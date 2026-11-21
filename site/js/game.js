// Rules and pure game logic. Nothing here touches the DOM or storage, and every
// number that defines the game lives in RULES so the mechanics can be tuned in one place.

export const RULES = {
  maxGuesses: 8,
  // Reveal level of the centre figure (0..4, see molecule.js and biologic.js):
  // one level per miss, complete from the fourth.
  revealComplete: 4,
  // A structure with more heavy atoms than this is not drawn; the format figure stands in.
  maxHeavyAtoms: 70,
  // What a guess is compared on, in display order. 'exact' compares names; 'year' also says which
  // way the answer lies and whether it is within `near` years.
  compare: [
    { key: 'area', label: 'Area', kind: 'exact' },
    { key: 'class', label: 'Class', kind: 'exact' },
    { key: 'sponsor', label: 'Sponsor', kind: 'exact' },
    { key: 'approved', label: 'Approved', kind: 'year', near: 3 },
  ],
  // The five modules in regulatory order, and the slots of the written clues filed under them
  // after the game. The day file's last clue is generated from the name and is not filed.
  modules: ['Administrative', 'Summaries', 'Quality', 'Nonclinical', 'Clinical'],
  written: ['kinetics', 'substance', 'product', 'safety', 'indication', 'mechanism'],
  suggestions: { shown: 10, limit: 50 },
  share: { none: '○', some: '◐', solved: '●' },
};

/* Days */

const DAY_MS = 864e5;

// Whole local calendar days since the epoch, 1-based, so the day turns at local midnight. Never less than 1.
export function todayNumber(epoch, now = new Date()) {
  const [y, m, d] = String(epoch).split('-').map(Number);
  const then = Date.UTC(y, m - 1, d);
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.max(1, Math.round((today - then) / DAY_MS) + 1);
}

// The day numbers keep counting; the dossiers wrap.
export function dossierNumber(day, days) {
  return ((day - 1) % days + days) % days + 1;
}

export function parseDay(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 99999 ? n : null;
}

// The day to show for a requested one: an earlier day is the archive, anything else is today.
export function playableDay(requested, today) {
  const day = parseDay(requested);
  return day && day <= today ? day : today;
}

/* A game */

export function newGame(day, answerId) {
  return { day, answerId, guesses: [], status: 'playing', live: false };
}

// Returns the next game and what happened: 'won' | 'lost' | 'miss' | 'duplicate' | 'over'.
// A game is live if its first guess is made while it is today's; only live games are counted.
export function guess(game, id, today) {
  if (game.status !== 'playing') return { game, outcome: 'over' };
  if (game.guesses.includes(id)) return { game, outcome: 'duplicate' };
  const guesses = [...game.guesses, id];
  const live = game.guesses.length ? game.live : game.day === today;
  let status = 'playing';
  if (id === game.answerId) status = 'won';
  else if (guesses.length >= RULES.maxGuesses) status = 'lost';
  return { game: { ...game, guesses, status, live }, outcome: status === 'playing' ? 'miss' : status };
}

export const misses = game => game.guesses.filter(id => id !== game.answerId);

// Everything the interface derives from a game.
export function view(game, clueCount = RULES.maxGuesses - 1) {
  const over = game.status !== 'playing';
  const wrong = misses(game).length;
  return {
    over,
    wrong,
    used: game.guesses.length,
    left: RULES.maxGuesses - game.guesses.length,
    progress: Math.min(RULES.maxGuesses, wrong + 1),
    clues: over ? clueCount : Math.min(clueCount, wrong),
    reveal: over ? RULES.revealComplete : Math.min(RULES.revealComplete, wrong),
  };
}

// The misses in the order made, each with its comparison and the clue it opened.
// The eighth miss ends the game and opens nothing.
export function turns(game, clues, drugOf) {
  const answer = drugOf(game.answerId);
  return misses(game).map((id, i) => {
    const drug = drugOf(id);
    return { drug, facts: compare(drug, answer), clue: clues[i] || null };
  });
}

// The written clues under the module names, in regulatory order: [{ module, clues: [clue] }].
export function filed(clues) {
  return RULES.modules.map(module => ({
    module,
    clues: clues.filter(clue => clue.module === module && RULES.written.includes(clue.slot)),
  })).filter(group => group.clues.length);
}

/* Comparison */

const same = (a, b) => fold(a) === fold(b) && fold(a) !== '';

// One entry per RULES.compare attribute: { key, label, kind, value, match, near, direction }.
// direction is 'later' | 'earlier' | null and says where the answer lies from the guess.
export function compare(guessed, answer) {
  return RULES.compare.map(rule => {
    const value = guessed?.[rule.key] ?? null;
    const target = answer?.[rule.key] ?? null;
    const out = { key: rule.key, label: rule.label, kind: rule.kind, value, match: false, near: false, direction: null };
    if (value == null || target == null) return out;
    if (rule.kind === 'year') {
      out.match = value === target;
      out.near = !out.match && Math.abs(value - target) <= rule.near;
      if (!out.match) out.direction = target > value ? 'later' : 'earlier';
    } else {
      out.match = same(value, target);
    }
    return out;
  });
}

function verdict(fact) {
  if (fact.value == null) return `${fact.label} unknown.`;
  if (fact.match) return `${fact.label} ${fact.value}, matches.`;
  if (!fact.direction) return `${fact.label} ${fact.value}, differs.`;
  return `${fact.label} ${fact.value}, the answer is ${fact.direction}${fact.near ? ', within three years' : ''}.`;
}

// A turn as one sentence run for a screen reader:
// "Sertraline. Area Psychiatry, differs. Class SSRI, differs. Sponsor Pfizer, differs. Approved 1991, the answer is later."
export function describeTurn(turn) {
  return [`${turn.drug.generic}.`, ...turn.facts.map(verdict)].join(' ');
}

export const guessesLeft = n => `${n} ${n === 1 ? 'guess' : 'guesses'} left`;

// The one announcement a guess makes: the row, the clue it opened, what is left.
export function announcement(turn, left) {
  const parts = [describeTurn(turn)];
  if (turn.clue) parts.push(`Clue, ${turn.clue.module}: ${turn.clue.text}`);
  if (left > 0) parts.push(`${guessesLeft(left)}.`);
  return parts.join(' ');
}

export function outcomeText(game) {
  return game.status === 'won'
    ? `Solved in ${game.guesses.length} of ${RULES.maxGuesses}`
    : `Not solved in ${RULES.maxGuesses}`;
}

/* Search */

export function fold(text) {
  return String(text ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

// Precompute the folded names of every guessable drug.
export function buildIndex(drugs) {
  return drugs.map(drug => ({
    drug,
    sort: fold(drug.generic),
    names: [
      { text: drug.generic, kind: 'generic' },
      ...(drug.brand ? [{ text: drug.brand, kind: 'brand' }] : []),
      ...(drug.aliases || []).map(text => ({ text, kind: 'alias' })),
    ].map(n => ({ ...n, key: fold(n.text) })),
  }));
}

const PREFIX_RANK = { generic: 1, brand: 2, alias: 3 };

function rank(name, q) {
  if (name.key === q) return 0;
  if (name.key.startsWith(q)) return PREFIX_RANK[name.kind];
  const at = name.key.indexOf(q);
  if (at < 0) return Infinity;
  return name.key[at - 1] === ' ' ? 4 : 5;
}

// Suggestions for a query: exact, then prefix (generic, brand, alias), then word start, then substring.
// Each result is { drug, via } where via is the brand or alias that matched, if it was not the generic name.
export function search(index, query, { exclude = [], limit = RULES.suggestions.limit } = {}) {
  const q = fold(query);
  if (!q) return [];
  const skip = new Set(exclude);
  const hits = [];
  for (const entry of index) {
    if (skip.has(entry.drug.id)) continue;
    let best = Infinity;
    let via = null;
    for (const name of entry.names) {
      const r = rank(name, q);
      if (r < best) { best = r; via = name; }
    }
    if (best < Infinity) hits.push({ entry, best, via });
  }
  hits.sort((a, b) => a.best - b.best || (a.entry.sort < b.entry.sort ? -1 : a.entry.sort > b.entry.sort ? 1 : 0));
  return hits.slice(0, limit).map(({ entry, via }) => ({
    drug: entry.drug,
    via: via.kind === 'generic' ? (entry.drug.brand || null) : via.text,
  }));
}

// The drug a typed name refers to exactly, or null.
export function resolve(index, text) {
  const q = fold(text);
  if (!q) return null;
  const hit = index.find(entry => entry.names.some(n => n.key === q));
  return hit ? hit.drug : null;
}

/* Share */

// Three lines: the day and score, a mark per guess, the link.
// ○ a miss sharing nothing with the answer, ◐ a miss sharing at least one attribute, ● solved.
export function shareText(game, url, drugOf) {
  const won = game.status === 'won';
  const { none, some, solved } = RULES.share;
  const answer = drugOf(game.answerId);
  const marks = misses(game).map(id => (compare(drugOf(id), answer).some(f => f.match) ? some : none));
  if (won) marks.push(solved);
  const score = `${won ? game.guesses.length : 'X'}/${RULES.maxGuesses}`;
  return [`Dose Dossier ${game.day} · ${score}`, marks.join(''), url].join('\n');
}

/* Statistics, derived from the stored games so there is nothing to keep in step */

// Only live games count. The streak is consecutive live days solved: a loss or a missed day ends it.
export function statistics(games, today) {
  const done = Object.values(games).filter(g => g && g.live && g.status !== 'playing');
  const won = new Set(done.filter(g => g.status === 'won').map(g => g.day));
  const distribution = Array(RULES.maxGuesses).fill(0);
  for (const g of done) if (g.status === 'won') distribution[g.guesses.length - 1]++;

  let best = 0;
  for (const day of won) {
    if (won.has(day - 1)) continue;
    let run = 1;
    while (won.has(day + run)) run++;
    best = Math.max(best, run);
  }

  // The streak runs back from today, or from yesterday while today is still open.
  const closed = done.some(g => g.day === today);
  let from = closed ? today : today - 1;
  let streak = 0;
  while (won.has(from)) { streak++; from--; }

  return { played: done.length, solved: won.size, missed: done.length - won.size, streak, best, distribution };
}
