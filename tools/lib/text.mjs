// Text helpers shared by the digest builder and the verifier.

// openFDA label fields are arrays of strings (usually one); join them.
export function flat(raw) {
  if (raw == null) return '';
  return (Array.isArray(raw) ? raw.join('\n') : String(raw));
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

// Tidy a label section: drop markup remnants (tags, entities, table rules, "[ see ... ]" cross references)
// and collapse whitespace. Never rewrites words.
export function cleanLabelText(s) {
  return flat(s)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') {
        const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
        return Number.isFinite(code) ? String.fromCodePoint(code) : ' ';
      }
      return ENTITIES[e.toLowerCase()] ?? ' ';
    })
    .replace(/\[\s*see [^\]]*\]/gi, ' ')
    .replace(/[|]+/g, ' ')
    .replace(/[-_=─—]{4,}/g, ' ')
    .replace(/[\s\u200b\ufeff]+/g, ' ')
    .replace(/\s+([.,;:])/g, '$1')
    .trim();
}

// Cut at a sentence boundary at or before `cap` characters. Adds " [...]" when it cut.
export function trimAt(text, cap) {
  if (text.length <= cap) return text;
  const cut = text.slice(0, cap);
  let stop = -1;
  for (const m of cut.matchAll(/[.!?)\]]\s(?=[A-Z0-9(•])/g)) stop = m.index + 1;
  return (stop > cap * 0.55 ? cut.slice(0, stop) : cut.replace(/\s+\S*$/, '')) + ' [...]';
}

export function sentences(text) {
  return text.split(/(?<=[.!?])\s+(?=[A-Z•(\d])/).filter(Boolean);
}

const SUB = '₀₁₂₃₄₅₆₇₈₉';
const SUP = '⁰¹²³⁴⁵⁶⁷⁸⁹';

// Normal form used to compare quotes with the digest: lower case, ASCII dashes and quotes, plain digits,
// single spaces. The same function is applied to both sides.
export function normalize(s) {
  return String(s)
    .normalize('NFKC')
    .replace(/[₀-₉]/g, c => String(SUB.indexOf(c)))
    .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, c => String(SUP.indexOf(c)))
    .replace(/[‐‑‒–—―−﹣－]/g, '-')
    .replace(/[‘’‚‛′`´]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[\u2000-\u200b\u202f\u205f\u3000\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
