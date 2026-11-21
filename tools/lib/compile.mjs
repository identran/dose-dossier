// Compilation helpers: the generated seventh clue and the per-theme accent colours.
import { FIELDS } from './validate.mjs';

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const words = n => (n < 20 ? ONES[n] : n < 100 ? TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : '') : String(n));

// "The generic name begins with S and has ten letters." A name of several words says so, and counts letters only:
// "The generic name begins with B and has seventeen letters in two words." A hyphen does not make a word.
export function nameClue(generic) {
  const parts = generic.trim().split(/\s+/).filter(part => /\p{L}/u.test(part));
  const letters = generic.replace(/[^\p{L}]/gu, '').length;
  const first = generic.trim()[0].toUpperCase();
  const count = `The generic name begins with ${first} and has ${words(letters)} letters`;
  return parts.length === 1 ? `${count}.` : `${count} in ${words(parts.length)} words.`;
}

export function compileClues(clues, generic) {
  return [...FIELDS.slots.map(slot => ({ slot, module: FIELDS.slotModule[slot], text: clues[slot] })),
    { slot: 'name', module: FIELDS.slotModule.name, text: nameClue(generic) }];
}

// ---- colour: sRGB <-> OKLCH, lightness-only adjustment to reach WCAG contrast 3:1
const lin = c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const gam = c => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
const hexToRgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
const rgbToHex = rgb => '#' + rgb.map(c => Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, '0')).join('').toUpperCase();

function toOklch([r, g, b]) {
  [r, g, b] = [r, g, b].map(lin);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(A, B), Math.atan2(B, A)];
}
function fromOklch([L, C, h]) {
  const A = C * Math.cos(h), B = C * Math.sin(h);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s].map(gam);
}
const luminance = rgb => { const [r, g, b] = rgb.map(lin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
export function contrast(hexA, hexB) {
  const a = luminance(hexToRgb(hexA)), b = luminance(hexToRgb(hexB));
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

// Move only the OKLCH lightness (hue and chroma fixed; channels clipped to the gamut) until the colour reaches 3:1.
function against(hex, paper, direction) {
  if (contrast(hex, paper) >= 3) return hex.toUpperCase();
  const [L, C, h] = toOklch(hexToRgb(hex));
  for (let step = 1; step <= 400; step++) {
    const l = Math.min(1, Math.max(0, L + direction * step * 0.0025));
    const out = rgbToHex(fromOklch([l, C, h]));
    if (contrast(out, paper) >= 3) return out;
  }
  return direction < 0 ? '#000000' : '#FFFFFF';
}

export function accent(color) {
  return { light: against(color, '#ECEAE5', -1), dark: against(color, '#0D0D0D', +1) };
}
