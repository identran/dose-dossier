// Line schematic of a biologic, the counterpart of the skeletal formula for answers that have no
// small-molecule structure. Resolved in the same five steps:
// 0 domain or residue positions · 1 the outline · 2 chains told apart · 3 the type · 4 the mass.
//
// renderBiologic(el, biologic, { reveal }) draws the schema's `biologic` ({ format, isotype, massKDa })
// inside `el`, composed for el's inscribed circle, in currentColor and the molecule's stroke.
// As there, each level's elements are created when the level is reached, never before.

const NS = 'http://www.w3.org/2000/svg';

const STROKE = 1.3;   // px, as molecule.js (override with --mol-stroke)
const MARGIN = 0.05;  // of the inscribed radius
const SCALE = 0.7;    // one figure unit / slot radius
const RISE = 0.17;    // the figure sits this far above centre, the caption below it
const FONT = 0.115;   // caption size / slot radius
const LINES = [0.67, 0.85]; // caption baselines / slot radius
const MS = 320;

const CSS = `
.dd-bio-in{animation:dd-bio-in ${MS}ms ease both}
.dd-bio-out{animation:dd-bio-in ${MS}ms ease both reverse}
@keyframes dd-bio-in{from{opacity:0}}
@media (prefers-reduced-motion:reduce){.dd-bio-in,.dd-bio-out{animation:none}}
`;

const NAMES = {
  antibody: 'Antibody', bispecific: 'Bispecific antibody', fragment: 'Antibody fragment', 'fc-fusion': 'Fc fusion',
  conjugate: 'Antibody conjugate', peptide: 'Peptide', protein: 'Protein', oligonucleotide: 'Oligonucleotide',
};

const states = new WeakMap();

export function renderBiologic(el, biologic, { reveal = 4 } = {}) {
  if (!el) return false;
  if (!biologic || typeof biologic !== 'object') {
    clear(el);
    return false;
  }
  const level = Math.max(0, Math.min(4, Math.round(Number(reveal)) || 0));
  let st = states.get(el);
  if (!st) {
    st = { el, raf: 0 };
    states.set(el, st);
    if (typeof ResizeObserver === 'function') {
      st.ro = new ResizeObserver(() => {
        const { w, h } = sizeOf(el);
        if (st.svg && (Math.abs(w - st.w) >= 0.5 || Math.abs(h - st.h) >= 0.5)) build(st);
      });
      st.ro.observe(el);
    }
  }
  const key = JSON.stringify([biologic.format, biologic.isotype, biologic.massKDa]);
  if (key !== st.key) {
    st.key = key;
    const format = FIGURES[biologic.format] ? biologic.format : 'protein';
    const mass = Number(biologic.massKDa);
    st.figure = FIGURES[format]();
    st.type = (typeof biologic.isotype === 'string' && biologic.isotype.trim()) || NAMES[format];
    st.mass = mass > 0 ? `${mass >= 100 ? Math.round(mass) : Math.round(mass * 10) / 10} kDa` : '';
    st.items = null;
  }
  st.level = level;
  if (!st.items || !st.svg || st.svg.parentNode !== el || level < st.shown) build(st);
  else show(st, true);
  return true;
}

function clear(el) {
  const st = states.get(el);
  if (st) {
    cancelAnimationFrame(st.raf);
    st.ro?.disconnect();
    states.delete(el);
  }
  el.replaceChildren();
}

/* ---------- figures ----------
   In figure units: origin at the middle of the figure, y down, everything within a radius of about 1.
   A figure is { dots, items }. An item is { level, tag, at(u) }: it enters the drawing at `level`,
   and u runs 0 → 1 as level 2 arrives, so that a second chain opens out of the line it lay on.
   at(u) gives [x1, y1, x2, y2] for a line, [cx, cy, r] for a circle, path commands for a path. */

const GAP = 0.13;                 // between two paired chains
const HALF = GAP / 2;
const SIN = Math.sin((40 * Math.PI) / 180), COS = Math.cos((40 * Math.PI) / 180); // an arm, from the vertical
const HINGE = -0.08, FOOT = 0.82, ARM = 0.95;

// The Fc stem: one line that becomes two heavy chains joined at the hinge.
function stem(fig) {
  for (const side of [-1, 1]) {
    fig.items.push({ level: side < 0 ? 1 : 2, tag: 'line', at: u => [side * HALF * u, HINGE, side * HALF * u, FOOT] });
    for (const f of [0.3, 0.75]) fig.dots.push([side * HALF, HINGE + f * (FOOT - HINGE)]);
  }
  for (const y of [HINGE + 0.08, HINGE + 0.17]) fig.items.push({ level: 2, tag: 'line', at: u => [-HALF * u, y, HALF * u, y] });
}

// An arm on one side of the hinge. `kind`: fab (heavy and light chain), scfv (a shorter hairpin),
// domain (a linker carrying a round, non-antibody domain).
function arm(fig, side, kind) {
  const dx = side * SIN, dy = -COS, nx = side * COS, ny = SIN; // along the arm, and outward from it
  const at = (t, o, u) => [side * HALF * u + dx * t + nx * o, HINGE + dy * t + ny * o];
  if (kind === 'fab') {
    fig.items.push({ level: 1, tag: 'line', at: u => [...at(0, 0, u), ...at(ARM, 0, u)] });
    fig.items.push({ level: 2, tag: 'line', at: u => [...at(0.14 * ARM, GAP * u, u), ...at(ARM, GAP * u, u)] });
    fig.items.push({ level: 2, tag: 'line', at: u => [...at(0.24 * ARM, 0, u), ...at(0.24 * ARM, GAP * u, u)] });
    for (const t of [0.42, 0.82]) fig.dots.push(at(t * ARM, 0, 1), at(t * ARM, GAP, 1));
  } else if (kind === 'scfv') {
    const len = 0.56 * ARM;
    fig.items.push({ level: 1, tag: 'line', at: u => [...at(0, 0, u), ...at(len, 0, u)] });
    fig.items.push({ level: 2, tag: 'path', at: u => [['M', ...at(len, 0, u)], ['A', (GAP * u) / 2, 0, side > 0 ? 1 : 0, ...at(len, GAP * u, u)], ['L', ...at(0.3 * len, GAP * u, u)]] });
    fig.dots.push(at(0.7 * len, 0, 1), at(0.7 * len, GAP, 1));
  } else {
    const link = 0.32, r = 0.23;
    fig.items.push({ level: 1, tag: 'line', at: u => [...at(0, 0, u), ...at(link, 0, u)] });
    fig.items.push({ level: 1, tag: 'circle', at: u => [...at(link + r, 0, u), r] });
    fig.dots.push(at(link + r, 0, 1));
  }
  return at;
}

function antibody(left = 'fab', right = 'fab', payload = false) {
  const fig = { dots: [], items: [] };
  stem(fig);
  const arms = [arm(fig, -1, left), arm(fig, 1, right)];
  if (payload) {
    // Four small marks: a stub and a bead, on the heavy chains below the hinge and inside the arms.
    const mark = (anchor, ex, ey) => {
      fig.items.push({ level: 2, tag: 'line', at: u => { const [x, y] = anchor(u); return [x, y, x + ex * 0.1 * u, y + ey * 0.1 * u]; } });
      fig.items.push({ level: 2, tag: 'circle', at: u => { const [x, y] = anchor(u); return [x + ex * 0.14 * u, y + ey * 0.14 * u, 0.04 * u]; } });
    };
    for (const side of [-1, 1]) {
      mark(u => [side * HALF * u, HINGE + 0.42], side, 0);
      mark(u => arms[side < 0 ? 0 : 1](0.62 * ARM, 0, u), -side * COS, -SIN);
    }
  }
  return fig;
}

function fragment() {
  const fig = { dots: [], items: [] };
  const gap = GAP * 1.2, len = 1.6;
  const at = (t, o) => [SIN * (t - 0.5) * len + COS * o, -COS * (t - 0.5) * len + SIN * o];
  fig.items.push({ level: 1, tag: 'line', at: u => [...at(0, (-gap / 2) * u), ...at(1, (-gap / 2) * u)] });
  fig.items.push({ level: 2, tag: 'line', at: u => [...at(0.07, (gap / 2) * u), ...at(1, (gap / 2) * u)] });
  fig.items.push({ level: 2, tag: 'line', at: u => [...at(0.15, (-gap / 2) * u), ...at(0.15, (gap / 2) * u)] });
  for (const t of [0.36, 0.78]) fig.dots.push(at(t, -gap / 2), at(t, gap / 2));
  return fig;
}

// An S of two equal arcs meeting in the middle: the first runs clockwise into the origin, the
// second leaves it anticlockwise. point(arc, deg, off) is the place at `deg` along that arc's
// circle, `off` to the right of the direction of travel.
function sCurve(R, span, turn) {
  const point = (arc, deg, off = 0) => {
    const a = (deg * Math.PI) / 180, r = R + (arc ? off : -off);
    const x = (arc ? R : -R) + r * Math.cos(a), y = -r * Math.sin(a);
    return [x * Math.cos(turn) - y * Math.sin(turn), x * Math.sin(turn) + y * Math.cos(turn)];
  };
  // Degrees at fraction f of an arc, and the path of the stretch between two fractions.
  const deg = (arc, f) => (arc ? 180 + span * f : span * (1 - f));
  const path = (arc, f0, f1, eat = 0) => {
    const e = arc ? eat : -eat;
    return [['M', ...point(arc, deg(arc, f0) + e)], ['A', R, 0, arc ? 0 : 1, ...point(arc, deg(arc, f1) - e)]];
  };
  return { point, deg, path };
}

// Beads on a line that folds once each way, a residue at every step.
function peptide() {
  const fig = { dots: [], items: [] };
  const R = 0.42, bead = 0.058, steps = 8, span = 215;
  const s = sCurve(R, span, (-24 * Math.PI) / 180);
  const eat = (2 * Math.asin(bead / (2 * R)) * 180) / Math.PI; // the angle a bead's radius takes from a link
  for (const arc of [0, 1]) {
    for (let i = 0; i < steps; i++) fig.items.push({ level: 1, tag: 'path', at: u => s.path(arc, i / steps, (i + 1) / steps, eat * u) });
    for (let i = arc; i <= steps; i++) {
      const p = s.point(arc, s.deg(arc, i / steps));
      fig.dots.push(p);
      fig.items.push({ level: 2, tag: 'circle', at: u => [...p, bead * u] });
    }
  }
  return fig;
}

// A single strand: a backbone with the slightest S in it and a base at every step, all to one side.
function oligonucleotide() {
  const fig = { dots: [], items: [] };
  const R = 1.5, span = 31, per = 7, base = 0.2;
  const s = sCurve(R, span, (62 * Math.PI) / 180);
  for (const arc of [0, 1]) {
    fig.items.push({ level: 1, tag: 'path', at: () => s.path(arc, 0, 1) });
    for (let i = 0; i < per; i++) {
      const d = s.deg(arc, (i + 0.5) / per);
      fig.dots.push(s.point(arc, d));
      fig.items.push({ level: 2, tag: 'line', at: u => [...s.point(arc, d), ...s.point(arc, d, base * u)] });
    }
  }
  return fig;
}

// One chain folded on itself: straight passes joined by half-turns, their lengths fitted to a circle.
function protein() {
  const fig = { dots: [], items: [] };
  const rows = [-0.6, -0.3, 0, 0.3, 0.6];        // the passes, and where each turns into the next
  const turns = [0.42, -0.6, 0.64, -0.58], first = -0.36, last = 0.34;
  const r = 0.15, cos = Math.cos(-0.5), sin = Math.sin(-0.5);
  const rot = (x, y) => [x * cos - y * sin, x * sin + y * cos];
  const cmds = [['M', ...rot(first, rows[0])]], pts = [];
  let x = first;
  rows.forEach((y, k) => {
    const end = k < turns.length ? turns[k] : last, dir = end > x ? 1 : -1;
    for (let i = 0; i <= 20; i++) pts.push(rot(x + ((end - x) * i) / 20, y));
    cmds.push(['L', ...rot(end, y)]);
    if (k < turns.length) {
      for (let i = 1; i < 12; i++) pts.push(rot(end + dir * r * Math.sin((Math.PI * i) / 12), y + r - r * Math.cos((Math.PI * i) / 12)));
      cmds.push(['A', r, 0, dir > 0 ? 1 : 0, ...rot(end, y + 2 * r)]);
    }
    x = end;
  });
  fig.items.push({ level: 1, tag: 'path', at: () => cmds });
  // Residues at equal steps along the chain.
  const len = [0];
  for (let i = 1; i < pts.length; i++) len.push(len[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const n = 30;
  for (let k = 0, i = 0; k < n; k++) {
    const want = (len[len.length - 1] * k) / (n - 1);
    while (i < pts.length - 1 && len[i + 1] < want) i++;
    const f = (want - len[i]) / (len[i + 1] - len[i] || 1), q = pts[Math.min(i + 1, pts.length - 1)];
    fig.dots.push([pts[i][0] + (q[0] - pts[i][0]) * f, pts[i][1] + (q[1] - pts[i][1]) * f]);
  }
  // Level 2: the two ends, and three bridges between neighbouring passes.
  const end = 0.055;
  for (const [ex, ey, dir] of [[first, rows[0], -1], [last, rows[4], 1]]) {
    fig.items.push({ level: 2, tag: 'circle', at: u => [...rot(ex + dir * end * u, ey), end * u] });
  }
  for (const [k, bx] of [[0, 0.06], [2, -0.26], [3, 0.12]]) {
    fig.items.push({ level: 2, tag: 'line', at: u => [...rot(bx, rows[k]), ...rot(bx, rows[k] + (rows[k + 1] - rows[k]) * u)] });
  }
  return fig;
}

const FIGURES = {
  antibody: () => antibody(),
  bispecific: () => antibody('fab', 'scfv'),
  fragment,
  'fc-fusion': () => antibody('domain', 'domain'),
  conjugate: () => antibody('fab', 'fab', true),
  peptide,
  protein,
  oligonucleotide,
};

/* ---------- drawing ---------- */

function node(name, attrs, parent) {
  const n = document.createElementNS(NS, name);
  for (const key in attrs) n.setAttribute(key, attrs[key]);
  if (parent) parent.appendChild(n);
  return n;
}

const f2 = v => (Math.round(v * 100) / 100).toString();

function sizeOf(el) {
  const cs = getComputedStyle(el);
  let w = el.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
  let h = el.clientHeight - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0);
  if (!(w >= 1)) w = 300;        // not laid out yet; the resize observer redraws when it is
  const auto = !(h >= 1);
  if (auto) h = w;
  return { w, h, auto };
}

let canvas;
function textWidth(el, text, size) {
  try {
    const cs = getComputedStyle(el);
    const ctx = (canvas ||= document.createElement('canvas')).getContext('2d');
    ctx.font = `400 ${size}px ${cs.getPropertyValue('--font-data').trim() || cs.fontFamily || 'serif'}`;
    return ctx.measureText(text).width;
  } catch {
    return text.length * size * 0.55;
  }
}

function build(st) {
  const { el } = st;
  cancelAnimationFrame(st.raf);
  const fresh = !st.svg || st.svg.parentNode !== el;
  if (fresh) el.replaceChildren();
  const { w, h, auto } = sizeOf(el);
  st.w = w; st.h = h;
  if (fresh) {
    st.svg ||= node('svg', { class: 'dd-bio', role: 'img', fill: 'none', stroke: 'currentColor', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
    st.svg.style.cssText = auto ? 'display:block;width:100%;height:auto;aspect-ratio:1;overflow:visible' : 'display:block;width:100%;height:100%;overflow:visible';
    el.appendChild(st.svg);
  }
  const stroke = parseFloat(getComputedStyle(el).getPropertyValue('--mol-stroke')) || STROKE;
  const R = (Math.min(w, h) / 2) * (1 - MARGIN) - stroke;
  st.R = R;
  st.k = R * SCALE;
  st.ox = w / 2;
  st.oy = h / 2 - R * RISE;
  st.items = st.figure.items.map(item => ({ ...item, el: null }));

  // The caption shrinks if a long type name would not fit the chord of the circle at its height.
  st.font = R * FONT;
  [st.type, st.mass].forEach((str, i) => {
    if (!str) return;
    const room = 2 * Math.sqrt(1 - (LINES[i] + 0.03) ** 2) * R * 0.94, width = textWidth(el, str, st.font);
    if (width > room) st.font *= room / width;
  });

  const frag = document.createDocumentFragment();
  node('style', {}, frag).textContent = CSS;
  st.root = node('g', { 'aria-hidden': 'true', 'stroke-width': stroke }, frag);
  st.dots = st.lines = st.caption = null;
  st.shown = -1;
  st.u = null;
  st.svg.setAttribute('viewBox', `0 0 ${f2(w)} ${f2(h)}`);
  st.svg.replaceChildren(frag);
  show(st, false);
}

// Bring the drawing to st.level, creating only what that level shows.
function show(st, animate) {
  const { svg, level, root, R } = st;
  svg.setAttribute('data-reveal', level);
  svg.setAttribute('aria-label', level < 4 ? 'Molecule format, partly revealed' : `Molecule format: ${[st.type, st.mass].filter(Boolean).join(', ')}`);
  const moving = animate && st.u !== null && !document.hidden && !matchMedia('(prefers-reduced-motion: reduce)').matches;
  const X = x => st.ox + x * st.k, Y = y => st.oy + y * st.k;

  if (level === 0 && !st.dots) {
    st.dots = node('g', { fill: 'currentColor', stroke: 'none' }, root);
    const r = f2(Math.max(1.4, Math.min(3, 0.019 * R)));
    for (const [x, y] of st.figure.dots) node('circle', { cx: f2(X(x)), cy: f2(Y(y)), r }, st.dots);
  }
  if (level >= 1 && st.dots) {
    const gone = st.dots;
    st.dots = null;
    if (moving) { gone.setAttribute('class', 'dd-bio-out'); setTimeout(() => gone.remove(), MS); } else gone.remove();
  }
  for (const n of [1, 2]) {
    if (level < n || st.shown >= n) continue;
    // The outline fades in; what level 2 adds starts on the outline and opens out of it.
    st.lines ||= node('g', moving ? { class: 'dd-bio-in' } : {}, root);
    for (const item of st.items) if (item.level === n) item.el = node(item.tag, { 'vector-effect': 'non-scaling-stroke' }, st.lines);
  }
  for (const n of [3, 4]) {
    const str = n === 3 ? st.type : st.mass;
    if (level < n || st.shown >= n || !str) continue;
    st.caption ||= node('g', {
      fill: 'currentColor', stroke: 'none', 'font-size': f2(st.font), 'text-anchor': 'middle',
      style: 'font-family:var(--font-data);font-weight:400;font-style:normal',
    }, root);
    node('text', { x: f2(st.ox), y: f2(st.h / 2 + LINES[n - 3] * R), ...(moving && { class: 'dd-bio-in' }) }, st.caption).textContent = str;
  }
  st.shown = level;

  const to = level >= 2 ? 1 : 0;
  cancelAnimationFrame(st.raf);
  if (!moving) {
    st.u = to;
    draw(st);
    return;
  }
  const from = st.u, t0 = performance.now();
  draw(st);
  const step = now => {
    const p = Math.min(1, (now - t0) / MS);
    st.u = from + (to - from) * p * p * (3 - 2 * p);
    draw(st);
    if (p < 1) st.raf = requestAnimationFrame(step);
  };
  st.raf = requestAnimationFrame(step);
}

function draw(st) {
  const X = x => f2(st.ox + x * st.k), Y = y => f2(st.oy + y * st.k), S = v => f2(v * st.k);
  for (const item of st.items) {
    if (!item.el) continue;
    const g = item.at(st.u);
    if (item.tag === 'line') {
      item.el.setAttribute('x1', X(g[0])); item.el.setAttribute('y1', Y(g[1]));
      item.el.setAttribute('x2', X(g[2])); item.el.setAttribute('y2', Y(g[3]));
    } else if (item.tag === 'circle') {
      item.el.setAttribute('cx', X(g[0])); item.el.setAttribute('cy', Y(g[1])); item.el.setAttribute('r', S(g[2]));
    } else {
      item.el.setAttribute('d', g.map(c => (c[0] === 'A' ? `A${S(c[1])} ${S(c[1])} 0 ${c[2]} ${c[3]} ${X(c[4])} ${Y(c[5])}` : `${c[0]}${X(c[1])} ${Y(c[2])}`)).join(''));
    }
  }
}
