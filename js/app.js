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
   * Review queue for video scans: each detected Pokémon is reviewed
   * one at a time with the same result form used for photos.
   */
  let reviewQueue = [];
  let reviewIndex = 0;

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
      if (isVideo) {
        // Video: scan the whole recording, then review each result in turn.
        const entries = await VideoScanner.scanVideo(file, showProgress);
        hideProgress();
        if (!entries.length) {
          alert('No Pokémon cards detected in this video. Make sure the appraisal bars are visible.');
          return;
        }
        reviewQueue = entries;
        reviewIndex = 0;
        showResult(reviewQueue[0]);
      } else {
        // Photo: single result.
        reviewQueue = [];
        reviewIndex = 0;
        const result = await Scanner.scanImage(file, showProgress);
        hideProgress();
        showResult(result);
      }
    } catch (err) {
      console.error('Scan failed:', err);
      hideProgress();
      alert('Scan failed: ' + err.message);
    } finally {
      scanning = false;
    }
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

  /** Rebuild the form/variant <select> for the current species name. */
  function refreshFormOptions(selectedForm) {
    const name = els.nameInput.value.trim();
    const forms = name ? Pokedex.getForms(name) : [];

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

  /** Recompute the "Calculated" panel (level + league targets) from the form. */
  function refreshDerived() {
    const entry = readForm();
    if (!entry) {
      els.derivedPanel.classList.add('hidden');
      return;
    }

    const levels = PgoCalc.findLevelsForCP(entry.form.base, entry.ivs, entry.cp, Pokedex.cpmTable);

    // Row 1: named IVs + current level (several levels can share one CP).
    const levelText = levels.length
      ? levels.map((l) => l.level).join(' / ')
      : `⚠️ none matches CP ${entry.cp}`;
    let html =
      `<div class="stat-line">Atk <strong>${entry.ivs.atk}</strong> · ` +
      `Def <strong>${entry.ivs.def}</strong> · HP <strong>${entry.ivs.hp}</strong> — ` +
      `Level <strong>${levelText}</strong></div>`;

    // Rows 2-3: the level that gets closest to each league cap WITHOUT
    // exceeding it (exactly 1500/2500 is allowed) and the resulting CP.
    // Power-ups are one-way, so if the Pokémon is already above that
    // level the league is out of reach; levels above 40 need XL Candy
    // and 50.5/51 exist only with a Best Buddy boost.
    const minCurrentLevel = levels.length ? Math.min(...levels.map((l) => l.level)) : null;
    const leagues = [
      { label: 'Great League', cap: 1500 },
      { label: 'Ultra League', cap: 2500 },
    ];
    for (const { label, cap } of leagues) {
      const best = PgoCalc.bestLevelForCap(entry.form.base, entry.ivs, cap, Pokedex.cpmTable);
      if (!best) {
        html += `<div class="stat-line">${label}: over ${cap} CP even at level 1</div>`;
        continue;
      }
      let note = '';
      if (minCurrentLevel !== null && minCurrentLevel > best.level) {
        note = " ⚠️ already above — can't power down";
      } else if (best.level > 50) {
        note = ' (Best Buddy)';
      } else if (best.level > 40) {
        note = ' (XL Candy)';
      }
      html += `<div class="stat-line">${label}: Level <strong>${best.level}</strong> → CP <strong>${best.cp}</strong>${note}</div>`;
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
      id: Date.now(),
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

  function renderCollection() {
    const list = loadCollection();
    els.collectionSection.classList.toggle('hidden', list.length === 0);
    els.collectionList.innerHTML = '';

    for (const e of list) {
      const li = document.createElement('li');
      li.className = 'collection-item';

      const info = document.createElement('div');
      const title = document.createElement('div');
      title.className = 'mon-name';
      title.textContent = `${e.name}${e.form && e.form !== 'Normal' ? ` (${e.form})` : ''} — CP ${e.cp}`;
      const meta = document.createElement('div');
      meta.className = 'mon-meta';
      const lvl = e.levels.length ? `L${e.levels.join('/')}` : 'level?';
      meta.textContent = `IVs ${e.ivs.atk}/${e.ivs.def}/${e.ivs.hp} · ${lvl} · ${e.types.join('/')}`;
      info.append(title, meta);

      const del = document.createElement('button');
      del.className = 'delete-btn';
      del.setAttribute('aria-label', `Delete ${e.name}`);
      del.textContent = '✕';
      del.addEventListener('click', () => deleteEntry(e.id));

      li.append(info, del);
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
