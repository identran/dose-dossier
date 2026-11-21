// The dial: a drug's concentration–time profile wound clockwise round a ring.
//
//   const dial = createDial(containerEl, { onProbe });
//   dial.center                              element over the ring's interior
//   dial.setChallenge({ curve, times, accent, seed })
//   dial.setProgress(k, { animate })         1..times.length
//   dial.setSolved(bool)
//   dial.setTheme('light' | 'dark')
//   dial.resize()
//   dial.destroy()
//
// Nothing here runs a permanent animation loop: a frame is drawn when something changed, and
// the only motion is the fill front sweeping to the next sampling time.

import { formatHours } from '../pk.js';
import {
  GEOM, STYLE, TAU, NODE_MAX,
  buildNodes, echoCount, tickSpec, cmaxLabelTurn, radiusAt, polar, easeInOut,
} from './model.js';
import { createGLRenderer } from './gl.js';
import { createSVGRenderer } from './svg.js';

const SWEEP_MS = 600;
const SETTLE_MS = 70;       // time constant of a node resolving
const REACH_MOUSE = 12;     // CSS px within which the probe snaps to a node
const REACH_TOUCH = 22;
const BAND = 12;            // CSS px either side of the profile band that still counts as over it

const FALLBACK = {
  light: { paper: '#ECEAE5', ink: '#111111', mute: '#6B6A66' },
  dark: { paper: '#0D0D0D', ink: '#DEDCD6', mute: '#8F8E8A' },
};

const CSS = `
.dial-root{position:relative;width:100%;aspect-ratio:1/1;touch-action:manipulation;-webkit-tap-highlight-color:transparent;outline:none}
.dial-canvas{position:absolute;inset:0;width:100%;height:100%;display:block}
.dial-labels{position:absolute;inset:0;pointer-events:none;font-family:var(--font-data,Georgia,'Times New Roman',serif);font-size:var(--size-s,0.8rem);line-height:1;font-variant-numeric:lining-nums;color:var(--mute,#6B6A66)}
.dial-label{position:absolute;transform:translate(-50%,-50%);white-space:nowrap;pointer-events:auto;-webkit-user-select:text;user-select:text}
.dial-label sub{font-size:0.8em;line-height:0}
.dial-center{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%)}
`;

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

function ensureStyles() {
  if (document.querySelector('style[data-dial]')) return;
  const style = document.createElement('style');
  style.dataset.dial = '';
  style.textContent = CSS;
  document.head.append(style);
}

// Resolves any CSS colour expression, custom properties included, to sRGB bytes.
function colorReader(host) {
  const probe = document.createElement('i');
  probe.hidden = true;
  host.append(probe);
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  return expr => {
    probe.style.color = '';
    probe.style.color = expr;
    const computed = getComputedStyle(probe).color;
    if (ctx) {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = '#000';
      ctx.fillStyle = computed;
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2]];
    }
    const m = computed.match(/[\d.]+/g) || [0, 0, 0];
    return [0, 1, 2].map(i => Math.round(+m[i] || 0));
  };
}

export function createDial(container, { onProbe, renderer: wanted } = {}) {
  ensureStyles();
  const root = document.createElement('div');
  root.className = 'dial-root';
  root.tabIndex = 0;
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', 'Concentration over time');
  const labels = document.createElement('div');
  labels.className = 'dial-labels';
  const center = document.createElement('div');
  center.className = 'dial-center';
  root.append(labels, center);
  container.append(root);

  const readColor = colorReader(root);
  const listeners = new AbortController();
  const on = (target, type, fn, extra = {}) => target.addEventListener(type, fn, { signal: listeners.signal, ...extra });
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const darkScheme = matchMedia('(prefers-color-scheme: dark)');

  let renderer = null;
  let box = { w: 0, h: 0, s: 0 };
  let scene = null;
  let challenge = null;        // { curve, times, accent, seed }
  let nodes = [];
  let progress = 1;
  let solved = false;
  let theme = null;
  let front = 0;               // hours
  let sweep = null;            // { from, to, t0 }
  let resolve = [];
  let emphasis = [];
  let probe = null;            // { t, index, x, y, snapped }
  let latched = false;         // a touch probe stays until the next touch elsewhere
  let raf = 0;
  let lastTick = 0;
  let drawn = false;
  let dead = false;
  let tickLabels = [];
  let cmaxLabel = null;
  let gap = { turn: 0.625, half: 0 };

  const forceSVG = wanted === 'svg' || new URLSearchParams(location.search).get('dial') === 'svg';

  function mount(next) {
    renderer?.destroy();
    renderer = next;
    root.prepend(renderer.el);
    root.dataset.renderer = renderer.kind;
    if (scene) renderer.setScene(scene);
    layout();
  }

  function useSVG() {
    if (dead || renderer?.kind === 'svg') return;
    mount(createSVGRenderer());
    invalidate();
  }

  // ---- colours ------------------------------------------------------------------------------

  function colors() {
    const explicit = document.documentElement.dataset.theme;
    const name = theme || (explicit === 'dark' || explicit === 'light' ? explicit : darkScheme.matches ? 'dark' : 'light');
    const base = FALLBACK[name];
    return {
      paper: readColor(`var(--paper, ${base.paper})`),
      ink: readColor(`var(--ink, ${base.ink})`),
      accent: readColor(challenge?.accent || `var(--accent, var(--mute, ${base.mute}))`),
    };
  }

  function recolor() {
    if (!scene) return;
    scene.colors = colors();
    renderer.setScene(scene);
    invalidate();
  }

  // ---- layout and labels --------------------------------------------------------------------

  function buildLabels() {
    labels.replaceChildren();
    tickLabels = [];
    cmaxLabel = null;
    if (!challenge) return;
    const { period } = challenge.curve;
    for (const h of tickSpec(period).labels) {
      const el = document.createElement('span');
      el.className = 'dial-label';
      // Day-scale dials stay in days throughout (formatHours switches unit at 72 h).
      el.textContent = period > 24 && h < 72 ? `${+(h / 24).toFixed(1)} d` : formatHours(h);
      labels.append(el);
      tickLabels.push({ el, turn: h / period });
    }
    cmaxLabel = document.createElement('span');
    cmaxLabel.className = 'dial-label';
    cmaxLabel.innerHTML = 'C<sub>max</sub>';
    labels.append(cmaxLabel);
  }

  function placeLabels() {
    if (!challenge || !box.s) return;
    const cx = box.w / 2;
    const cy = box.h / 2;
    const put = (el, turn, radius) => {
      el.style.left = `${cx + radius * Math.sin(TAU * turn)}px`;
      el.style.top = `${cy - radius * Math.cos(TAU * turn)}px`;
    };
    for (const { el, turn } of tickLabels) {
      const a = TAU * turn;
      const extent = (Math.abs(Math.sin(a)) * el.offsetWidth + Math.abs(Math.cos(a)) * el.offsetHeight) / 2;
      put(el, turn, GEOM.R0 * box.s - STYLE.tickMajor - 5 - extent);
    }
    const turn = cmaxLabelTurn(challenge.curve);
    const a = TAU * turn;
    const radius = (GEOM.R0 + GEOM.H) * box.s;
    const along = (Math.abs(Math.cos(a)) * cmaxLabel.offsetWidth + Math.abs(Math.sin(a)) * cmaxLabel.offsetHeight) / 2 + 5;
    put(cmaxLabel, turn, radius);
    gap = { turn, half: along / (TAU * radius) };
  }

  function layout() {
    const rect = root.getBoundingClientRect();
    if (!rect.width || !rect.height || !renderer) return;
    box = { w: rect.width, h: rect.height, s: Math.min(rect.width, rect.height) / 2 };
    renderer.resize(box.w, box.h, box.s);
    const side = 2 * GEOM.CENTER * GEOM.R0 * box.s;
    center.style.width = center.style.height = `${side}px`;
    placeLabels();
    if (scene) {
      scene.echoN = echoCount(scene.curve, box.s);
      scene.gap = gap;
      renderer.setScene(scene);
    }
    invalidate();
  }

  // ---- state and animation ------------------------------------------------------------------

  const reached = () => (solved ? nodes.length : clamp(progress, 0, nodes.length));
  const frontTarget = () => {
    if (!challenge) return 0;
    return solved ? challenge.curve.span : nodes[clamp(progress, 1, nodes.length) - 1]?.t ?? 0;
  };
  const still = () => !drawn || reducedMotion.matches || document.hidden;

  function retarget(animate) {
    if (!challenge) return;
    const to = frontTarget();
    if (animate && !still() && to !== front) {
      sweep = { from: front, to, t0: performance.now() };
    } else {
      sweep = null;
      front = to;
      settle();
    }
    invalidate();
  }

  function nodeTargets(arriving) {
    const count = reached();
    return nodes.map((n, i) => {
      const passed = front >= n.t - 1e-9 || (arriving && i === count - 1);
      const res = i < count && (!sweep || passed) ? 1 : 0;
      return [res, res && !solved && i === count - 1 ? 1 : 0];
    });
  }

  function settle() {
    nodeTargets(true).forEach(([res, emp], i) => { resolve[i] = res; emphasis[i] = emp; });
  }

  function step(now) {
    const dt = lastTick ? Math.min(100, now - lastTick) : 16;
    lastTick = now;
    let busy = false;
    let arriving = !sweep;
    if (sweep) {
      const u = clamp((now - sweep.t0) / SWEEP_MS, 0, 1);
      front = sweep.from + (sweep.to - sweep.from) * easeInOut(u);
      arriving = u > 0.72;
      if (u >= 1) { front = sweep.to; sweep = null; } else busy = true;
    }
    const k = 1 - Math.exp(-dt / SETTLE_MS);
    nodeTargets(arriving).forEach(([res, emp], i) => {
      resolve[i] += (res - resolve[i]) * k;
      emphasis[i] += (emp - emphasis[i]) * k;
      if (Math.abs(res - resolve[i]) < 0.01) resolve[i] = res; else busy = true;
      if (Math.abs(emp - emphasis[i]) < 0.01) emphasis[i] = emp; else busy = true;
    });
    return busy;
  }

  function tick(now) {
    raf = 0;
    if (dead || !scene || !box.s) return;
    const busy = still() ? (sweep = null, front = frontTarget(), settle(), false) : step(now);
    const ok = renderer.draw({
      front,
      resolve,
      emphasis,
      hand: solved && !sweep ? 0 : 1,
      probe: probe && { x: probe.x, y: probe.y, snapped: probe.index >= 0 },
    });
    if (ok) drawn = true;
    if (busy) invalidate(); else lastTick = 0;
  }

  function invalidate() {
    if (!raf && !dead && !document.hidden) raf = requestAnimationFrame(tick);
  }

  // ---- probe --------------------------------------------------------------------------------

  function emit(next) {
    const same = (!next && !probe) || (next && probe && next.t === probe.t && next.index === probe.index);
    probe = next;
    if (same) return;
    invalidate();
    if (!onProbe) return;
    const { curve } = challenge;
    onProbe(next ? { t: next.t, c: curve.c(next.t), auc: curve.auc(next.t), index: next.index } : null);
  }

  const atNode = i => ({ t: nodes[i].t, index: i, x: nodes[i].x, y: nodes[i].y });

  function locate(clientX, clientY, reach) {
    if (!challenge || !box.s) return null;
    const rect = root.getBoundingClientRect();
    const x = (clientX - rect.left - rect.width / 2) / box.s;
    const y = -(clientY - rect.top - rect.height / 2) / box.s;
    let best = -1;
    let bestD = reach / box.s;
    nodes.forEach((n, i) => {
      const d = Math.hypot(x - n.x, y - n.y);
      if (d <= bestD) { bestD = d; best = i; }
    });
    if (best >= 0) return atNode(best);

    const r = Math.hypot(x, y);
    const pad = BAND / box.s;
    if (r < GEOM.R0 - pad || r > GEOM.R0 + GEOM.H + pad) return null;
    const { curve } = challenge;
    const turn = (Math.atan2(x, y) / TAU + 1) % 1;
    let tau = -1;
    let miss = Infinity;
    for (let l = 0; (l + turn) * curve.period <= curve.span; l++) {
      const d = Math.abs(radiusAt(curve, l + turn) - r);
      if (d < miss) { miss = d; tau = l + turn; }
    }
    if (tau < 0) return null;
    const [px, py] = polar(tau, radiusAt(curve, tau));
    return { t: tau * curve.period, index: -1, x: px, y: py };
  }

  on(root, 'pointermove', e => {
    if (e.pointerType === 'touch' && !e.isPrimary) return;
    if (e.pointerType !== 'touch') latched = false;
    emit(locate(e.clientX, e.clientY, e.pointerType === 'touch' ? REACH_TOUCH : REACH_MOUSE));
  });
  on(root, 'pointerdown', e => {
    if (!e.isPrimary) return;
    const touch = e.pointerType === 'touch';
    const hit = locate(e.clientX, e.clientY, touch ? REACH_TOUCH : REACH_MOUSE);
    latched = touch && !!hit;
    emit(hit);
  });
  on(root, 'pointerleave', () => { if (!latched) emit(null); });
  on(root, 'keydown', e => {
    if (!nodes.length || e.altKey || e.ctrlKey || e.metaKey) return;
    const at = probe?.index >= 0 ? probe.index : reached() - 1;
    const to = { ArrowRight: at + 1, ArrowDown: at + 1, ArrowLeft: at - 1, ArrowUp: at - 1, Home: 0, End: nodes.length - 1 }[e.key];
    if (e.key === 'Escape') return emit(null);
    if (to === undefined) return;
    e.preventDefault();
    emit(atNode(clamp(probe ? to : at, 0, nodes.length - 1)));
  });
  on(root, 'focus', () => {
    if (nodes.length && !probe && root.matches(':focus-visible')) emit(atNode(Math.max(0, reached() - 1)));
  });
  on(root, 'blur', () => { latched = false; emit(null); });

  // ---- environment --------------------------------------------------------------------------

  const resizeObserver = new ResizeObserver(layout);
  resizeObserver.observe(root);
  on(window, 'resize', layout);
  let recolorQueued = false;
  const queueRecolor = () => {
    if (recolorQueued) return;
    recolorQueued = true;
    queueMicrotask(() => { recolorQueued = false; if (!dead) recolor(); });
  };
  const themeObserver = new MutationObserver(queueRecolor);
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
  on(darkScheme, 'change', queueRecolor);
  on(document, 'visibilitychange', () => {
    if (document.hidden) { cancelAnimationFrame(raf); raf = 0; lastTick = 0; } else invalidate();
  });
  document.fonts?.ready.then(() => { if (!dead) layout(); });

  const gl = forceSVG ? null : createGLRenderer({ onLost: useSVG, onRestored: () => invalidate() });
  mount(gl || createSVGRenderer());

  return {
    center,

    setChallenge(next) {
      const times = Array.from(next.times).slice(0, NODE_MAX);
      challenge = { ...next, times };
      nodes = buildNodes(next.curve, times);
      resolve = nodes.map(() => 0);
      emphasis = nodes.map(() => 0);
      progress = clamp(progress, 1, nodes.length);
      emit(null);
      latched = false;
      buildLabels();
      placeLabels();
      scene = {
        curve: next.curve,
        nodes,
        echoN: echoCount(next.curve, box.s),
        tick: tickSpec(next.curve.period),
        gap,
        colors: colors(),
      };
      renderer.setScene(scene);
      drawn = false;
      retarget(false);
    },

    setProgress(k, { animate = true } = {}) {
      const next = clamp(Math.round(k) || 1, 1, Math.max(1, nodes.length));
      if (next === progress && !sweep && front === frontTarget()) return;
      progress = next;
      retarget(animate);
    },

    setSolved(value) {
      if (!!value === solved) return;
      solved = !!value;
      retarget(true);
    },

    setTheme(next) {
      theme = next === 'dark' || next === 'light' ? next : null;
      recolor();
    },

    resize: layout,

    destroy() {
      dead = true;
      cancelAnimationFrame(raf);
      listeners.abort();
      resizeObserver.disconnect();
      themeObserver.disconnect();
      renderer.destroy();
      root.remove();
    },

    // Not part of the contract: state for the test page.
    debug: () => ({ renderer: renderer.kind, front, progress, solved, box, echoes: scene?.echoN, busy: !!raf, simulateLoss: ms => renderer.simulateLoss?.(ms) }),
  };
}
