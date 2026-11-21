// The dial's shaders. One fullscreen triangle; every mark is an analytic distance turned into
// pixel coverage, so line weights hold at any resolution and nothing needs multisampling.
// Colours are blended in linear light and encoded to sRGB once at the end.

import { STYLE, NODE_MAX, ECHO_MAX, KNOT_ROW } from './model.js';

const f = x => (Number.isInteger(x) ? x.toFixed(1) : String(x));

export const VERTEX = `#version 300 es
void main() {
  gl_Position = vec4(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0, 0.0, 1.0);
}`;

export const FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

uniform vec2 uRes;        // drawing buffer, device px
uniform float uS;         // half the figure's side, device px
uniform float uPx;        // device px per CSS px
uniform vec2 uGeom;       // base ring radius and Cmax displacement, fractions of uS
uniform sampler2D uKnots; // profile polyline: (turns, C/Cmax) per knot
uniform int uKnotN;
uniform float uM;         // knots per turn
uniform float uLaps;      // span / period
uniform float uFront;     // fill front, turns
uniform float uHalf;      // half-life, turns
uniform int uEchoN;
uniform vec4 uNode[${NODE_MAX}];  // xy (fractions of uS), resolve 0..1, emphasis 0..1
uniform int uNodeN;
uniform vec3 uPaper;
uniform vec3 uInk;
uniform vec3 uAccent;
uniform vec2 uTick;       // ticks per turn, every n-th is long
uniform vec3 uGap;        // gap in the Cmax circle: centre (turns), half-width (turns), on
uniform float uHand;
uniform vec4 uProbe;      // xy (fractions of uS), snapped to a node, on

out vec4 outColor;

const float TAU = 6.283185307179586;

// Coverage of a half-plane whose edge lies x pixels inside the pixel centre.
float edge(float x) { return smoothstep(-0.6, 0.6, x); }
// Coverage of a stroke of width w at distance d from its centre line.
float stroke(float d, float w) { return edge(0.5 * w - d) - edge(-0.5 * w - d); }

float segment(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-9), 0.0, 1.0);
  return length(pa - ba * h);
}

vec2 knot(int i) { return texelFetch(uKnots, ivec2(i % ${KNOT_ROW}, i / ${KNOT_ROW}), 0).rg; }

vec2 onDial(float turns, float radius) {
  float a = TAU * fract(turns);
  return radius * vec2(sin(a), cos(a));
}

// Distance from P to a copy of the profile delayed by "shift" turns and scaled by "gain",
// measured against the few segments around the fragment's own angle on this lap.
float profileDistance(vec2 P, float tau, float shift, float gain, float R0, float H) {
  int j = int(floor((tau - shift) * uM));
  float d = 1e9;
  vec2 prev = vec2(0.0);
  bool have = false;
  for (int s = -2; s <= 2; s++) {
    int i = j + s;
    if (i < 0 || i >= uKnotN) { have = false; continue; }
    vec2 k = knot(i);
    if (k.x + shift > uLaps + 1e-5) break;
    vec2 q = onDial(k.x + shift, R0 + H * gain * k.y);
    if (have) d = min(d, segment(P, prev, q));
    prev = q;
    have = true;
  }
  return d;
}

// Radius of the profile at lap-time tau, and its slope in px per radian.
vec2 profileRadius(float tau, float R0, float H) {
  int j = clamp(int(floor(tau * uM)), 0, uKnotN - 2);
  vec2 a = knot(j), b = knot(j + 1);
  if (tau >= b.x && j + 2 < uKnotN) { a = b; b = knot(j + 2); }
  float span = max(b.x - a.x, 1e-7);
  float u = (tau - a.x) / span;
  return vec2(R0 + H * mix(a.y, b.y, u), H * (b.y - a.y) / (span * TAU));
}

vec3 encode(vec3 c) {
  return mix(12.92 * c, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

void main() {
  vec2 P = gl_FragCoord.xy - 0.5 * uRes;
  float r = length(P);
  float R0 = uGeom.x * uS, H = uGeom.y * uS;
  vec3 col = uPaper;

  if (r > R0 - 10.0 * uPx && r < R0 + H + 14.0 * uPx) {
    float a = atan(P.x, P.y) / TAU;
    a = a < 0.0 ? a + 1.0 : a;
    float arc = TAU * r;            // px per turn at this radius
    int lapN = int(ceil(uLaps - 1e-6));
    float reach = 3.0 / uM;

    float fill = 0.0, hair = 0.0, line = 0.0;

    // The profile and the area under it, lap by lap. Lap -1 is the sliver just before
    // 12 o'clock, there only so the dose edge is antialiased from both sides.
    for (int l = -1; l < 3; l++) {
      if (l >= lapN) break;
      float tau = float(l) + a;
      if (tau < -reach || tau > uLaps + reach) continue;
      float behind = edge((uFront - tau) * arc);
      vec2 pr = profileRadius(tau, R0, H);
      float g = sqrt(1.0 + pr.y * pr.y / max(r * r, 1.0));
      fill = max(fill, edge((pr.x - r) / g) * behind);
      float w = mix(${f(STYLE.fine)}, ${f(STYLE.bold)}, behind) * uPx;
      line = max(line, stroke(profileDistance(P, tau, 0.0, 1.0, R0, H), w));
    }
    fill *= edge(r - R0);

    // Half-life echoes: the profile delayed by k half-lives at 1/2^k the height.
    for (int k = 1; k <= ${ECHO_MAX}; k++) {
      if (k > uEchoN) break;
      float gain = exp2(-float(k));
      if (r > R0 + H * gain + 2.0 * uPx) break;
      float shift = float(k) * uHalf;
      for (int l = 0; l < 3; l++) {
        if (l >= lapN) break;
        float tau = float(l) + a;
        if (tau - shift < -reach || tau > uLaps + reach) continue;
        hair = max(hair, stroke(profileDistance(P, tau, shift, gain, R0, H), ${f(STYLE.echo)} * uPx));
      }
    }

    // Cmax circle, broken where its label sits.
    float away = abs(fract(a - uGap.x + 0.5) - 0.5);
    float open = uGap.z > 0.5 ? edge((away - uGap.y) * arc) : 1.0;
    float pitch = TAU * (R0 + H) / floor(TAU * (R0 + H) / (${f(STYLE.cmaxPitch)} * uPx) + 0.5);
    float beat = abs(fract(a * TAU * (R0 + H) / pitch) - 0.5) * pitch;
    hair = max(hair, stroke(abs(r - R0 - H), ${f(STYLE.cmax)} * uPx) * edge(0.5 * ${f(STYLE.cmaxDash)} * uPx - beat) * open);

    // Time ticks on the inside of the ring.
    float idx = floor(a * uTick.x + 0.5);
    float len = (mod(idx, uTick.y) < 0.5 ? ${f(STYLE.tickMajor)} : ${f(STYLE.tickMinor)}) * uPx;
    hair = max(hair, stroke(abs(a - idx / uTick.x) * arc, ${f(STYLE.tick)} * uPx) * edge(R0 - r) * edge(r - R0 + len));

    // The hand: the current sampling time, from the ring out to Cmax.
    if (uHand > 0.0) {
      float dh = segment(P, onDial(uFront, R0), onDial(uFront, R0 + H));
      hair = max(hair, stroke(dh, ${f(STYLE.hand)} * uPx) * uHand);
    }

    float ring = stroke(abs(r - R0), ${f(STYLE.ring)} * uPx);

    col = mix(col, uAccent, fill);
    col = mix(col, uInk, max(max(hair, ring), line));

    // Sampling nodes: child rings on the profile, hollow until reached.
    for (int i = 0; i < ${NODE_MAX}; i++) {
      if (i >= uNodeN) break;
      vec4 nd = uNode[i];
      float d = length(P - nd.xy * uS);
      float rad = (mix(${f(STYLE.nodeQuiet)}, ${f(STYLE.nodeFull)}, nd.z) + ${f(STYLE.nodeNow)} * nd.w) * uPx;
      if (d > rad + 3.0 * uPx) continue;
      float w = mix(${f(STYLE.nodeQuietW)}, ${f(STYLE.nodeFullW)}, nd.z) * uPx;
      col = mix(col, uPaper, edge(rad + 0.5 * w - d));
      float ink = max(stroke(abs(d - rad), w), edge(${f(STYLE.nodeDot)} * uPx * nd.z - d) * step(0.01, nd.z));
      col = mix(col, uInk, ink);
    }

    if (uProbe.w > 0.5) {
      float d = length(P - uProbe.xy * uS);
      float ink = stroke(abs(d - ${f(STYLE.probe)} * uPx), ${f(STYLE.probeW)} * uPx);
      if (uProbe.z < 0.5) {
        col = mix(col, uPaper, edge(3.2 * uPx - d));
        ink = max(ink, edge(1.8 * uPx - d));
      }
      col = mix(col, uInk, ink);
    }
  }

  outColor = vec4(encode(col), 1.0);
}`;

export const UNIFORMS = [
  'uRes', 'uS', 'uPx', 'uGeom', 'uKnots', 'uKnotN', 'uM', 'uLaps', 'uFront', 'uHalf', 'uEchoN',
  'uNode', 'uNodeN', 'uPaper', 'uInk', 'uAccent', 'uTick', 'uGap', 'uHand', 'uProbe',
];
