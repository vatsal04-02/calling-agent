'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { selectOpportunities } = require('../lib/opportunities');
const { planGeneration, finalizeGeneration } = require('../lib/generate');
const { validateDraft } = require('../lib/validate');
const { parseResponse, buildRequest, EMAIL_SCHEMA } = require('../lib/llm');
const { templateParts, greeting } = require('../lib/compose');
const { readJson, testSettings } = require('./helpers');

const catalogue = readJson('config/service-catalogue.json');
const compliance = readJson('config/compliance.json');
const settings = testSettings(null, { llm: { provider: 'template' } });

const SIG = {
  booking: { id: 'booking_by_phone_or_email', topic: 'booking', claim_type: 'observed', statement: 'The website asks people to phone to book ("please call us to book").', evidence_url: 'https://d.example/contact', evidence_snippet: '...please call us to book an appointment...', confidence: 0.85 },
  noForm: { id: 'no_contact_form_found', topic: 'enquiry_form', claim_type: 'not_found', statement: "I couldn't find an enquiry form; the contact page lists phone and/or email details instead.", evidence_url: 'https://d.example/contact', evidence_snippet: 'Contact page lists: 555', confidence: 0.7 },
  chat: { id: 'chat_widget_present', topic: 'chat', claim_type: 'observed', statement: 'The website already has a chat tool (tidio).', evidence_url: 'https://d.example/', evidence_snippet: 'tidio', confidence: 0.5 },
  faq: { id: 'faq_extensive', topic: 'faq', claim_type: 'observed', statement: 'The website has an FAQ section answering 7 common questions.', evidence_url: 'https://d.example/faq', evidence_snippet: 'Q1 | Q2', confidence: 0.75, question_count: 7 },
  mobile: { id: 'no_mobile_viewport', topic: 'mobile', claim_type: 'observed', statement: 'x', evidence_url: 'https://d.example/', evidence_snippet: 'x', confidence: 0.9, requires_human_check: true },
};
const lead = (o) => Object.assign({ lead_id: 'L1', business_name: 'Demo Dental', first_name: 'Sam', email: 'sam@demo.example', country: 'US', industry: 'dental', industry_group: 'appointment', website: 'https://demo.example/' }, o);

test('selection: at most 2 signals and 2 services, best evidence first', () => {
  const sel = selectOpportunities([SIG.noForm, SIG.booking, SIG.faq], lead(), catalogue, settings);
  assert.ok(sel.ok);
  assert.equal(sel.signals[0].id, 'booking_by_phone_or_email');
  assert.equal(sel.primary_service.id, 'appointment_scheduling');
  assert.ok(sel.signals.length <= 2);
  assert.ok(!sel.secondary_service || sel.secondary_service.id !== sel.primary_service.id);
});

test('selection: low confidence or no match -> no recommendation (manual review)', () => {
  const sel = selectOpportunities([SIG.chat], lead({ industry_group: 'other' }), catalogue, settings);
  assert.equal(sel.ok, false);
  assert.match(sel.reason, /low_confidence/);
  assert.equal(selectOpportunities([], lead(), catalogue, settings).ok, false);
  assert.equal(selectOpportunities([SIG.mobile], lead(), catalogue, settings).ok, false, 'signals needing human checks are never auto-selected');
  const plan = planGeneration(lead({ signals_json: JSON.stringify([SIG.chat]) }), catalogue, settings, compliance);
  assert.equal(plan.action, 'skip');
  assert.equal(plan.update.outreach_status, 'MANUAL_REVIEW');
});

test('selection: excluded service (existing chat widget -> no AI website assistant)', () => {
  const sel = selectOpportunities([SIG.faq, SIG.chat], lead({ industry_group: 'other' }), catalogue, settings);
  assert.ok(!sel.ok || sel.primary_service.id !== 'ai_website_assistant');
});

test('disabled services are never recommended', () => {
  const cat = JSON.parse(JSON.stringify(catalogue));
  cat.services.find((s) => s.id === 'appointment_scheduling').enabled = false;
  const sel = selectOpportunities([SIG.booking], lead(), cat, settings);
  assert.notEqual(sel.ok && sel.primary_service.id, 'appointment_scheduling');
});

test('template writer produces drafts that pass validation (US and GB spelling)', () => {
  for (const country of ['US', 'GB', 'AU', 'NZ']) {
    const l = lead({ country, signals_json: JSON.stringify([SIG.booking, SIG.noForm]) });
    const plan = planGeneration(l, catalogue, settings, compliance);
    assert.equal(plan.action, 'template');
    const u = finalizeGeneration(plan, null, settings, compliance);
    assert.equal(u.factual_validation_status, 'PASSED', `${country}: ${u.validation_issues}`);
    assert.equal(u.outreach_status, 'READY_FOR_APPROVAL');
    assert.match(u.email_body, /^Hi Sam,/);
    assert.match(u.email_body, /unsubscribe/);
    if (country === 'US') assert.match(u.email_body, /1 Test Street/, 'postal address in US footer');
    assert.ok(!/\[|\{\{|REPLACE_WITH/.test(u.email_body));
  }
});

test('missing contact name -> deterministic fallback greeting, never an invented name', () => {
  assert.equal(greeting(lead({ first_name: '' })), 'Hi Demo Dental team,');
  assert.equal(greeting(lead({ first_name: '', business_name: 'A'.repeat(50) })), 'Hello,');
});

function ctxFor(signals) {
  const sel = selectOpportunities(signals, lead(), catalogue, settings);
  return { lead: lead(), selection: sel, settings, locale: 'en-US', companyName: 'FlowHQ', sender: settings.sender };
}
const goodParts = (ctx) => templateParts(Object.assign({}, ctx, { sender: settings.sender }));

test('validation blocks unsupported claims, hype, numbers, guarantees and social proof', () => {
  const ctx = ctxFor([SIG.booking]);
  const bad = (field, text) => validateDraft(Object.assign(goodParts(ctx), { [field]: text }), ctx);
  const codes = (r) => r.issues.filter((i) => i.severity === 'block').map((i) => i.code);
  assert.ok(codes(bad('observation_paragraph', 'I noticed your website is slow and asks people to call to book.')).includes('unsupported_quality_claim'));
  assert.ok(codes(bad('suggestion_paragraph', 'This could increase your revenue by 30%, guaranteed.')).includes('guarantee'));
  assert.ok(codes(bad('suggestion_paragraph', 'This could increase your revenue by 30%.')).includes('numeric_claim'));
  assert.ok(codes(bad('suggestion_paragraph', "We've helped dozens of clinics like yours.")).includes('social_proof'));
  assert.ok(codes(bad('suggestion_paragraph', 'Our cutting-edge AI will revolutionise your bookings.')).includes('hype_or_urgency'));
  assert.ok(codes(bad('observation_paragraph', 'I called your clinic and nobody answered, and your website asks people to call to book.')).includes('pretended_testing'));
  assert.ok(codes(bad('cta_sentence', 'Book a call at https://cal.example/x')).includes('link_in_text'));
  assert.ok(codes(bad('observation_paragraph', 'Hi Sam, your website asks people to call to book.')).includes('greeting_in_part'));
  assert.ok(codes(bad('subject', 'Re: your website')).includes('subject_deceptive_prefix'));
  assert.ok(codes(bad('subject', 'URGENT idea for you!')).includes('subject_exclamation'));
  assert.ok(codes(bad('intro_sentence', 'I run an agency.')).includes('sender_not_identified'));
  assert.ok(codes(bad('cta_sentence', 'Can I help, [First Name]?')).includes('placeholder'));
});

test('validation: claims must be grounded in selected evidence and not-found must be hedged', () => {
  const ctx = ctxFor([SIG.booking]);
  const parts = goodParts(ctx);
  const r1 = validateDraft(Object.assign({}, parts, { observation_paragraph: "I noticed your website asks people to call to book, and your FAQ page doesn't cover pricing." }), ctx);
  assert.ok(r1.issues.some((i) => i.code === 'ungrounded_claim'), 'FAQ topic was not in the evidence');
  const ctxNF = ctxFor([SIG.noForm]);
  const r2 = validateDraft(Object.assign({}, goodParts(ctxNF), { observation_paragraph: "Your website doesn't have an enquiry form." }), ctxNF);
  const codes = r2.issues.map((i) => i.code);
  assert.ok(codes.includes('absolute_absence_claim'));
  assert.ok(codes.includes('not_found_phrasing'));
  const r3 = validateDraft(Object.assign({}, parts, { used_signal_ids: ['faq_extensive'] }), ctx);
  assert.ok(r3.issues.some((i) => i.code === 'signal_ids_mismatch'));
  const r4 = validateDraft(Object.assign({}, parts, { observation_paragraph: 'I noticed Dr. Patel asks people to call to book on your website.' }), Object.assign({}, ctx, { lead: lead({ first_name: '' }) }));
  assert.ok(r4.issues.some((i) => i.code === 'invented_name'));
});

test('validation: length limits', () => {
  const ctx = ctxFor([SIG.booking]);
  const long = Object.assign(goodParts(ctx), { suggestion_paragraph: 'One idea would be online booking with reminders. '.repeat(30) });
  assert.ok(validateDraft(long, ctx).issues.some((i) => i.code === 'too_long'));
  const short = Object.assign(goodParts(ctx), { suggestion_paragraph: 'Online booking.', observation_paragraph: 'Your website asks people to call to book.', intro_sentence: 'I run FlowHQ.', cta_sentence: 'Chat?', secondary_sentence: '' });
  assert.ok(validateDraft(short, ctx).issues.some((i) => i.code === 'too_short'));
});

test('sender placeholders in config keep drafts out of the approval queue', () => {
  const s = testSettings(null, { llm: { provider: 'template' }, sender: { name: 'REPLACE_WITH_YOUR_NAME' } });
  const plan = planGeneration(lead({ signals_json: JSON.stringify([SIG.booking]) }), catalogue, s, compliance);
  const u = finalizeGeneration(plan, null, s, compliance);
  assert.equal(u.factual_validation_status, 'FAILED');
  assert.match(u.validation_issues, /placeholder_in_assembled_email/);
});

test('websites that refuse unsolicited messages are not drafted', () => {
  const plan = planGeneration(lead({ signals_json: JSON.stringify([SIG.booking]), no_unsolicited_notice: 'x: "no unsolicited emails"' }), catalogue, settings, compliance);
  assert.equal(plan.action, 'skip');
  assert.equal(plan.update.status_reason, 'website_says_no_unsolicited_messages');
});

test('LLM request: Anthropic structured output; OpenAI-compatible json mode', () => {
  const ctx = ctxFor([SIG.booking]);
  const a = buildRequest(ctx, { provider: 'anthropic', model: 'claude-haiku-5-5', max_tokens: 3000, effort: 'low' });
  assert.equal(a.output_config.format.type, 'json_schema');
  assert.deepEqual(a.output_config.format.schema, EMAIL_SCHEMA);
  assert.equal(a.output_config.effort, 'low');
  assert.match(a.system, /untrusted/);
  const o = buildRequest(ctx, { provider: 'openai_compatible', model: 'x', openai_response_format: 'json_object' });
  assert.equal(o.response_format.type, 'json_object');
  assert.equal(o.messages[0].role, 'system');
});

test('no email addresses or contact names are sent to the AI model', () => {
  const sig = Object.assign({}, SIG.booking, { evidence_snippet: 'Call us to book. Email: sam.smith@demo.example' });
  const ctx = Object.assign(ctxFor([sig]), { lead: lead({ contact_name: 'Sam Smith' }) });
  const body = JSON.stringify(buildRequest(ctx, { provider: 'anthropic', model: 'm' }));
  assert.ok(!/sam\.smith@|sam@demo\.example|Sam Smith/.test(body));
  assert.match(body, /\(email address\)/);
});

test('LLM response parsing: malformed, truncated, refusal, provider errors', () => {
  const llm = { provider: 'anthropic' };
  const wrap = (text, extra) => Object.assign({ content: [{ type: 'text', text }], stop_reason: 'end_turn' }, extra);
  assert.equal(parseResponse(wrap('Sure! Here is an email'), llm).kind, 'malformed');
  assert.equal(parseResponse(wrap('{"subject":"x"}'), llm).kind, 'malformed');
  assert.equal(parseResponse(wrap('{', { stop_reason: 'max_tokens' }), llm).kind, 'malformed');
  assert.equal(parseResponse(wrap('', { stop_reason: 'refusal' }), llm).kind, 'permanent');
  assert.equal(parseResponse({ error: { message: '529 overloaded_error' } }, llm).kind, 'temporary');
  assert.equal(parseResponse({ error: { message: '429 rate limit' } }, llm).kind, 'temporary');
  assert.equal(parseResponse({ error: { message: '401 invalid x-api-key' } }, llm).kind, 'permanent');
  const ok = parseResponse(wrap('```json\n' + JSON.stringify({ subject: 's', observation_paragraph: 'o', suggestion_paragraph: 'p', secondary_sentence: '', intro_sentence: 'i', cta_sentence: 'c', used_signal_ids: [], used_service_ids: [] }) + '\n```'), llm);
  assert.equal(ok.ok, true);
  const oa = parseResponse({ choices: [{ message: { content: '{}' }, finish_reason: 'length' }] }, { provider: 'openai_compatible' });
  assert.equal(oa.kind, 'malformed');
});

test('temporary LLM failure keeps the lead queued; repeated failures go to manual review', () => {
  const s = testSettings(null, { llm: { provider: 'anthropic', model: 'm' } });
  const plan = planGeneration(lead({ signals_json: JSON.stringify([SIG.booking]) }), catalogue, s, compliance);
  const u1 = finalizeGeneration(plan, { error: { message: '529 overloaded' } }, s, compliance);
  assert.equal(u1.outreach_status, 'RESEARCHED');
  assert.equal(u1.generation_attempts, 1);
  const plan3 = Object.assign({}, plan, { lead: Object.assign({}, plan.lead, { generation_attempts: 2 }) });
  assert.equal(finalizeGeneration(plan3, { error: { message: '529 overloaded' } }, s, compliance).outreach_status, 'MANUAL_REVIEW');
});
