# Scanner calibration checklist

## Known issues (tracked, being worked through)
Running log of real-world scan failures reported by the user, so they can
be revisited with more data instead of getting lost between sessions.
Mark ✅ RESOLVED with the fix + commit once confirmed by a re-test.

- **Regional-form disambiguation from video is unreliable** (e.g. Stunfisk
  Normal vs Galarian — same base stats in our data, different types
  Ground/Electric vs Ground/Steel). The type-row OCR that resolves this
  from photos often can't read the tiny type label at video resolution.
  STATUS: OPEN — user is preparing a comparison video (both Stunfisk
  types back to back) specifically to find a fix. Do not attempt a fix
  from guesswork; wait for that video's real pixel data.
- **2026-07-19 (10.39.32 video) — user reported 6/30 needing manual CP
  review, asked to reduce it. ✅ MOSTLY RESOLVED, one residual case
  documented below:**
  1. Root cause (dense diagnostic sweep across each failing group's full
     time window, sampling every 0.1s): the coarse 0.4s-grid boundary
     used to detect a "stable" group routinely UNDERSAMPLES how long a
     card is actually on screen — e.g. Stufful's true stable window was
     0.8s wide but the coarse grid only caught 0.4s of it, missing the
     cleanest, most consistent CP frames entirely. Confirmed for
     Stufful/Wimpod/Mimikyu/Smoliv/Wattrel/Wiglett: the correct CP was
     reliably readable just outside the detected window.
     FIX: `refineGroupBounds` (js/videoscanner.js) re-checks the IV bars
     at 0.1s resolution and extends the window outward while they keep
     matching — cheap (pixel-only, no OCR) and used ONLY for CP/HP
     escalation reads, never for name (see finding 3).
  2. Second root cause found on an older video (Buneary/Bronzor,
     2026-07-18 14.46.33): for some cards the NORMAL-threshold CP read is
     unreadable across the card's ENTIRE window while the STRICT (235)
     threshold reads it cleanly throughout — but the strict-threshold
     escalation tier only checked 3 narrow points, easy to miss. FIX: the
     final "dense" escalation tier now reads BOTH thresholds at every
     sampled point instead of just the normal one.
  3. **BLOCKER caught during testing, fixed before shipping:** widening
     the boundary for CP reads was initially applied to NAME reads too,
     which is unsafe — name text can finish transitioning to the next
     card before the IV bars do, so a widened name-read window
     occasionally picked up an ADJACENT card's name (confirmed: a real
     Stufful/Dewpider pair produced a "Stufful" entry carrying Dewpider's
     IVs). FIX: name/HP/type reads stay strictly within the original,
     un-widened coarse window; only CP reads use the refined (wider)
     window, protected by the existing CP+HP+level plausibility check.
  4. Residual, OPEN, lower-severity case: a card's own un-widened coarse
     window can occasionally already straddle the swipe into the next
     card by itself (independent of any refinement), producing a SHORT
     group whose name reads as the wrong (adjacent) species while its
     IVs are correct — e.g. a 2-frame blip read "Wimpod" while showing
     the preceding Stufful's real IVs. Mitigated (not eliminated): Pass 4
     dedup no longer requires a name match to merge a SHORT group into a
     longer, more-trustworthy neighbor. This closes most cases but not
     all — when the mislabeled short group has no long correctly-named
     neighbor with matching IVs to merge into, it survives as its own
     entry. SAFE either way: CP always stays blank for these (never a
     guessed/wrong number), so nothing wrong ever auto-saves — worst
     case is an extra low-confidence entry in the manual-review queue.
  Verified: repeated runs (6+) of the reported video after all fixes
  typically show 0-3 entries needing review (down from the reported 6),
  sometimes 0; full 8-photo + 5-video regression suite unaffected.
- **2026-07-19 (09.52.54 video, tested via the live site) — ✅ RESOLVED,
  two causes stacked:**
  1. Likely stale cache: GitHub Pages serves js/*.js with
     `Cache-Control: max-age=600` and the site had no cache-busting, so
     a phone (especially the Home Screen PWA) could keep running OLD
     code for a while after a deploy. FIX: index.html script/style tags
     now carry a `?v=YYYYMMDDx` query string, bumped on every deploy
     that touches js/*.js or css/style.css (rule added to CLAUDE.md).
  2. Real, reproducible flakiness in `decideCP` (js/videoscanner.js):
     traced the Clauncher miss to per-frame CP reads [644, 1644, null,
     64, null] — no value repeated, so the old "majority OR unique
     plausible" rule bailed to null even though only 644 passed the
     CP+shown-HP-vs-level plausibility check. Root cause of the
     per-frame disagreement: video seeking is not perfectly
     deterministic — a "cold" seek straight to one timestamp can
     occasionally decode a slightly different frame than a sequential
     seek through nearby timestamps would (confirmed: 3 repeated full
     scans of this video gave inconsistent Clauncher results before the
     fix, identical results after). FIX: decideCP now scores ALL
     plausible candidates by vote count and returns the best-supported
     one (handles a single strong plausible read the same way as a
     clean majority) with a blank-out only on a genuine tie between two
     different plausible values; added a third escalation tier that
     samples densely (~6 extra points) across the whole stable window
     when the normal 3-5 reads can't resolve it.
  Verified: 3 repeated full scans of the video now give identical,
  correct results for Stunfisk (CP1000), Deino (CP312) and Clauncher
  (CP644); full photo+video regression suite still 100% green; bonus
  recovery on an unrelated video (Tynamo CP333, previously blank).


The scanner reads IVs from the appraisal bars by pixel analysis and reads
name/CP by OCR. Both need calibration against REAL screenshots from the
user's device. This file tracks which cases have been verified.

Legend: [ ] = need a sample screenshot · [x] = verified working

## IV bar values (each bar: 3 blocks × 5 points = 0–15)
Ideally one sample for every value on any of the three bars:

- [x] 0  (bar completely gray/empty) — verified: Shellos CP410 Attack
- [x] 1  (tiny sliver of first block) — verified: Blissey Defense (batch 2)
- [x] 2  (~2/5 of block 1) — verified: Mankey HP (batch 2)
- [x] 3  (~3/5 of block 1) — verified: Blissey Attack (batch 2)
- [x] 4  (block 1 almost full, thin gray tip) — verified: Mankey Defense (batch 2)
- [x] 5  (exactly one full block) — verified: Drifloon/Cherubi/Shellos14 Attack
- [x] 6  (1 block + small stub past the separator) — verified: Buizel Attack
- [x] 7  (1 block + ~2/5 of block 2) — verified: Mankey Attack (batch 2)
- [x] 8  (1 block + ~3/5 of block 2) — verified: Cherubi/Shellos410 HP
- [x] 9  (1 block + ~4/5, thin gray tip left) — verified: Buizel Defense
- [x] 10 (exactly two full blocks) — verified: Necrozma Defense (batch 2)
- [x] 11 (2 blocks + small stub) — verified: Shellos410 Defense
- [x] 12 (2 blocks + ~2/5 of block 3) — verified: Cherubi Defense
- [x] 13 (2 blocks + ~3/5 of block 3) — verified: Necrozma HP (batch 2)
- [x] 14 (2 blocks + ~4/5, thin gray tip at the end) — verified: Buizel/Shellos14 HP, Drifloon Defense
- [x] 15 (full bar rendered RED/PINK instead of orange) — verified: Drifloon HP, Necrozma Attack (red is per-bar)

ALL 16 VALUES CATALOGUED. Batch 2 (Mankey/Necrozma/Blissey) is verified
visually with unique level solutions; run the scanner on those files once
they are copied into samples/.

## OCR — text variants
- [x] CP font digits 0–9 all seen at least once — batch 2 added 6,7,9 (CP 679)
      (scanner run on batch 2 pending — files not yet in samples/)
- [x] 2-digit CP — verified: Shellos CP 14
- [x] 3-digit CP — verified: 128 / 410 / 431 / 503
- [ ] 4-digit CP — seen in batch 2 (2588, 2011) but not yet scanner-verified
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
