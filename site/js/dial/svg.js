// SVG fallback: the same ring, profile, fill, echoes and nodes, for browsers without WebGL2
// or after a context that stays lost. Same interface as the WebGL renderer.

import { GEOM, STYLE, TAU, buildKnots, normalised } from './model.js';

const NS = 'http://www.w3.org/2000/svg';
const KNOTS_PER_TURN = 480;

const make = (name, attrs = {}) => {
  const node = document.createElementNS(NS, name);
  for (const k in attrs) node.setAttribute(k, attrs[k]);
  return node;
};
const rgb = c => `rgb(${c[0]},${c[1]},${c[2]})`;

export function createSVGRenderer() {
  const svg = make('svg', { class: 'dial-canvas', 'aria-hidden': 'true', focusable: 'false' });
  let scene = null;
  let knots = null;
  let knotsFor = null;
  let box = { w: 0, h: 0, s: 0 };
  let stale = true;
  let parts = null;

  const xy = (tau, radius) => {
    const a = TAU * tau;
    const x = box.w / 2 + box.s * radius * Math.sin(a);
    const y = box.h / 2 - box.s * radius * Math.cos(a);
    return `${x.toFixed(2)} ${y.toFixed(2)}`;
  };

  // Points of the profile between two lap-times, with exact end points.
  function along(from, to, shift = 0, gain = 1) {
    const cn = normalised(scene.curve);
    const at = tau => xy(tau + shift, GEOM.R0 + GEOM.H * gain * cn(tau * scene.curve.period));
    const out = [at(from)];
    if (from === 0 && cn(0) > 1e-4) out.unshift(xy(shift, GEOM.R0));   // the dose step of a bolus
    for (let i = 0; i < knots.n; i++) {
      const tau = knots.data[2 * i];
      if (tau > from && tau < to) out.push(xy(tau + shift, GEOM.R0 + GEOM.H * gain * knots.data[2 * i + 1]));
    }
    out.push(at(to));
    return out;
  }

  function fillPath(front) {
    let d = '';
    for (let l = 0; l < front && l < knots.laps; l++) {
      const to = Math.min(l + 1, front, knots.laps);
      if (to - l < 1e-6) break;
      const back = [];
      for (let tau = to; tau > l; tau -= 1 / 120) back.push(xy(tau, GEOM.R0));
      back.push(xy(l, GEOM.R0));
      d += `M${along(l, to).concat(back).join('L')}Z`;
    }
    return d;
  }

  function build() {
    const { curve, colors, nodes } = scene;
    if (!knotsFor || knotsFor !== curve) {
      knots = buildKnots(curve, KNOTS_PER_TURN);
      knotsFor = curve;
    }
    const ink = rgb(colors.ink);
    const paper = rgb(colors.paper);
    const cx = box.w / 2;
    const cy = box.h / 2;
    svg.setAttribute('viewBox', `0 0 ${box.w} ${box.h}`);
    svg.replaceChildren();
    const line = (w, extra = {}) => ({ fill: 'none', stroke: ink, 'stroke-width': w, ...extra });

    const fill = make('path', { fill: rgb(colors.accent), stroke: 'none' });

    let echoes = '';
    const half = curve.halfLife / curve.period;
    for (let k = 1; k <= scene.echoN; k++) {
      const end = knots.laps - k * half;
      if (end > 0) echoes += `M${along(0, end, k * half, 1 / 2 ** k).join('L')}`;
    }

    const rc = GEOM.R0 + GEOM.H;
    const { turn, half: gap } = scene.gap;
    const around = TAU * rc * box.s;
    const pitch = around / Math.round(around / STYLE.cmaxPitch);
    const dotted = line(STYLE.cmax, { 'stroke-dasharray': `${STYLE.cmaxDash} ${(pitch - STYLE.cmaxDash).toFixed(3)}` });
    const cmax = gap > 0
      ? make('path', { d: `M${xy(turn + gap, rc)}A${rc * box.s} ${rc * box.s} 0 1 1 ${xy(turn - gap, rc)}`, ...dotted })
      : make('circle', { cx, cy, r: rc * box.s, ...dotted });

    let ticks = '';
    for (let i = 0; i < scene.tick.minor; i++) {
      const len = (i % scene.tick.every === 0 ? STYLE.tickMajor : STYLE.tickMinor) / box.s;
      ticks += `M${xy(i / scene.tick.minor, GEOM.R0)}L${xy(i / scene.tick.minor, GEOM.R0 - len)}`;
    }

    const hand = make('path', line(STYLE.hand));
    const ring = make('circle', { cx, cy, r: GEOM.R0 * box.s, ...line(STYLE.ring) });
    const fine = make('path', { d: `M${along(0, knots.laps).join('L')}`, ...line(STYLE.fine, { 'stroke-linejoin': 'round' }) });
    const bold = make('path', line(STYLE.bold, { 'stroke-linejoin': 'round' }));
    const dots = nodes.map(() => ({
      ring: make('circle', { fill: paper, stroke: ink }),
      dot: make('circle', { fill: ink, stroke: 'none' }),
    }));
    const probe = { ring: make('circle', line(STYLE.probeW)), dot: make('circle', { fill: ink, stroke: paper, 'stroke-width': 1.4, r: 2.5 }) };

    svg.append(
      fill,
      make('path', { d: echoes, ...line(STYLE.echo) }),
      cmax,
      make('path', { d: ticks, ...line(STYLE.tick) }),
      hand, ring, fine, bold,
      ...dots.flatMap(n => [n.ring, n.dot]),
      probe.ring, probe.dot,
    );
    parts = { fill, hand, bold, dots, probe };
    stale = false;
  }

  return {
    kind: 'svg',
    el: svg,

    resize(wCss, hCss, sCss) {
      if (box.w !== wCss || box.h !== hCss || box.s !== sCss) {
        box = { w: wCss, h: hCss, s: sCss };
        stale = true;
      }
      return 1;
    },

    setScene(next) {
      scene = next;
      stale = true;
    },

    draw(frame) {
      if (!scene || !box.s) return false;
      if (stale) build();
      const { curve, nodes } = scene;
      const front = Math.min(frame.front / curve.period, knots.laps);
      parts.fill.setAttribute('d', fillPath(front));
      parts.bold.setAttribute('d', front > 0 ? `M${along(0, front).join('L')}` : '');
      parts.hand.setAttribute('d', frame.hand > 0 ? `M${xy(front, GEOM.R0)}L${xy(front, GEOM.R0 + GEOM.H)}` : '');
      const px = (x, y) => [box.w / 2 + box.s * x, box.h / 2 - box.s * y];
      nodes.forEach((n, i) => {
        const res = frame.resolve[i];
        const [x, y] = px(n.x, n.y);
        const { ring, dot } = parts.dots[i];
        ring.setAttribute('cx', x);
        ring.setAttribute('cy', y);
        ring.setAttribute('r', STYLE.nodeQuiet + (STYLE.nodeFull - STYLE.nodeQuiet) * res + STYLE.nodeNow * frame.emphasis[i]);
        ring.setAttribute('stroke-width', STYLE.nodeQuietW + (STYLE.nodeFullW - STYLE.nodeQuietW) * res);
        dot.setAttribute('cx', x);
        dot.setAttribute('cy', y);
        dot.setAttribute('r', STYLE.nodeDot * res);
      });
      const p = frame.probe;
      parts.probe.ring.setAttribute('visibility', p ? 'visible' : 'hidden');
      parts.probe.dot.setAttribute('visibility', p && !p.snapped ? 'visible' : 'hidden');
      if (p) {
        const [x, y] = px(p.x, p.y);
        for (const el of [parts.probe.ring, parts.probe.dot]) {
          el.setAttribute('cx', x);
          el.setAttribute('cy', y);
        }
        parts.probe.ring.setAttribute('r', STYLE.probe);
      }
      return true;
    },

    destroy() { svg.remove(); },
  };
}
