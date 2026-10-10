#!/usr/bin/env node
'use strict';
/*
 * Generates the importable n8n workflows in workflows/ from lib/ + config/.
 * Every Code node carries a bundled copy of the (unit-tested) lib modules it
 * needs, so the logic in n8n is byte-for-byte the code covered by `npm test`.
 *
 *   node scripts/build-workflows.js                 -> workflows/*.json (production)
 *   node scripts/build-workflows.js --harness URL   -> out/harness/*.json (Sheets/Gmail/LLM replaced by a local MOCK at URL)
 *
 * Settings come from config/settings.default.json deep-merged with
 * config/settings.local.json (git-ignored) if present.
 */
const fs = require('fs');
const path = require('path');
const { loadSettings } = require('./local-pipeline');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const HARNESS = args.includes('--harness') ? args[args.indexOf('--harness') + 1] : '';
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));

const IDS = {
  preflight: 'FlowHQ0Preflight', import: 'FlowHQ01Import00', research: 'FlowHQ02Research', generate: 'FlowHQ03Generate',
  send: 'FlowHQ04SendMail', inbox: 'FlowHQ05InboxMon', unsubscribe: 'FlowHQ06Unsubscr', error: 'FlowHQ99ErrorLog',
};
const CREDS = {
  sheets: { googleSheetsOAuth2Api: { id: 'flowhqSheetsCred', name: 'FlowHQ Google Sheets' } },
  gmail: { gmailOAuth2: { id: 'flowhqGmailCred0', name: 'FlowHQ Gmail' } },
};

// ---------------------------------------------------------------- bundling
function moduleDeps(name) {
  const src = fs.readFileSync(path.join(ROOT, 'lib', name + '.js'), 'utf8');
  const deps = [];
  const re = /require\('\.\/([a-z]+)'\)/g;
  let m;
  while ((m = re.exec(src))) deps.push(m[1]);
  return { src, deps };
}

function bundle(entries) {
  const order = [];
  const seen = new Set();
  const visit = (n) => {
    if (seen.has(n)) return;
    seen.add(n);
    moduleDeps(n).deps.forEach(visit);
    order.push(n);
  };
  entries.forEach(visit);
  const defs = order.map((n) => `__defs[${JSON.stringify(n)}] = function (module, exports, require) {\n${moduleDeps(n).src}\n};`).join('\n');
  return [
    '// ===== FlowHQ library bundle (generated from lib/*.js by scripts/build-workflows.js; edit lib/ and rebuild) =====',
    'const __defs = {};',
    defs,
    'const __cache = {};',
    "function __require(n) { n = n.replace(/^\\.\\//, '').replace(/\\.js$/, ''); if (__cache[n]) return __cache[n].exports; const m = { exports: {} }; __cache[n] = m; __defs[n](m, m.exports, __require); return m.exports; }",
    `const lib = { ${entries.map((e) => `${e}: __require(${JSON.stringify(e)})`).join(', ')} };`,
    '// ===== end of bundle =====',
    '',
  ].join('\n');
}

const COMMON_JS = `
const CFG = $('Config').first().json;
const S = CFG.settings;
const rowsOf = (name) => { try { return $(name).all().map((i) => i.json).filter((r) => r && Object.keys(r).length && !r.error); } catch (e) { return []; } };
`;

// ---------------------------------------------------------------- node builders
let uid = 0;
function node(name, type, typeVersion, parameters, pos, extra) {
  uid++;
  return Object.assign({ parameters, id: `fhq-${uid.toString(16).padStart(4, '0')}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`.slice(0, 60), name, type, typeVersion, position: pos }, extra || {});
}

function code(name, libs, body, pos, extra) {
  // Only reference $('Config') where the node can see it: n8n rejects references to nodes that are not upstream.
  const needsConfig = /\b(CFG|S|rowsOf)\b/.test(body) || libs.length;
  const js = (libs.length ? bundle(libs) : '') + (needsConfig ? COMMON_JS : '\n') + body.trim() + '\n';
  return node(name, 'n8n-nodes-base.code', 2, { jsCode: js }, pos, extra);
}

function configNode(settings, pos) {
  const payload = {
    settings,
    catalogue: readJson('config/service-catalogue.json'),
    compliance: readJson('config/compliance.json'),
    mapping: readJson('config/field-mapping.json'),
  };
  const js = '// Static FlowHQ configuration (generated from config/*.json). No secrets here: keys live in n8n credentials.\n' +
    `return [{ json: ${JSON.stringify(payload, null, 1)} }];\n`;
  return node('Config', 'n8n-nodes-base.code', 2, { jsCode: js }, pos);
}

const docId = (source) => (source
  ? "={{ $('Config').first().json.settings.source.spreadsheet_id || $('Config').first().json.settings.spreadsheet_id }}"
  : "={{ $('Config').first().json.settings.spreadsheet_id }}");
const tabExpr = (tab) => (tab === 'source' ? "={{ $('Config').first().json.settings.source.sheet_name }}" : `={{ $('Config').first().json.settings.sheets.${tab} }}`);

// Google Sheets (or, in harness mode, an HTTP call to the mock sheet store).
function sheet(name, op, tab, pos, opts) {
  const o = opts || {};
  const extra = {};
  if (op === 'read') { extra.executeOnce = true; extra.alwaysOutputData = true; }
  extra.retryOnFail = true; extra.maxTries = 3; extra.waitBetweenTries = 3000;
  if (HARNESS) {
    const url = `${HARNESS}/sheets/${tab}/${op}` + (o.key ? `?key=${o.key}` : '');
    const p = op === 'read'
      ? { method: 'GET', url, options: { timeout: 10000 } }
      : { method: 'POST', url, sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify($json) }}', options: { timeout: 10000 } };
    return node(name, 'n8n-nodes-base.httpRequest', 4.2, p, pos, extra);
  }
  const p = {
    resource: 'sheet',
    operation: op,
    documentId: { __rl: true, value: docId(tab === 'source'), mode: 'id' },
    sheetName: { __rl: true, value: tabExpr(tab), mode: 'name' },
  };
  if (op === 'read') p.options = {};
  else {
    p.columns = { mappingMode: 'autoMapInputData', value: {}, matchingColumns: o.key ? [o.key] : [], schema: [], attemptToConvertTypes: false, convertFieldsToString: true };
    p.options = { cellFormat: 'RAW', handlingExtraData: 'ignoreIt' };
  }
  return node(name, 'n8n-nodes-base.googleSheets', 4.7, p, pos, Object.assign(extra, { credentials: CREDS.sheets }));
}

function httpGmail(name, method, pathSuffix, bodyExpr, pos, extra) {
  const p = {
    method,
    url: `={{ $('Config').first().json.settings.sending.gmail_api_base }}${pathSuffix}`,
    authentication: HARNESS ? 'none' : 'predefinedCredentialType',
    options: { timeout: 30000, response: { response: { fullResponse: true, neverError: true, responseFormat: 'json' } } },
  };
  if (!HARNESS) p.nodeCredentialType = 'gmailOAuth2';
  if (bodyExpr) Object.assign(p, { sendBody: true, specifyBody: 'json', jsonBody: bodyExpr });
  return node(name, 'n8n-nodes-base.httpRequest', 4.2, p, pos, Object.assign({}, extra || {}, HARNESS ? {} : { credentials: CREDS.gmail }));
}

function llmHttp(settings, pos) {
  const llm = settings.llm;
  const p = {
    method: 'POST',
    url: "={{ $('Config').first().json.settings.llm.endpoint }}",
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify($json.request_body) }}',
    options: { timeout: llm.timeout_ms || 120000 },
  };
  const credentials = {};
  if (HARNESS || llm.credential_type === 'none') p.authentication = 'none';
  else if (llm.credential_type === 'httpHeaderAuth') {
    Object.assign(p, { authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth' });
    credentials.httpHeaderAuth = { id: 'flowhqLlmHeader0', name: 'FlowHQ LLM API key' };
  } else {
    Object.assign(p, { authentication: 'predefinedCredentialType', nodeCredentialType: llm.credential_type || 'anthropicApi' });
    credentials[llm.credential_type || 'anthropicApi'] = { id: 'flowhqLlmCred000', name: 'FlowHQ LLM' };
  }
  if (llm.provider === 'anthropic') {
    p.sendHeaders = true;
    p.headerParameters = { parameters: [{ name: 'anthropic-version', value: '2023-06-01' }] };
  }
  return node('Call LLM', 'n8n-nodes-base.httpRequest', 4.2, p, pos,
    Object.assign({ retryOnFail: true, maxTries: llm.max_tries || 3, waitBetweenTries: 5000, onError: 'continueRegularOutput' }, Object.keys(credentials).length ? { credentials } : {}));
}

function ifNode(name, leftExpr, right, pos) {
  return node(name, 'n8n-nodes-base.if', 2.2, {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
      conditions: [{ id: `cond-${name.toLowerCase().replace(/[^a-z]+/g, '-')}`, leftValue: leftExpr, rightValue: right, operator: { type: 'string', operation: 'equals' } }],
      combinator: 'and',
    },
    options: {},
  }, pos);
}

const manual = (pos) => node('Run manually', 'n8n-nodes-base.manualTrigger', 1, {}, pos);
const schedule = (name, minutes, pos) => node(name, 'n8n-nodes-base.scheduleTrigger', 1.2, { rule: { interval: [{ field: 'minutes', minutesInterval: minutes }] } }, pos);
const loop = (name, pos) => node(name, 'n8n-nodes-base.splitInBatches', 3, { batchSize: 1, options: {} }, pos);

function connect(conns, from, to, fromOutput, toInput) {
  const c = conns[from] = conns[from] || { main: [] };
  const o = fromOutput || 0;
  while (c.main.length <= o) c.main.push([]);
  c.main[o].push({ node: to, type: 'main', index: toInput || 0 });
}

function chain(conns, names) {
  for (let i = 0; i < names.length - 1; i++) connect(conns, names[i], names[i + 1]);
}

function workflow(key, name, nodes, connections, notes) {
  return {
    id: IDS[key],
    name,
    nodes: [node('Notes', 'n8n-nodes-base.stickyNote', 1, { content: notes, height: 340, width: 420 }, [-520, -380])].concat(nodes),
    connections,
    active: false,
    settings: Object.assign({ executionOrder: 'v1', saveManualExecutions: true, saveDataErrorExecution: 'all', saveDataSuccessExecution: 'all' }, key === 'error' ? {} : { errorWorkflow: IDS.error }),
    pinData: {},
    meta: { templateCredsSetupCompleted: false },
    tags: [],
  };
}

const at = (col, row) => [col * 240, row * 200];

// ---------------------------------------------------------------- workflows
function wfImport(settings) {
  const c = {};
  const nodes = [
    manual(at(0, 0)), configNode(settings, at(1, 0)),
    sheet('Read source leads', 'read', 'source', at(2, 0)),
    sheet('Read Leads', 'read', 'leads', at(3, 0)),
    sheet('Read Suppression', 'read', 'suppression', at(4, 0)),
    code('Prepare import', ['leads'], `
const { records, stats } = lib.leads.prepareImport({
  sourceRows: rowsOf('Read source leads'),
  existingLeads: rowsOf('Read Leads'),
  suppressionRows: rowsOf('Read Suppression'),
  settings: S, mapping: CFG.mapping, catalogue: CFG.catalogue,
});
if (!records.length) return [{ json: { nothing_to_import: true, stats } }];
return records.map((r) => ({ json: r }));
`, at(5, 0)),
    ifNode('Anything new?', '={{ String($json.nothing_to_import === true) }}', 'false', at(6, 0)),
    sheet('Append to Leads', 'append', 'leads', at(7, -0.5)),
    code('Import summary', [], `
const added = $('Append to Leads').all().length;
const by = {};
for (const i of $('Prepare import').all()) by[i.json.outreach_status] = (by[i.json.outreach_status] || 0) + 1;
return [{ json: { added, by_status: by } }];
`, at(8, -0.5)),
  ];
  chain(c, ['Run manually', 'Config', 'Read source leads', 'Read Leads', 'Read Suppression', 'Prepare import', 'Anything new?']);
  connect(c, 'Anything new?', 'Append to Leads', 0);
  connect(c, 'Append to Leads', 'Import summary');
  return workflow('import', 'FlowHQ 01 - Import & validate leads', nodes, c,
    '## FlowHQ 01 - Import & validate leads\nReads your source sheet (read-only), maps columns via config/field-mapping.json, normalises and validates each row, detects duplicates and suppressed contacts, and appends NEW rows to the Leads tab.\n\nSafe to re-run: rows already imported (same lead_id) are skipped.');
}

function wfResearch(settings) {
  const c = {};
  const nodes = [
    manual(at(0, 0)), schedule('Every hour', 60, at(0, 1)), configNode(settings, at(1, 0)),
    sheet('Read Settings', 'read', 'settings', at(2, 0)),
    sheet('Read Leads', 'read', 'leads', at(3, 0)),
    sheet('Read Research Cache', 'read', 'research_cache', at(4, 0)),
    code('Select leads to research', ['config', 'status'], `
const policy = lib.config.effectivePolicy(S, rowsOf('Read Settings'));
const cache = {};
for (const r of rowsOf('Read Research Cache')) if (r.domain) cache[String(r.domain).toLowerCase()] = r;
const ST = lib.status.STATUS;
const reprocess = (l) => String(l.reprocess).toUpperCase() === 'TRUE';
const leads = rowsOf('Read Leads').filter((l) => l.outreach_status === ST.VALIDATED || (reprocess(l) && [ST.RESEARCHED, ST.MANUAL_REVIEW].includes(l.outreach_status)));
return leads.slice(0, policy.research_batch_size).map((lead) => ({ json: { lead, cache_row: cache[String(lead.domain).toLowerCase()] || null } }));
`, at(5, 0)),
    loop('One site at a time', at(6, 0)),
    code('Research website', ['research', 'html', 'url', 'util'], `
// One lead per run. Fetches robots.txt, the homepage and up to 3 more pages,
// sequentially, with a pause between requests. Any failure is recorded on the
// lead (manual review) instead of stopping the batch.
const { lead, cache_row } = $input.first().json;
const rs = S.research;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url) {
  try {
    const res = await helpers.httpRequest({
      method: 'GET', url: lib.url.fetchUrlFor(url, S.fixture_base_url), timeout: rs.request_timeout_ms,
      headers: { 'user-agent': rs.user_agent, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5' },
      returnFullResponse: true, ignoreHttpStatusErrors: true, encoding: 'text', json: false,
    });
    return { statusCode: res.statusCode, headers: res.headers || {}, body: typeof res.body === 'string' ? res.body : JSON.stringify(res.body || '') };
  } catch (e) {
    return { error: { message: String((e && (e.message || e.code)) || e) } };
  }
}
let research;
try {
  const plan = lib.research.planResearch(lead, cache_row ? { [lead.domain]: cache_row } : {}, S);
  if (plan.use_cache) research = plan.research;
  else {
    const robots = lib.research.robotsDecision(lead, await get(plan.robots_url), S);
    const fetched = [];
    if (!robots.blocked) {
      await sleep(rs.request_interval_ms);
      const home = await get(lead.website);
      fetched.push({ url: lead.website, category: 'home', response: home });
      const hr = lib.research.interpretResponse(home, rs.max_html_chars);
      if (hr.ok) {
        for (const p of lib.research.selectPages(lib.html.extractPage(hr.body, lead.website), robots.groups, S)) {
          await sleep(rs.request_interval_ms);
          fetched.push({ url: p.url, category: p.category, response: await get(p.url) });
        }
      }
    }
    research = lib.research.buildResearch({ lead, robots, fetched, settings: S, compliance: CFG.compliance });
  }
  const update = lib.research.leadUpdateFromResearch(lead, research, S);
  const cacheRow = research.from_cache ? cache_row : lib.research.cacheRowFromResearch(research, S);
  return [{ json: { update, cache_row: cacheRow } }];
} catch (e) {
  const now = new Date().toISOString();
  return [{ json: {
    update: { lead_id: lead.lead_id, outreach_status: 'MANUAL_REVIEW', status_reason: 'research_exception', last_error: lib.util.errorMessage(e), updated_at: now },
    cache_row: { domain: lead.domain || 'unknown', researched_at: now, expires_at: now, access_status: 'ERROR', summary: lib.util.errorMessage(e) },
  } }];
}
`, at(7, 0)),
    code('Lead update', [], `return [{ json: $input.first().json.update }];`, at(8, 0)),
    sheet('Update lead', 'update', 'leads', at(9, 0), { key: 'lead_id' }),
    code('Cache row', [], `return [{ json: $('Research website').first().json.cache_row }];`, at(10, 0)),
    sheet('Save research cache', 'appendOrUpdate', 'research_cache', at(11, 0), { key: 'domain' }),
    code('Run summary', [], `
const n = $('Select leads to research').all().filter((i) => i.json.lead).length;
return [{ json: { researched: n } }];
`, at(7, -1)),
  ];
  connect(c, 'Every hour', 'Config');
  chain(c, ['Run manually', 'Config', 'Read Settings', 'Read Leads', 'Read Research Cache', 'Select leads to research', 'One site at a time']);
  connect(c, 'One site at a time', 'Run summary', 0);
  connect(c, 'One site at a time', 'Research website', 1);
  chain(c, ['Research website', 'Lead update', 'Update lead', 'Cache row', 'Save research cache', 'One site at a time']);
  return workflow('research', 'FlowHQ 02 - Research websites', nodes, c,
    '## FlowHQ 02 - Research websites\nFor VALIDATED leads (and rows marked reprocess=TRUE): respects robots.txt, fetches the homepage plus at most 3 relevant pages (contact, booking, services, quote, FAQ), records evidence with URLs and quotes, caches results per domain.\n\nInaccessible, blocked, JS-only or thin sites go to MANUAL_REVIEW. Nothing is ever invented.\n\nThe schedule trigger only runs once you activate the workflow.');
}

function wfGenerate(settings) {
  const c = {};
  const nodes = [
    manual(at(0, 0)), schedule('Every hour', 60, at(0, 1)), configNode(settings, at(1, 0)),
    sheet('Read Settings', 'read', 'settings', at(2, 0)),
    sheet('Read Leads', 'read', 'leads', at(3, 0)),
    code('Plan drafts', ['generate', 'config'], `
const policy = lib.config.effectivePolicy(S, rowsOf('Read Settings'));
const leads = rowsOf('Read Leads').filter((l) => l.outreach_status === 'RESEARCHED').slice(0, policy.generation_batch_size);
return leads.map((lead) => {
  try { return { json: lib.generate.planGeneration(lead, CFG.catalogue, S, CFG.compliance) }; }
  catch (e) { return { json: { action: 'skip', lead_id: lead.lead_id, update: { lead_id: lead.lead_id, outreach_status: 'MANUAL_REVIEW', status_reason: 'planning_exception', last_error: String(e.message || e) } } }; }
});
`, at(4, 0)),
    loop('One lead at a time', at(5, 0)),
    ifNode('Needs AI model?', '={{ $json.action }}', 'llm', at(6, 0)),
    llmHttp(settings, at(7, -0.5)),
    code('Validate AI draft', ['generate'], `
const plan = $('One lead at a time').first().json;
const resp = $input.first().json;
try { return [{ json: lib.generate.finalizeGeneration(plan, resp, S, CFG.compliance) }]; }
catch (e) { return [{ json: { lead_id: plan.lead_id, outreach_status: 'MANUAL_REVIEW', status_reason: 'finalize_exception', last_error: String(e.message || e) } }]; }
`, at(8, -0.5)),
    code('Template draft or skip', ['generate'], `
const plan = $input.first().json;
if (plan.action === 'skip') return [{ json: plan.update }];
try { return [{ json: lib.generate.finalizeGeneration(plan, null, S, CFG.compliance) }]; }
catch (e) { return [{ json: { lead_id: plan.lead_id, outreach_status: 'MANUAL_REVIEW', status_reason: 'finalize_exception', last_error: String(e.message || e) } }]; }
`, at(7, 0.5)),
    code('Strip internal fields', [], `
const u = Object.assign({}, $input.first().json);
for (const k of Object.keys(u)) if (k.startsWith('_')) delete u[k];
return [{ json: u }];
`, at(9, 0)),
    sheet('Update lead', 'update', 'leads', at(10, 0), { key: 'lead_id' }),
    code('Run summary', [], `
return [{ json: { planned: $('Plan drafts').all().length } }];
`, at(6, -1)),
  ];
  connect(c, 'Every hour', 'Config');
  chain(c, ['Run manually', 'Config', 'Read Settings', 'Read Leads', 'Plan drafts', 'One lead at a time']);
  connect(c, 'One lead at a time', 'Run summary', 0);
  connect(c, 'One lead at a time', 'Needs AI model?', 1);
  connect(c, 'Needs AI model?', 'Call LLM', 0);
  connect(c, 'Needs AI model?', 'Template draft or skip', 1);
  chain(c, ['Call LLM', 'Validate AI draft', 'Strip internal fields']);
  connect(c, 'Template draft or skip', 'Strip internal fields');
  chain(c, ['Strip internal fields', 'Update lead', 'One lead at a time']);
  return workflow('generate', 'FlowHQ 03 - Select opportunities & draft emails', nodes, c,
    `## FlowHQ 03 - Draft emails\nFor RESEARCHED leads: picks at most 2 evidence-backed observations and at most 2 matching services from the catalogue (deterministic), asks the AI model (${settings.llm.provider}: ${settings.llm.model}) to word the email in structured JSON, then validates every claim against the evidence.\n\nPassing drafts -> READY_FOR_APPROVAL. Failing drafts or no credible recommendation -> MANUAL_REVIEW. Temporary AI errors are retried on the next run (max 3).\n\nNothing is sent by this workflow.`);
}

function wfSend(settings) {
  const c = {};
  const nodes = [
    manual(at(0, 0)), schedule('Every 30 minutes', 30, at(0, 1)), configNode(settings, at(1, 0)),
    sheet('Read Settings', 'read', 'settings', at(2, 0)),
    sheet('Read Leads', 'read', 'leads', at(3, 0)),
    sheet('Read Suppression', 'read', 'suppression', at(4, 0)),
    sheet('Read Send Log', 'read', 'send_log', at(5, 0)),
    code('Send gate', ['sendgate'], `
// Decides which APPROVED drafts may be sent now. Fail-closed: kill switch,
// SENDING_ENABLED (config AND sheet), TEST_MODE allowlist, limits, duplicates,
// suppression, opt-outs, per-country compliance and a final content check.
const g = lib.sendgate.evaluateSendQueue({
  leads: rowsOf('Read Leads'), sendLog: rowsOf('Read Send Log'), suppressionRows: rowsOf('Read Suppression'),
  settings: S, settingsRows: rowsOf('Read Settings'), compliance: CFG.compliance, runId: $execution.id ? 'exec-' + $execution.id : undefined,
});
const out = [{ json: Object.assign({ route: 'summary' }, g.summary, { blocked: g.blocked, would_send: g.would_send }) }];
for (const u of g.updates) out.push({ json: Object.assign({ route: 'update' }, u) });
for (const s of g.send) out.push({ json: Object.assign({ route: 'send' }, s) });
return out;
`, at(6, 0)),
    ifNode('Block-reason update?', '={{ $json.route }}', 'update', at(7, -1)),
    code('Drop route field', [], `return $input.all().map((i) => { const j = Object.assign({}, i.json); delete j.route; return { json: j }; });`, at(8, -1)),
    sheet('Record block reasons', 'update', 'leads', at(9, -1), { key: 'lead_id' }),
    ifNode('Email to send?', '={{ $json.route }}', 'send', at(7, 0.5)),
    loop('One email at a time', at(8, 0.5)),
    sheet('Re-read Settings', 'read', 'settings', at(9, 0.5)),
    code('Kill-switch check', ['sendgate'], `
// Re-evaluated before EVERY email so setting KILL_SWITCH=TRUE stops a run mid-way.
const item = $('One email at a time').first().json;
const check = lib.sendgate.recheckBeforeSend(S, rowsOf('Re-read Settings'));
if (!check.ok) return [{ json: { proceed: 'no', lead_id: item.lead_id, reasons: check.reasons } }];
return [{ json: { proceed: 'yes', lead_id: item.lead_id, outreach_status: 'SENDING', updated_at: new Date().toISOString() } }];
`, at(10, 0.5)),
    ifNode('Still allowed?', '={{ $json.proceed }}', 'yes', at(11, 0.5)),
    code('Claim lead', [], `const j = $input.first().json; return [{ json: { lead_id: j.lead_id, outreach_status: j.outreach_status, updated_at: j.updated_at } }];`, at(12, 0)),
    sheet('Mark SENDING', 'update', 'leads', at(13, 0), { key: 'lead_id' }),
    code('Message payload', [], `return [{ json: { raw: $('One email at a time').first().json.raw } }];`, at(14, 0)),
    httpGmail('Gmail API send', 'POST', '/gmail/v1/users/me/messages/send', '={{ JSON.stringify({ raw: $json.raw }) }}', at(15, 0), { onError: 'continueRegularOutput' }),
    code('Classify result', ['sendgate'], `
const item = $('One email at a time').first().json;
const result = lib.sendgate.classifySendResult($input.first().json);
const rec = lib.sendgate.recordSendResult(item, result, S);
const update = Object.assign({}, rec.update);
if (rec.suppress) update.opt_out_status = 'INVALID_ADDRESS';
return [{ json: { update, log: rec.log, trip: rec.trip_kill_switch, outcome: result.outcome } }];
`, at(16, 0)),
    code('Lead result', [], `return [{ json: $input.first().json.update }];`, at(17, 0)),
    sheet('Save send result', 'update', 'leads', at(18, 0), { key: 'lead_id' }),
    code('Log row', [], `return [{ json: $('Classify result').first().json.log }];`, at(19, 0)),
    sheet('Append Send Log', 'append', 'send_log', at(20, 0)),
    code('Settings writes', [], `
// Always records LAST_SEND_AT; additionally trips the kill switch on Gmail auth/quota errors.
const r = $('Classify result').first().json;
const now = new Date().toISOString();
const rows = [{ key: 'LAST_SEND_AT', value: now, notes: 'last outcome: ' + r.outcome }];
if (r.trip) rows.push({ key: 'KILL_SWITCH', value: 'TRUE', notes: 'set automatically' }, { key: 'KILL_SWITCH_REASON', value: r.trip, notes: 'set automatically' });
return rows.map((json) => ({ json }));
`, at(21, 0)),
    sheet('Update Settings', 'appendOrUpdate', 'settings', at(22, 0), { key: 'key' }),
    code('Pause before next email', ['config'], `
const p = lib.config.effectivePolicy(S, rowsOf('Re-read Settings'));
const jitter = Math.floor(Math.random() * (p.jitter_seconds + 1));
return [{ json: { wait_seconds: Math.max(1, p.interval_seconds + jitter) } }];
`, at(23, 0)),
    node('Wait', 'n8n-nodes-base.wait', 1.1, { resume: 'timeInterval', amount: '={{ $json.wait_seconds }}', unit: 'seconds' }, at(24, 0), { webhookId: 'flowhq-send-wait-0000-000000000000' }),
    code('Send summary', [], `
const gate = $('Send gate').first().json;
return [{ json: { mode: gate.mode, sending_enabled: gate.sending_enabled, queued: gate.queued, would_send: gate.would_send, blocked: gate.blocked, blocked_reasons: gate.blocked_reasons } }];
`, at(9, 1.5)),
  ];
  connect(c, 'Every 30 minutes', 'Config');
  chain(c, ['Run manually', 'Config', 'Read Settings', 'Read Leads', 'Read Suppression', 'Read Send Log', 'Send gate']);
  connect(c, 'Send gate', 'Block-reason update?');
  connect(c, 'Send gate', 'Email to send?');
  connect(c, 'Block-reason update?', 'Drop route field', 0);
  connect(c, 'Drop route field', 'Record block reasons');
  connect(c, 'Email to send?', 'One email at a time', 0);
  connect(c, 'One email at a time', 'Send summary', 0);
  connect(c, 'One email at a time', 'Re-read Settings', 1);
  chain(c, ['Re-read Settings', 'Kill-switch check', 'Still allowed?']);
  connect(c, 'Still allowed?', 'Claim lead', 0);
  connect(c, 'Still allowed?', 'One email at a time', 1);
  chain(c, ['Claim lead', 'Mark SENDING', 'Message payload', 'Gmail API send', 'Classify result', 'Lead result', 'Save send result', 'Log row', 'Append Send Log', 'Settings writes', 'Update Settings', 'Pause before next email', 'Wait', 'One email at a time']);
  return workflow('send', 'FlowHQ 04 - Send approved emails (Gmail)', nodes, c,
    '## FlowHQ 04 - Send approved emails\nSends ONLY drafts a human set to approval_status=APPROVED, and only when SENDING_ENABLED is TRUE in BOTH the workflow config and the Settings tab, the KILL_SWITCH is off, and limits allow.\n\nTEST_MODE (default) only emails allowlisted test inboxes. Live mode additionally needs sending.live_approval filled in.\n\nEach lead is marked SENDING before the Gmail call and SENT/TEST_SENT/RETRY_PENDING/FAILED/SEND_UNKNOWN after it, so nothing is ever sent twice. Gmail auth/quota errors trip the kill switch.\n\nKeep this workflow INACTIVE until you have approved live sending.');
}

function wfInbox(settings) {
  const c = {};
  const gmailList = HARNESS
    ? node('Fetch recent inbox messages', 'n8n-nodes-base.httpRequest', 4.2, { method: 'GET', url: `${HARNESS}/gmail/parsed-inbox`, options: {} }, at(5, 0), { executeOnce: true, alwaysOutputData: true })
    : node('Fetch recent inbox messages', 'n8n-nodes-base.gmail', 2.1, {
      resource: 'message', operation: 'getAll', returnAll: false, limit: 100, simple: false,
      filters: { q: 'in:inbox newer_than:7d -from:me', includeSpamTrash: false }, options: {},
    }, at(5, 0), { executeOnce: true, alwaysOutputData: true, credentials: CREDS.gmail, retryOnFail: true, maxTries: 3, waitBetweenTries: 5000 });
  const nodes = [
    manual(at(0, 0)), schedule('Every 30 minutes', 30, at(0, 1)), configNode(settings, at(1, 0)),
    sheet('Read Leads', 'read', 'leads', at(2, 0)),
    sheet('Read Inbox Log', 'read', 'inbox_log', at(3, 0)),
    sheet('Read Send Log', 'read', 'send_log', at(4, 0)),
    gmailList,
    code('Classify messages', ['inbox'], `
// Opt-outs and hard bounces -> Suppression + lead status; genuine replies -> REPLIED
// (stops any follow-up). A high hard-bounce rate trips the kill switch.
const pick = (m) => {
  const h = m.headers || {};
  const from = (m.from && (m.from.text || (m.from.value && m.from.value[0] && m.from.value[0].address))) || h.from || '';
  return { id: m.id, threadId: m.threadId, from, subject: m.subject || h.subject || '', text: m.text || m.snippet || '', headers: h, date: m.date || '' };
};
const msgs = rowsOf('Fetch recent inbox messages').filter((m) => m.id).map(pick);
const leads = rowsOf('Read Leads');
const out = lib.inbox.processInbox(msgs, leads, rowsOf('Read Inbox Log'));
const bouncedBefore = leads.filter((l) => l.outreach_status === 'BOUNCED').length;
const trip = lib.inbox.bounceRateTrip(rowsOf('Read Send Log'), out.hardBounces, bouncedBefore, 0.05);
const items = [];
for (const s of out.suppress) items.push({ json: Object.assign({ route: 'suppress' }, s) });
for (const u of out.leadUpdates) items.push({ json: Object.assign({ route: 'lead' }, u) });
for (const l of out.log) items.push({ json: Object.assign({ route: 'log' }, l) });
if (trip) items.push({ json: { route: 'settings', key: 'KILL_SWITCH', value: 'TRUE', notes: 'set automatically' } }, { json: { route: 'settings', key: 'KILL_SWITCH_REASON', value: trip, notes: 'set automatically' } });
return items;
`, at(6, 0)),
  ];
  const routes = [['suppress', 'Add to Suppression', 'append', 'suppression', null], ['lead', 'Update lead status', 'update', 'leads', 'lead_id'], ['log', 'Append Inbox Log', 'append', 'inbox_log', null], ['settings', 'Trip kill switch', 'appendOrUpdate', 'settings', 'key']];
  connect(c, 'Every 30 minutes', 'Config');
  chain(c, ['Run manually', 'Config', 'Read Leads', 'Read Inbox Log', 'Read Send Log', 'Fetch recent inbox messages', 'Classify messages']);
  routes.forEach(([route, name, op, tab, key], i) => {
    nodes.push(ifNode(`Route: ${route}`, '={{ $json.route }}', route, at(7, i - 1.5)));
    nodes.push(code(`Clean ${route}`, [], `return $input.all().map((i) => { const j = Object.assign({}, i.json); delete j.route; return { json: j }; });`, at(8, i - 1.5)));
    nodes.push(sheet(name, op, tab, at(9, i - 1.5), key ? { key } : {}));
    connect(c, 'Classify messages', `Route: ${route}`);
    connect(c, `Route: ${route}`, `Clean ${route}`, 0);
    connect(c, `Clean ${route}`, name);
  });
  return workflow('inbox', 'FlowHQ 05 - Inbox monitor (opt-outs, bounces, replies)', nodes, c,
    '## FlowHQ 05 - Inbox monitor\nReads recent Gmail inbox messages (read-only), and:\n- "unsubscribe"/"remove me"/"not interested" replies -> Suppression + UNSUBSCRIBED\n- hard bounces -> Suppression + BOUNCED\n- genuine replies -> REPLIED (a human takes over)\n- hard-bounce rate > 5% -> KILL_SWITCH\n\nActivate this BEFORE any live sending so opt-outs are honoured within minutes.');
}

function wfUnsubscribe(settings) {
  const c = {};
  const page = (msg) => `<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>FlowHQ</title></head><body style="font-family:sans-serif;max-width:520px;margin:48px auto;padding:0 16px">${msg}</body></html>`;
  const nodes = [
    node('Unsubscribe link opened (GET)', 'n8n-nodes-base.webhook', 2, { httpMethod: 'GET', path: 'flowhq-unsubscribe', responseMode: 'responseNode', options: {} }, at(0, 0), { webhookId: 'flowhq-unsubscribe-get-000000000000' }),
    code('Confirmation page', [], `
const t = String(($json.query || {}).t || '').replace(/[^a-z0-9]/g, '').slice(0, 64);
return [{ json: { html: ${JSON.stringify(page('<h2>Unsubscribe</h2><p>Click below and you will not receive further emails from FlowHQ.</p><form method="post"><input type="hidden" name="t" value="__T__"><button type="submit">Unsubscribe</button></form>'))}.replace('__T__', t) } }];
`, at(1, 0), {}),
    node('Show confirmation', 'n8n-nodes-base.respondToWebhook', 1.1, { respondWith: 'text', responseBody: '={{ $json.html }}', options: { responseHeaders: { entries: [{ name: 'content-type', value: 'text/html; charset=utf-8' }] } } }, at(2, 0)),
    node('Unsubscribe confirmed (POST)', 'n8n-nodes-base.webhook', 2, { httpMethod: 'POST', path: 'flowhq-unsubscribe', responseMode: 'responseNode', options: {} }, at(0, 1.5), { webhookId: 'flowhq-unsubscribe-post-00000000000' }),
    configNode(settings, at(1, 1.5)),
    sheet('Read Leads', 'read', 'leads', at(2, 1.5)),
    code('Find lead by token', ['inbox'], `
const req = $('Unsubscribe confirmed (POST)').first().json;
const token = String((req.body && req.body.t) || (req.query && req.query.t) || '');
const r = lib.inbox.unsubscribeByToken(token, rowsOf('Read Leads'));
return [{ json: r.ok ? { found: 'yes', update: r.update, suppress: r.suppress } : { found: 'no' } }];
`, at(3, 1.5)),
    ifNode('Token valid?', '={{ $json.found }}', 'yes', at(4, 1.5)),
    code('Lead update', [], `return [{ json: $input.first().json.update }];`, at(5, 1)),
    sheet('Mark UNSUBSCRIBED', 'update', 'leads', at(6, 1), { key: 'lead_id' }),
    code('Suppression row', [], `return [{ json: $('Find lead by token').first().json.suppress }];`, at(7, 1)),
    sheet('Add to Suppression', 'append', 'suppression', at(8, 1)),
    node('Done page', 'n8n-nodes-base.respondToWebhook', 1.1, { respondWith: 'text', responseBody: page('<h2>You have been unsubscribed</h2><p>You will not receive further emails from FlowHQ.</p>'), options: { responseHeaders: { entries: [{ name: 'content-type', value: 'text/html; charset=utf-8' }] } } }, at(9, 1.5)),
  ];
  chain(c, ['Unsubscribe link opened (GET)', 'Confirmation page', 'Show confirmation']);
  chain(c, ['Unsubscribe confirmed (POST)', 'Config', 'Read Leads', 'Find lead by token', 'Token valid?']);
  connect(c, 'Token valid?', 'Lead update', 0);
  chain(c, ['Lead update', 'Mark UNSUBSCRIBED', 'Suppression row', 'Add to Suppression', 'Done page']);
  connect(c, 'Token valid?', 'Done page', 1);
  return workflow('unsubscribe', 'FlowHQ 06 - Unsubscribe link (optional)', nodes, c,
    '## FlowHQ 06 - Unsubscribe link (optional)\nOnly needed if you set sender.unsubscribe_url_base to this workflow\'s production webhook URL (https://<your-n8n>/webhook/flowhq-unsubscribe). Without it, emails use reply-"unsubscribe" + a mailto List-Unsubscribe header, handled by workflow 05.\n\nGET shows a confirmation button (so link scanners cannot unsubscribe people); POST performs the opt-out (also used by one-click List-Unsubscribe-Post).');
}

function wfPreflight(settings) {
  const c = {};
  const sheetsCheck = HARNESS
    ? node('Read sheet headers', 'n8n-nodes-base.httpRequest', 4.2, { method: 'GET', url: `${HARNESS}/sheets/__headers`, options: {} }, at(3, 0), { onError: 'continueRegularOutput' })
    : node('Read sheet headers', 'n8n-nodes-base.httpRequest', 4.2, {
      method: 'GET',
      url: "={{ 'https://sheets.googleapis.com/v4/spreadsheets/' + $('Config').first().json.settings.spreadsheet_id + '/values:batchGet' }}",
      authentication: 'predefinedCredentialType', nodeCredentialType: 'googleSheetsOAuth2Api',
      sendQuery: true, queryParameters: { parameters: Object.keys(require('../lib/schema').TABS).map((t) => ({ name: 'ranges', value: `${t}!1:1` })) },
      options: { response: { response: { fullResponse: true, neverError: true, responseFormat: 'json' } } },
    }, at(3, 0), { credentials: CREDS.sheets, onError: 'continueRegularOutput' });
  const nodes = [
    manual(at(0, 0)), configNode(settings, at(1, 0)),
    code('Check configuration', ['config'], `return [{ json: { config_problems: lib.config.configProblems(S) } }];`, at(2, -0.5)),
    sheet('Read Settings', 'read', 'settings', at(2, 0.5)),
    sheetsCheck,
    httpGmail('Gmail profile (read-only)', 'GET', '/gmail/v1/users/me/profile', null, at(4, 0), { onError: 'continueRegularOutput' }),
    code('Preflight report', ['schema', 'config'], `
// Read-only checks. Sends nothing. Confirms the spreadsheet and OAuth actually work.
const report = { config_problems: $('Check configuration').first().json.config_problems, sheets: {}, gmail: {}, ok: true };
const sh = $('Read sheet headers').first().json;
const body = sh.body || sh;
if (sh.statusCode && sh.statusCode >= 300) { report.sheets.error = 'HTTP ' + sh.statusCode + ': ' + JSON.stringify(body).slice(0, 300); report.ok = false; }
const ranges = (body && body.valueRanges) || [];
for (const tab of Object.keys(lib.schema.TABS)) {
  const vr = ranges.find((r) => String(r.range || '').replace(/'/g, '').startsWith(tab + '!'));
  const have = vr && vr.values && vr.values[0] ? vr.values[0] : [];
  const missing = lib.schema.TABS[tab].filter((col) => !have.includes(col));
  report.sheets[tab] = !vr ? 'TAB MISSING' : missing.length ? 'missing columns: ' + missing.join(', ') : 'ok';
  if (report.sheets[tab] !== 'ok') report.ok = false;
}
const g = $('Gmail profile (read-only)').first().json;
const gb = g.body || g;
if (g.statusCode === 200 && gb.emailAddress) {
  report.gmail.authenticated_as = gb.emailAddress;
  report.gmail.matches_sender_email = String(gb.emailAddress).toLowerCase() === String(S.sender.email).toLowerCase();
  if (!report.gmail.matches_sender_email) report.gmail.note = 'sender.email differs from the authenticated account; Gmail will only use it if it is a verified send-as alias.';
} else { report.gmail.error = 'Gmail OAuth check failed: ' + JSON.stringify(gb).slice(0, 300); report.ok = false; }
if (report.config_problems.length) report.ok = false;
report.policy = lib.config.effectivePolicy(S, rowsOf('Read Settings'));
return [{ json: report }];
`, at(5, 0)),
  ];
  chain(c, ['Run manually', 'Config', 'Check configuration', 'Read Settings', 'Read sheet headers', 'Gmail profile (read-only)', 'Preflight report']);
  return workflow('preflight', 'FlowHQ 00 - Preflight check (read-only)', nodes, c,
    '## FlowHQ 00 - Preflight check\nRun this first after importing. Read-only: verifies config placeholders are filled, every spreadsheet tab and column exists, and the Gmail OAuth credential actually works (reads the profile; sends nothing).');
}

function wfError(settings) {
  const c = {};
  const nodes = [
    node('On workflow error', 'n8n-nodes-base.errorTrigger', 1, {}, at(0, 0)),
    configNode(settings, at(1, 0)),
    code('Format error', [], `
const e = $('On workflow error').first().json;
return [{ json: {
  timestamp: new Date().toISOString(),
  workflow: (e.workflow && e.workflow.name) || '',
  node: (e.execution && e.execution.lastNodeExecuted) || '',
  lead_id: '',
  error_type: 'workflow_error',
  message: String((e.execution && e.execution.error && e.execution.error.message) || 'unknown').slice(0, 1000),
  execution_id: String((e.execution && e.execution.id) || ''),
} }];
`, at(2, 0)),
    sheet('Append Error Log', 'append', 'error_log', at(3, 0)),
  ];
  chain(c, ['On workflow error', 'Config', 'Format error', 'Append Error Log']);
  return workflow('error', 'FlowHQ 99 - Error logger', nodes, c,
    '## FlowHQ 99 - Error logger\nSet as the "Error workflow" of workflows 00-06 (Settings > Error workflow). Appends failures to the Error_Log tab.');
}

// ---------------------------------------------------------------- main
function main() {
  const { deepMerge } = require('./local-pipeline');
  let settings = args.includes('--defaults') ? readJson('config/settings.default.json') : loadSettings();
  // --preset <name>: overlay config/presets/<name>.json (e.g. ollama-qwen3-4b)
  const PRESET = args.includes('--preset') ? args[args.indexOf('--preset') + 1] : (HARNESS && process.env.HARNESS_PRESET) || '';
  if (PRESET) settings = deepMerge(settings, readJson(`config/presets/${PRESET}.json`));
  if (HARNESS) {
    const presetLlm = PRESET ? Object.assign({}, settings.llm) : null;
    settings = deepMerge(settings, JSON.parse(fs.readFileSync(path.join(ROOT, 'test/n8n/harness-settings.json'), 'utf8')));
    // Keep the preset's provider; only point it at the local mock (same path, e.g. /api/chat).
    if (presetLlm) settings.llm = Object.assign(presetLlm, { endpoint: presetLlm.endpoint.replace(/^https?:\/\/[^/]+/, 'MOCK'), timeout_ms: 30000 });
    settings.llm.endpoint = settings.llm.endpoint.replace('MOCK', HARNESS);
    settings.sending.gmail_api_base = HARNESS;
    settings.fixture_base_url = settings.fixture_base_url.replace('FIXTURE', process.env.FIXTURE_URL || 'http://127.0.0.1:8787');
  }
  // With a settings.local.json (your spreadsheet ID, sender details), output goes to a git-ignored folder
  // so personal configuration is never committed. workflows/ always holds the placeholder build.
  const hasLocal = fs.existsSync(path.join(ROOT, 'config', 'settings.local.json'));
  const outDir = HARNESS ? path.join(ROOT, 'out', 'harness')
    : hasLocal && !args.includes('--defaults') ? path.join(ROOT, 'out', 'workflows-local')
      : PRESET ? path.join(ROOT, 'workflows', 'presets', PRESET) : path.join(ROOT, 'workflows');
  if (!HARNESS && hasLocal && !args.includes('--defaults')) console.log('config/settings.local.json found -> writing to out/workflows-local/ (git-ignored). Import these into n8n.');
  fs.mkdirSync(outDir, { recursive: true });
  const builders = [['00-preflight-check', wfPreflight], ['01-import-leads', wfImport], ['02-research-websites', wfResearch], ['03-generate-emails', wfGenerate],
    ['04-send-approved-emails', wfSend], ['05-inbox-monitor', wfInbox], ['06-unsubscribe-webhook', wfUnsubscribe], ['99-error-logger', wfError]];
  for (const [file, build] of builders) {
    const wf = build(settings);
    if (settings.workflow_name_suffix) wf.name += settings.workflow_name_suffix;
    fs.writeFileSync(path.join(outDir, `${file}.json`), JSON.stringify(wf, null, 2) + '\n');
    console.log(`${file}.json: ${wf.nodes.length} nodes`);
  }
}

if (require.main === module) main();
module.exports = { bundle };
