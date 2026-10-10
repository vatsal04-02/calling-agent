'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { processInbox, classifyMessage, unsubscribeByToken, bounceRateTrip } = require('../lib/inbox');

const leads = [
  { lead_id: 'L1', email: 'sam@demo.example', provider_thread_id: 'T1', unsubscribe_token: 'abcdefghijklmnopqrstuvwx' },
  { lead_id: 'L2', email: 'kim@other.example', provider_thread_id: 'T2' },
];

test('classifies unsubscribe, bounce, auto-reply and genuine replies', () => {
  const c = (m) => classifyMessage(m, { 'sam@demo.example': leads[0], 'kim@other.example': leads[1] }, { T1: leads[0], T2: leads[1] }).type;
  assert.equal(c({ id: '1', from: 'Sam <sam@demo.example>', subject: 'Re: idea', text: 'Please unsubscribe me.\n> quoted' }), 'unsubscribe');
  assert.equal(c({ id: '2', from: 'Sam <sam@demo.example>', subject: 'Re: idea', text: 'Not interested, thanks.' }), 'unsubscribe');
  assert.equal(c({ id: '3', from: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>', subject: 'Delivery Status Notification (Failure)', text: "Address not found. Your message wasn't delivered to kim@other.example. 550 5.1.1" }), 'hard_bounce');
  assert.equal(c({ id: '4', from: 'kim@other.example', subject: 'Automatic reply: idea', text: 'I am away' }), 'auto_reply');
  assert.equal(c({ id: '5', from: 'kim@other.example', subject: 'Re: idea', text: 'Sounds good, call me Tuesday.\n> please unsubscribe' }), 'reply', 'quoted text is ignored');
  assert.equal(c({ id: '6', from: 'random@x.example', subject: 'Hello', text: 'hi' }), 'other');
});

test('inbox processing suppresses opt-outs and hard bounces, stops follow-ups, and is idempotent', () => {
  const msgs = [
    { id: 'm1', threadId: 'T1', from: 'sam@demo.example', subject: 'Re: idea', text: 'Remove me from your list' },
    { id: 'm2', threadId: 'x', from: 'mailer-daemon@googlemail.com', subject: 'Undeliverable', text: 'kim@other.example 550 user unknown' },
  ];
  const out = processInbox(msgs, leads, []);
  assert.deepEqual(out.suppress.map((s) => [s.value, s.reason]), [['sam@demo.example', 'unsubscribe_reply'], ['kim@other.example', 'hard_bounce']]);
  assert.deepEqual(out.leadUpdates.map((u) => u.outreach_status), ['UNSUBSCRIBED', 'BOUNCED']);
  assert.ok(out.leadUpdates.every((u) => u.follow_up_eligible === 'FALSE'));
  const again = processInbox(msgs, leads, out.log);
  assert.equal(again.log.length, 0, 'already-processed message ids are skipped');
});

test('unsubscribe link tokens', () => {
  assert.equal(unsubscribeByToken('abcdefghijklmnopqrstuvwx', leads).suppress.value, 'sam@demo.example');
  assert.equal(unsubscribeByToken('zzzzzzzzzzzzzzzzzzzzzzzz', leads).reason, 'unknown_token');
  assert.equal(unsubscribeByToken("'; DROP", leads).reason, 'invalid_token');
});

test('bounce-rate circuit breaker', () => {
  const log = Array.from({ length: 40 }, (_, i) => ({ status: 'SENT', lead_id: 'L' + i }));
  assert.equal(bounceRateTrip(log, 1, 0, 0.05), '');
  assert.match(bounceRateTrip(log, 3, 0, 0.05), /hard bounce rate 7\.5%/);
  assert.equal(bounceRateTrip(log.slice(0, 10), 5, 0, 0.05), '', 'needs a minimum sample');
});
