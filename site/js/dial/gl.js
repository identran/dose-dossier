// WebGL2 renderer: a canvas, one program, one small float texture holding the profile.
// It draws only when asked, and reports a context that stays lost so the caller can fall back.

import { VERTEX, FRAGMENT, UNIFORMS } from './shader.js';
import { GEOM, NODE_MAX, KNOT_ROW, TAU, buildKnots, toLinear } from './model.js';

const LOST_FOR_GOOD_MS = 2500;
const MAX_PIXELS = 2.4e6;   // drawing-buffer budget; beyond it the buffer is scaled down
const MAX_DPR = 2;

function compile(gl) {
  const program = gl.createProgram();
  const shaders = [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, FRAGMENT]].map(([type, source]) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    gl.attachShader(program, shader);
    return shader;
  });
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = shaders.map(s => gl.getShaderInfoLog(s)).concat(gl.getProgramInfoLog(program)).filter(Boolean).join('\n');
    throw new Error(`dial shader: ${log}`);
  }
  shaders.forEach(s => gl.deleteShader(s));
  const loc = {};
  for (const name of UNIFORMS) loc[name] = gl.getUniformLocation(program, name);
  return { program, loc };
}

// Returns null when WebGL2 is not available.
export function createGLRenderer({ onLost, onRestored }) {
  const canvas = document.createElement('canvas');
  canvas.className = 'dial-canvas';
  canvas.setAttribute('aria-hidden', 'true');

  const gl = canvas.getContext('webgl2', {
    alpha: false, antialias: false, depth: false, stencil: false,
    premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'low-power',
  });
  if (!gl) return null;

  let program = null;
  let loc = null;
  let texture = null;
  let lost = false;
  let dead = false;
  let lostTimer = 0;
  let scene = null;         // { curve, nodes, tick, colors }
  let knots = null;         // polyline currently in the texture
  let knotsFor = null;      // [curve, M] it was built for
  let size = { css: 0, px: 1 };
  const nodeData = new Float32Array(NODE_MAX * 3);

  function init() {
    ({ program, loc } = compile(gl));
    gl.useProgram(program);
    gl.bindVertexArray(gl.createVertexArray());
    texture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST],
      [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    gl.uniform1i(loc.uKnots, 0);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    knotsFor = null;
  }

  function uploadKnots() {
    // About one knot every 2.5 device pixels along the ring.
    const M = Math.round(Math.min(2048, Math.max(256, (TAU * GEOM.R0 * size.css * size.px) / 2.5)));
    if (knotsFor && knotsFor[0] === scene.curve && knotsFor[1] === M) return;
    knots = buildKnots(scene.curve, M);
    const rows = Math.ceil(knots.n / KNOT_ROW);
    const data = new Float32Array(rows * KNOT_ROW * 2);
    data.set(knots.data);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, KNOT_ROW, rows, 0, gl.RG, gl.FLOAT, data);
    knotsFor = [scene.curve, M];
  }

  canvas.addEventListener('webglcontextlost', e => {
    e.preventDefault();
    lost = true;
    clearTimeout(lostTimer);
    if (!dead) lostTimer = setTimeout(() => { if (lost && !dead) onLost(); }, LOST_FOR_GOOD_MS);
  });
  canvas.addEventListener('webglcontextrestored', () => {
    clearTimeout(lostTimer);
    if (dead) return;
    try {
      init();
      lost = false;
      onRestored();
    } catch (err) {
      console.error(err);
      onLost();
    }
  });

  try {
    init();
  } catch (err) {
    console.error(err);
    return null;
  }

  return {
    kind: 'webgl2',
    el: canvas,

    // sCss: half the figure's side in CSS px. Returns the device-pixel ratio actually used.
    resize(wCss, hCss, sCss) {
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      const scale = Math.min(1, Math.sqrt(MAX_PIXELS / (wCss * hCss * dpr * dpr)));
      const w = Math.max(1, Math.round(wCss * dpr * scale));
      const h = Math.max(1, Math.round(hCss * dpr * scale));
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      size = { css: sCss, px: w / wCss };
      return size.px;
    },

    setScene(next) { scene = next; },

    draw(frame) {
      if (lost || !scene || gl.isContextLost()) return false;
      uploadKnots();
      const w = gl.drawingBufferWidth;
      const h = gl.drawingBufferHeight;
      gl.viewport(0, 0, w, h);
      const { curve, nodes, colors } = scene;
      gl.uniform2f(loc.uRes, w, h);
      gl.uniform1f(loc.uS, size.css * size.px);
      gl.uniform1f(loc.uPx, size.px);
      gl.uniform2f(loc.uGeom, GEOM.R0, GEOM.H);
      gl.uniform1i(loc.uKnotN, knots.n);
      gl.uniform1f(loc.uM, knots.M);
      gl.uniform1f(loc.uLaps, knots.laps);
      gl.uniform1f(loc.uFront, frame.front / curve.period);
      nodes.forEach((n, i) => {
        nodeData[3 * i] = n.x;
        nodeData[3 * i + 1] = n.y;
        nodeData[3 * i + 2] = frame.resolve[i];
      });
      gl.uniform3fv(loc.uNode, nodeData);
      gl.uniform1i(loc.uNodeN, nodes.length);
      gl.uniform3fv(loc.uPaper, toLinear(colors.paper));
      gl.uniform3fv(loc.uInk, toLinear(colors.ink));
      gl.uniform3fv(loc.uAccent, toLinear(colors.accent));
      gl.uniform2f(loc.uTick, scene.tick.minor, scene.tick.every);
      const p = frame.probe;
      gl.uniform3f(loc.uProbe, p ? p.x : 0, p ? p.y : 0, p ? 1 : 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      return true;
    },

    // For tests: lose the context, optionally bringing it back.
    simulateLoss(restoreAfterMs) {
      const ext = gl.getExtension('WEBGL_lose_context');
      if (!ext) return false;
      ext.loseContext();
      if (restoreAfterMs != null) setTimeout(() => ext.restoreContext(), restoreAfterMs);
      return true;
    },

    destroy() {
      dead = true;
      clearTimeout(lostTimer);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      canvas.remove();
    },
  };
}
