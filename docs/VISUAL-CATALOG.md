# Visual scraping catalog

Every element of the Pokémon GO card interface that can be scraped
visually, with its location and learning status. Companion to
IV-VISUAL-GUIDE.md (which covers the appraisal bars in detail).
When a new screenshot arrives, update this catalog with anything new.

## Screen layout (relative to a full-screen card screenshot)
| Element | Where | Status |
|---------|-------|--------|
| CP ("CP2588") | Top center, stylized white outline digits | ✅ scanner reads it (dedicated band OCR) |
| Species name / nickname | Center of white card (~41–44% height), dark text + pencil icon | ✅ scanner reads it |
| HP line ("154 / 154 HP") | Under the green HP bar, below the name | 📋 catalogued, not yet scraped |
| Gender symbol | Right edge, at name/HP height: gray ♂ or ♀; **genderless species show nothing** (e.g. Necrozma) | 📋 catalogued, not yet scraped |
| Tag pill (e.g. green "PVM") | Below the HP line — must never be confused with the name | ✅ documented trap |
| Weight (kg) / Height (m) | Row under the name area, left and right | 📋 catalogued, not yet scraped |
| Type icon(s) | Same row, center: 1 or 2 colored circles with a glyph + type word below | 🔶 icon library in progress (see below) |
| Star medal (appraisal) | Left edge overlay: 0–3 stars; orange stamp = 37–44 IV total, all-gray = low | ✅ used as cross-check |
| IV bars | Appraisal overlay panel | ✅ fully calibrated (IV-VISUAL-GUIDE.md) |
| Catch caption | Bottom: "This X was caught on DATE around PLACE" | 📋 catalogued (privacy: never publish) |
| Candy / Stardust counters | Right/lower area, often covered by the trainer avatar | 📋 catalogued, unreliable (occluded) |

Note: the type WORD and the right-hand stats are often partially covered
by the trainer avatar (Spark). The type ICON usually stays visible —
that's why the icon library matters more than the word.

## Type icon library (18 total)
Colored circle + white glyph, shown under the name row next to WEIGHT.

Seen and learned (11):
- [x] Normal — gray-pink circle, plain dot glyph (Blissey, Snorlax, Buneary)
- [x] Water — blue circle, droplet glyph (Buizel, Shellos, Mudkip, Oshawott)
- [x] Grass — green circle, leaf glyph (Cherubi, Lileep 2nd, Carnivine)
- [x] Fighting — dark red circle, fist glyph (Mankey, Meditite, Riolu)
- [x] Psychic — pink/magenta circle, swirl glyph (Necrozma, Meditite 2nd, Bronzor 2nd)
- [x] Ghost — purple circle, ghost glyph (Drifloon, first of its pair)
- [x] Flying — light blue/lavender circle, wing glyph (Drifloon/Zubat, second)
- [x] Poison — dusty pink/mauve circle, droplet-cross glyph (Zubat, Grimer) — 2026-07-18 video batch
- [x] Rock — khaki/brown circle, boulder glyph (Lileep) — 2026-07-18 video batch
- [x] Electric — mustard-yellow circle, lightning bolt glyph (Shinx) — 2026-07-18 video batch
- [x] Steel — gray-green circle, gear/ring glyph (Bronzor) — 2026-07-18 video batch
- [x] Dark — charcoal-gray circle, crescent glyph (Purrloin) — 2026-07-18 Unova video
- [x] Ground — orange-tan circle, mountain glyph (Drilbur) — 2026-07-18 Unova video
- [x] Fairy — pink circle (Cottonee, second icon) — 2026-07-18 Unova video
- [x] Fire — orange circle, flame glyph (Darumaka) — 2026-07-18 Unova video
- [x] Bug — yellow-green circle, beetle glyph (Dwebble) — 2026-07-18 Unova video

Still needed — send one screenshot containing each (2):
- [ ] Ice (e.g. Swinub, Snorunt, Alolan Vulpix)
- [ ] Dragon (e.g. Dratini, Bagon, Gible)

Additional traps learned (2026-07-18 videos):
- LUCKY Pokémon show a gold "Lucky Pokémon" label under the name and a
  sparkle background; the name band can misread on those frames.
- Short OCR words could fuzzy-match short species names ("New" -> Mew);
  fixed: names of <=4 letters must match exactly, 5-6 letters allow one
  edit (js/pokedex.js matchName).
- The first second of a recording can catch the appraisal overlay while
  it is still animating in — CP usually fails there, sending the entry
  to manual review (safe).

## Why types matter for identification
The same species name can exist with different types per REGIONAL FORM
(English names: Alolan, Galarian, Hisuian, Paldean). Example: Raichu is
pure Electric; Alolan Raichu is Electric/Psychic. The type icons visible
on screen are the key to picking the right form when the name alone is
ambiguous. All Pokédex lookups in this app are keyed by (name + form).

Two kinds of "regional" — do not confuse them:
- POKÉMON-WORLD regional forms (Alolan/Galarian/Hisuian/Paldean):
  different types and/or stats. These MATTER: shown bold, kept distinct,
  and their evolutions stay regional.
- COSMETIC variants: real-world catch region colors (Shellos East/West
  Sea), costumes, appearance-only forms. Same stats, same types — they
  change NOTHING in battle. The app collapses them automatically
  (`Pokedex.getDistinctForms`: forms are equivalent iff base stats AND
  type set match), never asks the user to choose between them, and never
  displays them. Data-driven, no hardcoded list — e.g. Pikachu's 50
  costume forms collapse to 1, while Deoxys' 4 forms stay distinct
  (same types but different stats).

## Gender notes (affects evolutions)
Gender is scrapeable from the ♂/♀ symbol. It matters for:
- Kirlia: male → Gallade (Sinnoh Stone); Snorunt: female → Froslass
- Combee: only female evolves (Vespiquen)
- Salandit: only female evolves (Salazzle)
- Burmy: male → Mothim, female → Wormadam (form by cloak)
- Nidoran♀ / Nidoran♂ are separate species
- Genderless species (many legendaries) show no symbol at all
