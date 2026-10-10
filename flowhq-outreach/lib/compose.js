'use strict';
// Email assembly. The greeting, signature and compliance footer are always
// deterministic, so the model can never invent a name or drop the opt-out.
const { clean, fnv1a } = require('./util');

function localeFor(country, compliance) {
  const c = compliance && compliance.countries && compliance.countries[country];
  return (c && c.language) || 'en-GB';
}

function greeting(lead) {
  const name = clean(lead.first_name);
  if (name) return `Hi ${name},`;
  const biz = clean(lead.business_name);
  if (biz && biz.length <= 40) return `Hi ${biz} team,`;
  return 'Hello,';
}

function spell(locale, gb, us) {
  return locale === 'en-US' ? us : gb;
}

function pick(list, seed) {
  return list[fnv1a(seed) % list.length];
}

// Zero-cost writer used when llm.provider = "template" (and as a reference for tests).
const OBSERVATION_TEMPLATES = {
  booking_by_phone_or_email: (s, L) => [
    `I was looking at ${L.biz}'s website and noticed that people are asked to ${s.channel} to book ("${s.quote}").`,
    `While looking at ${L.biz}'s website, I noticed that bookings are made by ${s.channel === 'get in touch' ? 'contacting the team' : s.channel} ("${s.quote}").`,
  ],
  booking_not_found: (s, L) => [
    `I was looking at ${L.biz}'s website and couldn't find an online booking option on the pages I reviewed.`,
    `While looking through ${L.biz}'s website, I didn't see a way to book online on the pages I checked.`,
  ],
  quote_by_phone_or_email: (s, L) => [
    `I was looking at ${L.biz}'s website and noticed that people are asked to ${s.channel} for a quote ("${s.quote}").`,
    `While looking at ${L.biz}'s website, I saw that people are asked to get in touch for a quote ("${s.quote}").`,
  ],
  contact_form_present: (s, L) => [
    `I was looking at ${L.biz}'s website and saw that new ${L.enquiries} come in through the ${L.enquiry} form.`,
    `While looking at ${L.biz}'s website, I noticed you take new ${L.enquiries} through a contact form.`,
  ],
  no_contact_form_found: (s, L) => [
    `I was looking at ${L.biz}'s website and couldn't find an ${L.enquiry} form; the contact page lists phone and email details instead.`,
    `While looking at ${L.biz}'s website, I didn't see an ${L.enquiry} form on the pages I reviewed, just phone and email details.`,
  ],
  phone_primary_contact: (s, L) => [
    `I was looking at ${L.biz}'s website and noticed that calling is one of the main ways to get in touch ("${s.quote}").`,
  ],
  opening_hours_listed: (s, L) => [
    `I was looking at ${L.biz}'s website and noticed your opening hours ("${s.quote}").`,
  ],
  faq_extensive: (s, L) => [
    `I was looking at ${L.biz}'s website and noticed your FAQ section covers ${s.count} common questions.`,
  ],
  pdf_intake_forms: (s, L) => [
    `I was looking at ${L.biz}'s website and noticed that client forms are provided as PDF downloads.`,
  ],
  contact_not_on_homepage: (s, L) => [
    `I was looking at ${L.biz}'s website and couldn't spot contact details or a contact link on the homepage.`,
  ],
  no_clear_cta_homepage: (s, L) => [
    `I was looking at ${L.biz}'s website and couldn't spot a clear next step, like a "Book" or "Get in touch" button, on the homepage.`,
  ],
  many_services_listed: (s, L) => [
    `I was looking at ${L.biz}'s website and noticed the wide range of services you offer.`,
  ],
  reviews_mentioned: (s, L) => [
    `I was looking at ${L.biz}'s website and noticed the customer reviews you highlight.`,
  ],
};

function quoteOf(signal) {
  const m = /\("([^"]+)"\)/.exec(signal.statement || '');
  return m ? m[1] : '';
}

function templateParts(ctx) {
  const { lead, selection, sender, locale } = ctx;
  const L = {
    biz: clean(lead.business_name) || 'your business',
    enquiry: spell(locale, 'enquiry', 'inquiry'),
    enquiries: spell(locale, 'enquiries', 'inquiries'),
  };
  const seed = lead.lead_id || lead.email;
  const [s1, s2] = selection.signals;
  const obsFor = (s) => {
    const f = OBSERVATION_TEMPLATES[s.id];
    const channel = (/asks people to (phone or email|phone|email|get in touch)/.exec(s.statement) || [])[1] || 'get in touch';
    return f ? pick(f({ quote: quoteOf(s), count: s.question_count || 'several', channel }, L), seed + s.id) : null;
  };
  let observation = obsFor(s1) || '';
  if (s2) {
    observation += ' ' + (s2.claim_type === 'not_found'
      ? s2.statement.replace(/^I /, 'I also ')
      : 'I also noticed that ' + lowerFirst(s2.statement));
  }
  const p = selection.primary_service;
  const benefits = (p.approved_benefits || []).slice(0, 2);
  const suggestion = `One idea would be ${lowerFirst(p.pitch || p.name)}. ` +
    (benefits.length ? `That way, ${benefits[0]}.${benefits[1] ? ` It can also mean ${benefits[1]}.` : ''}` : '');
  const sec = selection.secondary_service;
  const secondary = sec ? `I also had a second idea, around ${lowerFirst(sec.pitch || sec.name)}.` : '';
  const desc = clean(sender.company_description);
  const re = new RegExp('^' + clean(sender.company).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+builds\\b', 'i');
  const intro = re.test(desc) ? `I run ${sender.company}, where ${desc.replace(re, 'we build')}` : `I run ${sender.company}. ${desc}`;
  const cta = pick([
    'Would you be open to a brief conversation? I can share a couple of ideas specific to your website.',
    'Would a short call be useful? Happy to share a few tailored suggestions.',
    'If it would help, I can send over a couple of specific ideas. Would you be open to a quick chat?',
  ], seed);
  const subject = pick([`A quick idea for ${L.biz}`, `An idea for ${L.biz}'s website`, `${L.biz}: a couple of ideas`], seed + 's');
  return {
    subject: subject.length > 60 ? 'A quick idea for your website' : subject,
    observation_paragraph: observation,
    suggestion_paragraph: suggestion,
    secondary_sentence: secondary,
    intro_sentence: intro.endsWith('.') ? intro : intro + '.',
    cta_sentence: cta,
    used_signal_ids: selection.signals.map((s) => s.id),
    used_service_ids: [p.id].concat(sec ? [sec.id] : []),
  };
}

function lowerFirst(s) {
  const t = clean(s);
  if (/^[A-Z]{2,}/.test(t) || /^(AI|FAQ|CRM|SMS)\b/.test(t)) return t;
  return t.charAt(0).toLowerCase() + t.slice(1);
}

function footer(lead, sender, countryRules, opts) {
  const o = opts || {};
  const lines = ['--', `${clean(sender.name)}, ${clean(sender.company)} | ${clean(sender.website)}`];
  if (clean(sender.postal_address)) lines.push(clean(sender.postal_address));
  if (countryRules && countryRules.require_ad_disclosure) lines.push(`This is a business solicitation from ${clean(sender.company)}.`);
  if (o.published_address) lines.push('I found your email address on your website.');
  let optOut = 'If you would prefer not to hear from me again, just reply "unsubscribe" and I won\'t contact you again.';
  if (o.unsubscribe_url) optOut += ` You can also unsubscribe here: ${o.unsubscribe_url}`;
  lines.push(optOut);
  return lines.join('\n');
}

function unsubscribeUrl(lead, sender) {
  const base = clean(sender.unsubscribe_url_base);
  if (!base || !lead.unsubscribe_token) return '';
  return `${base}${base.includes('?') ? '&' : '?'}t=${encodeURIComponent(lead.unsubscribe_token)}`;
}

function assembleEmail(parts, ctx) {
  const { lead, sender, countryRules } = ctx;
  const middle = [parts.suggestion_paragraph, parts.secondary_sentence].filter(Boolean).join(' ');
  const closing = [parts.intro_sentence, parts.cta_sentence].filter(Boolean).join(' ');
  const mainText = [parts.observation_paragraph, middle, closing].filter(Boolean).join('\n\n');
  const body = [
    greeting(lead),
    mainText,
    `Best regards,\n${clean(sender.name)}\n${clean(sender.company)}`,
    footer(lead, sender, countryRules, { published_address: !!lead.email_published_url, unsubscribe_url: unsubscribeUrl(lead, sender) }),
  ].join('\n\n');
  return { subject: clean(parts.subject), body, main_text: mainText };
}

module.exports = { localeFor, greeting, templateParts, assembleEmail, footer, unsubscribeUrl, lowerFirst };
