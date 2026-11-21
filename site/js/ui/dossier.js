// The dossier: clues as plain typeset entries under the five module names.
// Modules with nothing revealed yet are listed in the muted tone.

import { h } from './dom.js';
import { typeset } from './format.js';

// clues: [{ module, title, text }], shown: how many are revealed, modules: { 1: 'Administrative', … }
export function renderDossier(root, clues, shown, modules, { fresh = false } = {}) {
  const groups = [];
  clues.forEach((clue, i) => {
    let group = groups.find(g => g.module === clue.module);
    if (!group) groups.push(group = { module: clue.module, entries: [] });
    if (i < shown) group.entries.push({ clue, isNew: fresh && i === shown - 1 });
  });
  groups.sort((a, b) => a.module - b.module);

  root.replaceChildren(...groups.map(group =>
    h('div', { class: group.entries.length ? 'module is-open' : 'module is-pending' },
      h('h3', null, modules[group.module] || ''),
      group.entries.map(({ clue, isNew }) =>
        h('p', { class: isNew ? 'clue is-new' : 'clue' },
          h('span', { class: 'clue-title' }, clue.title), typeset(clue.text))))));
}
