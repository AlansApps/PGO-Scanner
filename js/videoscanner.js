/* ==========================================================================
   videoscanner.js — scan a screen-recording video for multiple Pokémon

   Intended use: the user opens a Pokémon's card in-game, records the
   screen, and swipes left/right through several Pokémon. This module
   finds every "settled" card in the recording and scrapes each one
   exactly like a photo.

   Pipeline:
     1. Sample the video every SAMPLE_STEP seconds.
     2. On every sampled frame run the (fast, pixel-only) IV bar analysis.
        A frame with a valid bar triplet = a card is on screen.
     3. Group CONSECUTIVE frames with identical IV triplets. A group with
        >= MIN_STABLE_FRAMES frames is a settled card (swipe transitions
        produce unstable/absent readings and break groups naturally).
     4. For each stable group, OCR name + CP on its middle frame
        (Scanner.scanFrame). IVs come from the group itself.
     5. Merge adjacent duplicates (same name, CP and IVs) that can appear
        if a bar reading flickered mid-card. IMPORTANT: the same species
        appearing again with different CP or IVs is a DIFFERENT Pokémon
        and is kept as its own entry.
   ========================================================================== */

'use strict';

const VideoScanner = (() => {

  const SAMPLE_STEP = 0.4;      // seconds between analyzed frames
  const MIN_STABLE_FRAMES = 2;  // frames with identical IVs to accept a card

  /** Load a video file and resolve when its metadata (size/duration) is ready. */
  function fileToVideo(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.onloadedmetadata = () => resolve(video);
      video.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not decode video file.')); };
      video.src = url;
    });
  }

  /** Seek the video to a time and resolve once the frame is available. */
  function seekTo(video, t) {
    return new Promise((resolve) => {
      video.onseeked = () => resolve();
      video.currentTime = t;
    });
  }

  /**
   * Decide the CP from several per-frame OCR readings.
   *
   * Rules, in order:
   *   1. A value read on >= 2 frames wins (moving background noise like
   *      bubbles corrupts single frames, but rarely the same way twice) —
   *      as long as it is plausible.
   *   2. Otherwise, if exactly ONE distinct reading is plausible for this
   *      species + IVs (i.e. some level produces that CP), take it. This
   *      rescues cases like readings [1128, 128]: 1128 is impossible,
   *      128 is the real CP.
   *   3. Otherwise return null -> the field stays blank for manual entry.
   *
   * Plausibility is only a sanity FILTER on OCR candidates; it never
   * invents or modifies a value.
   */
  function decideCP(reads, name, ivs) {
    const nonNull = reads.filter((r) => r !== null);
    if (!nonNull.length) return null;

    // A CP is plausible if any form of the species can reach it at some level.
    const forms = name ? Pokedex.getForms(name) : [];
    const isPlausible = (cp) =>
      !forms.length ||
      forms.some((f) => PgoCalc.findLevelsForCP(f.base, ivs, cp, Pokedex.cpmTable).length > 0);

    // Rule 1: majority
    const counts = new Map();
    for (const r of nonNull) counts.set(r, (counts.get(r) || 0) + 1);
    let majority = null;
    for (const [value, count] of counts) {
      if (count >= 2 && (majority === null || count > counts.get(majority))) majority = value;
    }
    if (majority !== null && isPlausible(majority)) return majority;

    // Rule 2: unique plausible candidate
    const plausible = [...counts.keys()].filter(isPlausible);
    return plausible.length === 1 ? plausible[0] : null;
  }

  /**
   * Scan a whole video.
   * @param {File} file - video file selected by the user
   * @param {(pct:number, label:string)=>void} [onProgress]
   * @returns {Promise<Array<{name:string|null, form:object|null, cp:number|null,
   *           ivs:{atk:number,def:number,hp:number}, time:number, previewUrl:string}>>}
   */
  async function scanVideo(file, onProgress = () => {}) {
    onProgress(2, 'Loading video…');
    const video = await fileToVideo(file);
    const W = video.videoWidth, H = video.videoHeight, D = video.duration;
    if (!W || !H || !isFinite(D)) throw new Error('Unsupported or corrupted video.');

    const frame = document.createElement('canvas');
    frame.width = W;
    frame.height = H;
    const ctx = frame.getContext('2d', { willReadFrequently: true });

    // ---- Pass 1: IV bars on every sampled frame -------------------------
    const samples = []; // {t, ivs:[a,d,h]|null}
    const totalSteps = Math.ceil(D / SAMPLE_STEP);
    let step = 0;
    for (let t = 0; t < D; t += SAMPLE_STEP) {
      await seekTo(video, Math.min(t, D - 0.01));
      ctx.drawImage(video, 0, 0, W, H);
      const r = IvBars.analyze(frame);
      samples.push({ t, ivs: r.found ? [r.atk, r.def, r.hp] : null });
      step++;
      onProgress(2 + Math.round((step / totalSteps) * 48), 'Detecting Pokémon cards…');
    }

    // ---- Pass 2: group consecutive identical IV readings -----------------
    const groups = [];
    for (const s of samples) {
      const key = s.ivs ? s.ivs.join('/') : null;
      const last = groups[groups.length - 1];
      if (key && last && last.key === key) {
        last.tEnd = s.t;
        last.count++;
      } else {
        groups.push({ key, ivs: s.ivs, tStart: s.t, tEnd: s.t, count: 1 });
      }
    }
    const stable = groups.filter((g) => g.key && g.count >= MIN_STABLE_FRAMES);

    // ---- Pass 3: OCR name + CP for each stable group ----------------------
    const entries = [];
    for (let i = 0; i < stable.length; i++) {
      const g = stable[i];
      onProgress(50 + Math.round(((i + 1) / stable.length) * 48), `Reading Pokémon ${i + 1} of ${stable.length}…`);

      const tMid = (g.tStart + g.tEnd) / 2;
      const ivs = { atk: g.ivs[0], def: g.ivs[1], hp: g.ivs[2] };

      // Name once, on the middle frame (also used for the thumbnail).
      await seekTo(video, tMid);
      ctx.drawImage(video, 0, 0, W, H);
      const previewUrl = frame.toDataURL('image/jpeg', 0.7);
      const name = await Scanner.ocrNameBand(frame);
      const cpReads = [await Scanner.ocrCPBand(frame)];

      // CP on two more frames of the group; decideCP votes among them.
      for (const t of [g.tStart, g.tEnd]) {
        if (t === tMid) continue;
        await seekTo(video, t);
        ctx.drawImage(video, 0, 0, W, H);
        cpReads.push(await Scanner.ocrCPBand(frame));
      }
      const cp = decideCP(cpReads, name, ivs);

      // Resolve the form only when the species has exactly one
      // FUNCTIONALLY distinct form (cosmetic variants collapse; video
      // frames skip the full-image type OCR — too slow per frame).
      let form = null;
      if (name) {
        const forms = Pokedex.getDistinctForms(name);
        if (forms.length === 1) form = forms[0];
      }

      entries.push({ name, form, cp, ivs, time: tMid, previewUrl });
    }

    // ---- Pass 4: merge adjacent exact duplicates --------------------------
    // (bar flicker can split one card into two identical groups)
    const deduped = [];
    for (const e of entries) {
      const prev = deduped[deduped.length - 1];
      const same = prev && prev.name === e.name && prev.cp === e.cp &&
        prev.ivs.atk === e.ivs.atk && prev.ivs.def === e.ivs.def && prev.ivs.hp === e.ivs.hp;
      if (!same) deduped.push(e);
    }

    URL.revokeObjectURL(video.src);
    onProgress(100, 'Done');
    return deduped;
  }

  // Public API
  return { scanVideo, SAMPLE_STEP, MIN_STABLE_FRAMES };

})();
