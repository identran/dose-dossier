# Reviewing dossier drafts

You are the second pair of eyes on dossier drafts for Dose Dossier, a daily guess-the-drug game
played by drug-development professionals. A first agent wrote each draft from a digest of the
FDA label, and a script has already confirmed that the quotes exist in the digest. Your job is
what a script cannot do: confirm that each draft is true, fair to play, and well written, and
repair it where it is not.

Read `tools/prompts/extract.md` first: it is the brief the drafts were written to, and you hold
them to it. For each id you are given, read the digest `tools/.cache/digests/<id>.txt` in full
and the draft `tools/.cache/drafts/<id>.json`, then check, in this order:

1. **Pharmacokinetics.** Do `tmaxH` and `halfLifeH` describe the same product, route and dose as `context`? Is the half-life the terminal half-life of the parent drug (not a metabolite's, not a distribution or effective half-life when a terminal one is stated)? Are units converted correctly (minutes, days, weeks to hours; molar to mass)? Is the model right (an intravenous infusion's `tmaxH` is its duration)? Is `cmax`, if present, for that same dose? The player reads these numbers off the central figure, so a wrong one ruins the day.
2. **Identity fields.** `approved` is the first approval of the active ingredient. `sponsor` is the originator under its present-day name, as the extraction brief defines it, not a current licensee or generic firm. `area` follows the first indication. `class` is accurate, specific enough to be worth matching on, and at most 28 characters. `route` and `form` describe the product the PK belongs to. Correct these from the digest and from your own knowledge where you are sure.
3. **Clues.** Each states only what the digest supports; each obeys its slot's "must not state" column in substance, not only in wording (a kinetics clue that says "an active sulfone metabolite", or a safety clue that lists "priapism", has given away what a later slot is for; rewrite it); none names the drug or contains its stem; each is at most two sentences and 220 characters; the six read as a ramp from hard to revealing. Rewrite label-ese into plain, exact English. Prefer the distinctive fact over the generic one (every drug "should be used with caution").
4. **Product description.** `pill.shape`, `pill.color` and `pill.desc` match the label's description of the product in `context`; the hex colour is a believable flat rendering of the words. For biologics, `biologic.format`, `isotype` and `massKDa` match the description.
5. **Tell.** One true, specific sentence within 140 characters.
6. **Fit for the game.** Reject a draft whose label lacks the numbers (do not let a guessed Tmax or half-life through), or whose label is for a product with no meaningful systemic exposure (for example an oral antibiotic that is not absorbed).
7. **Skips.** Where the first agent wrote a skip file, read the digest and judge whether the skip was right. If the numbers are in fact there, delete the skip file and write the draft yourself.

Edit `tools/.cache/drafts/<id>.json` directly to fix what you find, keeping `evidence` in step
with the text (quotes verbatim from the digest). Then, from `/home/user/dose-dossier`, re-run for your ids:

```
node tools/assemble.mjs <ids…> --drafts tools/.cache/drafts --out tools/.cache/staging --force
node tools/verify.mjs <ids…> --dir tools/.cache/staging
```

until each reads PASS. To reject a draft, delete `tools/.cache/staging/<id>.json` if it exists
and write `tools/.cache/drafts/<id>.skip.json` with `{ "id": "<id>", "reason": "…" }`.

Never edit a digest, a script, or any file outside `tools/.cache/drafts/` and `tools/.cache/staging/`.
