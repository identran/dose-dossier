// openFDA label + Drugs@FDA access. Importable; the CLI wrapper is tools/fetch-label.mjs.
import { getJSON } from './http.mjs';

const API = 'https://api.fda.gov/drug';

// Sections a dossier is written from, in reading order, with a character cap for the digest.
export const SECTIONS = [
  ['description', 1500],
  ['indications_and_usage', 1800],
  ['dosage_forms_and_strengths', 1200],
  ['boxed_warning', 1200],
  ['contraindications', 1200],
  ['mechanism_of_action', 1500],
  ['pharmacokinetics', 7000],
  ['clinical_pharmacology', 7000],
  ['adverse_reactions', 1800],
  ['warnings_and_cautions', 1500],
  ['nonclinical_toxicology', 1500],
  ['how_supplied', 2500],
];

const q = s => encodeURIComponent(`"${s}"`);

export function isApplicationNumber(s) {
  return /^(NDA|ANDA|BLA)\s*-?\s*\d{5,6}$/i.test(s.trim());
}

export function normalizeApplication(s) {
  const m = s.trim().match(/^(NDA|ANDA|BLA)\s*-?\s*(\d{5,6})$/i);
  return m ? `${m[1].toUpperCase()}${m[2].padStart(6, '0')}` : null;
}

// Collapse a label section (array of strings, often with table text) to tidy plain text.
export function cleanText(s) {
  return String(s)
    .replace(/\r/g, '')
    .replace(/[ \t ]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

export function trimTo(text, cap) {
  if (text.length <= cap) return text;
  const cut = text.slice(0, cap);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('\n'));
  return (stop > cap * 0.6 ? cut.slice(0, stop + 1) : cut) + ' [...]';
}

// Find the current label. `query` is an application number (NDA 020895) or a brand name.
export async function findLabel(query) {
  const app = isApplicationNumber(query) ? normalizeApplication(query) : null;
  const field = app ? `openfda.application_number:${q(app)}` : `openfda.brand_name:${q(query)}`;
  const res = await getJSON(`${API}/label.json?search=${field}&limit=20`);
  const rows = res?.results || [];
  if (!rows.length) throw new Error(`No openFDA label found for "${query}"`);
  const wanted = String(query).toLowerCase();
  const score = r => {
    const brands = (r.openfda?.brand_name || []).map(b => b.toLowerCase());
    // Repackager labels (A-S Medication, Cardinal, ...) copy the sponsor's text; prefer the sponsor's own.
    return (r.openfda?.is_original_packager ? 4 : 0) + (brands.includes(wanted) ? 2 : 0) + (r.pharmacokinetics || r.clinical_pharmacology ? 1 : 0);
  };
  rows.sort((a, b) => score(b) - score(a) || String(b.effective_time).localeCompare(String(a.effective_time)));
  return { label: rows[0], alternatives: rows.slice(1).map(r => ({ setId: r.set_id, brand: r.openfda?.brand_name, manufacturer: r.openfda?.manufacturer_name, effective: r.effective_time })) };
}

// Original approval from Drugs@FDA: earliest ORIG submission date, per application.
export async function fetchApprovals(applicationNumbers) {
  const out = [];
  for (const app of applicationNumbers) {
    const res = await getJSON(`${API}/drugsfda.json?search=application_number:${q(app)}&limit=1`);
    const r = res?.results?.[0];
    if (!r) { out.push({ application: app, found: false }); continue; }
    const orig = (r.submissions || [])
      .filter(s => s.submission_type === 'ORIG' && s.submission_status_date)
      .map(s => s.submission_status_date)
      .sort();
    // Applications approved before ~1992 often carry no ORIG submission in Drugs@FDA; say so rather than guess.
    out.push({
      application: app,
      found: true,
      sponsor: r.sponsor_name,
      brands: [...new Set((r.products || []).map(p => p.brand_name))],
      approved: orig[0] ? `${orig[0].slice(0, 4)}-${orig[0].slice(4, 6)}-${orig[0].slice(6, 8)}` : null,
      year: orig[0] ? Number(orig[0].slice(0, 4)) : null,
    });
  }
  return out;
}

export async function fetchLabelDigest(query, { also = [] } = {}) {
  const { label, alternatives } = await findLabel(query);
  const of = label.openfda || {};
  const apps = of.application_number || [];
  // `also`: related applications whose approval belongs to the same product (e.g. an earlier capsule NDA).
  const approvals = await fetchApprovals([...new Set([...apps, ...also.map(a => normalizeApplication(a) || a)])]);
  const sections = {};
  for (const [name, cap] of SECTIONS) {
    const raw = label[name];
    if (raw) sections[name] = trimTo(cleanText(Array.isArray(raw) ? raw.join('\n') : raw), cap);
  }
  const setId = label.set_id;
  return {
    query,
    setId,
    effective: label.effective_time,
    label: `https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=${setId}`,
    openfda: of,
    approvals,
    sections,
    alternatives,
  };
}

export function digestToText(d) {
  const lines = [];
  lines.push(`LABEL DIGEST for "${d.query}"`);
  lines.push(`set id: ${d.setId}   effective: ${d.effective}`);
  lines.push(`dailymed: ${d.label}`);
  lines.push('');
  lines.push('== openfda ==');
  for (const [k, v] of Object.entries(d.openfda)) lines.push(`${k}: ${Array.isArray(v) ? v.join('; ') : v}`);
  lines.push('');
  lines.push('== drugs@fda (earliest ORIG submission) ==');
  for (const a of d.approvals) lines.push(a.found ? `${a.application}: ${a.approved || 'no ORIG submission on record (pre-electronic; take the year from the FDA approval letter)'}  sponsor ${a.sponsor}  brands ${a.brands.join(', ')}` : `${a.application}: not in drugsfda`);
  for (const [name, text] of Object.entries(d.sections)) {
    lines.push('');
    lines.push(`== ${name} ==`);
    lines.push(text);
  }
  if (d.alternatives.length) {
    lines.push('');
    lines.push('== other matching labels (not used) ==');
    for (const a of d.alternatives) lines.push(`${a.setId} ${a.effective} ${[].concat(a.brand || []).join(', ')} / ${[].concat(a.manufacturer || []).join(', ')}`);
  }
  return lines.join('\n') + '\n';
}
