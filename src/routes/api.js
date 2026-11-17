'use strict';

const express = require('express');
const multer = require('multer');
const { readTable, IngestionError } = require('../parser/ingestion');
const { processViajes, distinctTripDates, applyTripDateOverride, ProcessingError, parseSequenceStart } = require('../parser/pipeline');
const { PASAJEROS_COLUMNS, applyCatalog, keyOf } = require('../parser/pasajeros');
const { asTable, diffCatalog } = require('../catalog-store');
const crypto = require('node:crypto');
const { toCsv, outputName } = require('../parser/csv-export');
const D = require('../parser/dates');
const F = require('../parser/fields');

const MAX_FILE_BYTES = 10 * 1024 * 1024;

class ApiError extends Error {
  constructor(status, code, details = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function rowsAsObjects(table) {
  return table.rows.map((r) => {
    const o = {};
    table.headers.forEach((h, i) => { o[h] = r.original[i]; });
    return o;
  });
}

function viajesRequiredColumns(rules) {
  const fr = rules.field_rules;
  return [...new Set([
    ...rules.required_field_validation.fields,
    'Passenger Ty', 'Space Type', 'Amount', 'DOAppt', 'Comments',
    ...fr.trip_purpose.sources,
  ])];
}

/** Catalog rows with the canonical column names (uploaded headers may differ in case). */
function canonicalRows(pas, columns) {
  return pas.rows.map((r) => Object.fromEntries(PASAJEROS_COLUMNS.map((c) => [c, String(r[pas.headers[columns.indexOf(c)]] ?? '')])));
}

function createApiRouter({ rules, uploads, jobs, catalogStore = null, accessKey = '' }) {
  const router = express.Router();

  // CATALOG-STORAGE-001: in database mode every request that reads or changes
  // the catalog carries the access key (header X-Catalog-Key).
  const keyBuf = Buffer.from(String(accessKey));
  const requireKey = (req, res, next) => {
    if (!catalogStore) return next();
    const given = Buffer.from(String(req.get('X-Catalog-Key') || ''));
    const ok = keyBuf.length > 0 && given.length === keyBuf.length && crypto.timingSafeEqual(given, keyBuf);
    return ok ? next() : next(new ApiError(401, 'CATALOG_KEY_INVALID'));
  };
  const storeCall = async (fn) => {
    try {
      return await fn();
    } catch (err) {
      console.error('[catalog-store]', err && err.name, err && err.message);
      throw new ApiError(503, 'CATALOG_STORE_UNAVAILABLE', { reason: err && err.name });
    }
  };
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_BYTES, files: 1 } });
  const single = (req, res, next) => upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return next(new ApiError(413, 'FILE_TOO_LARGE'));
    return next(new ApiError(400, 'FILE_UNREADABLE', { reason: err.message }));
  });

  const getUpload = (id, kind) => {
    const u = uploads.get(id);
    if (!u || (kind && u.kind !== kind)) throw new ApiError(404, 'UPLOAD_NOT_FOUND');
    return u;
  };
  const getJob = (id) => {
    const j = jobs.get(id);
    if (!j) throw new ApiError(404, 'JOB_NOT_FOUND');
    return j;
  };

  router.post('/uploads/viajes', single, async (req, res, next) => {
    try {
      if (!req.file) throw new ApiError(400, 'NO_FILE');
      const table = await readTable(req.file.buffer, req.file.originalname, {
        expectedColumns: rules.source_columns,
        requiredColumns: viajesRequiredColumns(rules),
        allowedExtensions: rules.file_contract.accepted_source_formats,
      });
      const tripDates = distinctTripDates(table.rows);
      const uploadId = uploads.add({ kind: 'viajes', filename: req.file.originalname, table, tripDates });
      res.json({ uploadId, filename: req.file.originalname, columns: table.headers, rows: rowsAsObjects(table), rowCount: table.rows.length, tripDates });
    } catch (err) {
      next(err);
    }
  });

  router.post('/uploads/pasajeros', single, async (req, res, next) => {
    try {
      if (!req.file) throw new ApiError(400, 'NO_FILE');
      const table = await readTable(req.file.buffer, req.file.originalname, {
        expectedColumns: PASAJEROS_COLUMNS,
        requiredColumns: PASAJEROS_COLUMNS,
        allowedExtensions: ['csv'],
      });
      const uploadId = uploads.add({ kind: 'pasajeros', filename: req.file.originalname, table });
      res.json({ uploadId, filename: req.file.originalname, columns: table.headers, rows: rowsAsObjects(table), rowCount: table.rows.length });
    } catch (err) {
      next(err);
    }
  });

  const parseNewDate = (value) => {
    const s = String(value || '');
    const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? D.parseTripDate(s) : null;
    if (!d) throw new ApiError(400, 'INVALID_DATE');
    return d;
  };
  const assertSingleDate = (u) => {
    if (u.tripDates.length > 1) throw new ApiError(409, 'MULTIPLE_TRIP_DATES', { dates: u.tripDates });
    if (u.tripDates.length === 0) throw new ApiError(409, 'NO_VALID_DATE');
  };

  router.post('/uploads/:uploadId/trip-date', express.json(), (req, res, next) => {
    try {
      const u = getUpload(req.params.uploadId, 'viajes');
      const newDate = parseNewDate(req.body && req.body.newDate);
      assertSingleDate(u);
      const changed = { ...u.table, rows: applyTripDateOverride(u.table.rows, newDate) };
      const tripIdx = u.table.columns.indexOf('TripDate');
      changed.rows = changed.rows.map((r) => ({ ...r, original: r.original.map((v, i) => (i === tripIdx ? r.values.TripDate : v)) }));
      res.json({ columns: u.table.headers, rows: rowsAsObjects(changed), newDate: D.ymdKey(newDate), previousDate: u.tripDates[0] });
    } catch (err) {
      next(err);
    }
  });

  // ---------- catalog in the database (CATALOG-STORAGE-001) ----------
  router.get('/catalog/status', (req, res) => {
    res.json({ mode: catalogStore ? catalogStore.kind : 'csv', table: catalogStore ? catalogStore.table : null, keyRequired: Boolean(catalogStore) });
  });

  router.get('/catalog', requireKey, async (req, res, next) => {
    try {
      if (!catalogStore) throw new ApiError(404, 'CATALOG_STORE_DISABLED');
      const rows = await storeCall(() => catalogStore.list());
      res.json({ table: catalogStore.table, columns: PASAJEROS_COLUMNS, rows, rowCount: rows.length });
    } catch (err) {
      next(err);
    }
  });

  router.get('/catalog/export', requireKey, async (req, res, next) => {
    try {
      if (!catalogStore) throw new ApiError(404, 'CATALOG_STORE_DISABLED');
      const rows = await storeCall(() => catalogStore.list());
      const filename = outputName(null, 'pasajeros_updated', rules.file_contract.output_file_naming, {}, new Date());
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Cache-Control', 'no-store');
      res.send(toCsv(PASAJEROS_COLUMNS, rows));
    } catch (err) {
      next(err);
    }
  });

  // Loads a Pasajeros CSV into the database: catalog migrations are applied,
  // the first row of a repeated MRN wins and existing passengers are kept.
  router.post('/catalog/import', requireKey, single, async (req, res, next) => {
    try {
      if (!catalogStore) throw new ApiError(404, 'CATALOG_STORE_DISABLED');
      if (!req.file) throw new ApiError(400, 'NO_FILE');
      const table = await readTable(req.file.buffer, req.file.originalname, {
        expectedColumns: PASAJEROS_COLUMNS,
        requiredColumns: PASAJEROS_COLUMNS,
        allowedExtensions: ['csv'],
      });
      const migrated = applyCatalog(table, [], () => 0, rules);
      const seen = new Set();
      const rows = canonicalRows(migrated, table.columns).filter((r) => {
        const k = keyOf(r['MRN Number']);
        if (!k || seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      const { saved, existed } = await storeCall(() => catalogStore.addNew(rows, { source: req.file.originalname }));
      const invalidPhones = (migrated.exceptions.find((e) => e.code === 'CATALOG_PHONE_INVALID') || {}).count || 0;
      res.json({
        filename: req.file.originalname,
        read: table.rows.length,
        saved: saved.length,
        existed: existed.length,
        duplicates: table.rows.length - rows.length,
        migrated: migrated.migrated,
        phonesMigrated: migrated.phonesMigrated,
        invalidPhones,
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/jobs', requireKey, express.json(), async (req, res, next) => {
    try {
      const body = req.body || {};
      const viajes = getUpload(body.viajesUploadId, 'viajes');
      // In database mode the catalog always comes from the database.
      const pasajeros = !catalogStore && body.pasajerosUploadId ? getUpload(body.pasajerosUploadId, 'pasajeros') : null;
      const catalogBefore = catalogStore ? await storeCall(() => catalogStore.list()) : null;
      const catalogTable = catalogStore ? asTable(catalogBefore) : pasajeros && pasajeros.table;
      let overrideDate = null;
      if (body.newTripDate) {
        overrideDate = parseNewDate(body.newTripDate);
        assertSingleDate(viajes);
      }

      let legIdV2Sequence = null;
      if (body.legIdV2Sequential === true) {
        const start = parseSequenceStart(body.legIdV2Start, rules);
        if (start === null) return res.status(400).json({ error: 'INVALID_SEQUENCE_START' });
        legIdV2Sequence = { start };
      }
      const result = await processViajes({ table: viajes.table, rules, overrideDate, catalog: catalogTable, legIdV2Mode: body.legIdV2Mode === true, legIdV2Sequence });
      const pas = result.catalog;

      // output_file_naming: a changed trip date is reflected in the Output and Invalid Trips names.
      const naming = rules.file_contract.output_file_naming;
      const dates = overrideDate ? { originalDate: D.parseTripDate(viajes.tripDates[0]), newDate: overrideDate } : {};
      const files = {
        // export_gate: Output is only produced when there is no blocking error
        ...(result.summary.exportReady ? { output: { filename: outputName(viajes.filename, 'destination', naming, dates), csv: toCsv(result.destinationColumns, result.destinationRows) } } : {}),
        pasajeros: { filename: outputName(pasajeros ? pasajeros.filename : null, 'pasajeros_updated', naming, {}, new Date()), csv: toCsv(pas.headers, pas.rows) },
      };
      if (result.invalidRows.length) {
        files.invalid = { filename: outputName(viajes.filename, 'invalid_trips', naming, dates), csv: toCsv(result.invalidColumns, result.invalidRows) };
      }
      const { summary } = result;
      let catalogJob = null;
      if (catalogStore) {
        const diff = diffCatalog(catalogBefore, canonicalRows(pas, PASAJEROS_COLUMNS));
        catalogJob = { diff, saved: null, source: viajes.filename };
        summary.catalogMode = catalogStore.kind;
        summary.catalogTable = catalogStore.table;
        summary.catalogPending = { added: diff.added.length, changed: diff.changed.length };
      }
      const jobId = jobs.add({ files, destinationRows: result.destinationRows, columns: result.destinationColumns, summary, catalog: catalogJob });

      const downloads = Object.fromEntries(Object.entries(files).map(([k, f]) => [k, { filename: f.filename, url: `/api/jobs/${jobId}/${k === 'invalid' ? 'invalid-trips' : k}` }]));
      res.json({ jobId, summary, exceptions: result.exceptions, columns: result.destinationColumns, rows: result.destinationRows, downloads });
    } catch (err) {
      next(err);
    }
  });

  // Saves the job's new passengers (and catalog migrations) in the database.
  // Saving twice does nothing the second time.
  router.post('/jobs/:jobId/catalog', requireKey, async (req, res, next) => {
    try {
      if (!catalogStore) throw new ApiError(404, 'CATALOG_STORE_DISABLED');
      const job = getJob(req.params.jobId);
      if (!job.catalog) throw new ApiError(404, 'JOB_NOT_FOUND');
      if (job.catalog.saved) return res.json({ ...job.catalog.saved, alreadySaved: true });
      const { diff, source } = job.catalog;
      const added = await storeCall(() => catalogStore.addNew(diff.added, { source }));
      const changes = await storeCall(() => catalogStore.applyChanges(diff.changed));
      const saved = {
        saved: added.saved.length,
        existed: added.existed.length,
        updated: changes.updated.length,
        skipped: changes.skipped.length,
        existedIds: added.existed.map((r) => r['MRN Number']),
      };
      saved.stale = saved.existed > 0 || saved.skipped > 0;
      job.catalog.saved = saved;
      res.json(saved);
    } catch (err) {
      next(err);
    }
  });

  const sendFile = (key) => (req, res, next) => {
    try {
      const f = getJob(req.params.jobId).files[key];
      if (!f) throw new ApiError(404, 'JOB_NOT_FOUND');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${f.filename.replace(/[^\x20-\x7E]|"/g, '_')}"; filename*=UTF-8''${encodeURIComponent(f.filename)}`);
      res.setHeader('Cache-Control', 'no-store');
      res.send(f.csv);
    } catch (err) {
      next(err);
    }
  };
  router.get('/jobs/:jobId/output', sendFile('output'));
  router.get('/jobs/:jobId/pasajeros', sendFile('pasajeros'));
  router.get('/jobs/:jobId/invalid-trips', sendFile('invalid'));

  router.get('/jobs/:jobId/search', (req, res, next) => {
    try {
      const job = getJob(req.params.jobId);
      const fold = (s) => F.collapse(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
      const q = fold(req.query.q);
      const rows = q ? job.destinationRows.filter((r) => ['First Name', 'Last Name', 'Tobi MRN'].some((c) => fold(r[c]).includes(q))) : job.destinationRows;
      res.json({ total: job.destinationRows.length, count: rows.length, rows });
    } catch (err) {
      next(err);
    }
  });

  // Errors are returned as { error: CODE, details } so the UI can translate them.
  // eslint-disable-next-line no-unused-vars
  router.use((err, req, res, next) => {
    if (err instanceof ApiError) return res.status(err.status).json({ error: err.code, details: err.details });
    if (err instanceof IngestionError) return res.status(400).json({ error: err.code, details: err.details });
    if (err instanceof ProcessingError) return res.status(409).json({ error: err.code, details: err.details });
    console.error('[api]', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'INTERNAL' });
  });

  return router;
}

module.exports = { createApiRouter, ApiError };
