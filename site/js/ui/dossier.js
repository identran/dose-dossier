// The dossier, shown once the game is over: the written clues under the module names.

import { h } from './dom.js';
import { typeset, glossLine } from './format.js';

// groups: [{ module, clues: [{ text }] }] in regulatory order (see game.filed).
export function renderDossier(root, groups, { gloss = null } = {}) {
  root.replaceChildren(...groups.map(group =>
    h('div', { class: 'module' },
      h('h3', null, group.module),
      glossLine(gloss?.(group.module)),
      group.clues.map(clue => [h('p', { class: 'clue' }, typeset(clue.text)), glossLine(gloss?.(clue.text))]))));
}
