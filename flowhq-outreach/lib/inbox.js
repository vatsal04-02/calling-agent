'use strict';
// Classifies inbound Gmail messages so opt-outs, bounces and replies stop any
// further automated contact. Conservative: anything that looks like an opt-out
// is treated as one.
const { clean, truncate, isoNow } = require('./util');
const { STATUS } = require('./status');

const OPT_OUT_RE = /\b(unsubscribe|remove me|opt[- ]?out|stop (emailing|contacting|sending)|take me off|do not (contact|email)|don'?t (contact|email)|not interested|no thanks|please stop|leave me alone)\b/i;
const AUTO_REPLY_SUBJECT = /\b(out of (the )?office|automatic reply|auto[- ]?reply|autoreply|away from (the )?office|on leave|on holiday|vacation)\b/i;
const BOUNCE_FROM = /\b(mailer-daemon|postmaster|mail delivery (subsystem|system))\b/i;
const BOUNCE_SUBJECT = /\b(delivery status notification|undeliver(able|ed)|delivery (has )?failed|delivery failure|returned mail|failure notice|mail delivery failed|address not found|message not delivered)\b/i;
const PERMANENT_BOUNCE = /\b(5\.\d\.\d+|550|551|553|554|address not found|does not exist|no such user|user unknown|recipient (address )?rejected|mailbox unavailable|invalid recipient|account (has been )?disabled)\b/i;
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}/gi;

function headerOf(msg, name) {
  const h = msg.headers || {};
  const want = name.toLowerCase();
  if (Array.isArray(h)) {
    const found = h.find((x) => clean(x.name).toLowerCase() === want);
    return found ? clean(found.value) : '';
  }
  for (const k of Object.keys(h)) if (k.toLowerCase() === want) return clean(h[k]);
  return '';
}

function addressOf(from) {
  const m = /<([^>]+)>/.exec(from || '');
  return clean(m ? m[1] : from).toLowerCase();
}

// msg: { id, threadId, from, subject, text, headers }
function classifyMessage(msg, leadsByEmail, leadsByThread) {
  const from = clean(msg.from || headerOf(msg, 'from'));
  const fromAddr = addressOf(from);
  const subject = clean(msg.subject || headerOf(msg, 'subject'));
  const text = String(msg.text || msg.snippet || '');
  const firstLines = text.split(/\r?\n/).filter((l) => !/^\s*>/.test(l)).slice(0, 15).join('\n');

  if (BOUNCE_FROM.test(from) || BOUNCE_SUBJECT.test(subject)) {
    const failed = headerOf(msg, 'x-failed-recipients') || ((/final-recipient:\s*rfc822;\s*([^\s]+)/i.exec(text) || [])[1]) || '';
    const candidates = [failed].concat(text.match(EMAIL_RE) || []).map((e) => clean(e).toLowerCase()).filter(Boolean);
    const lead = candidates.map((e) => leadsByEmail[e]).find(Boolean) || leadsByThread[msg.threadId];
    return { type: PERMANENT_BOUNCE.test(text + ' ' + subject) ? 'hard_bounce' : 'soft_bounce', email: lead ? lead.email : candidates[0] || '', lead };
  }
  const lead = leadsByEmail[fromAddr] || leadsByThread[msg.threadId];
  if (AUTO_REPLY_SUBJECT.test(subject) || /auto-replied|auto-generated/i.test(headerOf(msg, 'auto-submitted')) || headerOf(msg, 'x-autoreply')) {
    return { type: 'auto_reply', email: fromAddr, lead };
  }
  if (OPT_OUT_RE.test(subject) || OPT_OUT_RE.test(firstLines)) return { type: 'unsubscribe', email: fromAddr, lead };
  if (lead) return { type: 'reply', email: fromAddr, lead };
  return { type: 'other', email: fromAddr, lead: null };
}

/** Build sheet writes for a batch of inbound messages. */
function processInbox(messages, leads, inboxLog, now) {
  const ts = isoNow(now);
  const done = new Set((inboxLog || []).map((r) => clean(r.message_id)));
  const byEmail = {};
  const allByEmail = {};
  const byThread = {};
  for (const l of leads || []) {
    const e = clean(l.email).toLowerCase();
    if (e) {
      (allByEmail[e] = allByEmail[e] || []).push(l);
      // Prefer the row that was actually contacted over duplicates.
      if (!byEmail[e] || (clean(byEmail[e].outreach_status) === STATUS.DUPLICATE && clean(l.outreach_status) !== STATUS.DUPLICATE)) byEmail[e] = l;
    }
    if (clean(l.provider_thread_id)) byThread[clean(l.provider_thread_id)] = l;
  }
  const sameAddress = (lead) => allByEmail[clean(lead.email).toLowerCase()] || [lead];
  const out = { suppress: [], leadUpdates: [], log: [], hardBounces: 0 };
  for (const m of messages || []) {
    if (!m || !m.id || done.has(m.id)) continue;
    const c = classifyMessage(m, byEmail, byThread);
    let action = 'none';
    if (c.type === 'unsubscribe') {
      action = 'suppressed';
      out.suppress.push({ value: c.email, type: 'email', reason: 'unsubscribe_reply', source: 'inbox', added_at: ts, lead_id: c.lead ? c.lead.lead_id : '' });
      if (c.lead) for (const l of sameAddress(c.lead)) out.leadUpdates.push({ lead_id: l.lead_id, outreach_status: STATUS.UNSUBSCRIBED, opt_out_status: 'OPTED_OUT', follow_up_eligible: 'FALSE', updated_at: ts });
    } else if (c.type === 'hard_bounce') {
      out.hardBounces++;
      action = 'suppressed';
      if (c.email) out.suppress.push({ value: c.email, type: 'email', reason: 'hard_bounce', source: 'inbox', added_at: ts, lead_id: c.lead ? c.lead.lead_id : '' });
      if (c.lead) for (const l of sameAddress(c.lead)) out.leadUpdates.push({ lead_id: l.lead_id, outreach_status: STATUS.BOUNCED, delivery_or_error_status: 'HARD_BOUNCE', follow_up_eligible: 'FALSE', updated_at: ts });
    } else if (c.type === 'reply' && c.lead) {
      action = 'marked_replied';
      out.leadUpdates.push({ lead_id: c.lead.lead_id, outreach_status: STATUS.REPLIED, follow_up_eligible: 'FALSE', updated_at: ts });
    }
    out.log.push({
      message_id: m.id, thread_id: m.threadId || '', received_at: m.date || '', from: truncate(clean(m.from), 120),
      subject: truncate(clean(m.subject), 150), classification: c.type, matched_lead_id: c.lead ? c.lead.lead_id : '', action, processed_at: ts,
    });
  }
  return out;
}

// Bounce-rate circuit breaker over recent live sends.
function bounceRateTrip(sendLog, newHardBounces, existingBouncedCount, threshold) {
  const live = (sendLog || []).filter((r) => clean(r.status) === STATUS.SENT).slice(-100);
  if (live.length < 20) return '';
  const rate = (existingBouncedCount + newHardBounces) / live.length;
  return rate > (threshold || 0.05) ? `hard bounce rate ${(rate * 100).toFixed(1)}% over last ${live.length} live sends` : '';
}

/** Unsubscribe webhook: find lead by token and produce writes. */
function unsubscribeByToken(token, leads, now) {
  const t = clean(token);
  if (!/^[a-z0-9]{16,64}$/.test(t)) return { ok: false, reason: 'invalid_token' };
  const lead = (leads || []).find((l) => clean(l.unsubscribe_token) === t);
  if (!lead) return { ok: false, reason: 'unknown_token' };
  const ts = isoNow(now);
  return {
    ok: true,
    lead_id: lead.lead_id,
    suppress: { value: clean(lead.email).toLowerCase(), type: 'email', reason: 'unsubscribe_link', source: 'webhook', added_at: ts, lead_id: lead.lead_id },
    update: { lead_id: lead.lead_id, outreach_status: STATUS.UNSUBSCRIBED, opt_out_status: 'OPTED_OUT', follow_up_eligible: 'FALSE', updated_at: ts },
  };
}

module.exports = { classifyMessage, processInbox, bounceRateTrip, unsubscribeByToken, addressOf };
