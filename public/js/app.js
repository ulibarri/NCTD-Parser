/* NCTD Manifest Parser — front end (vanilla JS + Tabulator) */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const I18N = JSON.parse($('i18nData').textContent);
  const OUTPUT_COLUMNS = JSON.parse($('outputColumns').textContent);
  const FROZEN = ['Journey ID', 'Leg ID'];
  const SEARCH_FIELDS = ['First Name', 'Last Name', 'Tobi MRN'];

  const state = {
    lang: document.documentElement.lang || 'es',
    viajes: null, // { uploadId, filename, rowCount, tripDates }
    pasajeros: null,
    changedDate: null, // 'YYYY-MM-DD' once "Cambiar la fecha" was applied
    job: null,
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
    if (state.job) { renderSummary(); updateCount(); }
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
    const res = await fetch(url, options);
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
  function onViajesChanged() {
    state.changedDate = null;
    $('dateToggle').checked = false;
    $('dateFields').disabled = true;
    $('newDate').value = '';
    clearGrid(grids.changed);
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
      clearGrid(grids.changed);
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
      await setGrid(grids.changed, body.columns, body.rows);
      setMessage('dateStatus', 'date.applied', { date: fmtDate(body.newDate) }, 'ok');
      resetResults();
    } catch (err) {
      const m = errorMessage(err);
      setMessage('dateStatus', m.key, m.vars, 'error');
    }
    updateApplyButton();
  });

  // ---------- processing ----------
  function updateProcessButton() {
    $('processBtn').disabled = !state.viajes;
  }

  function setBusy(busy) {
    ['viajesFile', 'pasajerosFile', 'processBtn'].forEach((id) => { $(id).disabled = busy; });
    if (!busy) updateProcessButton();
    $('section1').setAttribute('aria-busy', busy ? 'true' : 'false');
  }

  $('processBtn').addEventListener('click', async () => {
    setBusy(true);
    setMessage('processStatus', 's1.processing');
    try {
      const payload = { viajesUploadId: state.viajes.uploadId };
      if (state.pasajeros) payload.pasajerosUploadId = state.pasajeros.uploadId;
      if ($('dateToggle').checked && state.changedDate) payload.newTripDate = state.changedDate;
      const body = await api('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      state.job = body;
      setMessage('processStatus', 's1.processed', {}, 'ok');
      await showResults();
    } catch (err) {
      const m = errorMessage(err);
      setMessage('processStatus', m.key, m.vars, 'error');
    }
    setBusy(false);
  });

  // ---------- results ----------
  function resetResults() {
    state.job = null;
    $('section2').classList.add('is-disabled');
    $('section2').setAttribute('aria-disabled', 'true');
    $('section2Hint').hidden = false;
    $('summary').hidden = true;
    $('downloads').hidden = true;
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
      ['summary.rowsRead', s.rowsRead],
      ['summary.validRows', s.validRows],
      ['summary.invalidRows', s.invalidRows],
      ['summary.duplicatesRemoved', s.duplicatesRemoved],
      ['summary.exceptionRows', s.exceptionRows],
      ['summary.journeys', s.journeys],
      ['summary.journeysReused', s.journeysReused],
      ['summary.outputRows', s.outputRows],
      ['summary.pasajerosAdded', s.pasajerosAdded],
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
      const rows = e.rows.length ? ` (${e.rows.slice(0, 12).join(', ')}${e.rows.length > 12 ? '…' : ''})` : '';
      notes.push({ cls: 'sev-' + e.severity, text: `${t('exc.' + e.code)} [${e.code}, ${t('sev.' + e.severity)}]: ${count}${rows}` });
    }
    if (s.unknownSpaceTypes && s.unknownSpaceTypes.length) {
      notes.push({ cls: 'sev-warning', text: t('summary.unknownSpaceTypes', { values: s.unknownSpaceTypes.join(', ') }) });
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
  });

  // ---------- wiring ----------
  $('viajesFile').addEventListener('change', (e) => handleUpload('viajes', e.target));
  $('pasajerosFile').addEventListener('change', (e) => handleUpload('pasajeros', e.target));
  updateProcessButton();
}());
