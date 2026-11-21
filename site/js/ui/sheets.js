// The sheets: how to play, statistics and the profile as a table, each a native <dialog>.

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

  const rows = [
    ...stats.distribution.map((count, i) => ({ count, label: [String(i + 1), sr(i ? ' guesses:' : ' guess:')] })),
    { count: stats.missed, label: [h('span', { 'aria-hidden': 'true' }, 'X'), sr('Missed:')] },
  ];
  const most = Math.max(1, ...rows.map(row => row.count));
  $('#distribution', dialog).replaceChildren(...rows.map(({ count, label }) =>
    h('li', null,
      h('span', { class: 'n' }, label),
      h('span', { class: 'bar', style: `--share: ${count / most}` }, count ? String(count) : sr('0')))));
}

// line: the profile in words; rows: [{ time, concentration, ofPeak }] (see format.profileRows);
// unit is null when the label gives no Cmax, and the concentration column is then left out.
export function renderProfile(dialog, { line, unit, rows }) {
  $('#profile-line', dialog).textContent = line;
  const heads = ['Time', unit && `Concentration, ${unit}`, 'Per cent of peak'].filter(Boolean);
  $('#profile-table', dialog).replaceChildren(
    h('thead', null, h('tr', null, heads.map(text => h('th', { scope: 'col' }, text)))),
    h('tbody', null, rows.map(row =>
      h('tr', null, h('td', null, row.time), unit && h('td', null, row.concentration), h('td', null, row.ofPeak)))));
}
