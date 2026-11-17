/* NCTD Manifest Parser — front end (vanilla JS + Tabulator) */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const I18N = JSON.parse($('i18nData').textContent);
  const OUTPUT_COLUMNS = JSON.parse($('outputColumns').textContent);
  const FROZEN = ['Vendor ID', 'Leg ID'];
  const SEARCH_FIELDS = ['First Name', 'Last Name', 'Tobi MRN'];
  // v2.8.3 CATALOG-STORAGE-001: 'csv' (upload) or 'dynamodb' (catalog in the database)
  const CATALOG = JSON.parse($('catalogConfig').textContent);
  const DB = CATALOG.mode !== 'csv';

  const state = {
    lang: document.documentElement.lang || 'es',
    viajes: null, // { uploadId, filename, rowCount, tripDates }
    pasajeros: null,
    changedDate: null, // 'YYYY-MM-DD' once "Cambiar la fecha" was applied
    job: null,
    dbCatalog: null, // database mode: { count, legIdV2 } once the catalog was read
    rememberedUntil: null, // v2.9.0: this computer is remembered until (ISO)
    messages: {}, // element id -> { key, vars, kind }
  };

  // ---------- i18n ----------
  function t(key, vars) {
    const dict = I18N[state.lang] || I18N.es;
    const text = dict[key] != null ? dict[key] : key;
    return String(text).replace(/\{(\w+)\}/g, (m, k) => (vars && k in vars ? vars[k] : m));
  }

  function applyI18n() {
    document.documentElement.lang = state.lang;
    document.title = t('app.title');
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      if (el.dataset.i18nLocked) return;
      el.textContent = t(el.dataset.i18n);
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
    Object.keys(state.messages).forEach(renderMessage);
    renderFileInfo('viajes');
    renderFileInfo('pasajeros');
    if (DB) { $('dbHint').textContent = t('db.hint', { table: CATALOG.table }); renderConnection(); }
    if (state.job) { renderSummary(); renderExportStatus(); renderCatalogSave(); updateCount(); }
  }

  function setMessage(id, key, vars, kind) {
    if (!key) delete state.messages[id];
    else state.messages[id] = { key, vars: vars || {}, kind: kind || '' };
    renderMessage(id);
  }

  function renderMessage(id) {
    const el = $(id);
    const m = state.messages[id];
    el.className = 'status' + (m && m.kind ? ' ' + m.kind : '');
    el.textContent = m ? t(m.key, m.vars) : '';
  }

  const fmtDate = (ymd) => (ymd ? `${ymd.slice(5, 7)}/${ymd.slice(8, 10)}/${ymd.slice(0, 4)}` : '');

  function errorMessage(body) {
    const code = (body && body.error) || 'INTERNAL';
    const d = (body && body.details) || {};
    return {
      key: I18N.es['err.' + code] ? 'err.' + code : 'err.INTERNAL',
      vars: {
        missing: (d.missing || []).join(', '),
        allowed: (d.allowed || []).map((x) => '.' + x).join(', '),
        dates: (d.dates || []).map(fmtDate).join(', '),
      },
    };
  }

  async function api(url, options) {
    const opts = { ...(options || {}) };
    const res = await fetch(url, opts);
    const body = await res.json().catch(() => ({ error: 'INTERNAL' }));
    if (!res.ok) throw body;
    return body;
  }

  // ---------- datagrids ----------
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function placeholderEl(key) {
    const el = document.createElement('div');
    el.dataset.i18n = key;
    el.textContent = t(key);
    return el;
  }

  function makeGrid(id) {
    // Tabulator sets an inline height on its element, so it lives inside the
    // .grid-box, which keeps the fixed (responsive) height from the CSS.
    const host = document.createElement('div');
    host.style.height = '100%';
    $(id).append(host);
    const table = new Tabulator(host, {
      height: '100%',
      layout: 'fitData',
      data: [],
      columns: [],
      nestedFieldSeparator: false,
      placeholder: placeholderEl('grid.empty'),
      columnDefaults: { headerSort: true, resizable: true, maxWidth: 420, tooltip: true },
    });
    const ready = new Promise((resolve) => table.on('tableBuilt', resolve));
    return { table, ready };
  }

  async function setGrid(grid, columns, rows, frozen) {
    await grid.ready;
    await grid.table.setColumns(columns.map((c) => ({
      title: escapeHtml(c),
      field: c,
      frozen: Boolean(frozen && frozen.includes(c)),
    })));
    await grid.table.setData(rows);
  }

  async function clearGrid(grid) {
    await grid.ready;
    grid.table.clearFilter(true);
    await grid.table.setData([]);
  }

  const grids = {
    viajes: makeGrid('viajesGrid'),
    pasajeros: makeGrid('pasajerosGrid'),
    changed: makeGrid('changedGrid'),
    output: makeGrid('outputGrid'),
  };

  // ---------- uploads ----------
  function renderFileInfo(kind) {
    const info = $(kind + 'Info');
    if (kind === 'pasajeros' && DB) {
      info.dataset.i18nLocked = '1';
      info.textContent = state.dbCatalog ? t('db.info', { table: CATALOG.table, count: state.dbCatalog.count }) : CATALOG.table;
      return;
    }
    const u = state[kind];
    if (!u) {
      delete info.dataset.i18nLocked;
      info.textContent = t('s1.noFile');
      return;
    }
    info.dataset.i18nLocked = '1';
    info.textContent = `${u.filename} · ${t('s1.rows', { count: u.rowCount })}`;
  }

  async function handleUpload(kind, input) {
    const file = input.files[0];
    if (!file) return;
    resetResults();
    setMessage(kind + 'Status', 's1.loading');
    const form = new FormData();
    form.append('file', file);
    try {
      const body = await api('/api/uploads/' + kind, { method: 'POST', body: form });
      state[kind] = { uploadId: body.uploadId, filename: body.filename, rowCount: body.rowCount, tripDates: body.tripDates || [] };
      await setGrid(grids[kind], body.columns, body.rows);
      setMessage(kind + 'Status', null);
    } catch (err) {
      state[kind] = null;
      await clearGrid(grids[kind]);
      const m = errorMessage(err);
      setMessage(kind + 'Status', m.key, m.vars, 'error');
      input.value = '';
    }
    renderFileInfo(kind);
    if (kind === 'viajes') onViajesChanged();
    updateProcessButton();
  }

  // ---------- date change ----------
  // The preview of the changed date stays collapsed until "Cambiar la fecha" succeeds.
  function hideChangedPreview() {
    $('changedPreview').hidden = true;
    clearGrid(grids.changed);
  }

  async function showChangedPreview(columns, rows) {
    $('changedPreview').hidden = false;
    await setGrid(grids.changed, columns, rows);
    grids.changed.table.redraw(true); // it was built while hidden
  }

  function onViajesChanged() {
    state.changedDate = null;
    $('dateToggle').checked = false;
    $('dateFields').disabled = true;
    $('newDate').value = '';
    hideChangedPreview();
    setMessage('dateStatus', null);
    const dates = state.viajes ? state.viajes.tripDates : [];
    $('currentDate').textContent = dates.length ? dates.map(fmtDate).join(', ') : '—';
    $('dateToggle').disabled = !(state.viajes && dates.length === 1);
    if (dates.length > 1) setMessage('dateStatus', 'date.multiple', { dates: dates.map(fmtDate).join(', ') }, 'error');
    updateApplyButton();
  }

  function updateApplyButton() {
    const v = $('newDate').value;
    const current = state.viajes && state.viajes.tripDates[0];
    $('applyDateBtn').disabled = !$('dateToggle').checked || !/^\d{4}-\d{2}-\d{2}$/.test(v) || v === current || v === state.changedDate;
  }

  $('dateToggle').addEventListener('change', () => {
    const on = $('dateToggle').checked;
    $('dateFields').disabled = !on;
    if (!on) {
      state.changedDate = null;
      $('newDate').value = '';
      hideChangedPreview();
      setMessage('dateStatus', null);
      resetResults();
    }
    updateApplyButton();
  });

  $('newDate').addEventListener('input', updateApplyButton);

  $('applyDateBtn').addEventListener('click', async () => {
    const newDate = $('newDate').value;
    $('applyDateBtn').disabled = true;
    try {
      const body = await api(`/api/uploads/${state.viajes.uploadId}/trip-date`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newDate }),
      });
      state.changedDate = body.newDate;
      await showChangedPreview(body.columns, body.rows);
      setMessage('dateStatus', 'date.applied', { date: fmtDate(body.newDate) }, 'ok');
      resetResults();
    } catch (err) {
      state.changedDate = null;
      hideChangedPreview();
      const m = errorMessage(err);
      setMessage('dateStatus', m.key, m.vars, 'error');
    }
    updateApplyButton();
  });

  // ---------- processing ----------
  function updateProcessButton() {
    $('processBtn').disabled = !state.viajes || (DB && !state.dbCatalog);
  }

  function setBusy(busy) {
    ['viajesFile', 'pasajerosFile', 'processBtn', 'legIdV2Toggle', 'legIdV2SeqToggle', 'dbConnectBtn', 'dbImportFile', 'dbBackupBtn'].forEach((id) => { if ($(id)) $(id).disabled = busy; });
    if (!busy) updateProcessButton();
    $('legIdV2Start').disabled = busy || !$('legIdV2SeqToggle').checked;
    $('section1').setAttribute('aria-busy', busy ? 'true' : 'false');
  }

  // ---------- Leg ID V2 consecutive numbers (LEG-ID-V2-SEQUENTIAL-001) ----------
  const seqLabel = (n) => 'L' + String(n).padStart(6, '0');
  function updateSequencePreview() {
    const on = $('legIdV2SeqToggle').checked;
    const input = $('legIdV2Start');
    input.disabled = !on;
    const ok = /^[0-9]+$/.test(input.value.trim()) && Number(input.value) >= 1 && Number(input.value) <= 999999;
    input.setAttribute('aria-invalid', on && !ok ? 'true' : 'false');
    $('legIdV2Preview').textContent = on ? (ok ? t('v2seq.preview', { first: seqLabel(Number(input.value)) }) : t('v2seq.invalid')) : '';
  }
  $('legIdV2SeqToggle').addEventListener('change', updateSequencePreview);
  $('legIdV2Start').addEventListener('input', updateSequencePreview);

  $('processBtn').addEventListener('click', async () => {
    setBusy(true);
    setMessage('processStatus', 's1.processing');
    try {
      const payload = { viajesUploadId: state.viajes.uploadId };
      if (!DB && state.pasajeros) payload.pasajerosUploadId = state.pasajeros.uploadId;
      if ($('dateToggle').checked && state.changedDate) payload.newTripDate = state.changedDate;
      if ($('legIdV2Toggle').checked) payload.legIdV2Mode = true;
      if ($('legIdV2SeqToggle').checked) {
        payload.legIdV2Sequential = true;
        payload.legIdV2Start = $('legIdV2Start').value;
      }
      const body = await api('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      state.job = body;
      setMessage('processStatus', 's1.processed', {}, 'ok');
      await showResults();
    } catch (err) {
      const m = errorMessage(err);
      setMessage('processStatus', m.key, m.vars, 'error');
      if (err && err.error === 'CATALOG_KEY_INVALID') disconnectCatalog();
    }
    setBusy(false);
  });

  // ---------- catalog in the database (CATALOG-STORAGE-001) ----------
  // v2.9.0 CATALOG-REMEMBER-DEVICE-001: the key is typed once; the server
  // remembers this computer with an HttpOnly cookie, so the browser never
  // keeps the key itself.
  function fmtDay(iso) {
    if (!iso) return '';
    try { return new Date(iso).toLocaleDateString(state.lang === 'es' ? 'es-MX' : 'en-US', { year: 'numeric', month: 'short', day: 'numeric' }); } catch (e) { return iso.slice(0, 10); }
  }

  function renderConnection() {
    if (!DB) return;
    const connected = Boolean(state.dbCatalog);
    $('dbKeyForm').hidden = connected;
    $('dbSession').hidden = !connected;
    $('dbTools').hidden = !connected;
    if (connected) $('dbSessionText').textContent = t('db.remembered', { date: fmtDay(state.rememberedUntil) });
  }

  function disconnectCatalog() {
    state.dbCatalog = null;
    state.rememberedUntil = null;
    renderConnection();
    renderFileInfo('pasajeros');
    updateProcessButton();
  }

  // v2.9.0 LEG-ID-V2-COUNTER-001: Start at = last saved number + 1.
  function suggestSequenceStart() {
    const info = state.dbCatalog && state.dbCatalog.legIdV2;
    if (!info) return;
    $('legIdV2Start').value = String(info.next);
    updateSequencePreview();
  }

  async function loadCatalog(quiet) {
    if (!quiet) setMessage('pasajerosStatus', 'db.loading');
    try {
      const body = await api('/api/catalog');
      state.dbCatalog = { count: body.rowCount, legIdV2: body.legIdV2 };
      await setGrid(grids.pasajeros, body.columns, body.rows);
      suggestSequenceStart();
      if (!quiet) setMessage('pasajerosStatus', 'db.connected', { count: body.rowCount }, 'ok');
    } catch (err) {
      const m = errorMessage(err);
      setMessage('pasajerosStatus', m.key, m.vars, 'error');
      if (err && err.error === 'CATALOG_KEY_INVALID') disconnectCatalog();
    }
    renderConnection();
    renderFileInfo('pasajeros');
    updateProcessButton();
  }

  function filenameOf(res, fallback) {
    const cd = res.headers.get('Content-Disposition') || '';
    const m = /filename="([^"]+)"/.exec(cd);
    return m ? m[1] : fallback;
  }

  const catalogError = (err, target) => {
    const m = errorMessage(err);
    setMessage(target, m.key, m.vars, 'error');
    if (err && err.error === 'CATALOG_KEY_INVALID') disconnectCatalog();
  };

  if (DB) {
    $('dbKeyForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const key = $('dbKey').value.trim();
      $('dbKey').value = '';
      if (!key) { setMessage('pasajerosStatus', 'db.needKey', {}, 'error'); return; }
      $('dbConnectBtn').disabled = true;
      try {
        const r = await api('/api/catalog/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) });
        state.rememberedUntil = r.rememberedUntil;
        resetResults();
        await loadCatalog(false);
      } catch (err) {
        catalogError(err, 'pasajerosStatus');
      }
      $('dbConnectBtn').disabled = false;
    });

    $('dbForgetBtn').addEventListener('click', async () => {
      try { await api('/api/catalog/session', { method: 'DELETE' }); } catch (e) { /* the cookie expires anyway */ }
      resetResults();
      disconnectCatalog();
      await setGrid(grids.pasajeros, [], []);
      setMessage('pasajerosStatus', 'db.forgotten', {}, 'ok');
    });

    $('dbImportFile').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      resetResults();
      setMessage('pasajerosStatus', 'db.importing');
      const form = new FormData();
      form.append('file', file);
      try {
        const r = await api('/api/catalog/import', { method: 'POST', body: form });
        await loadCatalog(true);
        setMessage('pasajerosStatus', 'db.imported', r, 'ok');
      } catch (err) {
        catalogError(err, 'pasajerosStatus');
      }
      e.target.value = '';
    });

    $('dbBackupBtn').addEventListener('click', async () => {
      try {
        const res = await fetch('/api/catalog/export');
        if (!res.ok) throw await res.json().catch(() => ({ error: 'INTERNAL' }));
        const url = URL.createObjectURL(await res.blob());
        const a = document.createElement('a');
        a.href = url;
        a.download = filenameOf(res, 'NCTD_Passengers.csv');
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      } catch (err) {
        catalogError(err, 'pasajerosStatus');
      }
    });

    $('catalogSaveBtn').addEventListener('click', async () => {
      const job = state.job;
      if (!job) return;
      $('catalogSaveBtn').disabled = true;
      setMessage('catalogSaveStatus', 'save.saving');
      try {
        job.catalogSaved = await api(`/api/jobs/${job.jobId}/catalog`, { method: 'POST' });
        setMessage('catalogSaveStatus', null);
        renderCatalogSave();
        await loadCatalog(true);
      } catch (err) {
        catalogError(err, 'catalogSaveStatus');
        $('catalogSaveBtn').disabled = false;
      }
    });

    $('dbHint').textContent = t('db.hint', { table: CATALOG.table });
    (async () => {
      try {
        const st = await api('/api/catalog/status');
        if (st.remembered) {
          state.rememberedUntil = st.rememberedUntil;
          await loadCatalog(false);
          return;
        }
      } catch (e) { /* show the key form */ }
      renderConnection();
      setMessage('pasajerosStatus', 'db.needKey');
    })();
  }

  function renderCatalogSave() {
    const box = $('catalogSave');
    const job = state.job;
    if (!DB || !job || !job.summary.catalogPending) { box.hidden = true; return; }
    box.hidden = false;
    const { added, changed, legIdV2 } = job.summary.catalogPending;
    const saved = job.catalogSaved;
    const text = $('catalogSaveText');
    const btn = $('catalogSaveBtn');
    box.className = 'catalog-save';
    const lines = [];
    if (saved) {
      btn.hidden = true;
      const seq = saved.legIdV2;
      if (saved.stale) {
        box.classList.add('is-stale');
        if (saved.saved + saved.updated > 0) lines.push(t('save.done', saved));
        if (saved.existed + saved.skipped > 0) lines.push(t('save.stale', { count: saved.existed + saved.skipped, ids: (saved.existedIds || []).slice(0, 6).join(', ') }));
        if (seq && !seq.recorded) lines.push(t('save.seqConflict', seq));
      } else {
        box.classList.add('is-done');
        lines.push(saved.alreadySaved ? t('save.already') : t('save.done', saved));
        if (seq && seq.recorded) lines.push(t('save.seqDone', seq));
      }
      text.textContent = lines.join(' ');
      return;
    }
    if (added + changed === 0 && !legIdV2) {
      box.classList.add('is-done');
      btn.hidden = true;
      text.textContent = t('save.none');
      return;
    }
    if (added + changed > 0) lines.push(t('save.pending', { added, changed }));
    if (legIdV2) lines.push(t(legIdV2.overlaps ? 'save.seqOverlap' : 'save.seqPending', { first: legIdV2.first, last: legIdV2.last, stored: 'L' + String(legIdV2.storedLast).padStart(6, '0') }));
    lines.push(t('save.beforeTobi'));
    if (legIdV2 && legIdV2.overlaps) box.classList.add('is-stale');
    btn.hidden = false;
    btn.disabled = false;
    text.textContent = lines.join(' ');
  }

  // ---------- results ----------
  function resetResults() {
    state.job = null;
    $('section2').classList.add('is-disabled');
    $('section2').setAttribute('aria-disabled', 'true');
    $('section2Hint').hidden = false;
    $('summary').hidden = true;
    $('exportStatus').hidden = true;
    $('downloads').hidden = true;
    $('catalogSave').hidden = true;
    setMessage('catalogSaveStatus', null);
    ['searchInput', 'searchBtn', 'clearBtn'].forEach((id) => { $(id).disabled = true; });
    $('searchInput').value = '';
    $('outputCount').textContent = '';
    $('outputGrid').hidden = true;
    $('outputCount').hidden = true;
    clearGrid(grids.output);
    if (state.messages.processStatus && state.messages.processStatus.kind === 'ok') setMessage('processStatus', null);
  }

  function setDownload(id, d) {
    const a = $(id);
    if (!d) { a.hidden = true; return; }
    a.hidden = false;
    a.href = d.url;
    a.setAttribute('download', d.filename);
    a.querySelector('.fname').textContent = d.filename;
  }

  async function showResults() {
    const job = state.job;
    $('section2').classList.remove('is-disabled');
    $('section2').setAttribute('aria-disabled', 'false');
    $('section2Hint').hidden = true;
    renderSummary();
    renderExportStatus();
    renderCatalogSave();
    setDownload('dlOutput', job.downloads.output);
    setDownload('dlPasajeros', job.downloads.pasajeros);
    setDownload('dlInvalid', job.downloads.invalid);
    $('downloads').hidden = false;
    ['searchInput', 'searchBtn', 'clearBtn'].forEach((id) => { $(id).disabled = false; });
    $('outputGrid').hidden = false;
    $('outputCount').hidden = false;
    await setGrid(grids.output, OUTPUT_COLUMNS, job.rows, FROZEN);
    grids.output.table.redraw(true); // it was built while hidden
    updateCount();
    $('section2').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function renderExportStatus() {
    const el = $('exportStatus');
    if (!state.job) { el.hidden = true; return; }
    const ready = state.job.summary.exportReady;
    el.hidden = false;
    el.className = 'export-status ' + (ready ? 'ok' : 'blocked');
    el.textContent = ready ? t('s2.exportReady') : t('s2.exportBlocked', { count: state.job.summary.blockingErrors });
    const mode = document.createElement('span');
    mode.className = 'mode';
    mode.textContent = state.job.summary.legIdV2Mode ? t('v2.modeOn', { name: state.job.summary.legIdV2ModeName }) : t('v2.modeOff');
    el.append(mode);
    const seq = state.job.summary.legIdV2Sequence;
    if (seq && seq.first) {
      const info = document.createElement('span');
      info.className = 'mode';
      info.textContent = t('v2seq.done', { first: seq.first, last: seq.last, next: seq.nextStart });
      el.append(info);
    }
  }

  function renderSummary() {
    const s = state.job.summary;
    const box = $('summary');
    box.replaceChildren();
    const h = document.createElement('h3');
    h.textContent = t('summary.title');
    h.style.fontSize = '1.05rem';
    const dl = document.createElement('dl');
    const items = [
      ['summary.effectiveTripDate', fmtDate(s.effectiveTripDate), s.dateChanged ? t('summary.dateChanged') : ''],
      ...(s.catalogMode ? [['summary.catalogSource', t('summary.catalogSource.db'), s.catalogTable]] : []),
      ['summary.rowsRead', s.rowsRead],
      ['summary.validRows', s.validRows],
      ['summary.invalidRows', s.invalidRows],
      ['summary.duplicatesRemoved', s.duplicatesRemoved],
      ['summary.outputRows', s.outputRows],
      ['summary.pairs', s.pairs],
      ['summary.unpairedLegs', s.unpairedLegs],
      ['summary.catalogMatched', s.catalogProvided ? s.catalogMatched : '—'],
      ['summary.pasajerosAdded', s.pasajerosAdded],
      ['summary.catalogMigrated', s.catalogProvided ? s.catalogMigrated : '—'],
      ['summary.catalogPhonesMigrated', s.catalogProvided ? s.catalogPhonesMigrated : '—'],
    ];
    for (const [key, value, note] of items) {
      const div = document.createElement('div');
      const dt = document.createElement('dt');
      const dd = document.createElement('dd');
      dt.textContent = t(key);
      dd.textContent = value == null || value === '' ? '—' : value;
      if (note) {
        const small = document.createElement('small');
        small.textContent = note;
        dd.append(small);
        div.className = 'wide';
      }
      div.append(dt, dd);
      dl.append(div);
    }
    box.append(h, dl);

    const notes = [];
    for (const e of state.job.exceptions || []) {
      const count = e.count || e.rows.length;
      if (e.code === 'UNKNOWN_SPACE_TYPE') {
        notes.push({ cls: 'sev-info', text: t('summary.unknownSpaceTypes', { values: (e.values || []).join(', ') }) });
        continue;
      }
      const rows = e.rows.length ? ` · ${t('summary.sourceRows')} ${e.rows.slice(0, 12).join(', ')}${e.rows.length > 12 ? '…' : ''}` : '';
      const ids = e.ids && e.ids.length ? ` · ${e.ids.slice(0, 4).join(', ')}${e.ids.length > 4 ? '…' : ''}` : '';
      const catalogRows = e.catalogRows && e.catalogRows.length ? ` · ${t('summary.catalogRows')} ${e.catalogRows.slice(0, 12).join(', ')}` : '';
      if (e.code === 'NO_PASSENGER_CATALOG') {
        notes.push({ cls: 'sev-warning', text: `${t('exc.' + e.code)} [${e.code}, ${t('sev.' + e.severity)}]` });
        continue;
      }
      notes.push({ cls: 'sev-' + e.severity, text: `${t('exc.' + e.code)} [${e.code}, ${t('sev.' + e.severity)}]: ${count}${rows}${ids}${catalogRows}` });
    }
    if (notes.length) {
      const p = document.createElement('p');
      p.textContent = t('summary.exceptions');
      p.style.margin = '0 0 .25rem';
      p.style.fontWeight = '600';
      const ul = document.createElement('ul');
      for (const n of notes) {
        const li = document.createElement('li');
        li.className = n.cls;
        li.textContent = n.text;
        ul.append(li);
      }
      box.append(p, ul);
    }
    box.hidden = false;
  }

  // ---------- search ----------
  const fold = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toUpperCase();

  function updateCount() {
    if (!state.job) return;
    const total = state.job.rows.length;
    const shown = grids.output.table.getDataCount('active');
    $('outputCount').textContent = shown === 0 && total > 0 ? t('s2.search.none') : t('s2.count', { shown, total });
  }

  $('searchForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = fold($('searchInput').value);
    if (!q) grids.output.table.clearFilter(true);
    else grids.output.table.setFilter((row) => SEARCH_FIELDS.some((f) => fold(row[f]).includes(q)));
    updateCount();
  });

  $('clearBtn').addEventListener('click', () => {
    $('searchInput').value = '';
    grids.output.table.clearFilter(true);
    updateCount();
  });

  // ---------- language ----------
  $('langSelect').addEventListener('change', (e) => {
    state.lang = e.target.value;
    document.cookie = `lang=${state.lang}; path=/; max-age=31536000; SameSite=Lax`;
    const url = new URL(window.location.href);
    url.searchParams.delete('lang');
    window.history.replaceState(null, '', url);
    applyI18n();
    updateSequencePreview();
    if (state.job) renderExportStatus();
  });

  // ---------- wiring ----------
  $('viajesFile').addEventListener('change', (e) => handleUpload('viajes', e.target));
  if (!DB) $('pasajerosFile').addEventListener('change', (e) => handleUpload('pasajeros', e.target));
  updateProcessButton();
}());
