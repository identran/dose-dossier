#!/usr/bin/env node
// Usage: node tools/fetch-structure.mjs <name-or-cid>
// Prints the dossier `structure` object (parent compound, heavy atoms, y up, mean bond length 1).
// Behind the agent proxy run with NODE_USE_ENV_PROXY=1.
import { fetchStructure, heavyAtomsFromFormula } from './lib/structure.mjs';

const arg = process.argv.slice(2).join(' ').trim();
if (!arg) { console.error('usage: fetch-structure.mjs <name-or-cid>'); process.exit(2); }
try {
  const s = await fetchStructure(arg);
  if (heavyAtomsFromFormula(s.formula) !== s.atoms.length) console.error(`warning: formula ${s.formula} implies ${heavyAtomsFromFormula(s.formula)} heavy atoms, record has ${s.atoms.length}`);
  console.log(JSON.stringify(s));
} catch (e) {
  console.error(`fetch-structure: ${e.message}`);
  process.exit(1);
}
