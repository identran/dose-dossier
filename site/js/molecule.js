// Skeletal formula of a small molecule as inline SVG, revealed in five chemist's steps:
// 0 atom positions · 1 bare skeleton · 2 bond orders · 3 heteroatom labels · 4 implicit hydrogens.
//
// renderMolecule(el, structure, { reveal }) draws the schema's `structure` (heavy atoms
// [x, y, element], y up, plus bonds [i, j, order]) inside `el`, fitted to el's inscribed circle.
// An optional fourth atom entry is a formal charge ([x, y, "N", 1]); without any, the obvious
// ones (nitro, N-oxide, quaternary N, sulfonium) are inferred from the valences.

const NS = 'http://www.w3.org/2000/svg';

const STROKE = 1.3;      // px, constant whatever the size of the element (override with --mol-stroke)
const DOUBLE = 0.18;     // double-bond spacing / bond length
const LABEL = 0.6;       // label size / bond length
const SUB = 0.7;         // subscript and charge size / label size
const MAX_BOND = 0.1;    // longest bond / element diameter, so a small molecule is not blown up
const MARGIN = 0.05;     // of the inscribed radius
const MS = 320;          // transition between levels

const CSS = `
.dd-mol{display:block;width:100%;height:100%;overflow:visible}
.dd-mol-dots,.dd-mol-bonds,.dd-mol-sym,.dd-mol-h,.dd-mol-c3{transition:opacity ${MS}ms ease}
@media (prefers-reduced-motion:reduce){.dd-mol-dots,.dd-mol-bonds,.dd-mol-sym,.dd-mol-h,.dd-mol-c3{transition:none}}
.dd-mol[data-reveal="0"] .dd-mol-bonds,
.dd-mol:not([data-reveal="0"]) .dd-mol-dots,
.dd-mol[data-reveal="0"] .dd-mol-sym,.dd-mol[data-reveal="1"] .dd-mol-sym,.dd-mol[data-reveal="2"] .dd-mol-sym,
.dd-mol:not([data-reveal="4"]) .dd-mol-h,
.dd-mol[data-reveal="4"] .dd-mol-c3{opacity:0}
`;

const states = new WeakMap();
const live = new Set(); // WeakRefs of elements holding a drawing, for re-measuring when fonts arrive

export function renderMolecule(el, structure, { reveal = 4 } = {}) {
  if (!el) return false;
  if (!Array.isArray(structure?.atoms) || !structure.atoms.length) {
    clear(el);
    return false;
  }
  const level = Math.max(0, Math.min(4, Math.round(Number(reveal)) || 0));
  let st = states.get(el);
  if (!st) {
    st = { el, cur: null, raf: 0 };
    states.set(el, st);
    live.add(st.ref = new WeakRef(el));
    if (typeof ResizeObserver === 'function') {
      st.ro = new ResizeObserver(() => {
        const { w, h } = sizeOf(el);
        if (st.svg && (Math.abs(w - st.w) >= 0.5 || Math.abs(h - st.h) >= 0.5)) build(st);
      });
      st.ro.observe(el);
    }
  }
  if (st.structure !== structure) {
    const key = JSON.stringify([structure.atoms, structure.bonds]);
    if (key !== st.key) {
      st.key = key;
      st.model = analyse(structure);
      st.lines = null;
    }
    st.structure = structure;
  }
  st.level = level;
  if (!st.lines || !st.svg || st.svg.parentNode !== el) build(st);
  else setLevel(st, true);
  return true;
}

function clear(el) {
  const st = states.get(el);
  if (st) {
    cancelAnimationFrame(st.raf);
    st.ro?.disconnect();
    live.delete(st.ref);
    states.delete(el);
  }
  el.replaceChildren();
}

if (typeof document !== 'undefined' && document.fonts?.addEventListener) {
  document.fonts.addEventListener('loadingdone', () => {
    fonts.clear();
    for (const ref of live) {
      const el = ref.deref();
      const st = el && states.get(el);
      if (st?.svg) build(st);
      else live.delete(ref);
    }
  });
}

/* ---------- chemistry ---------- */

const VALENCE = { B: [3], C: [4], Si: [4], N: [3], P: [3, 5], As: [3, 5], O: [2], S: [2, 4, 6], Se: [2, 4, 6],
  F: [1], Cl: [1], Br: [1], I: [1] };
const GROUP = { B: 13, C: 14, Si: 14, N: 15, P: 15, As: 15, O: 16, S: 16, Se: 16, F: 17, Cl: 17, Br: 17, I: 17 };

// Implicit hydrogens from the standard valences, shifted by the formal charge (N+ 4, O+ 3, O- 1, B- 4, C± 3).
function hydrogens(el, bos, q) {
  const base = VALENCE[el];
  if (!base) return 0;
  const g = GROUP[el];
  const shift = g >= 15 ? q : g === 14 ? -Math.abs(q) : -q;
  for (const v of base) if (v + shift >= bos) return v + shift - bos;
  return 0;
}

function analyse(structure) {
  const atoms = structure.atoms.map(a => ({
    x: Number(a[0]) || 0, y: -(Number(a[1]) || 0), el: String(a[2] || 'C'), q: Math.round(Number(a[3])) || 0, nb: [], bos: 0,
  }));
  const bonds = [];
  const seen = new Set();
  for (const b of structure.bonds || []) {
    const i = b[0], j = b[1];
    if (!atoms[i] || !atoms[j] || i === j || seen.has(i < j ? `${i}-${j}` : `${j}-${i}`)) continue;
    seen.add(i < j ? `${i}-${j}` : `${j}-${i}`);
    const bond = { a: i, b: j, order: b[2] === 2 || b[2] === 3 ? b[2] : 1 };
    bonds.push(bond);
    atoms[i].nb.push({ j, bond });
    atoms[j].nb.push({ j: i, bond });
    atoms[i].bos += bond.order;
    atoms[j].bos += bond.order;
  }
  // Normalise to a median bond length of 1, whatever the source scale.
  const len = bonds.map(b => Math.hypot(atoms[b.a].x - atoms[b.b].x, atoms[b.a].y - atoms[b.b].y)).filter(v => v > 0).sort((p, q) => p - q);
  const unit = len.length ? len[len.length >> 1] : 1;
  for (const a of atoms) { a.x /= unit; a.y /= unit; }

  if (!atoms.some(a => a.q)) inferCharges(atoms);
  for (const a of atoms) {
    a.h = hydrogens(a.el, a.bos, a.q);
    a.label = a.el !== 'C' || a.q !== 0 || a.nb.length === 0;
  }
  for (const b of bonds) b.lines = bondLines(atoms, b);
  return { atoms, bonds };
}

// The schema carries no charges, so recover the ones the valences make unambiguous.
function inferCharges(atoms) {
  for (const a of atoms) {
    if (a.el === 'N' && a.bos === 4) {
      a.q = 1;
      const o = a.nb.find(n => n.bond.order === 1 && atoms[n.j].el === 'O' && atoms[n.j].nb.length === 1 && !atoms[n.j].q);
      if (o) atoms[o.j].q = -1; // nitro, N-oxide
    } else if ((a.el === 'O' && a.bos === 3) || (a.el === 'S' && (a.bos === 3 || a.bos === 5))) a.q = 1;
    else if (a.el === 'B' && a.bos === 4) a.q = -1;
  }
}

// Chordless rings of up to `max` atoms through a bond, as atom-index lists starting at b.b and ending at b.a.
function ringsThrough(atoms, bond, max = 8) {
  const out = [];
  const path = [bond.b];
  const on = new Set(path);
  const walk = i => {
    for (const n of atoms[i].nb) {
      if (n.bond === bond) continue;
      if (n.j === bond.a) { if (path.length >= 2) out.push([...path, bond.a]); continue; }
      if (on.has(n.j) || path.length >= max - 1) continue;
      path.push(n.j); on.add(n.j);
      walk(n.j);
      path.pop(); on.delete(n.j);
    }
  };
  walk(bond.b);
  return out.filter(ring => {
    const set = new Set(ring);
    let inside = 0;
    for (const i of ring) for (const n of atoms[i].nb) if (set.has(n.j)) inside++;
    return inside / 2 === ring.length;
  });
}

// How a bond is drawn: a list of parallel lines, each offset by m double-bond spacings from the
// atom-atom axis and shortened at either end by ca / cb spacings (so an inner line follows the ring).
function bondLines(atoms, b) {
  if (b.order === 1) return [{ m: 0, ca: 0, cb: 0 }];
  if (b.order === 3) return [{ m: 0, ca: 0, cb: 0 }, { m: 1, ca: 0, cb: 0 }, { m: -1, ca: 0, cb: 0 }];
  const A = atoms[b.a], B = atoms[b.b];
  const len = Math.hypot(B.x - A.x, B.y - A.y) || 1;
  const dx = (B.x - A.x) / len, dy = (B.y - A.y) / len, nx = -dy, ny = dx;
  const side = (o, p) => (p.x - o.x) * nx + (p.y - o.y) * ny;
  const cumulated = a => a.nb.length === 2 && a.nb.every(n => n.bond.order === 2);
  const termA = A.nb.length === 1, termB = B.nb.length === 1;
  const hetero = A.el !== 'C' || B.el !== 'C';
  if (cumulated(A) || cumulated(B) || (termA && termB) || ((termA || termB) && hetero)) {
    return [{ m: 0.5, ca: 0, cb: 0 }, { m: -0.5, ca: 0, cb: 0 }];
  }
  // Shortening at an end: the inner line stops on the bisector of the angle to the neighbour on its side.
  const cut = (o, dir, s, only) => {
    let best = null;
    for (const n of o.nb) {
      if (n.bond === b || (only && !only.has(n.j))) continue;
      const p = atoms[n.j];
      if (side(o, p) * s <= 0.05) continue;
      const l = Math.hypot(p.x - o.x, p.y - o.y) || 1;
      const cos = ((p.x - o.x) * dx + (p.y - o.y) * dy) * dir / l;
      if (best === null || cos > best) best = cos;
    }
    if (best === null) return o.nb.length === 1 ? 0.3 : 0.58;
    const half = Math.acos(Math.max(-1, Math.min(1, best))) / 2;
    return Math.max(0, Math.min(1.5, 1 / Math.tan(half)));
  };
  const rings = ringsThrough(atoms, b);
  let s, only = null;
  if (rings.length) {
    // In a fused system the double bond belongs to the ring that looks most aromatic.
    let top = -Infinity, ring = rings[0];
    for (const r of rings) {
      let doubles = 0;
      r.forEach((i, k) => { if (atoms[i].nb.some(n => n.j === r[(k + 1) % r.length] && n.bond.order === 2)) doubles++; });
      const score = doubles * 10 + (r.length === 6 ? 3 : r.length === 5 ? 2 : 1) - r.length * 0.01;
      if (score > top) { top = score; ring = r; }
    }
    const cx = ring.reduce((t, i) => t + atoms[i].x, 0) / ring.length;
    const cy = ring.reduce((t, i) => t + atoms[i].y, 0) / ring.length;
    s = side(A, { x: cx, y: cy }) >= 0 ? 1 : -1;
    only = new Set(ring);
  } else {
    // In a chain the second line goes to the side that carries more substituents.
    let plus = 0, minus = 0;
    for (const o of [A, B]) for (const n of o.nb) {
      if (n.bond === b) continue;
      const v = side(o, atoms[n.j]);
      if (v > 0.05) plus++; else if (v < -0.05) minus++;
    }
    if (plus !== minus) s = plus > minus ? 1 : -1;
    else {
      const gx = atoms.reduce((t, a) => t + a.x, 0) / atoms.length, gy = atoms.reduce((t, a) => t + a.y, 0) / atoms.length;
      s = side(A, { x: gx, y: gy }) >= 0 ? 1 : -1;
    }
  }
  return [{ m: 0, ca: 0, cb: 0 }, { m: s, ca: cut(A, 1, s, only), cb: cut(B, -1, s, only) }];
}

/* ---------- measuring ---------- */

const fonts = new Map();
let canvas;

function fontFor(el) {
  const cs = getComputedStyle(el);
  const family = cs.getPropertyValue('--font-data').trim() || cs.fontFamily || 'serif';
  let f = fonts.get(family);
  if (f) return f;
  let ctx = null;
  try { ctx = (canvas ||= document.createElement('canvas')).getContext('2d'); } catch { ctx = null; }
  const use = () => {
    ctx.font = `400 100px ${family}`;
    if (!ctx.font.includes('100px')) ctx.font = '400 100px serif';
  };
  let cap = 0.68;
  if (ctx) {
    use();
    const asc = ctx.measureText('N').actualBoundingBoxAscent;
    if (asc > 20 && asc < 100) cap = asc / 100;
  }
  const widths = new Map();
  f = {
    cap,
    w(text) {
      let v = widths.get(text);
      if (v === undefined) {
        v = 0.66 * text.length;
        if (ctx) { use(); v = ctx.measureText(text).width / 100 || v; }
        widths.set(text, v);
      }
      return v;
    },
  };
  fonts.set(family, f);
  return f;
}

function sizeOf(el) {
  const cs = getComputedStyle(el);
  let w = el.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
  let h = el.clientHeight - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0);
  if (!(w >= 1)) w = 300;        // not laid out yet; the resize observer redraws when it is
  const auto = !(h >= 1);
  if (auto) h = w;
  return { w, h, auto };
}

/* ---------- geometry ---------- */

const inflate = (r, p) => [r[0] - p, r[1] - p, r[2] + 2 * p, r[3] + 2 * p];
const overlap = (p, q) => p[0] < q[0] + q[2] && q[0] < p[0] + p[2] && p[1] < q[1] + q[3] && q[1] < p[1] + p[3];
const corners = r => [[r[0], r[1]], [r[0] + r[2], r[1]], [r[0], r[1] + r[3]], [r[0] + r[2], r[1] + r[3]]];

// Parameter interval [t0, t1] of the ray o + t·u inside a rectangle, or null.
function rayRect(ox, oy, ux, uy, r) {
  let t0 = -Infinity, t1 = Infinity;
  for (const [o, u, lo, hi] of [[ox, ux, r[0], r[0] + r[2]], [oy, uy, r[1], r[1] + r[3]]]) {
    if (Math.abs(u) < 1e-9) { if (o < lo || o > hi) return null; continue; }
    const a = (lo - o) / u, b = (hi - o) / u;
    t0 = Math.max(t0, Math.min(a, b));
    t1 = Math.min(t1, Math.max(a, b));
  }
  return t0 <= t1 ? [t0, t1] : null;
}

function segmentHits(p, q, r) {
  const t = rayRect(p.x, p.y, q.x - p.x, q.y - p.y, r);
  return !!t && t[0] <= 1 && t[1] >= 0;
}

// Where the ray from (px, py), relative to the centre of an axis-aligned ellipse, leaves it.
function exitEllipse(px, py, ux, uy, a, b) {
  const A = (ux / a) ** 2 + (uy / b) ** 2;
  const B = 2 * (px * ux / (a * a) + py * uy / (b * b));
  const C = (px / a) ** 2 + (py / b) ** 2 - 1;
  const disc = B * B - 4 * A * C;
  return disc <= 0 ? 0 : Math.max(0, (-B + Math.sqrt(disc)) / (2 * A));
}

// Smallest enclosing circle (incremental, with a fixed-seed shuffle so the result is deterministic).
function enclosingCircle(points) {
  const P = points.slice();
  let seed = 12345;
  for (let i = P.length - 1; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const j = seed % (i + 1);
    [P[i], P[j]] = [P[j], P[i]];
  }
  const has = (c, p) => Math.hypot(p[0] - c.x, p[1] - c.y) <= c.r + 1e-7;
  const two = (p, q) => ({ x: (p[0] + q[0]) / 2, y: (p[1] + q[1]) / 2, r: Math.hypot(p[0] - q[0], p[1] - q[1]) / 2 });
  const three = (p, q, s) => {
    const d = 2 * (p[0] * (q[1] - s[1]) + q[0] * (s[1] - p[1]) + s[0] * (p[1] - q[1]));
    if (Math.abs(d) < 1e-12) return [two(p, q), two(p, s), two(q, s)].sort((m, n) => n.r - m.r)[0];
    const pp = p[0] * p[0] + p[1] * p[1], qq = q[0] * q[0] + q[1] * q[1], ss = s[0] * s[0] + s[1] * s[1];
    const x = (pp * (q[1] - s[1]) + qq * (s[1] - p[1]) + ss * (p[1] - q[1])) / d;
    const y = (pp * (s[0] - q[0]) + qq * (p[0] - s[0]) + ss * (q[0] - p[0])) / d;
    return { x, y, r: Math.hypot(p[0] - x, p[1] - y) };
  };
  let c = { x: 0, y: 0, r: -1 };
  for (let i = 0; i < P.length; i++) {
    if (c.r >= 0 && has(c, P[i])) continue;
    c = { x: P[i][0], y: P[i][1], r: 0 };
    for (let j = 0; j < i; j++) {
      if (has(c, P[j])) continue;
      c = two(P[i], P[j]);
      for (let k = 0; k < j; k++) if (!has(c, P[k])) c = three(P[i], P[j], P[k]);
    }
  }
  return c;
}

/* ---------- layout ---------- */

const chargeText = q => (Math.abs(q) > 1 ? Math.abs(q) : '') + (q > 0 ? '+' : '−');

// Positions and label geometry in px for a bond length of k px (before centring).
function place(model, k, font, stroke) {
  const F = Math.max(LABEL * k, Math.min(7, 0.8 * k)); // labels stop shrinking where they would stop being read
  const Fs = SUB * F, ch = font.cap * F, pad = 0.12 * F + stroke / 2, gap = 0.04 * F;
  const s = Math.min(0.3 * k, Math.max(DOUBLE * k, stroke + 1.4));
  const P = model.atoms.map(a => ({ x: a.x * k, y: a.y * k }));
  const labels = [], byAtom = [];
  for (const [i, a] of model.atoms.entries()) {
    if (!a.label) continue;
    const ws = font.w(a.el) * F, { x, y } = P[i];
    const lab = { i, x, y, yb: y + ch / 2, sym: a.el, ws, h: a.h, a: 0.6 * ws + pad, b: 0.6 * ch + pad, box: [x - ws / 2, y - ch / 2, ws, ch] };
    if (a.q) {
      lab.qt = chargeText(a.q);
      lab.wq = font.w(lab.qt) * Fs;
      lab.c3 = lab.c4 = { x: x + ws / 2 + gap, y: y - ch / 2 + 0.45 * Fs };
    }
    labels.push(lab);
    byAtom[i] = lab;
  }
  const chargeBox = (lab, c) => [c.x, c.y - 0.62 * Fs, lab.wq, 0.62 * Fs];

  // Hydrogens go on the free side: the candidate that runs into the fewest bonds and labels,
  // then the one that points furthest away from the atom's own bonds.
  const taken = labels.map(l => l.box);
  for (const lab of labels) {
    if (!lab.h) continue;
    const a = model.atoms[lab.i], { x, y, ws, yb } = lab;
    const wh = font.w('H') * F, wd = lab.h > 1 ? font.w(String(lab.h)) * Fs : 0, wg = wh + wd;
    const tall = ch + (lab.h > 1 ? 0.2 * F : 0), lead = ch + 0.24 * F;
    let fx = 0, fy = 0;
    for (const n of a.nb) {
      const l = Math.hypot(P[n.j].x - x, P[n.j].y - y) || 1;
      fx -= (P[n.j].x - x) / l; fy -= (P[n.j].y - y) / l;
    }
    const fl = Math.hypot(fx, fy);
    if (fl > 0.15) { fx /= fl; fy /= fl; } else { fx = 0; fy = 0; }
    const upright = a.nb.length <= 1 ? 2.5 : 0.3; // an end group reads along the line: OH, HO, NH2, H2N
    const cands = [
      { dir: 'r', x: x + ws / 2 + gap, y: yb, anchor: 'start', box: [x + ws / 2 + gap, y - ch / 2, wg, tall], cost: 1 - fx },
      { dir: 'l', x: x - ws / 2 - gap, y: yb, anchor: 'end', box: [x - ws / 2 - gap - wg, y - ch / 2, wg, tall], cost: 1 + fx + 0.02 },
      { dir: 'd', x: x - wh / 2, y: yb + lead, anchor: 'start', box: [x - wh / 2, yb + lead - ch, wg, tall], cost: 1 - fy + upright },
      { dir: 'u', x: x - wh / 2, y: yb - lead, anchor: 'start', box: [x - wh / 2, yb - lead - ch, wg, tall], cost: 1 + fy + upright + 0.02 },
    ];
    let best = null;
    for (const c of cands) {
      const zone = inflate(c.box, 0.08 * F), near = inflate(c.box, 0.25 * F), around = inflate(c.box, 0.5 * F);
      for (const b of model.bonds) {
        if (segmentHits(P[b.a], P[b.b], zone)) c.cost += 10;
        else if (b.a === lab.i || b.b === lab.i) continue;
        else if (segmentHits(P[b.a], P[b.b], near)) c.cost += 1.5;
        else if (segmentHits(P[b.a], P[b.b], around)) c.cost += 0.5;
      }
      for (const t of taken) if (t !== lab.box && overlap(t, zone)) c.cost += 10;
      if (lab.qt && c.dir !== 'r' && overlap(chargeBox(lab, lab.c3), c.box)) c.cost += 10;
      if (!best || c.cost < best.cost) best = c;
    }
    lab.H = best;
    if (lab.qt && best.dir === 'r') lab.c4 = { x: best.x + wg + gap, y: lab.c3.y }; // NH3+ rather than N+H3
    taken.push(best.box);
  }

  const points = P.map(p => [p.x, p.y]);
  for (const lab of labels) {
    points.push(...corners(lab.box));
    if (lab.H) points.push(...corners(lab.H.box));
    if (lab.qt) points.push(...corners(chargeBox(lab, lab.c3)), ...corners(chargeBox(lab, lab.c4)));
  }
  return { k, F, Fs, pad, s, P, labels, byAtom, points, chargeBox };
}

function layout(model, w, h, font, stroke) {
  const D = Math.min(w, h), R = (D / 2) * (1 - MARGIN) - stroke;
  let k = D * MAX_BOND, L, c;
  for (let i = 0; i < 6; i++) {
    L = place(model, k, font, stroke);
    c = enclosingCircle(L.points);
    if (c.r <= R * 1.002) break;
    k *= (R / c.r) * 0.998;
  }
  L.dx = w / 2 - c.x;
  L.dy = h / 2 - c.y;

  // Every bond line, with how far each end pulls back from its atom's label at levels 3 and 4.
  L.lines = [];
  for (const b of model.bonds) {
    const A = L.P[b.a], B = L.P[b.b];
    const len = Math.hypot(B.x - A.x, B.y - A.y) || 1;
    const ux = (B.x - A.x) / len, uy = (B.y - A.y) / len, nx = -uy, ny = ux;
    const trims = (lab, ox, oy, dx, dy) => {
      if (!lab) return [0, 0];
      const limit = 0.45 * len;
      const past = (t, r) => { const hit = rayRect(ox, oy, dx, dy, inflate(r, L.pad)); return hit && hit[1] > 0 && hit[0] < limit ? Math.max(t, hit[1]) : t; };
      const base = exitEllipse(ox - lab.x, oy - lab.y, dx, dy, lab.a, lab.b);
      let t3 = base, t4 = base;
      if (lab.qt) { t3 = past(t3, L.chargeBox(lab, lab.c3)); t4 = past(t4, L.chargeBox(lab, lab.c4)); }
      if (lab.H) t4 = past(t4, lab.H.box);
      return [Math.min(t3, limit), Math.min(t4, limit)];
    };
    for (const ln of b.lines) {
      const off = ln.m * L.s;
      const [a3, a4] = trims(L.byAtom[b.a], A.x + nx * off, A.y + ny * off, ux, uy);
      const [b3, b4] = trims(L.byAtom[b.b], B.x + nx * off, B.y + ny * off, -ux, -uy);
      L.lines.push({ ax: A.x, ay: A.y, bx: B.x, by: B.y, ux, uy, nx, ny, off, sa: ln.ca * L.s, sb: ln.cb * L.s, a3, a4, b3, b4, max: 0.45 * len });
    }
  }
  return L;
}

/* ---------- drawing ---------- */

function node(name, attrs, parent) {
  const n = document.createElementNS(NS, name);
  for (const key in attrs) n.setAttribute(key, attrs[key]);
  if (parent) parent.appendChild(n);
  return n;
}

const f2 = v => (Math.round(v * 100) / 100).toString();

function build(st) {
  const { el, model } = st;
  cancelAnimationFrame(st.raf);
  const fresh = !st.svg || st.svg.parentNode !== el;
  if (fresh) el.replaceChildren(); // measure the element empty: is its height its own, or ours to give?
  const { w, h, auto } = sizeOf(el);
  st.w = w; st.h = h;
  if (fresh) {
    st.svg ||= node('svg', { class: 'dd-mol', role: 'img', fill: 'none', stroke: 'currentColor', 'stroke-linecap': 'round' });
    st.svg.style.cssText = auto ? 'display:block;width:100%;height:auto;aspect-ratio:1' : 'display:block;width:100%;height:100%';
    el.appendChild(st.svg);
  }
  const svg = st.svg;
  const stroke = parseFloat(getComputedStyle(el).getPropertyValue('--mol-stroke')) || STROKE;
  const L = layout(model, w, h, fontFor(el), stroke);

  const frag = document.createDocumentFragment();
  node('style', {}, frag).textContent = CSS;
  const root = node('g', { transform: `translate(${f2(L.dx)} ${f2(L.dy)})` }, frag);

  const dots = node('g', { class: 'dd-mol-dots', fill: 'currentColor', stroke: 'none' }, root);
  const r = f2(Math.max(1.4, Math.min(3, 0.09 * L.k)));
  for (const p of L.P) node('circle', { cx: f2(p.x), cy: f2(p.y), r }, dots);

  const bonds = node('g', { class: 'dd-mol-bonds', 'stroke-width': stroke }, root);
  for (const ln of L.lines) ln.el = node('line', { 'vector-effect': 'non-scaling-stroke' }, bonds);

  const labels = node('g', {
    class: 'dd-mol-labels', fill: 'currentColor', stroke: 'none', 'font-size': f2(L.F),
    style: 'font-family:var(--font-data);font-weight:400;font-style:normal',
  }, root);
  const text = (parent, str, x, y, anchor, extra) => {
    const t = node('text', { x: f2(x), y: f2(y), 'text-anchor': anchor, ...extra }, parent);
    t.textContent = str;
    return t;
  };
  for (const lab of L.labels) {
    const sym = node('g', { class: 'dd-mol-sym' }, labels);
    text(sym, lab.sym, lab.x, lab.yb, 'middle');
    const moves = lab.qt && lab.c4 !== lab.c3;
    if (lab.qt) text(sym, lab.qt, lab.c3.x, lab.c3.y, 'start', { 'font-size': f2(L.Fs), ...(moves && { class: 'dd-mol-c3' }) });
    if (!lab.H) continue;
    const hyd = node('g', { class: 'dd-mol-h' }, labels);
    const t = text(hyd, 'H', lab.H.x, lab.H.y, lab.H.anchor);
    if (lab.h > 1) node('tspan', { dy: f2(0.2 * L.F), 'font-size': f2(L.Fs) }, t).textContent = String(lab.h);
    if (moves) text(hyd, lab.qt, lab.c4.x, lab.c4.y, 'start', { 'font-size': f2(L.Fs) });
  }

  svg.setAttribute('viewBox', `0 0 ${f2(w)} ${f2(h)}`);
  svg.replaceChildren(frag);
  st.lines = L.lines;
  setLevel(st, false);
}

function setLevel(st, animate) {
  const { svg, level } = st;
  svg.setAttribute('data-reveal', level);
  svg.setAttribute('aria-label', level < 4 ? 'Chemical structure, partly revealed' : 'Chemical structure');
  // u opens the bond orders, v pulls the bonds back from the labels, w from the hydrogens.
  const to = { u: level >= 2 ? 1 : 0, v: level >= 3 ? 1 : 0, w: level >= 4 ? 1 : 0 };
  cancelAnimationFrame(st.raf);
  const still = !animate || !st.cur || document.hidden || matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (still) {
    st.cur = to;
    draw(st);
    return;
  }
  const from = { ...st.cur }, t0 = performance.now();
  const step = now => {
    const p = Math.min(1, (now - t0) / MS), e = p * p * (3 - 2 * p);
    st.cur = { u: from.u + (to.u - from.u) * e, v: from.v + (to.v - from.v) * e, w: from.w + (to.w - from.w) * e };
    draw(st);
    if (p < 1) st.raf = requestAnimationFrame(step);
  };
  st.raf = requestAnimationFrame(step);
}

function draw(st) {
  const { u, v, w } = st.cur;
  for (const ln of st.lines) {
    const off = ln.off * u;
    const ta = Math.min(ln.max, Math.max(ln.sa * u, ln.a3 * v + (ln.a4 - ln.a3) * w));
    const tb = Math.min(ln.max, Math.max(ln.sb * u, ln.b3 * v + (ln.b4 - ln.b3) * w));
    ln.el.setAttribute('x1', f2(ln.ax + ln.nx * off + ln.ux * ta));
    ln.el.setAttribute('y1', f2(ln.ay + ln.ny * off + ln.uy * ta));
    ln.el.setAttribute('x2', f2(ln.bx + ln.nx * off - ln.ux * tb));
    ln.el.setAttribute('y2', f2(ln.by + ln.ny * off - ln.uy * tb));
  }
}
