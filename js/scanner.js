/* ==========================================================================
   scanner.js — orchestrates a full screenshot scan

   Pipeline for one image:
     1. Decode the file into an <img> / canvas.
     2. IV bars     -> pixel analysis (ivbars.js), no OCR involved.
     3. OCR         -> Tesseract.js reads all text in the image.
     4. Parse OCR   -> CP (top of screen), species name (fuzzy match
                       against the Pokédex), type words (to pick the form).

   Design rule: if any value cannot be extracted CONFIDENTLY it is
   returned as null — the UI then leaves that field blank for the user.
   ========================================================================== */

'use strict';

const Scanner = (() => {

  const OCR_MAX_WIDTH = 1200; // downscale before OCR for speed on mobile

  // CP band: where the big "CP####" text lives, relative to screen size.
  // Deliberately excludes the status bar (clock! "08:59" reads as 859)
  // and the top corners (white circle / clouds create fake digits).
  const CP_BAND = {
    x: 0.28, w: 0.44,      // horizontal: center 44% of the screen
    y: 0.04, h: 0.07,      // vertical: just below the status bar
    scale: 3,              // upscale for better glyph recognition
    whiteThreshold: 215,   // min RGB channel value to count as "white text"
  };

  // Name band: the species/nickname line on the white card.
  const NAME_BAND = {
    x: 0.15, w: 0.70,
    y: 0.38, h: 0.09,
    scale: 3,
  };

  // HP band: the "118 / 118 HP" line under the green HP bar. The max HP
  // is a strong cross-check: CP + IVs + shown HP must agree on a level.
  const HP_BAND = {
    x: 0.28, w: 0.44,
    y: 0.452, h: 0.035,
    scale: 4,
    darkThreshold: 180, // dark gray digits on white card
  };

  // Type band: the label line with the type word(s) ("GHOST / FLYING"),
  // measured at y ~0.605-0.628 of the screen. The right side is often
  // covered by the trainer avatar — truncated words are handled by
  // fuzzy type matching (Pokedex.detectTypesInText).
  const TYPE_BAND = {
    x: 0.10, w: 0.75,
    y: 0.59, h: 0.05,
    scale: 6,
    darkThreshold: 180, // label text is gray: lum < this -> black
  };

  /**
   * Hook the current scan can set to surface OCR engine setup progress.
   * On a phone's first scan Tesseract downloads ~15 MB (wasm core +
   * language data) — without feedback that looks like a frozen app.
   */
  let ocrSetupHook = null;

  /** Lazily-created shared Tesseract worker (creating one is expensive). */
  let workerPromise = null;
  function getWorker() {
    if (!workerPromise) {
      workerPromise = Tesseract.createWorker('eng', 1, {
        logger: (m) => {
          if (!ocrSetupHook || !m.status) return;
          // Statuses before recognition = engine setup (downloads etc.)
          if (m.status !== 'recognizing text') {
            const pct = typeof m.progress === 'number' ? ` ${Math.round(m.progress * 100)}%` : '';
            ocrSetupHook(`Preparing OCR engine (first scan only)…${pct}`);
          }
        },
      });
    }
    return workerPromise;
  }

  // ---- File decoding -----------------------------------------------------

  /** Decode an image File/Blob into an HTMLImageElement. */
  function fileToImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => resolve(img); // URL revoked by caller after use
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not decode image file.')); };
      img.src = url;
    });
  }

  /** Draw an image onto a canvas, downscaling to maxWidth if needed. */
  function imageToCanvas(img, maxWidth) {
    const scale = Math.min(1, maxWidth / img.naturalWidth);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  // ---- OCR parsing helpers ------------------------------------------------

  /**
   * Read the CP value with a dedicated OCR pass. The big "CP####" at the
   * top of the screen uses a stylized white outline font that a plain
   * full-image OCR pass usually misses. This pass:
   *   1. Crops only the CP band (excluding the status bar — the phone
   *      clock "08:59" otherwise gets read as CP 859!).
   *   2. Upscales it and binarizes it: near-white pixels (the glyphs)
   *      become black text on a white background.
   *   3. OCRs that with a digits-only whitelist in single-line mode.
   * Calibrated against real iPhone screenshots (see CALIBRATION.md).
   * @returns {Promise<number|null>}
   */
  async function ocrCPBand(source, whiteThreshold = CP_BAND.whiteThreshold) {
    // A stricter threshold (e.g. 235) suppresses bright-background noise
    // such as the light rays behind Lucky Pokémon cards.
    const canvas = cropBand(source, CP_BAND, whiteThreshold);

    const worker = await getWorker();
    await worker.setParameters({
      tessedit_char_whitelist: '0123456789CP',
      tessedit_pageseg_mode: '7', // single text line
    });
    const { data } = await worker.recognize(canvas);

    // Prefer the TALLEST word containing digits: the CP glyphs dominate
    // the band, while leftover background noise OCRs as small blobs.
    const words = (data.words || []).filter((w) => w.bbox && /\d/.test(w.text));
    words.sort((a, b) => (b.bbox.y1 - b.bbox.y0) - (a.bbox.y1 - a.bbox.y0));
    const text = words.length ? words[0].text : (data.text || '');

    const m = text.replace(/[CP]/gi, '').match(/\d{1,4}/);
    if (!m) return null;
    const cp = parseInt(m[0], 10);
    return cp >= 10 && cp <= 9999 ? cp : null;
  }

  /**
   * Read the species name from the name band (dedicated single-line OCR,
   * fuzzy-matched against the Pokédex). Faster than a full-image pass and
   * the primary method for video frames.
   * @returns {Promise<string|null>} canonical species name, or null
   */
  async function ocrNameBand(source) {
    const canvas = cropBand(source, NAME_BAND, 0);

    const worker = await getWorker();
    await worker.setParameters({
      tessedit_char_whitelist: '',
      tessedit_pageseg_mode: '7', // single text line
    });
    const { data } = await worker.recognize(canvas);

    // Pokedex.matchName() already normalizes accents internally (NFD
    // strip), so pass the raw OCR text straight through — filtering to
    // ASCII here would mangle accented names first (e.g. "Flabébé"
    // -> "Flabb", unrecognizable). Only trim whitespace/newlines.
    const raw = (data.text || '').replace(/\s+/g, ' ').trim();
    const match = Pokedex.matchName(raw);
    return match ? match.name : null;
  }

  /**
   * Read the displayed max HP from the "118 / 118 HP" line.
   * @returns {Promise<number|null>} the max HP (second number), or null
   */
  async function ocrHpBand(source) {
    const canvas = cropBand(source, HP_BAND, 0);

    // Binarize for DARK text on the white card.
    const ctx = canvas.getContext('2d');
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = imageData.data;
    for (let i = 0; i < d.length; i += 4) {
      const lum = (d[i] + d[i + 1] + d[i + 2]) / 3;
      const v = lum < HP_BAND.darkThreshold ? 0 : 255;
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    ctx.putImageData(imageData, 0, 0);

    const worker = await getWorker();
    await worker.setParameters({
      tessedit_char_whitelist: '0123456789/HP ',
      tessedit_pageseg_mode: '7',
    });
    const { data } = await worker.recognize(canvas);

    const m = (data.text || '').match(/(\d{1,4})\s*\/\s*(\d{1,4})/);
    if (!m) return null;
    const hp = parseInt(m[2], 10);
    return hp >= 10 && hp <= 999 ? hp : null;
  }

  /**
   * Read the type word(s) from the type row ("POISON / FLYING") and
   * return the recognized type names plus whether a "/" separator was
   * seen (proof of two types, even when the second word is illegible —
   * used to disambiguate regional forms in video scans; photos use the
   * full-image pass instead).
   * @returns {Promise<{types: Array<string>, twoTypes: boolean}>}
   */
  async function ocrTypeBand(source) {
    const canvas = cropBand(source, TYPE_BAND, 0);

    // Binarize for DARK text: the gray labels sit on a pale gradient.
    const ctx = canvas.getContext('2d');
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = imageData.data;
    for (let i = 0; i < d.length; i += 4) {
      const lum = (d[i] + d[i + 1] + d[i + 2]) / 3;
      const v = lum < TYPE_BAND.darkThreshold ? 0 : 255;
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    ctx.putImageData(imageData, 0, 0);

    const worker = await getWorker();
    await worker.setParameters({
      tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ/ ',
      tessedit_pageseg_mode: '7', // single text line
    });
    const { data } = await worker.recognize(canvas);
    const text = data.text || '';
    return { types: Pokedex.detectTypesInText(text), twoTypes: Pokedex.detectTypeSeparator(text) };
  }

  // Icon row: the colored circle(s) shown just above the type WORD(S) —
  // same row the trainer avatar usually clips, but the icon itself often
  // survives when the word doesn't. Last-resort fallback for when text
  // OCR of the type band found NOTHING at all.
  const ICON_BAND = {
    x: 0.10, w: 0.75,
    y: 0.555, h: 0.045,
    scale: 1, // no OCR here, just color sampling — no need to upscale
  };

  // Approximate hue (0-360) of each type's badge icon. Only Grass (~90)
  // and Water have been directly measured from real screenshots so far
  // (see CALIBRATION.md "Known issues" — icon color is a first pass,
  // background blending was found to shift hue noticeably, e.g. a real
  // Water icon measured ~159 instead of a "pure" blue ~205-210). Normal,
  // Dark and Steel are deliberately excluded: their icons render close to
  // gray on screen, so hue alone can't tell them apart from background —
  // safer to never guess those than to risk a confident wrong pick.
  const TYPE_HUE = {
    Fire: 20, Electric: 48, Grass: 90, Water: 205, Ice: 190,
    Fighting: 8, Poison: 300, Ground: 32, Flying: 235, Psychic: 322,
    Bug: 75, Rock: 42, Ghost: 272, Dragon: 185, Fairy: 335,
  };

  /** Shortest distance between two hues on the 360-degree color wheel. */
  function hueDistance(a, b) {
    const diff = Math.abs(a - b) % 360;
    return diff > 180 ? 360 - diff : diff;
  }

  /** RGB (0-255 each) -> hue in degrees. Caller must already know sat > 0. */
  function rgbToHue(r, g, b, max, min, sat) {
    let h;
    if (max === r) h = 60 * (((g - b) / sat) % 6);
    else if (max === g) h = 60 * (((b - r) / sat) + 2);
    else h = 60 * (((r - g) / sat) + 4);
    return h < 0 ? h + 360 : h;
  }

  /**
   * Find the dominant saturated hue within a pixel region, ignoring
   * near-neutral background/gradient pixels. Returns null if too few
   * saturated pixels are found (no confident color blob present) —
   * a conservative gate so a plain gradient never gets misread as a type.
   */
  function dominantHue(d, w, h, x0, x1) {
    const MIN_SAT = 40; // below this, treat as background, not an icon
    const buckets = new Map();
    for (let y = 0; y < h; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * w + x) * 4;
        const r = d[i], g = d[i + 1], b = d[i + 2];
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        const sat = max - min;
        if (sat < MIN_SAT) continue;
        const hue = rgbToHue(r, g, b, max, min, sat);
        const bucket = Math.round(hue / 15) * 15;
        const entry = buckets.get(bucket) || { count: 0, sumHue: 0 };
        entry.count++;
        entry.sumHue += hue;
        buckets.set(bucket, entry);
      }
    }
    let best = null;
    for (const entry of buckets.values()) {
      if (!best || entry.count > best.count) best = entry;
    }
    if (!best || best.count < 10) return null; // no confident color blob
    return best.sumHue / best.count;
  }

  /**
   * Match a measured hue against a SPECIFIC species' candidate types only
   * (never the full 18-type table) — e.g. for Grimer, only {Poison, Dark}
   * are ever considered, so an unreliable global classifier isn't needed:
   * we only need to be closer to one candidate than the others. Types with
   * no reliable hue (Normal/Dark/Steel, see TYPE_HUE) never match.
   * Requires a clear margin (>=30°) over the next-best candidate, else
   * returns null rather than guessing between two close candidates.
   */
  function matchHueAmongCandidates(hue, candidateTypeNames) {
    const scored = candidateTypeNames
      .filter((t) => TYPE_HUE[t] != null)
      .map((t) => ({ type: t, dist: hueDistance(hue, TYPE_HUE[t]) }))
      .sort((a, b) => a.dist - b.dist);
    if (!scored.length || scored[0].dist > 40) return null;
    const runnerUpDist = scored[1] ? scored[1].dist : Infinity;
    if (runnerUpDist - scored[0].dist < 30) return null;
    return scored[0].type;
  }

  /**
   * Last-resort type fallback: read the icon CIRCLE color(s) instead of
   * the text label, for use only when text OCR of the type band found
   * NOTHING (see ocrTypeBand). Splits the icon row in half (a dual-typed
   * card shows two icons side by side); two halves with clearly distinct
   * hues prove two types even when neither hue can be confidently named
   * (e.g. one of them is Dark/Steel/Normal, whose icons are near-gray).
   * @param {HTMLCanvasElement|HTMLVideoElement|HTMLImageElement} source
   * @param {Array<string>} candidateTypeNames - union of types across the
   *        species' candidate forms; narrows matching to just these.
   * @returns {{types: Array<string>, twoTypes: boolean}}
   */
  function ocrTypeIcons(source, candidateTypeNames) {
    const canvas = cropBand(source, ICON_BAND, 0);
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    const imageData = ctx.getImageData(0, 0, w, h);
    const d = imageData.data;
    const midX = Math.floor(w / 2);

    const leftHue = dominantHue(d, w, h, 0, midX);
    const rightHue = dominantHue(d, w, h, midX, w);

    const types = [];
    const leftType = leftHue != null ? matchHueAmongCandidates(leftHue, candidateTypeNames) : null;
    const rightType = rightHue != null ? matchHueAmongCandidates(rightHue, candidateTypeNames) : null;
    if (leftType) types.push(leftType);
    if (rightType && rightType !== leftType) types.push(rightType);

    const twoTypes = leftHue != null && rightHue != null && hueDistance(leftHue, rightHue) > 40;

    return { types, twoTypes };
  }

  /**
   * Crop a relative band out of an image/canvas, upscale it, and
   * optionally binarize it (near-white pixels -> black on white).
   * @param {HTMLImageElement|HTMLCanvasElement|HTMLVideoElement} source
   * @param {{x:number, y:number, w:number, h:number, scale:number}} band
   * @param {number} whiteThreshold - 0 disables binarization
   * @returns {HTMLCanvasElement}
   */
  function cropBand(source, band, whiteThreshold) {
    const W = source.naturalWidth || source.videoWidth || source.width;
    const H = source.naturalHeight || source.videoHeight || source.height;
    const sx = Math.round(W * band.x), sw = Math.round(W * band.w);
    const sy = Math.round(H * band.y), sh = Math.round(H * band.h);

    const canvas = document.createElement('canvas');
    canvas.width = sw * band.scale;
    canvas.height = sh * band.scale;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(source, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);

    if (whiteThreshold > 0) {
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const d = imageData.data;
      for (let i = 0; i < d.length; i += 4) {
        const v = (d[i] >= whiteThreshold && d[i + 1] >= whiteThreshold && d[i + 2] >= whiteThreshold) ? 0 : 255;
        d[i] = d[i + 1] = d[i + 2] = v;
      }
      ctx.putImageData(imageData, 0, 0);
    }
    return canvas;
  }

  /**
   * Fallback CP extraction from the full-image OCR text: an explicit
   * "CP####" pattern (accepts common OCR confusions O->0, l/I->1).
   * @returns {number|null}
   */
  function parseCPFromText(ocrText) {
    const cleaned = ocrText.replace(/[OoQ]/g, '0').replace(/[lI|]/g, '1');
    const m = cleaned.match(/[CG]P\s*([0-9]{2,4})/i);
    if (!m) return null;
    const cp = parseInt(m[1], 10);
    return cp >= 10 && cp <= 9999 ? cp : null;
  }

  /**
   * Extract the species name: fuzzy-match every plausible OCR line
   * against the Pokédex and keep the best hit. Nicknamed Pokémon will
   * simply not match (returns null -> user fills the field manually).
   * @returns {string|null} canonical species display name
   */
  function parseName(ocrText) {
    let best = null;
    for (const rawLine of ocrText.split('\n')) {
      const line = rawLine.trim();
      // Plausible name: 3-15 chars, mostly letters, not a stat/type line.
      if (line.length < 3 || line.length > 15) continue;
      if (/\d{2,}/.test(line)) continue;

      const match = Pokedex.matchName(line);
      if (match && (!best || match.distance < best.distance)) best = match;
      if (best && best.distance === 0) break;
    }
    return best ? best.name : null;
  }

  // ---- Main entry point ----------------------------------------------------

  /**
   * Scan one screenshot.
   * @param {File} file - image file selected by the user
   * @param {(pct:number, label:string)=>void} [onProgress]
   * @returns {Promise<{name:string|null, form:object|null, types:string[],
   *                    cp:number|null, ivs:{atk:number|null, def:number|null, hp:number|null},
   *                    previewUrl:string}>}
   */
  async function scanImage(file, onProgress = () => {}) {
    onProgress(5, 'Loading image…');
    const img = await fileToImage(file);
    const previewUrl = img.src; // object URL, reused as thumbnail by the UI

    // --- IV bars (fast, pure pixels) ---
    onProgress(15, 'Reading IV bars…');
    const ivResult = IvBars.analyze(img);

    // --- OCR pass 1: dedicated CP band (fast, small crop) ---
    onProgress(25, 'Reading CP…');
    ocrSetupHook = (label) => onProgress(30, label); // engine download feedback
    let cp = null;
    try {
      cp = await ocrCPBand(img);
    } catch (err) {
      console.warn('CP band OCR failed:', err);
    } finally {
      ocrSetupHook = null;
    }

    // --- OCR pass 2: full image, for name and type words ---
    onProgress(45, 'Reading text (OCR)…');
    const ocrCanvas = imageToCanvas(img, OCR_MAX_WIDTH);
    const worker = await getWorker();
    await worker.setParameters({
      tessedit_char_whitelist: '', // no restriction for the full pass
      tessedit_pageseg_mode: '3',  // fully automatic segmentation
    });
    const { data } = await worker.recognize(ocrCanvas);

    onProgress(95, 'Interpreting…');
    const text = data.text || '';

    // --- Interpret OCR output ---
    if (cp === null) cp = parseCPFromText(text); // fallback
    const name = parseName(text);
    // Full-page text is noisy (HP fraction, catch-location caption), so
    // only trust EXACT type-word matches from it — fuzzy/truncated
    // matching and "/" separator detection are only safe against the
    // narrow, position-anchored type-row crop (see ocrTypeBand/
    // detectTypeSeparator warnings), fetched below when needed.
    let detectedTypes = Pokedex.detectTypesInText(text, false);

    // Resolve the form (Normal / Alolan / Galarian / Hisuian / ...).
    // Only FUNCTIONALLY distinct forms are considered — cosmetic-only
    // variants (Shellos East/West, costumes) collapse automatically.
    let form = null;
    if (name) {
      const forms = Pokedex.getDistinctForms(name);
      let types = detectedTypes, twoTypesFinal = false;
      if (forms.length > 1) {
        // Multiple real forms: re-read the type row with the dedicated
        // narrow crop, which tolerates truncated/misread words and "/"
        // detection safely (unlike the full page).
        const band = await ocrTypeBand(img);
        types = [...new Set([...types, ...band.types])];
        twoTypesFinal = band.twoTypes;
        if (!types.length && !twoTypesFinal) {
          // Text OCR found nothing at all — last resort: the icon color(s).
          const candidateTypes = [...new Set(forms.flatMap((f) => f.types))];
          const icons = ocrTypeIcons(img, candidateTypes);
          types = icons.types;
          twoTypesFinal = icons.twoTypes;
        }
      }
      form = Pokedex.pickFormByTypes(forms, types, twoTypesFinal ? 2 : null);
      detectedTypes = types;
    }

    onProgress(100, 'Done');
    return {
      name,
      form,
      types: detectedTypes,
      cp,
      ivs: { atk: ivResult.atk, def: ivResult.def, hp: ivResult.hp },
      ivBarsFound: ivResult.found,
      previewUrl,
    };
  }

  /**
   * Scan a single still frame (used by the video scanner): IV bars +
   * CP band + name band. No full-image OCR pass (too slow per frame),
   * so type words are not extracted — the form is only auto-resolved
   * when the species has exactly one form.
   * @param {HTMLCanvasElement|HTMLVideoElement|HTMLImageElement} source
   */
  async function scanFrame(source) {
    const iv = IvBars.analyze(source);
    const cp = await ocrCPBand(source);
    const name = await ocrNameBand(source);

    let form = null;
    if (name) {
      const forms = Pokedex.getDistinctForms(name);
      if (forms.length === 1) {
        form = forms[0];
      } else if (forms.length > 1) {
        // Multiple real forms: read the type row to pick (e.g. Grimer
        // "POISON" = Normal vs Alolan "POISON / DARK"). A "/" alone proves
        // two types even when the second word is illegible.
        let { types, twoTypes } = await ocrTypeBand(source);
        if (!types.length && !twoTypes) {
          // Text OCR found nothing at all — last resort: the icon color(s).
          const candidateTypes = [...new Set(forms.flatMap((f) => f.types))];
          const icons = ocrTypeIcons(source, candidateTypes);
          types = icons.types;
          twoTypes = icons.twoTypes;
        }
        form = Pokedex.pickFormByTypes(forms, types, twoTypes ? 2 : null);
      }
    }

    return {
      name,
      form,
      cp,
      ivs: { atk: iv.atk, def: iv.def, hp: iv.hp },
      ivBarsFound: iv.found,
    };
  }

  /** Let callers (e.g. the video scanner) receive OCR setup progress. */
  function setOcrSetupHook(fn) { ocrSetupHook = fn; }

  // Public API (band OCR helpers are reused by the video scanner)
  return { scanImage, scanFrame, ocrCPBand, ocrNameBand, ocrHpBand, ocrTypeBand, ocrTypeIcons, setOcrSetupHook };

})();
