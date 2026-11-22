// "Explain terms": finds the glossary term to gloss after a piece of text. Pure, no DOM.
//
// The glossary is data/glossary.json: [{ "term": "CYP3A4", "also": ["CYP3A"], "gloss": "CYP3A4: a liver enzyme …" }].
// A term or variant is matched as a whole word; one written with a capital is matched in that
// case only ("BLA" is not "black"), anything else in either case.

const WORD = /[\p{L}\p{N}]/u;

function find(text, lower, word) {
  const exact = word !== word.toLowerCase();
  const hay = exact ? text : lower;
  const needle = exact ? word : word.toLowerCase();
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + 1)) {
    const before = text[at - 1];
    const after = text[at + needle.length];
    if (!(before && WORD.test(before)) && !(after && WORD.test(after))) return at;
  }
  return -1;
}

// A glosser for one rendering of the page. gloss(text) returns the gloss of the first glossary
// term in the text that this glosser has not already returned, or null: each term is explained
// once, where it first appears.
export function createGlosser(entries) {
  const seen = new Set();
  return function gloss(text) {
    const source = String(text ?? '');
    const lower = source.toLowerCase();
    let first = null;
    let firstAt = Infinity;
    for (const entry of entries) {
      if (seen.has(entry.term)) continue;
      for (const word of [entry.term, ...(entry.also || [])]) {
        const at = find(source, lower, word);
        if (at >= 0 && at < firstAt) { first = entry; firstAt = at; }
      }
    }
    if (!first) return null;
    seen.add(first.term);
    return first.gloss;
  };
}
