'use strict';
// Deterministic draft validation. Any "block" issue keeps the email out of the
// approval queue. It checks that website claims are grounded in the selected
// evidence, and that no unsupported, risky or placeholder content slipped in.
const { clean } = require('./util');
const { VALIDATION } = require('./status');

const PLACEHOLDER_RE = /\[[^\]\n]{1,40}\]|\{\{|\}\}|\{[A-Za-z_ ]{2,30}\}|<[A-Za-z_ ]{2,30}>|\b(TODO|TBD|PLACEHOLDER|lorem ipsum)\b|REPLACE_WITH|\b(first name|business name|company name|your name|recipient name)\b/i;

const BANNED = [
  ['guarantee', /\bguarantee(d|s)?\b/i],
  ['numeric_claim', /\d+\s?%|\b\d+\s?x\b|\b(double|triple|halve)\b/i],
  ['money', /[$£€]\s?\d|\b\d+\s?(dollars|pounds|usd|aud|nzd|gbp|euros?)\b/i],
  ['revenue_or_loss_claim', /\b(increase|boost|grow|skyrocket|maximi[sz]e|improve)\s+(your\s+)?(revenue|sales|profits?|conversions?|conversion rate|roi)\b|\b(losing|lose|lost|missing out on|leaving)\s+(\w+\s)?(customers|clients|patients|leads|revenue|money|sales|business|bookings)\b/i],
  ['unsupported_quality_claim', /\b(slow|loading (speed|times?)|load times?|seo|search rankings?|rank(s|ing)? (higher|on google)|google rankings?|accessib(le|ility)|ada complian\w*|wcag|broken|outdated|old[- ]fashioned|poorly (designed|built|optimi[sz]ed)|not optimi[sz]ed|bad (design|website)|confusing)\b/i],
  ['social_proof', /\b(testimonials? from|case stud(y|ies)|our clients|clients like you|businesses like yours (have|saw|see)|we('ve| have) helped|trusted by|award[- ]winning|hundreds of|thousands of)\b/i],
  ['pretended_testing', /\b(I|we) (tested|tried (to|booking|calling)|called|rang|phoned|submitted|filled (in|out)|mystery[- ]shopp\w*|visited your (clinic|office|store|shop|premises))\b/i],
  ['hype_or_urgency', /\b(act now|limited time|urgent(ly)?|don'?t miss|last chance|revolutioni[sz]\w*|game[- ]?chang\w*|cutting[- ]edge|state[- ]of[- ]the[- ]art|supercharg\w*|unlock|skyrocket\w*|next[- ]level|seamless(ly)?|synerg\w*|transform your business|world[- ]class|best[- ]in[- ]class)\b/i],
  ['spam_phrase', /\b(click here|risk[- ]free|buy now|winner|congratulations|100% free|free trial)\b|!!|!/i],
  ['absolute_absence_claim', /\b(you|your (website|site|homepage|business|team|clinic|practice|company)) (don'?t|do not|doesn'?t|does not) (have|offer|provide|use)\b|\bthere (is|'s) no\b|\b(lacks?|lacking)\b|\bmissing\b|\bno (online )?(booking|form|chat|faq|contact)/i],
  ['ai_meta_text', /\b(as an ai|language model|i cannot (help|assist)|i'?m sorry, but)\b/i],
  ['link_in_text', /https?:\/\/|\bwww\./i],
];

const TOPIC_RE = {
  booking: /\b(book(ing|ings|ed)?|appointments?|schedul\w*|reservations?)\b/i,
  quote: /\b(quotes?|quoting|estimates?)\b/i,
  enquiry_form: /\b(enquiry|inquiry|contact|quote|booking|web(site)?|online) forms?\b/i,
  contact: /\b(contact (details|information|info|link|page|options)|phone number|email address)\b/i,
  phone: /\b(phone (number|line|calls?)|missed calls?|inbound calls?|answer(ing)? (the )?(phone|calls)|call link|calling)\b/i,
  hours: /\b(opening hours|business hours|office hours|after[- ]hours|outside (of )?(your )?(opening|business|office) hours|weekends?|evenings?)\b/i,
  faq: /\b(faqs?|frequently asked)\b/i,
  chat: /\b(live chat|chat (widget|tool)|chatbot)\b/i,
  pdf_forms: /\b(pdfs?|paper forms?|printable|download(able|ed)? forms?)\b/i,
  cta: /\b(call to action|next step|button)\b/i,
  services: /\b(range of services|services you offer|services page)\b/i,
  reviews: /\breviews?\b/i,
  mobile: /\b(mobile|smartphones?|viewport)\b/i,
};
const RELATED = {
  booking: ['phone', 'hours', 'contact'], quote: ['phone', 'contact', 'enquiry_form'], enquiry_form: ['contact', 'phone'],
  contact: ['phone', 'enquiry_form'], phone: ['contact', 'hours'], hours: ['phone'], cta: ['contact', 'booking'],
  faq: [], chat: [], pdf_forms: [], services: [], reviews: [], mobile: [],
};
const CLAIM_SENTENCE_RE = /\b(your (website|site|homepage|contact page|services page|faq|page)|on (your|the) (website|site|homepage|pages)|(I|we) (noticed|saw|spotted|couldn'?t|could not|didn'?t|did not|was looking|were looking|also noticed)|it (looks|seems) like|you (currently )?(use|have|offer|list|ask|take))\b/i;
const NOT_FOUND_PHRASE = /\b(couldn'?t|could not|didn'?t|did not|wasn'?t able to|was not able to|unable to) (find|see|spot|locate)\b/i;

function words(s) {
  return clean(s).split(/\s+/).filter(Boolean).length;
}

function sentences(text) {
  return String(text || '').split(/(?<=[.?!])\s+(?=[A-Z"'(])/).map((s) => s.trim()).filter(Boolean);
}

function topicsIn(sentence) {
  return Object.keys(TOPIC_RE).filter((t) => TOPIC_RE[t].test(sentence));
}

function issue(list, code, severity, detail) {
  list.push({ code, severity, detail: String(detail || '').slice(0, 200) });
}

function checkText(issues, label, text) {
  if (PLACEHOLDER_RE.test(text)) issues.push({ code: 'placeholder', severity: 'block', detail: `${label}: ${(PLACEHOLDER_RE.exec(text) || [''])[0]}` });
  for (const [code, re] of BANNED) {
    const m = re.exec(text);
    if (m) issue(issues, code, 'block', `${label}: "${m[0]}"`);
  }
}

function checkSubject(issues, subject, maxChars) {
  const s = clean(subject);
  if (!s) return issue(issues, 'subject_missing', 'block');
  if (s.length > (maxChars || 60)) issue(issues, 'subject_too_long', 'block', `${s.length} chars`);
  if (/^(re|fw|fwd)\s*:/i.test(s)) issue(issues, 'subject_deceptive_prefix', 'block', s);
  if (/[!?]{2,}|!/.test(s)) issue(issues, 'subject_exclamation', 'block', s);
  if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(s)) issue(issues, 'subject_emoji', 'block', s);
  const caps = (s.match(/\b[A-Z]{4,}\b/g) || []).filter((w) => !['FAQ', 'FLOWHQ'].includes(w));
  if (caps.length) issue(issues, 'subject_all_caps', 'block', caps.join(' '));
  checkText(issues, 'subject', s);
}

/**
 * Validate model-written parts against the selection that produced them.
 * ctx: { lead, selection, settings, locale, companyName }
 */
function validateDraft(parts, ctx) {
  const issues = [];
  const gen = ctx.settings.generation || {};
  const selectedSignalIds = ctx.selection.signals.map((s) => s.id);
  const selectedServiceIds = [ctx.selection.primary_service.id].concat(ctx.selection.secondary_service ? [ctx.selection.secondary_service.id] : []);
  const topics = new Set(ctx.selection.signals.map((s) => s.topic));
  const allowedTopics = new Set();
  for (const t of topics) { allowedTopics.add(t); for (const r of RELATED[t] || []) allowedTopics.add(r); }

  for (const k of ['observation_paragraph', 'suggestion_paragraph', 'intro_sentence', 'cta_sentence']) {
    if (!clean(parts[k])) issue(issues, 'missing_part', 'block', k);
  }
  checkSubject(issues, parts.subject, gen.subject_max_chars);
  const textParts = ['observation_paragraph', 'suggestion_paragraph', 'secondary_sentence', 'intro_sentence', 'cta_sentence'];
  for (const k of textParts) {
    const t = parts[k] || '';
    checkText(issues, k, t);
    if (/^\s*(hi|hello|dear|hey)\b/i.test(t)) issue(issues, 'greeting_in_part', 'block', k);
    if (/\b(best regards|kind regards|cheers|sincerely|thanks,)\s*$/i.test(t)) issue(issues, 'signoff_in_part', 'block', k);
  }

  const mainWords = textParts.reduce((n, k) => n + words(parts[k]), 0);
  if (mainWords < (gen.body_min_words || 60)) issue(issues, 'too_short', 'block', `${mainWords} words`);
  if (mainWords > (gen.body_max_words || 170)) issue(issues, 'too_long', 'block', `${mainWords} words`);

  // Every claim sentence must be about a selected observation's topic.
  const claimText = [parts.observation_paragraph, parts.suggestion_paragraph, parts.secondary_sentence].join(' ');
  let groundedClaims = 0;
  for (const s of sentences(claimText)) {
    if (!CLAIM_SENTENCE_RE.test(s)) continue;
    const found = topicsIn(s);
    const foreign = found.filter((t) => !allowedTopics.has(t));
    if (foreign.length) issue(issues, 'ungrounded_claim', 'block', `${foreign.join(',')} in: ${s}`);
    if (found.some((t) => topics.has(t))) groundedClaims++;
  }
  if (!groundedClaims) issue(issues, 'observation_not_grounded', 'block', 'no sentence references a selected observation');

  for (const sig of ctx.selection.signals) {
    if (sig.claim_type === 'not_found' && !NOT_FOUND_PHRASE.test(parts.observation_paragraph || '')) {
      issue(issues, 'not_found_phrasing', 'block', `${sig.id} must be phrased as "I couldn't find..."`);
    }
  }

  const usedSignals = parts.used_signal_ids || [];
  const usedServices = parts.used_service_ids || [];
  if (!usedSignals.length || usedSignals.some((id) => !selectedSignalIds.includes(id))) issue(issues, 'signal_ids_mismatch', 'block', usedSignals.join(','));
  if (!usedServices.includes(selectedServiceIds[0]) || usedServices.some((id) => !selectedServiceIds.includes(id))) issue(issues, 'service_ids_mismatch', 'block', usedServices.join(','));
  if (!ctx.selection.secondary_service && clean(parts.secondary_sentence)) issue(issues, 'unrequested_secondary_service', 'block', parts.secondary_sentence);

  const company = ctx.companyName || 'FlowHQ';
  if (!new RegExp(company, 'i').test(parts.intro_sentence || '')) issue(issues, 'sender_not_identified', 'block', 'intro must name the company');

  if (!clean(ctx.lead.first_name) && /\b(Dr|Mr|Mrs|Ms|Miss|Prof)\.? [A-Z][a-z]+/.test(textParts.map((k) => parts[k]).join(' '))) {
    issue(issues, 'invented_name', 'block', 'a personal name appears but no contact name was provided');
  }

  const all = textParts.map((k) => parts[k] || '').join(' ');
  if (ctx.locale === 'en-US' && /\b(enquir\w*|organis\w*|colour)\b/i.test(all)) issue(issues, 'spelling_locale', 'warn', 'British spelling in a US email');
  if (ctx.locale !== 'en-US' && /\b(organiz\w*|color)\b/i.test(all)) issue(issues, 'spelling_locale', 'warn', 'American spelling in a non-US email');

  const blocked = issues.filter((i) => i.severity === 'block');
  return { status: blocked.length ? VALIDATION.FAILED : VALIDATION.PASSED, issues, main_words: mainWords };
}

/**
 * Re-check the final (possibly human-edited) subject and body right before
 * sending. Lighter than validateDraft because the reviewer may rephrase.
 */
function validateFinal(subject, body, ctx) {
  const issues = [];
  checkSubject(issues, subject, (ctx.settings.generation || {}).subject_max_chars);
  const b = String(body || '');
  const footerAt = b.lastIndexOf('\n--\n');
  const main = footerAt >= 0 ? b.slice(0, footerAt) : b;
  const foot = footerAt >= 0 ? b.slice(footerAt) : '';
  if (PLACEHOLDER_RE.test(b)) issue(issues, 'placeholder', 'block', (PLACEHOLDER_RE.exec(b) || [''])[0]);
  for (const [code, re] of BANNED) {
    if (code === 'link_in_text' || code === 'spam_phrase') continue;
    const m = re.exec(main);
    if (m) issue(issues, code, 'block', `"${m[0]}"`);
  }
  if (/!/.test(main)) issue(issues, 'exclamation', 'block');
  if (!foot) issue(issues, 'footer_missing', 'block');
  if (!/unsubscribe/i.test(foot)) issue(issues, 'opt_out_missing', 'block');
  const sender = ctx.sender || {};
  if (!clean(sender.name) || /REPLACE_WITH/.test(sender.name) || !foot.includes(clean(sender.name))) issue(issues, 'sender_identity_missing', 'block');
  if (ctx.countryRules && ctx.countryRules.require_postal_address) {
    const addr = clean(sender.postal_address);
    if (!addr || /REPLACE_WITH/.test(addr) || !foot.includes(addr)) issue(issues, 'postal_address_missing', 'block');
  }
  if (words(main) > 260) issue(issues, 'too_long', 'block', `${words(main)} words`);
  const blocked = issues.filter((i) => i.severity === 'block');
  return { status: blocked.length ? VALIDATION.FAILED : VALIDATION.PASSED, issues };
}

module.exports = { validateDraft, validateFinal, PLACEHOLDER_RE, sentences, topicsIn };
