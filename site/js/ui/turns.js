// The turns: each miss with its comparison against the answer and the clue it opened, newest first.
// A match is set in ink semibold and a miss in the muted tone; the year carries an arrow toward
// the answer's and is set in ink when it is within three years.

import { h, sr } from './dom.js';
import { tidy, typeset, glossLine, THIN } from './format.js';

const ARROW = { later: '↑', earlier: '↓' };

function fact(f) {
  if (f.value == null) return h('li', { class: 'fact' }, '–');
  return h('li', { class: 'fact', 'data-state': f.match ? 'match' : f.near ? 'near' : null },
    tidy(f.value), f.direction && `${THIN}${ARROW[f.direction]}`);
}

// turns: [{ drug, facts, clue }] in the order played (see game.turns). describe(turn) is the
// row as a sentence for a screen reader; gloss(text), when given, returns a term's explanation.
export function renderTurns(list, turns, { fresh = false, describe, gloss = null } = {}) {
  const items = turns.map((turn, i) => {
    const { drug, facts, clue } = turn;
    return h('li', { class: fresh && i === turns.length - 1 ? 'turn is-new' : 'turn' },
      sr(describe(turn)),
      h('p', { class: 'turn-name', 'aria-hidden': 'true' }, drug.generic, drug.brand && [' ', h('span', { class: 'aka' }, drug.brand)]),
      h('ul', { class: 'facts', 'aria-hidden': 'true' }, facts.map(fact)),
      clue && [
        h('p', { class: 'clue' }, h('span', { class: 'clue-module' }, clue.module), ' ', typeset(clue.text)),
        glossLine(gloss?.(clue.module)),
        glossLine(gloss?.(clue.text)),
      ]);
  });
  list.replaceChildren(...items.reverse());
}
