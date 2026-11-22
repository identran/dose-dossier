// Pharmacokinetic curve model shared by the figure, the readouts and the build tools.
// A dossier stores label parameters (Tmax, Cmax, terminal half-life); the curve is
// reconstructed from them rather than digitised from a plot.
//
//   absorption  one-compartment, first-order absorption (Bateman). When Tmax is long
//               relative to the half-life (ke * Tmax >= 1) the Bateman form has no
//               solution, so a transit (gamma) form with the same Tmax, Cmax and
//               terminal slope is used instead.
//   bolus       intravenous bolus, mono-exponential decline from Cmax.
//   infusion    constant-rate infusion ending at Tmax, then mono-exponential decline.
//
// The profile runs for five half-lives past the peak, or, where the transit form declines more
// slowly than that, until it has fallen to a twelfth of the peak.

const LN2 = Math.LN2;
// One turn of the dial, chosen as the shortest of these that holds the whole profile.
const PERIODS_H = [6, 12, 24, 48, 96, 168, 336, 672, 1344, 2016, 4032, 8064];
const NICE_SPANS_H = [6, 8, 12, 24, 36, 48, 72, 96, 120, 168, 240, 336, 504, 672, 1008, 1344, 2016, 2688, 4032, 6048, 8064];
const TAIL = 1 / 12; // of the peak: a profile is not cut off above this

function solveKa(ke, tmax) {
  // tmax(ka) = ln(ka / ke) / (ka - ke) falls monotonically from 1/ke toward 0.
  let lo = ke * 1.0001;
  let hi = ke * 1e6;
  for (let i = 0; i < 200; i++) {
    const mid = Math.sqrt(lo * hi);
    const t = Math.log(mid / ke) / (mid - ke);
    if (t > tmax) lo = mid; else hi = mid;
  }
  return Math.sqrt(lo * hi);
}

export function makeCurve(pk) {
  const { tmaxH: tmax, halfLifeH } = pk;
  // Without a label Cmax the profile is relative: it peaks at 1 and has no unit.
  const relative = pk.cmax == null;
  const cmax = relative ? 1 : pk.cmax;
  const model = pk.model || 'absorption';
  const ke = LN2 / halfLifeH;
  let c;

  if (model === 'bolus') {
    c = t => (t < 0 ? 0 : cmax * Math.exp(-ke * t));
  } else if (model === 'infusion') {
    const T = Math.max(tmax, 1e-6);
    const top = 1 - Math.exp(-ke * T);
    c = t => (t <= 0 ? 0 : t <= T ? cmax * (1 - Math.exp(-ke * t)) / top : cmax * Math.exp(-ke * (t - T)));
  } else if (ke * tmax >= 0.98) {
    const n = ke * tmax;
    c = t => (t <= 0 ? 0 : cmax * Math.pow(t / tmax, n) * Math.exp(n - ke * t));
  } else {
    const ka = solveKa(ke, tmax);
    const norm = Math.exp(-ke * tmax) - Math.exp(-ka * tmax);
    c = t => (t <= 0 ? 0 : cmax * (Math.exp(-ke * t) - Math.exp(-ka * t)) / norm);
  }

  // The time after the peak at which the curve has fallen to TAIL of it.
  let low = tmax;
  let high = tmax + 40 * halfLifeH;
  for (let i = 0; i < 60; i++) {
    const mid = (low + high) / 2;
    if (c(mid) > TAIL * cmax) low = mid; else high = mid;
  }
  const span = pk.spanH || NICE_SPANS_H.find(s => s >= Math.max(tmax + 5 * halfLifeH, high)) || NICE_SPANS_H.at(-1);
  const period = pk.periodH || PERIODS_H.find(p => p >= span * 0.95) || PERIODS_H.at(-1);

  // Cumulative AUC on a grid dense near the origin, where the curve moves fastest.
  const N = 2048;
  const ts = new Float64Array(N + 1);
  const cum = new Float64Array(N + 1);
  for (let i = 1; i <= N; i++) {
    const u = i / N;
    ts[i] = span * u * u;
    cum[i] = cum[i - 1] + 0.5 * (c(ts[i]) + c(ts[i - 1])) * (ts[i] - ts[i - 1]);
  }
  const auc = t => {
    if (t <= 0) return 0;
    if (t >= span) return cum[N];
    const x = Math.sqrt(t / span) * N;
    const i = Math.floor(x);
    return cum[i] + (cum[i + 1] - cum[i]) * (x - i);
  };

  return { c, auc, span, period, tmax, cmax, halfLife: halfLifeH, model, relative, unit: relative ? null : pk.unit, aucTotal: cum[N] };
}

// n sampling times: pre-dose, the rise, the peak, then points that spread out along the decline.
export function sampleTimes(curve, n = 8) {
  const { tmax, span, model } = curve;
  const head = model === 'bolus' ? [0] : tmax < span / 60 ? [0, tmax] : [0, tmax / 2, tmax];
  const from = model === 'bolus' ? 0 : tmax;
  const rest = n - head.length;
  const out = head.slice();
  for (let i = 1; i <= rest; i++) out.push(from + (span - from) * Math.pow(i / rest, 1.7));
  return out;
}

export function formatHours(h) {
  if (h === 0) return '0 h';
  if (h < 1) return `${Math.round(h * 60)} min`;
  if (h < 72) return `${+h.toFixed(h < 10 ? 1 : 0)} h`;
  return `${+(h / 24).toFixed(h < 240 ? 1 : 0)} d`;
}
