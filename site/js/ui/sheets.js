// "How to play" and statistics, each a native <dialog> styled as a plain sheet.

import { $, h, sr } from './dom.js';

export function initSheets(onOpen = {}) {
  for (const button of document.querySelectorAll('[data-sheet]')) {
    const name = button.dataset.sheet;
    const dialog = document.getElementById(name);
    if (!dialog || typeof dialog.showModal !== 'function') {
      button.hidden = true;
      continue;
    }
    button.addEventListener('click', () => {
      onOpen[name]?.(dialog);
      dialog.showModal();
    });
  }
}

export function renderStatistics(dialog, stats) {
  const figures = [['Played', stats.played], ['Solved', stats.solved], ['Streak', stats.streak], ['Best streak', stats.best]];
  $('#figures', dialog).replaceChildren(...figures.map(([label, value]) =>
    h('div', null, h('dt', null, label), h('dd', null, String(value)))));

  const most = Math.max(1, ...stats.distribution);
  $('#distribution', dialog).replaceChildren(...stats.distribution.map((count, i) =>
    h('li', null,
      h('span', { class: 'n' }, String(i + 1), sr(i ? ' guesses:' : ' guess:')),
      h('span', { class: 'bar', style: `--share: ${count / most}` }, count ? String(count) : sr('0')))));
}
