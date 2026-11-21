#!/usr/bin/env node
// Usage: node tools/fetch-label.mjs <application-number-or-brand> [--out dir] [--json] [--also <related application>]...
// Writes tools/.cache/digests/<slug>.txt (plain-text digest) and prints it.
// Behind the agent proxy run with NODE_USE_ENV_PROXY=1.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchLabelDigest, digestToText } from './lib/label.mjs';

const args = process.argv.slice(2);
const flag = n => args.includes(n);
const outIdx = args.indexOf('--out');
const outDir = outIdx >= 0 ? args[outIdx + 1] : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '.cache', 'digests');
const also = [];
for (let i = 0; i < args.length; i++) if (args[i] === '--also') also.push(args[i + 1]);
const skip = new Set(args.flatMap((a, i) => (a === '--out' || a === '--also' ? [i, i + 1] : [])));
const query = args.filter((a, i) => !a.startsWith('--') && !skip.has(i)).join(' ');
if (!query) { console.error('usage: fetch-label.mjs <application-number-or-brand> [--out dir] [--json] [--also <related application>]...'); process.exit(2); }

try {
  const d = await fetchLabelDigest(query, { also });
  const text = flag('--json') ? JSON.stringify(d, null, 2) : digestToText(d);
  await mkdir(outDir, { recursive: true });
  const slug = query.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const file = path.join(outDir, `${slug}.${flag('--json') ? 'json' : 'txt'}`);
  await writeFile(file, text);
  process.stdout.write(text);
  console.error(`\nwrote ${file}`);
} catch (e) {
  console.error(`fetch-label: ${e.message}`);
  process.exit(1);
}
