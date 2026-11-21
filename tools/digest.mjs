#!/usr/bin/env node
// Usage: node tools/digest.mjs [ids...] [--all] [--candidates data/candidates.json]
// Writes tools/.cache/digests/<id>.txt (6-10 KB, never above 12 KB) for each ok candidate, plus
// tools/.cache/digests/_index.json (bytes, PK source, empty sections per id). Reads the labels that resolve.mjs saved in
// tools/.cache/labels/; fetches a label (cached) only when its file is missing.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDigest, HARD_MAX } from './lib/digest.mjs';
import { fetchLabelBySetId } from './lib/resolve.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'tools', '.cache', 'digests');
const args = process.argv.slice(2);
const ci = args.indexOf('--candidates');
const candFile = path.resolve(ci >= 0 ? args[ci + 1] : path.join(ROOT, 'data', 'candidates.json'));
const ids = args.filter((a, i) => !a.startsWith('--') && i !== ci + 1);
if (!ids.length && !args.includes('--all')) { console.error('usage: digest.mjs [ids...] [--all] [--candidates file]'); process.exit(2); }

const cands = JSON.parse(await readFile(candFile, 'utf8'));
const todo = cands.filter(c => c.status === 'ok' && (ids.length ? ids.includes(c.id) : true));
for (const id of ids) if (!cands.find(c => c.id === id && c.status === 'ok')) console.error(`${id}: not an ok candidate`);
await mkdir(OUT, { recursive: true });
let index = {};
try { index = JSON.parse(await readFile(path.join(OUT, '_index.json'), 'utf8')); } catch {}

for (const c of todo) {
  let label;
  try { label = JSON.parse(await readFile(path.join(ROOT, 'tools', '.cache', 'labels', `${c.id}.json`), 'utf8')); }
  catch { label = await fetchLabelBySetId(c.setId); }
  if (!label) { console.error(`${c.id}: label ${c.setId} not available`); continue; }
  const d = buildDigest(c, label);
  await writeFile(path.join(OUT, `${c.id}.txt`), d.text);
  index[c.id] = { bytes: d.bytes, pkSource: d.pkSource, empty: d.missing };
  if (d.bytes > HARD_MAX) console.error(`${c.id}: digest is ${d.bytes} bytes, above ${HARD_MAX}`);
}
await writeFile(path.join(OUT, '_index.json'), JSON.stringify(index, null, 1) + '\n');

const sizes = todo.map(c => index[c.id]?.bytes).filter(Boolean).sort((a, b) => a - b);
if (sizes.length) {
  const q = p => sizes[Math.min(sizes.length - 1, Math.floor(p * sizes.length))];
  console.log(`digests: ${sizes.length} written; bytes min ${sizes[0]}, median ${q(0.5)}, p90 ${q(0.9)}, max ${sizes.at(-1)}; over 10 KB: ${sizes.filter(s => s > 10240).length}; under 6 KB: ${sizes.filter(s => s < 6144).length}`);
  const src = {};
  for (const c of todo) { const s = index[c.id]?.pkSource; if (s) src[s] = (src[s] || 0) + 1; }
  console.log('PK text source:', JSON.stringify(src));
}
