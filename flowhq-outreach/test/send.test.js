'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { effectivePolicy } = require('../lib/config');
const { evaluateSendQueue, classifySendResult, recordSendResult, recheckBeforeSend } = require('../lib/sendgate');
const { buildRawMessage, decodeBase64Url } = require('../lib/mime');
const { planGeneration, finalizeGeneration } = require('../lib/generate');
const { DEFAULT_SETTINGS_ROWS } = require('../lib/schema');
const { readJson, testSettings } = require('./helpers');

const catalogue = readJson('config/service-catalogue.json');
const compliance = readJson('config/compliance.json');
const SIG = { id: 'booking_by_phone_or_email', topic: 'booking', claim_type: 'observed', statement: 'The website asks people to phone to book ("call us to book").', evidence_url: 'https://d.example/', evidence_snippet: 'call us to book', confidence: 0.85 };

function approvedLead(o, settings) {
  const s = settings || testSettings(null, { llm: { provider: 'template' } });
  const base = Object.assign({ lead_id: 'L1', business_name: 'Demo Dental', first_name: 'Sam', email: 'sam@demo.example', domain: 'demo.example', country: 'US', industry_group: 'appointment', website: 'https://demo.example/', email_published_url: 'https://demo.example/contact', signals_json: JSON.stringify([SIG]), unsubscribe_token: 'abcdefghijklmnopqrstuvwx' }, o);
  const u = finalizeGeneration(planGeneration(base, catalogue, s, compliance), null, s, compliance);
  return Object.assign(base, u, { approval_status: 'APPROVED' }, o);
}
const rows = (kv) => DEFAULT_SETTINGS_ROWS.map((r) => Object.assign({}, r, kv[r.key] !== undefined ? { value: kv[r.key] } : {}));
const settingsWith = (sending) => testSettings(null, { llm: { provider: 'template' }, sending });
const gate = (leads, s, sheet, extra) => evaluateSendQueue(Object.assign({ leads, sendLog: [], suppressionRows: [], settings: s, settingsRows: rows(sheet || {}), compliance, now: '2026-10-10T12:00:00Z' }, extra));

test('defaults are fail-closed: nothing is sent with the shipped configuration', () => {
  const shipped = readJson('config/settings.default.json');
  assert.equal(shipped.sending.SENDING_ENABLED, false);
  assert.equal(shipped.sending.TEST_MODE, true);
  assert.equal(shipped.sending.REQUIRE_APPROVAL, true);
  const p = effectivePolicy(shipped, DEFAULT_SETTINGS_ROWS);
  assert.equal(p.sending_enabled, false);
  assert.equal(p.live, false);
  assert.equal(effectivePolicy(Object.assign({}, shipped, { sending: Object.assign({}, shipped.sending, { SENDING_ENABLED: true }) }), []).sending_enabled, false, 'missing Settings rows fail closed');
});

test('most-restrictive merge: both switches needed; kill switch wins; limits take the lower value', () => {
  const s = settingsWith({ SENDING_ENABLED: true, max_sends_per_run: 5, max_sends_per_day: 20 });
  assert.equal(effectivePolicy(s, rows({ SENDING_ENABLED: 'TRUE' })).sending_enabled, true);
  assert.equal(effectivePolicy(s, rows({ SENDING_ENABLED: 'TRUE', KILL_SWITCH: 'TRUE' })).sending_enabled, false);
  assert.equal(effectivePolicy(s, rows({ SENDING_ENABLED: 'TRUE', MAX_SENDS_PER_RUN: '50' })).max_per_run, 5);
  assert.equal(effectivePolicy(s, rows({ SENDING_ENABLED: 'TRUE', MAX_SENDS_PER_RUN: '2' })).max_per_run, 2);
  assert.equal(effectivePolicy(s, rows({ SENDING_ENABLED: 'TRUE', TEST_MODE: 'FALSE' })).test_mode, true, 'sheet cannot leave test mode alone');
});

test('live mode requires the written live approval record', () => {
  const noApproval = settingsWith({ SENDING_ENABLED: true, TEST_MODE: false });
  const p = effectivePolicy(noApproval, rows({ SENDING_ENABLED: 'TRUE', TEST_MODE: 'FALSE' }));
  assert.equal(p.live, false);
  assert.equal(p.sending_enabled, false);
  const approved = settingsWith({ SENDING_ENABLED: true, TEST_MODE: false, live_approval: { approved_by: 'Owner', approved_at: '2026-10-10' } });
  assert.equal(effectivePolicy(approved, rows({ SENDING_ENABLED: 'TRUE', TEST_MODE: 'FALSE' })).live, true);
});

test('when sending is disabled the gate reports what WOULD be sent and sends nothing', () => {
  const s = settingsWith({ SENDING_ENABLED: false, test_allowlist: ['sam@demo.example'] });
  const g = gate([approvedLead()], s, {});
  assert.equal(g.send.length, 0);
  assert.equal(g.would_send.length, 1);
  assert.match(g.updates[0].send_block_reason, /^NOT SENT - sending is off \(SENDING_ENABLED=false in workflow config.*Would send in TEST mode to sam@demo\.example/, 'reason visible on the lead row');
});

test('human approval is required; unapproved or rejected drafts never send', () => {
  const s = settingsWith({ SENDING_ENABLED: true, test_allowlist: ['sam@demo.example'] });
  assert.equal(gate([approvedLead({ approval_status: 'PENDING' })], s, { SENDING_ENABLED: 'TRUE' }).send.length, 0);
  assert.equal(gate([approvedLead({ approval_status: 'REJECTED' })], s, { SENDING_ENABLED: 'TRUE' }).send.length, 0);
  assert.equal(gate([approvedLead()], s, { SENDING_ENABLED: 'TRUE' }).send.length, 1);
});

test('test mode: allowlisted recipients only; redirect copies are labelled; others skipped', () => {
  const s = settingsWith({ SENDING_ENABLED: true });
  const lead = approvedLead();
  const none = gate([lead], s, { SENDING_ENABLED: 'TRUE' });
  assert.equal(none.send.length, 0);
  assert.match(none.blocked[0].reason, /test_mode_recipient_not_on_allowlist/);
  const red = gate([lead], s, { SENDING_ENABLED: 'TRUE', TEST_ALLOWLIST: 'me@mine.example', TEST_REDIRECT_TO: 'me@mine.example' });
  assert.equal(red.send[0].to, 'me@mine.example');
  assert.equal(red.send[0].mode, 'TEST');
  const mime = decodeBase64Url(red.send[0].raw);
  assert.match(mime, /^To: me@mine\.example/m);
  assert.match(mime, /Subject: \[TEST\]/);
  const bodyB64 = mime.split('\r\n\r\n')[1].replace(/\s+/g, '');
  assert.match(Buffer.from(bodyB64, 'base64').toString('utf8'), /NOT sent to the lead[\s\S]*Intended recipient: sam@demo\.example/);
  const redirectNotAllowlisted = gate([lead], s, { SENDING_ENABLED: 'TRUE', TEST_REDIRECT_TO: 'x@else.example' });
  assert.equal(redirectNotAllowlisted.send.length, 0);
});

test('duplicates, suppression, opt-outs and invalid addresses are hard stops', () => {
  const s = settingsWith({ SENDING_ENABLED: true, test_allowlist: ['sam@demo.example'] });
  const sheet = { SENDING_ENABLED: 'TRUE' };
  const lead = approvedLead();
  const sentLog = [{ status: 'SENT', intended_recipient: 'sam@demo.example', lead_id: 'OTHER', timestamp: '2026-01-01T00:00:00Z' }];
  const dup = gate([lead], s, sheet, { sendLog: sentLog });
  assert.equal(dup.send.length, 0);
  assert.equal(dup.updates[0].outreach_status, 'DUPLICATE');
  const supp = gate([lead], s, sheet, { suppressionRows: [{ value: 'demo.example', type: 'domain' }] });
  assert.equal(supp.updates[0].outreach_status, 'SUPPRESSED');
  assert.equal(gate([approvedLead({ opt_out_status: 'OPTED_OUT' })], s, sheet).send.length, 0);
  assert.equal(gate([approvedLead({ email: 'bad@@x' })], s, sheet).updates[0].outreach_status, 'INVALID');
  const testedAlready = gate([lead], s, sheet, { sendLog: [{ status: 'TEST_SENT', lead_id: 'L1', timestamp: '2026-10-10T11:00:00Z' }] });
  assert.match(testedAlready.blocked[0].reason, /already_test_sent/);
});

test('status gating: only READY/RETRY-due leads; SENDING/SENT/SEND_UNKNOWN never re-sent', () => {
  const s = settingsWith({ SENDING_ENABLED: true, test_allowlist: ['sam@demo.example'] });
  for (const st of ['SENDING', 'SENT', 'SEND_UNKNOWN', 'FAILED', 'MANUAL_REVIEW', 'UNSUBSCRIBED', 'BOUNCED', 'REPLIED']) {
    assert.equal(gate([approvedLead({ outreach_status: st })], s, { SENDING_ENABLED: 'TRUE' }).send.length, 0, st);
  }
  assert.equal(gate([approvedLead({ outreach_status: 'RETRY_PENDING', next_retry_at: '2026-10-10T13:00:00Z' })], s, { SENDING_ENABLED: 'TRUE' }).send.length, 0, 'retry not yet due');
  assert.equal(gate([approvedLead({ outreach_status: 'RETRY_PENDING', next_retry_at: '2026-10-10T11:00:00Z', retry_count: 1 })], s, { SENDING_ENABLED: 'TRUE' }).send.length, 1);
});

test('per-run and rolling daily limits', () => {
  const allow = Array.from({ length: 10 }, (_, i) => `u${i}@d${i}.example`);
  const s = settingsWith({ SENDING_ENABLED: true, test_allowlist: allow, max_sends_per_run: 3, max_sends_per_day: 5 });
  const leads = allow.map((e, i) => approvedLead({ lead_id: 'L' + i, email: e, domain: `d${i}.example` }));
  assert.equal(gate(leads, s, { SENDING_ENABLED: 'TRUE' }).send.length, 3);
  const log = [0, 1, 2, 3].map((i) => ({ status: 'TEST_SENT', lead_id: 'X' + i, timestamp: '2026-10-10T08:00:00Z' }));
  assert.equal(gate(leads, s, { SENDING_ENABLED: 'TRUE' }, { sendLog: log }).send.length, 1);
  const old = [0, 1, 2, 3, 4].map((i) => ({ status: 'TEST_SENT', lead_id: 'X' + i, timestamp: '2026-10-08T08:00:00Z' }));
  assert.equal(gate(leads, s, { SENDING_ENABLED: 'TRUE' }, { sendLog: old }).send.length, 3, 'only the last 24h counts');
});

test('live compliance gates: GB needs confirmed legal basis; AU/NZ need published-address evidence; no-unsolicited notices block', () => {
  const s = settingsWith({ SENDING_ENABLED: true, TEST_MODE: false, live_approval: { approved_by: 'Owner', approved_at: '2026-10-10' } });
  const sheet = { SENDING_ENABLED: 'TRUE', TEST_MODE: 'FALSE' };
  const gb = gate([approvedLead({ country: 'GB' })], s, sheet);
  assert.match(gb.blocked[0].reason, /legal_basis_not_confirmed/);
  assert.equal(gate([approvedLead({ country: 'GB', legal_basis_confirmed: 'TRUE' })], s, sheet).send.length, 1);
  assert.match(gate([approvedLead({ country: 'AU', email_published_url: '' })], s, sheet).blocked[0].reason, /email_not_found_published/);
  assert.equal(gate([approvedLead({ country: 'NZ' })], s, sheet).send.length, 1);
  assert.match(gate([Object.assign(approvedLead(), { no_unsolicited_notice: 'x' })], s, sheet).blocked[0].reason, /no_unsolicited/);
  const live = gate([approvedLead()], s, sheet).send[0];
  assert.equal(live.mode, 'LIVE');
  assert.equal(live.to, 'sam@demo.example');
});

test('final check at send time catches human edits that add placeholders or remove the opt-out', () => {
  const s = settingsWith({ SENDING_ENABLED: true, test_allowlist: ['sam@demo.example'] });
  const l = approvedLead();
  const edited = Object.assign({}, l, { email_body: l.email_body.replace(/If you would prefer[^\n]*/, '') });
  assert.match(gate([edited], s, { SENDING_ENABLED: 'TRUE' }).blocked[0].reason, /opt_out_missing/);
  const ph = Object.assign({}, l, { email_body: l.email_body.replace('Hi Sam,', 'Hi [First Name],') });
  assert.match(gate([ph], s, { SENDING_ENABLED: 'TRUE' }).blocked[0].reason, /placeholder/);
});

test('MIME: headers, UTF-8 subject, List-Unsubscribe, no header injection', () => {
  const raw = buildRawMessage({ fromName: 'Alex (FlowHQ)', fromEmail: 'a@flowhq.example', to: 'b@x.example\r\nBcc: evil@x.example', subject: 'Idée pour vous', body: 'Héllo\nworld', listUnsubscribe: ['mailto:a@flowhq.example?subject=unsubscribe', 'https://u.example/?t=1'], oneClick: true });
  const m = decodeBase64Url(raw);
  assert.ok(!/^Bcc:/m.test(m), 'CR/LF stripped from addresses');
  assert.match(m, /^Subject: =\?UTF-8\?B\?/m);
  assert.match(m, /^List-Unsubscribe: <mailto:a@flowhq\.example\?subject=unsubscribe>, <https:\/\/u\.example\/\?t=1>/m);
  assert.match(m, /^List-Unsubscribe-Post: List-Unsubscribe=One-Click/m);
  assert.equal(Buffer.from(m.split('\r\n\r\n')[1].replace(/\s+/g, ''), 'base64').toString('utf8'), 'Héllo\r\nworld');
});

test('Gmail result classification and retry rules', () => {
  const c = (j) => classifySendResult(j).outcome;
  assert.equal(c({ statusCode: 200, body: { id: 'm1', threadId: 't1' } }), 'sent');
  assert.equal(c({ statusCode: 503, body: '{}' }), 'temporary');
  assert.equal(c({ statusCode: 429, body: '{"error":{"errors":[{"reason":"userRateLimitExceeded"}]}}' }), 'temporary');
  assert.equal(c({ statusCode: 403, body: '{"error":{"errors":[{"reason":"dailyLimitExceeded"}]}}' }), 'quota');
  assert.equal(c({ statusCode: 401, body: '{}' }), 'auth');
  assert.equal(c({ statusCode: 400, body: '{"error":{"message":"Invalid To header"}}' }), 'permanent');
  assert.equal(c({ error: { message: 'timeout of 30000ms exceeded' } }), 'unknown', 'ambiguous timeouts are never auto-retried');
  assert.equal(c({ error: { message: 'getaddrinfo EAI_AGAIN' } }), 'temporary');

  const s = settingsWith({ max_retries: 2, retry_backoff_minutes: 10 });
  const item = { lead_id: 'L1', mode: 'LIVE', to: 'a@b.example', intended_to: 'a@b.example', subject: 's', run_id: 'r', retry_count: 0 };
  const t1 = recordSendResult(item, { outcome: 'temporary', http_status: 503, error: 'x' }, s, '2026-10-10T12:00:00Z');
  assert.equal(t1.update.outreach_status, 'RETRY_PENDING');
  assert.equal(t1.update.next_retry_at, '2026-10-10T12:10:00.000Z');
  assert.equal(recordSendResult(Object.assign({}, item, { retry_count: 2 }), { outcome: 'temporary' }, s).update.outreach_status, 'FAILED');
  const perm = recordSendResult(item, { outcome: 'permanent', invalid_recipient: true, error: 'Invalid To header' }, s);
  assert.equal(perm.update.outreach_status, 'FAILED');
  assert.equal(perm.suppress.reason, 'gmail_rejected_address');
  const redirected = recordSendResult(Object.assign({}, item, { mode: 'TEST', to: 'me@mine.example' }), { outcome: 'permanent', invalid_recipient: true, error: 'Invalid To header' }, s);
  assert.equal(redirected.update.outreach_status, 'READY_FOR_APPROVAL', 'a failed test copy does not condemn the lead');
  assert.equal(redirected.suppress, null);
  const quota = recordSendResult(item, { outcome: 'quota', error: 'dailyLimitExceeded' }, s);
  assert.equal(quota.update.outreach_status, 'READY_FOR_APPROVAL');
  assert.match(quota.trip_kill_switch, /quota/);
  const sent = recordSendResult(item, { outcome: 'sent', message_id: 'm1', thread_id: 't1' }, s);
  assert.equal(sent.update.outreach_status, 'SENT');
  assert.equal(sent.update.provider_message_id, 'm1');
  assert.equal(recordSendResult(Object.assign({}, item, { mode: 'TEST' }), { outcome: 'sent', message_id: 'm2' }, s).update.outreach_status, 'TEST_SENT');
});

test('kill switch is re-checked before every single send', () => {
  const s = settingsWith({ SENDING_ENABLED: true });
  assert.equal(recheckBeforeSend(s, rows({ SENDING_ENABLED: 'TRUE' })).ok, true);
  assert.equal(recheckBeforeSend(s, rows({ SENDING_ENABLED: 'TRUE', KILL_SWITCH: 'TRUE' })).ok, false);
});

test('no sheet column or written row uses the key "error" (n8n retries any node whose output item has json.error)', () => {
  const { TABS } = require('../lib/schema');
  for (const [tab, cols] of Object.entries(TABS)) assert.ok(!cols.includes('error'), tab);
  const s = settingsWith({});
  const item = { lead_id: 'L1', mode: 'TEST', to: 'a@b.example', intended_to: 'a@b.example', subject: 's', run_id: 'r', retry_count: 0 };
  for (const outcome of ['sent', 'temporary', 'permanent', 'auth', 'unknown']) {
    const rec = recordSendResult(item, { outcome, error: 'x', message_id: 'm' }, s);
    assert.ok(!('error' in rec.log) && !('error' in rec.update), outcome);
  }
});
