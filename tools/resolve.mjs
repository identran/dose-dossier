#!/usr/bin/env node
// Usage: node tools/resolve.mjs <candidates.json...> [--out data/candidates.json] [--refresh] [--max-requests N] [--only id,id]
// Merges candidate lists (arrays of { generic, brand, area, class, type, route, fame }; data/dictionary.json also works),
// de-duplicates them, and resolves each to its US prescription label on openFDA plus approval facts from Drugs@FDA.
// Resumable and idempotent: the output is rewritten as it goes, finished records are reused on the next run, and every
// HTTP response is cached under tools/.cache/. The full label of each ok drug is saved to tools/.cache/labels/<id>.json.
// openFDA allows about 1,000 keyless requests a day per IP; a run stops cleanly at --max-requests (default 900 live requests).
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setRequestBudget, stats } from './lib/http.mjs';
import { resolveCandidate, slug } from './lib/resolve.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LABELS = path.join(ROOT, 'tools', '.cache', 'labels');
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const valueIdx = new Set(['--out', '--max-requests', '--only'].flatMap(n => (args.includes(n) ? [args.indexOf(n) + 1] : [])));
const inputs = args.filter((a, i) => !a.startsWith('--') && !valueIdx.has(i));
const outFile = path.resolve(opt('--out', path.join(ROOT, 'data', 'candidates.json')));
const refresh = args.includes('--refresh');
const only = opt('--only') ? new Set(opt('--only').split(',')) : null;
setRequestBudget(Number(opt('--max-requests', 900)));

if (!inputs.length) { console.error('usage: resolve.mjs <candidates.json...> [--out data/candidates.json] [--refresh] [--max-requests N] [--only id,id]'); process.exit(2); }

const str = v => (typeof v === 'string' ? v.trim() : v);
const signature = c => [c.generic, c.brand || ''].join('|').toLowerCase();

async function loadInputs() {
  const merged = new Map();
  for (const f of inputs) {
    let list;
    try { list = JSON.parse(await readFile(f, 'utf8')); } catch (e) { console.error(`skipping ${f}: ${e.message}`); continue; }
    if (!Array.isArray(list)) list = list.candidates || list.drugs || [];
    const src = path.basename(f);
    for (const raw of list) {
      const generic = str(raw?.generic);
      if (!generic) continue;
      const id = slug(generic);
      const cur = merged.get(id) || { id, generic, sources: [], mentions: 0, altNames: [] };
      cur.mentions++;
      if (!cur.sources.includes(src)) cur.sources.push(src);
      for (const k of ['brand', 'area', 'class', 'type', 'route', 'fame']) {
        const v = str(raw[k]);
        if (v === undefined || v === '' || v === null) continue;
        if (cur[k] === undefined) cur[k] = v;
        else if (k === 'brand' && String(cur[k]).toLowerCase() !== String(v).toLowerCase() && !cur.altNames.includes(v)) cur.altNames.push(v);
      }
      for (const a of raw.aliases || []) if (typeof a === 'string' && !cur.altNames.includes(a)) cur.altNames.push(a);
      if (generic.toLowerCase() !== cur.generic.toLowerCase() && !cur.altNames.includes(generic)) cur.altNames.push(generic);
      merged.set(id, cur);
    }
  }
  return [...merged.values()].sort((a, b) => a.id.localeCompare(b.id));
}

async function writeOut(records) {
  await mkdir(path.dirname(outFile), { recursive: true });
  const tmp = `${outFile}.tmp`;
  await writeFile(tmp, JSON.stringify(records, null, 2) + '\n');
  await rename(tmp, outFile);
}

const cands = await loadInputs();
let previous = new Map();
try { previous = new Map(JSON.parse(await readFile(outFile, 'utf8')).map(r => [r.id, r])); } catch {}
await mkdir(LABELS, { recursive: true });

const records = [];
let stopped = null;
let consecutiveErrors = 0;
let sinceWrite = 0;
for (const c of cands) {
  const base = { ...c };
  const prev = previous.get(c.id);
  const reusable = prev && !refresh && (prev.status === 'ok' || prev.status === 'reject') && prev._sig === signature(c);
  if (reusable) { records.push({ ...base, ...stripInput(prev), _sig: signature(c) }); continue; }
  if (stopped || (only && !only.has(c.id))) {
    records.push(prev ? { ...base, ...stripInput(prev) } : { ...base, status: 'pending', _sig: signature(c) });
    continue;
  }
  try {
    const res = await resolveCandidate(c);
    const { _row, ...rest } = res;
    if (_row) await writeFile(path.join(LABELS, `${c.id}.json`), JSON.stringify(_row));
    records.push({ ...base, ...rest, _sig: signature(c) });
    consecutiveErrors = 0;
    process.stderr.write(`${res.status === 'ok' ? 'ok    ' : 'reject'} ${c.id}${res.reject ? '  ' + res.reject : ''}\n`);
  } catch (e) {
    if (e.code === 'RATE_LIMIT' || e.code === 'BUDGET') {
      stopped = e;
      records.push({ ...base, status: 'pending', _sig: signature(c) });
      continue;
    }
    records.push({ ...base, status: 'error', reject: `lookup error: ${e.message.slice(0, 160)}`, _sig: signature(c) });
    process.stderr.write(`error  ${c.id}  ${e.message.slice(0, 120)}\n`);
    if (++consecutiveErrors >= 6) { stopped = new Error('six lookups in a row failed; stopping (is the network up?)'); }
  }
  if (++sinceWrite >= 10) { sinceWrite = 0; await writeOut([...records, ...cands.slice(records.length).map(x => ({ ...x, status: 'pending' }))].map(clean)); }
}

function pickInputFields(b) { const { id, generic, brand, area, class: cls, type, route, fame, sources, mentions, altNames } = b; return { id, generic, brand, area, class: cls, type, route, fame, sources, mentions, altNames }; }
function stripInput(r) { const { id, generic, brand, area, class: _c, type, route, fame, sources, mentions, altNames, ...rest } = r; return rest; }
function clean(r) {
  const ordered = {};
  for (const k of ['id', 'generic', 'brand', 'area', 'class', 'type', 'route', 'fame', 'status', 'reject', 'rejectDetail']) if (r[k] !== undefined && r[k] !== null) ordered[k] = r[k];
  for (const [k, v] of Object.entries(r)) if (!(k in ordered) && v !== undefined && !(Array.isArray(v) && !v.length && k === 'altNames')) ordered[k] = v;
  return ordered;
}
records.sort((a, b) => a.id.localeCompare(b.id));
await writeOut(records.map(clean));

// ---- summary
const by = k => records.reduce((m, r) => ((m[r[k] ?? '(none)'] = (m[r[k] ?? '(none)'] || 0) + 1), m), {});
const ok = records.filter(r => r.status === 'ok');
console.log(`\ncandidates ${records.length}   ok ${ok.length}   reject ${records.filter(r => r.status === 'reject').length}   error ${records.filter(r => r.status === 'error').length}   pending ${records.filter(r => r.status === 'pending').length}`);
const reasons = {};
for (const r of records) if (r.status === 'reject' || r.status === 'error') reasons[r.reject] = (reasons[r.reject] || 0) + 1;
for (const [k, n] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${k}`);
const nopk = ok.filter(r => !r.sectionLengths.pharmacokinetics);
console.log(`ok labels without a separate pharmacokinetics field: ${nopk.length} of ${ok.length}`);
console.log(`ok labels with a note: ${ok.filter(r => r.notes?.length).length}; brand not matched: ${ok.filter(r => r.notes?.some(n => n.startsWith('brand'))).length}; no approval date: ${ok.filter(r => !r.approvedYear).length}`);
console.log(`requests: ${stats.network} live, ${stats.cached} cached, ${stats.retries} retries`);
console.log(`wrote ${path.relative(process.cwd(), outFile)}`);
if (stopped) {
  console.error(`\nstopped early: ${stopped.message}\nRe-run the same command to continue (finished records and cached responses are reused).`);
  process.exit(3);
}
