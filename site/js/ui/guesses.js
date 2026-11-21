// The list of guesses, newest first, each with its comparison against the answer.
// A match is set in ink, a miss in the muted tone; the half-life carries an arrow.

import { h, sr } from './dom.js';
import { halfLife, THIN } from './format.js';

const ARROW = { longer: '↑', shorter: '↓' };

function fact(f) {
  if (f.value == null) return h('li', { class: 'fact' }, sr(`${f.label}: `), '–');
  const text = f.kind === 'scalar' ? halfLife(f.value) : f.value;
  const verdict = f.match ? ', matches' : f.direction ? `, the answer’s is ${f.direction}` : ', differs';
  return h('li', { class: 'fact', 'data-match': String(f.match), title: f.label },
    sr(`${f.label}: `), text,
    f.direction && [THIN, h('span', { class: 'dir', 'aria-hidden': 'true' }, ARROW[f.direction])],
    sr(verdict));
}

// rows: [{ drug, facts }] in the order guessed.
export function renderGuesses(list, rows, { fresh = false } = {}) {
  list.replaceChildren(...rows.map((row, i) =>
    h('li', { class: fresh && i === rows.length - 1 ? 'guess is-new' : 'guess' },
      h('p', { class: 'guess-name' }, row.drug.generic, row.drug.brand && h('span', { class: 'aka' }, row.drug.brand)),
      h('ul', { class: 'facts' }, row.facts.map(fact)))).reverse());
}
