'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { parseCsv } = require('../scripts/csv');
const L = require('../lib/leads');
const { normalizeWebsite } = require('../lib/url');
const { readJson, testSettings, ROOT } = require('./helpers');

const mapping = readJson('config/field-mapping.json');
const catalogue = readJson('config/service-catalogue.json');
const rows = parseCsv(fs.readFileSync(path.join(ROOT, 'data/synthetic/leads.synthetic.csv'), 'utf8'));
const suppression = parseCsv(fs.readFileSync(path.join(ROOT, 'data/synthetic/suppression.synthetic.csv'), 'utf8'));
const settings = testSettings(null);
const run = (existing) => L.prepareImport({ sourceRows: rows, existingLeads: existing || [], suppressionRows: suppression, settings, mapping, catalogue });
const byName = (records, n) => records.find((r) => r.business_name === n);

test('maps differently named columns through aliases and preserves the original row', () => {
  const { records, stats } = run();
  assert.equal(stats.column_map.business_name, 'Company Name');
  assert.equal(stats.column_map.email, 'E-mail');
  assert.equal(stats.column_map.website, 'Web Site');
  const r = byName(records, 'Bright Smile Dental');
  assert.equal(JSON.parse(r.original_row_json).City, 'Austin', 'unmapped columns are preserved');
});

test('explicit mapping overrides aliases', () => {
  const m = L.buildColumnMap(['Org', 'Mail', 'URL'], { explicit: { business_name: 'Org', email: 'Mail' }, aliases: mapping.aliases });
  assert.deepEqual([m.business_name, m.email, m.website], ['Org', 'Mail', 'URL']);
});

test('normalizes websites and emails safely', () => {
  assert.equal(normalizeWebsite('www.Example-Biz.com/about?utm_source=x').url, 'https://www.example-biz.com/');
  assert.equal(normalizeWebsite('www.Example-Biz.com').domain, 'example-biz.com');
  assert.equal(normalizeWebsite('https://instagram.com/x').reason, 'social_or_directory_profile_not_website');
  assert.equal(normalizeWebsite('ftp://x.com').reason, 'unsupported_scheme');
  assert.equal(normalizeWebsite('http://10.0.0.1').reason, 'ip_address_not_allowed');
  assert.equal(normalizeWebsite('shop.example').reason, 'reserved_test_domain');
  assert.equal(L.normalizeEmail(' Info@Biz.COM ').email, 'info@biz.com');
  assert.equal(L.normalizeEmail('info@biz.com').role_address, true);
  assert.equal(L.normalizeEmail('noreply@biz.com').ok, false);
  assert.equal(L.normalizeEmail('a@b.com; c@d.com').reason, 'multiple_emails_in_cell');
  assert.equal(L.normalizeEmail('not-an-email').reason, 'invalid_email_format');
});

test('never invents a contact name; falls back when missing or generic', () => {
  assert.equal(L.parseContactName('Dr. Sarah Chen').greeting_name, 'Dr Chen');
  assert.equal(L.parseContactName('mere ngata').greeting_name, 'Mere');
  assert.equal(L.parseContactName('').greeting_name, '');
  assert.equal(L.parseContactName('Reception').greeting_name, '');
  assert.equal(L.parseContactName('Front Desk Team').greeting_name, '');
  assert.equal(L.parseContactName('Acme Ltd', '', '', 'Acme Ltd').greeting_name, '');
});

test('assigns statuses: invalid, duplicate, suppressed, country, source status', () => {
  const { records, stats } = run();
  assert.equal(stats.source_rows, 18);
  assert.equal(byName(records, 'Bad Email Co').outreach_status, 'INVALID');
  const dup = byName(records, 'BRIGHT SMILE DENTAL');
  assert.equal(dup.outreach_status, 'DUPLICATE');
  assert.equal(dup.duplicate_of, byName(records, 'Bright Smile Dental').lead_id);
  assert.equal(byName(records, 'Coastal Vets').outreach_status, 'SUPPRESSED');
  assert.equal(byName(records, 'Maple Dental').outreach_status, 'COUNTRY_NOT_ENABLED');
  assert.equal(byName(records, 'Insta Salon').outreach_status, 'INVALID');
  assert.equal(byName(records, 'No Site Builders').status_reason, 'missing_website');
  assert.equal(byName(records, 'Do Not Contact Ltd').outreach_status, 'SKIPPED_SOURCE_STATUS');
  assert.equal(byName(records, 'Harbour Plumbing').first_name, '', 'no contact name -> no greeting name');
  assert.equal(byName(records, 'Oxford Hair Studio').country, 'GB');
});

test('lead ids are stable and re-running the import adds nothing', () => {
  const first = run();
  const second = L.prepareImport({ sourceRows: rows, existingLeads: first.records, suppressionRows: suppression, settings, mapping, catalogue });
  assert.equal(second.records.length, 0);
  assert.equal(second.stats.skipped_existing, 18);
  const again = run();
  assert.deepEqual(again.records.map((r) => r.lead_id), first.records.map((r) => r.lead_id));
  assert.equal(new Set(first.records.map((r) => r.lead_id)).size, 18, 'ids are unique');
});

test('one contact per domain by default', () => {
  const extra = rows.concat([{ 'Company Name': 'Bright Smile Dental', Contact: 'Bob', 'E-mail': 'bob@brightsmile-dental.example', 'Web Site': 'brightsmile-dental.example', Country: 'US' }]);
  const { records } = L.prepareImport({ sourceRows: extra, existingLeads: [], suppressionRows: [], settings, mapping, catalogue });
  assert.equal(records[records.length - 1].status_reason, 'same_domain_already_listed');
});

test('infers country from ccTLD only when the column is empty', () => {
  assert.deepEqual(L.normalizeCountry('', 'https://shop.com.au/'), { code: 'AU', inferred: true });
  assert.equal(L.normalizeCountry('', 'https://shop.com/').code, '');
  assert.equal(L.normalizeCountry('England').code, 'GB');
});
