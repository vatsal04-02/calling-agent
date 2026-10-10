'use strict';
const { clean, truncate, uniq, toCell, isoNow, safeJsonParse } = require('./util');
const { parseUrl, sameSite, fetchUrlFor } = require('./url');
const { isAllowed, robotsFromResponse } = require('./robots');
const { extractPage } = require('./html');
const { detectSignals } = require('./signals');

const CATEGORIES = [
  { name: 'contact', re: /\b(contact|get[- ]in[- ]touch|reach[- ]us|enquir|inquir|find[- ]us|locations?)\b/i, priority: 1 },
  { name: 'booking', re: /\b(book|booking|appointments?|schedule|reserve|reservations?)\b/i, priority: 2 },
  { name: 'services', re: /\b(services?|treatments?|what[- ]we[- ]do|solutions|our[- ]work|specialt(y|ies)|procedures|menu)\b/i, priority: 3 },
  { name: 'quote', re: /\b(quote|estimate|pricing|prices|fees|rates|cost)\b/i, priority: 4 },
  { name: 'faq', re: /\b(faqs?|frequently[- ]asked|questions|help)\b/i, priority: 5 },
  { name: 'new_clients', re: /\b(new[- ]patients?|new[- ]clients?|patient[- ](info|forms)|first[- ]visit|forms)\b/i, priority: 6 },
];
const SKIP_PATH = /\.(pdf|jpe?g|png|gif|webp|svg|zip|docx?|xlsx?|pptx?|mp4|mov|mp3|ics|xml|json|css|js)(\?|$)|\/(wp-admin|wp-login|login|log-in|signin|sign-in|account|my-account|cart|checkout|basket|portal|admin|feed|tag|author|privacy|terms|cookie|careers|jobs)(\/|$|\?)/i;

function categorise(link) {
  const hay = `${link.text} ${(parseUrl(link.href) || {}).path || ''}`.replace(/[-_/]+/g, ' ');
  for (const c of CATEGORIES) if (c.re.test(hay)) return c;
  return null;
}

// Choose up to (maxPages - 1) internal pages, one per category, by priority.
function selectPages(homepage, robotsGroups, settings) {
  const max = Math.max(1, (settings.research && settings.research.max_pages_per_site) || 4) - 1;
  const ua = (settings.research && settings.research.user_agent) || 'FlowHQ-ResearchBot';
  const chosen = {};
  for (const link of homepage.links || []) {
    if (!sameSite(link.href, homepage.url)) continue;
    const u = parseUrl(link.href);
    if (!u || SKIP_PATH.test(u.path) || u.path === '/' || u.query.length > 60) continue;
    if (robotsGroups && !isAllowed(robotsGroups, ua, u.path)) continue;
    const c = categorise(link);
    if (!c) continue;
    const prev = chosen[c.name];
    if (!prev || u.path.length < prev.path_len) chosen[c.name] = { url: link.href, category: c.name, priority: c.priority, path_len: u.path.length };
  }
  return Object.values(chosen).sort((a, b) => a.priority - b.priority).slice(0, max).map((c) => ({ url: c.url, category: c.category }));
}

// Normalise an n8n HTTP Request result (fullResponse + neverError, or an error item).
function interpretResponse(item, maxChars) {
  const j = item || {};
  if (j.error) {
    const msg = clean(typeof j.error === 'string' ? j.error : j.error.message || JSON.stringify(j.error));
    const timeout = /timeout|timed out|ETIMEDOUT|ESOCKETTIMEDOUT|aborted/i.test(msg);
    const dns = /ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(msg);
    return { ok: false, status: 0, kind: timeout ? 'TIMEOUT' : dns ? 'DNS_FAILURE' : 'NETWORK_ERROR', error: truncate(msg, 300) };
  }
  const status = Number(j.statusCode || j.status || 0);
  const headers = j.headers || {};
  const ctype = String(headers['content-type'] || headers['Content-Type'] || '');
  let body = j.body !== undefined ? j.body : j.data;
  if (body && typeof body === 'object') body = JSON.stringify(body);
  body = String(body || '');
  if (status === 401 || status === 403 || status === 429 || status === 503) {
    return { ok: false, status, kind: status === 429 ? 'RATE_LIMITED' : 'BLOCKED', error: `HTTP ${status}`, body: body.slice(0, 2000) };
  }
  if (status < 200 || status >= 300) return { ok: false, status, kind: 'HTTP_ERROR', error: `HTTP ${status}` };
  if (ctype && !/html|xml|text\/plain/i.test(ctype)) return { ok: false, status, kind: 'NOT_HTML', error: `content-type ${truncate(ctype, 60)}` };
  if (/cf-chl-|challenge-platform|captcha|g-recaptcha|hcaptcha|Access Denied|Attention Required/i.test(body.slice(0, 20000)) && body.length < 60000 && !/<form[^>]*contact/i.test(body)) {
    return { ok: false, status, kind: 'BOT_CHALLENGE', error: 'anti-bot challenge page' };
  }
  return { ok: true, status, body: body.slice(0, maxChars || 600000), truncated: body.length > (maxChars || 600000) };
}

/**
 * Build the per-domain research record from fetched pages.
 * fetched: [{ url, category, response }] where response is an n8n HTTP item; first entry = homepage.
 */
function buildResearch(input) {
  const { lead, robots, fetched, settings, compliance } = input;
  const now = isoNow(input.now);
  const rs = settings.research || {};
  const pages = [];
  const errors = [];
  for (const f of fetched || []) {
    const r = interpretResponse(f.response, rs.max_html_chars);
    if (!r.ok) { errors.push({ url: f.url, kind: r.kind, error: r.error }); continue; }
    const page = extractPage(r.body, f.url, { maxChars: rs.max_html_chars });
    page.category = f.category || 'home';
    pages.push(page);
  }
  const homeOk = pages.length && pages[0].category === 'home';
  let accessStatus = 'OK';
  if (robots && robots.blocked) accessStatus = 'BLOCKED_BY_ROBOTS_TXT';
  else if (!homeOk) {
    const homeErr = errors.find((e) => e.url === (fetched[0] || {}).url) || errors[0] || {};
    accessStatus = homeErr.kind || 'UNREACHABLE';
  }
  const totalText = pages.reduce((n, p) => n + p.text_chars, 0);
  const home = homeOk ? pages[0] : null;
  const jsSuspected = !!home && home.text_chars < (rs.min_text_chars || 400) && home.script_count >= 5;
  if (accessStatus === 'OK' && jsSuspected) accessStatus = 'JS_RENDERED_SUSPECTED';
  else if (accessStatus === 'OK' && totalText < (rs.min_text_chars || 400)) accessStatus = 'INSUFFICIENT_CONTENT';

  const signals = accessStatus === 'OK' ? detectSignals(pages, {
    industry_group: lead.industry_group,
    coverage: { page_count: pages.length, has_contact_page: pages.some((p) => p.category === 'contact'), js_suspected: jsSuspected },
  }) : [];

  const emailsFound = uniq([].concat(...pages.map((p) => p.emails || []))).slice(0, 25);
  const emailPages = {};
  for (const p of pages) for (const e of p.emails || []) if (!emailPages[e]) emailPages[e] = p.url;
  let noUnsolicited = '';
  const patterns = ((compliance && compliance.no_unsolicited_patterns) || []).map((s) => new RegExp(s, 'i'));
  for (const p of pages) {
    for (const re of patterns) {
      const m = re.exec(p.text || '');
      if (m) {
        const t = p.text || '';
        const start = Math.max(0, t.lastIndexOf('\n', m.index) + 1);
        const endNl = t.indexOf('\n', m.index);
        noUnsolicited = `${p.url}: "${truncate(clean(t.slice(start, endNl < 0 ? t.length : endNl)), 160)}"`;
        break;
      }
    }
    if (noUnsolicited) break;
  }

  const summary = accessStatus !== 'OK'
    ? `Research incomplete (${accessStatus}). ${errors.map((e) => `${e.url}: ${e.kind}`).join('; ')}`
    : truncate(`${pages.length} page(s) reviewed (${pages.map((p) => p.category).join(', ')}). ` +
      (home.title ? `Title: "${home.title}". ` : '') +
      `Signals: ${signals.map((s) => s.id).join(', ') || 'none'}.`, 600);

  return {
    domain: lead.domain,
    researched_at: now,
    access_status: accessStatus,
    pages_reviewed: pages.map((p) => p.url),
    page_categories: pages.map((p) => p.category),
    text_chars: totalText,
    signals,
    emails_found: emailsFound,
    email_pages: emailPages,
    no_unsolicited_notice: noUnsolicited,
    fetch_errors: errors,
    summary,
    site_title: home ? home.title : '',
    meta_description: home ? home.meta_description : '',
  };
}

function cacheRowFromResearch(r, settings) {
  const days = (settings.research && settings.research.cache_days) || 30;
  const expires = new Date(new Date(r.researched_at).getTime() + days * 86400000).toISOString();
  return {
    domain: r.domain,
    researched_at: r.researched_at,
    expires_at: expires,
    access_status: r.access_status,
    pages_reviewed: r.pages_reviewed.join('\n'),
    signals_json: toCell(r.signals),
    emails_found: toCell(r.email_pages, 8000),
    no_unsolicited_notice: r.no_unsolicited_notice,
    text_chars: r.text_chars,
    summary: r.summary,
    research_json: toCell({ page_categories: r.page_categories, fetch_errors: r.fetch_errors, site_title: r.site_title, meta_description: r.meta_description }, 20000),
  };
}

function researchFromCacheRow(row) {
  const extra = safeJsonParse(row.research_json, {});
  const emailPages = safeJsonParse(row.emails_found, {});
  return {
    domain: clean(row.domain).toLowerCase(),
    researched_at: row.researched_at,
    access_status: clean(row.access_status),
    pages_reviewed: String(row.pages_reviewed || '').split('\n').filter(Boolean),
    page_categories: extra.page_categories || [],
    text_chars: Number(row.text_chars) || 0,
    signals: safeJsonParse(row.signals_json, []),
    emails_found: Object.keys(emailPages),
    email_pages: emailPages,
    no_unsolicited_notice: clean(row.no_unsolicited_notice),
    fetch_errors: extra.fetch_errors || [],
    summary: row.summary || '',
    site_title: extra.site_title || '',
    meta_description: extra.meta_description || '',
    from_cache: true,
  };
}

function isCacheFresh(row, now) {
  if (!row || !row.expires_at) return false;
  const exp = Date.parse(row.expires_at);
  return Number.isFinite(exp) && exp > new Date(now || Date.now()).getTime();
}

// Plan for one lead: use cache, or fetch robots.txt first.
function planResearch(lead, cacheByDomain, settings, now) {
  const cached = cacheByDomain[lead.domain];
  if (cached && isCacheFresh(cached, now) && !String(lead.reprocess).toUpperCase().startsWith('TRUE')) {
    return { use_cache: true, research: researchFromCacheRow(cached) };
  }
  const root = parseUrl(lead.website);
  const robotsUrl = root ? `${root.scheme}://${root.host}${root.port ? ':' + root.port : ''}/robots.txt` : '';
  return { use_cache: false, robots_url: robotsUrl, robots_fetch_url: fetchUrlFor(robotsUrl, settings.fixture_base_url) };
}

function robotsDecision(lead, robotsResponse, settings) {
  const rs = settings.research || {};
  if (rs.respect_robots_txt === false) return { blocked: false, groups: [], state: 'ignored' };
  const j = robotsResponse || {};
  let parsed;
  if (j.error) parsed = robotsFromResponse(0, '');
  else parsed = robotsFromResponse(j.statusCode, typeof j.body === 'string' ? j.body : '');
  const home = parseUrl(lead.website);
  const allowed = isAllowed(parsed.groups, rs.user_agent, home ? home.path : '/');
  return { blocked: !allowed, groups: parsed.groups, state: parsed.state };
}

// Map research onto the Leads row columns.
function leadUpdateFromResearch(lead, research, settings) {
  const s0 = research.signals[0] || {};
  const s1 = research.signals[1] || {};
  const email = clean(lead.email).toLowerCase();
  const ok = research.access_status === 'OK';
  const hasSignals = research.signals.length > 0;
  return {
    lead_id: lead.lead_id,
    website_access_status: research.access_status,
    pages_reviewed: research.pages_reviewed.join('\n'),
    signals_json: toCell(research.signals),
    observed_issue_1: s0.statement || '',
    evidence_url_1: s0.evidence_url || '',
    evidence_snippet_1: s0.evidence_snippet || '',
    observed_issue_2: s1.statement || '',
    evidence_url_2: s1.evidence_url || '',
    evidence_snippet_2: s1.evidence_snippet || '',
    email_published_url: (research.email_pages && research.email_pages[email]) || '',
    no_unsolicited_notice: research.no_unsolicited_notice || '',
    research_summary: research.summary + (research.from_cache ? ' (from cache)' : ''),
    researched_at: research.researched_at,
    outreach_status: ok && hasSignals ? 'RESEARCHED' : 'MANUAL_REVIEW',
    status_reason: ok ? (hasSignals ? '' : 'no_credible_observations') : `research_${research.access_status.toLowerCase()}`,
    reprocess: '',
    updated_at: isoNow(),
  };
}

module.exports = {
  selectPages, interpretResponse, buildResearch, cacheRowFromResearch, researchFromCacheRow, isCacheFresh,
  planResearch, robotsDecision, leadUpdateFromResearch, categorise,
};
