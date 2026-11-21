// Shared validation for data/ (used by build.mjs and verify.mjs).
// Every function reports through a context { err(where, msg), warn(where, msg) }; see createContext().
//
// The dossier field table lives in ONE place, FIELDS below. To add a per-dossier field, add it there.
import path from 'node:path';

export function createContext() {
  const ctx = { errors: [], warnings: [] };
  ctx.err = (where, msg) => ctx.errors.push(`${where}: ${msg}`);
  ctx.warn = (where, msg) => ctx.warnings.push(`${where}: ${msg}`);
  return ctx;
}

// ------------------------------------------------------------------ the field table

export const FIELDS = {
  // required non-empty strings
  strings: ['generic', 'brand', 'sponsor', 'class'],
  // optional non-empty strings
  optionalStrings: ['salt'],
  // fields whose value must come from data/vocab.json: field -> vocab list name
  vocab: { area: 'areas', route: 'routes', form: 'forms' },
  // fields handled by dedicated checks below
  other: ['id', 'aliases', 'application', 'approved', 'pk', 'pill', 'structure', 'clues', 'source'],
  // present while an agent is writing or reviewing a dossier; checked, then dropped from the compiled day files
  reviewOnly: ['evidence', 'notes', 'review', 'scratch'],
  // pharmacokinetic fields: required fields must be positive numbers inside [lo, hi]
  pk: {
    tmaxH: { required: true, lo: 0.01, hi: 168, what: 'h' },
    halfLifeH: { required: true, lo: 0.05, hi: 2000, what: 'h' },
    cmax: { required: false, lo: 1e-3, hi: 1e6, needs: 'unit' },
    spanH: { required: false },
  },
  models: ['absorption', 'bolus', 'infusion'],
  units: ['pg/mL', 'ng/mL', 'µg/mL', 'mg/L', 'ng/L'],
  maxClue: 240, // hard limit; the target is about 220
  maxTitle: 40,
  clueCount: 10,
};
export const KNOWN_TOP = new Set([...FIELDS.strings, ...FIELDS.optionalStrings, ...Object.keys(FIELDS.vocab), ...FIELDS.other, ...FIELDS.reviewOnly]);

// ------------------------------------------------------------------ helpers

export const isStr = v => typeof v === 'string' && v.trim() !== '';
export const isNum = v => typeof v === 'number' && Number.isFinite(v);
export const isHex = v => typeof v === 'string' && /^#[0-9A-Fa-f]{6}$/.test(v);
export const isDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
export const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A copy of the dossier without the review-only fields (what gets compiled for the site).
export function stripReviewFields(d) {
  const out = { ...d };
  for (const k of FIELDS.reviewOnly) delete out[k];
  return out;
}

export function checkVocab(ctx, where, field, value, list) {
  if (!isStr(value)) return ctx.err(where, `"${field}" is required`);
  if (!list.includes(value)) ctx.err(where, `"${field}" is "${value}", which is not in data/vocab.json (${list.join(', ')})`);
}

export function formulaCounts(formula) {
  const counts = {};
  for (const [, el, k] of formula.matchAll(/([A-Z][a-z]?)(\d*)/g)) counts[el] = (counts[el] || 0) + (k ? Number(k) : 1);
  return counts;
}

// ------------------------------------------------------------------ structure

export function validateStructure(ctx, where, s) {
  const before = ctx.errors.length;
  if (!s || typeof s !== 'object') return ctx.err(where, '"structure" must be an object');
  if (!Number.isInteger(s.cid) || s.cid <= 0) ctx.err(where, '"structure.cid" must be a positive integer');
  if (!isStr(s.formula) || !/^([A-Z][a-z]?\d*)+$/.test(s.formula)) ctx.err(where, '"structure.formula" must be a molecular formula such as C22H30N6O4S');
  if (!Array.isArray(s.atoms) || !s.atoms.length) return ctx.err(where, '"structure.atoms" must be a non-empty array');
  if (!Array.isArray(s.bonds) || !s.bonds.length) return ctx.err(where, '"structure.bonds" must be a non-empty array');
  const n = s.atoms.length;
  s.atoms.forEach((a, i) => {
    const ok = Array.isArray(a) && (a.length === 3 || a.length === 4) && isNum(a[0]) && isNum(a[1]) && isStr(a[2]);
    if (!ok) ctx.err(where, `structure.atoms[${i}] must be [x, y, "Element"] or [x, y, "Element", charge]`);
    else if (a[2] === 'H') ctx.err(where, `structure.atoms[${i}] is a hydrogen; heavy atoms only`);
    else if (a.length === 4 && (!Number.isInteger(a[3]) || a[3] === 0 || Math.abs(a[3]) > 4)) ctx.err(where, `structure.atoms[${i}] charge must be a non-zero integer (omit the fourth entry when the atom is neutral)`);
  });
  const parent = [...Array(n).keys()];
  const find = x => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  let lengthSum = 0;
  let badBond = false;
  s.bonds.forEach((b, i) => {
    if (!Array.isArray(b) || b.length !== 3) { badBond = true; return ctx.err(where, `structure.bonds[${i}] must be [i, j, order]`); }
    const [a, c, o] = b;
    if (!Number.isInteger(a) || !Number.isInteger(c) || a < 0 || c < 0 || a >= n || c >= n) { badBond = true; return ctx.err(where, `structure.bonds[${i}] indexes an atom that does not exist (${a}, ${c}; there are ${n} atoms)`); }
    if (a === c) { badBond = true; return ctx.err(where, `structure.bonds[${i}] joins atom ${a} to itself`); }
    if (![1, 2, 3].includes(o)) ctx.err(where, `structure.bonds[${i}] has order ${o}; use 1, 2 or 3`);
    parent[find(a)] = find(c);
    lengthSum += Math.hypot(s.atoms[a][0] - s.atoms[c][0], s.atoms[a][1] - s.atoms[c][1]);
  });
  if (badBond || ctx.errors.length > before) return;
  if (new Set(s.atoms.map((_, i) => find(i))).size !== 1) ctx.err(where, 'structure is not one connected molecule (a counter-ion or salt is in the record; use the parent compound)');
  const mean = lengthSum / s.bonds.length;
  if (!(mean > 0.9 && mean < 1.1)) ctx.err(where, `mean bond length is ${mean.toFixed(2)}; scale coordinates so it is 1`);
  const want = formulaCounts(s.formula);
  const have = {};
  for (const a of s.atoms) have[a[2]] = (have[a[2]] || 0) + 1;
  delete want.H;
  const keys = new Set([...Object.keys(want), ...Object.keys(have)]);
  const diff = [...keys].filter(k => (want[k] || 0) !== (have[k] || 0)).map(k => `${k}: formula ${want[k] || 0}, atoms ${have[k] || 0}`);
  if (diff.length) ctx.err(where, `heavy atoms do not match formula ${s.formula} (${diff.join('; ')})`);
}

// ------------------------------------------------------------------ pk

export function validatePk(ctx, where, pk) {
  if (!pk || typeof pk !== 'object') return ctx.err(where, '"pk" is required');
  if (!isStr(pk.context)) ctx.err(where, '"pk.context" is required (dose and population the numbers come from)');
  if (!FIELDS.models.includes(pk.model)) ctx.err(where, `"pk.model" is "${pk.model}"; use one of ${FIELDS.models.join(', ')}`);
  const hasCmax = pk.cmax !== undefined;
  const hasUnit = pk.unit !== undefined;
  if (hasCmax !== hasUnit) ctx.err(where, '"pk.cmax" and "pk.unit" go together: give both, or leave both out when the label states no Cmax');
  if (hasUnit && !FIELDS.units.includes(pk.unit)) ctx.err(where, `"pk.unit" is "${pk.unit}"; use one of ${FIELDS.units.join(', ')}`);
  for (const [k, spec] of Object.entries(FIELDS.pk)) {
    if (k === 'spanH') continue;
    const v = pk[k];
    if (v === undefined && !spec.required) continue;
    if (k === 'tmaxH' && pk.model === 'bolus' && v === 0) continue; // a bolus peaks at time zero
    if (!isNum(v) || v <= 0) { ctx.err(where, `"pk.${k}" must be a positive number (got ${JSON.stringify(v)})`); continue; }
    const what = spec.what || pk.unit || '';
    if (v < spec.lo || v > spec.hi) ctx.err(where, `"pk.${k}" is ${v}, outside the plausible range ${spec.lo} to ${spec.hi} ${what}`);
  }
  for (const k of Object.keys(pk)) if (!['context', 'model', 'unit', ...Object.keys(FIELDS.pk)].includes(k)) ctx.warn(where, `unknown field "pk.${k}"`);
  if (pk.spanH !== undefined) {
    if (!isNum(pk.spanH) || pk.spanH <= 0) ctx.err(where, '"pk.spanH" must be a positive number when given');
    else if (isNum(pk.tmaxH) && pk.spanH < pk.tmaxH * 2) ctx.err(where, `"pk.spanH" (${pk.spanH}) is shorter than twice Tmax (${pk.tmaxH})`);
  }
  if (isNum(pk.tmaxH) && isNum(pk.halfLifeH) && pk.model === 'absorption' && pk.tmaxH > pk.halfLifeH * 12) ctx.warn(where, `Tmax ${pk.tmaxH} h is more than 12 half-lives (${pk.halfLifeH} h); check the numbers`);
}

// ------------------------------------------------------------------ clues

export function validateClues(ctx, where, d) {
  const clues = d.clues;
  if (!Array.isArray(clues)) return ctx.err(where, '"clues" must be an array');
  if (clues.length !== FIELDS.clueCount) ctx.err(where, `needs exactly ${FIELDS.clueCount} clues, has ${clues.length}`);
  const banned = [...new Map([d.generic, d.brand, ...(d.aliases || []), d.salt].filter(isStr).map(s => [s.toLowerCase(), { raw: s, low: s.toLowerCase() }])).values()];
  let prev = 0;
  const seen = new Set();
  clues.forEach((c, i) => {
    const w = `${where} clue ${i + 1}`;
    if (!c || typeof c !== 'object') return ctx.err(w, 'must be an object');
    if (!Number.isInteger(c.module) || c.module < 1 || c.module > 5) ctx.err(w, `"module" must be an integer 1 to 5 (got ${JSON.stringify(c.module)})`);
    else {
      if (c.module < prev) ctx.err(w, `module ${c.module} comes after module ${prev}; modules must not decrease`);
      prev = c.module;
      seen.add(c.module);
    }
    if (!isStr(c.title)) ctx.err(w, '"title" is required');
    else {
      if (/\.\s*$/.test(c.title)) ctx.err(w, `title "${c.title}" ends with a period`);
      if (/^M\d/i.test(c.title)) ctx.err(w, `title "${c.title}" starts with a code prefix`);
      if (c.title.length > FIELDS.maxTitle) ctx.err(w, `title is ${c.title.length} characters; keep it under ${FIELDS.maxTitle}`);
      if (c.title[0] !== c.title[0].toUpperCase()) ctx.err(w, `title "${c.title}" should start with a capital`);
    }
    if (!isStr(c.text)) ctx.err(w, '"text" is required');
    else {
      if (c.text.length > FIELDS.maxClue) ctx.err(w, `text is ${c.text.length} characters; the limit is ${FIELDS.maxClue} (aim for 220)`);
      else if (c.text.length > 220) ctx.warn(w, `text is ${c.text.length} characters; aim for 220 or fewer`);
    }
    for (const [field, text] of [['title', c.title], ['text', c.text]]) {
      if (!isStr(text)) continue;
      const low = text.toLowerCase();
      for (const b of banned) if (low.includes(b.low)) ctx.err(w, `${field} contains "${b.raw}" (generic name, brand, alias or salt name): "${text}"`);
    }
    for (const extra of Object.keys(c)) if (!['module', 'title', 'text'].includes(extra)) ctx.err(w, `unknown field "${extra}"`);
  });
  for (let m = 1; m <= 5; m++) if (!seen.has(m)) ctx.err(where, `no clue for module ${m}; every module 1 to 5 needs at least one`);
}

// ------------------------------------------------------------------ dossier

export function validateDossier(ctx, file, d, vocab) {
  const where = file;
  if (!d || typeof d !== 'object') return ctx.err(where, 'must be a JSON object');
  const id = path.basename(file, '.json');
  if (!isStr(d.id) || !SLUG.test(d.id)) ctx.err(where, `"id" must be a lower-case slug (got ${JSON.stringify(d.id)})`);
  else if (d.id !== id) ctx.err(where, `"id" is "${d.id}" but the file is named ${id}.json`);
  for (const f of FIELDS.strings) if (!isStr(d[f])) ctx.err(where, `"${f}" is required`);
  for (const f of FIELDS.optionalStrings) if (d[f] !== undefined && !isStr(d[f])) ctx.err(where, `"${f}" must be a non-empty string when present`);
  if (!Array.isArray(d.aliases) || d.aliases.some(a => !isStr(a))) ctx.err(where, '"aliases" must be an array of strings (may be empty)');
  if (!isStr(d.application) || !/^(NDA|ANDA|BLA) \d{5,6}$/.test(d.application)) ctx.err(where, `"application" must look like "NDA 020895" (got ${JSON.stringify(d.application)})`);
  if (!Number.isInteger(d.approved) || d.approved < 1938 || d.approved > new Date().getFullYear()) ctx.err(where, `"approved" must be a year from 1938 to now (got ${JSON.stringify(d.approved)})`);
  for (const [field, list] of Object.entries(FIELDS.vocab)) checkVocab(ctx, where, field, d[field], vocab[list]);
  validatePk(ctx, where, d.pk);
  if (d.pill !== undefined) {
    const p = d.pill;
    if (!p || typeof p !== 'object') ctx.err(where, '"pill" must be an object');
    else {
      checkVocab(ctx, where, 'pill.shape', p.shape, vocab.pillShapes);
      if (!isHex(p.color)) ctx.err(where, `"pill.color" must be a hex colour like #4C86C6 (got ${JSON.stringify(p.color)})`);
      if (p.color2 !== undefined && !isHex(p.color2)) ctx.err(where, `"pill.color2" must be a hex colour (got ${JSON.stringify(p.color2)})`);
      if (!isStr(p.desc)) ctx.err(where, '"pill.desc" is required');
    }
  }
  if (d.structure !== undefined) validateStructure(ctx, where, d.structure);
  validateClues(ctx, where, d);
  const s = d.source;
  if (!s || typeof s !== 'object') ctx.err(where, '"source" is required');
  else {
    if (!isStr(s.setId) || !UUID.test(s.setId)) ctx.err(where, `"source.setId" must be a DailyMed set id (UUID), got ${JSON.stringify(s.setId)}`);
    else if (s.label !== `https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=${s.setId}`) ctx.err(where, '"source.label" must be the DailyMed URL for "source.setId"');
    if (!isDate(s.retrieved)) ctx.err(where, `"source.retrieved" must be a YYYY-MM-DD date (got ${JSON.stringify(s.retrieved)})`);
  }
  if (d.evidence !== undefined) {
    const e = d.evidence;
    if (!e || typeof e !== 'object' || Array.isArray(e)) ctx.err(where, '"evidence" must be an object mapping field paths to quotes');
    else for (const [k, v] of Object.entries(e)) if (!(isStr(v) || (Array.isArray(v) && v.length && v.every(isStr)))) ctx.err(where, `evidence["${k}"] must be a quote string (or an array of quote strings)`);
  }
  for (const k of Object.keys(d)) if (!KNOWN_TOP.has(k)) ctx.warn(where, `unknown field "${k}" (add it to FIELDS in tools/lib/validate.mjs if it is intended)`);
}

// ------------------------------------------------------------------ dictionary, vocab

export function guessable(d) {
  return { id: d.id, generic: d.generic, brand: d.brand, aliases: d.aliases, area: d.area, form: d.form, sponsor: d.sponsor, halfLifeH: d.pk.halfLifeH };
}

export function validateDictionary(ctx, list, vocab) {
  if (!Array.isArray(list)) return ctx.err('data/dictionary.json', 'must be an array');
  const ids = new Set();
  list.forEach((g, i) => {
    const w = `data/dictionary.json [${i}] ${g?.id ?? ''}`.trim();
    if (!g || typeof g !== 'object') return ctx.err(w, 'must be an object');
    if (!isStr(g.id) || !SLUG.test(g.id)) ctx.err(w, `"id" must be a lower-case slug (got ${JSON.stringify(g.id)})`);
    else if (ids.has(g.id)) ctx.err(w, `duplicate id "${g.id}"`);
    else ids.add(g.id);
    for (const f of ['generic', 'brand', 'sponsor']) if (!isStr(g[f])) ctx.err(w, `"${f}" is required`);
    if (!Array.isArray(g.aliases) || g.aliases.some(a => !isStr(a))) ctx.err(w, '"aliases" must be an array of strings');
    checkVocab(ctx, w, 'area', g.area, vocab.areas);
    checkVocab(ctx, w, 'form', g.form, vocab.forms);
    if (!isNum(g.halfLifeH) || g.halfLifeH <= 0 || g.halfLifeH > 2000) ctx.err(w, `"halfLifeH" must be a positive number of hours (got ${JSON.stringify(g.halfLifeH)})`);
  });
}

export function validateVocab(ctx, v) {
  if (!v) return;
  for (const k of ['areas', 'routes', 'forms', 'pillShapes']) {
    if (!Array.isArray(v[k]) || !v[k].length || v[k].some(x => !isStr(x))) ctx.err('data/vocab.json', `"${k}" must be a non-empty array of strings`);
    else if (new Set(v[k]).size !== v[k].length) ctx.err('data/vocab.json', `"${k}" has duplicates`);
  }
  for (const a of v.areas || []) if (/[\/&,]/.test(a)) ctx.err('data/vocab.json', `area "${a}" is a compound; use one concept per area`);
}
