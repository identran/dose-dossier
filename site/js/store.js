// Everything the game remembers, under one localStorage key: { v, games, theme, explain }.
// Older data is brought forward by ordered migrations when it is read. Data written by a newer
// version of the game is never overwritten: the session then runs in memory. So it does when
// storage is unavailable (private mode, blocked, full).

export const STORAGE_KEY = 'dose-dossier';
export const VERSION = 2;

// Version 1 lived under its own key.
const LEGACY_KEY = 'dose-dossier.v1';
const STATUSES = ['playing', 'won', 'lost'];

const blank = () => ({ v: VERSION, games: {}, theme: null, explain: false });

// MIGRATIONS[n] takes data at version n to version n + 1.
const MIGRATIONS = {
  // 1 → 2: eight guesses instead of eleven, and games are live or archive. A version 1 game that
  // fits in eight guesses is kept as an archive game, since nothing recorded when it was played.
  1(data) {
    const games = {};
    for (const [day, g] of Object.entries(data.games || {})) {
      const n = Array.isArray(g?.guesses) ? g.guesses.length : Infinity;
      if ((g?.status === 'won' && n <= 8) || (g?.status === 'playing' && n < 8)) games[day] = { ...g, live: false };
    }
    return { v: 2, games, theme: data.theme ?? null, explain: false };
  },
};

function sane(data) {
  const out = blank();
  if (data.theme === 'light' || data.theme === 'dark') out.theme = data.theme;
  out.explain = data.explain === true;
  if (data.games && typeof data.games === 'object') {
    for (const [key, g] of Object.entries(data.games)) {
      const day = Number(key);
      if (!Number.isInteger(day) || !g || typeof g.answerId !== 'string') continue;
      if (!Array.isArray(g.guesses) || !g.guesses.every(id => typeof id === 'string')) continue;
      if (!STATUSES.includes(g.status)) continue;
      out.games[day] = { day, answerId: g.answerId, guesses: g.guesses, status: g.status, live: g.live === true };
    }
  }
  return out;
}

// Parsed storage to current data: { data, newer } where newer means a later version wrote it.
export function upgrade(raw) {
  if (!raw || typeof raw !== 'object' || !Number.isInteger(raw.v) || raw.v < 1) return { data: blank(), newer: false };
  if (raw.v > VERSION) return { data: { ...blank(), theme: sane(raw).theme }, newer: true };
  let data = raw;
  try {
    while (data.v < VERSION) data = MIGRATIONS[data.v](data);
  } catch {
    return { data: blank(), newer: false };
  }
  return { data: sane(data), newer: false };
}

export function createStore(key = STORAGE_KEY) {
  let storage = null;
  try {
    storage = window.localStorage;
    const probe = `${key}.probe`;
    storage.setItem(probe, '1');
    storage.removeItem(probe);
  } catch {
    storage = null;
  }

  let memory = blank();
  let legacy = false;

  function read() {
    if (!storage) return memory;
    try {
      let text = storage.getItem(key);
      legacy = text == null && key === STORAGE_KEY;
      if (legacy) text = storage.getItem(LEGACY_KEY);
      if (text == null) return (memory = blank());
      const { data, newer } = upgrade(JSON.parse(text));
      if (newer) storage = null;
      memory = data;
    } catch {
      // Unreadable or corrupt: keep what is in memory.
    }
    return memory;
  }

  // Re-read before every write so two open tabs do not overwrite each other's days.
  function write(change) {
    const data = read();
    change(data);
    memory = data;
    if (!storage) return;
    try {
      storage.setItem(key, JSON.stringify(data));
      if (legacy) storage.removeItem(LEGACY_KEY);
    } catch {
      // Quota or permissions: the game goes on in memory.
    }
  }

  // Version 1 data moves to the current key at once, so the page's inline theme script finds it.
  read();
  if (legacy && storage?.getItem(LEGACY_KEY) != null) write(() => {});

  return {
    game: day => read().games[day] || null,
    games: () => read().games,
    saveGame: game => write(data => { data.games[game.day] = game; }),
    theme: () => read().theme,
    setTheme: theme => write(data => { data.theme = theme; }),
    explain: () => read().explain,
    setExplain: explain => write(data => { data.explain = Boolean(explain); }),
  };
}
