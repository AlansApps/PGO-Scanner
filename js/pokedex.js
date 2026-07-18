/* ==========================================================================
   pokedex.js — Pokémon GO reference data (base stats, forms, types, CPM)

   Data source: PogoAPI (https://pogoapi.net) — a free, machine-readable
   mirror of the Pokémon GO Game Master. Three endpoints are used:

     pokemon_stats.json  -> base attack / defense / stamina, per form
     pokemon_types.json  -> type(s), per form
     cp_multiplier.json  -> CPM value for every level (1..51, 0.5 steps)

   Everything is cached in localStorage for CACHE_TTL_MS so the app works
   fast (and mostly offline) after the first load.

   Forms matter: the same species name (e.g. "Growlithe") can exist as
   "Normal" and "Hisuian" with different stats and types — that's why every
   lookup here is (name + form), never name alone.
   ========================================================================== */

'use strict';

const Pokedex = (() => {

  const API_BASE = 'https://pogoapi.net/api/v1/';
  const CACHE_KEY = 'pgo-scanner-pokedex-v2'; // v2: + pokemon_evolutions
  const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // refresh weekly

  /**
   * Official Game Master CP multipliers for levels 40.5–51.
   * PogoAPI's cp_multiplier.json only reaches level 45 and admits its
   * half-levels above 40 are interpolated ("may not be entirely correct"),
   * so these authoritative constants are merged OVER the API data.
   * Levels above 40 need XL Candy; 50.5/51 exist only via Best Buddy (+1).
   * Source: Game Master (verified against GamePress/PvPoke).
   */
  const OFFICIAL_HIGH_CPM = {
    40.5: 0.792803968, 41: 0.79530001, 41.5: 0.797800015,
    42: 0.80030001, 42.5: 0.802799995, 43: 0.80530001,
    43.5: 0.807799978, 44: 0.81030001, 44.5: 0.812799963,
    45: 0.81530001, 45.5: 0.817799948, 46: 0.82029999,
    46.5: 0.822799933, 47: 0.82529999, 47.5: 0.827799918,
    48: 0.83029999, 48.5: 0.832799903, 49: 0.83529999,
    49.5: 0.837799888, 50: 0.84029999, 50.5: 0.842799873,
    51: 0.84529999,
  };

  /** All 18 Pokémon types, used to spot type words in OCR text. */
  const ALL_TYPES = [
    'Normal', 'Fire', 'Water', 'Electric', 'Grass', 'Ice', 'Fighting',
    'Poison', 'Ground', 'Flying', 'Psychic', 'Bug', 'Rock', 'Ghost',
    'Dragon', 'Dark', 'Steel', 'Fairy',
  ];

  // ---- Internal state (populated by load()) -----------------------------

  /** @type {Map<string, Array<object>>} normalized species name -> entries (one per form) */
  let byName = new Map();

  /** @type {Array<string>} display names for the autocomplete datalist */
  let allNames = [];

  /** @type {Array<{level:number, multiplier:number}>} */
  let cpmTable = [];

  /** @type {Map<string, Array<object>>} "id|form" -> raw evolution list */
  let evoByKey = new Map();

  let loaded = false;

  // ---- Name normalization / fuzzy matching ------------------------------

  /**
   * Normalize a name for comparison: lowercase, strip accents and
   * non-alphanumeric characters, map gender symbols to letters.
   * "Mr. Mime" -> "mrmime", "Nidoran♀" -> "nidoranf", "Flabébé" -> "flabebe"
   */
  function normalizeName(str) {
    return String(str)
      .replace(/♀/g, 'f')
      .replace(/♂/g, 'm')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '') // strip combining diacritics (range U+0300-U+036F)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
  }

  /**
   * Levenshtein edit distance — used for fuzzy OCR name matching.
   * Iterative two-row implementation (O(len(a) * len(b))).
   */
  function levenshtein(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;

    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    let curr = new Array(b.length + 1);

    for (let i = 1; i <= a.length; i++) {
      curr[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      }
      [prev, curr] = [curr, prev];
    }
    return prev[b.length];
  }

  // ---- Data loading ------------------------------------------------------

  async function fetchJson(endpoint) {
    const res = await fetch(API_BASE + endpoint);
    if (!res.ok) throw new Error(`PogoAPI ${endpoint} failed: HTTP ${res.status}`);
    return res.json();
  }

  /** Build the in-memory indexes from the raw API payloads. */
  function buildIndexes(stats, types, cpm, evolutions) {
    byName = new Map();

    // Evolution lookup by (id, form). Entries may carry gender_required,
    // item_required etc. — kept raw and interpreted at chain-walk time.
    evoByKey = new Map();
    for (const e of evolutions || []) {
      evoByKey.set(`${e.pokemon_id}|${e.form}`, e.evolutions || []);
    }

    // Index types by "id|form" for a quick join with the stats list.
    const typeByKey = new Map();
    for (const t of types) {
      typeByKey.set(`${t.pokemon_id}|${t.form}`, t.type);
    }

    for (const s of stats) {
      const entry = {
        id: s.pokemon_id,
        name: s.pokemon_name,
        form: s.form, // e.g. "Normal", "Alola", "Galarian", "Hisuian"
        base: {
          attack: s.base_attack,
          defense: s.base_defense,
          stamina: s.base_stamina,
        },
        types: typeByKey.get(`${s.pokemon_id}|${s.form}`) || [],
      };

      const key = normalizeName(s.pokemon_name);
      if (!byName.has(key)) byName.set(key, []);
      byName.get(key).push(entry);
    }

    allNames = [...new Set(stats.map((s) => s.pokemon_name))].sort();

    // Build the CPM table: API rows first, then merge the official
    // constants for 40.5–51 over them (replacing the API's imprecise
    // interpolations and adding the levels the API is missing).
    // Cap at level 51: game max is 50, +1 with a Best Buddy boost.
    const cpmByLevel = new Map();
    for (const row of cpm) cpmByLevel.set(row.level, row.multiplier);
    for (const [level, multiplier] of Object.entries(OFFICIAL_HIGH_CPM)) {
      cpmByLevel.set(parseFloat(level), multiplier);
    }
    cpmTable = [...cpmByLevel.entries()]
      .map(([level, multiplier]) => ({ level, multiplier }))
      .filter((row) => row.level <= 51)
      .sort((a, b) => a.level - b.level);

    loaded = true;
  }

  /**
   * Load reference data (from localStorage cache when fresh, otherwise
   * from PogoAPI). Must complete before any scan/lookup is attempted.
   */
  async function load() {
    // 1) Try cache
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (raw) {
        const cached = JSON.parse(raw);
        if (Date.now() - cached.timestamp < CACHE_TTL_MS) {
          buildIndexes(cached.stats, cached.types, cached.cpm, cached.evolutions);
          return;
        }
      }
    } catch (_) {
      // Corrupted cache — ignore and refetch.
    }

    // 2) Fetch fresh data
    const [stats, types, cpm, evolutions] = await Promise.all([
      fetchJson('pokemon_stats.json'),
      fetchJson('pokemon_types.json'),
      fetchJson('cp_multiplier.json'),
      fetchJson('pokemon_evolutions.json'),
    ]);

    buildIndexes(stats, types, cpm, evolutions);

    // 3) Save cache (best effort — localStorage can be full/blocked)
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ timestamp: Date.now(), stats, types, cpm, evolutions }));
    } catch (_) { /* non-fatal */ }
  }

  // ---- Lookups -----------------------------------------------------------

  /**
   * Fuzzy-match an OCR'd string against all species names.
   * @param {string} text - candidate name from OCR
   * @param {number} [maxDistance=2] - max edit distance to accept
   * @returns {{name:string, distance:number}|null} best match or null
   */
  function matchName(text, maxDistance = 2) {
    const needle = normalizeName(text);
    if (needle.length < 3) return null; // too short to match reliably

    // Short strings carry little redundancy, so scale the allowed edit
    // distance with length: <=4 chars must match exactly (OCR noise
    // like "New" must never morph into "Mew"), 5-6 chars allow 1 edit,
    // 7+ allow the full maxDistance.
    const allowed = Math.min(
      maxDistance,
      needle.length <= 4 ? 0 : needle.length <= 6 ? 1 : 2
    );

    let best = null;
    for (const [key, entries] of byName) {
      // Quick length filter before computing the full edit distance.
      if (Math.abs(key.length - needle.length) > allowed) continue;
      const d = levenshtein(needle, key);
      if (d <= allowed && (!best || d < best.distance)) {
        best = { name: entries[0].name, distance: d };
        if (d === 0) break; // exact match — stop early
      }
    }
    return best;
  }

  /**
   * All form entries for a species display name.
   * @returns {Array<object>} entries ({id, name, form, base, types}), or []
   */
  function getForms(displayName) {
    return byName.get(normalizeName(displayName)) || [];
  }

  /**
   * Pick the form whose types best match a set of OCR-detected type words.
   * @param {Array<object>} forms - entries from getForms()
   * @param {Array<string>} detectedTypes - e.g. ["Normal"]
   * @returns {object|null} the single best-matching form, or null if ambiguous
   */
  function pickFormByTypes(forms, detectedTypes) {
    if (forms.length === 1) return forms[0];
    if (!detectedTypes.length) return null;

    const detected = detectedTypes.map((t) => t.toLowerCase()).sort();
    const scored = forms.map((f) => {
      const own = f.types.map((t) => t.toLowerCase());
      const overlap = detected.filter((t) => own.includes(t)).length;
      const exact = own.length === detected.length && overlap === own.length;
      return { form: f, overlap, exact };
    });

    // Prefer an exact type-set match; fall back to highest overlap if unique.
    const exactMatches = scored.filter((s) => s.exact);
    if (exactMatches.length === 1) return exactMatches[0].form;

    scored.sort((a, b) => b.overlap - a.overlap);
    if (scored[0].overlap > 0 && (scored.length === 1 || scored[0].overlap > scored[1].overlap)) {
      return scored[0].form;
    }
    return null; // ambiguous — let the user choose
  }

  /**
   * Signature of what makes a form FUNCTIONALLY different in battle:
   * base stats + type set. Forms sharing a signature are cosmetic-only
   * variants (Shellos East/West Sea, costumes, real-world-region colors).
   */
  function formSignature(entry) {
    return `${entry.base.attack}|${entry.base.defense}|${entry.base.stamina}|` +
      [...entry.types].sort().join(',');
  }

  /**
   * The species' functionally distinct forms only: cosmetic variants
   * collapse into one representative (preferring the "Normal" form).
   * E.g. Shellos -> 1 entry; Raichu -> 2 (Normal + Alola);
   * Deoxys -> all 4 (same types, different stats).
   */
  function getDistinctForms(displayName) {
    const bySig = new Map();
    for (const f of getForms(displayName)) {
      const sig = formSignature(f);
      const existing = bySig.get(sig);
      if (!existing || (existing.form !== 'Normal' && f.form === 'Normal')) {
        bySig.set(sig, f);
      }
    }
    return [...bySig.values()];
  }

  /** True when the species has more than one functionally distinct form. */
  function hasSignificantForms(displayName) {
    return getDistinctForms(displayName).length > 1;
  }

  /**
   * All future evolutions of a form entry (whole chain, including
   * branches — e.g. Kirlia returns both Gardevoir and Gallade, and
   * Mankey returns Primeape then Annihilape).
   * @param {object} formEntry - an entry from getForms()
   * @returns {Array<object>} resolved entries ({id, name, form, base,
   *          types, genderRequired}) in chain order; [] if none
   */
  function getEvolutionChain(formEntry) {
    const out = [];
    const seen = new Set();
    // Output dedupe by FUNCTIONAL signature: cosmetic-equivalent
    // evolutions (Gastrodon East/West) produce one row, while
    // functionally different ones (the three Wormadam cloaks) keep
    // one row each.
    const outSigs = new Set([`${formEntry.name}|${formSignature(formEntry)}`]);

    // Seed with EVERY cosmetic sibling of the scanned form, not just
    // the representative: cosmetic variants can have different
    // evolution outcomes (Burmy cloaks -> different Wormadam forms;
    // only White-striped Basculin -> Basculegion), so the union of all
    // sibling chains is walked. (pogo-auditor finding, 2026-07-18.)
    const sig = formSignature(formEntry);
    const queue = [];
    for (const sibling of getForms(formEntry.name)) {
      if (formSignature(sibling) === sig) {
        seen.add(`${sibling.id}|${sibling.form}`);
        queue.push(sibling);
      }
    }

    while (queue.length) {
      const current = queue.shift();
      const evolutions = evoByKey.get(`${current.id}|${current.form}`) || [];
      for (const evo of evolutions) {
        const key = `${evo.pokemon_id}|${evo.form}`;
        if (seen.has(key)) continue; // cycle/duplicate guard
        seen.add(key);

        // Resolve the evolved species to its stats entry, matching the
        // exact form when possible (regional lines keep their region;
        // fallback covers evolutions whose species has no such form
        // entry, e.g. Galarian Corsola -> Cursola stored as "Normal").
        const forms = byName.get(normalizeName(evo.pokemon_name)) || [];
        const resolved = forms.find((f) => f.form === evo.form) || forms[0];
        if (!resolved) continue; // species missing from stats data

        queue.push(resolved); // keep walking even when the row dedupes

        const outKey = `${resolved.name}|${formSignature(resolved)}`;
        if (outSigs.has(outKey)) continue;
        outSigs.add(outKey);
        out.push({ ...resolved, genderRequired: evo.gender_required || null });
      }
    }
    return out;
  }

  /**
   * Find type words (e.g. "NORMAL", "Fire") inside raw OCR text.
   * Besides exact word matches, words of >= 4 letters may fuzzy-match a
   * type name with one edit — the trainer avatar often covers the tail
   * of the word on screen ("POISO", "FLYIN").
   */
  function detectTypesInText(text) {
    const found = new Set();
    for (const type of ALL_TYPES) {
      // Word-boundary match, case-insensitive.
      const re = new RegExp(`\\b${type}\\b`, 'i');
      if (re.test(text)) found.add(type);
    }
    for (const word of String(text).split(/[^A-Za-z]+/)) {
      if (word.length < 4) continue;
      const w = word.toLowerCase();
      for (const type of ALL_TYPES) {
        const t = type.toLowerCase();
        // Accept a truncated prefix (>=4 chars) or a 1-edit misread.
        if (t.startsWith(w) || levenshtein(w, t) <= 1) { found.add(type); break; }
      }
    }
    return [...found];
  }

  // Public API
  return {
    load,
    get isLoaded() { return loaded; },
    get names() { return allNames; },
    get cpmTable() { return cpmTable; },
    normalizeName,
    matchName,
    getForms,
    getDistinctForms,
    hasSignificantForms,
    getEvolutionChain,
    pickFormByTypes,
    detectTypesInText,
    ALL_TYPES,
  };

})();
