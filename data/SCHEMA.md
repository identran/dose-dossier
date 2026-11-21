# Data layout

`data/dossiers/<id>.json` is the source of truth, one file per drug, abstracted from the
public FDA label. `tools/build.mjs` compiles the dossiers into what the site loads:

- `site/data/index.json` — `{ "epoch": "YYYY-MM-DD", "days": <n>, "drugs": [Guessable] }`
- `site/data/day/<NNN>.json` — one compiled dossier per day, zero-padded, 1-based

The site never reads `data/` directly, and it fetches only the index and the current day.

`data/schedule.json` is `{ "epoch": "YYYY-MM-DD", "days": [dossier ids, day 1 first] }`. It is
append-only: once a day has been published its id never changes, and ids are never renamed or removed.

## Dossier

```jsonc
{
  "id": "sildenafil",                 // slug of the generic name, permanent, also the file name
  "generic": "Sildenafil",
  "brand": "Viagra",                  // main US brand, or null
  "aliases": ["Sildenafil citrate", "Revatio"],   // salt names, other brands of the same active moiety
  "salt": "Sildenafil citrate",       // optional
  "application": "NDA 020895",
  "approved": 1998,                   // year the active moiety was first approved by FDA
  "sponsor": "Pfizer",                // originator at first approval, as listed in data/vocab.json
  "area": "Urology",                  // therapeutic area, from data/vocab.json
  "class": "PDE5 inhibitor",          // pharmacologic class, from data/vocab.json (28 characters at most)
  "route": "oral",                    // from data/vocab.json
  "form": "tablet",                   // from data/vocab.json
  "pk": {
    "context": "100 mg oral, single dose, healthy adults",
    //          "{dose} {route}, {single dose | steady state}, {healthy adults | patients}"
    //          never sex, age band or disease: those give the answer away
    "model": "absorption",            // absorption | bolus | infusion  (see site/js/pk.js)
    "tmaxH": 1.0,                     // hours; for an infusion, its duration. A label range is entered as its midpoint
    "halfLifeH": 4.0,                 // terminal half-life, hours
    "cmax": 440,                      // optional: omitted with "unit" when the label states no Cmax for this dose
    "unit": "ng/mL",                  // mass concentration; molar label values are converted with the parent MW
    "spanH": 24,                      // optional, otherwise derived
    "periodH": 24                     // optional, otherwise derived: hours in one turn of the dial
  },
  "pill": {                           // optional
    "shape": "diamond",               // from data/vocab.json
    "color": "#4C86C6",               // flat colour of the product as the label describes it
    "color2": "#D9A441",              // optional, second half of a two-tone capsule
    "desc": "blue, film-coated, rounded-diamond tablet"
  },
  "structure": {                      // small molecules; PubChem 2D layout of the parent compound
    "cid": 135398744,
    "formula": "C22H30N6O4S",
    "atoms": [[x, y, "C"], [x, y, "N", 1]],   // heavy atoms, y up, mean bond length 1; 4th entry = formal charge when non-zero
    "bonds": [[i, j, order]]                   // 0-based atom indices, order 1 | 2 | 3
  },
  "biologic": {                       // instead of "structure" for biologics and large peptides, never for a large
                                      // small molecule (which has its structure, or neither when PubChem has no layout)
    "format": "antibody",             // antibody | bispecific | fragment | fc-fusion | conjugate | peptide | protein | oligonucleotide
    "isotype": "IgG1 κ",              // or null
    "massKDa": 148
  },
  "clues": {                          // six written clues, revealed in this order, one per miss
    "kinetics":   "…",                // bioavailability, food effect, protein binding, main clearance path
    "substance":  "…",                // kind of salt, mass of the active moiety, one physical property
    "product":    "…",                // NDA or BLA, strengths, dosing frequency
    "safety":     "…",                // boxed warning or its absence, contraindications, two signature adverse reactions
    "indication": "…",                // approved indications, shortened
    "mechanism":  "…"                 // target, action, selectivity
  },
  "tell": "…",                        // one sentence, shown after the game: what in the dossier gives this drug away
  "source": {
    "setId": "d905dc8d-917f-4ea3-a4ee-a1ecf6967d4e",
    "label": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=d905dc8d-917f-4ea3-a4ee-a1ecf6967d4e",
    "retrieved": "2026-11-21"
  },
  "evidence": { "pk.tmaxH": "…", "clues.kinetics": "…" },   // verbatim label quotes behind each field; review only, never shipped
  "revised": "2027-01-04",            // optional, with "revisionNote": one line shown after the game
  "revisionNote": "…"
}
```

### Clue rules

Each written clue is at most two sentences and 220 characters. No clue names the drug, a brand,
an alias, the salt, or the distinctive stem of the generic name, and none repeats what the figure
already prints (Tmax, half-life, Cmax, dose, dosage form). Beyond that, each slot holds back what
later slots reveal:

| Slot | Shown as | Must not state |
|---|---|---|
| `kinetics` | Summaries | half-life, Tmax, metabolite names, class |
| `substance` | Quality | formula, colour or shape; for biologics the antibody format or isotype |
| `product` | Administrative | approval year, sponsor |
| `safety` | Clinical | indication, class |
| `indication` | Clinical | class |
| `mechanism` | Nonclinical | – |

The build appends a seventh clue generated from the name ("The generic name begins with S and has ten letters.").

## Compiled day file

The dossier without `evidence`, `source.retrieved` and `salt`, with two changes: `clues` becomes the
ordered array the game reveals, `[{ "slot": "kinetics", "module": "Summaries", "text": "…" }, … ]`
(seven entries, the generated one last), and `accent` is added, `{ "light": "#…", "dark": "#…" }`:
`pill.color` moved in lightness only until it reaches 3:1 against each theme's paper.

## Guessable

The autocomplete list and the attributes each guess is compared on.

```jsonc
{ "id": "sildenafil", "generic": "Sildenafil", "brand": "Viagra", "aliases": ["Revatio"],
  "area": "Urology", "class": "PDE5 inhibitor", "sponsor": "Pfizer", "approved": 1998 }
```

Every dossier is guessable. `data/dictionary.json` holds further guessable drugs that have no dossier.
