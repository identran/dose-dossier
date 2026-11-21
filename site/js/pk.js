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

const LN2 = Math.LN2;
const PERIODS_H = [24, 168, 672, 2016];
const NICE_SPANS_H = [6, 8, 12, 24, 36, 48, 72, 96, 120, 168, 240, 336, 504, 672, 1008, 1344, 2016, 2688, 4032];

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
  const { tmaxH: tmax, cmax, halfLifeH } = pk;
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

  const span = pk.spanH || NICE_SPANS_H.find(s => s >= tmax + 5 * halfLifeH) || NICE_SPANS_H.at(-1);
  const period = pk.periodH || PERIODS_H.find(p => span / p <= 3) || PERIODS_H.at(-1);

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

  return { c, auc, span, period, tmax, cmax, halfLife: halfLifeH, model, unit: pk.unit, aucTotal: cum[N] };
}

// n sampling times: pre-dose, two on the rise, the peak, then geometric spacing out to the span.
export function sampleTimes(curve, n = 11) {
  const { tmax, span, model } = curve;
  const head = model === 'bolus' ? [0] : [0, tmax / 4, tmax / 2, tmax];
  const start = model === 'bolus' ? span / 200 : tmax;
  const rest = n - head.length;
  const out = head.slice();
  for (let i = 1; i <= rest; i++) out.push(start * Math.pow(span / start, i / rest));
  return out;
}

export function formatHours(h) {
  if (h === 0) return '0 h';
  if (h < 1) return `${Math.round(h * 60)} min`;
  if (h < 72) return `${+h.toFixed(h < 10 ? 1 : 0)} h`;
  return `${+(h / 24).toFixed(h < 240 ? 1 : 0)} d`;
}
