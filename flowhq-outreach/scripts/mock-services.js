#!/usr/bin/env node
'use strict';
// MOCK external services for offline testing. Nothing here talks to a real
// provider. Behaviour is scripted so every failure path can be exercised:
//   LLM  POST /v1/messages (Anthropic shape), POST /v1/chat/completions (OpenAI shape)
//     - business "Summit Roofing"   -> returns unsupported claims (must fail validation)
//     - business "Harbour Plumbing" -> first call returns 529 overloaded (temporary failure)
//     - business "Kiwi Physio"      -> returns non-JSON text once (malformed response)
//     - otherwise                   -> a well-formed draft built only from the provided observations
//   Ollama POST /api/chat (small-model behaviour): Harbour -> first reply truncated (done_reason=length),
//     Summit -> fabricated claims, Kiwi -> <think> preamble before the JSON, all -> empty used_*_ids
//   Sheets (n8n harness only) GET /sheets/<tab>/read, POST /sheets/<tab>/<append|update|appendOrUpdate>?key=col
//     - in-memory tabs with Google-Sheets-like semantics (update skips missing keys)
//   Gmail POST /gmail/v1/users/me/messages/send, GET /gmail/v1/users/me/profile, GET /gmail/parsed-inbox
//     - recipient containing "tempfail" -> 503, "authfail" -> 401, "invalid" -> 400 Invalid To header
//     - otherwise -> 200 with a fake message id; every accepted message is recorded
const http = require('http');
const { decodeBase64Url } = require('../lib/mime');

function draftFromPayload(p) {
  const biz = p.business.name;
  const us = p.locale === 'en-US';
  const enquiry = us ? 'inquiry' : 'enquiry';
  const obs = p.observations.map((o) => {
    if (o.claim_type === 'not_found') return o.observation.replace(/^I /, 'I also ');
    return o.observation.replace(/^The (website|homepage)/, 'your $1').replace(/^Client/, 'client').replace(/^Quotes/, 'quotes');
  });
  const first = p.observations[0].claim_type === 'not_found'
    ? `While looking at ${biz}'s website, ${p.observations[0].observation.replace(/^I /, 'I ')}`
    : `While looking at ${biz}'s website, I noticed ${obs[0].replace(/\.$/, '')}.`;
  const rest = obs.slice(1).map((o) => (/^I also/.test(o) ? o : `I also noticed ${o}`)).join(' ');
  const svc = p.primary_service;
  return {
    subject: `An idea for ${biz}`.slice(0, 55),
    observation_paragraph: [first, rest].filter(Boolean).join(' '),
    suggestion_paragraph: `One option would be ${svc.name.toLowerCase()}: ${svc.what_it_does.charAt(0).toLowerCase()}${svc.what_it_does.slice(1)} That way, ${svc.approved_benefits[0]}.`,
    secondary_sentence: p.secondary_service ? `I also had a thought about ${p.secondary_service.name.toLowerCase()}, depending on how your team handles each ${enquiry} today.` : '',
    intro_sentence: `I run ${p.sender.company}, where we build custom websites and AI automation for small businesses.`,
    cta_sentence: 'Would you be open to a brief conversation? I can share a couple of ideas specific to your website.',
    used_signal_ids: p.observations.map((o) => o.id),
    used_service_ids: [svc.id].concat(p.secondary_service ? [p.secondary_service.id] : []),
  };
}

function createServer() {
  const state = { llmCalls: [], sent: [], harbourFailures: 0, kiwiMalformed: 0, sheets: {}, inbox: [] };
  const { TABS } = require('../lib/schema');
  const tab = (name) => (state.sheets[name] = state.sheets[name] || []);
  const cell = (v) => (v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : v);
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch (e) { return send(400, { error: 'bad json' }); }
      if (!req.url.startsWith('/__')) (state.requests = state.requests || []).push({ t: Date.now(), method: req.method, url: req.url, ua: req.headers['user-agent'] || '' });

      if (req.method === 'POST' && (req.url === '/v1/messages' || req.url === '/v1/chat/completions')) {
        const anthropic = req.url === '/v1/messages';
        const userMsg = anthropic ? body.messages[0].content : body.messages[1].content;
        const payload = JSON.parse(String(userMsg).replace(/\n\nReturn only the JSON object\.$/, ''));
        state.llmCalls.push({ business: payload.business.name, headers: { 'x-api-key': req.headers['x-api-key'] ? 'present' : 'absent', 'anthropic-version': req.headers['anthropic-version'] || '' } });
        const name = payload.business.name;
        if (/Harbour Plumbing/.test(name) && state.harbourFailures < 1) {
          state.harbourFailures++;
          return send(529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded (mock)' } });
        }
        let text;
        if (/Kiwi Physio/.test(name) && state.kiwiMalformed < 1) {
          state.kiwiMalformed++;
          text = 'Sure! Here is a great email for you: Hi there...';
        } else {
          const d = draftFromPayload(payload);
          if (/Summit Roofing/.test(name)) {
            d.observation_paragraph = "I noticed your website is slow and outdated, and you're probably losing 30% of customers because of it.";
            d.suggestion_paragraph = 'Our clients typically double their bookings within a month, guaranteed.';
          }
          text = JSON.stringify(d);
        }
        if (anthropic) {
          return send(200, { id: 'msg_mock', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 1450, output_tokens: 260 } });
        }
        return send(200, { id: 'chatcmpl_mock', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 1450, completion_tokens: 260 } });
      }

      if (req.method === 'GET' && req.url === '/gmail/v1/users/me/profile') return send(200, { emailAddress: 'sender@flowhq-test.example', messagesTotal: 0 });

      if (req.method === 'POST' && req.url === '/gmail/v1/users/me/messages/send') {
        const mime = decodeBase64Url(body.raw || '');
        const to = (/^To: (.*)$/m.exec(mime) || [])[1] || '';
        if (/tempfail/.test(to)) return send(503, { error: { code: 503, message: 'Backend Error (mock)' } });
        if (/authfail/.test(to)) return send(401, { error: { code: 401, message: 'Request had invalid authentication credentials (mock)' } });
        if (/invalid/.test(to)) return send(400, { error: { code: 400, message: 'Invalid To header (mock)' } });
        const id = 'mock-' + (state.sent.length + 1).toString(16).padStart(8, '0');
        state.sent.push({ id, to, mime });
        return send(200, { id, threadId: 'thread-' + id, labelIds: ['SENT'] });
      }

      if (req.method === 'POST' && req.url === '/api/chat') {
        // Ollama native API, emulating a small local model (Qwen3 4B class).
        const payload = JSON.parse(String(body.messages[1].content).replace(/\n\nReturn only the JSON object\.$/, ''));
        const name = payload.business.name;
        state.llmCalls.push({ business: name, provider: 'ollama', think: body.think, has_format: !!body.format, num_ctx: body.options && body.options.num_ctx, stream: body.stream });
        state.ollamaCounts = state.ollamaCounts || {};
        const n = (state.ollamaCounts[name] = (state.ollamaCounts[name] || 0) + 1);
        const reply = (content, extra) => send(200, Object.assign({ model: body.model, message: { role: 'assistant', content }, done: true, done_reason: 'stop', prompt_eval_count: 1900, eval_count: 330 }, extra || {}));
        if (/Harbour Plumbing/.test(name) && n === 1) return reply('{"subject": "An idea for Harb', { done_reason: 'length' });
        const d = draftFromPayload(payload);
        d.used_signal_ids = [];  // small models often drop the echo fields
        d.used_service_ids = [];
        if (/Summit Roofing/.test(name)) {
          d.observation_paragraph = 'Your website is slow and outdated, so you are losing customers.';
          d.suggestion_paragraph = 'We guarantee a 30% increase in bookings!';
        }
        if (/Kiwi Physio/.test(name)) return reply('<think>\nThe user wants a JSON object {like this}. Let me plan.\n</think>\n\n' + JSON.stringify(d));
        return reply(JSON.stringify(d));
      }
      const sm = /^\/sheets\/([a-z_]+)\/(read|append|update|appendOrUpdate)(?:\?key=([a-z_]+))?$/.exec(req.url);
      if (sm) {
        const [, name, op, key] = sm;
        const rows = tab(name);
        if (op === 'read') return send(200, rows.map((r, i) => Object.assign({ row_number: i + 2 }, r)));
        const item = {};
        for (const k of Object.keys(body)) if (k !== 'row_number') item[k] = cell(body[k]);
        const existing = key ? rows.find((r) => String(r[key]) === String(item[key])) : null;
        if (op === 'append' || (op === 'appendOrUpdate' && !existing)) rows.push(item);
        else if (existing) for (const k of Object.keys(body)) if (k !== key && body[k] !== undefined && body[k] !== null && k !== 'row_number') existing[k] = cell(body[k]);
        return send(200, item);
      }
      if (req.method === 'GET' && req.url === '/sheets/__headers') {
        return send(200, { statusCode: 200, body: { valueRanges: Object.keys(TABS).map((t) => ({ range: `${t}!A1:ZZ1`, values: [TABS[t]] })) } });
      }
      if (req.method === 'POST' && req.url === '/__sheets/load') { for (const k of Object.keys(body)) state.sheets[k] = body[k]; return send(200, { ok: true }); }
      if (req.method === 'GET' && req.url === '/__sheets') return send(200, state.sheets);
      if (req.method === 'GET' && req.url === '/gmail/parsed-inbox') return send(200, state.inbox);
      if (req.method === 'POST' && req.url === '/__inbox') { state.inbox = body; return send(200, { ok: true }); }
      if (req.method === 'GET' && req.url === '/__state') return send(200, state);
      send(404, { error: 'not mocked' });
    });
  });
  server.state = state;
  return server;
}

if (require.main === module) {
  const port = Number(process.env.MOCK_PORT || 8789);
  createServer().listen(port, '127.0.0.1', () => console.log(`MOCK llm+gmail on http://127.0.0.1:${port}`));
}

module.exports = { createServer, draftFromPayload };
