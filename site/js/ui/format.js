// Number formatting, the profile put into words, and the small typesetting of clue text.

import { formatHours } from '../pk.js';
import { h } from './dom.js';

export const THIN = '\u2009';
const NBSP = '\u00a0';

// Genera set in italics, alone or with a species name; an abbreviated binomial ("H. pylori") needs no list.
const GENERA = 'Helicobacter|Clostridioides|Clostridium|Escherichia|Staphylococcus|Streptococcus|Enterococcus|'
  + 'Pseudomonas|Klebsiella|Haemophilus|Mycobacterium|Mycoplasma|Pneumocystis|Plasmodium|Candida|Aspergillus|'
  + 'Cryptococcus|Streptomyces|Trichomonas|Chlamydia|Neisseria';
const EPITHETS = 'pylori|difficile|coli|aureus|epidermidis|pyogenes|pneumoniae|agalactiae|faecium|faecalis|'
  + 'aeruginosa|influenzae|tuberculosis|avium|jirovecii|falciparum|vivax|albicans|glabrata|auris|fumigatus|'
  + 'neoformans|roseosporus|vaginalis|trachomatis|gonorrhoeae|meningitidis';

const UNITS = 'mg|mcg|µg|ng|g|kg|mL|L|kDa|nM|µM|mM';

// Plain text set as it would be in print: a true apostrophe and quotation marks, an en dash in a
// range of numbers, a superscript in "per square metre", and no line break between a number and its unit.
export function tidy(text) {
  return String(text ?? '')
    .replace(/([A-Za-z0-9])'/g, '$1’')
    .replace(/"([^"]+)"/g, '“$1”')
    .replace(/(\d)-(?=\d)/g, '$1–')
    .replace(/\/m2(?![A-Za-z0-9])/g, '/m²')
    .replace(new RegExp(`(\\d) (?=(?:${UNITS})(?![A-Za-z]))`, 'g'), `$1${NBSP}`);
}

const nb = (...children) => h('span', { class: 'nb' }, children);

// Each rule is a pattern whose first group is a lead that stays text, and what the rest becomes.
const RULES = [
  // An abbreviated binomial is a lone capital, a full stop and a lower-case word of four letters
  // or more; the lead keeps "U.S. patent" and the middle of a word out.
  [/(^|[\s(\[])([A-Z])\. ([a-z]{4,})(?![a-z])/g, m => h('i', null, `${m[2]}.${NBSP}${m[3]}`)],
  [new RegExp(`(^|[^A-Za-z])(${GENERA})(?: (${EPITHETS}))?(?![a-z])`, 'g'), m => h('i', null, m[3] ? `${m[2]} ${m[3]}` : m[2])],
  [/(^|[^A-Za-z])([CT])(max|min)(?![A-Za-z])/g, m => [m[2], h('sub', null, m[3])]],
  // Receptor subtypes and potencies carry their index as a subscript: 5-HT1A, D2, P2Y12, IC50.
  [/(^|[^A-Za-z0-9])(5-HT)(\d[A-F]?(?:\/\d[A-F])?)(?![A-Za-z0-9])/g, m => nb(m[2], h('sub', null, m[3]))],
  [/(^|[^A-Za-z0-9])(P2Y|CysLT|LTD|AT|NK|IC|EC|D|H|V|G)(\d{1,2}[ab]?)(?![A-Za-z0-9])/g, m => nb(m[2], h('sub', null, m[3]))],
  [/()([αβ])(\d)/g, m => [m[2], h('sub', null, m[3])]],
  [/() ?(→) ?/g, m => `${THIN}${m[2]}${THIN}`],
  // A short hyphenated term ("PD-L1", "10-fold", "T-cell") is not broken at its hyphen.
  [/()([A-Za-z0-9.]+(?:-[A-Za-z0-9]+)+)/g, m => (m[2].length <= 14 && m[2].split('-').some(part => part.length <= 3) ? nb(m[2]) : m[2])],
];

// Plain clue text to nodes: tidied, with species names in italics (a no-break space after an
// initial), Tmax and Cmax and receptor subtypes with a true subscript, a thin space either side
// of an arrow. Everything else, markup characters included, stays text.
export function typeset(text) {
  let parts = [tidy(text)];
  for (const [pattern, make] of RULES) {
    parts = parts.flatMap(part => {
      if (typeof part !== 'string') return [part];
      const out = [];
      let at = 0;
      for (const m of part.matchAll(pattern)) {
        out.push(part.slice(at, m.index) + m[1], make(m));
        at = m.index + m[0].length;
      }
      out.push(part.slice(at));
      return out.flat();
    });
  }
  // Neighbouring pieces of text become one again.
  const out = [];
  for (const part of parts) {
    if (part === '') continue;
    if (typeof part === 'string' && typeof out.at(-1) === 'string') out[out.length - 1] += part;
    else out.push(part);
  }
  return out;
}

// A term's explanation as its own muted line, or nothing.
export const glossLine = text => (text ? h('p', { class: 'gloss' }, typeset(text)) : null);

export function number(value) {
  if (!Number.isFinite(value)) return '';
  return value.toLocaleString('en-US', { maximumSignificantDigits: 3 });
}

export const percent = fraction => `${Math.round(fraction * 100)}%`;

// A generic name as it stands inside a sentence.
export const inSentence = name => name.charAt(0).toLowerCase() + name.slice(1);

/* The profile in words. `curve` is from pk.js; a relative curve has no label Cmax. */

// One turn of the dial, in the unit its ticks are labelled in (see tickSpec in dial/model.js).
function turnLength(period) {
  if (period <= 48) return `${period} h`;
  return period < 1344 ? `${+(period / 24).toFixed(1)} d` : `${+(period / 168).toFixed(1)} wk`;
}

// "Peak 440 ng/mL at 1 h · half-life 4 h · one turn is 24 h"
export function profileLine(curve) {
  const peak = curve.relative ? 'Peak' : `Peak ${number(curve.cmax)} ${curve.unit}`;
  const at = curve.model === 'bolus' ? 0 : curve.tmax;
  return `${peak} at ${formatHours(at)} · half-life ${formatHours(curve.halfLife)} · one turn is ${turnLength(curve.period)}`;
}

// The profile line as nodes: each of its statements keeps to one line.
export function statements(line) {
  return line.split(' · ').flatMap((part, i) => [i ? ' · ' : '', h('span', { class: 'nb' }, part)]).filter(Boolean);
}

// "2.5 h · 310 ng/mL", or "2.5 h · 62% of peak"
export function probeLine(curve, t) {
  const c = curve.c(t);
  return `${formatHours(t)} · ${curve.relative ? `${percent(c / curve.cmax)} of peak` : `${number(c)} ${curve.unit}`}`;
}

// One row per sampling time: { time, concentration, ofPeak }, concentration null on a relative curve.
export function profileRows(curve, times) {
  return times.map(t => {
    const c = curve.c(t);
    return { time: formatHours(t), concentration: curve.relative ? null : number(c), ofPeak: percent(c / curve.cmax) };
  });
}
