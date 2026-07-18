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

Seen and learned (7):
- [x] Normal — gray-pink circle, plain dot glyph (Blissey, Snorlax)
- [x] Water — blue circle, droplet glyph (Buizel, Shellos)
- [x] Grass — green circle, leaf glyph (Cherubi)
- [x] Fighting — dark red circle, fist glyph (Mankey)
- [x] Psychic — pink/magenta circle, swirl glyph (Necrozma)
- [x] Ghost — purple circle, ghost glyph (Drifloon, first of its pair)
- [x] Flying — light blue/lavender circle, wing glyph (Drifloon, second)

Still needed — send one screenshot containing each (11):
- [ ] Fire
- [ ] Electric
- [ ] Ice
- [ ] Poison
- [ ] Ground
- [ ] Bug
- [ ] Rock
- [ ] Dragon
- [ ] Dark
- [ ] Steel
- [ ] Fairy

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
