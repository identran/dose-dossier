#!/usr/bin/env node
// Usage: node tools/assemble.mjs [ids...] [--all] --drafts <dir> [--out data/dossiers] [--force] [--candidates data/candidates.json]
// Merges each agent-written draft <dir>/<id>.json (aliases, salt, approved, sponsor, area, class, route, form, pk, pill,
// biologic, clues, tell, evidence) with the deterministic parts: id, generic, brand, application and source from
// data/candidates.json, and `structure` from tools/.cache/structures/<id>.json when present and at most 70 heavy atoms
// (the draft's `biologic` is then dropped). Writes the dossier with a stable key order and 2-space JSON.
// Refuses to overwrite an existing dossier unless --force. Run `npm run verify` afterwards.
import { readFile, readdir, writeFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const valueIdx = new Set(['--drafts', '--out', '--candidates'].flatMap(n => (args.includes(n) ? [args.indexOf(n) + 1] : [])));
const wanted = args.filter((a, i) => !a.startsWith('--') && !valueIdx.has(i));
const drafts = opt('--drafts') && path.resolve(opt('--drafts'));
const outDir = path.resolve(opt('--out', path.join(ROOT, 'data', 'dossiers')));
const candFile = path.resolve(opt('--candidates', path.join(ROOT, 'data', 'candidates.json')));
const force = args.includes('--force');
const MAX_HEAVY_ATOMS = 70;
if (!drafts || (!wanted.length && !args.includes('--all'))) { console.error('usage: assemble.mjs [ids...] [--all] --drafts <dir> [--out data/dossiers] [--force]'); process.exit(2); }

const ORDER = ['id', 'generic', 'brand', 'aliases', 'salt', 'application', 'approved', 'sponsor', 'area', 'class', 'route', 'form', 'pk', 'pill', 'structure', 'biologic', 'clues', 'tell', 'source', 'evidence', 'revised', 'revisionNote'];
const DRAFT_FIELDS = ['aliases', 'salt', 'approved', 'sponsor', 'area', 'class', 'route', 'form', 'pk', 'pill', 'biologic', 'clues', 'tell', 'evidence', 'revised', 'revisionNote'];
const cands = new Map(JSON.parse(await readFile(candFile, 'utf8')).map(c => [c.id, c]));
const exists = async f => { try { await access(f); return true; } catch { return false; } };

const ids = args.includes('--all') ? (await readdir(drafts)).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).sort() : wanted;
const today = new Date().toISOString().slice(0, 10);
let wrote = 0, problems = 0;
await mkdir(outDir, { recursive: true });
for (const id of ids) {
  const say = (kind, msg) => { console.error(`${kind}  ${id}: ${msg}`); if (kind === 'error') problems++; };
  const c = cands.get(id);
  if (!c) { say('error', 'not in data/candidates.json'); continue; }
  if (c.status !== 'ok') { say('error', `candidate is ${c.status} (${c.reject || ''}); no label to build from`); continue; }
  let draft;
  try { draft = JSON.parse(await readFile(path.join(drafts, `${id}.json`), 'utf8')); } catch (e) { say('error', `cannot read draft: ${e.message}`); continue; }
  const target = path.join(outDir, `${id}.json`);
  if (!force && await exists(target)) { say('error', `${path.relative(ROOT, target)} exists; use --force to overwrite`); continue; }

  const d = { id, generic: c.generic, brand: c.brand || null, application: c.application, source: { setId: c.setId, label: c.dailymed, retrieved: today } };
  for (const k of DRAFT_FIELDS) if (draft[k] !== undefined) d[k] = draft[k];
  for (const k of Object.keys(draft)) if (![...DRAFT_FIELDS, 'id', 'generic', 'brand', 'application', 'source', 'structure'].includes(k)) say('warn', `ignored unknown draft field "${k}"`);
  for (const k of ['id', 'generic', 'brand', 'application', 'source', 'structure']) if (draft[k] !== undefined) say('warn', `draft field "${k}" ignored; it comes from the pipeline`);

  try {
    const st = JSON.parse(await readFile(path.join(ROOT, 'tools', '.cache', 'structures', `${id}.json`), 'utf8'));
    if (st.atoms.length <= MAX_HEAVY_ATOMS) {
      const { molecularWeight, ...structure } = st;
      d.structure = structure;
      if (d.biologic) { delete d.biologic; say('info', 'structure present, draft biologic dropped'); }
    } else say('warn', `structure has ${st.atoms.length} heavy atoms (over ${MAX_HEAVY_ATOMS}); left out`);
  } catch {}
  if (!d.structure && !d.biologic) say('warn', 'neither a structure nor a biologic block');

  const out = {};
  for (const k of ORDER) if (d[k] !== undefined) out[k] = d[k];
  if (out.clues) out.clues = Object.fromEntries(['kinetics', 'substance', 'product', 'safety', 'indication', 'mechanism'].filter(k => out.clues[k] !== undefined).map(k => [k, out.clues[k]]));
  await writeFile(target, JSON.stringify(out, null, 2) + '\n');
  wrote++;
  console.log(`wrote ${path.relative(ROOT, target)}`);
}
console.log(`\n${wrote} written, ${problems} problem${problems === 1 ? '' : 's'}`);
process.exit(problems ? 1 : 0);
