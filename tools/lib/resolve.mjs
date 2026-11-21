// Resolve a candidate drug to its US prescription label (openFDA) and approval facts (Drugs@FDA).
import { getJSON } from './http.mjs';
import { flat, cleanLabelText } from './text.mjs';

const API = 'https://api.fda.gov/drug';
const quote = s => encodeURIComponent(`"${String(s).replace(/"/g, '')}"`);
const APP_FILTER = '(openfda.application_number:NDA*+OR+openfda.application_number:BLA*)';

// Label fields kept in the cache; everything else (package panels, patient leaflets, tables) is dropped.
export const KEEP = new Set(['id', 'set_id', 'version', 'effective_time', 'openfda', 'boxed_warning', 'indications_and_usage',
  'dosage_forms_and_strengths', 'contraindications', 'description', 'mechanism_of_action', 'pharmacokinetics',
  'clinical_pharmacology', 'adverse_reactions', 'nonclinical_toxicology', 'carcinogenesis_and_mutagenesis_and_impairment_of_fertility',
  'how_supplied', 'dosage_and_administration']);
export const KEY_SECTIONS = ['boxed_warning', 'indications_and_usage', 'dosage_forms_and_strengths', 'contraindications', 'description',
  'mechanism_of_action', 'pharmacokinetics', 'clinical_pharmacology', 'adverse_reactions', 'nonclinical_toxicology', 'how_supplied'];

const slimLabels = body => ({
  meta: { total: body?.meta?.results?.total },
  results: (body?.results || []).map(r => Object.fromEntries(Object.entries(r).filter(([k]) => KEEP.has(k)))),
});
const slimFda = body => ({
  meta: { total: body?.meta?.results?.total },
  results: (body?.results || []).map(r => ({
    application_number: r.application_number,
    sponsor_name: r.sponsor_name,
    products: (r.products || []).map(p => ({ brand_name: p.brand_name, dosage_form: p.dosage_form, route: p.route, marketing_status: p.marketing_status, active_ingredients: p.active_ingredients })),
    submissions: (r.submissions || []).map(s => ({ submission_type: s.submission_type, submission_status: s.submission_status, submission_status_date: s.submission_status_date })),
  })),
});

// ---------------------------------------------------------------- names

const SALT_WORDS = new Set(['hydrochloride', 'hydrobromide', 'hcl', 'dihydrochloride', 'sodium', 'disodium', 'potassium', 'dipotassium', 'calcium',
  'magnesium', 'zinc', 'mesylate', 'mesilate', 'dimesylate', 'besylate', 'maleate', 'fumarate', 'succinate', 'tartrate', 'bitartrate', 'citrate',
  'phosphate', 'sulfate', 'sulphate', 'acetate', 'bromide', 'chloride', 'nitrate', 'hemihydrate', 'monohydrate', 'dihydrate', 'trihydrate',
  'sesquihydrate', 'anhydrous', 'hydrate', 'tosylate', 'lactate', 'gluconate', 'oxalate', 'malate', 'hydroxide', 'pamoate', 'xinafoate',
  'napsylate', 'edisylate', 'hyclate', 'carbonate', 'benzoate', 'ethanolate', 'tromethamine', 'meglumine', 'oral', 'injection', 'solution']);

// "IMATINIB MESYLATE" -> "imatinib", "Insulin glargine-yfgn" -> "insulin glargine"
export function moiety(name) {
  const words = String(name).toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim().split(' ')
    .filter(w => w && !SALT_WORDS.has(w));
  return words.join(' ');
}

export function slug(s) {
  return moiety(s).replace(/ /g, '-') || String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

const sameMoiety = (a, b) => a === b || a.startsWith(b + ' ') || b.startsWith(a + ' ');

export function distinctMoieties(names) {
  const out = [];
  for (const n of names.map(moiety).filter(Boolean)) if (!out.some(o => sameMoiety(o, n))) out.push(n);
  return out;
}

// Substances of a label row: openfda.substance_name, else generic_name split on " and " / "," / "/".
function substances(row) {
  const of = row.openfda || {};
  if (of.substance_name?.length) return of.substance_name;
  return (of.generic_name || []).flatMap(g => g.split(/\s+and\s+|,|\//i));
}

function matchesCandidate(row, cand) {
  const want = moiety(cand.generic);
  if (!want) return true;
  const have = substances(row).map(moiety);
  const names = [...have, ...(row.openfda?.generic_name || []).map(moiety)];
  return names.some(n => n && (sameMoiety(n, want) || n.includes(want) || want.includes(n)));
}

const appNumbers = row => (row.openfda?.application_number || []).filter(a => /^(NDA|BLA)\d+$/.test(a));
export const formatApp = a => a.replace(/^(NDA|ANDA|BLA)(\d+)$/, '$1 $2');

function pkLength(row) {
  return Math.max(flat(row.pharmacokinetics).length, /pharmacokinetic|absorption|half-life|half life/i.test(flat(row.clinical_pharmacology)) ? flat(row.clinical_pharmacology).length : 0);
}

const normB = x => String(x).toLowerCase().replace(/[^a-z0-9]/g, '');
// 2 = label brand equals the wanted brand, 1 = one extends the other ("Humalog" / "Humalog Mix50/50"), 0 = no match
export function brandScore(row, brand) {
  if (!brand) return 0;
  const w = normB(brand);
  let best = 0;
  for (const b of row.openfda?.brand_name || []) {
    const n = normB(b);
    if (n === w) return 2;
    if (w.length >= 5 && n.length >= 5 && (n.startsWith(w) || w.startsWith(n))) best = 1;
  }
  return best;
}

const cleanBrand = b => (b || '').replace(/\([^)]*\)/g, '').split(/[\/,;]/)[0].trim();

// ---------------------------------------------------------------- label selection

// Walks the filters in the order of the rules and returns { row } or { reject }.
export function pickLabel(rows, cand, brand) {
  if (!rows.length) return { reject: 'not found' };
  let pool = rows.filter(r => (r.openfda?.product_type || []).some(t => /HUMAN PRESCRIPTION/i.test(t)));
  if (!pool.length) return { reject: 'not prescription', detail: 'labels found are not human prescription drugs' };
  pool = pool.filter(r => appNumbers(r).length);
  if (!pool.length) return { reject: 'ANDA only' };
  pool = pool.filter(r => matchesCandidate(r, cand));
  if (!pool.length) return { reject: 'substance mismatch', detail: `labels found are for ${[...new Set(rows.flatMap(substances))].slice(0, 4).join(', ')}` };
  pool = pool.filter(r => distinctMoieties(substances(r)).length <= 1);
  if (!pool.length) return { reject: 'combination', detail: [...new Set(rows.flatMap(r => [].concat(r.openfda?.generic_name || [])))].slice(0, 3).join(' | ') };
  pool = pool.filter(r => pkLength(r) > 300);
  if (!pool.length) return { reject: 'no pharmacokinetics text' };
  const hit = r => brandScore(r, brand);
  const score = r => [hit(r), r.openfda?.is_original_packager ? 1 : 0, flat(r.pharmacokinetics).length > 300 ? 1 : 0];
  pool.sort((a, b) => {
    const sa = score(a), sb = score(b);
    for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return sb[i] - sa[i];
    return String(b.effective_time).localeCompare(String(a.effective_time));
  });
  return { row: pool[0], brandMatched: hit(pool[0]) > 0, considered: pool.length };
}

async function searchLabels(cand, brand, originalOnly, brandOnly) {
  const terms = [];
  if (brand) terms.push(`openfda.brand_name:${quote(brand)}`);
  if (!brandOnly) {
    const g = cand.generic.replace(/\([^)]*\)/g, '').trim();
    terms.push(`openfda.generic_name:${quote(g)}`, `openfda.substance_name:${quote(g)}`);
  }
  const search = `(${terms.join('+OR+')})+AND+${originalOnly ? 'openfda.is_original_packager:true+AND+' : ''}${APP_FILTER}`;
  const body = await getJSON(`${API}/label.json?search=${search}&limit=${originalOnly ? 40 : 25}`, { slim: slimLabels });
  return { rows: body?.results || [], total: body?.meta?.total ?? 0 };
}

// ---------------------------------------------------------------- Drugs@FDA

const dateOf = d => (d && /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : null);

function earliestApproval(app) {
  const subs = (app?.submissions || []).filter(s => s.submission_status_date && (!s.submission_status || s.submission_status === 'AP'));
  const orig = subs.filter(s => s.submission_type === 'ORIG').map(s => s.submission_status_date).sort();
  if (orig.length) return { date: dateOf(orig[0]), note: null };
  const any = subs.map(s => s.submission_status_date).sort();
  return any.length ? { date: dateOf(any[0]), note: 'no ORIG submission on record (approved before electronic records); date is the earliest submission on file and is not the approval date' } : { date: null, note: 'no submissions on record' };
}

async function fdaApplications(moietyName, apps) {
  const out = new Map();
  const body = await getJSON(`${API}/drugsfda.json?search=products.active_ingredients.name:${quote(moietyName.split(' ')[0])}+AND+(application_number:NDA*+OR+application_number:BLA*)&limit=60`, { slim: slimFda });
  for (const r of body?.results || []) out.set(r.application_number, r);
  for (const a of apps) {
    if (out.has(a)) continue;
    const one = await getJSON(`${API}/drugsfda.json?search=application_number:${quote(a)}&limit=1`, { slim: slimFda });
    if (one?.results?.[0]) out.set(a, one.results[0]);
  }
  return out;
}

// ---------------------------------------------------------------- labels without an openfda block

// Many current labels (Zofran, Tarceva, Onglyza ...) carry no `openfda` harmonisation in the openFDA index, so no
// brand, application or manufacturer field can be searched. Fall back to Drugs@FDA (brand -> application, sponsor)
// and to a text search of the indications section for the brand name, newest label first.
async function unharmonizedByBrand(cand, brand) {
  if (!brand) return null;
  const fda = await getJSON(`${API}/drugsfda.json?search=products.brand_name:${quote(brand)}+AND+(application_number:NDA*+OR+application_number:BLA*)&limit=10`, { slim: slimFda });
  const want = moiety(cand.generic);
  const apps = (fda?.results || []).filter(r => (r.products || []).some(p => normB(p.brand_name || '') === normB(brand)
    && (p.active_ingredients || []).length === 1 && sameMoietyLoose(moiety(p.active_ingredients[0].name), want)));
  if (!apps.length) return null;
  apps.sort((a, b) => (b.products.some(p => /prescription/i.test(p.marketing_status)) - a.products.some(p => /prescription/i.test(p.marketing_status))) || b.products.length - a.products.length || (earliestApproval(a).date || '9').localeCompare(earliestApproval(b).date || '9'));
  const app = apps[0];
  const body = await getJSON(`${API}/label.json?search=indications_and_usage:${quote(brand)}+AND+_missing_:openfda.application_number&sort=effective_time:desc&limit=8`, { slim: slimLabels });
  const flex = new RegExp(brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[\s-]+/g, '[\\s-]*'), 'i');
  const row = (body?.results || []).find(r => flex.test(flat(r.indications_and_usage).slice(0, 300)) && pkLength(r) > 300);
  if (!row) return null;
  const p0 = app.products.find(p => normB(p.brand_name || '') === normB(brand)) || app.products[0];
  return {
    row,
    apps: [app.application_number],
    fda: new Map([[app.application_number, app]]),
    of: { brand_name: [p0.brand_name], substance_name: [p0.active_ingredients[0].name], route: [...new Set(app.products.map(p => p.route).filter(Boolean))].map(r => r.toLowerCase()), manufacturer_name: [app.sponsor_name] },
    brandMatched: true,
    unharmonized: true,
  };
}

const ROUTE_SYNONYMS = r => ({ inhaled: ['inhal', 'respiratory'], topical: ['topical', 'cutaneous'], oral: ['oral'], intravenous: ['intravenous'], subcutaneous: ['subcutaneous'], intramuscular: ['intramuscular'], nasal: ['nasal'], ophthalmic: ['ophthalmic'], transdermal: ['transdermal'], sublingual: ['sublingual'], rectal: ['rectal'] })[r] || [r.split(/[ ,/]/)[0]];
const sameMoietyLoose = (a, b) => !b || !a || sameMoiety(a, b) || a.includes(b) || b.includes(a);

// ---------------------------------------------------------------- main entry

export async function resolveCandidate(cand) {
  const brand = cleanBrand(cand.brand);
  let chosen = null;      // { row, brandMatched, ... }
  let picked = { reject: 'not found' };
  let total = 0, examined = 0;

  // 1. the brand alone: cheap and precise
  if (brand) {
    const r = await searchLabels(cand, brand, true, true);
    const p = pickLabel(r.rows, cand, brand);
    if (p.row && p.brandMatched) chosen = { ...p, rowsExamined: r.rows.length, total: r.total };
    else picked = p;
  }
  // 2. brand or generic, original packagers first, then anyone
  if (!chosen) {
    let r = await searchLabels(cand, brand, true, false);
    let p = pickLabel(r.rows, cand, brand);
    if (p.reject && p.reject !== 'combination') {
      const again = await searchLabels(cand, brand, false, false);
      if (again.rows.length) {
        const p2 = pickLabel(again.rows, cand, brand);
        if (p2.row) { p = p2; r = again; } else if (!r.rows.length) p = p2;
      }
    }
    picked = p; total = r.total; examined = r.rows.length;
    if (p.row && (!brand || p.brandMatched)) chosen = { ...p };
  }
  // 3. the brand's label may lack the openfda block
  if (!chosen && brand) {
    const u = await unharmonizedByBrand(cand, brand);
    if (u) chosen = u;
  }
  // 4. a label of the same drug under another name beats no label
  if (!chosen && picked.row) chosen = { ...picked };

  const notes = [];
  if (!chosen) {
    let reason = picked.reject || 'not found';
    if (reason === 'not found') {
      const g = cand.generic.replace(/\([^)]*\)/g, '').trim();
      const anda = await getJSON(`${API}/label.json?search=openfda.generic_name:${quote(g)}+AND+openfda.application_number:ANDA*&limit=1`, { slim: slimLabels });
      if (anda?.results?.length) reason = 'ANDA only';
    }
    return { status: 'reject', reject: reason, rejectDetail: picked.detail || null };
  }

  const row = chosen.row;
  const of = chosen.of || row.openfda || {};
  const apps = chosen.apps || appNumbers(row);
  const mo = distinctMoieties(chosen.unharmonized ? of.substance_name : substances(row))[0] || moiety(cand.generic);
  const fda = chosen.fda || await fdaApplications(mo, apps);

  // The label's own application: prefer one whose Drugs@FDA products carry the candidate's brand, else the first.
  const app = apps.find(a => fda.get(a)?.products?.some(p => normB(p.brand_name || '') === normB(brand))) || apps[0];
  const appRec = fda.get(app);
  const products = [];
  const seen = new Set();
  for (const p of appRec?.products || []) {
    const strengths = (p.active_ingredients || []).map(a => a.strength).filter(Boolean).join(' + ');
    const key = [p.dosage_form, p.route, strengths].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    products.push({ brand: p.brand_name, form: p.dosage_form, route: p.route, strength: strengths, marketing: p.marketing_status });
  }
  // Drugs@FDA status can lag (Prozac is listed as discontinued while Lilly's label is current), so a recent label outranks it.
  const effYear = Number(String(row.effective_time || '0000').slice(0, 4));
  if (products.length && products.every(p => /discontinued/i.test(p.marketing || ''))) {
    if (effYear < new Date().getFullYear() - 3) return { status: 'reject', reject: 'discontinued', rejectDetail: `${formatApp(app)}: every product is marked discontinued in Drugs@FDA and the label dates from ${effYear}` };
    notes.push('Drugs@FDA marks every product discontinued, but the label is recent');
  }
  if (!appRec) notes.push('application not found in Drugs@FDA; no approval date or product list');
  if (chosen.unharmonized) {
    notes.push('label has no openfda block: found by brand name in the indications text; application, routes and manufacturer come from Drugs@FDA');
  }
  const ownApproval = earliestApproval(appRec);
  // Earliest approval of any NDA/BLA for the same active moiety (a 505(b)(2) label can be younger than the first product).
  let first = null;
  for (const [number, r] of fda) {
    if (!(r.products || []).some(p => (p.active_ingredients || []).some(a => sameMoiety(moiety(a.name), mo)) && (p.active_ingredients || []).length === 1)) continue;
    const ap = earliestApproval(r);
    if (ap.date && !ap.note && (!first || ap.date < first.date)) first = { date: ap.date, application: formatApp(number) };
  }
  const effDate = dateOf(String(row.effective_time || ''));
  if (brand && !chosen.brandMatched) notes.push(`brand "${brand}" not matched; label brand is ${(of.brand_name || []).join(', ') || 'none'}`);
  const routes = (of.route || []).map(r => r.toLowerCase());
  const wantRoute = String(cand.route || '').toLowerCase();
  if (wantRoute && routes.length && !routes.some(r => ROUTE_SYNONYMS(wantRoute).some(w => r.includes(w)))) notes.push(`route mismatch: candidate list says ${cand.route}, label says ${routes.join(', ')}`);
  if (effDate && Number(effDate.slice(0, 4)) < new Date().getFullYear() - 8) notes.push(`old label (effective ${effDate})`);
  if (total > examined && examined) notes.push(`openFDA reported ${total} matching labels, ${examined} examined`);
  if (flat(row.pharmacokinetics).length <= 300) notes.push('no separate pharmacokinetics field; PK is inside clinical_pharmacology');
  const sectionLengths = {};
  for (const k of KEY_SECTIONS) sectionLengths[k] = cleanLabelText(row[k]).length;

  return {
    status: 'ok',
    labelBrand: (of.brand_name || [])[0] || null,
    substance: (of.substance_name || [])[0] || null,
    application: formatApp(app),
    applications: apps.map(formatApp),
    setId: row.set_id,
    dailymed: `https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=${row.set_id}`,
    routes,
    manufacturer: (of.manufacturer_name || [])[0] || null,
    effective: effDate,
    sectionLengths,
    approved: ownApproval.date,
    approvedYear: ownApproval.date ? Number(ownApproval.date.slice(0, 4)) : null,
    approvedNote: ownApproval.note,
    firstApprovalSameMoiety: first,
    sponsorFda: appRec?.sponsor_name || null,
    products,
    brandMatched: brand ? !!chosen.brandMatched : null,
    harmonized: !chosen.unharmonized,
    notes,
    _row: row,
  };
}

// Full (slimmed) label by DailyMed set id; used when tools/.cache/labels/<id>.json is missing.
export async function fetchLabelBySetId(setId) {
  const body = await getJSON(`${API}/label.json?search=set_id:${quote(setId)}&limit=1`, { slim: slimLabels });
  return body?.results?.[0] || null;
}
