'use strict';
// End-to-end over SYNTHETIC data. Websites: local fixture server. LLM and
// Gmail: local MOCK servers (scripts/mock-services.js). No real services.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const P = require('../scripts/local-pipeline');
const { parseCsv } = require('../scripts/csv');
const { startServers, testSettings, ROOT } = require('./helpers');

test('full pipeline: import -> research -> generate -> approve -> send (test mode) -> inbox, re-run safe', async (t) => {
  const srv = await startServers();
  t.after(() => srv.close());
  const settings = testSettings(srv, { sending: { SENDING_ENABLED: true }, research: { batch_size: 50 }, generation: { batch_size: 50 } });
  const store = P.createStore();
  const set = (k, v) => P.setSetting(store, k, v);
  set('RESEARCH_BATCH_SIZE', '50'); set('GENERATION_BATCH_SIZE', '50');
  const csv = fs.readFileSync(path.join(ROOT, 'data/synthetic/leads.synthetic.csv'), 'utf8');
  store.Suppression.push(...parseCsv(fs.readFileSync(path.join(ROOT, 'data/synthetic/suppression.synthetic.csv'), 'utf8')));
  const lead = (n) => store.Leads.find((l) => l.business_name === n);

  P.runImport(store, parseCsv(csv), settings);
  await P.runResearch(store, settings);
  await P.runGenerate(store, settings); // first pass: mock LLM returns one 529 and one malformed reply
  assert.equal(lead('Harbour Plumbing').outreach_status, 'RESEARCHED', 'temporary provider failure -> stays queued');
  assert.match(lead('Harbour Plumbing').last_error, /temporary/);
  assert.equal(lead('Kiwi Physio').outreach_status, 'RESEARCHED', 'malformed AI response -> retried next run');
  await P.runGenerate(store, settings); // second pass succeeds
  assert.equal(lead('Harbour Plumbing').outreach_status, 'READY_FOR_APPROVAL');
  assert.equal(lead('Kiwi Physio').outreach_status, 'READY_FOR_APPROVAL');

  // 1 normal site / 6 clear observed opportunity
  const bs = lead('Bright Smile Dental');
  assert.equal(bs.outreach_status, 'READY_FOR_APPROVAL');
  assert.equal(bs.factual_validation_status, 'PASSED');
  assert.match(bs.email_body, /^Hi Dr Chen,/);
  assert.match(bs.selected_signals, /booking_by_phone_or_email/);
  // 2 no named contact
  assert.match(lead('Harbour Plumbing').email_body, /^Hi Harbour Plumbing team,/);
  // 3 multiple services: recommendation chosen from evidence, max two services
  assert.ok(lead('Kiwi Physio').selected_signals.split(',').length <= 2);
  // 4 inaccessible / 5 thin content / JS / robots -> manual review, nothing drafted
  for (const n of ['Greenleaf Accountants', 'Tiny Bakes', 'Serenity Day Spa', 'Private Clinic Group']) {
    assert.equal(lead(n).outreach_status, 'MANUAL_REVIEW', n);
    assert.equal(lead(n).email_body || '', '', n);
  }
  // 7 invalid email, 8 duplicate, 9 opted out
  assert.equal(lead('Bad Email Co').outreach_status, 'INVALID');
  assert.equal(store.Leads.filter((l) => l.business_name.toLowerCase() === 'bright smile dental' && l.outreach_status === 'DUPLICATE').length, 1);
  assert.equal(lead('Coastal Vets').outreach_status, 'SUPPRESSED');
  // 10 no credible recommendation
  assert.match(lead('Northside Florist').status_reason, /no_recommendation/);
  // 11 AI response with unsupported claims: AI text rejected, validated template draft used instead
  assert.match(lead('Summit Roofing').validation_issues, /ai_fallback:AI draft rejected \(.*unsupported_quality_claim/);
  assert.match(lead('Summit Roofing').generator, /^template \(fallback/);
  assert.ok(!/slow|30%|guarantee/i.test(lead('Summit Roofing').email_body));
  // site that refuses unsolicited email is never drafted
  assert.equal(lead('Metro Electrical').status_reason, 'website_says_no_unsolicited_messages');

  // Nothing is sent before human approval
  set('SENDING_ENABLED', 'TRUE');
  set('TEST_ALLOWLIST', 'owner@flowhq-test.example');
  set('TEST_REDIRECT_TO', 'owner@flowhq-test.example');
  let r = await P.runSend(store, settings);
  assert.equal(r.results.length, 0, 'no approvals yet');

  // Reviewer approves everything that is ready
  for (const l of store.Leads.filter((x) => x.outreach_status === 'READY_FOR_APPROVAL')) { l.approval_status = 'APPROVED'; l.approved_by = 'test-reviewer'; }
  const approvedCount = store.Leads.filter((x) => x.approval_status === 'APPROVED').length;
  set('MAX_SENDS_PER_RUN', '50');
  r = await P.runSend(store, settings);
  assert.equal(r.summary.mode, 'TEST');
  assert.equal(r.results.filter((x) => x.outcome === 'sent').length, Math.min(approvedCount, 5), 'workflow config caps the run at 5');
  assert.ok(srv.mk.state.sent.every((m) => /^To: owner@flowhq-test\.example/m.test(m.mime)), 'test mode never emails a lead');
  assert.ok(srv.mk.state.sent.every((m) => /^List-Unsubscribe: <mailto:/m.test(m.mime)));
  const sentIds = new Set(store.Send_Log.map((x) => x.lead_id));
  assert.ok(store.Leads.filter((l) => sentIds.has(l.lead_id)).every((l) => l.outreach_status === 'TEST_SENT' && l.provider_message_id));

  // 13 repeated execution: nothing is sent twice, research/generation are not repeated
  const before = { sent: srv.mk.state.sent.length, llm: srv.mk.state.llmCalls.length, fetch: srv.fx.requests.length, leads: store.Leads.length };
  P.runImport(store, parseCsv(csv), settings);
  await P.runResearch(store, settings);
  await P.runGenerate(store, settings);
  r = await P.runSend(store, settings);
  assert.equal(store.Leads.length, before.leads, 'import is idempotent');
  assert.equal(srv.fx.requests.length, before.fetch, 'no website refetch');
  assert.equal(srv.mk.state.llmCalls.length, before.llm, 'no extra LLM calls');
  const resent = srv.mk.state.sent.slice(before.sent).map((m) => (/X-FlowHQ-Lead-Id: (\S+)/.exec(m.mime) || [])[1]);
  assert.ok(resent.every((id) => !sentIds.has(id)), 'no lead received a second test email');

  // 12 temporary provider failure on send + kill switch mid-run
  const target = store.Leads.find((l) => l.outreach_status === 'READY_FOR_APPROVAL' && l.approval_status === 'APPROVED');
  if (target) {
    set('TEST_ALLOWLIST', 'owner@flowhq-test.example,tempfail@flowhq-test.example');
    set('TEST_REDIRECT_TO', 'tempfail@flowhq-test.example');
    r = await P.runSend(store, settings);
    assert.ok(r.results.some((x) => x.outcome === 'temporary'));
    assert.ok(store.Leads.some((l) => l.outreach_status === 'RETRY_PENDING' && l.next_retry_at));
  }
  set('KILL_SWITCH', 'TRUE');
  const killed = await P.runSend(store, settings);
  assert.equal(killed.results.length, 0, 'kill switch stops sending');
  set('KILL_SWITCH', 'FALSE');

  // Opt-out reply: suppressed and never contacted again
  const bright = lead('Bright Smile Dental');
  P.runInbox(store, [{ id: 'in-1', threadId: 'zz', from: 'hello@brightsmile-dental.example', subject: 'Re: An idea', text: 'Please unsubscribe us.' }]);
  assert.equal(bright.outreach_status, 'UNSUBSCRIBED');
  assert.ok(store.Suppression.some((s) => s.value === 'hello@brightsmile-dental.example'));

  // Live mode cannot be reached without the written approval record
  set('TEST_MODE', 'FALSE');
  const liveAttempt = await P.runSend(store, testSettings(srv, { sending: { SENDING_ENABLED: true, TEST_MODE: false } }));
  assert.equal(liveAttempt.summary.sending_enabled, false);
  assert.match(liveAttempt.summary.blocked_reasons.join(' '), /live_approval/);

  fs.mkdirSync(path.join(ROOT, 'out', 'e2e'), { recursive: true });
  P.writeReport(store, path.join(ROOT, 'out', 'e2e'));
});
