'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseRobots, isAllowed, robotsFromResponse } = require('../lib/robots');
const { extractPage } = require('../lib/html');
const R = require('../lib/research');
const { detectSignals } = require('../lib/signals');
const { resolveUrl } = require('../lib/url');
const { createStore, runImport, runResearch, updateRows } = require('../scripts/local-pipeline');
const { parseCsv } = require('../scripts/csv');
const fs = require('fs');
const path = require('path');
const { startServers, testSettings, ROOT, readJson } = require('./helpers');

test('robots.txt: longest match, agent groups, wildcards, RFC 9309 error handling', () => {
  const g = parseRobots('User-agent: *\nDisallow: /private\nAllow: /private/ok\n\nUser-agent: FlowHQ-ResearchBot\nDisallow: /no-bots$\n');
  assert.equal(isAllowed(g, 'FlowHQ-ResearchBot/1.0', '/private'), true, 'specific group replaces *');
  assert.equal(isAllowed(g, 'FlowHQ-ResearchBot/1.0', '/no-bots'), false);
  assert.equal(isAllowed(g, 'OtherBot', '/private/x'), false);
  assert.equal(isAllowed(g, 'OtherBot', '/private/ok/1'), true);
  assert.equal(isAllowed(parseRobots('User-agent: *\nDisallow: /*.pdf$'), 'x', '/a/b.pdf'), false);
  assert.equal(robotsFromResponse(404, '').groups.length, 0, '4xx = no restrictions');
  assert.equal(isAllowed(robotsFromResponse(503, '').groups, 'x', '/'), false, '5xx = full disallow');
});

test('URL resolution handles relative, root, protocol-relative and junk links', () => {
  assert.equal(resolveUrl('https://a.com/x/y', '../contact'), 'https://a.com/contact');
  assert.equal(resolveUrl('https://a.com/x/', 'b'), 'https://a.com/x/b');
  assert.equal(resolveUrl('https://a.com/', '//cdn.a.com/z'), 'https://cdn.a.com/z');
  assert.equal(resolveUrl('https://a.com/', 'javascript:void(0)'), null);
  assert.equal(resolveUrl('https://a.com/', '#top'), null);
});

test('HTML extraction pulls text, links, forms, tel/mailto and widgets; ignores scripts', () => {
  const html = `<html><head><title>T &amp; Co</title><script>var x="<a href='/evil'>"</script></head><body>
  <a href="/contact">Contact us</a><a href="tel:+1 555">Call now</a><a href="mailto:hi@x.com?subject=a">mail</a>
  <form><input type="email" name="email"><textarea name="msg"></textarea></form>
  <form role="search"><input type="search" name="q"></form>
  <script src="https://embed.tawk.to/1"></script><a href="https://x.cliniko.com/bookings">Book</a></body></html>`;
  const p = extractPage(html, 'https://x.com/');
  assert.equal(p.title, 'T & Co');
  assert.ok(p.links.some((l) => l.href === 'https://x.com/contact'));
  assert.ok(!p.links.some((l) => l.href.includes('evil')), 'links inside scripts are ignored by text, raw anchors only');
  assert.deepEqual(p.tel_links.map((t) => t.text), ['Call now']);
  assert.deepEqual(p.emails, ['hi@x.com']);
  assert.equal(p.forms.filter((f) => f.kind === 'enquiry').length, 1);
  assert.equal(p.forms.filter((f) => f.kind === 'search').length, 1);
  assert.deepEqual(p.chat_widgets, ['tawk']);
  assert.deepEqual(p.booking_widgets, ['cliniko']);
});

test('page selection: max 4 pages total, internal only, skips private/file paths and robots-disallowed', () => {
  const home = extractPage(`<a href="/contact">Contact</a><a href="/book-online">Book</a><a href="/services">Services</a><a href="/faq">FAQ</a>
    <a href="/pricing">Pricing</a><a href="/login">Login</a><a href="/forms/new.pdf">New patient form</a><a href="https://other.com/contact">Partner</a>`, 'https://biz.com/');
  const robots = parseRobots('User-agent: *\nDisallow: /book-online');
  const pages = R.selectPages(home, robots, { research: { max_pages_per_site: 4, user_agent: 'FlowHQ-ResearchBot/1.0' } });
  assert.equal(pages.length, 3);
  assert.deepEqual(pages.map((p) => p.category), ['contact', 'services', 'quote']);
  assert.ok(pages.every((p) => p.url.startsWith('https://biz.com/')));
});

test('"not found" signals are suppressed when coverage is too thin or the site is JS-rendered', () => {
  const home = extractPage('<html><body><h1>Dental care</h1><p>' + 'We look after families. '.repeat(30) + '</p><a href="/about">About</a></body></html>', 'https://d.com/');
  home.category = 'home';
  const one = detectSignals([home], { industry_group: 'appointment', coverage: { page_count: 1, has_contact_page: false } });
  assert.ok(!one.some((s) => s.id === 'booking_not_found'), 'single page: no absence claims about booking');
  const second = Object.assign({}, home, { url: 'https://d.com/about', category: 'services' });
  const two = detectSignals([home, second], { industry_group: 'appointment', coverage: { page_count: 2, has_contact_page: false } });
  assert.ok(two.some((s) => s.id === 'booking_not_found' && s.claim_type === 'not_found' && /couldn't find/.test(s.statement)));
  const js = detectSignals([home, second], { industry_group: 'appointment', coverage: { page_count: 2, js_suspected: true } });
  assert.ok(!js.some((s) => s.claim_type === 'not_found'));
});

test('interpretResponse classifies timeouts, DNS, blocks, non-HTML and challenges', () => {
  assert.equal(R.interpretResponse({ error: { message: 'timeout of 15000ms exceeded' } }).kind, 'TIMEOUT');
  assert.equal(R.interpretResponse({ error: { message: 'getaddrinfo ENOTFOUND x.com' } }).kind, 'DNS_FAILURE');
  assert.equal(R.interpretResponse({ statusCode: 403, body: '' }).kind, 'BLOCKED');
  assert.equal(R.interpretResponse({ statusCode: 200, headers: { 'content-type': 'application/pdf' }, body: '%PDF' }).kind, 'NOT_HTML');
  assert.equal(R.interpretResponse({ statusCode: 200, headers: { 'content-type': 'text/html' }, body: '<div class="g-recaptcha"></div>' }).kind, 'BOT_CHALLENGE');
  assert.equal(R.interpretResponse({ statusCode: 200, headers: { 'content-type': 'text/html' }, body: 'x'.repeat(10) }, 5).body.length, 5, 'response size cap');
});

test('research over the synthetic fixture sites (live HTTP to local fixture server)', async (t) => {
  const srv = await startServers();
  t.after(() => srv.close());
  const settings = testSettings(srv, { research: { batch_size: 50 } }); // the lower of config and Settings tab applies
  const store = createStore();
  store.Settings.find((r) => r.key === 'RESEARCH_BATCH_SIZE').value = '50';
  store.Suppression.push(...parseCsv(fs.readFileSync(path.join(ROOT, 'data/synthetic/suppression.synthetic.csv'), 'utf8')));
  runImport(store, parseCsv(fs.readFileSync(path.join(ROOT, 'data/synthetic/leads.synthetic.csv'), 'utf8')), settings);
  await runResearch(store, settings);
  const lead = (n) => store.Leads.find((l) => l.business_name === n);
  const sigs = (n) => JSON.parse(lead(n).signals_json || '[]').map((s) => s.id);

  // normal site: evidence with URLs and quotes; email published on the site
  assert.equal(lead('Bright Smile Dental').outreach_status, 'RESEARCHED');
  assert.ok(sigs('Bright Smile Dental').includes('booking_by_phone_or_email'));
  assert.ok(sigs('Bright Smile Dental').includes('pdf_intake_forms'));
  assert.match(lead('Bright Smile Dental').evidence_snippet_1, /call us to book/i);
  assert.equal(lead('Bright Smile Dental').email_published_url, 'https://brightsmile-dental.example/');
  assert.ok(lead('Bright Smile Dental').pages_reviewed.split('\n').length <= 4);
  // multiple services + FAQ + existing online booking -> no booking claims
  assert.ok(sigs('Kiwi Physio').includes('faq_extensive'));
  assert.ok(!sigs('Kiwi Physio').some((s) => s.startsWith('booking')));
  // inaccessible / thin / JS / robots-blocked -> manual review, no findings
  assert.equal(lead('Greenleaf Accountants').website_access_status, 'BLOCKED');
  assert.equal(lead('Tiny Bakes').website_access_status, 'INSUFFICIENT_CONTENT');
  assert.equal(lead('Serenity Day Spa').website_access_status, 'JS_RENDERED_SUSPECTED');
  assert.equal(lead('Private Clinic Group').website_access_status, 'BLOCKED_BY_ROBOTS_TXT');
  for (const n of ['Greenleaf Accountants', 'Tiny Bakes', 'Serenity Day Spa', 'Private Clinic Group']) {
    assert.equal(lead(n).outreach_status, 'MANUAL_REVIEW', n);
    assert.deepEqual(sigs(n), [], n);
  }
  const robotsHits = srv.fx.requests.filter((r) => r.host === 'privateclinic.example');
  assert.deepEqual(robotsHits.map((r) => r.path), ['/robots.txt'], 'robots-disallowed site: only robots.txt fetched');
  assert.ok(srv.fx.requests.every((r) => r.ua.startsWith('FlowHQ-ResearchBot')), 'honest user agent on every request');
  // compliance evidence captured
  assert.match(lead('Metro Electrical').no_unsolicited_notice, /no unsolicited sales emails/i);
  // invalid/duplicate/suppressed leads are never fetched
  for (const h of ['bademail.example', 'coastalvets.example', 'mapledental.example']) assert.ok(!srv.fx.requests.some((r) => r.host === h), h);

  // cache: re-running research for a reprocessed lead does not refetch
  const before = srv.fx.requests.length;
  updateRows(store.Leads, [{ lead_id: lead('Bright Smile Dental').lead_id, outreach_status: 'VALIDATED' }], 'lead_id');
  await runResearch(store, settings);
  assert.equal(srv.fx.requests.length, before, 'served from Research_Cache');
  assert.match(lead('Bright Smile Dental').research_summary, /from cache/);
});
