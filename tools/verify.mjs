#!/usr/bin/env node
// Usage: node tools/verify.mjs [ids-or-files...] [--all] [--dir data/dossiers] [--digests tools/.cache/digests] [--strict]
//                              [--report tools/.cache/verify-report.json]
// Mechanical verification of dossiers written by agents. Beyond every schema, vocab and leak check build.mjs makes
// (tools/lib/validate.mjs), it uses the dossier's optional `evidence` object, which maps field paths to verbatim quotes
// from that drug's digest, for example { "pk.tmaxH": "median Tmax of 60 minutes", "clues.safety": "..." }.
// Evidence paths: clues.kinetics ... clues.mechanism, pk.tmaxH, pk.halfLifeH, pk.cmax, pill, biologic (and other fields):
//   - every quote must occur in the digest (whitespace, Unicode dashes and quotes, and case are normalised;
//     "[...]", "..." or an ellipsis inside a quote splits it into fragments that must each occur)
//   - every number in a clue must appear in the clue's quote or somewhere in the digest (warning)
//   - pk.tmaxH / pk.halfLifeH / pk.cmax must agree with their quote where a number can be parsed (hours, minutes, days;
//     mass or molar concentrations; table rows such as "C max (ng/mL) | 440" read the unit from the row)
// --strict makes a class or sponsor missing from data/vocab.json an error instead of a warning.
// Exit status 1 when any dossier fails.
import { readFile, readdir, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, validateDossier, validateVocab, isStr, KNOWN_TOP, FIELDS } from './lib/validate.mjs';
import { normalize } from './lib/text.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const valueIdx = new Set(['--dir', '--digests', '--report'].flatMap(n => (args.includes(n) ? [args.indexOf(n) + 1] : [])));
const targets = args.filter((a, i) => !a.startsWith('--') && !valueIdx.has(i));
const DIR = path.resolve(opt('--dir', path.join(ROOT, 'data', 'dossiers')));
const DIGESTS = path.resolve(opt('--digests', path.join(ROOT, 'tools', '.cache', 'digests')));
const STRUCT = path.join(ROOT, 'tools', '.cache', 'structures');
const REPORT = path.resolve(opt('--report', path.join(ROOT, 'tools', '.cache', 'verify-report.json')));
const strict = args.includes('--strict');
if (!targets.length && !args.includes('--all')) { console.error('usage: verify.mjs [ids-or-files...] [--all] [--dir dir] [--strict]'); process.exit(2); }

// ------------------------------------------------------------------ number and quantity parsing

const canon = s => { const n = Number(String(s).replace(/,/g, '')); return Number.isFinite(n) ? String(n) : null; };

// Numbers as written in text; digits glued to letters ("CYP3A4", "H2O") are part of a name, not a figure.
function numbersIn(text) {
  const t = normalize(text);
  const out = [];
  for (const m of t.matchAll(/(?<![a-z0-9_.,])(\d{1,3}(?:,\d{3})+(?![0-9])|\d+(?:\.\d+)?)(?![0-9]|\.\d)/g)) {
    const c = canon(m[1]);
    if (c !== null) out.push({ raw: m[1], canon: c });
  }
  return out;
}

// "7 ± 1", "4.7 (1.6)", "4.7 [range 2-9]", "1.0 (0.5-3.0)" mean the first number; drop the spread. Spelled-out numbers become digits.
const WORDS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, sixteen: 16, twenty: 20, 'twenty-four': 24, thirty: 30, 'thirty-six': 36, forty: 40, 'forty-eight': 48, sixty: 60, 'seventy-two': 72 };
const WORD_RE = new RegExp(`\\b(${Object.keys(WORDS).sort((a, b) => b.length - a.length).join('|')})(?=[ -](?:hours?|hrs?|minutes?|mins?|days?|weeks?)\\b)`, 'g');
function cleanQuote(q) {
  return normalize(q)
    .replace(/\s*(?:±|\+\/-|\+-)\s*\d+(?:\.\d+)?%?/g, '')
    .replace(/(\d)\s*[(\[]\s*(?:(?:range|cv|sd|se|ci|95% ci|min-max)\s*[:=]?\s*)?[\d.,\s\-%]+(?:\s*to\s*[\d.,\s%]+)?[)\]]/g, '$1')
    .replace(WORD_RE, w => String(WORDS[w]));
}

const TIME = /(\d+(?:\.\d+)?)(?:\s*(?:-|to|and)\s*(\d+(?:\.\d+)?))?\s*-?\s*(hours?|hrs?|h|minutes?|mins?|days?|weeks?)(?![a-z])/g;
const toHours = (v, unit) => (/^h/.test(unit) ? v : /^m/.test(unit) ? v / 60 : /^d/.test(unit) ? v * 24 : v * 168);

function timesIn(quote) {
  const out = [];
  for (const m of cleanQuote(quote).matchAll(TIME)) {
    const a = toHours(Number(m[1]), m[3]);
    out.push({ h: a, text: m[0] });
    if (m[2] !== undefined) {
      const b = toHours(Number(m[2]), m[3]);
      out.push({ h: b, text: m[0] }, { h: (a + b) / 2, text: `${m[0]} (midpoint)` });
    }
  }
  return out;
}

const MASS_NG = { pg: 1e-3, ng: 1, µg: 1e3, μg: 1e3, ug: 1e3, mcg: 1e3, mg: 1e6, g: 1e9 };
const MOLE_NMOL = { micromol: 1e3, nanomol: 1, pmol: 1e-3, nmol: 1, µmol: 1e3, μmol: 1e3, umol: 1e3, mmol: 1e6, nm: 1, µm: 1e3, μm: 1e3, um: 1e3 };
const PER_ML = { ml: 1, l: 1000, dl: 100 };
const TARGET_NG_ML = { 'pg/mL': 1e-3, 'ng/mL': 1, 'µg/mL': 1e3, 'mg/L': 1e3, 'ng/L': 1e-3 };
const CONC = /(\d+(?:\.\d+)?)(?:\s*(?:-|to|and)\s*(\d+(?:\.\d+)?))?\s*(pg|ng|µg|μg|ug|mcg|mg|g|pmol|nmol|micromol|nanomol|µmol|μmol|umol|mmol|nm|µm|μm|um)\s*(?:\/|per)\s*(ml|dl|l)(?![a-z])/g;

// Concentrations in the quote as { ngPerMl (or null when a molecular weight is needed), molar: nmol/mL }
function concentrationsIn(quote) {
  const out = [];
  for (const m of cleanQuote(quote).matchAll(CONC)) {
    const unit = m[3];
    const den = PER_ML[m[4]];
    const vals = [Number(m[1])];
    if (m[2] !== undefined) vals.push(Number(m[2]), (Number(m[1]) + Number(m[2])) / 2);
    for (const v of vals) {
      if (MASS_NG[unit] !== undefined) out.push({ text: m[0], ngMl: (v * MASS_NG[unit]) / den });
      else out.push({ text: m[0], nmolMl: (v * MOLE_NMOL[unit]) / den });
    }
  }
  for (const m of cleanQuote(quote).matchAll(MOLAR)) {
    const vals = [Number(m[1])];
    if (m[2] !== undefined) vals.push(Number(m[2]), (Number(m[1]) + Number(m[2])) / 2);
    for (const v of vals) out.push({ text: m[0], nmolMl: (v * M_NMOL_L[m[3]]) / 1000 });
  }
  return out;
}

const MOLAR = /(\d+(?:\.\d+)?)(?:\s*(?:-|to|and)\s*(\d+(?:\.\d+)?))?\s*(nm|µm|μm|um|mm)(?![a-z\/])/g; // nM, µM: mol per litre
const M_NMOL_L = { nm: 1, µm: 1e3, μm: 1e3, um: 1e3, mm: 1e6 };

const close = (a, b, rel = 0.06) => Math.abs(a - b) <= Math.max(1e-6, rel * Math.max(Math.abs(a), Math.abs(b)));

// ------------------------------------------------------------------ per dossier

function parseMwFromDigest(digest) {
  const m = /molecular (?:weight|mass)(?:\s+(?:of|is))?\s+(?:approximately\s+)?(\d+(?:\.\d+)?)/i.exec(digest);
  return m ? Number(m[1]) : null;
}

const sentenceCountOf = t => t.trim().split(/(?<=[.!?])\s+(?=[A-Z0-9(])/).filter(Boolean).length;
function evidenceList(v) { return Array.isArray(v) ? v : [v]; }

function checkQuote(quote, digestNorm) {
  const frags = String(quote).split(/\s*(?:\[\.\.\.\]|\.\.\.|…)\s*/).map(normalize).filter(Boolean);
  if (!frags.length) return 'quote is empty';
  const missing = frags.find(f => !digestNorm.includes(f));
  if (missing !== undefined) return `quote not found in the digest: "${String(quote).length > 90 ? String(quote).slice(0, 90) + '…' : quote}"`;
  const tiny = frags.find(f => f.length < 8);
  if (tiny !== undefined && frags.every(f => f.length < 8)) return `quote is too short to be evidence: "${quote}"`;
  return null;
}

async function verifyOne(label, file, vocab) {
  const res = { id: label, status: 'pass', errors: [], warnings: [], checked: { quotes: 0, numbers: 0, pkQuotes: 0 } };
  let d;
  try { d = JSON.parse(await readFile(file, 'utf8')); } catch (e) { res.errors.push(`cannot read ${file}: ${e.message}`); res.status = 'fail'; return res; }
  const id = d?.id || label;
  res.id = id;
  const ctx = createContext();
  validateDossier(ctx, path.basename(file), d, vocab, { strict });
  res.errors.push(...ctx.errors);
  res.warnings.push(...ctx.warnings);
  if (!d || typeof d !== 'object') { res.status = 'fail'; return res; }

  let digest;
  try { digest = await readFile(path.join(DIGESTS, `${id}.txt`), 'utf8'); } catch {
    res.errors.push(`no digest for ${id} (run npm run digest -- ${id}); quotes and numbers cannot be checked`);
    res.status = 'fail';
    return res;
  }
  const digestNorm = normalize(digest);
  const digestNums = new Set(numbersIn(digest).map(n => n.canon));
  const evidence = d.evidence && typeof d.evidence === 'object' && !Array.isArray(d.evidence) ? d.evidence : {};
  if (!Object.keys(evidence).length) res.warnings.push('no evidence object: nothing to check quotes against');

  const clueQuote = new Map();
  const validPath = k => /^clues\./.test(k) ? FIELDS.slots.includes(k.slice(6))
    : k.startsWith('pk.') ? Object.keys(FIELDS.pk).concat(['context', 'model', 'unit']).includes(k.slice(3))
    : ['pill', 'biologic', 'structure', 'tell'].includes(k) || k.startsWith('pill.') || k.startsWith('biologic.') || (KNOWN_TOP.has(k) && !FIELDS.reviewOnly.includes(k));

  for (const [pathKey, value] of Object.entries(evidence)) {
    const quotes = evidenceList(value).filter(isStr);
    if (!validPath(pathKey)) res.errors.push(`evidence["${pathKey}"]: unknown field path (use clues.<slot>, pk.<field>, pill, biologic ...)`);
    else if (pathKey.startsWith('clues.')) clueQuote.set(pathKey.slice(6), quotes);
    for (const q of quotes) {
      res.checked.quotes++;
      const bad = checkQuote(q, digestNorm);
      if (bad) res.errors.push(`evidence["${pathKey}"]: ${bad}`);
    }
  }

  // pk values against their quotes
  const pk = d.pk || {};
  let mw = null;
  try { mw = JSON.parse(await readFile(path.join(STRUCT, `${id}.json`), 'utf8')).molecularWeight; } catch {}
  const mws = [mw, parseMwFromDigest(digest)].filter(Boolean);
  for (const k of ['tmaxH', 'halfLifeH', 'cmax']) {
    if (typeof pk[k] !== 'number') continue;
    const quotes = evidenceList(evidence[`pk.${k}`]).filter(isStr);
    if (!quotes.length) { res.warnings.push(`pk.${k} has no evidence quote`); continue; }
    res.checked.pkQuotes++;
    const joined = cleanQuote(quotes.join(' '));
    if (k === 'cmax') {
      const found = concentrationsIn(joined);
      if (!found.length) {
        // table row: "C max (ng/mL) | 440 | 12": the unit sits in the label cell, the numbers follow
        const u = /(pg|ng|µg|μg|ug|mcg|mg|pmol|nmol|micromol|nanomol|µmol|μmol|umol|mmol)\s*\/\s*(ml|l)(?![a-z])/.exec(normalize(joined));
        if (u) for (const n of numbersIn(joined.replace(/\([^)]*\)/g, ' '))) {
          const v = Number(n.canon), den = PER_ML[u[2]];
          found.push(MASS_NG[u[1]] !== undefined ? { text: `${n.raw} ${u[0]}`, ngMl: (v * MASS_NG[u[1]]) / den } : { text: `${n.raw} ${u[0]}`, nmolMl: (v * MOLE_NMOL[u[1]]) / den });
        }
      }
      if (!found.length) { res.warnings.push(`pk.cmax: no concentration could be parsed from its quote, so it was not cross-checked`); continue; }
      const target = pk.cmax * (TARGET_NG_ML[pk.unit] ?? NaN);
      const ok = found.some(f => (f.ngMl !== undefined ? close(f.ngMl, target) : mws.some(w => close(f.nmolMl * w, target, 0.1))));
      if (!ok) {
        const molarOnly = found.every(f => f.nmolMl !== undefined);
        const msg = `pk.cmax ${pk.cmax} ${pk.unit} does not match its quote (${found.map(f => f.text).filter((x, i, a) => a.indexOf(x) === i).join('; ')})`;
        if (molarOnly && !mws.length) res.warnings.push(`${msg}; molar values and no molecular weight to convert with`);
        else res.errors.push(molarOnly ? `${msg}; checked against molecular weight ${mws.join(' or ')}` : msg);
      }
    } else {
      const found = timesIn(joined);
      if (!found.length) {
        // table row: "T max (h) | 1.0 | 0.5-3.0": the unit sits in the label cell
        const hint = /\(\s*(h|hr|hrs|hours?|min|mins|minutes?|days?)\s*\)|\b(hours?|minutes?|days?)\b/i.exec(joined);
        if (hint) { const unit = (hint[1] || hint[2]).toLowerCase(); for (const n of numbersIn(joined.replace(/\([^)]*\)/g, ' '))) found.push({ h: toHours(Number(n.canon), unit), text: `${n.raw} ${unit}` }); }
      }
      if (!found.length) { res.warnings.push(`pk.${k}: no time could be parsed from its quote, so it was not cross-checked`); continue; }
      const ok = found.some(f => close(f.h, pk[k], 0.06)) || (k === 'tmaxH' && pk[k] === 0 && found.some(f => f.h === 0));
      if (!ok) res.errors.push(`pk.${k} is ${pk[k]} h but its quote says ${found.map(f => `${f.text} (= ${Number(f.h.toFixed(3))} h)`).filter((x, i, a) => a.indexOf(x) === i).join('; ')}`);
    }
  }

  // clue figures
  for (const slot of FIELDS.slots) {
    const text = d.clues && d.clues[slot];
    if (!isStr(text)) continue;
    const w = `clue ${slot}`;
    const quotes = clueQuote.get(slot);
    if (slot === 'safety') {
      const saysNone = /\b(?:no|without a?|carries no|has no)\s+(?:boxed|black[- ]box)\s+warning/i.test(text);
      if (saysNone && /^## Boxed warning/m.test(digest)) res.errors.push('clue safety says there is no boxed warning, but the digest has a ## Boxed warning section');
      if (!saysNone && /^## Boxed warning/m.test(digest) && !/boxed|black[- ]box|\bWARNING\b/i.test(text)) res.warnings.push('the label has a boxed warning (see the digest) but the safety clue does not mention it');
    }
    if (!quotes && !(slot === 'safety' && /\b(?:no|without a?|carries no|has no)\s+(?:boxed|black[- ]box)\s+warning/i.test(text) && sentenceCountOf(text) <= 1)) res.warnings.push(`${w} has no evidence quote`);
    const quoteNums = new Set(numbersIn((quotes || []).join(' ')).map(n => n.canon));
    for (const n of numbersIn(text)) {
      res.checked.numbers++;
      if (!quoteNums.has(n.canon) && !digestNums.has(n.canon)) res.warnings.push(`${w}: the number ${n.raw} appears in neither its quote nor the digest`);
    }
  }
  if (d.pill && !evidence.pill) res.warnings.push('pill has no evidence quote');
  if (d.biologic && !evidence.biologic) res.warnings.push('biologic has no evidence quote');

  res.status = res.errors.length ? 'fail' : 'pass';
  return res;
}

// ------------------------------------------------------------------ main

let vocab;
try { vocab = JSON.parse(await readFile(path.join(ROOT, 'data', 'vocab.json'), 'utf8')); } catch (e) { console.error(`cannot read data/vocab.json: ${e.message}`); process.exit(2); }
const vctx = createContext();
validateVocab(vctx, vocab);
if (vctx.errors.length) { console.error(vctx.errors.join('\n')); process.exit(2); }

// <id>.skip.json ({ "reason": "..." }) in the dossier dir or tools/.cache/drafts marks an id as deliberately skipped.
const SKIP_DIRS = [...new Set([DIR, path.join(ROOT, 'tools', '.cache', 'drafts')])];
async function findSkip(id) {
  for (const dir of SKIP_DIRS) {
    try {
      const raw = await readFile(path.join(dir, `${id}.skip.json`), 'utf8');
      let reason = raw.trim();
      try { const j = JSON.parse(raw); reason = typeof j === 'string' ? j : j.reason || JSON.stringify(j); } catch {}
      return { dir, reason };
    } catch {}
  }
  return null;
}

let files = [];
const skipIds = new Set();
if (args.includes('--all')) {
  for (const dir of SKIP_DIRS) { try { for (const f of await readdir(dir)) if (f.endsWith('.skip.json')) skipIds.add(f.slice(0, -10)); } catch {} }
  files = (await readdir(DIR)).filter(f => f.endsWith('.json') && !f.endsWith('.skip.json')).sort().map(f => [f.replace(/\.json$/, ''), path.join(DIR, f)]);
}
for (const t of targets) files.push(t.endsWith('.json') ? [path.basename(t, '.json'), path.resolve(t)] : [t, path.join(DIR, `${t}.json`)]);
for (const [label] of files) skipIds.add(label);

const skipped = new Map();
for (const id of skipIds) { const k = await findSkip(id); if (k) skipped.set(id, k); }
for (const [id, k] of skipped) { try { await rm(path.join(k.dir, `${id}.json`)); } catch {} } // the skip wins over any staged file

const results = [];
for (const [label, file] of files) if (!skipped.has(label)) results.push(await verifyOne(label, file, vocab));

let fails = 0;
for (const [id, k] of skipped) console.log(`SKIP  ${id}: ${k.reason}`);
for (const r of results) {
  if (r.status === 'fail') fails++;
  console.log(`${r.status === 'pass' ? 'PASS' : 'FAIL'}  ${r.id}${r.warnings.length ? `  (${r.warnings.length} warning${r.warnings.length === 1 ? '' : 's'})` : ''}`);
  for (const e of r.errors) console.log(`    error    ${e}`);
  for (const w of r.warnings) console.log(`    warning  ${w}`);
}
console.log(`\n${results.length - fails} of ${results.length} pass${skipped.size ? `, ${skipped.size} skipped` : ''}`);
// Only a full run writes the report; parallel agents verifying single ids must not clobber it.
if (args.includes('--all')) {
  await mkdir(path.dirname(REPORT), { recursive: true });
  await writeFile(REPORT, JSON.stringify({ summary: { total: results.length, pass: results.length - fails, fail: fails, skipped: skipped.size, strict }, results, skipped: [...skipped].map(([id, k]) => ({ id, reason: k.reason })) }, null, 2) + '\n');
  console.log(`report: ${path.relative(process.cwd(), REPORT)}`);
}
process.exit(fails ? 1 : 0);
