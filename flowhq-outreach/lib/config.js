'use strict';
// Effective runtime policy = static config (in the workflow) combined with the
// "Settings" sheet tab. Every combination is the MORE RESTRICTIVE of the two,
// and a missing or unreadable Settings value fails closed.
const { clean, truthy, toInt } = require('./util');

function settingsMap(rows) {
  const map = {};
  for (const r of rows || []) {
    const k = clean(r.key || r.Key || r.setting).toUpperCase();
    if (k) map[k] = r.value !== undefined ? r.value : r.Value;
  }
  return map;
}

function listOf(v) {
  if (Array.isArray(v)) return v.map((x) => clean(x).toLowerCase()).filter(Boolean);
  return String(v || '').split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
}

function minDefined(a, b) {
  const xs = [a, b].filter((x) => Number.isFinite(x));
  return xs.length ? Math.min(...xs) : 0;
}

function effectivePolicy(settings, settingsRows) {
  const s = settings.sending || {};
  const sheet = settingsMap(settingsRows);
  const has = (k) => sheet[k] !== undefined && clean(sheet[k]) !== '';
  const killSwitch = has('KILL_SWITCH') ? truthy(sheet.KILL_SWITCH) : false;
  const sheetSending = has('SENDING_ENABLED') ? truthy(sheet.SENDING_ENABLED) : false;
  const sheetTest = has('TEST_MODE') ? truthy(sheet.TEST_MODE) : true;
  const sendingEnabled = !!s.SENDING_ENABLED && sheetSending && !killSwitch;
  const testMode = s.TEST_MODE !== false || sheetTest;
  const approval = s.live_approval || {};
  const liveApproved = !!(clean(approval.approved_by) && clean(approval.approved_at));
  const reasons = [];
  if (killSwitch) reasons.push(`KILL_SWITCH is on${has('KILL_SWITCH_REASON') ? ': ' + clean(sheet.KILL_SWITCH_REASON) : ''}`);
  if (!s.SENDING_ENABLED) reasons.push('SENDING_ENABLED=false in workflow config');
  if (!sheetSending) reasons.push('SENDING_ENABLED is not TRUE in the Settings sheet');
  if (!testMode && !liveApproved) reasons.push('live sending requested but sending.live_approval is not filled in');
  return {
    sending_enabled: sendingEnabled && (testMode || liveApproved),
    test_mode: testMode,
    live: sendingEnabled && !testMode && liveApproved,
    kill_switch: killSwitch,
    require_approval: s.REQUIRE_APPROVAL !== false || (has('REQUIRE_APPROVAL') && truthy(sheet.REQUIRE_APPROVAL)),
    max_per_run: minDefined(toInt(s.max_sends_per_run, NaN), has('MAX_SENDS_PER_RUN') ? toInt(sheet.MAX_SENDS_PER_RUN, NaN) : NaN),
    max_per_day: minDefined(toInt(s.max_sends_per_day, NaN), has('MAX_SENDS_PER_DAY') ? toInt(sheet.MAX_SENDS_PER_DAY, NaN) : NaN),
    interval_seconds: Math.max(toInt(s.send_interval_seconds, 60), has('SEND_INTERVAL_SECONDS') ? toInt(sheet.SEND_INTERVAL_SECONDS, 0) : 0),
    jitter_seconds: Math.max(0, toInt(s.send_jitter_seconds, 0)),
    test_allowlist: Array.from(new Set(listOf(s.test_allowlist).concat(has('TEST_ALLOWLIST') ? listOf(sheet.TEST_ALLOWLIST) : []))),
    test_redirect_to: clean(has('TEST_REDIRECT_TO') ? sheet.TEST_REDIRECT_TO : s.test_redirect_to).toLowerCase(),
    max_retries: toInt(s.max_retries, 3),
    retry_backoff_minutes: toInt(s.retry_backoff_minutes, 30),
    domain_cooldown_days: toInt(s.domain_cooldown_days, 180),
    blocked_reasons: reasons,
    research_batch_size: minDefined(toInt((settings.research || {}).batch_size, NaN), has('RESEARCH_BATCH_SIZE') ? toInt(sheet.RESEARCH_BATCH_SIZE, NaN) : NaN) || 10,
    generation_batch_size: minDefined(toInt((settings.generation || {}).batch_size, NaN), has('GENERATION_BATCH_SIZE') ? toInt(sheet.GENERATION_BATCH_SIZE, NaN) : NaN) || 10,
  };
}

// Problems with static config that make sending impossible.
function configProblems(settings) {
  const p = [];
  const sender = settings.sender || {};
  if (!clean(settings.spreadsheet_id) || /REPLACE_WITH/.test(settings.spreadsheet_id)) p.push('spreadsheet_id not set');
  if (!clean(sender.name) || /REPLACE_WITH/.test(sender.name)) p.push('sender.name not set');
  if (!clean(sender.email) || /REPLACE_WITH/.test(sender.email)) p.push('sender.email not set');
  if (/REPLACE_WITH/.test(sender.postal_address || '')) p.push('sender.postal_address not set (required for US recipients)');
  return p;
}

module.exports = { settingsMap, effectivePolicy, configProblems, listOf };
