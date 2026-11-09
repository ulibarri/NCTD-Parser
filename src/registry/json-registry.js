'use strict';

// Journey ID registry stored in a local JSON file.
// Per architecture.json_registry_usage this is for local development and a
// single-process prototype; production should move to PostgreSQL with
// transactional sequence allocation.

const fs = require('node:fs');
const path = require('node:path');

class JsonRegistry {
  constructor(file, { retentionHours = 72 } = {}) {
    this.file = file;
    this.retentionMs = retentionHours * 3600 * 1000;
    this.queue = Promise.resolve();
  }

  read() {
    try {
      const state = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return { sequences: state.sequences || {}, fingerprints: state.fingerprints || {} };
    } catch (err) {
      if (err.code === 'ENOENT') return { sequences: {}, fingerprints: {} };
      throw err;
    }
  }

  write(state) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, ...state }, null, 2));
    fs.renameSync(tmp, this.file);
  }

  /**
   * Runs fn(session) with exclusive access. session.allocate(datePrefix, fingerprint)
   * returns { journeyId, reused } or { error: 'INVALID_JOURNEY_ID' } when the daily
   * maximum is exceeded. Changes are saved once fn finishes.
   */
  transaction(fn, { now = new Date(), maximumPerDay = 9999, width = 4 } = {}) {
    const run = async () => {
      const state = this.read();
      const nowMs = now.getTime();
      for (const [fp, entry] of Object.entries(state.fingerprints)) {
        if (Date.parse(entry.expiresAt) <= nowMs) delete state.fingerprints[fp];
      }
      const session = {
        allocate: (datePrefix, fingerprint) => {
          const active = state.fingerprints[fingerprint];
          if (active && active.journeyId.startsWith(datePrefix)) return { journeyId: active.journeyId, reused: true };
          const next = (state.sequences[datePrefix] || 0) + 1;
          if (next > maximumPerDay) return { error: 'INVALID_JOURNEY_ID' };
          state.sequences[datePrefix] = next;
          const journeyId = datePrefix + String(next).padStart(width, '0');
          state.fingerprints[fingerprint] = {
            journeyId,
            createdAt: new Date(nowMs).toISOString(),
            expiresAt: new Date(nowMs + this.retentionMs).toISOString(),
          };
          return { journeyId, reused: false };
        },
      };
      const result = await fn(session);
      this.write(state);
      return result;
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }
}

module.exports = { JsonRegistry };
