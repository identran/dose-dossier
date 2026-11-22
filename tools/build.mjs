#!/usr/bin/env node
// Validates data/ and compiles it into site/data/ (see data/SCHEMA.md).
//   node tools/build.mjs            validate, then write site/data/index.json and site/data/day/NNN.json
//   node tools/build.mjs --check    validate only
//   --strict                        class and sponsor must be listed in data/vocab.json (a warning otherwise)
//   --data <dir> --out <dir>        build from another data directory into another output directory
import { readFile, readdir, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileClues, accent } from './lib/compile.mjs';
import { createContext, isDate, isStr, validateDossier, validateDictionary, validateVocab, checkVocab, guessable, stripReviewFields } from './lib/validate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argOf = n => { const i = process.argv.indexOf(n); return i >= 0 ? path.resolve(process.argv[i + 1]) : null; };
const DATA = argOf('--data') || path.join(ROOT, 'data');      // --data <dir> and --out <dir> let a scratch copy be built
const OUT = argOf('--out') || path.join(ROOT, 'site', 'data');
const CHECK_ONLY = process.argv.includes('--check');
const STRICT = process.argv.includes('--strict'); // class and sponsor must be in data/vocab.json

const ctx = createContext();
const { errors, warnings, err, warn } = ctx;

const readJSON = async (file) => {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (e) {
    err(path.relative(ROOT, file), e.code === 'ENOENT' ? 'file not found' : `invalid JSON (${e.message})`);
    return null;
  }
};

async function main() {
  const vocab = await readJSON(path.join(DATA, 'vocab.json'));
  const dictionary = await readJSON(path.join(DATA, 'dictionary.json'));
  const schedule = await readJSON(path.join(DATA, 'schedule.json'));
  validateVocab(ctx, vocab);
  if (!vocab) return finish();
  validateDictionary(ctx, dictionary, vocab, { strict: STRICT });

  let files = [];
  try {
    files = (await readdir(path.join(DATA, 'dossiers'))).filter(f => f.endsWith('.json')).sort();
  } catch {
    err('data/dossiers', 'directory not found');
  }
  const dossiers = new Map();
  for (const f of files) {
    const rel = `data/dossiers/${f}`;
    const d = await readJSON(path.join(DATA, 'dossiers', f));
    const before = errors.length;
    validateDossier(ctx, rel, d, vocab, { strict: STRICT });
    if (d && d.id) dossiers.set(d.id, { d, ok: errors.length === before });
  }

  // Schedule
  let days = [];
  if (schedule) {
    if (!isDate(schedule.epoch)) err('data/schedule.json', `"epoch" must be a YYYY-MM-DD date (got ${JSON.stringify(schedule.epoch)})`);
    if (!Array.isArray(schedule.days) || !schedule.days.length) err('data/schedule.json', '"days" must be a non-empty array of dossier ids');
    else {
      const seen = new Set();
      schedule.days.forEach((id, i) => {
        if (!dossiers.has(id)) err('data/schedule.json', `day ${i + 1} is "${id}", which has no dossier in data/dossiers/`);
        if (seen.has(id)) err('data/schedule.json', `"${id}" is scheduled twice (day ${i + 1})`);
        seen.add(id);
      });
      days = schedule.days;
      for (const id of dossiers.keys()) if (!seen.has(id)) warn('data/schedule.json', `dossier "${id}" is not scheduled`);
    }
  }

  // Guessable list: dossiers win over dictionary entries with the same id, and must agree with them.
  const byId = new Map();
  for (const g of dictionary || []) byId.set(g.id, g);
  for (const [id, { d, ok }] of dossiers) {
    if (!ok) continue;
    const g = guessable(d);
    const dict = byId.get(id);
    if (dict) {
      for (const k of ['generic', 'brand', 'area', 'class', 'sponsor', 'approved']) {
        if (dict[k] !== g[k]) err('data/dictionary.json', `"${id}" ${k} is ${JSON.stringify(dict[k])} but the dossier says ${JSON.stringify(g[k])}`);
      }
    }
    byId.set(id, g);
  }
  const names = new Map();
  for (const g of byId.values()) {
    for (const n of [g.generic, g.brand, ...g.aliases].filter(isStr)) { // brand is null when a drug has no US brand
      const k = n.toLowerCase();
      if (names.has(k) && names.get(k) !== g.id) err('guessable names', `"${n}" names both "${names.get(k)}" and "${g.id}"`);
      names.set(k, g.id);
    }
  }

  if (errors.length) return finish();
  if (CHECK_ONLY) return finish({ drugs: byId.size, days: days.length, dossiers: dossiers.size });

  const index = { epoch: schedule.epoch, days: days.length, drugs: [...byId.values()].sort((a, b) => a.generic.localeCompare(b.generic)) };
  await mkdir(path.join(OUT, 'day'), { recursive: true });
  for (const f of await readdir(path.join(OUT, 'day'))) if (/^\d{3}\.json$/.test(f)) await rm(path.join(OUT, 'day', f));
  await writeFile(path.join(OUT, 'index.json'), JSON.stringify(index));
  for (const [i, id] of days.entries()) {
    const { source, clues, ...rest } = stripReviewFields(dossiers.get(id).d); // evidence and other review-only fields never reach the site
    delete rest.salt;
    const compiled = { ...rest, clues: compileClues(clues, rest.generic), ...(rest.pill?.color ? { accent: accent(rest.pill.color) } : {}), source: { setId: source.setId, label: source.label } };
    await writeFile(path.join(OUT, 'day', `${String(i + 1).padStart(3, '0')}.json`), JSON.stringify(compiled));
  }
  finish({ drugs: byId.size, days: days.length, dossiers: dossiers.size, wrote: true });
}

function finish(stats) {
  for (const w of warnings) console.warn(`warning  ${w}`);
  if (errors.length) {
    console.error(`\n${errors.length} problem${errors.length === 1 ? '' : 's'} found:\n`);
    for (const e of errors) console.error(`  ${e}`);
    process.exit(1);
  }
  if (stats) console.log(`ok  ${stats.dossiers} dossiers, ${stats.days} scheduled days, ${stats.drugs} guessable drugs${stats.wrote ? '; wrote site/data/' : ' (check only)'}`);
}

main().catch(e => { console.error(e); process.exit(1); });
