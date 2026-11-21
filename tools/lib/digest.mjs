// Compact plain-text digest of one label for the extraction agents. Trims and tidies; never rewrites words
// (the validator matches quotes against this text).
import { cleanLabelText, trimAt, sentences } from './text.mjs';

export const HARD_MAX = 12000;
const TARGET_MAX = 11500;

const TITLES = {
  boxed_warning: null,
  indications_and_usage: /^(?:\d+\.?\s+)?INDICATIONS\s*(?:AND|&)\s*USAGE\s*/i,
  dosage_forms_and_strengths: /^(?:\d+\.?\s+)?DOSAGE FORMS\s*(?:AND|&)\s*STRENGTHS\s*/i,
  contraindications: /^(?:\d+\.?\s+)?CONTRAINDICATIONS\s*/i,
  description: /^(?:\d+\.?\s+)?DESCRIPTION\s*/i,
  mechanism_of_action: /^(?:12\.1\s+)?Mechanism of Action:?\s*/i,
  pharmacokinetics: /^(?:12\.3\s+)?Pharmacokinetics:?\s*/i,
  adverse_reactions: /^(?:6\.?\s+)?ADVERSE REACTIONS\s*/i,
  nonclinical_toxicology: /^(?:13\.?\s+)?NONCLINICAL TOXICOLOGY\s*/i,
  how_supplied: /^(?:16\.?\s+)?HOW SUPPLIED(?:\s*\/\s*STORAGE AND HANDLING)?\s*/i,
};

const get = (label, name) => {
  const t = cleanLabelText(label[name]);
  return TITLES[name] ? t.replace(TITLES[name], '') : t;
};

// ---- pharmacokinetics

const SPECIAL = new RegExp([
  String.raw`(?:^|[.)\]]\s)(?:Pharmacokinetics in )?(?:Special|Specific) Populations?\b`,
  String.raw`\bDrug[- ]Drug Interaction`,
  String.raw`\bDrug Interaction Studies?\b`,
  String.raw`(?:^|[.)]\s)Drug Interactions?\b`,
  String.raw`\bEffects? of (?:Other |Concomitant )?Drugs? on\b`,
  String.raw`(?:^|[.)]\s)(?:Geriatric|Pediatric|Renal Impairment|Hepatic Impairment|Patients with (?:Renal|Hepatic) Impairment|Gender|Sex|Race)\b`,
].join('|'));

const HALF_LIFE = /half-?\s?li(?:fe|ves)|t\s?1\/2|t½|t ½/i;

function pharmacokinetics(label) {
  const own = get(label, 'pharmacokinetics');
  if (own.length > 200) return { text: own, source: 'pharmacokinetics field' };
  const cp = cleanLabelText(label.clinical_pharmacology);
  if (!cp) return own ? { text: own, source: 'pharmacokinetics field (short)' } : { text: '', source: 'missing' };
  const m = /\b12\.3\s+Pharmacokinetics\b/.exec(cp);
  if (m) {
    const rest = cp.slice(m.index);
    const end = /\b12\.[4-9]\s+(?=[A-Z])/.exec(rest.slice(20));
    return { text: (end ? rest.slice(0, end.index + 20) : rest).replace(TITLES.pharmacokinetics, ''), source: 'cut from clinical_pharmacology (12.3)' };
  }
  const old = /(?<![a-z,] )(?:PHARMACOKINETICS|Pharmacokinetics)\b(?!\s+(?:of|in)\b)/.exec(cp);
  if (old) {
    const rest = cp.slice(old.index);
    const end = /\b(?:PHARMACODYNAMICS|Pharmacodynamics|MICROBIOLOGY|Microbiology|CLINICAL STUDIES|Clinical Studies|Pharmacogenomics|ANIMAL PHARMACOLOGY|Animal Pharmacology)\b/.exec(rest.slice(200));
    return { text: end ? rest.slice(0, end.index + 200) : rest, source: 'cut from clinical_pharmacology (heading)' };
  }
  // Old-format label with PK mixed into the general text: keep the sentences that talk about PK, in label order.
  const pkWords = /absorb|bioavailab|peak|half-?\s?life|t\s?1\/2|plasma|serum|protein.bound|bound to|metaboli|excret|eliminat|clearance|urine|urinary|feces|fecal|C\s?max|T\s?max|AUC|steady.state|volume of distribution|concentrations? (?:of|in|was|were|reach)/i;
  const kept = cp.length > 3000 ? sentences(cp).filter(x => pkWords.test(x)).join(' ') : cp;
  return { text: kept || cp, source: 'clinical_pharmacology, PK sentences only (no PK heading found)' };
}

function trimPk(text, cap) {
  if (text.length <= cap) return text;
  const m = SPECIAL.exec(text.slice(Math.floor(text.length * 0.2)));
  let kept = text;
  let dropped = '';
  if (m) {
    const at = Math.floor(text.length * 0.2) + m.index + (m[0].match(/^[.)\]]\s/) ? 2 : 0);
    if (at > 800) { kept = text.slice(0, at).trim(); dropped = text.slice(at); }
  }
  let out = trimAt(kept, cap);
  // Never lose the half-life: if the kept part has none, add the first sentence of the full text that does.
  if (!HALF_LIFE.test(out)) {
    const hit = sentences(text).find(x => HALF_LIFE.test(x));
    if (hit) out += ` [...] ${hit.length > 500 ? hit.slice(0, 500) : hit}`;
  }
  return out;
}

// ---- other sections

function descriptionKeep(text, cap) {
  if (text.length <= 1400) return trimAt(text, cap);
  const keep = /chemical|designated|name|formula|molecular|C\d+H\d+|white|off-white|crystalline|powder|solid|solubl|insoluble|freely|practically|slightly|inactive ingredient|excipient|each (?:tablet|capsule|mL|vial)|contains|supplied as/i;
  const picked = sentences(text).filter(s => keep.test(s));
  return trimAt((picked.length ? picked.join(' ') : text), cap);
}

function commonAdverse(text, cap) {
  const ss = sentences(text);
  const hit = ss.filter(s => /most (?:common|frequent)|commonly (?:reported|observed)|most frequently|incidence (?:of|was)|adverse reactions? (?:\(|reported|occurring)/i.test(s) && !/^the following/i.test(s));
  if (hit.length) return trimAt(hit.slice(0, 2).join(' '), cap);
  return trimAt(ss.filter(s => !/^the following|discussed in more detail/i.test(s)).join(' '), 400);
}

function mechanism(label) {
  const own = get(label, 'mechanism_of_action');
  if (own) return own;
  const cp = cleanLabelText(label.clinical_pharmacology);
  const m = /\b12\.1\s+Mechanism of Action\b/.exec(cp);
  if (!m) return '';
  const rest = cp.slice(m.index);
  const end = /\b12\.[2-9]\s+(?=[A-Z])/.exec(rest.slice(20));
  return (end ? rest.slice(0, end.index + 20) : rest).replace(TITLES.mechanism_of_action, '');
}

function productLines(rec) {
  const groups = new Map();
  for (const p of rec.products || []) {
    const k = `${p.form} (${(p.route || '').toLowerCase()})`;
    if (!groups.has(k)) groups.set(k, new Set());
    const st = (p.strength || '').replace(/\*\*.*?\*\*/g, '').replace(/\s+/g, ' ').trim();
    if (st) groups.get(k).add(st);
  }
  return [...groups].map(([k, s]) => `${k}: ${[...s].join('; ') || 'strength not listed'}`);
}

// ---- tables: openFDA gives them as HTML strings; render rows as "cell | cell" lines

const PK_WORDS = /C\s?max|T\s?max|AUC|half-?\s?li(?:fe|ves)|t\s?1\/2|clearance|bioavailab|steady.state/gi;
const OFF_TOPIC = /co-?administ|drug interaction|interaction|effect of .{0,40} on|impair|renal|hepatic|pediatric|paediatric|geriatric|elderly|age group|gender|race/i;

export function tableToText(html) {
  const cap = /<caption[^>]*>([\s\S]*?)<\/caption>/i.exec(html);
  const lines = [];
  if (cap) lines.push(cleanLabelText(cap[1]));
  for (const row of String(html).split(/<\/tr>/i)) {
    const cells = [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(m => cleanLabelText(m[1])).filter(Boolean);
    if (cells.length === 1 && cells[0].length > 90) continue; // footnote
    if (cells.length) lines.push(cells.join(' | '));
  }
  return lines.filter(Boolean);
}

function pkTables(label, cap) {
  const raw = [...[].concat(label.pharmacokinetics_table || []), ...[].concat(label.clinical_pharmacology_table || [])];
  const seen = new Set();
  const scored = [];
  raw.forEach((html, i) => {
    const lines = tableToText(html);
    const text = lines.join('\n');
    if (!text || seen.has(text)) return;
    seen.add(text);
    const hits = (text.match(PK_WORDS) || []).length;
    if (!hits) return;
    const head = lines.slice(0, 2).join(' ').slice(0, 250);
    if (OFF_TOPIC.test(head)) return; // interaction and special-population tables are not for the figure
    scored.push({ lines, score: Math.min(hits, 8) - i * 0.01 });
  });
  scored.sort((a, b) => b.score - a.score);
  const out = [];
  let used = 0;
  for (const t of scored) {
    const keep = [];
    for (const l of t.lines) { if (used + l.length + 1 > cap || keep.join('\n').length + l.length > 1300) break; keep.push(l); used += l.length + 1; }
    if (keep.length > 1) out.push(keep.join('\n'));
    if (used >= cap - 60) break;
  }
  return out.join('\n\n');
}

const INJECTED = /intravenous|subcutaneous|intramuscular|intrathecal|intravitreal|intra-?articular|epidural|infus|inject/i;
const DURATION = [
  /infus\w*[^.]{0,80}\bover\b[^.]{0,40}?\d/i,
  /\bover\s+(?:approximately|about|at least|no less than|a period of|a minimum of)?\s*\d+(?:\.\d+)?(?:\s*(?:to|-|or)\s*\d+(?:\.\d+)?)?\s*(?:minutes?|mins?|hours?|hrs?|seconds?)/i,
  /\b\d+(?:\.\d+)?[- ](?:minute|hour|second)\s+(?:intravenous\s+)?(?:infusion|injection)/i,
  /intravenous(?:ly)?\s+(?:bolus|push)|\bIV\s+(?:bolus|push)|\bbolus\b/i,
  /subcutaneous(?:ly)?\s+(?:injection|inject)[^.]{0,60}(?:once|every|weekly|monthly|daily)|(?:once|every)\s+(?:\d+\s+)?(?:weekly|monthly|daily|weeks?|months?|days?)[^.]{0,60}subcutaneous/i,
  /(?:administered|given|infused|injected)\s+(?:as\s+)?(?:an?\s+)?(?:intravenous|subcutaneous|intramuscular)\s+(?:infusion|injection)/i,
];
const INJ_ROUTE = /intravenous|subcutaneous|intramuscular|intrathecal|intravitreal|infus|inject/i;
// Sentences that say how and how fast the product is given come first, then other dosing-route text.
function administration(rec, label, cap) {
  const given = [...(rec.routes || []), ...(rec.products || []).map(p => `${p.form} ${p.route}`)].join(' ');
  if (!INJ_ROUTE.test(given)) return '';
  const text = cleanLabelText(label.dosage_and_administration);
  const all = sentences(text).map(x => (x.length > 450 ? x.slice(0, 450) : x));
  const seen = new Set();
  const first = [], rest = [];
  const key = /infus|bolus|inject|once (?:weekly|every|monthly|daily)|every \d+ (?:weeks?|days?|hours?|months?)/i;
  for (const x of all) {
    const k = x.toLowerCase().replace(/\W+/g, ' ');
    if (seen.has(k)) continue;
    seen.add(k);
    if (DURATION.some(r => r.test(x))) first.push(x); else if (key.test(x)) rest.push(x);
  }
  const picked = [...first, ...rest];
  return picked.length ? trimAt(picked.join(' '), cap) : '';
}

export function buildDigest(rec, label, structure = null) {
  const caps = { tables: 2000, admin: 600, boxed: 600, ind: 900, forms: 600, contra: 700, desc: 1500, moa: 1400, pk: 6500, ae: 500, nonclin: 500, supplied: 700 };
  const pk = pharmacokinetics(label);
  const raw = {
    boxed: get(label, 'boxed_warning'),
    ind: get(label, 'indications_and_usage'),
    forms: get(label, 'dosage_forms_and_strengths'),
    contra: get(label, 'contraindications'),
    desc: get(label, 'description'),
    moa: mechanism(label),
    ae: get(label, 'adverse_reactions'),
    nonclin: get(label, 'nonclinical_toxicology') || cleanLabelText(label.carcinogenesis_and_mutagenesis_and_impairment_of_fertility),
    supplied: get(label, 'how_supplied'),
  };
  const make = c => ({
    boxed: raw.boxed && trimAt(raw.boxed, c.boxed),
    ind: raw.ind && trimAt(raw.ind, c.ind),
    forms: raw.forms && trimAt(raw.forms, c.forms),
    contra: raw.contra && trimAt(raw.contra, c.contra),
    desc: raw.desc && descriptionKeep(raw.desc, c.desc),
    moa: raw.moa && trimAt(raw.moa, c.moa),
    pk: pk.text && trimPk(pk.text, c.pk),
    ae: raw.ae && commonAdverse(raw.ae, c.ae),
    nonclin: raw.nonclin && trimAt(raw.nonclin, c.nonclin),
    supplied: raw.supplied && trimAt(raw.supplied, c.supplied),
    tables: pkTables(label, c.tables),
    admin: administration(rec, label, c.admin),
  });

  const header = [`DIGEST ${rec.id}`, `Generic: ${rec.generic}`, `Brand: ${rec.labelBrand || rec.brand || ''}`, `Application: ${rec.application}`];
  if (rec.approvedYear) header.push(`Original approval year: ${rec.approvedYear} (earliest original approval date ${rec.approved}, Drugs@FDA)`);
  else header.push(`Original approval year: not on record in Drugs@FDA${rec.approvedNote ? ' (' + rec.approvedNote + ')' : ''}`);
  if (rec.firstApprovalSameMoiety && rec.firstApprovalSameMoiety.application !== rec.application) header.push(`First approval of this active ingredient: ${rec.firstApprovalSameMoiety.date} (${rec.firstApprovalSameMoiety.application})`);
  header.push(`Current manufacturer: ${rec.manufacturer || ''}`, `Label effective: ${rec.effective || ''}`, `Routes: ${(rec.routes || []).join(', ')}`);
  const pl = productLines(rec);
  if (pl.length) header.push('Dosage forms and strengths (Drugs@FDA):', ...pl.map(l => `  ${l}`));
  if (structure?.formula) header.push(`Parent compound (PubChem CID ${structure.cid}): formula ${structure.formula}${structure.molecularWeight ? `, molecular weight ${structure.molecularWeight}` : ''}`);
  header.push(`PK text source: ${pk.source}`);

  const render = parts => {
    const out = [header.join('\n')];
    const add = (title, text) => { if (text) out.push(`## ${title}\n${text}`); };
    add('Boxed warning', parts.boxed);
    add('Indications and usage', parts.ind);
    add('Dosage forms and strengths', parts.forms);
    add('Administration', parts.admin);
    add('Contraindications', parts.contra);
    add('Description', parts.desc);
    add('Mechanism of action', parts.moa);
    out.push(`## Pharmacokinetics\n${parts.pk || '(this label has no pharmacokinetics text)'}`);
    add('Pharmacokinetic tables', parts.tables);
    add('Most common adverse reactions', parts.ae);
    add('Nonclinical toxicology', parts.nonclin);
    add('How supplied', parts.supplied);
    return out.join('\n\n') + '\n';
  };

  let text = render(make(caps));
  // Keep under budget: shrink the long sections in turn, PK last and never below 3500.
  const order = [['desc', 1000], ['tables', 1200], ['ind', 600], ['moa', 700], ['contra', 450], ['supplied', 450], ['pk', 3500], ['nonclin', 350], ['ae', 350], ['forms', 350]];
  for (const [k, floor] of order) {
    while (Buffer.byteLength(text) > TARGET_MAX && caps[k] > floor) { caps[k] = Math.max(floor, Math.floor(caps[k] * 0.85)); text = render(make(caps)); }
  }
  if (Buffer.byteLength(text) > HARD_MAX) {
    caps.pk = 2500; caps.desc = 700; caps.ind = 400; caps.tables = 900; text = render(make(caps));
  }
  return { text, bytes: Buffer.byteLength(text), pkSource: pk.source, missing: Object.entries(make(caps)).filter(([, v]) => !v).map(([k]) => k) };
}
