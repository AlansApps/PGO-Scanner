# Scanner calibration checklist

The scanner reads IVs from the appraisal bars by pixel analysis and reads
name/CP by OCR. Both need calibration against REAL screenshots from the
user's device. This file tracks which cases have been verified.

Legend: [ ] = need a sample screenshot · [x] = verified working

## IV bar values (each bar: 3 blocks × 5 points = 0–15)
Ideally one sample for every value on any of the three bars:

- [x] 0  (bar completely gray/empty) — verified: Shellos CP410 Attack
- [ ] 1  (tiny sliver of first block)
- [ ] 2
- [ ] 3
- [ ] 4
- [x] 5  (exactly one full block) — verified: Drifloon/Cherubi/Shellos14 Attack
- [x] 6  (1 block + small stub past the separator) — verified: Buizel Attack
- [ ] 7
- [x] 8  (1 block + ~3/5 of block 2) — verified: Cherubi/Shellos410 HP
- [x] 9  (1 block + ~4/5, thin gray tip left) — verified: Buizel Defense
- [ ] 10 (exactly two full blocks; example: Snorlax Defense bar)
- [x] 11 (2 blocks + small stub) — verified: Shellos410 Defense
- [x] 12 (2 blocks + ~2/5 of block 3) — verified: Cherubi Defense
- [ ] 13
- [x] 14 (2 blocks + ~4/5, thin gray tip at the end) — verified: Buizel/Shellos14 HP, Drifloon Defense
- [x] 15 (full bar rendered RED/PINK instead of orange) — verified: Drifloon HP

Still needed: 1, 2, 3, 4, 7, 10, 13.

## OCR — text variants
- [ ] CP font digits 0–9 all seen at least once — seen so far: 0,1,2,3,4,5,8 (missing 6,7,9)
- [x] 2-digit CP — verified: Shellos CP 14
- [x] 3-digit CP — verified: 128 / 410 / 431 / 503
- [ ] 4-digit CP (example available: CP 2757)
- [ ] Short name (3–4 letters, e.g. Abra)
- [x] Medium name (6–8 letters) — verified: Buizel, Cherubi, Shellos, Drifloon
- [ ] Long name (e.g. Feraligatr)
- [ ] Name with punctuation (Mr. Mime, Farfetch'd, Ho-Oh)
- [ ] Name with gender symbol (Nidoran♀ / Nidoran♂)
- [ ] Nicknamed Pokémon (should leave name blank, no wrong guess)
- [ ] Regional form (Alolan / Galarian / Hisuian) — form picked via types

Known traps (fixed):
- Status-bar clock "08:59" was read as CP 859 → CP now comes from a dedicated
  band crop that excludes the status bar (js/scanner.js `CP_BAND`).
- Stylized CP glyphs invisible to the full-image OCR pass on some backgrounds
  → binarized band + digit whitelist + single-line mode fixes it.
- WhatsApp-compressed JPEGs (739×1600, ~80 KB) work fine for bars and OCR.

## Screenshot conditions
- [ ] Appraisal overlay (small panel, as in the first Snorlax sample)
- [ ] Full appraisal screen
- [ ] Different iPhone sizes / notch variants
- [ ] Dark in-game background vs light
- [ ] Weather effects on screen behind the card
- [ ] Shadow / Purified Pokémon card
- [ ] Mega-evolved Pokémon card
- [ ] Screenshot cropped by the user (partial screen)

## How to calibrate
1. User sends batches of screenshots with the TRUE values (name, CP, IVs).
2. Run them through the scanner; log mismatches.
3. Adjust `IvBars.CONFIG` / `IvBars.COLOR` thresholds or OCR parsing in
   `js/scanner.js`; re-run the whole set (no regressions), tick the boxes.
