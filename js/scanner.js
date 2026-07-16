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
   * Extract the CP value. In-game the CP is the big "CP2757" at the very
   * top, in a stylized font OCR often mangles. Two strategies, in order:
   *   a) regex "CP <digits>" anywhere in the text (also accepts cp/Cp and
   *      common OCR confusions O->0, l/I->1);
   *   b) the numerically largest 2-4 digit number found in words located
   *      in the TOP 20% of the image (using word bounding boxes).
   * @returns {number|null}
   */
  function parseCP(ocrText, words, imageHeight) {
    // Strategy (a): explicit "CP####" pattern
    const cleaned = ocrText.replace(/[OoQ]/g, '0').replace(/[lI|]/g, '1');
    const m = cleaned.match(/[CG]P\s*([0-9]{2,4})/i);
    if (m) {
      const cp = parseInt(m[1], 10);
      if (cp >= 10 && cp <= 9999) return cp;
    }

    // Strategy (b): biggest number near the top of the screenshot
    let best = null;
    for (const w of words) {
      if (!w.bbox || w.bbox.y0 > imageHeight * 0.2) continue;
      const digits = w.text.replace(/[OoQ]/g, '0').replace(/[lI|]/g, '1').replace(/[^0-9]/g, '');
      if (digits.length >= 2 && digits.length <= 4) {
        const cp = parseInt(digits, 10);
        if (cp >= 10 && cp <= 9999 && (best === null || cp > best)) best = cp;
      }
    }
    return best;
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

    // --- OCR (slow part) ---
    onProgress(25, 'Reading text (OCR)…');
    const ocrCanvas = imageToCanvas(img, OCR_MAX_WIDTH);
    const { data } = await Tesseract.recognize(ocrCanvas, 'eng', {
      logger: (msg) => {
        if (msg.status === 'recognizing text') {
          onProgress(25 + Math.round(msg.progress * 65), 'Reading text (OCR)…');
        }
      },
    });

    onProgress(95, 'Interpreting…');
    const words = data.words || [];
    const text = data.text || '';

    // --- Interpret OCR output ---
    const cp = parseCP(text, words, ocrCanvas.height);
    const name = parseName(text);
    const detectedTypes = Pokedex.detectTypesInText(text);

    // Resolve the form (Normal / Alolan / Galarian / Hisuian / ...)
    let form = null;
    if (name) {
      const forms = Pokedex.getForms(name);
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

  // Public API
  return { scanImage };

})();
