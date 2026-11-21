# Writing dossier drafts from label digests

You turn digests of FDA prescribing information into dossier drafts for Dose Dossier, a daily
guess-the-drug game played by drug-development professionals. The player sees the drug's
pharmacokinetic profile and, after each wrong guess, one more clue. Every fact you write must
come from the digest and be backed by a verbatim quote, because a script checks each quote
against the digest and each number against its quote.

For each drug id you are given:

- Read `tools/.cache/digests/<id>.txt` in full. It is the only source for facts.
- Write `tools/.cache/drafts/<id>.json`, or, if the drug cannot be an answer, `tools/.cache/drafts/<id>.skip.json` containing `{ "id": "<id>", "reason": "…" }`.

Study `tools/prompts/example-draft.json` (a draft that passes) and one finished dossier,
`data/dossiers/esomeprazole.json`, before you start. `data/SCHEMA.md` has the full schema and
`data/vocab.json` the allowed values.

## When to skip

Skip when the digest states no terminal or elimination half-life; when it gives no time to peak
concentration and the product is not given intravenously; when the label covers more than one
active ingredient; or when the digest is plainly the wrong product. Do not skip for a missing Cmax.

## Fields of the draft

`aliases` — other US brand names of the same active ingredient and its salt name as the label gives it (for example "Sildenafil citrate"). Empty array if none.

`salt` — the salt or ester form named in the description ("Imatinib mesylate"), omitted for a free base or a biologic.

`approved` — the year in the digest header: "First approval of this active ingredient" when that line is present, otherwise "Original approval year".

`sponsor` — the originator: the company that first brought the drug to approval, by its short common name, at most 20 characters ("Pfizer", "Merck", "Bristol Myers Squibb", "GSK", "Genentech", "Novo Nordisk"). The header's current manufacturer is often a later owner or a subsidiary; use your knowledge of who developed the drug. Use a name already in `vocab.json` `sponsors` when it is the same company.

`area` — one therapeutic area from `vocab.json`, chosen by the first indication's organ system.

`class` — the pharmacologic class, short and in the style of the `vocab.json` `classes` list, at most 28 characters ("Factor Xa inhibitor", "GLP-1 receptor agonist", "PD-1 blocking antibody"). Reuse an existing entry when it fits exactly.

`route`, `form` — from `vocab.json`, for the product the PK numbers describe. An injectable solution is form "injection".

`pk` — one dosing situation from the label, with the numbers that belong to it:
- `context`: exactly "{dose} {route}, {single dose | steady state}, {healthy adults | patients}", for example "20 mg oral, single dose, healthy adults" or "200 mg intravenous, steady state, patients". No sex, age, food state or disease.
- `model`: "absorption" for oral, subcutaneous, intramuscular, inhaled and other extravascular routes; "infusion" for an intravenous infusion; "bolus" for an intravenous push.
- `tmaxH`: hours from dose to peak. A range is entered as its midpoint, minutes and days are converted. For an infusion it is the infusion duration (see the Administration section); for a bolus it is 0.
- `halfLifeH`: the terminal (elimination) half-life in hours, of the parent drug, not of a metabolite and not an "effective" or distribution half-life when a terminal one is given. A range is entered as its midpoint.
- `cmax` and `unit`: only when the digest states a peak concentration for the dose in `context`, as a mass concentration ("ng/mL", "µg/mL", "mg/L"). Convert molar values with the parent molecular weight in the digest header. Otherwise omit both.

`pill` — the product as described under How supplied or Dosage forms:
- `shape` from `vocab.json` `pillShapes` (tablets and capsules by their shape; injectables "vial", "pen" or "syringe"; "inhaler", "patch", "dropper").
- `color`: one flat hex colour for the described colour of the tablet, capsule or solution; `color2` for the second half of a two-tone capsule. Omit `color` when the product is colourless or no colour is described.
- `desc`: a few words, lower case, no brand and no imprint ("yellow, film-coated, almond-shaped tablet", "clear, colourless solution in a single-dose vial").

`biologic` — write this when the digest header has no "Parent compound" line, or the molecular weight is above 900: `{ "format": …, "isotype": …, "massKDa": … }` with format one of antibody, bispecific, fragment, fc-fusion, conjugate, peptide, protein, oligonucleotide; isotype as the description gives it ("IgG1 κ", "IgG4 κ") or null; mass in kilodaltons from the description, or null if not stated.

`clues` — six clues, each at most two sentences and 220 characters, in plain, exact English (rewrite the label's wording, keep its facts and numbers). They are revealed in this order, so each holds back what later ones reveal:

| Slot | States | Must not state |
|---|---|---|
| `kinetics` | bioavailability, food effect, protein binding, main clearance path | half-life, Tmax, metabolite names, the class |
| `substance` | kind of salt, molecular weight of the active moiety, one physical property. For biologics: origin, expression system, presentation | the formula, colour or shape; antibody format or isotype |
| `product` | NDA or BLA, strengths, dosing frequency | approval year, sponsor |
| `safety` | boxed warning or that there is none, contraindications, two signature adverse reactions | the indication, the class |
| `indication` | the approved indications, shortened | the class |
| `mechanism` | target, action, selectivity | – |

No clue names the drug, a brand, a salt or alias, a metabolite named after the drug, or any word containing the first five letters of the generic name. No clue repeats what the figure already prints (Tmax, half-life, Cmax). Where the label uses the brand in capitals, write "it" or "the drug". Every number in a clue must appear in that clue's quotes.

`tell` — one sentence, at most 140 characters, shown after the game: what in this dossier most sets the drug apart. It may name the drug and its class. State only what the digest supports.

`evidence` — an object mapping `pk.tmaxH`, `pk.halfLifeH`, `pk.cmax` (when given), `pill` (when given), `biologic` (when given) and each `clues.<slot>` to a verbatim quote from the digest, or an array of quotes. Copy the digest's exact characters; keep quotes short (a clause is enough); do not join text across a gap unless you mark it with `[...]`.

## Checking your work

After writing your drafts, from `/home/user/dose-dossier` run, with your own ids:

```
node tools/assemble.mjs <ids…> --drafts tools/.cache/drafts --out tools/.cache/staging --force
node tools/verify.mjs <ids…> --dir tools/.cache/staging
```

Fix every error the verifier prints by editing the draft and re-running both commands, until
each id reads PASS. Warnings about vocabulary membership of `class` or `sponsor` are expected.
If a draft cannot be made to pass honestly (the fact is not in the digest), remove the claim
rather than bending the quote; if the PK numbers themselves are not in the digest, skip the drug.
Never edit a digest, a script, or any file outside `tools/.cache/drafts/`.
