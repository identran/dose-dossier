#!/usr/bin/env node
// Validates data/ and compiles it into site/data/ (see data/SCHEMA.md).
//   node tools/build.mjs            validate, then write site/data/index.json and site/data/day/NNN.json
//   node tools/build.mjs --check    validate only
import { readFile, readdir, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const OUT = path.join(ROOT, 'site', 'data');
const CHECK_ONLY = process.argv.includes('--check');

const errors = [];
const warnings = [];
const err = (where, msg) => errors.push(`${where}: ${msg}`);
const warn = (where, msg) => warnings.push(`${where}: ${msg}`);

const readJSON = async (file) => {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (e) {
    err(path.relative(ROOT, file), e.code === 'ENOENT' ? 'file not found' : `invalid JSON (${e.message})`);
    return null;
  }
};

const isStr = v => typeof v === 'string' && v.trim() !== '';
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const isHex = v => typeof v === 'string' && /^#[0-9A-Fa-f]{6}$/.test(v);
const isDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MODELS = ['absorption', 'bolus', 'infusion'];
const UNITS = ['pg/mL', 'ng/mL', 'µg/mL', 'mg/L', 'ng/L'];
const MAX_CLUE = 240; // hard limit; the target is about 220
const MAX_TITLE = 40;

function checkVocab(where, field, value, list) {
  if (!isStr(value)) return err(where, `"${field}" is required`);
  if (!list.includes(value)) err(where, `"${field}" is "${value}", which is not in data/vocab.json (${list.join(', ')})`);
}

function formulaCounts(formula) {
  const counts = {};
  for (const [, el, k] of formula.matchAll(/([A-Z][a-z]?)(\d*)/g)) counts[el] = (counts[el] || 0) + (k ? Number(k) : 1);
  return counts;
}

function validateStructure(where, s) {
  if (!Number.isInteger(s.cid) || s.cid <= 0) err(where, '"structure.cid" must be a positive integer');
  if (!isStr(s.formula) || !/^([A-Z][a-z]?\d*)+$/.test(s.formula)) err(where, '"structure.formula" must be a molecular formula such as C22H30N6O4S');
  if (!Array.isArray(s.atoms) || !s.atoms.length) return err(where, '"structure.atoms" must be a non-empty array');
  if (!Array.isArray(s.bonds) || !s.bonds.length) return err(where, '"structure.bonds" must be a non-empty array');
  const n = s.atoms.length;
  s.atoms.forEach((a, i) => {
    if (!Array.isArray(a) || a.length !== 3 || !isNum(a[0]) || !isNum(a[1]) || !isStr(a[2])) err(where, `structure.atoms[${i}] must be [x, y, "Element"]`);
    else if (a[2] === 'H') err(where, `structure.atoms[${i}] is a hydrogen; heavy atoms only`);
  });
  const parent = [...Array(n).keys()];
  const find = x => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  let lengthSum = 0;
  s.bonds.forEach((b, i) => {
    if (!Array.isArray(b) || b.length !== 3) return err(where, `structure.bonds[${i}] must be [i, j, order]`);
    const [a, c, o] = b;
    if (!Number.isInteger(a) || !Number.isInteger(c) || a < 0 || c < 0 || a >= n || c >= n) return err(where, `structure.bonds[${i}] indexes an atom that does not exist (${a}, ${c}; there are ${n} atoms)`);
    if (a === c) return err(where, `structure.bonds[${i}] joins atom ${a} to itself`);
    if (![1, 2, 3].includes(o)) err(where, `structure.bonds[${i}] has order ${o}; use 1, 2 or 3`);
    parent[find(a)] = find(c);
    lengthSum += Math.hypot(s.atoms[a][0] - s.atoms[c][0], s.atoms[a][1] - s.atoms[c][1]);
  });
  if (errors.length && !isStr(s.formula)) return;
  if (new Set(s.atoms.map((_, i) => find(i))).size !== 1) err(where, 'structure is not one connected molecule (a counter-ion or salt is in the record; use the parent compound)');
  const mean = lengthSum / s.bonds.length;
  if (!(mean > 0.9 && mean < 1.1)) err(where, `mean bond length is ${mean.toFixed(2)}; scale coordinates so it is 1`);
  if (isStr(s.formula)) {
    const want = formulaCounts(s.formula);
    const have = {};
    for (const a of s.atoms) have[a[2]] = (have[a[2]] || 0) + 1;
    delete want.H;
    const keys = new Set([...Object.keys(want), ...Object.keys(have)]);
    const diff = [...keys].filter(k => (want[k] || 0) !== (have[k] || 0)).map(k => `${k}: formula ${want[k] || 0}, atoms ${have[k] || 0}`);
    if (diff.length) err(where, `heavy atoms do not match formula ${s.formula} (${diff.join('; ')})`);
  }
}

function validatePk(where, pk) {
  if (!pk || typeof pk !== 'object') return err(where, '"pk" is required');
  if (!isStr(pk.context)) err(where, '"pk.context" is required (dose and population the numbers come from)');
  if (!MODELS.includes(pk.model)) err(where, `"pk.model" is "${pk.model}"; use one of ${MODELS.join(', ')}`);
  if (!UNITS.includes(pk.unit)) err(where, `"pk.unit" is "${pk.unit}"; use one of ${UNITS.join(', ')}`);
  const positive = (k, lo, hi, what) => {
    const v = pk[k];
    if (!isNum(v) || v <= 0) return err(where, `"pk.${k}" must be a positive number (got ${JSON.stringify(v)})`);
    if (v < lo || v > hi) err(where, `"pk.${k}" is ${v}, outside the plausible range ${lo} to ${hi} ${what}`);
  };
  if (pk.model === 'bolus' && pk.tmaxH === 0) { /* a bolus peaks at time zero */ } else positive('tmaxH', 0.01, 168, 'h');
  positive('halfLifeH', 0.05, 2000, 'h');
  positive('cmax', 1e-3, 1e6, pk.unit || '');
  if (pk.spanH !== undefined) {
    if (!isNum(pk.spanH) || pk.spanH <= 0) err(where, '"pk.spanH" must be a positive number when given');
    else if (isNum(pk.tmaxH) && pk.spanH < pk.tmaxH * 2) err(where, `"pk.spanH" (${pk.spanH}) is shorter than twice Tmax (${pk.tmaxH})`);
  }
  if (isNum(pk.tmaxH) && isNum(pk.halfLifeH) && pk.model === 'absorption' && pk.tmaxH > pk.halfLifeH * 12) warn(where, `Tmax ${pk.tmaxH} h is more than 12 half-lives (${pk.halfLifeH} h); check the numbers`);
}

function validateClues(where, d) {
  const clues = d.clues;
  if (!Array.isArray(clues)) return err(where, '"clues" must be an array');
  if (clues.length !== 10) err(where, `needs exactly 10 clues, has ${clues.length}`);
  const banned = [...new Map([d.generic, d.brand, ...(d.aliases || []), d.salt].filter(isStr).map(s => [s.toLowerCase(), { raw: s, low: s.toLowerCase() }])).values()];
  let prev = 0;
  const seen = new Set();
  clues.forEach((c, i) => {
    const w = `${where} clue ${i + 1}`;
    if (!c || typeof c !== 'object') return err(w, 'must be an object');
    if (!Number.isInteger(c.module) || c.module < 1 || c.module > 5) err(w, `"module" must be an integer 1 to 5 (got ${JSON.stringify(c.module)})`);
    else {
      if (c.module < prev) err(w, `module ${c.module} comes after module ${prev}; modules must not decrease`);
      prev = c.module;
      seen.add(c.module);
    }
    if (!isStr(c.title)) err(w, '"title" is required');
    else {
      if (/\.\s*$/.test(c.title)) err(w, `title "${c.title}" ends with a period`);
      if (/^M\d/i.test(c.title)) err(w, `title "${c.title}" starts with a code prefix`);
      if (c.title.length > MAX_TITLE) err(w, `title is ${c.title.length} characters; keep it under ${MAX_TITLE}`);
      if (c.title[0] !== c.title[0].toUpperCase()) err(w, `title "${c.title}" should start with a capital`);
    }
    if (!isStr(c.text)) err(w, '"text" is required');
    else {
      if (c.text.length > MAX_CLUE) err(w, `text is ${c.text.length} characters; the limit is ${MAX_CLUE} (aim for 220)`);
      else if (c.text.length > 220) warn(w, `text is ${c.text.length} characters; aim for 220 or fewer`);
    }
    for (const [field, text] of [['title', c.title], ['text', c.text]]) {
      if (!isStr(text)) continue;
      const low = text.toLowerCase();
      for (const b of banned) if (low.includes(b.low)) err(w, `${field} contains "${b.raw}" (generic name, brand, alias or salt name): "${text}"`);
    }
    for (const extra of Object.keys(c)) if (!['module', 'title', 'text'].includes(extra)) err(w, `unknown field "${extra}"`);
  });
  for (let m = 1; m <= 5; m++) if (!seen.has(m)) err(where, `no clue for module ${m}; every module 1 to 5 needs at least one`);
}

function validateDossier(file, d, vocab) {
  const where = file;
  if (!d || typeof d !== 'object') return err(where, 'must be a JSON object');
  const id = path.basename(file, '.json');
  if (!isStr(d.id) || !SLUG.test(d.id)) err(where, `"id" must be a lower-case slug (got ${JSON.stringify(d.id)})`);
  else if (d.id !== id) err(where, `"id" is "${d.id}" but the file is named ${id}.json`);
  for (const f of ['generic', 'brand', 'sponsor', 'class']) if (!isStr(d[f])) err(where, `"${f}" is required`);
  if (!Array.isArray(d.aliases) || d.aliases.some(a => !isStr(a))) err(where, '"aliases" must be an array of strings (may be empty)');
  if (d.salt !== undefined && !isStr(d.salt)) err(where, '"salt" must be a non-empty string when present');
  if (!isStr(d.application) || !/^(NDA|ANDA|BLA) \d{5,6}$/.test(d.application)) err(where, `"application" must look like "NDA 020895" (got ${JSON.stringify(d.application)})`);
  if (!Number.isInteger(d.approved) || d.approved < 1938 || d.approved > new Date().getFullYear()) err(where, `"approved" must be a year from 1938 to now (got ${JSON.stringify(d.approved)})`);
  checkVocab(where, 'area', d.area, vocab.areas);
  checkVocab(where, 'route', d.route, vocab.routes);
  checkVocab(where, 'form', d.form, vocab.forms);
  validatePk(where, d.pk);
  if (d.pill !== undefined) {
    const p = d.pill;
    if (!p || typeof p !== 'object') err(where, '"pill" must be an object');
    else {
      checkVocab(where, 'pill.shape', p.shape, vocab.pillShapes);
      if (!isHex(p.color)) err(where, `"pill.color" must be a hex colour like #4C86C6 (got ${JSON.stringify(p.color)})`);
      if (p.color2 !== undefined && !isHex(p.color2)) err(where, `"pill.color2" must be a hex colour (got ${JSON.stringify(p.color2)})`);
      if (!isStr(p.desc)) err(where, '"pill.desc" is required');
    }
  }
  if (d.structure !== undefined) validateStructure(where, d.structure);
  validateClues(where, d);
  const s = d.source;
  if (!s || typeof s !== 'object') err(where, '"source" is required');
  else {
    if (!isStr(s.setId) || !UUID.test(s.setId)) err(where, `"source.setId" must be a DailyMed set id (UUID), got ${JSON.stringify(s.setId)}`);
    else if (s.label !== `https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=${s.setId}`) err(where, '"source.label" must be the DailyMed URL for "source.setId"');
    if (!isDate(s.retrieved)) err(where, `"source.retrieved" must be a YYYY-MM-DD date (got ${JSON.stringify(s.retrieved)})`);
  }
}

function guessable(d) {
  return { id: d.id, generic: d.generic, brand: d.brand, aliases: d.aliases, area: d.area, form: d.form, sponsor: d.sponsor, halfLifeH: d.pk.halfLifeH };
}

function validateDictionary(list, vocab) {
  if (!Array.isArray(list)) return err('data/dictionary.json', 'must be an array');
  const ids = new Set();
  list.forEach((g, i) => {
    const w = `data/dictionary.json [${i}] ${g?.id ?? ''}`.trim();
    if (!g || typeof g !== 'object') return err(w, 'must be an object');
    if (!isStr(g.id) || !SLUG.test(g.id)) err(w, `"id" must be a lower-case slug (got ${JSON.stringify(g.id)})`);
    else if (ids.has(g.id)) err(w, `duplicate id "${g.id}"`);
    else ids.add(g.id);
    for (const f of ['generic', 'brand', 'sponsor']) if (!isStr(g[f])) err(w, `"${f}" is required`);
    if (!Array.isArray(g.aliases) || g.aliases.some(a => !isStr(a))) err(w, '"aliases" must be an array of strings');
    checkVocab(w, 'area', g.area, vocab.areas);
    checkVocab(w, 'form', g.form, vocab.forms);
    if (!isNum(g.halfLifeH) || g.halfLifeH <= 0 || g.halfLifeH > 2000) err(w, `"halfLifeH" must be a positive number of hours (got ${JSON.stringify(g.halfLifeH)})`);
  });
}

function validateVocab(v) {
  if (!v) return;
  for (const k of ['areas', 'routes', 'forms', 'pillShapes']) {
    if (!Array.isArray(v[k]) || !v[k].length || v[k].some(x => !isStr(x))) err('data/vocab.json', `"${k}" must be a non-empty array of strings`);
    else if (new Set(v[k]).size !== v[k].length) err('data/vocab.json', `"${k}" has duplicates`);
  }
  for (const a of v.areas || []) if (/[\/&,]/.test(a)) err('data/vocab.json', `area "${a}" is a compound; use one concept per area`);
}

async function main() {
  const vocab = await readJSON(path.join(DATA, 'vocab.json'));
  const dictionary = await readJSON(path.join(DATA, 'dictionary.json'));
  const schedule = await readJSON(path.join(DATA, 'schedule.json'));
  validateVocab(vocab);
  if (!vocab) return finish();
  validateDictionary(dictionary, vocab);

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
    validateDossier(rel, d, vocab);
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
      for (const k of ['generic', 'brand', 'area', 'form', 'sponsor', 'halfLifeH']) {
        if (dict[k] !== g[k]) err('data/dictionary.json', `"${id}" ${k} is ${JSON.stringify(dict[k])} but the dossier says ${JSON.stringify(g[k])}`);
      }
    }
    byId.set(id, g);
  }
  const names = new Map();
  for (const g of byId.values()) {
    for (const n of [g.generic, g.brand, ...g.aliases]) {
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
    const { source, ...rest } = dossiers.get(id).d;
    const compiled = { ...rest, source: { setId: source.setId, label: source.label } };
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
