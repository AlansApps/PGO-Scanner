/* ==========================================================================
   ivbars.js — read IV values from the appraisal bars in a screenshot

   How the game draws IVs (no numbers anywhere!):
     * Three horizontal bars stacked vertically: Attack, Defense, HP.
     * Each bar is split into 3 blocks separated by small white gaps.
     * Each block represents 5 IV points -> full bar = 15.
     * Filled portion is ORANGE; a maxed stat (15/15) turns the whole
       bar RED/PINK; the unfilled portion is LIGHT GRAY.

   Strategy (pure pixel analysis, no ML):
     1. Classify every pixel as fill (orange/red), empty (gray) or other.
     2. Scan rows for long horizontal runs of bar-colored pixels
        (allowing small white gaps = the block separators).
     3. Group adjacent rows into bar rectangles.
     4. Keep a vertical stack of exactly 3 aligned bars.
     5. IV = round( filledPixels / (filledPixels + emptyPixels) * 15 ).

   All color thresholds live in COLOR so they are easy to calibrate
   against real screenshots (different devices / brightness).
   ========================================================================== */

'use strict';

const IvBars = (() => {

  // ---- Tunable parameters (calibrated against real screenshots) ---------
  const CONFIG = {
    maxAnalysisWidth: 1400, // downscale larger images for speed
    rowStep: 2,             // analyze every Nth row
    minBarWidthRatio: 0.18, // a bar must span >= 18% of image width
    maxGapRatio: 0.035,     // max white gap inside a bar (block separators)
    minBarRows: 2,          // min sampled rows to accept a bar rectangle
    xAlignTolerance: 0.03,  // bars must be left/right aligned within 3% width
    maxBarSpacingRatio: 0.12, // max vertical distance between stacked bars
    minBarYRatio: 0.35,     // ignore candidates above this fraction of height
  };

  // Color classifiers. Game palette (approx.):
  //   orange fill ~ rgb(255,160,65) | red "maxed" fill ~ rgb(240,125,115)
  //   empty gray  ~ rgb(230,230,230) on a white card (~rgb(250+))
  const COLOR = {
    isOrange: (r, g, b) => r >= 190 && g >= 95 && g <= 205 && b <= 130 && (r - b) >= 80 && r > g && g > b,
    isRed:    (r, g, b) => r >= 195 && g >= 60 && g <= 165 && b >= 60 && b <= 165 && (r - g) >= 55 && Math.abs(g - b) <= 45,
    isGray:   (r, g, b) => {
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      return min >= 200 && max <= 242 && (max - min) <= 14;
    },
    isWhite:  (r, g, b) => Math.min(r, g, b) >= 243,
  };

  // Pixel classes
  const PX = { OTHER: 0, FILL: 1, EMPTY: 2, WHITE: 3 };

  /** Classify one pixel into a PX class. */
  function classifyPixel(r, g, b) {
    if (COLOR.isOrange(r, g, b) || COLOR.isRed(r, g, b)) return PX.FILL;
    if (COLOR.isGray(r, g, b)) return PX.EMPTY;
    if (COLOR.isWhite(r, g, b)) return PX.WHITE;
    return PX.OTHER;
  }

  /**
   * Find horizontal bar-like segments in a single pixel row.
   * A segment is a run of FILL/EMPTY pixels where interruptions
   * (white block separators) are shorter than maxGap. Red fill pixels
   * are counted separately: a RED bar is the game's maxed-stat (15)
   * rendering, and telling red from orange decides 14 vs 15.
   * @returns {Array<{x0:number, x1:number, fill:number, red:number, empty:number}>}
   */
  function findRowSegments(data, width, y, maxGap, minLen) {
    const segments = [];
    let seg = null;
    let gap = 0;

    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const cls = classifyPixel(r, g, b);

      if (cls === PX.FILL || cls === PX.EMPTY) {
        if (!seg) seg = { x0: x, x1: x, fill: 0, red: 0, empty: 0 };
        seg.x1 = x;
        gap = 0;
        if (cls === PX.FILL) {
          seg.fill++;
          if (COLOR.isRed(r, g, b)) seg.red++;
        } else {
          seg.empty++;
        }
      } else if (seg && gap < maxGap) {
        // Tolerate short interruptions: white block separators AND
        // anti-aliased edge pixels between color zones.
        gap++;
      } else {
        if (seg && (seg.x1 - seg.x0) >= minLen) segments.push(seg);
        seg = null;
        gap = 0;
      }
    }
    if (seg && (seg.x1 - seg.x0) >= minLen) segments.push(seg);
    return segments;
  }

  /**
   * Group row segments (from consecutive rows) into bar rectangles.
   * Segments belong to the same bar when their x-ranges overlap heavily
   * and they are on adjacent sampled rows.
   */
  function groupSegmentsIntoBars(rowsWithSegments, width) {
    const bars = []; // {x0, x1, y0, y1, fill, empty, rows}
    const tol = width * CONFIG.xAlignTolerance;

    for (const { y, segments } of rowsWithSegments) {
      for (const seg of segments) {
        // Try to extend an existing bar whose last row is directly above.
        const bar = bars.find(
          (b) =>
            y - b.y1 <= CONFIG.rowStep &&
            Math.abs(b.x0 - seg.x0) <= tol &&
            Math.abs(b.x1 - seg.x1) <= tol
        );
        if (bar) {
          bar.y1 = y;
          bar.fill += seg.fill;
          bar.red += seg.red;
          bar.empty += seg.empty;
          bar.rows++;
        } else {
          bars.push({ x0: seg.x0, x1: seg.x1, y0: y, y1: y, fill: seg.fill, red: seg.red, empty: seg.empty, rows: 1 });
        }
      }
    }

    return bars.filter((b) => b.rows >= CONFIG.minBarRows);
  }

  /**
   * From all candidate bars, find a stack of exactly 3 vertically
   * consecutive, x-aligned bars (Attack / Defense / HP).
   *
   * Bars above CONFIG.minBarYRatio of the image are ignored outright:
   * the CP text, status bar and background art near the top of the
   * screen can occasionally form a spurious "3 aligned bars" pattern
   * (observed: a red clock badge + gradient noise misread as a full
   * IV triplet). The real appraisal panel is always well below that
   * line in every screenshot/video layout seen so far.
   *
   * When several valid triplets remain, the WIDEST one wins (an
   * accidental match from thin noise is very unlikely to span as much
   * width as the real bars, which stretch most of the card).
   * @returns {Array<object>|null} the 3 bars top-to-bottom, or null
   */
  function findBarTriplet(bars, width, height) {
    const tol = width * CONFIG.xAlignTolerance;
    const maxSpacing = height * CONFIG.maxBarSpacingRatio;
    const minY = height * CONFIG.minBarYRatio;
    const sorted = bars.filter((b) => b.y0 >= minY).sort((a, b) => a.y0 - b.y0);

    let best = null;
    for (let i = 0; i < sorted.length - 2; i++) {
      const stack = [sorted[i]];
      for (let j = i + 1; j < sorted.length && stack.length < 3; j++) {
        const prev = stack[stack.length - 1];
        const cand = sorted[j];
        const aligned = Math.abs(cand.x0 - prev.x0) <= tol && Math.abs(cand.x1 - prev.x1) <= tol;
        const spacedOk = cand.y0 - prev.y1 > 0 && cand.y0 - prev.y1 <= maxSpacing;
        if (aligned && spacedOk) stack.push(cand);
      }
      if (stack.length === 3) {
        const width3 = stack[0].x1 - stack[0].x0;
        if (!best || width3 > best.width3) best = { stack, width3 };
      }
    }
    return best ? best.stack : null;
  }

  /**
   * Convert a bar's fill measurements into an IV value (0..15).
   * Color rules taught by real screenshots (see docs/IV-VISUAL-GUIDE.md):
   *   - a maxed stat (15) is ALWAYS a full RED bar;
   *   - an ORANGE bar is therefore never 15 -> capped at 14, even when
   *     the thin gray tip of a 14 gets lost at low resolutions;
   *   - any real orange at all is at least 1 -> the tiny sliver of an
   *     IV-1 must not be rounded away (Shinx 1/1/2 regression).
   */
  function barToIV(bar) {
    const total = bar.fill + bar.empty;
    if (total === 0) return null;
    const ratio = bar.fill / total;
    const mostlyRed = bar.red > bar.fill / 2;
    if (mostlyRed) return 15;
    if (bar.fill === 0 || ratio <= 0.005) return 0;
    return Math.max(1, Math.min(14, Math.round(ratio * 15)));
  }

  /**
   * Analyze a screenshot and extract the three IV values.
   * @param {HTMLCanvasElement|HTMLImageElement} source
   * @returns {{atk:number|null, def:number|null, hp:number|null,
   *            found:boolean, debug:object}}
   */
  function analyze(source) {
    // Draw (and possibly downscale) the source into a working canvas.
    const srcW = source.naturalWidth || source.width;
    const srcH = source.naturalHeight || source.height;
    const scale = Math.min(1, CONFIG.maxAnalysisWidth / srcW);
    const w = Math.round(srcW * scale);
    const h = Math.round(srcH * scale);

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(source, 0, 0, w, h);
    const { data } = ctx.getImageData(0, 0, w, h);

    // 1) Per-row segment detection
    const maxGap = Math.round(w * CONFIG.maxGapRatio);
    const minLen = Math.round(w * CONFIG.minBarWidthRatio);
    const rowsWithSegments = [];
    for (let y = 0; y < h; y += CONFIG.rowStep) {
      const segments = findRowSegments(data, w, y, maxGap, minLen);
      if (segments.length) rowsWithSegments.push({ y, segments });
    }

    // 2) Group into bars, 3) find the Attack/Defense/HP triplet
    const bars = groupSegmentsIntoBars(rowsWithSegments, w);
    const triplet = findBarTriplet(bars, w, h);

    if (!triplet) {
      return { atk: null, def: null, hp: null, found: false, debug: { barsDetected: bars.length } };
    }

    // 4) Bars are ordered top-to-bottom: Attack, Defense, HP
    const [atkBar, defBar, hpBar] = triplet;
    return {
      atk: barToIV(atkBar),
      def: barToIV(defBar),
      hp: barToIV(hpBar),
      found: true,
      debug: { barsDetected: bars.length, triplet },
    };
  }

  // Public API
  return { analyze, CONFIG, COLOR };

})();
