'use strict';
// RFC 5322 message builder for the Gmail API "raw" field. Pure JS UTF-8 and
// base64url so it runs inside the n8n Code-node sandbox.

function utf8Bytes(str) {
  const out = [];
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    let c = s.codePointAt(i);
    if (c > 0xffff) i++;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function base64(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const n = (a << 16) | (b << 8) | c;
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=';
    out += i + 2 < bytes.length ? B64[n & 63] : '=';
  }
  return out;
}

function base64Utf8(str) {
  return base64(utf8Bytes(str));
}

function base64Url(str) {
  return base64Utf8(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function encodeHeader(value) {
  const v = String(value || '').replace(/[\r\n]+/g, ' ');
  return /^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${base64Utf8(v)}?=`;
}

function addressHeader(name, email) {
  const e = String(email || '').replace(/[\r\n<>]/g, '');
  if (!name) return e;
  const n = String(name).replace(/[\r\n"]/g, '');
  return `${/^[\x20-\x7e]*$/.test(n) ? `"${n}"` : encodeHeader(n)} <${e}>`;
}

function wrap76(s) {
  return s.replace(/.{1,76}/g, '$&\r\n').trimEnd();
}

/**
 * opts: { fromName, fromEmail, to, replyTo, subject, body, listUnsubscribe: [..], oneClick, extraHeaders: {} }
 * Returns the base64url "raw" string for POST users/me/messages/send.
 */
function buildRawMessage(opts) {
  const headers = [];
  headers.push(`From: ${addressHeader(opts.fromName, opts.fromEmail)}`);
  headers.push(`To: ${addressHeader('', opts.to)}`);
  if (opts.replyTo) headers.push(`Reply-To: ${addressHeader('', opts.replyTo)}`);
  headers.push(`Subject: ${encodeHeader(opts.subject)}`);
  headers.push('MIME-Version: 1.0');
  headers.push('Content-Type: text/plain; charset="UTF-8"');
  headers.push('Content-Transfer-Encoding: base64');
  const unsub = (opts.listUnsubscribe || []).filter(Boolean);
  if (unsub.length) headers.push(`List-Unsubscribe: ${unsub.map((u) => `<${u}>`).join(', ')}`);
  if (opts.oneClick && unsub.some((u) => /^https:/i.test(u))) headers.push('List-Unsubscribe-Post: List-Unsubscribe=One-Click');
  for (const k of Object.keys(opts.extraHeaders || {})) {
    if (/^X-[A-Za-z0-9-]+$/.test(k)) headers.push(`${k}: ${encodeHeader(opts.extraHeaders[k])}`);
  }
  const body = String(opts.body || '').replace(/\r?\n/g, '\r\n');
  const message = headers.join('\r\n') + '\r\n\r\n' + wrap76(base64Utf8(body)) + '\r\n';
  return base64Url(message);
}

// For tests and debugging: decode base64url back to a string.
function decodeBase64Url(s) {
  const b64 = String(s).replace(/-/g, '+').replace(/_/g, '/');
  const bytes = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of b64) {
    if (ch === '=') break;
    const v = B64.indexOf(ch);
    if (v < 0) continue;
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) { bits -= 8; bytes.push((buffer >> bits) & 0xff); }
  }
  let out = '';
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i];
    let cp;
    if (b < 0x80) { cp = b; i += 1; } else if (b < 0xe0) { cp = ((b & 31) << 6) | (bytes[i + 1] & 63); i += 2; } else if (b < 0xf0) { cp = ((b & 15) << 12) | ((bytes[i + 1] & 63) << 6) | (bytes[i + 2] & 63); i += 3; } else { cp = ((b & 7) << 18) | ((bytes[i + 1] & 63) << 12) | ((bytes[i + 2] & 63) << 6) | (bytes[i + 3] & 63); i += 4; }
    out += String.fromCodePoint(cp);
  }
  return out;
}

module.exports = { buildRawMessage, base64Url, base64Utf8, decodeBase64Url, encodeHeader };
