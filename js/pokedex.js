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
  const CACHE_KEY = 'pgo-scanner-pokedex-v1';
  const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // refresh weekly

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
  function buildIndexes(stats, types, cpm) {
    byName = new Map();

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

    // Sort CPM by level so findLevelsForCP results come out ordered.
    cpmTable = cpm
      .map((row) => ({ level: row.level, multiplier: row.multiplier }))
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
          buildIndexes(cached.stats, cached.types, cached.cpm);
          return;
        }
      }
    } catch (_) {
      // Corrupted cache — ignore and refetch.
    }

    // 2) Fetch fresh data
    const [stats, types, cpm] = await Promise.all([
      fetchJson('pokemon_stats.json'),
      fetchJson('pokemon_types.json'),
      fetchJson('cp_multiplier.json'),
    ]);

    buildIndexes(stats, types, cpm);

    // 3) Save cache (best effort — localStorage can be full/blocked)
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ timestamp: Date.now(), stats, types, cpm }));
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

    let best = null;
    for (const [key, entries] of byName) {
      // Quick length filter before computing the full edit distance.
      if (Math.abs(key.length - needle.length) > maxDistance) continue;
      const d = levenshtein(needle, key);
      if (d <= maxDistance && (!best || d < best.distance)) {
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

  /** Find type words (e.g. "NORMAL", "Fire") inside raw OCR text. */
  function detectTypesInText(text) {
    const found = [];
    for (const type of ALL_TYPES) {
      // Word-boundary match, case-insensitive.
      const re = new RegExp(`\\b${type}\\b`, 'i');
      if (re.test(text)) found.push(type);
    }
    return found;
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
    pickFormByTypes,
    detectTypesInText,
    ALL_TYPES,
  };

})();
