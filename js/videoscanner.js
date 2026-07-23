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
  const REFINE_STEP = 0.15;     // fine-grained step for boundary refinement
  const REFINE_MAX_EXTEND = 0.8; // max seconds to extend a boundary, each side

  /** Load a video file and resolve when its metadata (size/duration) is ready. */
  function fileToVideo(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.preload = 'auto';
      video.onloadedmetadata = () => resolve(video);
      video.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not decode video file.')); };
      video.src = url;
    });
  }

  /**
   * Kickstart the decode pipeline. iOS/WebKit may never deliver frames
   * (or 'seeked' events) for a video that has not started playing at
   * least once; a muted inline play+pause is allowed without a user
   * gesture and unblocks seeking. No-op where unnecessary.
   */
  async function primeVideo(video) {
    try {
      await video.play();
      video.pause();
      video.currentTime = 0;
    } catch (_) { /* non-fatal: desktop browsers seek fine without it */ }
  }

  /**
   * Seek the video to a time and resolve once the frame is available.
   * Resolves on WHICHEVER fires first:
   *   - 'seeked' (fast and reliable on desktop browsers),
   *   - requestVideoFrameCallback (the signal iOS/WebKit actually
   *     delivers — it often drops 'seeked' on paused videos),
   *   - a hard 2s timeout, so a missed event can NEVER hang the scan
   *     (worst case one stale frame gets analyzed).
   */
  function seekTo(video, t) {
    return new Promise((resolve) => {
      // No-op seek (already at t): no event will fire — resolve now.
      if (Math.abs(video.currentTime - t) < 0.001) { resolve(); return; }

      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        video.onseeked = null;
        resolve();
      };
      const timer = setTimeout(done, 2000);
      video.onseeked = done;
      if (typeof video.requestVideoFrameCallback === 'function') {
        video.requestVideoFrameCallback(() => done());
      }
      video.currentTime = t;
    });
  }

  /**
   * Refine a stable group's [tStart, tEnd] with a FINE-GRAINED (0.1s+)
   * IV-bar recheck, extending outward from the coarse SAMPLE_STEP-grid
   * boundary until the reading no longer matches the group's IV key.
   *
   * Why: the coarse 0.4s grid used to FIND groups often undersamples
   * how long a card is actually stable on screen — real viewing time
   * gets missed on either side, exactly the time OCR would most like to
   * read (bars settle, or motion blur clears, well before the nearest
   * 0.4s tick lands "inside" the detected window). Confirmed on a real
   * video: a group detected as a 0.4s window was actually stable for a
   * full 0.8s once checked at 0.1s resolution, and every failed CP read
   * in that case came from the missed portion.
   *
   * This is bounded on TWO independent levels so it can never bleed
   * into an adjacent card:
   *   1. It stops the instant the bar reading no longer matches —
   *      normally sufficient, since a different card reads different
   *      IVs.
   *   2. It is ALSO hard-capped at `prevBoundary`/`nextBoundary` (the
   *      immediate neighboring group's own tEnd/tStart from Pass 1,
   *      including groups too short to qualify as "stable" — a brief
   *      transition blip still marks a real boundary). This guards the
   *      rare but real case of two DIFFERENT adjacent Pokémon sharing
   *      the exact same IV spread by coincidence, where check #1 alone
   *      would happily read straight through into the next card and
   *      corrupt the name/CP with a mix of both (confirmed on a real
   *      video: a Stufful/Dewpider pair with matching bars produced a
   *      "Stufful" entry carrying Dewpider's IVs before this cap was
   *      added).
   *
   * Cost: cheap (pixel-only IvBars.analyze(), no OCR) and bounded by
   * REFINE_MAX_EXTEND with early-exit on the first mismatch, so groups
   * whose coarse boundary was already accurate cost nothing extra.
   */
  async function refineGroupBounds(video, ctx, frame, W, H, group, prevBoundary, nextBoundary) {
    let start = group.tStart;
    let end = group.tEnd;

    const backLimit = Math.max(0, prevBoundary, group.tStart - REFINE_MAX_EXTEND);
    for (let t = group.tStart - REFINE_STEP; t >= backLimit; t -= REFINE_STEP) {
      await seekTo(video, t);
      ctx.drawImage(video, 0, 0, W, H);
      const r = IvBars.analyze(frame);
      if (!r.found || [r.atk, r.def, r.hp].join('/') !== group.key) break;
      start = t;
    }

    const forwardLimit = Math.min(nextBoundary, group.tEnd + REFINE_MAX_EXTEND);
    for (let t = group.tEnd + REFINE_STEP; t <= forwardLimit; t += REFINE_STEP) {
      await seekTo(video, t);
      ctx.drawImage(video, 0, 0, W, H);
      const r = IvBars.analyze(frame);
      if (!r.found || [r.atk, r.def, r.hp].join('/') !== group.key) break;
      end = t;
    }

    return { tStart: start, tEnd: end };
  }

  /**
   * Most frequent non-null value among per-frame reads, requiring at
   * least minCount occurrences (agreement across frames). Returns null
   * when nothing reaches the threshold.
   */
  function majorityValue(reads, minCount = 2) {
    const counts = new Map();
    for (const r of reads) {
      if (r !== null && r !== undefined) counts.set(r, (counts.get(r) || 0) + 1);
    }
    let best = null;
    for (const [value, count] of counts) {
      if (count >= minCount && (best === null || count > counts.get(best))) best = value;
    }
    return best;
  }

  /** Alias with name-specific semantics (see majorityValue). */
  function majorityName(reads, minCount) {
    return majorityValue(reads, minCount);
  }

  /**
   * Decide the CP from several per-frame OCR readings.
   *
   * Plausibility is checked first: a CP is plausible only if some form
   * of the species reaches it at some level, and — when the shown max
   * HP was also read — that SAME level reproduces that HP too. This
   * cross-check (does any level explain BOTH independently-read numbers
   * at once?) kills the vast majority of OCR misreads outright (e.g. a
   * CP that only fits at level 1 while the HP says level 16, or a
   * Lucky-card glare turning CP 540 into 1540).
   *
   * Among whatever remains plausible, the value read on the most frames
   * wins (ties broken by whichever was seen first). This handles both
   * a clean majority (e.g. 644 read 3 times) AND a single lucky read
   * among mostly-corrupted frames (e.g. reads [644, 1644, null, 64,
   * null] where only 644 survives the plausibility filter) with the
   * same logic, rather than two separate all-or-nothing rules.
   *
   * Returns null (blank field, never a guess) when no read is plausible.
   */
  function decideCP(reads, name, ivs, hpShown = null) {
    const nonNull = reads.filter((r) => r !== null);
    if (!nonNull.length) return null;

    const forms = name ? Pokedex.getForms(name) : [];
    const isPlausible = (cp) =>
      !forms.length ||
      forms.some((f) =>
        PgoCalc.findLevelsForCP(f.base, ivs, cp, Pokedex.cpmTable).some((row) =>
          hpShown === null ||
          Math.max(Math.floor((f.base.stamina + ivs.hp) * row.multiplier), 10) === hpShown
        )
      );

    const counts = new Map();
    for (const r of nonNull) counts.set(r, (counts.get(r) || 0) + 1);

    // Among plausible candidates, the most-voted one wins; a genuine
    // tie between two DIFFERENT plausible values is rare (the math
    // cross-check already rejects most noise) but ambiguous when it
    // happens — blank out rather than arbitrarily pick one.
    let best = null;
    let bestCount = 0;
    let tied = false;
    for (const [value, count] of counts) {
      if (!isPlausible(value)) continue;
      if (count > bestCount) { best = value; bestCount = count; tied = false; }
      else if (count === bestCount && value !== best) { tied = true; }
    }
    return tied ? null : best;
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
    await primeVideo(video); // required on iOS before seeking works

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
    // First OCR call may download the engine (~15 MB) — show progress.
    Scanner.setOcrSetupHook((label) => onProgress(50, label));
    const entries = [];
    for (let i = 0; i < stable.length; i++) {
      const g = stable[i];
      onProgress(50 + Math.round(((i + 1) / stable.length) * 48), `Reading Pokémon ${i + 1} of ${stable.length}…`);

      const tMid = (g.tStart + g.tEnd) / 2;
      const ivs = { atk: g.ivs[0], def: g.ivs[1], hp: g.ivs[2] };

      // Sample times spread across the group: every field is read on
      // SEVERAL frames and decided by voting — a moving/compressed
      // video corrupts single frames far too often to trust one read.
      // Start with 3 frames; when any field fails to reach agreement,
      // ADAPTIVELY sample 2 more and re-vote.
      //
      // NAME and HP are read ONLY within the ORIGINAL coarse [g.tStart,
      // g.tEnd] window — never widened. This is deliberate: a wrong CP
      // is safe (the HP+level cross-check below blanks it out), but a
      // WRONG SPECIES NAME is not — it silently changes which base
      // stats validate the rest of the entry. Confirmed on a real
      // video: widening the name-read window let it occasionally pick
      // up the NEXT card's name during the hand-off (name text can
      // finish transitioning before the IV bars do), producing a
      // real Pokémon's IVs mislabeled with an adjacent one's name.
      const baseTimes = [...new Set([g.tStart, tMid, g.tEnd])];
      const extraTimes = [...new Set([
        g.tStart + (g.tEnd - g.tStart) * 0.25,
        g.tStart + (g.tEnd - g.tStart) * 0.75,
      ])].filter((t) => !baseTimes.includes(t));

      const nameReads = [];
      const cpReads = [];
      const hpReads = [];
      let previewUrl = null;
      const readFrame = async (t) => {
        await seekTo(video, t);
        ctx.drawImage(video, 0, 0, W, H);
        if (previewUrl === null || t === tMid) previewUrl = frame.toDataURL('image/jpeg', 0.7);
        nameReads.push(await Scanner.ocrNameBand(frame));
        cpReads.push(await Scanner.ocrCPBand(frame));
        hpReads.push(await Scanner.ocrHpBand(frame));
      };
      for (const t of baseTimes) await readFrame(t);

      const decideFields = () => ({
        name: majorityName(nameReads, nameReads.length > 1 ? 2 : 1),
        hpShown: majorityValue(hpReads, 2),
        cpMajority: majorityValue(cpReads, 2),
      });
      let fields = decideFields();
      if ((!fields.name || fields.cpMajority === null || fields.hpShown === null) && extraTimes.length) {
        for (const t of extraTimes) await readFrame(t);
        fields = decideFields();
      }

      // Name: even though reads are Pokédex-validated, a single read
      // among several is not trusted for DISPLAY (early/transition
      // frames produce junk that can fuzzy-match some species) —
      // require agreement. A lone read still serves as a HINT for the
      // CP plausibility filter (better one probable species than none).
      const name = fields.name;
      const nameHint = name || majorityValue(nameReads, 1);

      // Shown max HP: strong cross-check for the CP decision below.
      const hpShown = fields.hpShown;

      // CP escalation gets a WIDER window than name/HP: the coarse 0.4s
      // grid used to find groups often undersamples how long a card is
      // actually stable on screen, and CP text can stay perfectly
      // readable well before/after the nearest 0.4s tick lands "inside"
      // the detected window. This is safe to widen — unlike a wrong
      // name, a wrong CP can never silently corrupt the entry: it must
      // pass the level+HP plausibility check below to be accepted at
      // all. Bounded by the immediate neighbors in the FULL (unfiltered)
      // groups list, including short/null ones, so it can never read
      // into a genuinely different card even if it coincidentally
      // shares this one's exact IV reading.
      const groupIdx = groups.indexOf(g);
      const prevBoundary = groupIdx > 0 ? groups[groupIdx - 1].tEnd : 0;
      const nextBoundary = groupIdx < groups.length - 1 ? groups[groupIdx + 1].tStart : D;
      const refined = await refineGroupBounds(video, ctx, frame, W, H, g, prevBoundary, nextBoundary);
      const cpTimes = [...new Set([refined.tStart, (refined.tStart + refined.tEnd) / 2, refined.tEnd])];

      // CP: vote + plausibility (CP AND shown HP must agree on a level).
      // When that fails, ESCALATE in two ways:
      //   a) a stricter binarization pass (kills the light rays behind
      //      Lucky cards that OCR as extra digits, e.g. CP 540 -> 1540);
      //   b) DENSER independent sampling across the whole refined window.
      //      Video seeking is not perfectly deterministic frame-to-frame
      //      (a cold seek straight to one timestamp can occasionally
      //      decode a slightly different frame than a sequential seek
      //      through nearby timestamps would have) — sampling more
      //      points inside the same "stable" window gives more chances
      //      for a clean read to outvote a corrupted one.
      // With NO species at all the CP cannot be validated — leave it
      // blank rather than trust an unverifiable OCR number.
      // Escalation thresholds beyond the default (215): 235 (stricter —
      // kills Lucky-card light-ray glare that adds phantom digits) and
      // 195 (more lenient — some cards' CP glyphs render with lower
      // contrast than the default expects and are invisible at 215+;
      // confirmed on a real video: a CP that read null at every
      // threshold from 210 up read cleanly as "38" at 195, and matched
      // the shown HP at no other candidate value). Neither direction
      // universally wins, so both are tried.
      const ESCALATION_THRESHOLDS = [235, 195];

      // Every escalation tier checks decideCP after each SAMPLE POINT
      // (not after every single read) and stops as soon as it succeeds —
      // most cards resolve in tier 1 or early in tier 2, and only a
      // genuinely hard card burns through the full dense sweep. Without
      // this, every group that needs any escalation always pays for the
      // ENTIRE sweep even after the answer is already certain, which
      // made a hard video take minutes instead of seconds.
      let cp = null;
      if (nameHint) {
        cp = decideCP(cpReads, nameHint, ivs, hpShown);

        if (cp === null) {
          for (const t of cpTimes) {
            await seekTo(video, t);
            ctx.drawImage(video, 0, 0, W, H);
            for (const th of ESCALATION_THRESHOLDS) cpReads.push(await Scanner.ocrCPBand(frame, th));
            cp = decideCP(cpReads, nameHint, ivs, hpShown);
            if (cp !== null) break;
          }
        }

        if (cp === null) {
          // Cast a wide net across the whole refined window at every
          // threshold: for some cards a single threshold is unreadable
          // across the ENTIRE window while a different one reads
          // cleanly throughout — tier 2 only checked 3 narrow points,
          // easy to miss the readable stretch on a card with this
          // failure mode.
          const span = refined.tEnd - refined.tStart;
          const denseStep = Math.max(0.1, span / 6);
          for (let t = refined.tStart; t <= refined.tEnd; t += denseStep) {
            if (cpTimes.includes(t)) continue;
            await seekTo(video, t);
            ctx.drawImage(video, 0, 0, W, H);
            cpReads.push(await Scanner.ocrCPBand(frame));
            for (const th of ESCALATION_THRESHOLDS) cpReads.push(await Scanner.ocrCPBand(frame, th));
            cp = decideCP(cpReads, nameHint, ivs, hpShown);
            if (cp !== null) break;
          }
        }
      }

      // Form: cosmetic variants collapse automatically; when several
      // REAL forms exist, read the type row across the sampled frames
      // and pick by the union of detected types (Grimer "POISON" =
      // Normal vs Alolan "POISON / DARK").
      let form = null;
      if (name) {
        const forms = Pokedex.getDistinctForms(name);
        if (forms.length === 1) {
          form = forms[0];
        } else if (forms.length > 1) {
          // Type-band reading stays on the SAFE coarse window too, for
          // the same reason as name: no strong cross-check exists for
          // it, so it must not risk picking up an adjacent card's type.
          const types = new Set();
          let twoTypesSeen = false;
          for (const t of baseTimes) {
            await seekTo(video, t);
            ctx.drawImage(video, 0, 0, W, H);
            const r = await Scanner.ocrTypeBand(frame);
            for (const ty of r.types) types.add(ty);
            if (r.twoTypes) twoTypesSeen = true;
          }
          if (!types.size && !twoTypesSeen) {
            // Text OCR found nothing on ANY sampled frame — last resort:
            // the icon color(s), tried on the same safe frames.
            const candidateTypes = [...new Set(forms.flatMap((f) => f.types))];
            for (const t of baseTimes) {
              await seekTo(video, t);
              ctx.drawImage(video, 0, 0, W, H);
              const r = Scanner.ocrTypeIcons(frame, candidateTypes);
              for (const ty of r.types) types.add(ty);
              if (r.twoTypes) twoTypesSeen = true;
            }
          }
          // A "/" seen on ANY sampled frame is proof of two types, even if
          // only one type WORD was ever legible (e.g. Grimer's "Dark" stays
          // hidden behind the trainer avatar the whole time).
          form = Pokedex.pickFormByTypes(forms, [...types], twoTypesSeen ? 2 : null);
        }
      }

      entries.push({ name, form, cp, ivs, time: tMid, previewUrl, frames: g.count });
    }

    // ---- Pass 4: merge adjacent duplicates and animation/transition artifacts
    // Exact duplicates: bar flicker can split one card into two groups.
    // Artifacts (two kinds, same signature): close in time, IVs either
    // monotonically below the settled group or within a small delta,
    // and crucially SHORT (few stable frames) vs. a really-viewed card
    // holding for longer:
    //   1. Animation ramp — bars fill up/overshoot when the panel opens.
    //   2. Transition blip — a card's OWN coarse [tStart, tEnd] window
    //      can happen to straddle the swipe into the NEXT card: the bars
    //      briefly read a blurry/transitional value distinct from both
    //      neighbors' settled keys, AND the name text can finish
    //      switching before the bars do — so a short artifact group's
    //      name is unreliable even when it reads as a real species
    //      (confirmed on a real video: a 2-frame blip mid-swipe read
    //      as "Wimpod" while its bars showed the PRECEDING Stufful's
    //      real IVs). For this reason a SHORT group's name is NOT
    //      trusted for the compatibility check — only a longer,
    //      genuinely-settled group's name is. Two long groups are
    //      never merged regardless of IV closeness: the same species
    //      seen twice with similar IVs is two real Pokémon, and by the
    //      time both sides are long enough to trust, their names are
    //      too.
    const compatible = (a, b) => {
      const eitherShort = a.frames <= SHORT || b.frames <= SHORT;
      const nameOk = eitherShort || !a.name || !b.name || a.name === b.name;
      return nameOk &&
        (a.cp === null || b.cp === null || a.cp === b.cp) &&
        (b.time - a.time) <= 6;
    };
    const ivsClose = (a, b) => {
      const monotone = a.ivs.atk <= b.ivs.atk && a.ivs.def <= b.ivs.def && a.ivs.hp <= b.ivs.hp;
      const small = Math.max(
        Math.abs(a.ivs.atk - b.ivs.atk),
        Math.abs(a.ivs.def - b.ivs.def),
        Math.abs(a.ivs.hp - b.ivs.hp)
      ) <= 3;
      return monotone || small;
    };
    const SHORT = 2; // groups this short are animation-artifact suspects

    // A THIRD artifact signature, distinct from ivsClose above: the bar
    // ANIMATION itself (opening overshoot, or the previous card's bars
    // still sliding toward this one's) can land on an intermediate value
    // that is NOT close to the settled IVs at all — confirmed on a real
    // video (18.15.14): an Eevee's bars briefly read (9,9,14) for two
    // consecutive coarse samples (its own "stable" group, count 2)
    // immediately before settling on the true (1,2,14) for the next two
    // samples (also count 2) — both groups equally SHORT, and the IV gap
    // (8, 7) far exceeds ivsClose's tolerance, so neither existing rule
    // catches it. The decisive signal here isn't IV distance at all: the
    // WRONG group's CP could never resolve (no level reproduces CP+shown
    // HP with those IVs — this is exactly what decideCP's plausibility
    // check already rejected), while the RIGHT group's CP resolved
    // cleanly. When two same-named, time-adjacent groups split exactly
    // this way — one with a validated CP, the other CP-blank — the
    // blank one is almost certainly the same physical card caught
    // mid-transition, so it's dropped in favor of the validated one
    // rather than kept as a separate, confusing blank entry.
    const oneCpResolvedOtherDidnt = (a, b) => (a.cp === null) !== (b.cp === null);

    const deduped = [];
    for (const e of entries) {
      const prev = deduped[deduped.length - 1];
      if (prev) {
        const exactDup = prev.name === e.name && prev.cp === e.cp &&
          prev.ivs.atk === e.ivs.atk && prev.ivs.def === e.ivs.def && prev.ivs.hp === e.ivs.hp;
        if (exactDup) continue;
        if (compatible(prev, e) && ivsClose(prev, e) &&
            (prev.frames <= SHORT) !== (e.frames <= SHORT)) {
          // Keep the settled (longer) group, drop the artifact.
          if (prev.frames <= SHORT) deduped[deduped.length - 1] = e;
          continue;
        }
        if (compatible(prev, e) && oneCpResolvedOtherDidnt(prev, e)) {
          // Keep whichever side has the math-validated CP, drop the
          // CP-blank one — see comment above.
          if (prev.cp === null) deduped[deduped.length - 1] = e;
          continue;
        }
      }
      deduped.push(e);
    }

    Scanner.setOcrSetupHook(null);
    URL.revokeObjectURL(video.src);
    onProgress(100, 'Done');
    return deduped;
  }

  // Public API
  return { scanVideo, SAMPLE_STEP, MIN_STABLE_FRAMES };

})();
