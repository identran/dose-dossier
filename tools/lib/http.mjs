// Polite cached JSON fetch: at most ~4 requests a second, every response cached on disk.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const CACHE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.cache');
const GAP_MS = 280;
let last = 0;

export async function getJSON(url, { retries = 3 } = {}) {
  const key = createHash('sha1').update(url).digest('hex').slice(0, 16);
  const file = path.join(CACHE_DIR, `${key}.json`);
  try {
    const hit = JSON.parse(await readFile(file, 'utf8'));
    return hit.status === 404 ? null : hit.body;
  } catch {}
  for (let attempt = 0; ; attempt++) {
    const wait = last + GAP_MS - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    last = Date.now();
    const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'dose-dossier-tools' } });
    if (res.status === 404) {
      await mkdir(CACHE_DIR, { recursive: true });
      await writeFile(file, JSON.stringify({ url, status: 404 }));
      return null;
    }
    if (res.ok) {
      const body = await res.json();
      await mkdir(CACHE_DIR, { recursive: true });
      await writeFile(file, JSON.stringify({ url, status: 200, body }));
      return body;
    }
    if (attempt >= retries || (res.status < 500 && res.status !== 429)) throw new Error(`${res.status} ${res.statusText} for ${url}`);
    await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
  }
}
