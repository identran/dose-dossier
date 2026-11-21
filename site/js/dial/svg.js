// SVG fallback: the same ring, profile, fill and sampling dots, for browsers without WebGL2
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
  function along(from, to) {
    const cn = normalised(scene.curve);
    const at = tau => xy(tau, GEOM.R0 + GEOM.H * cn(tau * scene.curve.period));
    const out = [at(from)];
    if (from === 0 && cn(0) > 1e-4) out.unshift(xy(0, GEOM.R0));   // the dose step of a bolus
    for (let i = 0; i < knots.n; i++) {
      const tau = knots.data[2 * i];
      if (tau > from && tau < to) out.push(xy(tau, GEOM.R0 + GEOM.H * knots.data[2 * i + 1]));
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
    const cx = box.w / 2;
    const cy = box.h / 2;
    svg.setAttribute('viewBox', `0 0 ${box.w} ${box.h}`);
    svg.replaceChildren();
    const line = (w, extra = {}) => ({ fill: 'none', stroke: ink, 'stroke-width': w, ...extra });
    const dot = () => make('circle', { fill: ink, stroke: 'none' });

    const fill = make('path', { fill: rgb(colors.accent), stroke: 'none' });

    let ticks = '';
    for (let i = 0; i < scene.tick.minor; i++) {
      const len = (i % scene.tick.every === 0 ? STYLE.tickMajor : STYLE.tickMinor) / box.s;
      ticks += `M${xy(i / scene.tick.minor, GEOM.R0)}L${xy(i / scene.tick.minor, GEOM.R0 - len)}`;
    }

    const ring = make('circle', { cx, cy, r: GEOM.R0 * box.s, ...line(STYLE.line) });
    const fine = make('path', { d: `M${along(0, knots.laps).join('L')}`, ...line(STYLE.line, { 'stroke-linejoin': 'round' }) });
    const bold = make('path', line(STYLE.bold, { 'stroke-linejoin': 'round' }));
    const dots = nodes.map(dot);
    const probe = { ring: make('circle', { r: STYLE.probe, ...line(STYLE.line) }), dot: make('circle', { r: STYLE.node, fill: ink, stroke: 'none' }) };

    svg.append(fill, make('path', { d: ticks, ...line(STYLE.line) }), ring, fine, bold, ...dots, probe.ring, probe.dot);
    parts = { fill, bold, dots, probe };
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
      const px = (x, y) => [box.w / 2 + box.s * x, box.h / 2 - box.s * y];
      nodes.forEach((n, i) => {
        const [x, y] = px(n.x, n.y);
        const dot = parts.dots[i];
        dot.setAttribute('cx', x);
        dot.setAttribute('cy', y);
        dot.setAttribute('r', STYLE.node * frame.resolve[i]);
      });
      const p = frame.probe;
      for (const el of [parts.probe.ring, parts.probe.dot]) {
        el.setAttribute('visibility', p ? 'visible' : 'hidden');
        if (!p) continue;
        const [x, y] = px(p.x, p.y);
        el.setAttribute('cx', x);
        el.setAttribute('cy', y);
      }
      return true;
    },

    destroy() { svg.remove(); },
  };
}
