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

const HALF_LIFE = /half-?\s?lives?|t\s?1\/2|t½|t ½/i;

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
  return { text: cp, source: 'whole clinical_pharmacology (no PK heading found)' };
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
  // Never lose the half-life: if only the dropped part mentions one, keep its first such sentence.
  if (dropped && !HALF_LIFE.test(kept)) {
    const s = sentences(dropped).find(x => HALF_LIFE.test(x));
    if (s) kept += ` [...] ${s}`;
  }
  return trimAt(kept, cap);
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

export function buildDigest(rec, label) {
  const caps = { boxed: 600, ind: 900, forms: 600, contra: 700, desc: 1500, moa: 1400, pk: 6500, ae: 500, nonclin: 500, supplied: 700 };
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
  });

  const header = [`DIGEST ${rec.id}`, `Generic: ${rec.generic}`, `Brand: ${rec.labelBrand || rec.brand || ''}`, `Application: ${rec.application}`];
  if (rec.approvedYear) header.push(`Original approval year: ${rec.approvedYear} (earliest original approval date ${rec.approved}, Drugs@FDA)`);
  else header.push(`Original approval year: not on record in Drugs@FDA${rec.approvedNote ? ' (' + rec.approvedNote + ')' : ''}`);
  if (rec.firstApprovalSameMoiety && rec.firstApprovalSameMoiety.application !== rec.application) header.push(`First approval of this active ingredient: ${rec.firstApprovalSameMoiety.date} (${rec.firstApprovalSameMoiety.application})`);
  header.push(`Current manufacturer: ${rec.manufacturer || ''}`, `Label effective: ${rec.effective || ''}`, `Routes: ${(rec.routes || []).join(', ')}`);
  const pl = productLines(rec);
  if (pl.length) header.push('Dosage forms and strengths (Drugs@FDA):', ...pl.map(l => `  ${l}`));
  header.push(`PK text source: ${pk.source}`);

  const render = parts => {
    const out = [header.join('\n')];
    const add = (title, text) => { if (text) out.push(`## ${title}\n${text}`); };
    add('Boxed warning', parts.boxed);
    add('Indications and usage', parts.ind);
    add('Dosage forms and strengths', parts.forms);
    add('Contraindications', parts.contra);
    add('Description', parts.desc);
    add('Mechanism of action', parts.moa);
    out.push(`## Pharmacokinetics\n${parts.pk || '(this label has no pharmacokinetics text)'}`);
    add('Most common adverse reactions', parts.ae);
    add('Nonclinical toxicology', parts.nonclin);
    add('How supplied', parts.supplied);
    return out.join('\n\n') + '\n';
  };

  let text = render(make(caps));
  // Keep under budget: shrink the long sections in turn, PK last and never below 3500.
  const order = [['desc', 1000], ['ind', 600], ['moa', 700], ['contra', 450], ['supplied', 450], ['pk', 3500], ['nonclin', 350], ['ae', 350], ['forms', 350]];
  for (const [k, floor] of order) {
    while (Buffer.byteLength(text) > TARGET_MAX && caps[k] > floor) { caps[k] = Math.max(floor, Math.floor(caps[k] * 0.85)); text = render(make(caps)); }
  }
  if (Buffer.byteLength(text) > HARD_MAX) {
    caps.pk = 2500; caps.desc = 700; caps.ind = 400; text = render(make(caps));
  }
  return { text, bytes: Buffer.byteLength(text), pkSource: pk.source, missing: Object.entries(make(caps)).filter(([, v]) => !v).map(([k]) => k) };
}
