'use strict';
// The send gate: decides, lead by lead, whether an email may be sent now, to
// whom, and in which mode. Everything defaults to "do not send".
const { clean, truthy, toInt, isoNow, truncate, stableHash } = require('./util');
const { STATUS, APPROVAL, VALIDATION } = require('./status');
const { effectivePolicy } = require('./config');
const { suppressionIndex, isSuppressed, normalizeEmail } = require('./leads');
const { validateFinal } = require('./validate');
const { unsubscribeUrl } = require('./compose');
const { buildRawMessage } = require('./mime');

const COUNTED = new Set([STATUS.SENT, STATUS.TEST_SENT]);

function logIndex(sendLog, now, cooldownDays) {
  const t = new Date(now).getTime();
  const idx = { last24h: 0, sentEmails: new Set(), sentLeads: new Set(), testLeads: new Set(), recentDomains: new Set() };
  for (const r of sendLog || []) {
    const status = clean(r.status);
    const ts = Date.parse(r.timestamp);
    if (COUNTED.has(status) && Number.isFinite(ts) && t - ts < 86400000) idx.last24h++;
    if (status === STATUS.SENT) {
      const e = clean(r.intended_recipient).toLowerCase();
      if (e) idx.sentEmails.add(e);
      if (r.lead_id) idx.sentLeads.add(clean(r.lead_id));
      if (Number.isFinite(ts) && t - ts < cooldownDays * 86400000 && e.includes('@')) idx.recentDomains.add(e.split('@')[1]);
    }
    if (status === STATUS.TEST_SENT && r.lead_id) idx.testLeads.add(clean(r.lead_id));
  }
  return idx;
}

function complianceIssues(lead, rules) {
  const out = [];
  if (!rules) return ['no_compliance_profile_for_country'];
  if (clean(lead.no_unsolicited_notice)) out.push('website_says_no_unsolicited_messages');
  if (rules.require_legal_basis_confirmation && !truthy(lead.legal_basis_confirmed)) out.push('legal_basis_not_confirmed (set legal_basis_confirmed=TRUE after checking)');
  if (rules.require_published_address_evidence && !clean(lead.email_published_url) && !truthy(lead.legal_basis_confirmed)) {
    out.push('email_not_found_published_on_website (consent cannot be inferred)');
  }
  return out;
}

function isEligibleStatus(lead, policy, now) {
  const st = clean(lead.outreach_status);
  if (st === STATUS.READY_FOR_APPROVAL) return true;
  if (st === STATUS.TEST_SENT && policy.live) return true;
  if (st === STATUS.RETRY_PENDING) {
    const due = Date.parse(lead.next_retry_at);
    return !Number.isFinite(due) || due <= new Date(now).getTime();
  }
  return false;
}

/**
 * Returns { policy, send: [...], blocked: [{lead_id, reason}], updates: [...], summary }.
 * Only leads that passed every check appear in `send`, capped by the limits.
 */
function evaluateSendQueue(input) {
  const { leads, sendLog, suppressionRows, settings, settingsRows, compliance } = input;
  const now = isoNow(input.now);
  const policy = effectivePolicy(settings, settingsRows);
  const idx = logIndex(sendLog, now, policy.domain_cooldown_days);
  const supp = suppressionIndex(suppressionRows);
  const runId = input.runId || 'run-' + stableHash(now);
  const remainingToday = Math.max(0, policy.max_per_day - idx.last24h);
  const capacity = Math.max(0, Math.min(policy.max_per_run, remainingToday));
  const send = [];
  const blocked = [];
  const updates = [];
  const sender = settings.sender || {};

  for (const lead of leads || []) {
    if (!isEligibleStatus(lead, policy, now)) continue;
    const reasons = [];
    const email = normalizeEmail(lead.email, { allowSynthetic: !!settings.allow_synthetic_domains });
    const approval = clean(lead.approval_status).toUpperCase();
    if (policy.require_approval && approval !== APPROVAL.APPROVED) {
      if (approval === APPROVAL.REJECTED) blocked.push({ lead_id: lead.lead_id, reason: 'rejected_by_reviewer' });
      continue; // waiting for human approval: not an error
    }
    if (clean(lead.factual_validation_status) !== VALIDATION.PASSED) reasons.push('factual_validation_not_passed');
    if (!email.ok) reasons.push(`invalid_email:${email.reason}`);
    const suppressed = email.ok ? isSuppressed(supp, email.email, clean(lead.domain)) : '';
    if (suppressed) reasons.push(suppressed);
    if (clean(lead.opt_out_status)) reasons.push(`opt_out:${clean(lead.opt_out_status)}`);
    if (email.ok && idx.sentEmails.has(email.email)) reasons.push('already_contacted_this_address');
    if (idx.sentLeads.has(clean(lead.lead_id))) reasons.push('lead_already_sent');
    if (email.ok && idx.recentDomains.has(email.email.split('@')[1]) && !idx.sentLeads.has(clean(lead.lead_id))) reasons.push('domain_contacted_within_cooldown');
    const enabled = ((settings.countries && settings.countries.enabled) || []).includes(clean(lead.country));
    if (!enabled) reasons.push(`country_not_enabled:${clean(lead.country)}`);
    if (clean(lead.outreach_status) === STATUS.RETRY_PENDING && toInt(lead.retry_count, 0) >= policy.max_retries) reasons.push('retries_exhausted');

    const rules = (compliance.countries || {})[clean(lead.country)] || null;
    const legal = complianceIssues(lead, rules);
    const final = validateFinal(lead.email_subject, lead.email_body, { settings, sender, countryRules: rules });
    for (const i of final.issues.filter((x) => x.severity === 'block')) reasons.push(`final_check:${i.code}`);

    // Hard stops: these leads must not be contacted at all.
    const hard = reasons.filter((r) => /^(suppressed|email_suppressed|domain_suppressed|opt_out|already_contacted|lead_already_sent|invalid_email)/.test(r));
    if (hard.length) {
      blocked.push({ lead_id: lead.lead_id, reason: reasons.join('; ') });
      updates.push({
        lead_id: lead.lead_id,
        outreach_status: /suppressed|opt_out/.test(hard.join()) ? STATUS.SUPPRESSED : /already/.test(hard.join()) ? STATUS.DUPLICATE : STATUS.INVALID,
        status_reason: truncate(`send_gate:${hard.join(',')}`, 300),
        send_block_reason: truncate(reasons.join('; '), 500),
        updated_at: now,
      });
      continue;
    }

    let mode;
    let to;
    let banner = '';
    if (policy.live) {
      if (legal.length) reasons.push(...legal.map((l) => `compliance:${l}`));
      mode = 'LIVE';
      to = email.ok ? email.email : '';
    } else {
      mode = 'TEST';
      if (idx.testLeads.has(clean(lead.lead_id)) && !truthy(lead.reprocess)) reasons.push('already_test_sent');
      if (email.ok && policy.test_allowlist.includes(email.email)) to = email.email;
      else if (policy.test_redirect_to && policy.test_allowlist.includes(policy.test_redirect_to)) {
        to = policy.test_redirect_to;
        banner = [
          '[TEST MODE: this copy was NOT sent to the lead]',
          `Intended recipient: ${email.ok ? email.email : lead.email}`,
          `Lead: ${lead.lead_id} / ${lead.business_name} / ${lead.country}`,
          `Live-mode compliance check: ${legal.length ? 'WOULD BE BLOCKED - ' + legal.join('; ') : 'ok'}`,
          '------------------------------------------------------------',
          '',
        ].join('\n');
      } else reasons.push('test_mode_recipient_not_on_allowlist');
    }
    if (reasons.length) {
      blocked.push({ lead_id: lead.lead_id, reason: reasons.join('; ') });
      updates.push({ lead_id: lead.lead_id, send_block_reason: truncate(reasons.join('; '), 500), updated_at: now });
      continue;
    }
    if (send.length >= capacity) {
      blocked.push({ lead_id: lead.lead_id, reason: capacity === 0 ? 'daily_limit_reached' : 'per_run_limit_reached' });
      continue;
    }
    const subject = (mode === 'TEST' && banner ? '[TEST] ' : '') + clean(lead.email_subject);
    const body = banner + String(lead.email_body || '');
    const unsubLink = unsubscribeUrl(lead, sender);
    const mailto = clean(sender.unsubscribe_mailto) || clean(sender.reply_to) || clean(sender.email);
    const raw = buildRawMessage({
      fromName: `${clean(sender.name)} (${clean(sender.company)})`,
      fromEmail: clean(sender.email),
      to,
      replyTo: clean(sender.reply_to),
      subject,
      body,
      listUnsubscribe: [mailto ? `mailto:${mailto}?subject=unsubscribe` : '', unsubLink],
      oneClick: !!unsubLink,
      extraHeaders: { 'X-FlowHQ-Lead-Id': lead.lead_id },
    });
    send.push({
      lead_id: lead.lead_id, mode, to, intended_to: email.email, subject, run_id: runId,
      business_name: lead.business_name, retry_count: toInt(lead.retry_count, 0), raw,
    });
    updates.push({
      lead_id: lead.lead_id,
      // Dry run: say plainly why an approved, eligible draft was not sent.
      send_block_reason: policy.sending_enabled ? '' : truncate(`NOT SENT - sending is off (${policy.blocked_reasons.join('; ')}). Would send in ${mode} mode to ${to}.`, 500),
      updated_at: now,
    });
  }

  return {
    policy,
    send: policy.sending_enabled ? send : [],
    would_send: policy.sending_enabled ? [] : send.map((s) => ({ lead_id: s.lead_id, mode: s.mode, to: s.to })),
    blocked,
    updates,
    summary: {
      run_id: runId,
      sending_enabled: policy.sending_enabled,
      mode: policy.live ? 'LIVE' : 'TEST',
      blocked_reasons: policy.blocked_reasons,
      sent_last_24h: idx.last24h,
      capacity,
      queued: policy.sending_enabled ? send.length : 0,
      would_send: policy.sending_enabled ? 0 : send.length,
      blocked: blocked.length,
    },
  };
}

// Classify the Gmail API HTTP result (fullResponse + neverError, or n8n error item).
function classifySendResult(item) {
  const j = item || {};
  if (j.error) {
    const msg = clean(typeof j.error === 'string' ? j.error : j.error.message || JSON.stringify(j.error));
    if (/timeout|timed out|ETIMEDOUT|ESOCKETTIMEDOUT|socket hang up|ECONNRESET/i.test(msg)) return { outcome: 'unknown', http_status: 0, error: truncate(msg, 300) };
    return { outcome: 'temporary', http_status: 0, error: truncate(msg, 300) };
  }
  const status = Number(j.statusCode || 0);
  let body = j.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { /* keep string */ } }
  const text = typeof body === 'string' ? body : JSON.stringify(body || {});
  if (status >= 200 && status < 300 && body && body.id) return { outcome: 'sent', http_status: status, message_id: body.id, thread_id: body.threadId || '' };
  const err = truncate(text, 300);
  if (/dailyLimitExceeded|quotaExceeded|Daily user sending limit|sending limit exceeded/i.test(text)) return { outcome: 'quota', http_status: status, error: err };
  if (status === 401) return { outcome: 'auth', http_status: status, error: err };
  if (status === 403) return /rateLimitExceeded|userRateLimitExceeded/i.test(text) ? { outcome: 'temporary', http_status: status, error: err } : { outcome: 'auth', http_status: status, error: err };
  if (status === 429 || status >= 500) return { outcome: 'temporary', http_status: status, error: err };
  if (status === 400) return { outcome: 'permanent', http_status: status, error: err, invalid_recipient: /invalid to header|invalid recipient|recipient address|invalid_argument.*to/i.test(text) };
  if (status >= 200 && status < 300) return { outcome: 'unknown', http_status: status, error: 'no message id in response' };
  return { outcome: 'permanent', http_status: status, error: err };
}

/** Lead update + log row + side effects for one send attempt. */
function recordSendResult(sendItem, result, settings, now) {
  const ts = isoNow(now);
  const s = settings.sending || {};
  const maxRetries = toInt(s.max_retries, 3);
  const backoff = toInt(s.retry_backoff_minutes, 30);
  const update = { lead_id: sendItem.lead_id, updated_at: ts, send_mode: sendItem.mode, sent_to: sendItem.to };
  const out = { update, log: null, suppress: null, trip_kill_switch: '' };
  const log = {
    log_id: `${sendItem.lead_id}-${Date.parse(ts)}`, timestamp: ts, run_id: sendItem.run_id, lead_id: sendItem.lead_id, mode: sendItem.mode,
    intended_recipient: sendItem.intended_to, actual_recipient: sendItem.to, subject: sendItem.subject,
    http_status: result.http_status || '', provider_message_id: result.message_id || '', thread_id: result.thread_id || '',
    // Never name a sheet column 'error': n8n treats any item with a truthy-ish json.error as a failed node run and retries it.
    error_message: result.error || '',
  };
  if (result.outcome === 'sent') {
    const st = sendItem.mode === 'LIVE' ? STATUS.SENT : STATUS.TEST_SENT;
    Object.assign(update, {
      outreach_status: st, sending_timestamp: ts, provider_message_id: result.message_id, provider_thread_id: result.thread_id,
      delivery_or_error_status: 'ACCEPTED_BY_GMAIL', last_error: '', follow_up_eligible: sendItem.mode === 'LIVE' ? 'TRUE' : '', next_retry_at: '',
    });
    log.status = st;
  } else if (result.outcome === 'temporary') {
    const n = sendItem.retry_count + 1;
    const exhausted = n > maxRetries;
    Object.assign(update, {
      outreach_status: exhausted ? STATUS.FAILED : STATUS.RETRY_PENDING, retry_count: n,
      next_retry_at: exhausted ? '' : new Date(Date.parse(ts) + backoff * 60000 * Math.pow(2, n - 1)).toISOString(),
      delivery_or_error_status: exhausted ? 'FAILED_AFTER_RETRIES' : 'TEMPORARY_FAILURE', last_error: result.error,
    });
    log.status = exhausted ? STATUS.FAILED : STATUS.RETRY_PENDING;
  } else if (result.outcome === 'permanent' && sendItem.to !== sendItem.intended_to) {
    // A test copy to a redirect inbox failed: says nothing about the lead's own address.
    Object.assign(update, { outreach_status: STATUS.READY_FOR_APPROVAL, delivery_or_error_status: 'TEST_COPY_FAILED', last_error: result.error });
    log.status = 'TEST_COPY_FAILED';
  } else if (result.outcome === 'permanent') {
    Object.assign(update, { outreach_status: STATUS.FAILED, delivery_or_error_status: 'PERMANENT_FAILURE', last_error: result.error, follow_up_eligible: 'FALSE' });
    log.status = STATUS.FAILED;
    if (result.invalid_recipient) out.suppress = { value: sendItem.intended_to, type: 'email', reason: 'gmail_rejected_address', source: 'send', added_at: ts, lead_id: sendItem.lead_id };
  } else if (result.outcome === 'auth' || result.outcome === 'quota') {
    // Nothing was sent: put the lead back in the queue and stop the run.
    Object.assign(update, { outreach_status: STATUS.READY_FOR_APPROVAL, delivery_or_error_status: `NOT_SENT_${result.outcome.toUpperCase()}`, last_error: result.error });
    log.status = `NOT_SENT_${result.outcome.toUpperCase()}`;
    out.trip_kill_switch = `${result.outcome} error from Gmail at ${ts}: ${truncate(result.error, 150)}`;
  } else {
    Object.assign(update, { outreach_status: STATUS.SEND_UNKNOWN, delivery_or_error_status: 'UNKNOWN_CHECK_GMAIL_SENT_FOLDER', last_error: result.error, follow_up_eligible: 'FALSE' });
    log.status = STATUS.SEND_UNKNOWN;
  }
  out.log = log;
  return out;
}

// Re-evaluated before every single send so the kill switch takes effect mid-run.
function recheckBeforeSend(settings, settingsRows) {
  const policy = effectivePolicy(settings, settingsRows);
  return { ok: policy.sending_enabled, reasons: policy.blocked_reasons, policy };
}

module.exports = { evaluateSendQueue, classifySendResult, recordSendResult, recheckBeforeSend, complianceIssues };
