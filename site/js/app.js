// Dose Dossier: loads the day's dossier and wires the figure, the guess field and the turns.
// Rules live in game.js, persistence in store.js, rendering in ui/.

import { makeCurve, sampleTimes } from './pk.js';
import { createDial } from './dial/index.js';
import { renderMolecule } from './molecule.js';
import { renderDoseForm } from './glyph.js';
import * as game from './game.js';
import { createStore } from './store.js';
import { $, h } from './ui/dom.js';
import { profileLine, probeLine, profileRows, inSentence, typeset, glossLine } from './ui/format.js';
import { createCombobox } from './ui/combobox.js';
import { renderTurns } from './ui/turns.js';
import { renderDossier } from './ui/dossier.js';
import { createGlosser } from './ui/gloss.js';
import { initSheets, renderStatistics, renderProfile } from './ui/sheets.js';

const { RULES } = game;
const GREETING = 'Name the drug with this profile. Each miss opens a clue.';
const params = new URLSearchParams(location.search);
const store = createStore();

const el = {
  day: $('#day'), earlier: $('#earlier'), later: $('#later'),
  dial: $('#dial'), glyph: $('#glyph'), context: $('#context'), profile: $('#profile'), probe: $('#probe'),
  table: $('[data-sheet="table"]'), captionGloss: $('#caption-gloss'),
  form: $('#guess-form'), input: $('#guess'), listbox: $('#suggestions'), submit: $('#guess-form .button'),
  status: $('#status'), result: $('#result'), answer: $('#answer'), brand: $('#answer-brand'),
  answerFacts: $('#answer-facts'), tell: $('#tell'), outcome: $('#outcome'), copy: $('#copy'), label: $('#label'),
  revision: $('#revision'), dossierSection: $('#dossier-section'), dossier: $('#dossier'), turns: $('#turns'),
  explain: $('#explain'), theme: $('#theme'), live: $('#live'),
};

const safely = (what, fn) => { try { return fn(); } catch (error) { console.error(what, error); return undefined; } };

// The one live region. It is emptied first so that a repeated message is spoken again.
let announcing = 0;
function announce(text) {
  clearTimeout(announcing);
  el.live.textContent = '';
  announcing = setTimeout(() => { el.live.textContent = text; }, 50);
}

/* Theme, and the day's accent, which has a value per theme */

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
const override = () => document.documentElement.dataset.theme || null;
const currentTheme = () => override() || (darkQuery.matches ? 'dark' : 'light');
let dial = null;
let accent = null; // { light, dark } from the day file; without one the accent is the mute token

const themeMetas = [...document.querySelectorAll('meta[name="theme-color"]')]
  .map(meta => ({ meta, media: meta.media, content: meta.content }));

function applyTheme() {
  const theme = currentTheme();
  const root = document.documentElement;
  if (accent?.[theme]) root.style.setProperty('--accent', accent[theme]);
  else root.style.removeProperty('--accent');
  const paper = getComputedStyle(root).getPropertyValue('--paper').trim();
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
// A theme carried over from older storage is not yet where the inline script looks for it.
if (!override() && store.theme()) document.documentElement.dataset.theme = store.theme();
applyTheme();

/* Loading */

async function load(path) {
  const response = await fetch(new URL(`../data/${path}`, import.meta.url));
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  return response.json();
}

// The address of a day; today's is the page itself.
function dayHref(day, today) {
  const next = new URLSearchParams(params);
  if (day === today) next.delete('day'); else next.set('day', day);
  const query = next.toString();
  return query ? `?${query}` : location.pathname;
}

async function start() {
  const index = await load('index.json');
  const today = game.todayNumber(index.epoch);
  const day = game.playableDay(params.get('day'), today);
  // A day that does not exist yet shows today, under today's address.
  if (params.has('day') && game.parseDay(params.get('day')) !== day) history.replaceState(null, '', dayHref(today, today));
  const file = String(game.dossierNumber(day, index.days)).padStart(3, '0');
  const dossier = await load(`day/${file}.json`);
  play({ index, today, day, dossier });
  explain();
}

/* Explain terms: off by default, remembered. The glossary is fetched when first wanted. */

let glossary = null;
let redraw = () => {};

async function explain() {
  const on = store.explain();
  el.explain.textContent = on ? 'Hide explanations' : 'Explain terms';
  if (on && !glossary) glossary = await load('glossary.json').catch(error => { console.error(error); return []; });
  redraw();
}

el.explain.addEventListener('click', () => {
  store.setExplain(!store.explain());
  explain();
});

/* The day */

function play({ index, today, day, dossier }) {
  // Guesses are compared on the index's attributes; the answer always has its own.
  const byId = new Map(index.drugs.map(drug => [drug.id, drug]));
  if (!byId.has(dossier.id)) byId.set(dossier.id, dossier);
  const drugs = game.buildIndex([...byId.values()]);
  // An id the index no longer knows keeps its place in a stored game, without attributes.
  const drugOf = id => byId.get(id) || { id, generic: id };
  const answer = drugOf(dossier.id);
  const clues = dossier.clues || [];
  const nowToday = () => game.todayNumber(index.epoch);

  let greet = Object.keys(store.games()).length === 0; // first visit, until the first keystroke
  let state = store.game(day);
  if (!state || state.answerId !== dossier.id) state = game.newGame(day, dossier.id);

  // Masthead
  el.day.textContent = `Day ${day}`;
  if (day > 1) { el.earlier.href = dayHref(day - 1, today); el.earlier.hidden = false; }
  if (day < today) { el.later.href = dayHref(day + 1, today); el.later.hidden = false; }

  // Figure
  accent = dossier.accent || null;
  applyTheme();
  const curve = makeCurve(dossier.pk);
  const times = sampleTimes(curve, RULES.maxGuesses);
  const context = dossier.pk.context || '';
  const profile = profileLine(curve);

  dial = safely('createDial', () => createDial(el.dial, { onProbe: showProbe }));
  const centre = dial?.center || el.dial;
  if (dial) {
    safely('dial.setTheme', () => dial.setTheme(currentTheme()));
    safely('dial.setChallenge', () => dial.setChallenge({ curve, times, seed: day }));
    safely('dial.setLabel', () => dial.setLabel?.(profile));
    safely('dial.setDetails', () => dial.setDetails?.('profile-table'));
  }
  el.context.textContent = context;
  el.profile.textContent = profile;
  el.table.hidden = false;
  // The glyph takes the day's accent, not the product's raw colour: one accent on the page.
  const pill = dossier.pill ? { shape: dossier.pill.shape, desc: dossier.pill.desc } : null;
  safely('renderDoseForm', () => renderDoseForm(el.glyph, pill, dossier.form));
  renderProfile($('#table'), { line: profile, unit: curve.unit, rows: profileRows(curve, times) });

  // The readout is spoken only while the figure itself has keyboard focus.
  function showProbe(probe) {
    const text = probe ? probeLine(curve, probe.t) : '';
    el.probe.textContent = text;
    if (text && el.dial.contains(document.activeElement)) announce(text);
  }

  // Inside the ring: the structure, or for a biologic the figure of its format.
  let drawCentre = () => {};
  if (Array.isArray(dossier.structure?.atoms) && dossier.structure.atoms.length <= RULES.maxHeavyAtoms) {
    drawCentre = reveal => safely('renderMolecule', () => renderMolecule(centre, dossier.structure, { reveal }));
  } else if (dossier.biologic) {
    let level = 0;
    let draw = null;
    drawCentre = reveal => { level = reveal; draw?.(); };
    // Fetched only on a biologic's day. If it cannot be had the ring stays empty.
    import('./biologic.js').then(({ renderBiologic }) => {
      draw = () => safely('renderBiologic', () => renderBiologic(centre, dossier.biologic, { reveal: level }));
      draw();
    }).catch(() => {});
  }

  // Guess field
  const combo = createCombobox({
    input: el.input,
    listbox: el.listbox,
    rows: RULES.suggestions.shown,
    search: text => game.search(drugs, text, { exclude: state.guesses }),
    onChoose: drug => say(`Enter to guess ${inSentence(drug.generic)}`),
    onAnnounce: announce,
  });

  // The status line: a note on the last action, or the offer of a new day, or what is left.
  let note = '';
  let stale = false;

  function renderStatus() {
    const v = game.view(state, clues.length);
    if (note) el.status.textContent = note;
    else if (stale) el.status.replaceChildren(h('a', { href: dayHref(today, today) }, 'New dossier'));
    else el.status.textContent = v.over ? '' : greet ? GREETING : game.guessesLeft(v.left);
    el.status.hidden = !el.status.hasChildNodes();
  }

  function say(text) {
    note = text;
    renderStatus();
    announce(text);
  }

  function render({ fresh = false } = {}) {
    const v = game.view(state, clues.length);
    // Terms are explained in page order: the caption, the dossier, the turns as they were played.
    const gloss = store.explain() && glossary ? createGlosser(glossary) : null;
    el.captionGloss.replaceChildren(...[glossLine(gloss?.(`${context} ${profile}`))].filter(Boolean));

    if (dial) {
      safely('dial.setProgress', () => dial.setProgress(v.progress, { animate: fresh }));
      safely('dial.setSolved', () => dial.setSolved(state.status === 'won'));
    }
    drawCentre(v.reveal);

    // During play a turn carries the clue it opened. Afterwards the clues are filed in the
    // dossier, and the list keeps the misses: the answer stands above it.
    const turns = game.turns(state, clues, drugOf);
    el.dossierSection.hidden = !v.over;
    if (v.over) {
      renderDossier(el.dossier, game.filed(clues), { gloss });
      renderTurns(el.turns, turns.map(turn => ({ ...turn, clue: null })), { describe: game.describeTurn });
    } else {
      renderTurns(el.turns, turns, { fresh, describe: game.describeTurn, gloss });
    }

    el.form.hidden = v.over;
    el.result.hidden = !v.over;
    el.input.disabled = el.submit.disabled = v.over;
    if (v.over) {
      el.answer.textContent = dossier.generic;
      el.brand.textContent = dossier.brand || '';
      el.brand.hidden = !dossier.brand;
      el.answerFacts.replaceChildren(...RULES.compare.map(rule => h('li', null, String(answer[rule.key] ?? '–'))));
      el.tell.replaceChildren(...typeset(dossier.tell || ''));
      el.tell.hidden = !dossier.tell;
      el.outcome.textContent = game.outcomeText(state);
      if (dossier.source?.label) el.label.href = dossier.source.label; else el.label.hidden = true;
      el.revision.textContent = dossier.revisionNote || '';
      el.revision.hidden = !dossier.revisionNote;
    }
    renderStatus();
  }

  redraw = render;

  el.input.addEventListener('input', () => {
    greet = false;
    note = '';
    renderStatus();
  });

  // On a phone the on-screen keyboard covers the lower half: bring the field to the top
  // so the suggestions under it stay in view.
  const handheld = window.matchMedia('(pointer: coarse) and (max-width: 59.99rem)');
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
      // Text that names no drug yet: Enter fills in the first suggestion, and a second Enter guesses it.
      if (!combo.completeFirst()) say('No such drug in the list');
      return el.input.focus();
    }

    const { game: next, outcome } = game.guess(state, drug.id, nowToday());
    if (outcome === 'duplicate') {
      say(`${drug.generic} already guessed`);
      return el.input.select();
    }

    state = next;
    store.saveGame(state);
    combo.clear();
    greet = false;
    note = '';
    render({ fresh: true });

    const v = game.view(state, clues.length);
    const last = game.turns(state, clues, drugOf).at(-1);
    if (outcome === 'miss') {
      announce(game.announcement(last, v.left));
      el.input.focus();
    } else {
      announce(outcome === 'won' ? `${game.outcomeText(state)}.` : `${game.describeTurn(last)} ${game.outcomeText(state)}.`);
      el.answer.focus();
    }
  });

  // Result
  let copiedTimer = 0;
  el.copy.addEventListener('click', async () => {
    const url = new URL(location.href);
    url.search = `?day=${day}`;
    url.hash = '';
    const ok = await copy(game.shareText(state, url.href, drugOf));
    el.copy.textContent = ok ? 'Copied' : 'Copy failed';
    announce(el.copy.textContent);
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => { el.copy.textContent = 'Copy result'; }, 2000);
  });

  initSheets({ stats: dialog => renderStatistics(dialog, game.statistics(store.games(), nowToday())) });

  // A tab left open past midnight offers the new day.
  function checkDay() {
    if (stale || nowToday() <= today) return;
    stale = true;
    renderStatus();
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkDay(); });
  window.addEventListener('focus', checkDay);

  render();
  if (state.status === 'playing' && window.matchMedia('(min-width: 60rem)').matches) el.input.focus({ preventScroll: true });
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
