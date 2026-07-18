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
  async function ocrCPBand(source) {
    const canvas = cropBand(source, CP_BAND, CP_BAND.whiteThreshold);

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

    const raw = (data.text || '').replace(/[^A-Za-z' .-]/g, '').trim();
    const match = Pokedex.matchName(raw);
    return match ? match.name : null;
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
    const detectedTypes = Pokedex.detectTypesInText(text);

    // Resolve the form (Normal / Alolan / Galarian / Hisuian / ...).
    // Only FUNCTIONALLY distinct forms are considered — cosmetic-only
    // variants (Shellos East/West, costumes) collapse automatically.
    let form = null;
    if (name) {
      const forms = Pokedex.getDistinctForms(name);
      form = Pokedex.pickFormByTypes(forms, detectedTypes);
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
      if (forms.length === 1) form = forms[0];
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
  return { scanImage, scanFrame, ocrCPBand, ocrNameBand, setOcrSetupHook };

})();
