'use strict';
const { clean } = require('./util');

const URL_RE = /^(https?):\/\/([^/?#:@\s]+)(?::(\d{1,5}))?([^?#\s]*)(\?[^#\s]*)?(#\S*)?$/i;

// Reserved by RFC 2606 / RFC 6761: never real businesses.
const RESERVED_TLDS = ['example', 'test', 'invalid', 'localhost', 'local'];

const SOCIAL_HOSTS = [
  'facebook.com', 'fb.com', 'instagram.com', 'linkedin.com', 'twitter.com', 'x.com', 'tiktok.com',
  'youtube.com', 'pinterest.com', 'yelp.com', 'google.com', 'goo.gl', 'maps.app.goo.gl',
  'yellowpages.com', 'yell.com', 'truelocal.com.au', 'linktr.ee', 'wa.me', 'bit.ly',
];

function parseUrl(input) {
  const m = URL_RE.exec(String(input || '').trim());
  if (!m) return null;
  const host = m[2].toLowerCase().replace(/\.$/, '');
  return {
    scheme: m[1].toLowerCase(),
    host,
    port: m[3] || '',
    path: m[4] || '/',
    query: m[5] || '',
    hash: m[6] || '',
  };
}

function formatUrl(u) {
  const port = u.port && !((u.scheme === 'https' && u.port === '443') || (u.scheme === 'http' && u.port === '80')) ? ':' + u.port : '';
  return `${u.scheme}://${u.host}${port}${u.path || '/'}${u.query || ''}`;
}

function registrableDomain(host) {
  return String(host || '').toLowerCase().replace(/^www\d*\./, '');
}

function isIp(host) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
}

function tldOf(host) {
  const parts = String(host).split('.');
  return parts[parts.length - 1];
}

function isReservedHost(host) {
  return RESERVED_TLDS.includes(tldOf(host)) || host === 'localhost';
}

function isSocialHost(host) {
  const d = registrableDomain(host);
  return SOCIAL_HOSTS.some((s) => d === s || d.endsWith('.' + s));
}

function stripTracking(query) {
  if (!query) return '';
  const kept = query.slice(1).split('&').filter((kv) => kv && !/^(utm_[a-z]+|gclid|fbclid|msclkid|mc_[a-z]+|ref)=/i.test(kv));
  return kept.length ? '?' + kept.join('&') : '';
}

// Returns { ok, url, domain, reason }. Never throws.
function normalizeWebsite(raw, opts) {
  const options = opts || {};
  let s = clean(raw);
  if (!s) return { ok: false, reason: 'missing_website' };
  s = s.replace(/^[<("']+|[>)"',;]+$/g, '');
  if (/^mailto:/i.test(s)) return { ok: false, reason: 'website_is_email' };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) && !/^https?:\/\//i.test(s)) return { ok: false, reason: 'unsupported_scheme' };
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s.replace(/^\/\//, '');
  const u = parseUrl(s);
  if (!u) return { ok: false, reason: 'unparseable_url' };
  if (!u.host.includes('.') && u.host !== 'localhost') return { ok: false, reason: 'invalid_host' };
  if (!/^[a-z0-9.-]+$/.test(u.host) || /\.\./.test(u.host)) return { ok: false, reason: 'invalid_host' };
  if (isIp(u.host)) return { ok: false, reason: 'ip_address_not_allowed' };
  if (isReservedHost(u.host) && !options.allowSynthetic) return { ok: false, reason: 'reserved_test_domain' };
  if (isSocialHost(u.host)) return { ok: false, reason: 'social_or_directory_profile_not_website' };
  u.query = stripTracking(u.query);
  u.hash = '';
  // Research always starts from the site's root, whatever page was listed.
  const root = { scheme: u.scheme, host: u.host, port: u.port, path: '/', query: '' };
  return { ok: true, url: formatUrl(root), listed_url: formatUrl(u), domain: registrableDomain(u.host) };
}

function normalizePath(path) {
  const segs = [];
  for (const seg of path.split('/')) {
    if (seg === '..') segs.pop();
    else if (seg !== '.' && seg !== '') segs.push(seg);
  }
  return '/' + segs.join('/') + (path.endsWith('/') && segs.length ? '/' : '');
}

// Resolve href against base. Returns absolute http(s) URL string or null.
function resolveUrl(base, href) {
  const h = String(href || '').trim();
  if (!h || /^(javascript|mailto|tel|sms|data|ftp|whatsapp):/i.test(h) || h.startsWith('#')) return null;
  const b = parseUrl(base);
  if (!b) return null;
  let out;
  if (/^https?:\/\//i.test(h)) {
    out = parseUrl(h);
  } else if (h.startsWith('//')) {
    out = parseUrl(b.scheme + ':' + h);
  } else if (h.startsWith('/')) {
    out = parseUrl(`${b.scheme}://${b.host}${b.port ? ':' + b.port : ''}${h}`);
  } else if (h.startsWith('?')) {
    out = parseUrl(`${b.scheme}://${b.host}${b.port ? ':' + b.port : ''}${b.path}${h}`);
  } else {
    const dir = b.path.endsWith('/') ? b.path : b.path.slice(0, b.path.lastIndexOf('/') + 1);
    out = parseUrl(`${b.scheme}://${b.host}${b.port ? ':' + b.port : ''}${dir}${h}`);
  }
  if (!out) return null;
  out.path = normalizePath(out.path || '/');
  out.hash = '';
  return formatUrl(out);
}

function sameSite(a, b) {
  const pa = parseUrl(a);
  const pb = parseUrl(b);
  return !!(pa && pb && registrableDomain(pa.host) === registrableDomain(pb.host));
}

// In test runs, synthetic *.example sites are served by scripts/fixture-server.js.
function fetchUrlFor(url, fixtureBaseUrl) {
  const u = parseUrl(url);
  if (!u) return url;
  if (fixtureBaseUrl && isReservedHost(u.host)) {
    return fixtureBaseUrl.replace(/\/$/, '') + '/' + u.host + u.path + (u.query || '');
  }
  return url;
}

module.exports = {
  parseUrl, formatUrl, normalizeWebsite, resolveUrl, sameSite, registrableDomain, isReservedHost,
  isSocialHost, fetchUrlFor, normalizePath,
};
