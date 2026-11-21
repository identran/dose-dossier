// Flat, single-colour silhouette of a dosage form.
// renderDoseForm(el, pill, form): `pill` is the dossier's optional { shape, color, color2, desc };
// without it the shape follows `form`. The fill is pill.color, or the day's accent.

const NS = 'http://www.w3.org/2000/svg';

// Closed polygon with circular corners, as a path. `r` is one radius or one per vertex.
function rounded(points, r) {
  const n = points.length;
  let d = '';
  for (let i = 0; i < n; i++) {
    const [x, y] = points[i], p = points[(i + n - 1) % n], q = points[(i + 1) % n];
    const ax = p[0] - x, ay = p[1] - y, bx = q[0] - x, by = q[1] - y;
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    const radius = Array.isArray(r) ? r[i] : r;
    const half = Math.acos((ax * bx + ay * by) / (la * lb)) / 2;
    const t = Math.min(radius / Math.tan(half), la / 2, lb / 2);
    const rr = t * Math.tan(half);
    const f = v => Math.round(v * 100) / 100;
    const sweep = ax * by - ay * bx < 0 ? 1 : 0;
    d += `${i ? 'L' : 'M'}${f(x + (ax / la) * t)} ${f(y + (ay / la) * t)}A${f(rr)} ${f(rr)} 0 0 ${sweep} ${f(x + (bx / lb) * t)} ${f(y + (by / lb) * t)}`;
  }
  return d + 'Z';
}

// Each shape is a list of parts in a 100 × 100 box; a part marked `second` takes pill.color2.
const SHAPES = {
  round: () => [{ d: 'M50 11A39 39 0 1 1 50 89A39 39 0 1 1 50 11Z' }],
  oval: () => [{ d: 'M4 50A46 29 0 1 1 96 50A46 29 0 1 1 4 50Z' }],
  oblong: () => [{ d: 'M22 32H78A18 18 0 0 1 78 68H22A18 18 0 0 1 22 32Z' }],
  capsule: () => [
    { d: 'M48.5 31H23A19 19 0 0 0 23 69H48.5Z', turn: -35 },
    { d: 'M51.5 33H79A17 17 0 0 1 79 67H51.5Z', turn: -35, second: true },
  ],
  diamond: () => [{ d: rounded([[50, 15], [96, 50], [50, 85], [4, 50]], [16, 9, 16, 9]) }],
  triangle: () => [{ d: rounded([[50, 9], [94, 84], [6, 84]], 10) }],
  shield: () => [{ d: 'M15 13H85V47C85 70 69 86 50 95C31 86 15 70 15 47Z' }],
  vial: () => [
    { d: 'M34 6H66V20H34Z' },
    { d: 'M40 23H60V30L74 40V94H26V40L40 30Z' },
  ],
  pen: () => [
    { d: 'M5 39H27V61H5A11 11 0 0 1 5 39Z', turn: -40 },
    { d: 'M30 39H90V61H30Z', turn: -40 },
    { d: 'M93 43H104V57H93Z', turn: -40 },
  ],
  inhaler: () => [
    { d: 'M31 5H57V29H31Z' },
    { d: 'M26 32H62V60L92 67L87 94H26Z' },
  ],
  patch: () => [
    { d: 'M10 10H90V62L62 90H10Z' },
    { d: 'M66.5 91.5L91.5 66.5V91.5Z' },
  ],
  drop: () => [{ d: 'M50 5C50 5 19 42 19 63A31 31 0 0 0 81 63C81 42 50 5 50 5Z' }],
};

const ALIAS = { caplet: 'oblong', elliptical: 'oval', ellipse: 'oval', circle: 'round', rhombus: 'diamond',
  ampoule: 'vial', ampule: 'vial', syringe: 'pen', autoinjector: 'pen', injector: 'pen', solution: 'drop', liquid: 'drop' };

const BY_FORM = [
  [/capsule/, 'capsule'],
  [/caplet/, 'oblong'],
  [/tablet|lozenge/, 'round'],
  [/pen|injector|syringe/, 'pen'],
  [/inhal|aerosol|spray|nebuli/, 'inhaler'],
  [/patch|transdermal|film/, 'patch'],
  [/inject|infus|vial|powder|lyophil/, 'vial'],
  [/solution|drop|suspension|syrup|liquid|elixir|gel|cream|ointment|lotion/, 'drop'],
];

export function shapeFor(pill, form) {
  const named = String(pill?.shape || '').toLowerCase().trim();
  if (SHAPES[named]) return named;
  if (ALIAS[named]) return ALIAS[named];
  const f = String(form || '').toLowerCase();
  for (const [re, shape] of BY_FORM) if (re.test(f)) return shape;
  return 'round';
}

export function renderDoseForm(el, pill, form) {
  if (!el) return null;
  const shape = shapeFor(pill, form);
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', pill?.desc || form || shape);
  svg.style.cssText = 'display:block;width:100%;height:100%;fill:var(--accent)';
  for (const part of SHAPES[shape]()) {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', part.d);
    if (part.turn) path.setAttribute('transform', `rotate(${part.turn} 50 50)`);
    // An unparsable colour is ignored by the browser, leaving the accent.
    const color = (part.second && pill?.color2) || pill?.color;
    if (color) path.style.fill = color;
    svg.appendChild(path);
  }
  el.replaceChildren(svg);
  return shape;
}
