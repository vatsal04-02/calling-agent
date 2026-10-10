#!/usr/bin/env node
'use strict';
// Offline reference runner. Executes the same library code as the n8n
// workflows against an in-memory spreadsheet (persisted to a JSON file), so
// the whole pipeline can be tested and drafts previewed without n8n, Google
// Sheets or Gmail. Sending here ONLY goes to a local mock Gmail server.
const fs = require('fs');
const path = require('path');
const { parseCsv, toCsv } = require('./csv');
const { prepareImport } = require('../lib/leads');
const research = require('../lib/research');
const { extractPage } = require('../lib/html');
const { fetchUrlFor } = require('../lib/url');
const { planGeneration, finalizeGeneration } = require('../lib/generate');
const { evaluateSendQueue, classifySendResult, recordSendResult, recheckBeforeSend } = require('../lib/sendgate');
const { effectivePolicy } = require('../lib/config');
const { processInbox, bounceRateTrip } = require('../lib/inbox');
const { TABS, DEFAULT_SETTINGS_ROWS } = require('../lib/schema');
const { STATUS } = require('../lib/status');

const ROOT = path.join(__dirname, '..');
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));

function loadSettings(overrides) {
  const base = readJson('config/settings.default.json');
  const localPath = path.join(ROOT, 'config/settings.local.json');
  const local = fs.existsSync(localPath) ? JSON.parse(fs.readFileSync(localPath, 'utf8')) : {};
  return deepMerge(deepMerge(base, local), overrides || {});
}

function deepMerge(a, b) {
  const out = Array.isArray(a) ? a.slice() : Object.assign({}, a);
  for (const k of Object.keys(b || {})) {
    out[k] = b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) && a && typeof a[k] === 'object' ? deepMerge(a[k], b[k]) : b[k];
  }
  return out;
}

function createStore() {
  const s = {};
  for (const t of Object.keys(TABS)) s[t] = [];
  s.Settings = DEFAULT_SETTINGS_ROWS.map((r) => Object.assign({}, r));
  return s;
}

// Mirrors the Google Sheets "update row, match on lead_id" behaviour.
function updateRows(rows, updates, key) {
  for (const u of updates) {
    const row = rows.find((r) => r[key] === u[key]);
    if (row) for (const k of Object.keys(u)) if (!k.startsWith('_')) row[k] = u[k];
  }
}

function setSetting(store, key, value) {
  const row = store.Settings.find((r) => r.key === key);
  if (row) row.value = value; else store.Settings.push({ key, value, notes: '' });
}

async function httpGet(url, settings) {
  const rs = settings.research;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), rs.request_timeout_ms);
  try {
    const res = await fetch(fetchUrlFor(url, settings.fixture_base_url), { headers: { 'user-agent': rs.user_agent }, signal: ctrl.signal, redirect: 'follow' });
    const headers = {};
    res.headers.forEach((v, k) => { headers[k] = v; });
    return { statusCode: res.status, headers, body: await res.text() };
  } catch (e) {
    return { error: { message: e.name === 'AbortError' ? 'timeout of ' + rs.request_timeout_ms + 'ms exceeded' : String(e.cause ? e.cause.code || e.message : e.message) } };
  } finally {
    clearTimeout(timer);
  }
}

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function runImport(store, sourceRows, settings) {
  const mapping = readJson('config/field-mapping.json');
  const catalogue = readJson('config/service-catalogue.json');
  const { records, stats } = prepareImport({ sourceRows, existingLeads: store.Leads, suppressionRows: store.Suppression, settings, mapping, catalogue });
  store.Leads.push(...records);
  return stats;
}

async function runResearch(store, settings) {
  const compliance = readJson('config/compliance.json');
  const policy = effectivePolicy(settings, store.Settings);
  const reprocess = (l) => String(l.reprocess).toUpperCase() === 'TRUE';
  const leads = store.Leads.filter((l) => l.outreach_status === STATUS.VALIDATED || (reprocess(l) && [STATUS.RESEARCHED, STATUS.MANUAL_REVIEW].includes(l.outreach_status))).slice(0, policy.research_batch_size);
  const cacheByDomain = {};
  for (const r of store.Research_Cache) cacheByDomain[r.domain] = r;
  const results = [];
  for (const lead of leads) {
    try {
      const plan = research.planResearch(lead, cacheByDomain, settings);
      let r;
      if (plan.use_cache) r = plan.research;
      else {
        const robotsResp = await httpGet(plan.robots_url, settings);
        const robots = research.robotsDecision(lead, robotsResp, settings);
        const fetched = [];
        if (!robots.blocked) {
          await sleep(settings.research.request_interval_ms);
          const home = await httpGet(lead.website, settings);
          fetched.push({ url: lead.website, category: 'home', response: home });
          const hr = research.interpretResponse(home, settings.research.max_html_chars);
          if (hr.ok) {
            const pages = research.selectPages(extractPage(hr.body, lead.website), robots.groups, settings);
            for (const p of pages) {
              await sleep(settings.research.request_interval_ms);
              fetched.push({ url: p.url, category: p.category, response: await httpGet(p.url, settings) });
            }
          }
        }
        r = research.buildResearch({ lead, robots, fetched, settings, compliance });
        const row = research.cacheRowFromResearch(r, settings);
        const existing = store.Research_Cache.find((c) => c.domain === row.domain);
        if (existing) Object.assign(existing, row); else store.Research_Cache.push(row);
        cacheByDomain[row.domain] = row;
      }
      const update = research.leadUpdateFromResearch(lead, r, settings);
      updateRows(store.Leads, [update], 'lead_id');
      results.push({ lead_id: lead.lead_id, status: update.outreach_status, access: r.access_status, signals: r.signals.map((s) => s.id) });
    } catch (e) {
      store.Error_Log.push({ timestamp: new Date().toISOString(), workflow: '02 Research', node: 'local', lead_id: lead.lead_id, error_type: 'exception', message: e.message });
      results.push({ lead_id: lead.lead_id, status: 'ERROR', error: e.message });
    }
  }
  return results;
}

async function callLlm(body, settings) {
  const headers = { 'content-type': 'application/json' };
  if (settings.llm.provider === 'anthropic') {
    headers['anthropic-version'] = '2023-06-01';
    headers['x-api-key'] = process.env.ANTHROPIC_API_KEY || 'mock-key';
  } else headers.authorization = `Bearer ${process.env.LLM_API_KEY || 'mock-key'}`;
  try {
    const res = await fetch(settings.llm.endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return { error: { message: `${res.status} ${JSON.stringify(json).slice(0, 200)}` } };
    return json;
  } catch (e) {
    return { error: { message: String(e.cause ? e.cause.code || e.message : e.message) } };
  }
}

async function runGenerate(store, settings) {
  const catalogue = readJson('config/service-catalogue.json');
  const compliance = readJson('config/compliance.json');
  const policy = effectivePolicy(settings, store.Settings);
  const leads = store.Leads.filter((l) => l.outreach_status === STATUS.RESEARCHED).slice(0, policy.generation_batch_size);
  const results = [];
  for (const lead of leads) {
    const plan = planGeneration(lead, catalogue, settings, compliance);
    let update;
    if (plan.action === 'skip') update = plan.update;
    else {
      const llmItem = plan.action === 'llm' ? await callLlm(plan.request_body, settings) : null;
      update = finalizeGeneration(plan, llmItem, settings, compliance);
    }
    if (update._error) store.Error_Log.push({ timestamp: new Date().toISOString(), workflow: '03 Generate', node: 'local', lead_id: lead.lead_id, error_type: update._error.type, message: update._error.message });
    updateRows(store.Leads, [update], 'lead_id');
    results.push({ lead_id: lead.lead_id, status: update.outreach_status, validation: update.factual_validation_status || '', reason: update.status_reason || '' });
  }
  return results;
}

async function runSend(store, settings, opts) {
  const o = opts || {};
  const base = settings.sending.gmail_api_base;
  if (!/^http:\/\/127\.0\.0\.1:\d+/.test(base)) throw new Error('local-pipeline only sends to a local MOCK Gmail server; real sending happens in n8n');
  const compliance = readJson('config/compliance.json');
  const gate = evaluateSendQueue({ leads: store.Leads, sendLog: store.Send_Log, suppressionRows: store.Suppression, settings, settingsRows: store.Settings, compliance, now: o.now });
  updateRows(store.Leads, gate.updates, 'lead_id');
  const results = [];
  for (const item of gate.send) {
    const check = recheckBeforeSend(settings, store.Settings);
    if (!check.ok) { results.push({ lead_id: item.lead_id, outcome: 'stopped', reason: check.reasons.join('; ') }); continue; }
    updateRows(store.Leads, [{ lead_id: item.lead_id, outreach_status: STATUS.SENDING }], 'lead_id');
    let resp;
    try {
      const res = await fetch(`${base}/gmail/v1/users/me/messages/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ raw: item.raw }) });
      resp = { statusCode: res.status, body: await res.text() };
    } catch (e) { resp = { error: { message: e.message } }; }
    const result = classifySendResult(resp);
    const rec = recordSendResult(item, result, settings, o.now);
    updateRows(store.Leads, [rec.update], 'lead_id');
    store.Send_Log.push(rec.log);
    if (rec.suppress) store.Suppression.push(rec.suppress);
    if (rec.trip_kill_switch) { setSetting(store, 'KILL_SWITCH', 'TRUE'); setSetting(store, 'KILL_SWITCH_REASON', rec.trip_kill_switch); }
    results.push({ lead_id: item.lead_id, outcome: result.outcome, mode: item.mode, to: item.to });
    if (o.intervalMs) await sleep(o.intervalMs);
  }
  return { summary: gate.summary, blocked: gate.blocked, would_send: gate.would_send, results };
}

function runInbox(store, messages) {
  const out = processInbox(messages, store.Leads, store.Inbox_Log);
  store.Suppression.push(...out.suppress);
  updateRows(store.Leads, out.leadUpdates, 'lead_id');
  store.Inbox_Log.push(...out.log);
  const bounced = store.Leads.filter((l) => l.outreach_status === STATUS.BOUNCED).length - out.hardBounces;
  const trip = bounceRateTrip(store.Send_Log, out.hardBounces, Math.max(0, bounced), 0.05);
  if (trip) { setSetting(store, 'KILL_SWITCH', 'TRUE'); setSetting(store, 'KILL_SWITCH_REASON', trip); }
  return out;
}

function writeReport(store, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'leads.csv'), toCsv(store.Leads, TABS.Leads));
  const md = ['# Draft preview (SYNTHETIC TEST DATA)', ''];
  for (const l of store.Leads) {
    md.push(`## ${l.business_name} (${l.lead_id}) - ${l.outreach_status}${l.status_reason ? ` (${l.status_reason})` : ''}`);
    if (l.website_access_status) md.push(`- Research: ${l.website_access_status}; pages: ${(l.pages_reviewed || '').split('\n').filter(Boolean).length}`);
    if (l.observed_issue_1) md.push(`- Evidence 1: ${l.observed_issue_1} [${l.evidence_url_1}] "${l.evidence_snippet_1}"`);
    if (l.observed_issue_2) md.push(`- Evidence 2: ${l.observed_issue_2} [${l.evidence_url_2}]`);
    if (l.selected_signals) md.push(`- Selected for the email: ${l.selected_signals}`);
    if (l.recommended_solution) md.push(`- Recommendation: ${l.recommended_solution}${l.secondary_solution ? ' + ' + l.secondary_solution : ''} (confidence ${l.confidence_score})`);
    if (l.factual_validation_status) md.push(`- Validation: ${l.factual_validation_status}${l.validation_issues ? '\n  ' + l.validation_issues.split('\n').join('\n  ') : ''}`);
    if (l.email_body) md.push('', `**Subject:** ${l.email_subject}`, '', '```text', l.email_body, '```');
    md.push('');
  }
  fs.writeFileSync(path.join(outDir, 'drafts.md'), md.join('\n'));
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const storePath = process.env.STORE || path.join(ROOT, 'out', 'store.json');
  const settings = loadSettings(process.env.SETTINGS_OVERRIDES ? JSON.parse(process.env.SETTINGS_OVERRIDES) : {});
  const store = fs.existsSync(storePath) ? JSON.parse(fs.readFileSync(storePath, 'utf8')) : createStore();
  let out;
  if (cmd === 'import') out = runImport(store, parseCsv(fs.readFileSync(args[0], 'utf8')), settings);
  else if (cmd === 'suppress') { store.Suppression.push(...parseCsv(fs.readFileSync(args[0], 'utf8'))); out = { suppression: store.Suppression.length }; }
  else if (cmd === 'research') out = await runResearch(store, settings);
  else if (cmd === 'generate') out = await runGenerate(store, settings);
  else if (cmd === 'send') out = await runSend(store, settings);
  else if (cmd === 'report') { writeReport(store, path.dirname(storePath)); out = { written: path.dirname(storePath) }; }
  else { console.log('usage: local-pipeline.js import <csv> | suppress <csv> | research | generate | send | report'); process.exit(1); }
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2));
  console.log(JSON.stringify(out, null, 2));
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { loadSettings, createStore, runImport, runResearch, runGenerate, runSend, runInbox, writeReport, updateRows, setSetting, deepMerge };
