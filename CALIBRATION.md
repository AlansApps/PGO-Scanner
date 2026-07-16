# Scanner calibration checklist

The scanner reads IVs from the appraisal bars by pixel analysis and reads
name/CP by OCR. Both need calibration against REAL screenshots from the
user's device. This file tracks which cases have been verified.

Legend: [ ] = need a sample screenshot · [x] = verified working

## IV bar values (each bar: 3 blocks × 5 points = 0–15)
Ideally one sample for every value on any of the three bars:

- [ ] 0  (bar completely gray/empty)
- [ ] 1  (tiny sliver of first block)
- [ ] 2
- [ ] 3
- [ ] 4
- [ ] 5  (exactly one full block)
- [ ] 6  (example available: Snorlax Attack bar = 1 block + sliver)
- [ ] 7
- [ ] 8
- [ ] 9  (example available: Snorlax HP bar)
- [ ] 10 (exactly two full blocks; example: Snorlax Defense bar)
- [ ] 11
- [ ] 12
- [ ] 13
- [ ] 14
- [ ] 15 (full bar rendered RED/PINK instead of orange)

## OCR — text variants
- [ ] CP font digits 0–9 all seen at least once (stylized top-of-screen font)
- [ ] 2-digit CP (e.g. CP 96)
- [ ] 3-digit CP
- [ ] 4-digit CP (example available: CP 2757)
- [ ] Short name (3–4 letters, e.g. Abra)
- [ ] Long name (e.g. Feraligatr)
- [ ] Name with punctuation (Mr. Mime, Farfetch'd, Ho-Oh)
- [ ] Name with gender symbol (Nidoran♀ / Nidoran♂)
- [ ] Nicknamed Pokémon (should leave name blank, no wrong guess)
- [ ] Regional form (Alolan / Galarian / Hisuian) — form picked via types

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
