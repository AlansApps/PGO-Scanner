/* ==========================================================================
   calc.js — Pokémon GO math (CP formula, level solving, real stats)

   Core game formulas:
     CP = floor( (BaseAtk + IVatk) * sqrt(BaseDef + IVdef)
                 * sqrt(BaseSta + IVsta) * CPM^2 / 10 ),  minimum 10
     HP = floor( (BaseSta + IVsta) * CPM ),               minimum 10

   CPM (CP Multiplier) is a per-level constant published by the game
   (levels 1 to 51 in 0.5 steps). We load it from PogoAPI (see pokedex.js).
   ========================================================================== */

'use strict';

const PgoCalc = (() => {

  /**
   * Compute the CP of a Pokémon.
   * @param {{attack:number, defense:number, stamina:number}} base - base stats
   * @param {{atk:number, def:number, hp:number}} ivs - IVs, each 0..15
   * @param {number} cpm - CP multiplier for the level
   * @returns {number} CP (integer, min 10)
   */
  function computeCP(base, ivs, cpm) {
    const cp = Math.floor(
      (base.attack + ivs.atk) *
      Math.sqrt(base.defense + ivs.def) *
      Math.sqrt(base.stamina + ivs.hp) *
      cpm * cpm / 10
    );
    return Math.max(cp, 10);
  }

  /**
   * Compute the real (in-battle) stats at a given CPM.
   * @returns {{attack:number, defense:number, hp:number}}
   *          attack/defense are floats, hp is an integer (as shown in game)
   */
  function computeStats(base, ivs, cpm) {
    return {
      attack: (base.attack + ivs.atk) * cpm,
      defense: (base.defense + ivs.def) * cpm,
      hp: Math.max(Math.floor((base.stamina + ivs.hp) * cpm), 10),
    };
  }

  /**
   * Find every level whose CP matches the target CP for the given
   * base stats + IVs. Usually returns exactly one level; can return
   * several when adjacent levels produce the same CP (common at low CP),
   * or none if the inputs are inconsistent (wrong IVs / wrong Pokémon).
   *
   * @param {{attack:number, defense:number, stamina:number}} base
   * @param {{atk:number, def:number, hp:number}} ivs
   * @param {number} targetCP
   * @param {Array<{level:number, multiplier:number}>} cpmTable
   * @returns {Array<{level:number, multiplier:number}>} matching levels
   */
  function findLevelsForCP(base, ivs, targetCP, cpmTable) {
    return cpmTable.filter((row) => computeCP(base, ivs, row.multiplier) === targetCP);
  }

  /**
   * Find the level that brings this Pokémon AS CLOSE AS POSSIBLE to a
   * league CP cap WITHOUT exceeding it (cap itself is allowed: 1500 is
   * legal for Great League, 1501 is not).
   *
   * CP grows monotonically with level, so the answer is simply the
   * highest level whose CP is <= cap. When several levels share that CP
   * the highest level wins (same CP, better real stats).
   *
   * @param {{attack:number, defense:number, stamina:number}} base
   * @param {{atk:number, def:number, hp:number}} ivs
   * @param {number} cap - league CP cap (e.g. 1500, 2500)
   * @param {Array<{level:number, multiplier:number}>} cpmTable - sorted by level
   * @returns {{level:number, cp:number}|null} null if even level 1 exceeds the cap
   */
  function bestLevelForCap(base, ivs, cap, cpmTable) {
    let best = null;
    for (const row of cpmTable) {
      const cp = computeCP(base, ivs, row.multiplier);
      if (cp > cap) break; // monotonic: everything after also exceeds
      best = { level: row.level, cp };
    }
    return best;
  }

  /**
   * Validate an IV value: integer within 0..15.
   * @returns {boolean}
   */
  function isValidIV(value) {
    return Number.isInteger(value) && value >= 0 && value <= 15;
  }

  // Public API
  return { computeCP, computeStats, findLevelsForCP, bestLevelForCap, isValidIV };

})();
