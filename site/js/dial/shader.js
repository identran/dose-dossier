// The dial's shaders. One fullscreen triangle; every mark is an analytic distance turned into
// pixel coverage, so line weights hold at any resolution and nothing needs multisampling.
// The only colours are paper, ink and the accent, each laid down at full coverage: the only
// in-between values are the antialiased edges. Blending is in linear light, encoded once at the end.

import { STYLE, NODE_MAX, KNOT_ROW } from './model.js';

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
uniform vec3 uNode[${NODE_MAX}];  // xy (fractions of uS), size 0..1
uniform int uNodeN;
uniform vec3 uPaper;
uniform vec3 uInk;
uniform vec3 uAccent;
uniform vec2 uTick;       // ticks per turn, every n-th is long
uniform int uLevels;      // half-life contours drawn
uniform vec3 uOnFill;     // their colour over the accent
uniform vec3 uProbe;      // xy (fractions of uS), on

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

// Distance from P to the profile, measured against the few segments around the fragment's
// own angle on this lap.
float profileDistance(vec2 P, float tau, float R0, float H) {
  int j = int(floor(tau * uM));
  float d = 1e9;
  vec2 prev = vec2(0.0);
  bool have = false;
  for (int s = -2; s <= 2; s++) {
    int i = j + s;
    if (i < 0 || i >= uKnotN) { have = false; continue; }
    vec2 k = knot(i);
    if (k.x > uLaps + 1e-5) break;
    vec2 q = onDial(k.x, R0 + H * k.y);
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

    float fill = 0.0, line = 0.0;

    // The half-life contour nearest this radius: C = Cmax / 2^k.
    float level = clamp(floor(0.5 - log2(max((r - R0) / H, 1e-4))), 1.0, float(max(uLevels, 1)));
    float Rk = R0 + H * exp2(-level);
    float arcInk = uLevels > 0 ? stroke(abs(r - Rk), ${f(STYLE.line)} * uPx) : 0.0;
    float contour = 0.0, contourOnFill = 0.0;

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
      // A contour exists only where the profile stands above it.
      float under = arcInk * edge((pr.x - Rk) / g) * edge((uLaps - tau) * arc);
      contour = max(contour, under);
      contourOnFill = max(contourOnFill, under * behind);
      float w = mix(${f(STYLE.line)}, ${f(STYLE.bold)}, behind) * uPx;
      line = max(line, stroke(profileDistance(P, tau, R0, H), w));
    }
    fill *= edge(r - R0);

    // Time ticks on the inside of the ring.
    float idx = floor(a * uTick.x + 0.5);
    float len = (mod(idx, uTick.y) < 0.5 ? ${f(STYLE.tickMajor)} : ${f(STYLE.tickMinor)}) * uPx;
    float tick = stroke(abs(a - idx / uTick.x) * arc, ${f(STYLE.line)} * uPx) * edge(R0 - r) * edge(r - R0 + len);

    float ring = stroke(abs(r - R0), ${f(STYLE.line)} * uPx);

    col = mix(col, uAccent, fill);
    col = mix(col, uInk, contour);
    col = mix(col, uOnFill, contourOnFill);
    col = mix(col, uInk, max(max(tick, ring), line));

    // Sampling times reached so far: a dot on the profile for each.
    for (int i = 0; i < ${NODE_MAX}; i++) {
      if (i >= uNodeN) break;
      vec3 nd = uNode[i];
      if (nd.z <= 0.0) continue;
      col = mix(col, uInk, edge(${f(STYLE.node)} * uPx * nd.z - length(P - nd.xy * uS)));
    }

    if (uProbe.z > 0.5) {
      float d = length(P - uProbe.xy * uS);
      float ink = max(stroke(abs(d - ${f(STYLE.probe)} * uPx), ${f(STYLE.line)} * uPx), edge(${f(STYLE.node)} * uPx - d));
      col = mix(col, uInk, ink);
    }
  }

  outColor = vec4(encode(col), 1.0);
}`;

export const UNIFORMS = [
  'uRes', 'uS', 'uPx', 'uGeom', 'uKnots', 'uKnotN', 'uM', 'uLaps', 'uFront',
  'uNode', 'uNodeN', 'uPaper', 'uInk', 'uAccent', 'uTick', 'uLevels', 'uOnFill', 'uProbe',
];
