/* ==========================================================================
   app.js — UI wiring and application state

   Flow:
     upload (tap / drag&drop / photo library)
       -> Scanner.scanImage()
       -> editable result form (blank fields = not detected, fill manually)
       -> live "Calculated" panel (level + real stats) as fields change
       -> OK  -> entry saved to localStorage collection
   ========================================================================== */

'use strict';

(() => {

  const STORAGE_KEY = 'pgo-scanner-collection-v1';
  const LAST_BATCH_KEY = 'pgo-scanner-last-batch-v1';

  /**
   * Regional form -> display adjective. Any form in this map is shown
   * BOLD next to the name (e.g. "Raichu (Alolan)"); other non-Normal
   * forms (East Sea, Origin, ...) are shown in regular weight.
   */
  const REGIONAL_FORMS = {
    Alola: 'Alolan',
    Alolan: 'Alolan',
    Galarian: 'Galarian',
    Galar: 'Galarian',
    Hisuian: 'Hisuian',
    Hisui: 'Hisuian',
    Paldea: 'Paldean',
    Paldean: 'Paldean',
  };

  // ---- DOM references ----------------------------------------------------
  const $ = (id) => document.getElementById(id);

  const els = {
    dropZone: $('drop-zone'),
    uploadBtn: $('upload-btn'),
    fileInput: $('file-input'),
    dataStatus: $('data-status'),
    progressSection: $('progress-section'),
    progressLabel: $('progress-label'),
    progressBar: $('progress-bar'),
    resultSection: $('result-section'),
    resultCounter: $('result-counter'),
    resultThumb: $('result-thumb'),
    nameInput: $('f-name'),
    nameList: $('pokedex-names'),
    formSelect: $('f-form'),
    formNote: $('f-form-note'),
    cpInput: $('f-cp'),
    ivAtk: $('f-iv-atk'),
    ivDef: $('f-iv-def'),
    ivHp: $('f-iv-hp'),
    derivedPanel: $('derived-panel'),
    derivedContent: $('derived-content'),
    okBtn: $('ok-btn'),
    cancelBtn: $('cancel-btn'),
    collectionSection: $('collection-section'),
    collectionList: $('collection-list'),
    clearCollectionBtn: $('clear-collection-btn'),
  };

  /** Current scan being reviewed (null when no result is open). */
  let currentScan = null;

  /**
   * Review queue for scans that need manual completion: each entry is
   * reviewed one at a time with the result form. Fully-detected scans
   * skip this queue and go straight to the Scanned Pokémon list.
   */
  let reviewQueue = [];
  let reviewIndex = 0;

  /**
   * Id of the scan batch being processed/reviewed. Entries saved with
   * the LAST batch id get the "NEW" tag in the Scanned Pokémon list
   * (photo = 1 entry; video = every entry of that recording).
   */
  let currentBatchId = null;

  function getLastBatchId() {
    const raw = localStorage.getItem(LAST_BATCH_KEY);
    return raw ? parseInt(raw, 10) : null;
  }

  function setLastBatchId(id) {
    try { localStorage.setItem(LAST_BATCH_KEY, String(id)); } catch (_) { /* non-fatal */ }
  }

  // ---- Pokédex data bootstrap ---------------------------------------------

  async function initData() {
    els.dataStatus.textContent = 'Loading Pokédex data…';
    try {
      await Pokedex.load();
      // Populate the name autocomplete list once.
      const frag = document.createDocumentFragment();
      for (const name of Pokedex.names) {
        const opt = document.createElement('option');
        opt.value = name;
        frag.appendChild(opt);
      }
      els.nameList.appendChild(frag);
      els.dataStatus.textContent = `Pokédex ready — ${Pokedex.names.length} species loaded`;
      els.dataStatus.classList.remove('error');
      renderCollection(); // saved entries can now show their league rows
    } catch (err) {
      console.error('Pokédex load failed:', err);
      els.dataStatus.textContent = 'Could not load Pokédex data — check your internet connection and reload.';
      els.dataStatus.classList.add('error');
    }
  }

  // ---- Upload handling -----------------------------------------------------

  function bindUpload() {
    // Tap anywhere in the drop zone (or the button) opens the file picker.
    els.uploadBtn.addEventListener('click', (e) => { e.stopPropagation(); els.fileInput.click(); });
    els.dropZone.addEventListener('click', () => els.fileInput.click());
    els.dropZone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); els.fileInput.click(); }
    });

    els.fileInput.addEventListener('change', () => {
      if (els.fileInput.files.length) handleFile(els.fileInput.files[0]);
      els.fileInput.value = ''; // allow re-selecting the same file
    });

    // Desktop drag & drop
    els.dropZone.addEventListener('dragover', (e) => { e.preventDefault(); els.dropZone.classList.add('drag-over'); });
    els.dropZone.addEventListener('dragleave', () => els.dropZone.classList.remove('drag-over'));
    els.dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      els.dropZone.classList.remove('drag-over');
      if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
    });
  }

  /** True while a scan is running — blocks concurrent uploads. */
  let scanning = false;

  async function handleFile(file) {
    const isVideo = file.type.startsWith('video/');
    const isImage = file.type.startsWith('image/');
    if (!isVideo && !isImage) {
      alert('Unsupported file type. Please upload an image or video.');
      return;
    }
    if (!Pokedex.isLoaded) {
      alert('Pokédex data is still loading (or failed to load). Please wait a moment and try again.');
      return;
    }
    if (scanning) {
      alert('A scan is already running — please wait for it to finish.');
      return;
    }

    scanning = true;
    showProgress(0, 'Starting scan…');
    try {
      currentBatchId = Date.now();
      if (isVideo) {
        // Video: scan the whole recording. Fully-detected entries are
        // saved immediately; only incomplete ones are queued for review.
        const entries = await VideoScanner.scanVideo(file, showProgress);
        hideProgress();
        if (!entries.length) {
          alert('No Pokémon cards detected in this video. Make sure the appraisal bars are visible.');
          return;
        }
        reviewQueue = [];
        reviewIndex = 0;
        for (const e of entries) {
          if (!autoSaveIfComplete(e)) reviewQueue.push(e);
        }
        setLastBatchId(currentBatchId);
        renderCollection();
        if (reviewQueue.length) {
          showResult(reviewQueue[0]);
        } else {
          els.collectionSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      } else {
        // Photo: single result — auto-save when everything was detected.
        reviewQueue = [];
        reviewIndex = 0;
        const result = await Scanner.scanImage(file, showProgress);
        hideProgress();
        if (autoSaveIfComplete(result)) {
          setLastBatchId(currentBatchId);
          renderCollection();
          if (result.previewUrl) URL.revokeObjectURL(result.previewUrl);
          els.collectionSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
        } else {
          setLastBatchId(currentBatchId);
          showResult(result);
        }
      }
    } catch (err) {
      console.error('Scan failed:', err);
      hideProgress();
      alert('Scan failed: ' + err.message);
    } finally {
      scanning = false;
    }
  }

  /**
   * Save a scan without review when EVERYTHING was detected confidently:
   * species, resolved form, CP, all three IVs, and a level consistent
   * with that CP. Returns false when any piece is missing — the caller
   * then opens the review form for manual completion.
   * @param {object} scan - result from Scanner.scanImage / VideoScanner
   * @returns {boolean} true when saved automatically
   */
  function autoSaveIfComplete(scan) {
    if (!scan.name || !scan.form || !Number.isInteger(scan.cp) || scan.cp < 10) return false;
    const { atk, def, hp } = scan.ivs;
    if (!PgoCalc.isValidIV(atk) || !PgoCalc.isValidIV(def) || !PgoCalc.isValidIV(hp)) return false;

    const entry = { name: scan.name, form: scan.form, cp: scan.cp, ivs: scan.ivs };
    const levels = PgoCalc.findLevelsForCP(entry.form.base, entry.ivs, entry.cp, Pokedex.cpmTable);
    if (!levels.length) return false; // CP inconsistent — needs a human look

    saveEntry(entry);
    return true;
  }

  // ---- Progress UI -----------------------------------------------------------

  function showProgress(pct, label) {
    els.progressSection.classList.remove('hidden');
    els.progressBar.style.width = `${pct}%`;
    els.progressLabel.textContent = label;
  }

  function hideProgress() {
    els.progressSection.classList.add('hidden');
    els.progressBar.style.width = '0%';
  }

  // ---- Result form -------------------------------------------------------------

  /** Set an input's value; when null, leave blank and highlight for manual entry. */
  function setField(input, value) {
    if (value === null || value === undefined || value === '') {
      input.value = '';
      input.classList.add('needs-input');
    } else {
      input.value = value;
      input.classList.remove('needs-input');
    }
  }

  function showResult(scan) {
    currentScan = scan;
    els.resultThumb.src = scan.previewUrl;

    // Queue counter ("2 / 5") only while reviewing video results.
    els.resultCounter.textContent =
      reviewQueue.length > 1 ? `${reviewIndex + 1} / ${reviewQueue.length}` : '';

    setField(els.nameInput, scan.name);
    setField(els.cpInput, scan.cp);
    setField(els.ivAtk, scan.ivs.atk);
    setField(els.ivDef, scan.ivs.def);
    setField(els.ivHp, scan.ivs.hp);

    refreshFormOptions(scan.form ? scan.form.form : null);
    refreshDerived();

    els.resultSection.classList.remove('hidden');
    els.resultSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /** Rebuild the form/variant <select> for the current species name.
   *  Only functionally distinct forms are offered — cosmetic variants
   *  (Shellos East/West, costumes) never require a choice. */
  function refreshFormOptions(selectedForm) {
    const name = els.nameInput.value.trim();
    const forms = name ? Pokedex.getDistinctForms(name) : [];

    els.formSelect.innerHTML = '';
    if (!forms.length) {
      els.formSelect.appendChild(new Option('—', ''));
      els.formNote.textContent = name ? 'Unknown Pokémon name' : '';
      return;
    }

    for (const f of forms) {
      const label = `${f.form} (${f.types.join('/')})`;
      els.formSelect.appendChild(new Option(label, f.form));
    }

    if (selectedForm && forms.some((f) => f.form === selectedForm)) {
      els.formSelect.value = selectedForm;
      els.formSelect.classList.remove('needs-input');
      els.formNote.textContent = '';
    } else if (forms.length === 1) {
      els.formSelect.value = forms[0].form;
      els.formSelect.classList.remove('needs-input');
      els.formNote.textContent = '';
    } else {
      // Multiple forms and no confident auto-pick: force an explicit choice
      // (without this, the <select> silently defaults to its first option
      // and a wrong form could be saved unnoticed).
      els.formSelect.insertBefore(new Option('— choose form —', ''), els.formSelect.firstChild);
      els.formSelect.value = '';
      els.formSelect.classList.add('needs-input');
      els.formNote.textContent = 'Multiple forms exist — please choose';
    }
  }

  /** Read + validate the current form values. Returns null if incomplete. */
  function readForm() {
    const name = els.nameInput.value.trim();
    const formName = els.formSelect.value;
    const cp = parseInt(els.cpInput.value, 10);
    const ivs = {
      atk: parseInt(els.ivAtk.value, 10),
      def: parseInt(els.ivDef.value, 10),
      hp: parseInt(els.ivHp.value, 10),
    };

    const forms = Pokedex.getForms(name);
    const form = forms.find((f) => f.form === formName) || null;

    const valid =
      form &&
      Number.isInteger(cp) && cp >= 10 &&
      PgoCalc.isValidIV(ivs.atk) && PgoCalc.isValidIV(ivs.def) && PgoCalc.isValidIV(ivs.hp);

    return valid ? { name, form, cp, ivs } : null;
  }

  /** Recompute the "Calculated" panel (level + league ratings) from the form. */
  function refreshDerived() {
    const entry = readForm();
    if (!entry) {
      els.derivedPanel.classList.add('hidden');
      return;
    }

    const levels = PgoCalc.findLevelsForCP(entry.form.base, entry.ivs, entry.cp, Pokedex.cpmTable);
    const minCurrentLevel = levels.length ? Math.min(...levels.map((l) => l.level)) : null;

    // Row 1: named IVs + current level (several levels can share one CP).
    const levelText = levels.length
      ? levels.map((l) => l.level).join(' / ')
      : `⚠️ none matches CP ${entry.cp}`;
    let html =
      `<div class="stat-line">Atk <strong>${entry.ivs.atk}</strong> · ` +
      `Def <strong>${entry.ivs.def}</strong> · HP <strong>${entry.ivs.hp}</strong> — ` +
      `Level <strong>${levelText}</strong></div>`;

    // League ratings: one colored row for the scanned Pokémon and one per
    // future evolution. Evolutions keep level and IVs, so each stage is
    // rated with the same IVs and the same current-level constraint
    // (power-ups are one-way; power-downs don't exist). Max level for
    // maximizing toward a cap: 50 (user rule).
    const cpmMax50 = Pokedex.cpmTable.filter((r) => r.level <= 50);
    const stages = [entry.form, ...Pokedex.getEvolutionChain(entry.form)];

    for (const stage of stages) {
      const perLeague = [
        { name: 'Great', cap: 1500 },
        { name: 'Ultra', cap: 2500 },
      ].map(({ name, cap }) => {
        const best = PgoCalc.bestLevelForCap(stage.base, entry.ivs, cap, cpmMax50);
        const tier = PgoCalc.rateLeague(best, cap, entry.ivs, minCurrentLevel);
        return { name, best, tier };
      });

      // Row highlight = the BEST tier across the two leagues.
      const rowTier = perLeague.reduce((a, b) => (a.tier.rank >= b.tier.rank ? a : b)).tier;

      // Stage title: append the form only when it matters + gender req.
      let title = stage.name + formTitleHtml(stage.name, stage.form).replace(/<\/?strong>/g, '');
      if (stage.genderRequired) title += ` — ${stage.genderRequired.toLowerCase()} only`;

      // Pill format: "Great: BAD | 1495 (19)" = closest CP (target level).
      const chips = perLeague.map(({ name, best, tier }) => {
        const detail = best ? ` | ${best.cp} (${best.level})` : '';
        return `<span class="league-chip tier-${tier.key}">${name}: <strong>${tier.label}</strong>${detail}</span>`;
      }).join('');

      html += `<div class="evo-row tier-${rowTier.key}"><span class="evo-name">${title}</span>${chips}</div>`;
    }

    els.derivedContent.innerHTML = html;
    els.derivedPanel.classList.remove('hidden');
  }

  function bindForm() {
    els.nameInput.addEventListener('input', () => { refreshFormOptions(null); refreshDerived(); });
    els.formSelect.addEventListener('change', () => { els.formSelect.classList.remove('needs-input'); refreshDerived(); });
    for (const input of [els.cpInput, els.ivAtk, els.ivDef, els.ivHp]) {
      input.addEventListener('input', () => { input.classList.remove('needs-input'); refreshDerived(); });
    }

    els.okBtn.addEventListener('click', () => {
      const entry = readForm();
      if (!entry) {
        alert('Please complete all fields (Pokémon, form, CP and the three IVs) before saving.');
        return;
      }
      saveEntry(entry);
      advanceQueue();
    });

    // Discard skips the current result (and moves on when reviewing a video).
    els.cancelBtn.addEventListener('click', advanceQueue);
  }

  /** Show the next queued video result, or close the form if none is left. */
  function advanceQueue() {
    if (reviewIndex + 1 < reviewQueue.length) {
      reviewIndex++;
      showResult(reviewQueue[reviewIndex]);
    } else {
      reviewQueue = [];
      reviewIndex = 0;
      closeResult();
    }
  }

  function closeResult() {
    els.resultSection.classList.add('hidden');
    // Object URLs (photo scans) must be released; data URLs (video thumbs)
    // are ignored by revokeObjectURL, so this is safe for both.
    if (currentScan && currentScan.previewUrl) URL.revokeObjectURL(currentScan.previewUrl);
    currentScan = null;
  }

  // ---- Collection (saved scans) ------------------------------------------------

  function loadCollection() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
    } catch (_) {
      return [];
    }
  }

  function persistCollection(list) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    } catch (err) {
      console.warn('Could not persist collection:', err);
    }
  }

  function saveEntry(entry) {
    const list = loadCollection();
    const levels = PgoCalc.findLevelsForCP(entry.form.base, entry.ivs, entry.cp, Pokedex.cpmTable);
    list.unshift({
      // Random suffix: video batches can save several entries in one ms.
      id: `${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      batchId: currentBatchId,
      name: entry.name,
      form: entry.form.form,
      types: entry.form.types,
      cp: entry.cp,
      ivs: entry.ivs,
      levels: levels.map((l) => l.level),
      savedAt: new Date().toISOString(),
    });
    persistCollection(list);
    renderCollection();
  }

  function deleteEntry(id) {
    persistCollection(loadCollection().filter((e) => e.id !== id));
    renderCollection();
  }

  /**
   * Form suffix for display. Pokémon-world regional forms (different
   * types/stats) are shown BOLD; other functionally distinct forms
   * (Giratina Origin, Necrozma Dusk Mane, ...) shown in regular weight;
   * cosmetic-only variants (Shellos East/West, costumes, real-world
   * region colors) are hidden entirely.
   */
  function formTitleHtml(name, form) {
    if (!form || form === 'Normal') return '';
    const regional = REGIONAL_FORMS[form];
    if (regional) return ` <strong>(${regional})</strong>`;
    if (Pokedex.isLoaded && !Pokedex.hasSignificantForms(name)) return '';
    return ` (${form.replace(/_/g, ' ')})`;
  }

  /**
   * League rating rows (this Pokémon + every evolution) for one saved
   * entry. Recomputed at render time from live Pokédex data; returns ''
   * until the Pokédex has loaded.
   */
  function entryEvoRowsHtml(e) {
    if (!Pokedex.isLoaded) return '';
    const formEntry = Pokedex.getForms(e.name).find((f) => f.form === e.form);
    if (!formEntry) return '';

    const cpmMax50 = Pokedex.cpmTable.filter((r) => r.level <= 50);
    const minLevel = e.levels.length ? Math.min(...e.levels) : null;
    const stages = [formEntry, ...Pokedex.getEvolutionChain(formEntry)];

    let html = '';
    for (const stage of stages) {
      const perLeague = [
        { name: 'Great', cap: 1500 },
        { name: 'Ultra', cap: 2500 },
      ].map(({ name, cap }) => {
        const best = PgoCalc.bestLevelForCap(stage.base, e.ivs, cap, cpmMax50);
        const tier = PgoCalc.rateLeague(best, cap, e.ivs, minLevel);
        return { name, best, tier };
      });
      const rowTier = perLeague.reduce((a, b) => (a.tier.rank >= b.tier.rank ? a : b)).tier;

      let title = stage.name + formTitleHtml(stage.name, stage.form).replace(/<\/?strong>/g, '');
      if (stage.genderRequired) title += ` — ${stage.genderRequired.toLowerCase()} only`;

      // Pill format: "Great: BAD | 1495 (19)" = closest CP (target level).
      const chips = perLeague
        .map(({ name, best, tier }) => {
          const detail = best ? ` | ${best.cp} (${best.level})` : '';
          return `<span class="league-chip tier-${tier.key}">${name}: <strong>${tier.label}</strong>${detail}</span>`;
        })
        .join('');
      html += `<div class="evo-row evo-row-sm tier-${rowTier.key}"><span class="evo-name">${title}</span>${chips}</div>`;
    }
    return html;
  }

  function renderCollection() {
    const list = loadCollection();
    const lastBatch = getLastBatchId();
    els.collectionSection.classList.toggle('hidden', list.length === 0);
    els.collectionList.innerHTML = '';

    for (const e of list) {
      const li = document.createElement('li');
      li.className = 'collection-item';

      // Header: "Mankey (CP 679) - IVs 7/4/2 · Lvl: 24" (+ NEW badge)
      const header = document.createElement('div');
      header.className = 'ci-header';

      const title = document.createElement('div');
      title.className = 'ci-title';
      const lvl = e.levels.length ? e.levels.join('/') : '?';
      title.innerHTML =
        `<strong>${e.name}</strong>${formTitleHtml(e.name, e.form)} ` +
        `(CP ${e.cp}) - IVs ${e.ivs.atk}/${e.ivs.def}/${e.ivs.hp} · Lvl: ${lvl}`;
      if (e.batchId && e.batchId === lastBatch) {
        title.innerHTML += ' <span class="new-badge">NEW</span>';
      }

      const del = document.createElement('button');
      del.className = 'delete-btn';
      del.setAttribute('aria-label', `Delete ${e.name}`);
      del.textContent = '✕';
      del.addEventListener('click', () => deleteEntry(e.id));

      header.append(title, del);
      li.appendChild(header);

      // Body: colored league rows for the Pokémon and its evolutions.
      const evoHtml = entryEvoRowsHtml(e);
      if (evoHtml) {
        const body = document.createElement('div');
        body.className = 'ci-evos';
        body.innerHTML = evoHtml;
        li.appendChild(body);
      }

      els.collectionList.appendChild(li);
    }
  }

  function bindCollection() {
    els.clearCollectionBtn.addEventListener('click', () => {
      if (confirm('Clear the whole scanned list?')) {
        persistCollection([]);
        renderCollection();
      }
    });
  }

  // ---- Boot ------------------------------------------------------------------

  bindUpload();
  bindForm();
  bindCollection();
  renderCollection();
  initData();

})();
