#!/usr/bin/env node
'use strict';
/*
 * Runs the GENERATED workflows inside a real n8n instance, with Google Sheets,
 * Gmail and the LLM replaced by local MOCK servers and websites served by the
 * fixture server. Uses an isolated n8n data folder, never your real instance.
 *
 *   N8N_BIN=/path/to/node_modules/.bin/n8n N8N_USER_FOLDER=/tmp/n8n-harness node scripts/n8n-harness.js
 *
 * n8n >= 2.x needs Node >= 24 (N8N_NODE=/path/to/node24 if `node` is older).
 */
const { spawn, spawnSync } = require('child_process'); // spawnSync only for the build step
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const fixture = require('./fixture-server');
const mocks = require('./mock-services');
const { parseCsv } = require('./csv');
const { DEFAULT_SETTINGS_ROWS } = require('../lib/schema');

const ROOT = path.join(__dirname, '..');
const N8N_BIN = process.env.N8N_BIN || 'n8n';
const MOCK_PORT = 8789;
const FIX_PORT = 8787;
const N8N_PORT = Number(process.env.HARNESS_N8N_PORT || 5680);
const ID = { import: 'FlowHQ01Import00', research: 'FlowHQ02Research', generate: 'FlowHQ03Generate', send: 'FlowHQ04SendMail', inbox: 'FlowHQ05InboxMon', preflight: 'FlowHQ0Preflight', unsub: 'FlowHQ06Unsubscr' };
const env = Object.assign({}, process.env, {
  N8N_DIAGNOSTICS_ENABLED: 'false', N8N_VERSION_NOTIFICATIONS_ENABLED: 'false', N8N_PERSONALIZATION_ENABLED: 'false',
  N8N_ENCRYPTION_KEY: process.env.N8N_ENCRYPTION_KEY || 'harness-only-not-a-secret',
  N8N_LOG_LEVEL: 'warn', N8N_PORT: String(N8N_PORT), N8N_LISTEN_ADDRESS: '127.0.0.1', FIXTURE_URL: `http://127.0.0.1:${FIX_PORT}`,
});
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const results = [];

// Async on purpose: the mock servers live in this process, so blocking the event loop would hang n8n's requests.
function n8n(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(N8N_BIN, args, { env });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => child.kill(), 600000);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`n8n ${args.join(' ')} failed (${code}): ${(err + out).slice(-800)}`));
      else resolve(out);
    });
  });
}
const get = async (p) => (await fetch(MOCK + p)).json();
const post = async (p, body) => (await fetch(MOCK + p, { method: 'POST', body: JSON.stringify(body) })).json();
async function sheets() { return get('/__sheets'); }
async function patch(fn) { const s = await sheets(); fn(s); await post('/__sheets/load', s); }
const setSetting = (s, k, v) => { const r = s.settings.find((x) => x.key === k); if (r) r.value = v; else s.settings.push({ key: k, value: v, notes: '' }); };
const lead = (s, name) => s.leads.find((l) => l.business_name === name);

async function check(name, fn) {
  try { await fn(); results.push({ name, ok: true }); console.log(`  PASS  ${name}`); } catch (e) { results.push({ name, ok: false, error: e.message }); console.log(`  FAIL  ${name}\n        ${e.message}`); }
}

async function main() {
  const fx = fixture.createServer();
  const mk = mocks.createServer();
  await new Promise((r) => fx.listen(FIX_PORT, '127.0.0.1', r));
  await new Promise((r) => mk.listen(MOCK_PORT, '127.0.0.1', r));
  try {
    console.log('Building harness workflows and importing into n8n', (await n8n(['--version'])).trim());
    const b = spawnSync(process.execPath, [path.join(__dirname, 'build-workflows.js'), '--harness', MOCK], { env, encoding: 'utf8' });
    if (b.status !== 0) throw new Error(b.stderr);
    for (const f of fs.readdirSync(path.join(ROOT, 'out/harness'))) await n8n(['import:workflow', `--input=${path.join(ROOT, 'out/harness', f)}`]);

    const settings = DEFAULT_SETTINGS_ROWS.map((r) => Object.assign({}, r));
    for (const [k, v] of [['RESEARCH_BATCH_SIZE', '50'], ['GENERATION_BATCH_SIZE', '50'], ['SEND_INTERVAL_SECONDS', '1']]) settings.find((r) => r.key === k).value = v;
    const strip = (rows) => rows.map((r) => { delete r.row_number; return r; });
    await post('/__sheets/load', {
      source: strip(parseCsv(fs.readFileSync(path.join(ROOT, 'data/synthetic/leads.synthetic.csv'), 'utf8'))),
      suppression: strip(parseCsv(fs.readFileSync(path.join(ROOT, 'data/synthetic/suppression.synthetic.csv'), 'utf8'))),
      settings, leads: [], research_cache: [], send_log: [], error_log: [], inbox_log: [],
    });

    console.log('\n01 Import');
    await n8n(['execute', `--id=${ID.import}`]);
    let s = await sheets();
    await check('18 rows imported with expected statuses', () => {
      const by = {};
      for (const l of s.leads) by[l.outreach_status] = (by[l.outreach_status] || 0) + 1;
      assert.deepStrictEqual(by, { VALIDATED: 11, INVALID: 3, DUPLICATE: 1, SUPPRESSED: 1, COUNTRY_NOT_ENABLED: 1, SKIPPED_SOURCE_STATUS: 1 });
    });
    await n8n(['execute', `--id=${ID.import}`]);
    await check('re-running import adds nothing', async () => assert.strictEqual((await sheets()).leads.length, 18));

    console.log('\n02 Research');
    await n8n(['execute', `--id=${ID.research}`]);
    s = await sheets();
    await check('normal site researched with evidence URLs', () => {
      const l = lead(s, 'Bright Smile Dental');
      assert.strictEqual(l.outreach_status, 'RESEARCHED');
      assert.match(l.signals_json, /booking_by_phone_or_email/);
      assert.match(l.evidence_url_1, /^https:\/\/brightsmile-dental\.example\//);
    });
    await check('blocked / thin / JS / robots-disallowed sites -> MANUAL_REVIEW', () => {
      for (const [n, st] of [['Greenleaf Accountants', 'BLOCKED'], ['Tiny Bakes', 'INSUFFICIENT_CONTENT'], ['Serenity Day Spa', 'JS_RENDERED_SUSPECTED'], ['Private Clinic Group', 'BLOCKED_BY_ROBOTS_TXT']]) {
        assert.strictEqual(lead(s, n).outreach_status, 'MANUAL_REVIEW', n);
        assert.strictEqual(lead(s, n).website_access_status, st, n);
      }
    });
    await check('robots.txt respected: only /robots.txt fetched from the disallowed site', () => {
      assert.deepStrictEqual(fx.requests.filter((r) => r.host === 'privateclinic.example').map((r) => r.path), ['/robots.txt']);
    });
    await check('research cache written per domain', () => assert.strictEqual(s.research_cache.length, 11));

    console.log('\n03 Generate (mock LLM)');
    await n8n(['execute', `--id=${ID.generate}`]);
    s = await sheets();
    await check('mock 529 overloaded retried by the HTTP node -> draft created', () => assert.strictEqual(lead(s, 'Harbour Plumbing').outreach_status, 'READY_FOR_APPROVAL'));
    await check('malformed AI response -> lead stays queued for next run', () => assert.match(lead(s, 'Kiwi Physio').status_reason, /generation_retry_pending:malformed/));
    await check('AI draft with unsupported claims -> FAILED validation, MANUAL_REVIEW', () => {
      assert.strictEqual(lead(s, 'Summit Roofing').factual_validation_status, 'FAILED');
      assert.match(lead(s, 'Summit Roofing').validation_issues, /unsupported_quality_claim/);
    });
    await check('no credible recommendation -> MANUAL_REVIEW, no LLM call', () => {
      assert.match(lead(s, 'Northside Florist').status_reason, /no_recommendation/);
      assert.ok(!mk.state.llmCalls.some((c) => c.business === 'Northside Florist'));
    });
    await check('site refusing unsolicited email is never drafted', () => assert.strictEqual(lead(s, 'Metro Electrical').status_reason, 'website_says_no_unsolicited_messages'));
    await n8n(['execute', `--id=${ID.generate}`]);
    s = await sheets();
    await check('second generation run completes the retried lead', () => assert.strictEqual(lead(s, 'Kiwi Physio').outreach_status, 'READY_FOR_APPROVAL'));

    console.log('\n04 Send (TEST MODE, mock Gmail)');
    await n8n(['execute', `--id=${ID.send}`]);
    await check('shipped defaults send nothing', () => assert.strictEqual(mk.state.sent.length, 0));
    await patch((x) => { setSetting(x, 'SENDING_ENABLED', 'TRUE'); setSetting(x, 'TEST_ALLOWLIST', 'owner@flowhq-test.example'); setSetting(x, 'TEST_REDIRECT_TO', 'owner@flowhq-test.example'); });
    await n8n(['execute', `--id=${ID.send}`]);
    await check('nothing is sent without human approval', () => assert.strictEqual(mk.state.sent.length, 0));
    await patch((x) => {
      setSetting(x, 'MAX_SENDS_PER_RUN', '2');
      for (const n of ['Bright Smile Dental', 'Harbour Plumbing', 'Oxford Hair Studio']) Object.assign(lead(x, n), { approval_status: 'APPROVED', approved_by: 'harness' });
    });
    await n8n(['execute', `--id=${ID.send}`]);
    s = await sheets();
    await check('per-run cap respected (2 of 3 approved)', () => assert.strictEqual(mk.state.sent.length, 2));
    await check('test mode: only the allowlisted inbox receives mail, subject marked [TEST]', () => {
      for (const m of mk.state.sent) { assert.match(m.mime, /^To: owner@flowhq-test\.example/m); assert.match(m.mime, /^Subject: \[TEST\]/m); }
    });
    await check('each send logged exactly once with Gmail message id', () => {
      assert.strictEqual(s.send_log.length, 2);
      assert.ok(s.send_log.every((r) => r.status === 'TEST_SENT' && r.provider_message_id));
    });
    await n8n(['execute', `--id=${ID.send}`]);
    await n8n(['execute', `--id=${ID.send}`]);
    await check('repeated runs: remaining lead sent once, no duplicates', async () => {
      const ids = mk.state.sent.map((m) => (/X-FlowHQ-Lead-Id: (\S+)/.exec(m.mime) || [])[1]);
      assert.strictEqual(ids.length, 3);
      assert.strictEqual(new Set(ids).size, 3);
    });

    console.log('\n04 Send failure handling');
    const ALLOW = 'owner@flowhq-test.example,authfail@flowhq-test.example,tempfail@flowhq-test.example,invalid@flowhq-test.example';
    await patch((x) => {
      setSetting(x, 'TEST_ALLOWLIST', ALLOW); setSetting(x, 'TEST_REDIRECT_TO', 'authfail@flowhq-test.example'); setSetting(x, 'MAX_SENDS_PER_RUN', '5');
      for (const n of ['Bright Smile Dental', 'Harbour Plumbing']) Object.assign(lead(x, n), { outreach_status: 'READY_FOR_APPROVAL', reprocess: 'TRUE' });
    });
    const callsBefore = () => mk.state.requests.filter((r) => r.url.includes('messages/send')).length;
    let c0 = callsBefore();
    await n8n(['execute', `--id=${ID.send}`]);
    s = await sheets();
    await check('Gmail 401 -> kill switch tripped mid-run; second email never attempted', () => {
      assert.strictEqual(callsBefore() - c0, 1);
      assert.strictEqual(s.settings.find((r) => r.key === 'KILL_SWITCH').value, 'TRUE');
      assert.ok(['Bright Smile Dental', 'Harbour Plumbing'].every((n) => lead(s, n).outreach_status === 'READY_FOR_APPROVAL'));
    });
    c0 = callsBefore();
    await n8n(['execute', `--id=${ID.send}`]);
    await check('kill switch on -> nothing attempted', () => assert.strictEqual(callsBefore() - c0, 0));
    await patch((x) => { setSetting(x, 'KILL_SWITCH', 'FALSE'); setSetting(x, 'TEST_REDIRECT_TO', 'tempfail@flowhq-test.example'); });
    await n8n(['execute', `--id=${ID.send}`]);
    s = await sheets();
    await check('Gmail 503 -> RETRY_PENDING with backoff time', () => {
      for (const n of ['Bright Smile Dental', 'Harbour Plumbing']) { assert.strictEqual(lead(s, n).outreach_status, 'RETRY_PENDING'); assert.ok(lead(s, n).next_retry_at); }
    });

    console.log('\n05 Inbox monitor');
    await post('/__inbox', [
      { id: 'g1', threadId: 'a', subject: 'Re: idea', from: { text: 'hello@brightsmile-dental.example' }, text: 'Please remove me from your list.' },
      { id: 'g2', threadId: 'b', subject: 'Delivery Status Notification (Failure)', from: { text: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>' }, text: "Your message wasn't delivered to info@harbourplumbing.example. 550 5.1.1 address not found" },
      { id: 'g3', threadId: 'c', subject: 'Automatic reply: idea', from: { text: 'mere@kiwiphysio.example' }, text: 'Out of office' },
      { id: 'g4', threadId: 'd', subject: 'Re: idea', from: { text: 'Emma <emma@oxfordhair.example>' }, text: 'Happy to chat.' },
    ]);
    await n8n(['execute', `--id=${ID.inbox}`]);
    await n8n(['execute', `--id=${ID.inbox}`]);
    s = await sheets();
    await check('opt-out reply -> UNSUBSCRIBED + suppression (all rows with that address)', () => {
      assert.ok(s.leads.filter((l) => l.email === 'hello@brightsmile-dental.example').every((l) => l.outreach_status === 'UNSUBSCRIBED'));
      assert.ok(s.suppression.some((r) => r.value === 'hello@brightsmile-dental.example'));
    });
    await check('hard bounce -> BOUNCED + suppression', () => assert.strictEqual(lead(s, 'Harbour Plumbing').outreach_status, 'BOUNCED'));
    await check('genuine reply -> REPLIED; auto-reply ignored', () => {
      assert.strictEqual(lead(s, 'Oxford Hair Studio').outreach_status, 'REPLIED');
      assert.notStrictEqual(lead(s, 'Kiwi Physio').outreach_status, 'REPLIED');
    });
    await check('inbox processing is idempotent', () => assert.strictEqual(s.inbox_log.length, 4));

    console.log('\n00 Preflight');
    await n8n(['execute', `--id=${ID.preflight}`]);
    await check('preflight executes (read-only)', () => true);

    console.log('\n06 Unsubscribe webhook (live n8n server)');
    await n8n(['publish:workflow', `--id=${ID.unsub}`]);
    const srv = spawn(N8N_BIN, ['start'], { env, stdio: 'ignore' });
    try {
      for (let i = 0; i < 90; i++) {
        try { if ((await fetch(`http://127.0.0.1:${N8N_PORT}/healthz`)).ok) break; } catch (e) { /* starting */ }
        await new Promise((r) => setTimeout(r, 2000));
      }
      // Published workflows are activated shortly after /healthz turns green: wait for the webhook to register.
      for (let i = 0; i < 60; i++) {
        const r = await fetch(`http://127.0.0.1:${N8N_PORT}/webhook/flowhq-unsubscribe?t=probe`).catch(() => null);
        if (r && r.status !== 404) break;
        await new Promise((res) => setTimeout(res, 2000));
      }
      const token = lead(await sheets(), 'Kiwi Physio').unsubscribe_token;
      const url = `http://127.0.0.1:${N8N_PORT}/webhook/flowhq-unsubscribe`;
      const g = await (await fetch(`${url}?t=${token}`)).text();
      await check('GET shows a confirmation button and does NOT unsubscribe', async () => {
        assert.match(g, /<form method="post">/);
        assert.notStrictEqual(lead(await sheets(), 'Kiwi Physio').outreach_status, 'UNSUBSCRIBED');
      });
      await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 't=zzzzzzzzzzzzzzzzzzzzzzzz' });
      await fetch(`${url}?t=${token}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
      s = await sheets();
      await check('one-click POST unsubscribes; bogus token changes nothing', () => {
        assert.strictEqual(lead(s, 'Kiwi Physio').outreach_status, 'UNSUBSCRIBED');
        assert.ok(s.suppression.some((r) => r.value === 'mere@kiwiphysio.example' && r.reason === 'unsubscribe_link'));
        assert.strictEqual(s.suppression.length, 4);
      });
    } finally { srv.kill(); }
  } finally {
    fx.close();
    mk.close();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} n8n harness checks passed`);
  fs.mkdirSync(path.join(ROOT, 'out'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'out', 'n8n-harness-results.json'), JSON.stringify({ n8n_version: (await n8n(['--version'])).trim(), results }, null, 2));
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
