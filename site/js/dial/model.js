// Geometry of the dial, shared by the WebGL renderer, the SVG fallback and the pointer probe.
//
// Time runs clockwise from 12 o'clock, one turn per curve.period hours. Concentration is the
// outward displacement from the base ring: r(t) = R0 + H * C(t) / Cmax. All lengths here are
// fractions of S, half the side of the square the figure is drawn in, with y pointing up.

export const TAU = Math.PI * 2;

export const GEOM = Object.freeze({
  R0: 0.68,       // base ring, zero concentration
  H: 0.27,        // displacement at Cmax
  CENTER: 0.54,   // half-side of the reserved centre square, as a fraction of R0
});

// Line weights and mark sizes in CSS pixels. There are two weights and nothing thinner than a
// pixel, so no line is ever a blend of ink and paper: quiet is the lighter weight, never a tint.
export const STYLE = Object.freeze({
  line: 1,          // ring, ticks, probe ring and the profile ahead of the fill front
  bold: 2,          // the profile behind the fill front
  tickMinor: 3.5,
  tickMajor: 7,
  node: 2.6,        // radius of a sampling time that has been reached
  probe: 8,         // radius of the probe ring
});

export const NODE_MAX = 24;
export const KNOT_ROW = 1024;

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

export function normalised(curve) {
  const cmax = curve.cmax || 1;
  return t => clamp(curve.c(t) / cmax, 0, 1);
}

// The profile as a polyline: knot i sits at (tau_i turns, c_i) with tau_i in ((i-1)/M, i/M], so a
// renderer can find the segments near any angle by index. Knots are pulled onto the instants
// that must stay sharp: the peak, and the dose itself when the profile starts above zero.
export function buildKnots(curve, M) {
  const cn = normalised(curve);
  const laps = curve.span / curve.period;
  const last = Math.max(2, Math.ceil(laps * M - 1e-9));
  const n = last + 1;
  const data = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) data[2 * i] = Math.min(i / M, laps);
  data[2 * last] = laps;
  if (curve.model !== 'bolus' && curve.tmax > 0) {
    const x = (curve.tmax / curve.period) * M;
    const i = Math.ceil(x - 1e-9);
    if (i >= 1 && i < last) data[2 * i] = x / M;
  }
  for (let i = 0; i < n; i++) data[2 * i + 1] = cn(data[2 * i] * curve.period);
  if (cn(0) > 1e-4) {
    // An intravenous bolus: the dose is a radial step from the ring to the curve.
    data[1] = 0;
    data[2] = 0.02 / M;
    data[3] = cn(0);
  }
  return { data, n, M, laps };
}

// Radius of the profile (fraction of S) at lap-time tau, from the true curve.
export function radiusAt(curve, tau) {
  return GEOM.R0 + GEOM.H * normalised(curve)(tau * curve.period);
}

export function polar(tau, radius) {
  const a = TAU * tau;
  return [radius * Math.sin(a), radius * Math.cos(a)];
}

export function buildNodes(curve, times) {
  const cn = normalised(curve);
  return times.slice(0, NODE_MAX).map(t => {
    const tau = t / curve.period;
    const c = cn(t);
    const [x, y] = polar(tau, GEOM.R0 + GEOM.H * c);
    return { t, tau, c, x, y };
  });
}

// Tick marks on the inside of the ring, and the three that carry a label. Labels stand at the
// quarter turns in the unit the period reads in; a 7 or 14 day dial has no whole quarter, so
// there they stand on whole days a third of the way round instead.
const TICKS = {
  6: [12, 3, 'h'], 12: [12, 3, 'h'], 24: [24, 6, 'h'], 48: [12, 3, 'h'],
  96: [12, 3, 'd'], 168: [7, 2, 'd'], 336: [14, 4, 'd'], 672: [28, 7, 'd'],
  1344: [8, 2, 'wk'], 2016: [12, 3, 'wk'], 4032: [24, 6, 'wk'], 8064: [24, 6, 'wk'],
};
const UNIT_H = { h: 1, d: 24, wk: 168 };

export function tickSpec(period) {
  const unit = period <= 48 ? 'h' : period < 1344 ? 'd' : 'wk';
  const [minor, every, u] = TICKS[period] || [12, 3, unit];
  const labels = [1, 2, 3].map(i => {
    const turn = (i * every) / minor;
    return { turn, text: `${+((turn * period) / UNIT_H[u]).toFixed(1)} ${u}` };
  });
  return { minor, every, labels };
}

// Half-life contours: circles at C = Cmax/2, Cmax/4, Cmax/8 ... drawn only under the profile.
// Their radii close in on the ring as a geometric series, and first-order elimination crosses
// one every half-life, so equal ratios show as equal angles. Levels stop before the gap to the
// next one (or to the ring) would fall under CONTOUR_GAP pixels.
export const CONTOUR_MAX = 3;
export const CONTOUR_GAP = 5;

export function contourCount(sCss) {
  let n = 0;
  while (n < CONTOUR_MAX && (GEOM.H * sCss) / 2 ** (n + 1) >= CONTOUR_GAP) n++;
  return n;
}

// Contours are ink. Over the accent fill they stay ink unless ink falls short of 3:1 there
// (a dark accent on light paper, a mid one on dark), in which case they are cut in paper
// when that reads better.
export function contourOnFill({ paper, ink, accent }) {
  const lum = c => toLinear(c).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
  const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  const la = lum(accent);
  const withInk = ratio(lum(ink), la);
  return withInk < 3 && ratio(lum(paper), la) > withInk ? paper : ink;
}

// Where the peak sits on the dial, in turns.
export function peakTurn(curve) {
  const t = curve.model === 'bolus' ? 0 : curve.tmax;
  return (t / curve.period) % 1;
}

// The lap-time at which the rising limb first reaches the fraction c of Cmax.
export function riseTurn(curve, c) {
  if (curve.model === 'bolus' || !(curve.tmax > 0)) return 0;
  const cn = normalised(curve);
  let lo = 0;
  let hi = curve.tmax;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (cn(mid) < c) lo = mid; else hi = mid;
  }
  return hi / curve.period;
}

export const easeInOut = x => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

// sRGB bytes to linear light, for blending in the shader.
export function toLinear(rgb) {
  return rgb.map(v => {
    const x = v / 255;
    return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  });
}
