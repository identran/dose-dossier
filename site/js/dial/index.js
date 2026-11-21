// The dial: a drug's concentration–time profile wound clockwise round a ring.
//
//   const dial = createDial(containerEl, { onProbe });
//   dial.center                              element over the ring's interior
//   dial.setChallenge({ curve, times, accent, seed })   seed is accepted and unused: every mark
//                                                        is a function of the curve, none is random
//   dial.setProgress(k, { animate })         1..times.length
//   dial.setSolved(bool)
//   dial.setTheme('light' | 'dark')
//   dial.setLabel(text)                      aria-label of the figure (role="img")
//   dial.setDetails(id)                      aria-details: id of the element that describes it
//   dial.setDescription(id)                  aria-describedby: id of a hint on how to use the keyboard
//   dial.resize()
//   dial.destroy()
//
//   onProbe(null | { t, c, frac, index })    t in hours, c in the curve's unit (null when the curve
//                                            is relative), frac = C/Cmax, index = node or -1
//
// The figure is a ring (zero concentration, with time ticks inside it), the profile, the area
// under it up to the current sampling time in the accent, a dot for each sampling time reached,
// and under the profile the half-life contours: arcs at Cmax/2, Cmax/4, Cmax/8 ... which first-
// order elimination crosses at equal angles, one half-life apart. Nothing here runs a permanent animation loop: a frame is drawn when something
// changed, and the only motion is the fill front sweeping to the next sampling time.

import {
  GEOM, STYLE, TAU, NODE_MAX,
  buildNodes, tickSpec, contourCount, contourOnFill, peakTurn, riseTurn, radiusAt, polar, easeInOut,
} from './model.js';
import { createGLRenderer } from './gl.js';
import { createSVGRenderer } from './svg.js';

const SWEEP_MS = 600;
const SETTLE_MS = 70;       // time constant of a node resolving
const REACH_MOUSE = 12;     // CSS px within which the probe snaps to a node
const REACH_TOUCH = 22;
const BAND = 12;            // CSS px either side of the profile band that still counts as over it

const FALLBACK = {
  light: { paper: '#ECEAE5', ink: '#111111', mute: '#5E5D59' },
  dark: { paper: '#0D0D0D', ink: '#DEDCD6', mute: '#8F8E8A' },
};

const CSS = `
.dial-root{position:relative;width:100%;aspect-ratio:1/1;touch-action:manipulation;-webkit-tap-highlight-color:transparent;outline:none}
.dial-canvas{position:absolute;inset:0;width:100%;height:100%;display:block}
.dial-labels{position:absolute;inset:0;pointer-events:none;font-family:var(--font-data,Georgia,'Times New Roman',serif);font-size:var(--size-s,0.8rem);line-height:1;font-variant-numeric:lining-nums;color:var(--mute,#5E5D59)}
.dial-label{position:absolute;transform:translate(-50%,-50%);white-space:nowrap;pointer-events:auto;-webkit-user-select:text;user-select:text}
.dial-label sub{font-size:0.75em}
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
  // Forced colours would otherwise turn every colour read here into the one system text colour.
  probe.style.forcedColorAdjust = 'none';
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
  root.setAttribute('role', 'img');
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
  const forcedScheme = matchMedia('(forced-colors: active)');

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
  let resolve = [];            // per node, 0 hidden .. 1 drawn
  let probe = null;            // { t, index, x, y }
  let latched = false;         // a touch probe stays until the next touch elsewhere
  let raf = 0;
  let lastTick = 0;
  let drawn = false;
  let dead = false;
  let tickLabels = [];
  let cmaxLabel = null;

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
    // Windows high contrast: the figure is drawn in the system's own colours.
    const set = forcedScheme.matches ? {
      paper: readColor('Canvas'),
      ink: readColor('CanvasText'),
      accent: readColor('Highlight'),
    } : {
      paper: readColor(`var(--paper, ${base.paper})`),
      ink: readColor(`var(--ink, ${base.ink})`),
      accent: readColor(challenge?.accent || `var(--accent, var(--mute, ${base.mute}))`),
    };
    set.onFill = contourOnFill(set);
    return set;
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
    for (const { turn, text } of tickSpec(period).labels) {
      const el = document.createElement('span');
      el.className = 'dial-label';
      el.textContent = text;
      labels.append(el);
      tickLabels.push({ el, turn });
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
      put(el, turn, GEOM.R0 * box.s - STYLE.tickMajor - 4 - extent);
    }
    // Cmax stands just outside the peak, clear of the probe ring. Where the figure's own box
    // leaves no room for that (a peak near 12 o'clock), it stands beside the rise instead,
    // level with the peak.
    const { curve } = challenge;
    const w = cmaxLabel.offsetWidth;
    const h = cmaxLabel.offsetHeight;
    const radial = t => (Math.abs(Math.sin(TAU * t)) * w + Math.abs(Math.cos(TAU * t)) * h) / 2;
    const tangent = t => (Math.abs(Math.cos(TAU * t)) * w + Math.abs(Math.sin(TAU * t)) * h) / 2;
    const top = (GEOM.R0 + GEOM.H) * box.s;
    let turn = peakTurn(curve);
    let radius = top + STYLE.probe + 4 + radial(turn);
    const inside = Math.abs(radius * Math.sin(TAU * turn)) + w / 2 <= cx - 1
      && Math.abs(radius * Math.cos(TAU * turn)) + h / 2 <= cy - 1;
    if (!inside) {
      const depth = 2 * radial(turn) + 4;
      const rise = riseTurn(curve, clamp(1 - depth / (GEOM.H * box.s), 0.2, 1));
      radius = top - radial(rise);
      turn = rise - (tangent(rise) + STYLE.probe) / (TAU * radius);
    }
    put(cmaxLabel, turn, radius);
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
      scene.levels = contourCount(box.s);
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

  // A node is drawn once the fill front has passed it.
  function nodeTargets(arriving) {
    const count = reached();
    return nodes.map((n, i) => {
      const passed = front >= n.t - 1e-9 || (arriving && i === count - 1);
      return i < count && (!sweep || passed) ? 1 : 0;
    });
  }

  function settle() {
    resolve = nodeTargets(true);
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
    nodeTargets(arriving).forEach((res, i) => {
      resolve[i] += (res - resolve[i]) * k;
      if (Math.abs(res - resolve[i]) < 0.01) resolve[i] = res; else busy = true;
    });
    return busy;
  }

  function tick(now) {
    raf = 0;
    if (dead || !scene || !box.s) return;
    const busy = still() ? (sweep = null, front = frontTarget(), settle(), false) : step(now);
    const ok = renderer.draw({ front, resolve, probe: probe && { x: probe.x, y: probe.y } });
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
    if (!next) return onProbe(null);
    const { curve } = challenge;
    const c = curve.c(next.t);
    onProbe({ t: next.t, c: curve.relative ? null : c, frac: c / (curve.cmax || 1), index: next.index });
  }

  const atNode = i => ({ t: nodes[i].t, index: i, x: nodes[i].x, y: nodes[i].y });

  function locate(clientX, clientY, reach) {
    if (!challenge || !box.s) return null;
    const rect = root.getBoundingClientRect();
    const x = (clientX - rect.left - rect.width / 2) / box.s;
    const y = -(clientY - rect.top - rect.height / 2) / box.s;
    let best = -1;
    let bestD = reach / box.s;
    nodes.slice(0, reached()).forEach((n, i) => {
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
  on(forcedScheme, 'change', queueRecolor);
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
      progress = clamp(progress, 1, nodes.length);
      emit(null);
      latched = false;
      buildLabels();
      placeLabels();
      scene = {
        curve: next.curve,
        nodes,
        tick: tickSpec(next.curve.period),
        levels: contourCount(box.s),
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

    setLabel(text) {
      if (text) root.setAttribute('aria-label', text); else root.removeAttribute('aria-label');
    },

    setDetails(id) {
      if (id) root.setAttribute('aria-details', id); else root.removeAttribute('aria-details');
    },

    setDescription(id) {
      if (id) root.setAttribute('aria-describedby', id); else root.removeAttribute('aria-describedby');
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
    debug: () => ({ renderer: renderer.kind, front, progress, solved, box, levels: scene?.levels, busy: !!raf, simulateLoss: ms => renderer.simulateLoss?.(ms) }),
  };
}
