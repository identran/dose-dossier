// Dose Dossier: loads the day's dossier and wires the figure, the guess field and the lists.
// Rules live in game.js, persistence in store.js, rendering in ui/.

import { makeCurve, sampleTimes, formatHours } from './pk.js';
import { createDial } from './dial/index.js';
import { renderMolecule } from './molecule.js';
import { renderDoseForm } from './glyph.js';
import * as game from './game.js';
import { createStore } from './store.js';
import { $ } from './ui/dom.js';
import { number, aucUnit } from './ui/format.js';
import { createCombobox } from './ui/combobox.js';
import { renderGuesses } from './ui/guesses.js';
import { renderDossier } from './ui/dossier.js';
import { initSheets, renderStatistics } from './ui/sheets.js';

const { RULES } = game;
const params = new URLSearchParams(location.search);
const store = createStore();

const el = {
  day: $('#day'), earlier: $('#earlier'), later: $('#later'),
  dial: $('#dial'), glyph: $('#glyph'), context: $('#context'), probe: $('#probe'),
  form: $('#guess-form'), input: $('#guess'), listbox: $('#suggestions'), submit: $('#guess-form .button'),
  status: $('#status'), result: $('#result'), answer: $('#answer'), brand: $('#answer-brand'),
  outcome: $('#outcome'), copy: $('#copy'), label: $('#label'),
  guesses: $('#guesses'), dossier: $('#dossier'), theme: $('#theme'), live: $('#live'),
};

const announce = text => { el.live.textContent = text; };
const safely = (what, fn) => { try { return fn(); } catch (error) { console.error(what, error); return undefined; } };

/* Theme */

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
const override = () => document.documentElement.dataset.theme || null;
const currentTheme = () => override() || (darkQuery.matches ? 'dark' : 'light');
let dial = null;

const themeMetas = [...document.querySelectorAll('meta[name="theme-color"]')]
  .map(meta => ({ meta, media: meta.media, content: meta.content }));

function applyTheme() {
  const theme = currentTheme();
  const paper = getComputedStyle(document.documentElement).getPropertyValue('--paper').trim();
  for (const { meta, media, content } of themeMetas) {
    if (override()) { meta.removeAttribute('media'); meta.content = paper; }
    else { meta.media = media; meta.content = content; }
  }
  el.theme.textContent = theme === 'dark' ? 'Light' : 'Dark';
  el.theme.setAttribute('aria-label', `Switch to the ${theme === 'dark' ? 'light' : 'dark'} theme`);
  if (dial) safely('dial.setTheme', () => dial.setTheme(theme));
}

// Choosing the theme the system already prefers goes back to following the system.
el.theme.addEventListener('click', () => {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  const follows = next === (darkQuery.matches ? 'dark' : 'light');
  if (follows) delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = next;
  store.setTheme(follows ? null : next);
  applyTheme();
});
darkQuery.addEventListener('change', applyTheme);
applyTheme();

/* Loading */

async function load(path) {
  const response = await fetch(new URL(`../data/${path}`, import.meta.url));
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  return response.json();
}

function dayHref(day, today) {
  const next = new URLSearchParams(params);
  if (day === today) next.delete('day'); else next.set('day', day);
  const query = next.toString();
  return query ? `?${query}` : location.pathname;
}

async function start() {
  const index = await load('index.json');
  const today = game.todayNumber(index.epoch);
  const day = game.parseDay(params.get('day')) ?? today;
  const number3 = String(game.dossierNumber(day, index.days)).padStart(3, '0');
  const dossier = await load(`day/${number3}.json`);
  play({ index, today, day, dossier });
}

/* The day */

function play({ index, today, day, dossier }) {
  const drugs = game.buildIndex(index.drugs);
  const byId = new Map(index.drugs.map(d => [d.id, d]));
  const answer = byId.get(dossier.id) || {
    id: dossier.id, generic: dossier.generic, brand: dossier.brand, aliases: dossier.aliases || [],
    area: dossier.area, form: dossier.form, sponsor: dossier.sponsor, halfLifeH: dossier.pk.halfLifeH,
  };
  if (!byId.has(answer.id)) { byId.set(answer.id, answer); drugs.push(...game.buildIndex([answer])); }
  const clues = dossier.clues || [];

  let state = store.game(day);
  if (!state || state.answerId !== dossier.id || state.guesses.some(id => !byId.has(id))) {
    state = game.newGame(day, dossier.id);
  }

  // Masthead
  el.day.textContent = `Day ${day}`;
  if (day > 1) { el.earlier.href = dayHref(day - 1, today); el.earlier.hidden = false; }
  if (day < today) { el.later.href = dayHref(day + 1, today); el.later.hidden = false; }

  // Figure
  const accent = dossier.pill?.color || getComputedStyle(document.documentElement).getPropertyValue('--mute').trim();
  document.documentElement.style.setProperty('--accent', accent);
  const curve = makeCurve(dossier.pk);
  const times = sampleTimes(curve, RULES.maxGuesses);
  const unit = dossier.pk.unit || '';

  dial = safely('createDial', () => createDial(el.dial, { onProbe: showProbe }));
  const centre = dial?.center || el.dial;
  if (dial) {
    safely('dial.setTheme', () => dial.setTheme(currentTheme()));
    safely('dial.setChallenge', () => dial.setChallenge({ curve, times, accent, seed: day }));
  }
  el.context.textContent = dossier.pk.context || '';
  safely('renderDoseForm', () => renderDoseForm(el.glyph, dossier.pill, dossier.form));

  // The readout is announced only while the figure itself has keyboard focus.
  el.dial.addEventListener('focusin', () => el.probe.setAttribute('aria-live', 'polite'));
  el.dial.addEventListener('focusout', () => el.probe.setAttribute('aria-live', 'off'));

  function showProbe(probe) {
    el.probe.textContent = probe
      ? `${formatHours(probe.t)} · ${number(probe.c)} ${unit} · AUC ${number(probe.auc)} ${aucUnit(unit)}`
      : '';
  }

  // Guess field
  const combo = createCombobox({
    input: el.input,
    listbox: el.listbox,
    search: text => game.search(drugs, text, { exclude: state.guesses }),
    onAnnounce: announce,
  });

  const turnText = () => `Guess ${game.view(state, clues.length).turn} of ${RULES.maxGuesses}`;
  const say = text => { el.status.textContent = text; };

  function render({ fresh = false } = {}) {
    const v = game.view(state, clues.length);

    if (dial) {
      safely('dial.setProgress', () => dial.setProgress(Math.min(v.progress, times.length), { animate: fresh }));
      safely('dial.setSolved', () => dial.setSolved(state.status === 'won'));
    }
    safely('renderMolecule', () => renderMolecule(centre, dossier.structure, { reveal: v.reveal }));

    // The list is of misses; a correct guess is the answer set above it, not a row to repeat.
    const misses = state.guesses.filter(id => id !== answer.id);
    renderGuesses(el.guesses, misses.map(id => ({ drug: byId.get(id), facts: game.compare(byId.get(id), answer) })),
      { fresh: fresh && state.status !== 'won' });
    renderDossier(el.dossier, clues, v.clues, RULES.modules, { fresh: fresh && !v.over });

    el.form.hidden = el.status.hidden = v.over;
    el.result.hidden = !v.over;
    el.input.disabled = el.submit.disabled = v.over;
    if (v.over) {
      el.answer.textContent = dossier.generic;
      el.brand.textContent = dossier.brand || '';
      el.outcome.textContent = state.status === 'won'
        ? `Solved in ${v.used} of ${RULES.maxGuesses}`
        : `Not solved in ${RULES.maxGuesses}`;
      if (dossier.source?.label) el.label.href = dossier.source.label; else el.label.hidden = true;
    } else {
      say(turnText());
    }
  }

  el.input.addEventListener('input', () => say(turnText()));

  // On a phone the on-screen keyboard covers the lower half: bring the field to the top
  // so the suggestions under it stay in view.
  const handheld = window.matchMedia('(pointer: coarse) and (max-width: 959px)');
  el.input.addEventListener('focus', () => {
    if (!handheld.matches) return;
    const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    requestAnimationFrame(() => el.form.scrollIntoView({ block: 'start', behavior: calm ? 'auto' : 'smooth' }));
  });

  el.form.addEventListener('submit', event => {
    event.preventDefault();
    if (state.status !== 'playing') return;
    const text = combo.text().trim();
    if (!text) return el.input.focus();

    const drug = combo.chosen() || game.resolve(drugs, text);
    if (!drug) {
      const found = combo.suggest();
      say(found ? 'Choose a drug from the list' : 'No such drug in the list');
      announce(el.status.textContent);
      return el.input.focus();
    }

    const { game: next, outcome } = game.guess(state, drug.id);
    if (outcome === 'duplicate') {
      say(`${drug.generic} already guessed`);
      announce(el.status.textContent);
      return el.input.select();
    }

    state = next;
    store.saveGame(state);
    combo.clear();
    render({ fresh: true });

    if (outcome === 'miss') {
      const clue = clues[game.view(state, clues.length).clues - 1];
      announce(`Not ${drug.generic}. ${clue ? `New clue, ${clue.title}: ${clue.text}` : ''}`);
      el.input.focus();
    } else {
      announce(`${el.outcome.textContent}. The answer is ${dossier.generic}.`);
      el.answer.focus();
    }
  });

  // Result
  let copiedTimer = 0;
  el.copy.addEventListener('click', async () => {
    const url = new URL(location.href);
    url.search = `?day=${day}`;
    url.hash = '';
    const ok = await copy(game.shareText(state, url.href));
    el.copy.textContent = ok ? 'Copied' : 'Copy failed';
    announce(el.copy.textContent);
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => { el.copy.textContent = 'Copy result'; }, 2000);
  });

  initSheets({ stats: dialog => renderStatistics(dialog, game.statistics(store.games(), today)) });

  render();
  if (state.status === 'playing') {
    el.input.disabled = el.submit.disabled = false;
    if (window.matchMedia('(min-width: 960px)').matches) el.input.focus({ preventScroll: true });
  }
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older browsers and insecure origins: fall back to a selection.
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.className = 'sr';
    document.body.append(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    area.remove();
    return ok;
  }
}

start().catch(error => {
  console.error(error);
  el.status.textContent = 'The dossier could not be loaded';
  initSheets();
});
