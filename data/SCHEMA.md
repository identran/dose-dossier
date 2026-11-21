# Data layout

`data/dossiers/<id>.json` is the source of truth, one file per drug, abstracted from the
public FDA label. `tools/build.mjs` compiles the dossiers into what the site loads:

- `site/data/index.json` — `{ "epoch": "YYYY-MM-DD", "days": <n>, "drugs": [Guessable] }`
- `site/data/day/<NNN>.json` — one compiled dossier per day, zero-padded, 1-based

The site never reads `data/` directly, and it fetches only the index and the current day.

## Dossier

```jsonc
{
  "id": "sildenafil",                 // slug, also the file name
  "generic": "Sildenafil",
  "brand": "Viagra",
  "aliases": ["Sildenafil citrate", "Revatio"],
  "salt": "Sildenafil citrate",
  "application": "NDA 020895",
  "approved": 1998,
  "sponsor": "Pfizer",
  "area": "Urology",                  // one of the areas in data/vocab.json
  "class": "PDE5 inhibitor",
  "route": "oral",                    // oral | intravenous | subcutaneous | intramuscular | inhaled | topical | ...
  "form": "tablet",                   // tablet | capsule | solution | injection | ...
  "pk": {
    "context": "100 mg single oral dose, fasted healthy adults",
    "model": "absorption",            // absorption | bolus | infusion  (see site/js/pk.js)
    "tmaxH": 1.0,
    "cmax": 450,
    "unit": "ng/mL",
    "halfLifeH": 4.0,
    "spanH": 24                       // optional, otherwise derived
  },
  "pill": {                           // optional
    "shape": "diamond",               // round | oval | oblong | capsule | diamond | triangle | vial | pen | inhaler | ...
    "color": "#4F7CC4",               // a second colour, "color2", only for two-tone capsules
    "desc": "blue, film-coated, rounded-diamond tablet"
  },
  "structure": {                      // optional, absent for biologics; 2D coordinates from PubChem
    "cid": 135398744,
    "formula": "C22H30N6O4S",
    "atoms": [[x, y, "C"], ...],      // heavy atoms only, y up
    "bonds": [[i, j, order], ...]     // 0-based atom indices, order 1 | 2 | 3
  },
  "clues": [                          // ordered, revealed one per wrong guess
    { "module": 1, "title": "Approval", "text": "…" }
  ],
  "source": {
    "setId": "0b0be196-0c62-461c-94f4-9a35339b4501",
    "label": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=0b0be196-0c62-461c-94f4-9a35339b4501",
    "retrieved": "2026-11-21"
  }
}
```

A clue never names the drug, its brands or its salt.

## Guessable

The autocomplete list and the attributes each guess is compared on.

```jsonc
{ "id": "sildenafil", "generic": "Sildenafil", "brand": "Viagra", "aliases": ["Revatio"],
  "area": "Urology", "form": "tablet", "sponsor": "Pfizer", "halfLifeH": 4.0 }
```

Every dossier is guessable. `data/dictionary.json` holds further guessable drugs that have no dossier yet.
