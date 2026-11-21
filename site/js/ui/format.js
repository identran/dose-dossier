// Number formatting, the profile put into words, and the small typesetting of clue text.

import { formatHours } from '../pk.js';
import { h } from './dom.js';

export const THIN = ' ';
const NBSP = ' ';

// Genera that may appear spelled out; an abbreviated binomial ("H. pylori") needs no list.
const GENERA = 'Helicobacter|Clostridioides|Clostridium|Escherichia|Staphylococcus|Streptococcus|Enterococcus|'
  + 'Pseudomonas|Klebsiella|Haemophilus|Mycobacterium|Pneumocystis|Plasmodium|Candida|Aspergillus';

// 1 lead, 2 initial, 3 epithet | 4 lead, 5 genus, 6 epithet | 7 lead, 8 C or T, 9 max or min | 10 arrow.
// An abbreviated binomial is a lone capital, a full stop and a lower-case word of four letters or
// more; the lead keeps "U.S. patent" and the middle of a word out.
const MARKS = new RegExp(
  '(^|[\\s(\\[])([A-Z])\\. ([a-z]{4,})(?![a-z])'
  + `|(^|[\\s(\\[])(${GENERA}) ([a-z]{4,})(?![a-z])`
  + '|(^|[^A-Za-z])([CT])(max|min)(?![A-Za-z])'
  + '| ?(→) ?', 'g');

// Plain clue text to nodes: species names in italics with a no-break space after the initial,
// Tmax and Cmax with a true subscript, a thin space either side of an arrow. Everything else,
// markup characters included, stays text.
export function typeset(text) {
  const source = String(text ?? '');
  const out = [];
  let at = 0;
  for (const m of source.matchAll(MARKS)) {
    const lead = m[1] ?? m[4] ?? m[7] ?? '';
    out.push(source.slice(at, m.index) + lead);
    if (m[2]) out.push(h('i', null, `${m[2]}.${NBSP}${m[3]}`));
    else if (m[5]) out.push(h('i', null, `${m[5]} ${m[6]}`));
    else if (m[8]) out.push(m[8], h('sub', null, m[9]));
    else out.push(`${THIN}${m[10]}${THIN}`);
    at = m.index + m[0].length;
  }
  out.push(source.slice(at));
  return out.filter(part => part !== '');
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

// "Peak 440 ng/mL at 1 h · half-life 4 h · one turn is 24 h"
export function profileLine(curve) {
  const peak = curve.relative ? 'Peak' : `Peak ${number(curve.cmax)} ${curve.unit}`;
  const at = curve.model === 'bolus' ? 0 : curve.tmax;
  return `${peak} at ${formatHours(at)} · half-life ${formatHours(curve.halfLife)} · one turn is ${formatHours(curve.period)}`;
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
