'use strict';

const express = require('express');
const multer = require('multer');
const { readTable, IngestionError } = require('../parser/ingestion');
const { processViajes, distinctTripDates, applyTripDateOverride, ProcessingError } = require('../parser/pipeline');
const { updatePasajeros, PASAJEROS_COLUMNS } = require('../parser/pasajeros');
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

function createApiRouter({ rules, registry, uploads, jobs }) {
  const router = express.Router();
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

  router.post('/jobs', express.json(), async (req, res, next) => {
    try {
      const body = req.body || {};
      const viajes = getUpload(body.viajesUploadId, 'viajes');
      const pasajeros = body.pasajerosUploadId ? getUpload(body.pasajerosUploadId, 'pasajeros') : null;
      let overrideDate = null;
      if (body.newTripDate) {
        overrideDate = parseNewDate(body.newTripDate);
        assertSingleDate(viajes);
      }

      const result = await processViajes({ table: viajes.table, rules, overrideDate, registry });
      const defaultPhone = rules.field_rules.phones['Primary Phone'].default;
      const pas = updatePasajeros(pasajeros && pasajeros.table, result.destinationRows, defaultPhone);

      const files = {
        output: { filename: outputName(viajes.filename, '_TOBI'), csv: toCsv(result.destinationColumns, result.destinationRows) },
        pasajeros: { filename: outputName(pasajeros ? pasajeros.filename : 'Pasajeros.csv', '_UPDATED'), csv: toCsv(pas.headers, pas.rows) },
      };
      if (result.invalidRows.length) {
        files.invalid = { filename: outputName(viajes.filename, '_INVALID_TRIPS'), csv: toCsv(result.invalidColumns, result.invalidRows) };
      }
      const summary = { ...result.summary, pasajerosAdded: pas.added };
      const jobId = jobs.add({ files, destinationRows: result.destinationRows, columns: result.destinationColumns, summary });

      const downloads = Object.fromEntries(Object.entries(files).map(([k, f]) => [k, { filename: f.filename, url: `/api/jobs/${jobId}/${k === 'invalid' ? 'invalid-trips' : k}` }]));
      res.json({ jobId, summary, exceptions: result.exceptions, columns: result.destinationColumns, rows: result.destinationRows, downloads });
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
