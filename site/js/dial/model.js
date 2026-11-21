// Geometry of the dial, shared by the WebGL renderer, the SVG fallback and the pointer probe.
//
// Time runs clockwise from 12 o'clock, one turn per curve.period hours. Concentration is the
// outward displacement from the base ring: r(t) = R0 + H * C(t) / Cmax. All lengths here are
// fractions of S, half the side of the square the figure is drawn in, with y pointing up.

export const TAU = Math.PI * 2;

export const GEOM = Object.freeze({
  R0: 0.64,       // base ring, zero concentration
  H: 0.26,        // displacement at Cmax
  CENTER: 0.56,   // half-side of the reserved centre square, as a fraction of R0
});

// Line weights and node sizes in CSS pixels. "Quiet" is always a lighter weight or a smaller
// scale, never a tint.
export const STYLE = Object.freeze({
  ring: 1.0,
  bold: 1.7,        // profile behind the fill front
  fine: 0.8,        // profile ahead of it
  echo: 0.6,        // half-life echoes
  cmax: 0.9,        // Cmax circle, dotted
  cmaxDash: 1.2,
  cmaxPitch: 5,
  tick: 0.8,
  tickMinor: 3.5,
  tickMajor: 7,
  hand: 0.8,
  nodeQuiet: 2.6,   // radius of an unreached node
  nodeFull: 4.2,    // radius of a resolved node
  nodeNow: 1.4,     // extra radius of the node under the hand
  nodeQuietW: 0.8,
  nodeFullW: 1.3,
  nodeDot: 1.3,
  probe: 8,         // radius of the probe ring
  probeW: 0.8,
});

export const NODE_MAX = 24;
export const ECHO_MAX = 6;
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

// Half-life echoes. First-order elimination has one symmetry: wait one half-life and halve the
// scale, and the tail lands on itself. Applying that map to the whole profile gives copies that
// leave the ring one half-life apart, each half the height of the last, and each joins the tail
// of the one before. They are culled once the copy would be under a few pixels tall.
export function echoCount(curve, sCss) {
  const hPx = GEOM.H * sCss;
  let n = 0;
  for (let k = 1; k <= ECHO_MAX; k++) {
    if (k * curve.halfLife >= curve.span) break;
    if (hPx / 2 ** k < 3.5) break;
    n = k;
  }
  return n;
}

// Tick marks on the inside of the ring, and the few that carry a label.
export function tickSpec(period) {
  if (period === 24) return { minor: 24, every: 6, labels: [6, 12, 18] };
  if (period === 168) return { minor: 7, every: 2, labels: [48, 96, 144] };
  if (period === 672) return { minor: 28, every: 7, labels: [168, 336, 504] };
  if (period === 2016) return { minor: 12, every: 3, labels: [504, 1008, 1512] };
  return { minor: 12, every: 3, labels: [period / 4, period / 2, (3 * period) / 4] };
}

// The Cmax label sits in a gap of the Cmax circle on the diagonal where the profile is lowest.
export function cmaxLabelTurn(curve) {
  const cn = normalised(curve);
  const laps = curve.span / curve.period;
  let best = 0.625;
  let bestC = Infinity;
  for (const a of [0.625, 0.375, 0.875, 0.125]) {
    let c = 0;
    for (let l = 0; l + a <= laps + 1e-9; l++) c = Math.max(c, cn((l + a) * curve.period));
    // Leave the neighbourhood of the peak alone as well.
    for (const d of [-0.04, 0.04]) for (let l = 0; l + a + d <= laps; l++) c = Math.max(c, cn((l + a + d) * curve.period));
    if (c < bestC - 1e-6) { bestC = c; best = a; }
  }
  return best;
}

export const easeInOut = x => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
export const easeOut = x => 1 - (1 - x) * (1 - x);

// sRGB bytes to linear light, for blending in the shader.
export function toLinear(rgb) {
  return rgb.map(v => {
    const x = v / 255;
    return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  });
}
