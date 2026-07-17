# IV bar visual guide

How to read the three appraisal bars (Attack / Defense / HP) **visually and
exactly**. This is the authoritative reference for both human review and the
scanner's pixel logic. Bars are read by geometry only — never inferred from
CP math (math is used later, for level derivation only).

## Geometry
Each bar = **3 blocks** separated by thin white gaps. Each block = **5 IV
points**, so a full bar = 15. Within a block, the fill advances in fifths
(1 point = 1/5 of the block's width).

## Anchor table (verified against real screenshots)

| IV | What you see |
|----|--------------------------------------------------------------|
| 0  | All three blocks gray — no orange at all |
| 1  | Tiny orange sliver at the start of block 1 (~1/5) |
| 2  | Block 1 ~2/5 orange |
| 3  | Block 1 ~3/5 orange |
| 4  | Block 1 almost full, thin gray tip remains |
| 5  | **Block 1 exactly full** — clean edge at the first separator |
| 6  | Block 1 full + small orange stub just past the separator |
| 7  | Block 1 full + ~2/5 of block 2 |
| 8  | Block 1 full + ~3/5 of block 2 |
| 9  | Block 1 full + block 2 almost full, thin gray tip |
| 10 | **Blocks 1–2 exactly full** — clean edge at the second separator |
| 11 | Blocks 1–2 full + small stub into block 3 |
| 12 | Blocks 1–2 full + ~2/5 of block 3 |
| 13 | Blocks 1–2 full + ~3/5 of block 3 |
| 14 | Blocks 1–2 full + block 3 almost full, **thin gray tip at the end** |
| 15 | **Entire bar filled and rendered RED/PINK** (not orange) |

## Critical distinctions (easy to get wrong)
- **14 vs 15**: 14 is ORANGE with a small gray tip at the far right;
  15 is fully RED. Color decides, not just length.
- **N vs N+1 at separators** (5 vs 6, 10 vs 11): look for the stub *past*
  the white gap. A clean edge exactly at the separator = 5 or 10.
- **4/9/14 vs 5/10/15**: the "almost full block" cases keep a thin gray tip —
  if any gray shows at the block's right edge, it is NOT the full-block value.
- **11 vs 14** (historical bug): don't summarize as "2 blocks + a bit" —
  measure the third block's fill fraction: stub (~1/5) = 11, near-full = 14.

## Verified real-world samples

Batch 1 (2026-07-16, WhatsApp JPEGs — scanner-verified 5/5):
| Pokémon | CP | IVs (ground truth) | Values exercised |
|---------|-----|--------------------|------------------|
| Drifloon | 503 | 5 / 14 / 15 | 5, 14, red-15 |
| Shellos | 14 | 5 / 5 / 14 | 5, 14 |
| Shellos ♀ | 410 | 0 / 11 / 8 | 0, 11, 8 |
| Cherubi | 431 | 5 / 12 / 8 | 12, 8 |
| Buizel ♀ | 128 | 6 / 9 / 14 | 6, 9, 14 |

Batch 2 (2026-07-17, full-resolution screenshots — visually verified 9/9,
levels solve uniquely; scanner run pending until files land in samples/):
| Pokémon | CP | IVs (ground truth) | Values exercised | Level |
|---------|-----|--------------------|------------------|-------|
| Mankey ♀ | 679 | 7 / 4 / 2 | 7, 4, 2 | 24 |
| Necrozma | 2588 | 15 / 10 / 13 | red-15 (Attack bar!), 10, 13 | 25 |
| Blissey ♀ | 2011 | 3 / 1 / 14 | 3, 1, 14 | 29 |

Notes from batch 2:
- The red "maxed" rendering is PER BAR: Necrozma's Attack bar is red while
  Defense/HP stay orange.
- A green tag pill (e.g. "PVM") can appear under the HP line — it sits
  below the name band and must not be OCR'd as the name.

**All 16 values (0–15) are now catalogued with real-screenshot anchors.**

Scanner result on batch 1: **15/15 IVs, 5/5 names, 5/5 CPs correct.**
