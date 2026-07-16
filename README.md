# PGO Scanner

A mobile-friendly web app that scans **Pokémon GO screenshots** (and later,
videos) and extracts:

- **Pokémon** — species name + form/variant (Alolan, Galarian, Hisuian, …),
  disambiguated by the type shown on screen
- **CP** — the combat power at the top of the screen
- **IVs** — Attack / Defense / HP read from the appraisal bars
  (3 bars × 3 blocks × 5 points = 0–15 each)

From those values the app derives the Pokémon's **level** and **real stats**
using the official CP formula and CPM table.

**Live app:** https://alansapps.github.io/PGO-Scanner/

## How it works
Everything runs client-side in the browser — no server, no uploads:

1. **IV bars** — pure pixel analysis finds the three appraisal bars and
   measures the orange/red fill ratio (`js/ivbars.js`).
2. **OCR** — [Tesseract.js](https://tesseract.projectnaptha.com/) reads the
   screenshot text; the CP and species name are parsed from it, with fuzzy
   matching against the full Pokédex (`js/scanner.js`, `js/pokedex.js`).
3. **Math** — level and stats are solved from CP + IVs + base stats
   (`js/calc.js`). Reference data comes from [PogoAPI](https://pogoapi.net)
   and is cached locally.

Values the scanner can't detect confidently are left **blank** for manual
entry — it never guesses.

## Use it like an app on your phone
- **iPhone (Safari):** open the live URL → Share button (square with arrow) →
  **Add to Home Screen**.
- **Android (Chrome):** open the live URL → ⋮ menu → **Add to Home screen** /
  **Install app**.

When you tap **Upload photo / video** the phone opens your photo library
(asking for photo access the first time), just like a native app.

## Development
- Plain HTML/CSS/JS, no build step.
- Branches: work on `dev`; `main` is production (auto-published by GitHub Pages).
- Scanner calibration status: see [CALIBRATION.md](CALIBRATION.md).

## Disclaimer
Unofficial fan tool. Not affiliated with Niantic, Nintendo or The Pokémon
Company. Pokémon GO data courtesy of the community project PogoAPI.
