// Polite cached JSON fetch shared by every tool.
//  - at most ~2.8 requests a second overall (one request every GAP_MS), whatever the host
//  - every response is cached on disk under tools/.cache/, so re-runs are free (404s are cached too)
//  - 429 / 5xx / network errors are retried with backoff, honouring Retry-After
//  - an optional request budget stops a run cleanly before openFDA's keyless daily allowance is gone
// Behind the agent proxy run with NODE_USE_ENV_PROXY=1 (the npm scripts set it).
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const CACHE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.cache');
const GAP_MS = 360;
let last = 0;
let budget = Infinity;
export const stats = { network: 0, cached: 0, retries: 0 };

export class RateLimitError extends Error {
  constructor(msg) { super(msg); this.code = 'RATE_LIMIT'; }
}
export class BudgetError extends Error {
  constructor(msg) { super(msg); this.code = 'BUDGET'; }
}

// Stop a run after this many live (uncached) requests; cached hits are free.
export function setRequestBudget(n) { budget = n; }

const sleep = ms => new Promise(r => setTimeout(r, ms));

export function cacheFile(url) {
  const key = createHash('sha1').update(url).digest('hex').slice(0, 16);
  return path.join(CACHE_DIR, `${key}.json`);
}

async function save(file, value) {
  await mkdir(CACHE_DIR, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value));
  await rename(tmp, file);
}

// `slim(body)` may drop bulky fields before the body is cached and returned.
export async function getJSON(url, { retries = 4, slim } = {}) {
  const file = cacheFile(url);
  try {
    const hit = JSON.parse(await readFile(file, 'utf8'));
    stats.cached++;
    return hit.status === 404 ? null : hit.body;
  } catch {}
  for (let attempt = 0; ; attempt++) {
    if (stats.network >= budget) throw new BudgetError(`request budget of ${budget} live requests reached`);
    const wait = last + GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    stats.network++;
    let res;
    try {
      res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'dose-dossier-tools' }, signal: AbortSignal.timeout(90000) });
    } catch (e) {
      if (attempt >= retries) throw new Error(`network error for ${url}: ${e.cause?.code || e.message}`);
      stats.retries++;
      await sleep(2000 * (attempt + 1));
      continue;
    }
    if (res.status === 404) {
      await res.arrayBuffer().catch(() => {});
      await save(file, { url, status: 404 });
      return null;
    }
    if (res.ok) {
      let body = await res.json();
      if (slim) body = slim(body);
      await save(file, { url, status: 200, body });
      return body;
    }
    const retryable = res.status === 429 || res.status >= 500;
    await res.arrayBuffer().catch(() => {});
    if (!retryable) throw new Error(`${res.status} ${res.statusText} for ${url}`);
    if (attempt >= retries) {
      const msg = `${res.status} ${res.statusText} for ${url}`;
      throw res.status === 429 ? new RateLimitError(msg) : new Error(msg);
    }
    stats.retries++;
    const ra = Number(res.headers.get('retry-after'));
    const backoff = res.status === 429 ? 8000 * 2 ** attempt : 1500 * (attempt + 1);
    await sleep(Math.min(Number.isFinite(ra) && ra > 0 ? ra * 1000 : backoff, 120000));
  }
}
