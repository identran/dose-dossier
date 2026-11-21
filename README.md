# Dose Dossier

A daily guessing game for people who work with drugs. Each day one FDA-approved drug is the
answer. You see its pharmacokinetic profile, and every wrong guess opens another clue from its
dossier.

## Playing

The ring is plasma concentration after a dose: time runs clockwise and concentration outward.
The arcs under the profile mark half, a quarter and an eighth of the peak, so they end one
half-life apart. You have eight guesses. Each miss opens a clue and sharpens the chemical
structure in the centre. Under each guess, bold marks what it shares with the answer
(therapeutic area, class, sponsor), and the arrow beside the year points toward the answer's
approval year.

## Running it

The site is static, with no framework and no build step for the front end.

```bash
npm run build
```

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000/site/`. Add `?day=3` to play a particular day.

Pushing to `main` deploys `site/` to GitHub Pages through `.github/workflows/pages.yml`. Pages
has to be enabled once in the repository settings, with GitHub Actions as the source.

## Layout

| Path | What it holds |
|---|---|
| `site/` | The published game: page, styles, modules, fonts, compiled data |
| `site/js/pk.js` | The pharmacokinetic model behind every profile |
| `site/js/dial/` | The central figure, in WebGL2 with an SVG fallback |
| `site/js/molecule.js`, `biologic.js` | Structure drawings that resolve step by step |
| `data/dossiers/` | One file per drug, the source of truth, with the label quotes behind each fact |
| `data/schedule.json` | Which drug is the answer on which day |
| `tools/` | Scripts that fetch labels, check dossiers and compile `site/data/` |
| `dev/` | Test pages for the figure and the structure drawings |

`data/SCHEMA.md` describes every field.

## Where the data comes from

Everything is abstracted from public sources: prescribing information from
[openFDA](https://open.fda.gov) and [DailyMed](https://dailymed.nlm.nih.gov), approval history
from Drugs@FDA, and two-dimensional structures from [PubChem](https://pubchem.ncbi.nlm.nih.gov).

Labels state a time to peak, a half-life and sometimes a peak concentration, not a
concentration–time table. Each profile is therefore reconstructed from those numbers with a
one-compartment model, and is a faithful sketch, not a digitised study curve.

Each dossier keeps, under `evidence`, the verbatim label text behind its numbers and clues.
`npm run verify -- --all` checks every quote against the label digest and every number against
its quote. Evidence is not shipped to the site.

## Adding or correcting a drug

```bash
npm run resolve -- candidates.json --out data/candidates.json
```

```bash
npm run structures -- <id>
```

```bash
npm run digest -- <id>
```

Write the draft from the digest following `tools/prompts/extract.md`, then:

```bash
npm run assemble -- <id> --drafts tools/.cache/drafts
```

```bash
npm run verify -- <id>
```

```bash
npm run build
```

The schedule is append-only: published days keep their answer, and ids are never renamed.
Corrections to text and numbers can ship at any time.

## Notes

Dose Dossier is a game and a teaching aid. It is not medical advice and must not be used for
clinical decisions. Label content is the work of its sponsors and the FDA; errors of
abstraction are ours, and corrections are welcome as issues or pull requests.

The typeface is Source Serif 4, subset and renamed under the SIL Open Font License
(`site/assets/fonts/OFL.txt`). The code is under the MIT License.
