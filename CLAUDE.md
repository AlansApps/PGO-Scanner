# PGO Scanner — project conventions

## What this is
A static web app (GitHub Pages) that scans Pokémon GO screenshots AND
screen-recording videos to extract the Pokémon (name + form), CP and IVs,
then derives level and real stats.

Live site: https://alansapps.github.io/PGO-Scanner/ (served from `main`).

## Workflow (important)
- ALL work happens on the `dev` branch.
- `main` = production (GitHub Pages). NEVER commit directly to `main`.
- After a meaningful batch of changes, ASK the user whether to merge
  `dev` → `main` (that is what publishes to the live site). Never merge
  without asking.
- GitHub Pages serves `js/*.js` and `css/style.css` with
  `Cache-Control: max-age=600` and NO cache-busting. A phone (especially
  the "Add to Home Screen" PWA) can keep running OLD code for 10+ minutes
  after a deploy. index.html loads these files with a `?v=YYYYMMDDx`
  query string for exactly this reason — **bump that version string on
  every deploy that changes any `js/*.js` or `css/style.css` file**, or a
  live fix may silently fail to reach the user (this caused a real
  confusion incident on 2026-07-19: fixes verified working locally
  appeared broken on the user's live retest minutes after deploy).

## Language & style
- The user may write in any language (usually Spanish); ALWAYS respond in English.
- All code, comments, commit messages, and UI text: English only.
- Code style: robust, defensive, well-ordered, thoroughly commented.
  Every module starts with a header comment explaining its purpose.
- Plain HTML/CSS/JS, no build step (deployed as-is to Pages).

## Game logic audits
Any change touching Pokémon GO mechanics (CP math, IVs, levels, forms, PvP)
must be checked with the `pogo-auditor` agent (.claude/agents/pogo-auditor.md).

## Architecture
- `index.html` — single page, loads modules in dependency order.
- `css/style.css` — Pokémon-themed styles (Poké Ball red / navy / yellow).
- `js/calc.js` — pure game math (CP formula, level solving, stats).
- `js/pokedex.js` — reference data from PogoAPI + name fuzzy matching (always
  key lookups by name AND form — same name can have different stats/types).
- `js/ivbars.js` — pixel analysis of the 3 appraisal bars (thresholds in
  `CONFIG`/`COLOR` at the top; these get calibrated with real screenshots,
  see CALIBRATION.md).
- `js/scanner.js` — scan pipeline: decode → IV bars → OCR (Tesseract.js) → parse.
  Exposes band-OCR helpers (CP band, name band) reused by the video scanner.
- `js/videoscanner.js` — video pipeline: sample frames → stable IV groups →
  per-group name/CP OCR with majority voting + plausibility filter →
  entries reviewed one by one in the UI. IVs always come from the bars
  (visual); math only validates/derives, never invents values.
- `js/app.js` — UI wiring, video review queue and localStorage collection.
- Rule: a value not detected confidently is returned as `null` and shown as a
  BLANK field for manual entry — never guess silently.
