// Flat silhouette of a dosage form in the day's one colour.
// renderDoseForm(el, pill, form): `pill` is the dossier's optional { shape, color, desc }; without
// it the shape follows `form`. The fill is pill.color, or the day's accent. A second colour in the
// data (a two-tone capsule) is not drawn: the palette has one accent, and the gap between the
// halves already says capsule. Corners are sharp or true arcs, never eased.

const NS = 'http://www.w3.org/2000/svg';

// Each shape is a list of parts in a 100 × 100 box.
const SHAPES = {
  round: () => [{ d: 'M50 11A39 39 0 1 1 50 89A39 39 0 1 1 50 11Z' }],
  oval: () => [{ d: 'M4 50A46 29 0 1 1 96 50A46 29 0 1 1 4 50Z' }],
  oblong: () => [{ d: 'M22 32H78A18 18 0 0 1 78 68H22A18 18 0 0 1 22 32Z' }],
  capsule: () => [
    { d: 'M48.5 31H23A19 19 0 0 0 23 69H48.5Z', turn: -35 },
    { d: 'M51.5 33H79A17 17 0 0 1 79 67H51.5Z', turn: -35 },
  ],
  diamond: () => [{ d: 'M50 15L96 50L50 85L4 50Z' }],
  triangle: () => [{ d: 'M50 9L94 84H6Z' }],
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
    if (pill?.color) path.style.fill = pill.color;
    svg.appendChild(path);
  }
  el.replaceChildren(svg);
  return shape;
}
