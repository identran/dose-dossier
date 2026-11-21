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

// Tick marks on the inside of the ring, and the few that carry a label.
export function tickSpec(period) {
  if (period === 24) return { minor: 24, every: 6, labels: [6, 12, 18] };
  if (period === 168) return { minor: 7, every: 2, labels: [48, 96, 144] };
  if (period === 672) return { minor: 28, every: 7, labels: [168, 336, 504] };
  if (period === 2016) return { minor: 12, every: 3, labels: [504, 1008, 1512] };
  return { minor: 12, every: 3, labels: [period / 4, period / 2, (3 * period) / 4] };
}

// Where the peak sits on the dial, in turns: the one place the Cmax label can stand clear of
// every lap of the profile.
export function peakTurn(curve) {
  const t = curve.model === 'bolus' ? 0 : curve.tmax;
  return (t / curve.period) % 1;
}

export const easeInOut = x => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

// sRGB bytes to linear light, for blending in the shader.
export function toLinear(rgb) {
  return rgb.map(v => {
    const x = v / 255;
    return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  });
}
