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
  // required non-empty strings, with a maximum length where the game's layout needs one
  strings: { generic: {}, sponsor: { max: 20 }, class: { max: 28 } },
  // optional non-empty strings
  optionalStrings: ['salt', 'revisionNote'],
  // fields whose value must come from data/vocab.json: field -> vocab list name
  vocab: { area: 'areas', route: 'routes', form: 'forms' },
  // fields whose membership in a vocab list is a warning (an error with strict): field -> vocab list name
  softVocab: { class: 'classes', sponsor: 'sponsors' },
  // fields handled by dedicated checks below
  other: ['id', 'brand', 'aliases', 'application', 'approved', 'pk', 'pill', 'structure', 'biologic', 'clues', 'tell', 'source', 'revised'],
  // present while an agent is writing or reviewing a dossier; checked, then dropped from the compiled day files
  reviewOnly: ['evidence', 'notes', 'review', 'scratch'],
  // pharmacokinetic fields: required fields must be positive numbers inside [lo, hi]
  pk: {
    tmaxH: { required: true, lo: 0.01, hi: 168, what: 'h' },
    halfLifeH: { required: true, lo: 0.05, hi: 2000, what: 'h' },
    cmax: { required: false, lo: 1e-3, hi: 1e6, needs: 'unit' },
    spanH: { required: false },
    periodH: { required: false },
  },
  models: ['absorption', 'bolus', 'infusion'],
  units: ['pg/mL', 'ng/mL', 'µg/mL', 'mg/L', 'ng/L'],
  contextTemplate: /^(?=.*\d)[^,]+, (single dose|steady state), (healthy adults|patients)$/,
  contextBanned: /\b(males?|females?|m[ae]n|wom[ae]n|boys?|girls?|volunteers?|child(?:ren)?|pediatric|paediatric|adolescents?|infants?|neonates?|elderly|geriatric|older|renal|hepatic|impairment|cancer|carcinoma|tumou?rs?|leuk[a]?emia|lymphoma|myeloma|melanoma|diabet\w*|hypertens\w*|asthma|epilepsy|seizures?|hiv|infections?|arthritis|depress\w*|schizophreni\w*|psoriasis|gerd|reflux|ulcers?|angina|heart failure|migraine|pain|obes\w*|osteoporosis)\b/i,
  slots: ['kinetics', 'substance', 'product', 'safety', 'indication', 'mechanism'],
  slotModule: { kinetics: 'Summaries', substance: 'Quality', product: 'Administrative', safety: 'Clinical', indication: 'Clinical', mechanism: 'Nonclinical', name: 'Administrative' },
  maxClue: 220,
  maxClueSentences: 2,
  maxTell: 140,
  biologicFormats: ['antibody', 'bispecific', 'fragment', 'fc-fusion', 'conjugate', 'peptide', 'protein', 'oligonucleotide'],
};
export const KNOWN_TOP = new Set([...Object.keys(FIELDS.strings), ...FIELDS.optionalStrings, ...Object.keys(FIELDS.vocab), ...FIELDS.other, ...FIELDS.reviewOnly, 'revisionNote']);

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
  for (const [, el, k] of formula.replace(/[+-]\d*$/, '').matchAll(/([A-Z][a-z]?)(\d*)/g)) counts[el] = (counts[el] || 0) + (k ? Number(k) : 1);
  return counts;
}

// ------------------------------------------------------------------ structure

export function validateStructure(ctx, where, s) {
  const before = ctx.errors.length;
  if (!s || typeof s !== 'object') return ctx.err(where, '"structure" must be an object');
  if (!Number.isInteger(s.cid) || s.cid <= 0) ctx.err(where, '"structure.cid" must be a positive integer');
  if (!isStr(s.formula) || !/^([A-Z][a-z]?\d*)+([+-]\d*)?$/.test(s.formula)) ctx.err(where, '"structure.formula" must be a molecular formula such as C22H30N6O4S (a trailing charge such as + is allowed)');
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
  if (!isStr(pk.context)) ctx.err(where, '"pk.context" is required');
  else {
    if (!FIELDS.contextTemplate.test(pk.context)) ctx.err(where, `"pk.context" is "${pk.context}"; use "{dose} {route}, {single dose | steady state}, {healthy adults | patients}"`);
    const bad = pk.context.match(FIELDS.contextBanned);
    if (bad) ctx.err(where, `"pk.context" says "${bad[0]}", which gives the answer away (no sex, age band, diet or disease)`);
  }
  if (!FIELDS.models.includes(pk.model)) ctx.err(where, `"pk.model" is "${pk.model}"; use one of ${FIELDS.models.join(', ')}`);
  const hasCmax = pk.cmax !== undefined;
  const hasUnit = pk.unit !== undefined;
  if (hasCmax !== hasUnit) ctx.err(where, '"pk.cmax" and "pk.unit" go together: give both, or leave both out when the label states no Cmax');
  if (hasUnit && !FIELDS.units.includes(pk.unit)) ctx.err(where, `"pk.unit" is "${pk.unit}"; use one of ${FIELDS.units.join(', ')}`);
  for (const [k, spec] of Object.entries(FIELDS.pk)) {
    const v = pk[k];
    if (v === undefined && !spec.required) continue;
    if (k === 'tmaxH' && pk.model === 'bolus' && v === 0) continue; // a bolus peaks at time zero
    if (!isNum(v) || v <= 0) { ctx.err(where, `"pk.${k}" must be a positive number (got ${JSON.stringify(v)})`); continue; }
    if (spec.lo === undefined) continue;
    const what = spec.what || pk.unit || '';
    if (v < spec.lo || v > spec.hi) ctx.err(where, `"pk.${k}" is ${v}, outside the plausible range ${spec.lo} to ${spec.hi} ${what}`);
  }
  for (const k of Object.keys(pk)) if (!['context', 'model', 'unit', ...Object.keys(FIELDS.pk)].includes(k)) ctx.warn(where, `unknown field "pk.${k}"`);
  if (pk.spanH !== undefined && isNum(pk.spanH) && isNum(pk.tmaxH) && pk.spanH < pk.tmaxH * 2) ctx.err(where, `"pk.spanH" (${pk.spanH}) is shorter than twice Tmax (${pk.tmaxH})`);
  if (isNum(pk.tmaxH) && isNum(pk.halfLifeH) && pk.model === 'absorption' && pk.tmaxH > pk.halfLifeH * 12) ctx.warn(where, `Tmax ${pk.tmaxH} h is more than 12 half-lives (${pk.halfLifeH} h); check the numbers`);
}

// ------------------------------------------------------------------ clues

const STEM_STOP = new Set(['acid', 'sodium', 'potassium', 'calcium', 'human', 'recombinant', 'factor', 'vitamin', 'hydrochloride', 'chloride', 'sulfate', 'phosphate', 'acetate', 'injection', 'tablets', 'capsules']);

// Distinctive stems of the generic and brand: first 5 letters of every word of 6+ letters, whole word otherwise (4-5 letters).
export function nameStems(d) {
  const out = new Map();
  const add = (word, why) => {
    const w = word.toLowerCase();
    if (w.length < 4 || STEM_STOP.has(w) || out.has(w.slice(0, 5))) return;
    const stem = w.slice(0, 5);
    out.set(stem, { stem, why, re: new RegExp(w.length <= 5 ? `\\b${w}\\b` : stem, 'i') });
  };
  for (const w of String(d.generic || '').split(/[^A-Za-z]+/)) add(w, 'generic name');
  for (const w of String(d.brand || '').split(/[^A-Za-z]+/)) add(w, 'brand name');
  return [...out.values()];
}

export const sentenceCount = t => t.trim().split(/(?<=[.!?])\s+(?=[A-Z0-9(])/).filter(Boolean).length;
const HALF_LIFE = /half[- ]?li(?:fe|ves)|\bt\s?(?:1\/2|½)|\bt\s?max\b|time to (?:peak|maximum|maximal)|peak (?:time|concentration time)/i;
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function validateClues(ctx, where, d) {
  const clues = d.clues;
  if (!clues || typeof clues !== 'object' || Array.isArray(clues)) return ctx.err(where, `"clues" must be an object with the slots ${FIELDS.slots.join(', ')}`);
  for (const k of Object.keys(clues)) if (!FIELDS.slots.includes(k)) ctx.err(where, `unknown clue slot "${k}"; the slots are ${FIELDS.slots.join(', ')}`);
  const banned = [...new Map([d.generic, d.brand, ...(d.aliases || []), d.salt].filter(isStr).map(s => [s.toLowerCase(), s])).values()];
  const stems = nameStems(d);
  for (const slot of FIELDS.slots) {
    const w = `${where} clue ${slot}`;
    const text = clues[slot];
    if (!isStr(text)) { ctx.err(w, 'is required (a non-empty string)'); continue; }
    if (text.length > FIELDS.maxClue) ctx.err(w, `is ${text.length} characters; the limit is ${FIELDS.maxClue}`);
    if (sentenceCount(text) > FIELDS.maxClueSentences) ctx.err(w, `has ${sentenceCount(text)} sentences; the limit is ${FIELDS.maxClueSentences}`);
    const low = text.toLowerCase();
    for (const b of banned) if (low.includes(b.toLowerCase())) ctx.err(w, `contains "${b}" (generic name, brand, alias or salt name): "${text}"`);
    if (!banned.some(b => low.includes(b.toLowerCase()))) for (const s of stems) if (s.re.test(text)) ctx.err(w, `contains "${s.stem}", the stem of the ${s.why}: "${text}"`);
    if (isStr(d.class) && ['kinetics', 'safety', 'indication'].includes(slot) && low.includes(d.class.toLowerCase())) ctx.err(w, `states the class "${d.class}", which this slot must not reveal`);
    if (slot === 'kinetics' && HALF_LIFE.test(text)) ctx.err(w, 'mentions half-life or Tmax, which the figure already shows');
    if (slot === 'product') {
      if (Number.isInteger(d.approved) && new RegExp(`\\b${d.approved}\\b`).test(text)) ctx.err(w, `states the approval year ${d.approved}`);
      if (isStr(d.sponsor) && low.includes(d.sponsor.toLowerCase())) ctx.err(w, `states the sponsor "${d.sponsor}"`);
    }
    if (slot === 'substance') {
      const formula = d.structure?.formula;
      if (formula && text.includes(formula.replace(/[+-]\d*$/, ''))) ctx.err(w, `states the formula ${formula}`);
      else if (/\bC\d{1,3}H\d{1,3}(?:[A-Z][a-z]?\d*)*/.test(text.normalize('NFKC'))) ctx.err(w, 'states a molecular formula');
      const b = d.biologic;
      if (b) for (const t of [b.format, ...(typeof b.isotype === 'string' ? b.isotype.split(/\s+/) : [])].filter(x => isStr(x) && x.length > 2)) if (new RegExp(esc(t), 'i').test(text)) ctx.err(w, `states the biologic format or isotype "${t}"`);
    }
  }
}

// ------------------------------------------------------------------ dossier

export function validateDossier(ctx, file, d, vocab, { strict = false } = {}) {
  const where = file;
  if (!d || typeof d !== 'object') return ctx.err(where, 'must be a JSON object');
  const soft = strict ? ctx.err : ctx.warn;
  const id = path.basename(file, '.json');
  if (!isStr(d.id) || !SLUG.test(d.id)) ctx.err(where, `"id" must be a lower-case slug (got ${JSON.stringify(d.id)})`);
  else if (d.id !== id) ctx.err(where, `"id" is "${d.id}" but the file is named ${id}.json`);
  for (const [f, spec] of Object.entries(FIELDS.strings)) {
    if (!isStr(d[f])) ctx.err(where, `"${f}" is required`);
    else if (spec.max && d[f].length > spec.max) ctx.err(where, `"${f}" is ${d[f].length} characters; the limit is ${spec.max}`);
  }
  if (d.brand !== null && !isStr(d.brand)) ctx.err(where, '"brand" must be a string, or null when the drug has no US brand');
  for (const f of FIELDS.optionalStrings) if (d[f] !== undefined && !isStr(d[f])) ctx.err(where, `"${f}" must be a non-empty string when present`);
  if (!Array.isArray(d.aliases) || d.aliases.some(a => !isStr(a))) ctx.err(where, '"aliases" must be an array of strings (may be empty)');
  if (!isStr(d.application) || !/^(NDA|ANDA|BLA) \d{5,6}$/.test(d.application)) ctx.err(where, `"application" must look like "NDA 020895" (got ${JSON.stringify(d.application)})`);
  if (!Number.isInteger(d.approved) || d.approved < 1938 || d.approved > new Date().getFullYear()) ctx.err(where, `"approved" must be a year from 1938 to now (got ${JSON.stringify(d.approved)})`);
  for (const [field, list] of Object.entries(FIELDS.vocab)) checkVocab(ctx, where, field, d[field], vocab[list]);
  for (const [field, list] of Object.entries(FIELDS.softVocab)) {
    if (isStr(d[field]) && Array.isArray(vocab[list]) && !vocab[list].includes(d[field])) soft(where, `"${field}" is "${d[field]}", which is not in data/vocab.json ${list}`);
  }
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
  if (d.structure !== undefined && d.biologic !== undefined) ctx.err(where, 'has both "structure" and "biologic"; a drug has one or the other');
  if (d.structure === undefined && d.biologic === undefined) ctx.warn(where, 'has neither "structure" nor "biologic" (fine for an inorganic such as lithium, otherwise add one)');
  if (d.structure !== undefined) validateStructure(ctx, where, d.structure);
  if (d.biologic !== undefined) {
    const b = d.biologic;
    if (!b || typeof b !== 'object') ctx.err(where, '"biologic" must be an object');
    else {
      if (!FIELDS.biologicFormats.includes(b.format)) ctx.err(where, `"biologic.format" is ${JSON.stringify(b.format)}; use one of ${FIELDS.biologicFormats.join(', ')}`);
      if (b.isotype !== null && !isStr(b.isotype)) ctx.err(where, '"biologic.isotype" must be a string or null');
      if (!isNum(b.massKDa) || b.massKDa <= 0) ctx.err(where, '"biologic.massKDa" must be a positive number');
    }
  }
  validateClues(ctx, where, d);
  if (!isStr(d.tell)) ctx.err(where, '"tell" is required (one sentence shown after the game)');
  else if (d.tell.length > FIELDS.maxTell) ctx.err(where, `"tell" is ${d.tell.length} characters; the limit is ${FIELDS.maxTell}`);
  if (d.revised !== undefined && !isDate(d.revised)) ctx.err(where, '"revised" must be a YYYY-MM-DD date');
  if (d.revisionNote !== undefined && d.revised === undefined) ctx.warn(where, '"revisionNote" without "revised"');
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

// ------------------------------------------------------------------ guessables, dictionary, vocab

export function guessable(d) {
  return { id: d.id, generic: d.generic, brand: d.brand, aliases: d.aliases, area: d.area, class: d.class, sponsor: d.sponsor, approved: d.approved };
}

export function validateDictionary(ctx, list, vocab, { strict = false } = {}) {
  if (!Array.isArray(list)) return ctx.err('data/dictionary.json', 'must be an array');
  const soft = strict ? ctx.err : ctx.warn;
  const ids = new Set();
  list.forEach((g, i) => {
    const w = `data/dictionary.json [${i}] ${g?.id ?? ''}`.trim();
    if (!g || typeof g !== 'object') return ctx.err(w, 'must be an object');
    if (!isStr(g.id) || !SLUG.test(g.id)) ctx.err(w, `"id" must be a lower-case slug (got ${JSON.stringify(g.id)})`);
    else if (ids.has(g.id)) ctx.err(w, `duplicate id "${g.id}"`);
    else ids.add(g.id);
    for (const f of ['generic', 'sponsor', 'class']) if (!isStr(g[f])) ctx.err(w, `"${f}" is required`);
    if (g.brand !== null && !isStr(g.brand)) ctx.err(w, '"brand" must be a string or null');
    if (!Array.isArray(g.aliases) || g.aliases.some(a => !isStr(a))) ctx.err(w, '"aliases" must be an array of strings');
    checkVocab(ctx, w, 'area', g.area, vocab.areas);
    if (!Number.isInteger(g.approved) || g.approved < 1938 || g.approved > new Date().getFullYear()) ctx.err(w, `"approved" must be a year from 1938 to now (got ${JSON.stringify(g.approved)})`);
    for (const [field, l] of Object.entries(FIELDS.softVocab)) if (isStr(g[field]) && Array.isArray(vocab[l]) && !vocab[l].includes(g[field])) soft(w, `"${field}" is "${g[field]}", which is not in data/vocab.json ${l}`);
    for (const k of Object.keys(g)) if (!['id', 'generic', 'brand', 'aliases', 'area', 'class', 'sponsor', 'approved'].includes(k)) ctx.err(w, `unknown field "${k}"`);
  });
}

export function validateVocab(ctx, v) {
  if (!v) return;
  for (const k of ['areas', 'routes', 'forms', 'pillShapes', 'classes', 'sponsors']) {
    if (!Array.isArray(v[k]) || !v[k].length || v[k].some(x => !isStr(x))) ctx.err('data/vocab.json', `"${k}" must be a non-empty array of strings`);
    else if (new Set(v[k]).size !== v[k].length) ctx.err('data/vocab.json', `"${k}" has duplicates`);
  }
  for (const a of v.areas || []) if (/[\/&,]/.test(a)) ctx.err('data/vocab.json', `area "${a}" is a compound; use one concept per area`);
  for (const c of v.classes || []) if (c.length > FIELDS.strings.class.max) ctx.err('data/vocab.json', `class "${c}" is longer than ${FIELDS.strings.class.max} characters`);
  for (const c of v.sponsors || []) if (c.length > FIELDS.strings.sponsor.max) ctx.err('data/vocab.json', `sponsor "${c}" is longer than ${FIELDS.strings.sponsor.max} characters`);
}
