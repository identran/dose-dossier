// Number and unit formatting for the readouts, and the small typesetting of clue text.

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

export function number(value) {
  if (!Number.isFinite(value)) return '';
  return value.toLocaleString('en-US', { maximumSignificantDigits: 3 });
}

export function halfLife(hours) {
  if (!Number.isFinite(hours)) return '';
  if (hours < 1) return `${Math.round(hours * 60)} min`;
  if (hours < 96) return `${+hours.toPrecision(3)} h`;
  return `${+(hours / 24).toPrecision(3)} d`;
}

// 'ng/mL' -> 'ng·h/mL'
export function aucUnit(unit) {
  if (!unit) return '';
  const cut = unit.indexOf('/');
  return cut < 0 ? `${unit}·h` : `${unit.slice(0, cut)}·h${unit.slice(cut)}`;
}
