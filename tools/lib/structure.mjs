// 2D structure of the PARENT compound from PubChem PUG REST, in the dossier `structure` shape.
import { getJSON } from './http.mjs';

const PUG = 'https://pubchem.ncbi.nlm.nih.gov/rest/pug';
const SYMBOLS = ['', 'H', 'He', 'Li', 'Be', 'B', 'C', 'N', 'O', 'F', 'Ne', 'Na', 'Mg', 'Al', 'Si', 'P', 'S', 'Cl', 'Ar', 'K', 'Ca',
  'Sc', 'Ti', 'V', 'Cr', 'Mn', 'Fe', 'Co', 'Ni', 'Cu', 'Zn', 'Ga', 'Ge', 'As', 'Se', 'Br', 'Kr', 'Rb', 'Sr', 'Y', 'Zr', 'Nb', 'Mo',
  'Tc', 'Ru', 'Rh', 'Pd', 'Ag', 'Cd', 'In', 'Sn', 'Sb', 'Te', 'I'];

export async function resolveParentCid(nameOrCid) {
  let cid = /^\d+$/.test(String(nameOrCid)) ? Number(nameOrCid) : null;
  if (!cid) {
    const r = await getJSON(`${PUG}/compound/name/${encodeURIComponent(nameOrCid)}/cids/JSON`);
    cid = r?.IdentifierList?.CID?.[0];
    if (!cid) throw new Error(`PubChem: no compound named "${nameOrCid}"`);
  }
  // A salt resolves to its parent (the neutral active moiety); a parent resolves to itself.
  const p = await getJSON(`${PUG}/compound/cid/${cid}/cids/JSON?cids_type=parent`);
  return p?.IdentifierList?.CID?.[0] || cid;
}

export function buildStructure(record, cid, formula) {
  const c = record.PC_Compounds[0];
  const xs = c.coords[0].conformers[0].x;
  const ys = c.coords[0].conformers[0].y;
  const keep = new Map(); // PubChem aid -> new index
  const atoms = [];
  c.atoms.aid.forEach((aid, i) => {
    const el = SYMBOLS[c.atoms.element[i]];
    if (el === 'H') return;
    keep.set(aid, atoms.length);
    atoms.push([xs[i], ys[i], el]); // PubChem 2D coordinates already have y pointing up (checked against its PNG depiction); no flip
  });
  const bonds = [];
  c.bonds.aid1.forEach((a, i) => {
    const b = c.bonds.aid2[i];
    if (!keep.has(a) || !keep.has(b)) return;
    const order = c.bonds.order[i];
    bonds.push([keep.get(a), keep.get(b), order >= 1 && order <= 3 ? order : 1]);
  });
  // Scale so the mean bond length is 1, centre on the bounding box.
  const len = bonds.map(([i, j]) => Math.hypot(atoms[i][0] - atoms[j][0], atoms[i][1] - atoms[j][1]));
  const mean = len.reduce((s, v) => s + v, 0) / len.length;
  const minX = Math.min(...atoms.map(a => a[0])), maxX = Math.max(...atoms.map(a => a[0]));
  const minY = Math.min(...atoms.map(a => a[1])), maxY = Math.max(...atoms.map(a => a[1]));
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const r2 = v => Math.round(v * 100) / 100 + 0; // + 0 turns -0 into 0
  return {
    cid,
    formula,
    atoms: atoms.map(([x, y, el]) => [r2((x - cx) / mean), r2((y - cy) / mean), el]),
    bonds,
  };
}

export async function fetchStructure(nameOrCid) {
  const cid = await resolveParentCid(nameOrCid);
  const rec = await getJSON(`${PUG}/compound/cid/${cid}/record/JSON?record_type=2d`);
  if (!rec?.PC_Compounds) throw new Error(`PubChem: no 2D record for CID ${cid}`);
  const prop = await getJSON(`${PUG}/compound/cid/${cid}/property/MolecularFormula/JSON`);
  const formula = prop?.PropertyTable?.Properties?.[0]?.MolecularFormula;
  return buildStructure(rec, cid, formula);
}

// Heavy-atom count implied by a Hill-style molecular formula such as C22H30N6O4S.
export function heavyAtomsFromFormula(formula) {
  let n = 0;
  for (const [, el, k] of formula.matchAll(/([A-Z][a-z]?)(\d*)/g)) if (el !== 'H') n += k ? Number(k) : 1;
  return n;
}
