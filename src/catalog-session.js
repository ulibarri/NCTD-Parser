'use strict';

// v2.9.0 CATALOG-REMEMBER-DEVICE-001: "remember this computer".
//
// After the catalog key is typed once, the server sets a signed cookie. The
// signature is derived from CATALOG_ACCESS_KEY, so changing the key in Render
// invalidates every cookie at once. The cookie only carries its expiry time
// and the signature, never the key itself.

const crypto = require('node:crypto');

const COOKIE = 'nctd_catalog';
const DAY_MS = 24 * 60 * 60 * 1000;

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const secretOf = (accessKey) => crypto.createHash('sha256').update(`nctd-catalog-session:v1:${accessKey}`).digest();
const signature = (accessKey, exp) => b64url(crypto.createHmac('sha256', secretOf(accessKey)).update(`v1.${exp}`).digest());

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

/** Token "<expiresMs>.<signature>". */
function createToken(accessKey, days, now = Date.now()) {
  const exp = now + days * DAY_MS;
  return { token: `${exp}.${signature(accessKey, exp)}`, expiresAt: exp };
}

/** @returns {number|null} expiry time when the token is valid */
function verifyToken(token, accessKey, now = Date.now()) {
  if (!accessKey || typeof token !== 'string') return null;
  const m = /^(\d{10,16})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!m) return null;
  const exp = Number(m[1]);
  if (!(exp > now)) return null;
  return safeEqual(m[2], signature(accessKey, exp)) ? exp : null;
}

function readCookie(req, name = COOKIE) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

function cookieHeader(req, value, maxAgeSeconds) {
  const parts = [`${COOKIE}=${value}`, 'Path=/', `Max-Age=${maxAgeSeconds}`, 'HttpOnly', 'SameSite=Strict'];
  if (req.secure) parts.push('Secure'); // Render serves HTTPS (trust proxy); localhost is plain HTTP
  return parts.join('; ');
}

/** Wrong-key attempts per client: after `max` failures in `windowMs`, wait. */
function createAttemptLimiter({ max = 5, windowMs = 15 * 60 * 1000 } = {}) {
  const fails = new Map();
  const live = (ip, now) => (fails.get(ip) || []).filter((t) => now - t < windowMs);
  return {
    blocked(ip, now = Date.now()) {
      return live(ip, now).length >= max;
    },
    fail(ip, now = Date.now()) {
      const list = live(ip, now);
      list.push(now);
      fails.set(ip, list);
      if (fails.size > 5000) fails.clear(); // bounded memory
    },
    reset(ip) {
      fails.delete(ip);
    },
  };
}

module.exports = { COOKIE, createToken, verifyToken, readCookie, cookieHeader, createAttemptLimiter, safeEqual };
