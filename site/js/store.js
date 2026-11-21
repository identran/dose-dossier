// Everything the game remembers, under one versioned localStorage key.
// If storage is unavailable (private mode, blocked, full) the store keeps working in memory.

export const STORAGE_KEY = 'dose-dossier.v1';

const blank = () => ({ v: 1, games: {}, theme: null });

function sane(data) {
  if (!data || typeof data !== 'object' || data.v !== 1) return blank();
  const out = blank();
  if (data.theme === 'light' || data.theme === 'dark') out.theme = data.theme;
  if (data.games && typeof data.games === 'object') {
    for (const [key, g] of Object.entries(data.games)) {
      const day = Number(key);
      if (!Number.isInteger(day) || !g || typeof g.answerId !== 'string') continue;
      if (!Array.isArray(g.guesses) || !g.guesses.every(id => typeof id === 'string')) continue;
      if (!['playing', 'won', 'lost'].includes(g.status)) continue;
      out.games[day] = { day, answerId: g.answerId, guesses: g.guesses, status: g.status };
    }
  }
  return out;
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

  function read() {
    if (!storage) return memory;
    try {
      memory = sane(JSON.parse(storage.getItem(key)));
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
    } catch {
      // Quota or permissions: the game goes on in memory.
    }
  }

  return {
    persistent: Boolean(storage),
    game: day => read().games[day] || null,
    games: () => read().games,
    saveGame: game => write(data => { data.games[game.day] = game; }),
    theme: () => read().theme,
    setTheme: theme => write(data => { data.theme = theme; }),
  };
}
