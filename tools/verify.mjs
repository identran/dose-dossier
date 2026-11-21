#!/usr/bin/env node
// Usage: node tools/verify.mjs [ids-or-files...] [--all] [--dir data/dossiers] [--digests tools/.cache/digests] [--strict]
//                              [--report tools/.cache/verify-report.json] [--one-based]
// Mechanical verification of dossiers written by agents. Beyond every schema and vocab check build.mjs makes
// (tools/lib/validate.mjs), it uses the dossier's optional `evidence` object, which maps field paths to verbatim quotes
// from that drug's digest, for example { "pk.tmaxH": "median Tmax of 60 minutes", "clues.3": "..." }:
//   - every quote must occur in the digest (whitespace, Unicode dashes and quotes, and case are normalised;
//     "[...]", "..." or an ellipsis inside a quote splits it into fragments that must each occur)
//   - every number in a clue must appear in the clue's quote or somewhere in the digest (warning)
//   - pk.tmaxH / pk.halfLifeH / pk.cmax must agree with their quote where a number can be parsed (hours, minutes, days;
//     mass or molar concentrations)
//   - no clue contains the generic name, brand, aliases, salt, or the stem (first 5 letters) of a name word
// `clues.N` is 0-based by default (like "pk.tmaxH" it is a path into the JSON); the base is detected as 1 when the
// evidence has "clues.10" and no "clues.0", or forced with --one-based.
// Exit status 1 when any dossier fails (or has warnings with --strict).
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
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
const forceOneBased = args.includes('--one-based');
if (!targets.length && !args.includes('--all')) { console.error('usage: verify.mjs [ids-or-files...] [--all] [--dir dir] [--strict] [--one-based]'); process.exit(2); }

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

const TIME = /(\d+(?:\.\d+)?)(?:\s*(?:-|to|and)\s*(\d+(?:\.\d+)?))?\s*-?\s*(hours?|hrs?|h|minutes?|mins?|days?|weeks?)(?![a-z])/g;
const toHours = (v, unit) => (/^h/.test(unit) ? v : /^m/.test(unit) ? v / 60 : /^d/.test(unit) ? v * 24 : v * 168);

function timesIn(quote) {
  const out = [];
  for (const m of normalize(quote).matchAll(TIME)) {
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
const MOLE_NMOL = { pmol: 1e-3, nmol: 1, µmol: 1e3, μmol: 1e3, umol: 1e3, mmol: 1e6, nm: 1, µm: 1e3, μm: 1e3, um: 1e3 };
const PER_ML = { ml: 1, l: 1000, dl: 100 };
const TARGET_NG_ML = { 'pg/mL': 1e-3, 'ng/mL': 1, 'µg/mL': 1e3, 'mg/L': 1e3, 'ng/L': 1e-3 };
const CONC = /(\d+(?:\.\d+)?)(?:\s*(?:-|to|and)\s*(\d+(?:\.\d+)?))?\s*(pg|ng|µg|μg|ug|mcg|mg|g|pmol|nmol|µmol|μmol|umol|mmol|nm|µm|μm|um)\s*(?:\/|per)\s*(ml|dl|l)(?![a-z])/g;

// Concentrations in the quote as { ngPerMl (or null when a molecular weight is needed), molar: nmol/mL }
function concentrationsIn(quote) {
  const out = [];
  for (const m of normalize(quote).matchAll(CONC)) {
    const unit = m[3];
    const den = PER_ML[m[4]];
    const vals = [Number(m[1])];
    if (m[2] !== undefined) vals.push(Number(m[2]), (Number(m[1]) + Number(m[2])) / 2);
    for (const v of vals) {
      if (MASS_NG[unit] !== undefined) out.push({ text: m[0], ngMl: (v * MASS_NG[unit]) / den });
      else out.push({ text: m[0], nmolMl: (v * MOLE_NMOL[unit]) / den });
    }
  }
  return out;
}

const close = (a, b, rel = 0.06) => Math.abs(a - b) <= Math.max(1e-6, rel * Math.max(Math.abs(a), Math.abs(b)));

// ------------------------------------------------------------------ name leaks

const STEM_STOP = new Set(['acid', 'sodium', 'potassium', 'calcium', 'human', 'recombinant', 'factor', 'vitamin', 'hydrochloride', 'chloride', 'sulfate', 'phosphate', 'acetate', 'injection', 'tablets', 'capsules']);
function stems(d) {
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

// ------------------------------------------------------------------ per dossier

function parseMwFromDigest(digest) {
  const m = /molecular (?:weight|mass)(?:\s+(?:of|is))?\s+(?:approximately\s+)?(\d+(?:\.\d+)?)/i.exec(digest);
  return m ? Number(m[1]) : null;
}

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
  validateDossier(ctx, path.basename(file), d, vocab);
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

  // clue index base
  const keys = Object.keys(evidence);
  const oneBased = forceOneBased || (keys.includes('clues.10') && !keys.includes('clues.0'));
  const clueQuote = new Map();

  for (const [pathKey, value] of Object.entries(evidence)) {
    const quotes = evidenceList(value).filter(isStr);
    const m = /^clues\.(\d+)$/.exec(pathKey);
    if (m) {
      const i = Number(m[1]) - (oneBased ? 1 : 0);
      if (!(i >= 0 && i < (d.clues || []).length)) res.errors.push(`evidence["${pathKey}"] points at a clue that does not exist (${oneBased ? '1' : '0'}-based, ${(d.clues || []).length} clues)`);
      else clueQuote.set(i, quotes);
    } else if (!(pathKey.startsWith('pk.') ? Object.keys(FIELDS.pk).concat(['context', 'model', 'unit']).includes(pathKey.slice(3)) : pathKey === 'pill.desc' || (KNOWN_TOP.has(pathKey) && !FIELDS.reviewOnly.includes(pathKey)))) {
      res.warnings.push(`evidence["${pathKey}"]: unknown field path`);
    }
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
    const joined = quotes.join(' ');
    if (k === 'cmax') {
      const found = concentrationsIn(joined);
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
      if (!found.length) { res.warnings.push(`pk.${k}: no time could be parsed from its quote, so it was not cross-checked`); continue; }
      const ok = found.some(f => close(f.h, pk[k], 0.06)) || (k === 'tmaxH' && pk[k] === 0 && found.some(f => f.h === 0));
      if (!ok) res.errors.push(`pk.${k} is ${pk[k]} h but its quote says ${found.map(f => `${f.text} (= ${Number(f.h.toFixed(3))} h)`).filter((x, i, a) => a.indexOf(x) === i).join('; ')}`);
    }
  }

  // clue figures and name stems
  const stemList = stems(d);
  (d.clues || []).forEach((c, i) => {
    if (!c || typeof c !== 'object') return;
    const w = `clue ${i + 1}`;
    const quotes = clueQuote.get(i);
    if (!quotes) res.warnings.push(`${w} has no evidence quote`);
    const quoteNums = new Set(numbersIn((quotes || []).join(' ')).map(n => n.canon));
    for (const n of numbersIn(`${c.title || ''} ${c.text || ''}`)) {
      res.checked.numbers++;
      if (!quoteNums.has(n.canon) && !digestNums.has(n.canon)) res.warnings.push(`${w}: the number ${n.raw} appears in neither its quote nor the digest`);
    }
    const full = [d.generic, d.brand, ...(d.aliases || []), d.salt].filter(isStr).map(s => s.toLowerCase());
    for (const [field, text] of [['title', c.title], ['text', c.text]]) {
      if (!isStr(text)) continue;
      if (full.some(f => text.toLowerCase().includes(f))) continue; // already reported by the schema check
      for (const s of stemList) if (s.re.test(text)) res.errors.push(`${w} ${field} contains "${s.stem}", the stem of the ${s.why}: "${text}"`);
    }
  });

  res.status = res.errors.length || (strict && res.warnings.length) ? 'fail' : 'pass';
  return res;
}

// ------------------------------------------------------------------ main

let vocab;
try { vocab = JSON.parse(await readFile(path.join(ROOT, 'data', 'vocab.json'), 'utf8')); } catch (e) { console.error(`cannot read data/vocab.json: ${e.message}`); process.exit(2); }
const vctx = createContext();
validateVocab(vctx, vocab);
if (vctx.errors.length) { console.error(vctx.errors.join('\n')); process.exit(2); }

let files = [];
if (args.includes('--all')) files = (await readdir(DIR)).filter(f => f.endsWith('.json')).sort().map(f => [f.replace(/\.json$/, ''), path.join(DIR, f)]);
for (const t of targets) files.push(t.endsWith('.json') ? [path.basename(t, '.json'), path.resolve(t)] : [t, path.join(DIR, `${t}.json`)]);

const results = [];
for (const [label, file] of files) results.push(await verifyOne(label, file, vocab));

let fails = 0;
for (const r of results) {
  if (r.status === 'fail') fails++;
  console.log(`${r.status === 'pass' ? 'PASS' : 'FAIL'}  ${r.id}${r.warnings.length ? `  (${r.warnings.length} warning${r.warnings.length === 1 ? '' : 's'})` : ''}`);
  for (const e of r.errors) console.log(`    error    ${e}`);
  for (const w of r.warnings) console.log(`    warning  ${w}`);
}
console.log(`\n${results.length - fails} of ${results.length} pass`);
await mkdir(path.dirname(REPORT), { recursive: true });
await writeFile(REPORT, JSON.stringify({ summary: { total: results.length, pass: results.length - fails, fail: fails, strict }, results }, null, 2) + '\n');
console.log(`report: ${path.relative(process.cwd(), REPORT)}`);
process.exit(fails ? 1 : 0);
