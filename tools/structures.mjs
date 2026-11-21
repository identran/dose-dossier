#!/usr/bin/env node
// Usage: node tools/structures.mjs [ids...] [--all] [--candidates data/candidates.json] [--refresh] [--max-mw 2000]
// For ok candidates whose type is a small molecule or peptide, fetches the parent-compound 2D structure from PubChem
// and writes tools/.cache/structures/<id>.json: the dossier `structure` object (cid, formula, atoms, bonds; formal charges
// as an optional fourth atom entry) plus `molecularWeight`. Failures are recorded in tools/.cache/structures/_failures.json
// and never stop the run. Cached and resumable: existing structure files are skipped unless --refresh is given.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchStructureWithMw, heavyAtomsFromFormula } from './lib/structure.mjs';
import { createContext, validateStructure } from './lib/validate.mjs';
import { moiety } from './lib/resolve.mjs';
import { stats } from './lib/http.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'tools', '.cache', 'structures');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const skipIdx = new Set(['--candidates', '--max-mw'].flatMap(n => (args.includes(n) ? [args.indexOf(n) + 1] : [])));
const wantIds = args.filter((a, i) => !a.startsWith('--') && !skipIdx.has(i));
const candFile = path.resolve(opt('--candidates', path.join(ROOT, 'data', 'candidates.json')));
const maxMw = Number(opt('--max-mw', 2000));
const refresh = args.includes('--refresh');
if (!wantIds.length && !args.includes('--all')) { console.error('usage: structures.mjs [ids...] [--all] [--candidates file] [--refresh] [--max-mw 2000]'); process.exit(2); }

const cands = JSON.parse(await readFile(candFile, 'utf8'));
const small = c => (c.type ? /small|peptide|molecule|oligo/i.test(c.type) && !/antibod|protein|biolog|enzyme|vaccine|gene|cell|plasma|toxin/i.test(c.type) : !/^BLA/.test(c.application || ''));
const todo = cands.filter(c => c.status === 'ok' && (wantIds.length ? wantIds.includes(c.id) : true) && (wantIds.length || small(c)));
for (const id of wantIds) if (!cands.some(c => c.id === id)) console.error(`unknown id ${id}`);

await mkdir(OUT, { recursive: true });
let failures = {};
try { failures = JSON.parse(await readFile(path.join(OUT, '_failures.json'), 'utf8')); } catch {}

const exists = async f => { try { await readFile(f); return true; } catch { return false; } };
const counts = { ok: 0, cached: 0, failed: 0, skippedLarge: 0 };
const failed = [];
const nameVariants = c => [...new Set([moiety(c.generic), c.generic, c.substance && moiety(c.substance)].filter(Boolean))];

for (const c of todo) {
  const file = path.join(OUT, `${c.id}.json`);
  if (!refresh && await exists(file)) { counts.cached++; delete failures[c.id]; continue; }
  let result = null, lastErr = null;
  for (const name of nameVariants(c)) {
    try { result = await fetchStructureWithMw(name); break; } catch (e) { lastErr = e; if (/^5\d\d|network/.test(e.message)) break; }
  }
  if (!result) { counts.failed++; failures[c.id] = lastErr?.message || 'no structure'; failed.push(c.id); process.stderr.write(`fail  ${c.id}  ${failures[c.id]}\n`); continue; }
  if (result.molecularWeight && result.molecularWeight > maxMw) {
    counts.skippedLarge++; failures[c.id] = `molecular weight ${result.molecularWeight} is over ${maxMw}`; failed.push(c.id); process.stderr.write(`skip  ${c.id}  MW ${result.molecularWeight}\n`); continue;
  }
  const { molecularWeight, ...structure } = result;
  const ctx = createContext();
  validateStructure(ctx, c.id, structure);
  if (ctx.errors.length || heavyAtomsFromFormula(structure.formula) !== structure.atoms.length) {
    counts.failed++; failures[c.id] = `invalid structure: ${ctx.errors[0] || 'heavy-atom count differs from formula'}`; failed.push(c.id); process.stderr.write(`fail  ${c.id}  ${failures[c.id]}\n`); continue;
  }
  await writeFile(file, JSON.stringify({ ...structure, molecularWeight }));
  delete failures[c.id];
  counts.ok++;
  process.stderr.write(`ok    ${c.id}  CID ${structure.cid}  ${structure.formula}  ${molecularWeight}\n`);
}
await writeFile(path.join(OUT, '_failures.json'), JSON.stringify(failures, null, 2) + '\n');
console.log(`\nstructures: ${counts.ok} fetched, ${counts.cached} already cached, ${counts.failed} failed, ${counts.skippedLarge} skipped as too large (of ${todo.length} candidates)`);
if (failed.length) console.log(`not written: ${failed.map(id => `${id} (${failures[id]})`).join('; ')}`);
console.log(`requests: ${stats.network} live, ${stats.cached} cached, ${stats.retries} retries`);
