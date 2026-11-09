'use strict';

// In-memory store for uploads and processing results.
// Entries contain personal data, so they expire (2 hours by default) and are
// never written to disk.

const crypto = require('node:crypto');

class TtlStore {
  constructor(ttlMs) {
    this.ttlMs = ttlMs;
    this.items = new Map();
    this.timer = setInterval(() => this.sweep(), Math.min(ttlMs, 10 * 60 * 1000));
    this.timer.unref();
  }

  add(value) {
    const id = crypto.randomUUID();
    this.items.set(id, { value, expires: Date.now() + this.ttlMs });
    return id;
  }

  get(id) {
    const entry = this.items.get(id);
    if (!entry) return null;
    if (entry.expires <= Date.now()) {
      this.items.delete(id);
      return null;
    }
    return entry.value;
  }

  sweep() {
    const now = Date.now();
    for (const [id, entry] of this.items) if (entry.expires <= now) this.items.delete(id);
  }
}

module.exports = { TtlStore };
