#!/usr/bin/env node
// Orders the dossiers in data/dossiers/ into data/schedule.json (see data/SCHEMA.md), deterministically.
//   node tools/schedule.mjs             keep every day already in data/schedule.json exactly as it is, and place
//                                       only the dossiers that are not yet scheduled after them (append-only)
//   node tools/schedule.mjs --rebuild   discard the existing order and schedule every dossier from day 1
//   node tools/schedule.mjs --check     report on the existing schedule against the rules, write nothing
//   --data <dir>                        use another data directory
//
// Rules, for the days this run places:
//   launch    days 1 to 14 are fame-5 drugs from fourteen different classes and at least eight areas; day 1 is OPENER
//   area      no two consecutive days share a therapeutic area
//   class     a class does not come back within ten days (at least 11 days between two drugs of one class)
//   sponsor   a sponsor does not come back within three days (at least 4 days between two of its drugs)
//   fame      after the launch fortnight every calendar week (days 15-21, 22-28, ...) holds at least three
//             well-known drugs (fame 4 or 5) and at least three specialist ones (fame 3 or less)
//   biologic  biologics are at least three days apart, at most two a week, and no week goes without one
// Fame comes from data/candidates.json (1 to 5; a dossier without one counts as 3). The order within the rules is
// fixed by how overdue each area, sponsor and class is, with a hash of the id (never a random number) to break ties,
// so the same dossiers always give the same schedule. When the dossiers left to place cannot satisfy every rule
// (a late addition of three drugs from one sponsor, say), the rules are relaxed in the order of RELAX, and the run says so.
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const DATA = path.resolve(opt('--data', path.join(ROOT, 'data')));
const REBUILD = args.includes('--rebuild');
const CHECK = args.includes('--check');

const OPENER = 'sildenafil';        // day 1 of a rebuilt schedule
const DEFAULT_EPOCH = '2026-12-01';
const LAUNCH_DAYS = 14;
const LAUNCH_AREAS = 8;
const WEEK = 7;
const STRICT = { launch: true, areaGap: 2, classGap: 11, sponsorGap: 4, fameWeek: true, bioGap: 3, bioWeek: true };
// Each step is tried only when the one before it has no solution.
const RELAX = [
  ['strict', {}],
  ['without the weekly fame mix', { fameWeek: false }],
  ['without the weekly fame mix or biologic spacing', { fameWeek: false, bioWeek: false, bioGap: 1 }],
  ['with the launch rule dropped too', { fameWeek: false, bioWeek: false, bioGap: 1, launch: false }],
  ['with sponsors two days apart', { fameWeek: false, bioWeek: false, bioGap: 1, launch: false, sponsorGap: 2 }],
  ['with classes five days apart', { fameWeek: false, bioWeek: false, bioGap: 1, launch: false, sponsorGap: 2, classGap: 5 }],
  ['with only the class and area rules, at their loosest', { fameWeek: false, bioWeek: false, bioGap: 1, launch: false, sponsorGap: 1, classGap: 2 }],
  ['with no rule but the order of urgency', { fameWeek: false, bioWeek: false, bioGap: 1, launch: false, sponsorGap: 1, classGap: 1, areaGap: 1 }],
];
const NODE_LIMIT = 400000;

const readJSON = async f => JSON.parse(await readFile(f, 'utf8'));
// FNV-1a: a fixed, id-dependent number in [0, 1) used only to break ties.
const hash = s => { let h = 0x811c9dc5; for (const c of s) { h ^= c.codePointAt(0); h = Math.imul(h, 0x01000193); } return (h >>> 0) / 2 ** 32; };
const weekOf = pos => Math.floor(pos / WEEK); // pos is 0-based

async function load() {
  const cands = new Map((await readJSON(path.join(DATA, 'candidates.json'))).map(c => [c.id, c]));
  const files = (await readdir(path.join(DATA, 'dossiers'))).filter(f => f.endsWith('.json')).sort();
  const items = new Map();
  for (const f of files) {
    const d = await readJSON(path.join(DATA, 'dossiers', f));
    const fame = Number.isInteger(cands.get(d.id)?.fame) ? cands.get(d.id).fame : 3;
    items.set(d.id, { id: d.id, area: d.area, class: d.class, sponsor: d.sponsor, fame, known: fame >= 4, bio: d.biologic !== undefined, tie: hash(d.id) });
  }
  let schedule = null;
  try { schedule = await readJSON(path.join(DATA, 'schedule.json')); } catch {}
  return { items, schedule };
}

// ------------------------------------------------------------------ rule check (independent of the search)

function violations(days, items, from = 0) {
  const out = [];
  const last = { class: new Map(), sponsor: new Map(), bio: -Infinity };
  days.forEach((id, i) => {
    const it = items.get(id);
    const say = msg => { if (i >= from) out.push(`day ${i + 1} ${id}: ${msg}`); };
    if (i > 0 && items.get(days[i - 1]).area === it.area) say(`same area as the day before (${it.area})`);
    if (last.class.has(it.class) && i - last.class.get(it.class) < STRICT.classGap) say(`class "${it.class}" was on day ${last.class.get(it.class) + 1}`);
    if (last.sponsor.has(it.sponsor) && i - last.sponsor.get(it.sponsor) < STRICT.sponsorGap) say(`sponsor ${it.sponsor} was on day ${last.sponsor.get(it.sponsor) + 1}`);
    if (it.bio && i - last.bio < STRICT.bioGap) say(`biologic ${i - last.bio} day(s) after another`);
    last.class.set(it.class, i); last.sponsor.set(it.sponsor, i); if (it.bio) last.bio = i;
  });
  const launch = days.slice(0, LAUNCH_DAYS).map(id => items.get(id));
  if (from === 0 && launch.length === LAUNCH_DAYS) {
    if (days[0] !== OPENER && items.has(OPENER)) out.push(`day 1 is ${days[0]}, not ${OPENER}`);
    const notFive = launch.filter(it => it.fame !== 5 && it.id !== OPENER).map(it => it.id);
    if (notFive.length) out.push(`launch fortnight has drugs below fame 5: ${notFive.join(', ')}`);
    if (new Set(launch.map(it => it.class)).size < LAUNCH_DAYS) out.push('launch fortnight repeats a class');
    if (new Set(launch.map(it => it.area)).size < LAUNCH_AREAS) out.push(`launch fortnight covers fewer than ${LAUNCH_AREAS} areas`);
  }
  const totalBio = days.filter(id => items.get(id).bio).length;
  for (let w = Math.ceil(Math.max(from, LAUNCH_DAYS) / WEEK); (w + 1) * WEEK <= days.length; w++) {
    const wk = days.slice(w * WEEK, (w + 1) * WEEK).map(id => items.get(id));
    const known = wk.filter(it => it.known).length, bio = wk.filter(it => it.bio).length;
    if (known < 3 || WEEK - known < 3) out.push(`week ${w + 1} (days ${w * WEEK + 1}-${(w + 1) * WEEK}) has ${known} well-known and ${WEEK - known} specialist drugs`);
    if (bio > 2 || (bio === 0 && totalBio >= days.length / WEEK)) out.push(`week ${w + 1} has ${bio} biologics`);
  }
  return out;
}

// ------------------------------------------------------------------ search

// Places `pool` after `prefix` under rule set R. Depth-first, most overdue candidate first; returns the ids or null.
function place(prefix, pool, items, R) {
  const N = prefix.length + pool.length;
  const seq = prefix.map(id => items.get(id));
  const left = new Set(pool);
  const count = { area: new Map(), class: new Map(), sponsor: new Map() };
  for (const id of pool) for (const k of ['area', 'class', 'sponsor']) count[k].set(items.get(id)[k], (count[k].get(items.get(id)[k]) || 0) + 1);
  let knownLeft = pool.filter(id => items.get(id).known).length;
  let bioLeft = pool.filter(id => items.get(id).bio).length;
  const bioTotal = bioLeft + seq.filter(it => it.bio).length;
  const gap = { area: R.areaGap, class: R.classGap, sponsor: R.sponsorGap };
  let nodes = 0;

  const lastPos = (key, value, p) => { for (let i = p - 1; i >= 0; i--) if (seq[i][key] === value) return i; return -Infinity; };
  const lastBio = p => { for (let i = p - 1; i >= 0; i--) if (seq[i].bio) return i; return -Infinity; };
  const inWeek = (p, test) => { let n = 0; for (let i = weekOf(p) * WEEK; i < p; i++) if (test(seq[i])) n++; return n; };
  // How many more drugs passing `test` the remaining days can take when a week holds at most `cap` of them.
  const capacity = (p, test, cap) => {
    let total = 0;
    for (let w = weekOf(p); w * WEEK < N; w++) {
      const start = Math.max(w * WEEK, p), end = Math.min((w + 1) * WEEK, N);
      const used = w === weekOf(p) ? inWeek(p, test) : 0;
      total += Math.max(0, Math.min(end - start, cap - used));
    }
    return total;
  };

  function allowed(it, p) {
    if (p > 0 && R.areaGap > 1 && seq[p - 1].area === it.area) return false;
    if (p - lastPos('class', it.class, p) < R.classGap) return false;
    if (p - lastPos('sponsor', it.sponsor, p) < R.sponsorGap) return false;
    if (it.bio && p - lastBio(p) < R.bioGap) return false;
    if (R.launch && p < LAUNCH_DAYS) {
      if (p === 0 ? (left.has(OPENER) && it.id !== OPENER) : it.fame !== 5) return false;
      for (let i = 0; i < p; i++) if (seq[i].class === it.class) return false;
      const areas = new Set(seq.slice(0, p).map(s => s.area)).add(it.area).size;
      if (areas + (LAUNCH_DAYS - 1 - p) < LAUNCH_AREAS) return false;
    }
    const launchWeek = R.launch && p < LAUNCH_DAYS;
    if (R.fameWeek && !launchWeek && p >= LAUNCH_DAYS) {
      if (inWeek(p, s => s.known === it.known) >= 4) return false;
    }
    if (R.bioWeek && it.bio && inWeek(p, s => s.bio) >= 2) return false;
    return true;
  }

  // After placing `it` at p: can everything that is left still fit?
  function feasible(it, p) {
    const next = p + 1, slots = N - next;
    for (const k of ['area', 'class', 'sponsor']) {
      const r = count[k].get(it[k]);
      if (r > 0 && gap[k] > 1 && next + (gap[k] - 1) + (r - 1) * gap[k] + 1 > N) return false;
    }
    if (R.fameWeek && next >= LAUNCH_DAYS && slots > 0) {
      if (knownLeft > capacity(next, s => s.known, 4)) return false;
      if (left.size - knownLeft > capacity(next, s => !s.known, 4)) return false;
    }
    if (R.bioWeek && slots > 0 && bioLeft > capacity(next, s => s.bio, 2)) return false;
    if (R.bioWeek && next % WEEK === 0 && bioTotal >= N / WEEK && inWeek(next - 1, s => s.bio) + (it.bio ? 1 : 0) === 0) return false;
    return true;
  }

  // Larger is more overdue: days since the group last appeared, over the interval it would have if spread evenly.
  function score(it, p) {
    const slots = N - p;
    const due = (k, floor) => { const r = count[k].get(it[k]); const since = Math.min(p - lastPos(k, it[k], p), slots / r); return since / Math.max(slots / r, floor); };
    let s = due('area', 2) + 0.6 * due('sponsor', 4) + 0.2 * due('class', 11);
    const tier = it.known ? knownLeft : left.size - knownLeft;
    s += 0.6 * (tier / slots);
    if (bioLeft) { const ideal = slots / bioLeft, since = Math.min(p - lastBio(p), ideal * 2); s += it.bio ? 0.8 * (since / ideal - 1) : 0; }
    if (it.fame === 5 && p >= LAUNCH_DAYS && inWeek(p, x => x.fame === 5) > 0) s -= 0.5;
    if (it.fame <= 2 && inWeek(p, x => x.fame <= 2) > 0) s -= 0.5;
    return s + it.tie * 0.05;
  }

  function step(p) {
    if (p === N) return true;
    if (++nodes > NODE_LIMIT) return false;
    const cands = [];
    for (const id of left) { const it = items.get(id); if (allowed(it, p)) cands.push([score(it, p), it]); }
    cands.sort((a, b) => b[0] - a[0] || (a[1].id < b[1].id ? -1 : 1));
    for (const [, it] of cands) {
      left.delete(it.id); seq.push(it);
      for (const k of ['area', 'class', 'sponsor']) count[k].set(it[k], count[k].get(it[k]) - 1);
      if (it.known) knownLeft--; if (it.bio) bioLeft--;
      const ok = feasible(it, p) && step(p + 1);
      if (ok) return true;
      if (it.known) knownLeft++; if (it.bio) bioLeft++;
      for (const k of ['area', 'class', 'sponsor']) count[k].set(it[k], count[k].get(it[k]) + 1);
      seq.pop(); left.add(it.id);
      if (nodes > NODE_LIMIT) return false;
    }
    return false;
  }
  return step(prefix.length) ? seq.map(it => it.id) : null;
}

// ------------------------------------------------------------------ main

const { items, schedule } = await load();
const epoch = schedule?.epoch || DEFAULT_EPOCH;
const existing = Array.isArray(schedule?.days) ? schedule.days : [];
const unknown = existing.filter(id => !items.has(id));
if (unknown.length && !REBUILD) { console.error(`data/schedule.json names ids with no dossier: ${unknown.join(', ')}`); process.exit(1); }

let days, note = 'strict';
if (CHECK) {
  days = existing;
} else {
  const prefix = REBUILD ? [] : existing;
  const pool = [...items.keys()].filter(id => !prefix.includes(id)).sort();
  if (!pool.length) console.log(`nothing to place: all ${items.size} dossiers are scheduled`);
  days = prefix;
  if (pool.length) {
    days = null;
    for (const [label, change] of RELAX) {
      days = place(prefix, pool, items, { ...STRICT, ...change });
      if (days) { note = label; break; }
    }
    if (!days) { console.error('no order found'); process.exit(1); }
    if (days.slice(0, prefix.length).join() !== prefix.join()) throw new Error('existing days changed'); // append-only, always
    const perLine = 5;
    const lines = Array.from({ length: Math.ceil(days.length / perLine) }, (_, i) => '    ' + days.slice(i * perLine, (i + 1) * perLine).map(id => JSON.stringify(id)).join(', '));
    await writeFile(path.join(DATA, 'schedule.json'), `{\n  "epoch": ${JSON.stringify(epoch)},\n  "days": [\n${lines.join(',\n')}\n  ]\n}\n`);
    console.log(`${REBUILD ? 'rebuilt' : 'appended'}: ${prefix.length} day${prefix.length === 1 ? '' : 's'} kept, ${pool.length} placed, ${days.length} in all (${note})`);
  }
}

const dateOf = i => { const d = new Date(`${epoch}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + i); return d.toISOString().slice(0, 10); };
const tally = key => { const m = new Map(); for (const id of days) { const v = key(items.get(id)); m.set(v, (m.get(v) || 0) + 1); } return [...m].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))); };
console.log(`\n${days.length} days from ${epoch} to ${days.length ? dateOf(days.length - 1) : epoch}`);
console.log('\nPer area');
for (const [area, n] of tally(it => it.area)) console.log(`  ${String(n).padStart(3)}  ${area}`);
console.log(`\nSmall molecules ${days.filter(id => !items.get(id).bio).length}, biologics ${days.filter(id => items.get(id).bio).length}; fame ${tally(it => it.fame).sort((a, b) => b[0] - a[0]).map(([f, n]) => `${f}: ${n}`).join(', ')}`);
console.log('\nFirst thirty days');
days.slice(0, 30).forEach((id, i) => { const it = items.get(id); console.log(`  ${String(i + 1).padStart(3)}  ${dateOf(i)}  ${id.padEnd(22)} ${it.area.padEnd(19)} ${it.class.padEnd(29)} ${it.sponsor.padEnd(21)} fame ${it.fame}${it.bio ? '  biologic' : ''}`); });
const bad = violations(days, items, CHECK || REBUILD ? 0 : existing.length);
console.log(bad.length ? `\n${bad.length} rule violation${bad.length === 1 ? '' : 's'}${CHECK || REBUILD ? '' : ' among the days placed in this run'}:\n  ${bad.join('\n  ')}` : '\nEvery rule holds.');
if (CHECK && bad.length) process.exit(1);
