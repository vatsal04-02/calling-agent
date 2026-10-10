'use strict';
const { clean, str, stableHash, randomToken, truthy, isoNow, toCell } = require('./util');
const { normalizeWebsite, isReservedHost, registrableDomain } = require('./url');
const { STATUS, APPROVAL } = require('./status');

function normHeader(h) {
  return str(h).toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Decide which source column feeds each canonical field.
function buildColumnMap(headers, mapping) {
  const map = {};
  const used = new Set();
  const byNorm = {};
  for (const h of headers) {
    const n = normHeader(h);
    if (n && byNorm[n] === undefined) byNorm[n] = h;
  }
  const explicit = (mapping && mapping.explicit) || {};
  for (const field of Object.keys(explicit)) {
    const src = explicit[field];
    if (src && headers.includes(src)) { map[field] = src; used.add(src); }
  }
  const aliases = (mapping && mapping.aliases) || {};
  // Canonical names themselves always count as aliases.
  for (const field of Object.keys(aliases)) {
    if (map[field]) continue;
    const candidates = [field].concat(aliases[field] || []);
    for (const alias of candidates) {
      const h = byNorm[normHeader(alias)];
      if (h !== undefined && !used.has(h)) { map[field] = h; used.add(h); break; }
    }
  }
  return map;
}

function mapRow(row, columnMap) {
  const out = {};
  for (const field of Object.keys(columnMap)) out[field] = row[columnMap[field]];
  return out;
}

const ROLE_LOCALS = ['info', 'hello', 'admin', 'office', 'contact', 'enquiries', 'enquiry', 'inquiries', 'inquiry',
  'sales', 'support', 'reception', 'bookings', 'booking', 'appointments', 'team', 'mail', 'accounts', 'service',
  'help', 'frontdesk', 'practice', 'clinic', 'studio', 'general'];
const BLOCKED_LOCALS = /^(no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|abuse|bounce[s]?|spam|unsubscribe|privacy|dpo|legal)$/i;
const EMAIL_RE = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;

function normalizeEmail(raw, opts) {
  const options = opts || {};
  let s = clean(raw).toLowerCase();
  if (!s) return { ok: false, reason: 'missing_email' };
  s = s.replace(/^mailto:/, '').replace(/^[<("']+|[>)"',;.]+$/g, '');
  if (/[\s,;]/.test(s) && s.split(/[\s,;]+/).filter(Boolean).length > 1) return { ok: false, reason: 'multiple_emails_in_cell' };
  if (!EMAIL_RE.test(s) || s.length > 254) return { ok: false, reason: 'invalid_email_format' };
  const [local, domain] = s.split('@');
  if (local.length > 64) return { ok: false, reason: 'invalid_email_format' };
  if (BLOCKED_LOCALS.test(local)) return { ok: false, reason: 'non_personal_system_address' };
  if (isReservedHost(domain) && !options.allowSynthetic) return { ok: false, reason: 'reserved_test_domain' };
  return { ok: true, email: s, domain: registrableDomain(domain), role_address: ROLE_LOCALS.includes(local.replace(/[^a-z]/g, '')) };
}

const COUNTRY_ALIASES = {
  US: ['us', 'usa', 'u.s.', 'u.s.a.', 'united states', 'united states of america', 'america'],
  GB: ['gb', 'uk', 'u.k.', 'united kingdom', 'great britain', 'britain', 'england', 'scotland', 'wales', 'northern ireland'],
  AU: ['au', 'aus', 'australia'],
  NZ: ['nz', 'new zealand', 'aotearoa', 'aotearoa new zealand'],
  CA: ['ca', 'can', 'canada'],
  IE: ['ie', 'ireland', 'republic of ireland'],
  IN: ['in', 'ind', 'india'],
};

function normalizeCountry(raw, website) {
  const s = clean(raw).toLowerCase().replace(/\s+/g, ' ');
  if (s) {
    for (const code of Object.keys(COUNTRY_ALIASES)) {
      if (COUNTRY_ALIASES[code].includes(s)) return { code, inferred: false };
    }
    if (/^[a-z]{2}$/.test(s)) return { code: s.toUpperCase(), inferred: false };
    return { code: s.toUpperCase(), inferred: false, unrecognised: true };
  }
  const host = str(website).toLowerCase();
  if (/\.au(\/|$)/.test(host)) return { code: 'AU', inferred: true };
  if (/\.nz(\/|$)/.test(host)) return { code: 'NZ', inferred: true };
  if (/\.uk(\/|$)/.test(host)) return { code: 'GB', inferred: true };
  if (/\.us(\/|$)/.test(host)) return { code: 'US', inferred: true };
  return { code: '', inferred: false };
}

const GENERIC_NAME_WORDS = new Set(['reception', 'receptionist', 'admin', 'administrator', 'office', 'team', 'manager',
  'info', 'sales', 'support', 'enquiries', 'enquiry', 'inquiries', 'frontdesk', 'front', 'desk', 'owner', 'practice',
  'hello', 'contact', 'accounts', 'bookings', 'marketing', 'director', 'staff', 'unknown', 'na', 'n/a', 'none',
  'customer', 'service', 'general', 'the', 'sir', 'madam', 'business', 'company', 'test']);
const HONORIFICS = { dr: 'Dr', 'dr.': 'Dr', mr: 'Mr', 'mr.': 'Mr', mrs: 'Mrs', 'mrs.': 'Mrs', ms: 'Ms', 'ms.': 'Ms', miss: 'Miss', prof: 'Prof', 'prof.': 'Prof' };

function titleCase(w) {
  return w.split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join('-');
}

// Only ever returns a name that was actually provided. Never invents one.
function parseContactName(contact, first, last, businessName) {
  let full = clean(contact);
  if (!full && (clean(first) || clean(last))) full = clean(`${clean(first)} ${clean(last)}`);
  if (!full || full.includes('@') || /\d/.test(full)) return { contact_name: full && !full.includes('@') ? full : '', greeting_name: '' };
  if (businessName && full.toLowerCase() === clean(businessName).toLowerCase()) return { contact_name: '', greeting_name: '' };
  const tokens = full.split(/\s+/);
  let honorific = '';
  if (HONORIFICS[tokens[0].toLowerCase()]) honorific = HONORIFICS[tokens.shift().toLowerCase()];
  const nameTokens = tokens.filter((t) => /^[\p{L}][\p{L}'’-]*\.?$/u.test(t));
  if (!nameTokens.length || nameTokens.length !== tokens.length) return { contact_name: full, greeting_name: '' };
  if (nameTokens.some((t) => GENERIC_NAME_WORDS.has(t.toLowerCase().replace(/[^a-z/]/g, '')))) return { contact_name: full, greeting_name: '' };
  if (nameTokens[0].replace(/\./g, '').length < 2) return { contact_name: full, greeting_name: '' };
  let greeting;
  if (honorific === 'Dr' || honorific === 'Prof') {
    greeting = nameTokens.length >= 2 ? `${honorific} ${titleCase(nameTokens[nameTokens.length - 1])}` : `${honorific} ${titleCase(nameTokens[0])}`;
  } else if (honorific && nameTokens.length === 1) {
    greeting = `${honorific} ${titleCase(nameTokens[0])}`;
  } else {
    greeting = titleCase(nameTokens[0]);
  }
  return { contact_name: full, greeting_name: greeting };
}

function classifyIndustry(industry, catalogue) {
  const s = clean(industry).toLowerCase();
  const groups = (catalogue && catalogue.industry_groups) || {};
  for (const g of Object.keys(groups)) {
    if (groups[g].some((k) => s.includes(k))) return g;
  }
  return s ? 'other' : '';
}

function sanitizeLeadId(v) {
  return clean(v).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
}

function suppressionIndex(rows) {
  const emails = new Set();
  const domains = new Set();
  for (const r of rows || []) {
    const value = clean(r.value || r.email || r.domain).toLowerCase();
    if (!value) continue;
    const type = clean(r.type).toLowerCase();
    if (type === 'domain' || (!value.includes('@') && value.includes('.'))) domains.add(registrableDomain(value.replace(/^@/, '')));
    else emails.add(value);
  }
  return { emails, domains };
}

function isSuppressed(index, email, domain) {
  if (email && index.emails.has(String(email).toLowerCase())) return 'email_suppressed';
  if (domain && index.domains.has(domain)) return 'domain_suppressed';
  if (email && index.domains.has(String(email).split('@')[1] || '')) return 'domain_suppressed';
  return '';
}

/**
 * Turn raw source rows into Leads records. Pure function: returns records to
 * append; rows already imported (same lead_id) are skipped, so re-running the
 * import is safe.
 */
function prepareImport(input) {
  const { sourceRows, existingLeads, suppressionRows, settings, mapping, catalogue } = input;
  const now = isoNow(input.now);
  const allowSynthetic = !!settings.allow_synthetic_domains;
  const enabledCountries = ((settings.countries && settings.countries.enabled) || []).map((c) => c.toUpperCase());
  const onePerDomain = !(settings.sending && settings.sending.one_contact_per_domain === false);
  const skipStatuses = ((mapping && mapping.source_statuses_to_skip) || []).map((s) => s.toLowerCase());

  const headers = [];
  for (const r of sourceRows) for (const k of Object.keys(r)) if (!headers.includes(k) && k !== 'row_number') headers.push(k);
  const columnMap = buildColumnMap(headers, mapping);

  const existingIds = new Set();
  const seenEmails = new Map();
  const seenDomains = new Map();
  for (const l of existingLeads || []) {
    const id = clean(l.lead_id);
    if (id) existingIds.add(id);
    if ([STATUS.INVALID, STATUS.DUPLICATE].includes(clean(l.outreach_status))) continue;
    const e = clean(l.email).toLowerCase();
    if (e && !seenEmails.has(e)) seenEmails.set(e, id);
    const d = clean(l.domain).toLowerCase();
    if (d && !seenDomains.has(d)) seenDomains.set(d, id);
  }
  const suppression = suppressionIndex(suppressionRows);
  const occurrences = new Map();
  const records = [];
  const stats = { source_rows: sourceRows.length, skipped_existing: 0, by_status: {}, column_map: columnMap };

  sourceRows.forEach((row, idx) => {
    const m = mapRow(row, columnMap);
    const errors = [];
    const businessName = clean(m.business_name);
    if (!businessName) errors.push('missing_business_name');
    const em = normalizeEmail(m.email, { allowSynthetic });
    if (!em.ok) errors.push(em.reason);
    const web = normalizeWebsite(m.website, { allowSynthetic });
    if (!web.ok) errors.push(web.reason);
    const country = normalizeCountry(m.country, web.ok ? web.url : m.website);
    const name = parseContactName(m.contact_name, m.first_name, m.last_name, businessName);

    const fingerprint = [em.ok ? em.email : clean(m.email).toLowerCase(), web.ok ? web.domain : clean(m.website).toLowerCase(), businessName.toLowerCase()].join('|');
    let leadId = sanitizeLeadId(m.lead_id);
    if (!leadId) {
      const n = occurrences.get(fingerprint) || 0;
      occurrences.set(fingerprint, n + 1);
      leadId = 'L' + stableHash(fingerprint) + (n ? '-' + (n + 1) : '');
    }
    if (existingIds.has(leadId)) { stats.skipped_existing++; return; }
    existingIds.add(leadId);

    let status = STATUS.VALIDATED;
    let reason = '';
    let duplicateOf = '';
    const srcStatus = clean(m.outreach_status).toLowerCase();
    const supp = isSuppressed(suppression, em.ok ? em.email : '', web.ok ? web.domain : '');
    if (srcStatus && skipStatuses.includes(srcStatus)) {
      status = STATUS.SKIPPED_SOURCE_STATUS; reason = `source_status:${srcStatus}`;
    } else if (errors.length) {
      status = STATUS.INVALID; reason = errors.join(',');
    } else if (supp) {
      status = STATUS.SUPPRESSED; reason = supp;
    } else if (seenEmails.has(em.email)) {
      status = STATUS.DUPLICATE; reason = 'duplicate_email'; duplicateOf = seenEmails.get(em.email);
    } else if (onePerDomain && seenDomains.has(web.domain)) {
      status = STATUS.DUPLICATE; reason = 'same_domain_already_listed'; duplicateOf = seenDomains.get(web.domain);
    } else if (!country.code) {
      status = STATUS.MANUAL_REVIEW; reason = 'country_unknown_add_country_then_set_reprocess';
    } else if (!enabledCountries.includes(country.code)) {
      status = STATUS.COUNTRY_NOT_ENABLED; reason = `country:${country.code}`;
    }
    if (status === STATUS.VALIDATED || status === STATUS.MANUAL_REVIEW) {
      seenEmails.set(em.email, leadId);
      seenDomains.set(web.domain, leadId);
    }

    const original = {};
    for (const k of Object.keys(row)) if (k !== 'row_number') original[k] = row[k];
    records.push({
      lead_id: leadId,
      business_name: businessName,
      contact_name: name.contact_name,
      first_name: name.greeting_name,
      email: em.ok ? em.email : clean(m.email),
      role_address: em.ok ? String(!!em.role_address).toUpperCase() : '',
      website: web.ok ? web.url : clean(m.website),
      domain: web.ok ? web.domain : '',
      country: country.code,
      country_inferred: country.inferred ? 'TRUE' : '',
      industry: clean(m.industry),
      industry_group: classifyIndustry(m.industry, catalogue),
      source: clean(m.source),
      notes: clean(m.notes),
      phone: clean(m.phone),
      legal_basis_confirmed: truthy(m.legal_basis_confirmed) ? 'TRUE' : '',
      source_row_number: row.row_number !== undefined ? row.row_number : idx + 2,
      original_row_json: toCell(original),
      imported_at: now,
      outreach_status: status,
      status_reason: reason,
      validation_errors: errors.join(','),
      duplicate_of: duplicateOf,
      approval_status: APPROVAL.PENDING,
      opt_out_status: status === STATUS.SUPPRESSED ? 'SUPPRESSED' : '',
      unsubscribe_token: randomToken(24),
      retry_count: 0,
      reprocess: '',
      updated_at: now,
    });
    stats.by_status[status] = (stats.by_status[status] || 0) + 1;
  });
  return { records, stats };
}

module.exports = {
  normHeader, buildColumnMap, mapRow, normalizeEmail, normalizeCountry, parseContactName, classifyIndustry,
  suppressionIndex, isSuppressed, prepareImport,
};
