// Rules and pure game logic. Nothing here touches the DOM or storage, and every
// number that defines the game lives in RULES so the mechanics can be tuned in one place.

export const RULES = {
  maxGuesses: 11,
  // Structure reveal level (0..4, see molecule.js) by number of wrong guesses; the last value holds.
  structureReveal: [0, 1, 1, 2, 2, 3, 4],
  revealComplete: 4,
  // Attributes a guess is compared on. 'exact' compares names, 'scalar' compares within a tolerance.
  compare: [
    { key: 'area', label: 'Therapeutic area', kind: 'exact' },
    { key: 'form', label: 'Dosage form', kind: 'exact' },
    { key: 'sponsor', label: 'Sponsor', kind: 'exact' },
    { key: 'halfLifeH', label: 'Half-life', kind: 'scalar', tolerance: 0.1 },
  ],
  modules: { 1: 'Administrative', 2: 'Summaries', 3: 'Quality', 4: 'Nonclinical', 5: 'Clinical' },
  suggestions: 7,
  share: { miss: '○', hit: '●' },
};

/* Days */

const DAY_MS = 864e5;

// Whole local calendar days since the epoch, 1-based. Never less than 1.
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

/* A game */

export function newGame(day, answerId) {
  return { day, answerId, guesses: [], status: 'playing' };
}

// Returns the next game and what happened: 'won' | 'lost' | 'miss' | 'duplicate' | 'over'.
export function guess(game, id) {
  if (game.status !== 'playing') return { game, outcome: 'over' };
  if (game.guesses.includes(id)) return { game, outcome: 'duplicate' };
  const guesses = [...game.guesses, id];
  let status = 'playing';
  if (id === game.answerId) status = 'won';
  else if (guesses.length >= RULES.maxGuesses) status = 'lost';
  return { game: { ...game, guesses, status }, outcome: status === 'playing' ? 'miss' : status };
}

// Everything the interface derives from a game.
export function view(game, clueCount = RULES.maxGuesses - 1) {
  const over = game.status !== 'playing';
  const wrong = game.guesses.length - (game.status === 'won' ? 1 : 0);
  const steps = RULES.structureReveal;
  return {
    over,
    wrong,
    used: game.guesses.length,
    turn: Math.min(RULES.maxGuesses, game.guesses.length + 1),
    progress: Math.min(RULES.maxGuesses, wrong + 1),
    clues: over ? clueCount : Math.min(clueCount, wrong),
    reveal: over ? RULES.revealComplete : steps[Math.min(wrong, steps.length - 1)],
  };
}

/* Comparison */

const same = (a, b) => fold(a) === fold(b) && fold(a) !== '';

// One entry per RULES.compare attribute:
// { key, label, kind, value, match, direction } where direction is 'longer' | 'shorter' | null
// and says how the answer differs from the guess.
export function compare(guessed, answer) {
  return RULES.compare.map(rule => {
    const value = guessed[rule.key];
    const target = answer[rule.key];
    const out = { key: rule.key, label: rule.label, kind: rule.kind, value, match: false, direction: null };
    if (value == null || target == null) return out;
    if (rule.kind === 'scalar') {
      out.match = Math.abs(value - target) <= rule.tolerance * target;
      if (!out.match) out.direction = target > value ? 'longer' : 'shorter';
    } else {
      out.match = same(value, target);
    }
    return out;
  });
}

/* Search */

export function fold(text) {
  return String(text ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
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
export function search(index, query, { exclude = [], limit = RULES.suggestions } = {}) {
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

export function shareText(game, url) {
  const won = game.status === 'won';
  const wrong = game.guesses.length - (won ? 1 : 0);
  const score = `${won ? game.guesses.length : 'X'}/${RULES.maxGuesses}`;
  const row = RULES.share.miss.repeat(wrong) + (won ? RULES.share.hit : '');
  return [`Dose Dossier ${game.day}  ${score}`, row, url].join('\n');
}

/* Statistics, derived from the stored games so there is nothing to keep in step */

export function statistics(games, today) {
  const done = Object.values(games).filter(g => g && g.status !== 'playing');
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
  const todays = games[today];
  let from = todays && todays.status !== 'playing' ? today : today - 1;
  let streak = 0;
  while (won.has(from)) { streak++; from--; }

  return { played: done.length, solved: won.size, streak, best, distribution };
}
