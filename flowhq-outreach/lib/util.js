'use strict';
// Shared helpers. Pure JavaScript only: these files are bundled into n8n Code
// nodes, which run in a sandboxed task runner without Node built-in modules.

function str(v) {
  if (v === null || v === undefined) return '';
  return String(v);
}

function clean(v) {
  return str(v).replace(/\s+/g, ' ').trim();
}

function truthy(v) {
  if (typeof v === 'boolean') return v;
  const s = clean(v).toLowerCase();
  return ['true', 'yes', 'y', '1', 'on', 'enabled', 'approved'].includes(s);
}

function toInt(v, fallback) {
  const n = parseInt(str(v).trim(), 10);
  return Number.isFinite(n) ? n : fallback;
}

// FNV-1a 32-bit, used for stable, non-secret identifiers.
function fnv1a(input, seed) {
  let h = seed === undefined ? 0x811c9dc5 : seed >>> 0;
  const s = str(input);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function stableHash(input) {
  const a = fnv1a(input).toString(36).padStart(7, '0');
  const b = fnv1a(input, 0x9747b28c).toString(36).padStart(7, '0');
  return (a + b).toUpperCase();
}

function randomToken(length) {
  const len = length || 32;
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  const c = typeof crypto !== 'undefined' && crypto && typeof crypto.getRandomValues === 'function' ? crypto : null;
  if (c) {
    const bytes = new Uint8Array(len);
    c.getRandomValues(bytes);
    for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
    return out;
  }
  for (let i = 0; i < len; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-',
  rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', hellip: '...', copy: '(c)', reg: '(R)',
  trade: '(TM)', middot: '-', bull: '-', laquo: '"', raquo: '"', eacute: 'e', egrave: 'e',
  aacute: 'a', agrave: 'a', oacute: 'o', uacute: 'u', iacute: 'i', ntilde: 'n', ccedil: 'c',
  times: 'x', pound: '£', euro: '€', dollar: '$', cent: 'c', deg: ' degrees', frac12: '1/2',
};

function decodeEntities(s) {
  return str(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, code) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      if (!Number.isFinite(n) || n <= 0 || n > 0x10ffff) return ' ';
      try { return String.fromCodePoint(n); } catch (e) { return ' '; }
    }
    const v = NAMED_ENTITIES[code.toLowerCase()];
    return v === undefined ? m : v;
  });
}

function truncate(s, max) {
  const t = str(s);
  if (t.length <= max) return t;
  return t.slice(0, Math.max(0, max - 3)).trimEnd() + '...';
}

function uniq(arr) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    if (!seen.has(x)) { seen.add(x); out.push(x); }
  }
  return out;
}

function safeJsonParse(s, fallback) {
  if (s && typeof s === 'object') return s;
  const t = str(s).trim();
  if (!t) return fallback;
  try { return JSON.parse(t); } catch (e) { return fallback; }
}

// Google Sheets cells hold at most 50,000 characters.
function toCell(value, max) {
  const limit = max || 45000;
  const s = typeof value === 'string' ? value : JSON.stringify(value === undefined ? null : value);
  return s.length > limit ? s.slice(0, limit) : s;
}

function isoNow(now) {
  return (now instanceof Date ? now : new Date(now || Date.now())).toISOString();
}

function errorMessage(e) {
  if (!e) return 'unknown error';
  if (typeof e === 'string') return e;
  return clean(e.message || JSON.stringify(e)).slice(0, 500);
}

module.exports = {
  str, clean, truthy, toInt, fnv1a, stableHash, randomToken, decodeEntities, truncate,
  uniq, safeJsonParse, toCell, isoNow, errorMessage,
};
