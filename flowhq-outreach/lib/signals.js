'use strict';
// Evidence detectors. Each signal is a single, checkable observation tied to
// a URL and a short quote from the page. "not_found" signals are only emitted
// when coverage is good enough, and must be phrased as "I couldn't find...".
const { truncate, clean, uniq } = require('./util');

const CTA_WORDS = /\b(book|booking|call|contact|quote|estimate|enquir|inquir|get started|schedule|appointment|get in touch|request|order|shop|buy|sign up|consult|talk to|speak to|reserve|apply|join|visit us|find us)\b/i;
const BOOKING_LINK_WORDS = /\b(book|booking|appointment|schedule|reserve|reservation)s?\b/i;
const CONTACT_LINK_WORDS = /\b(contact|get in touch|enquire|enquiry|inquire|inquiry|reach us|email us|call us)\b/i;

const PHONE_BOOKING_RE = [
  /\b(?:please\s+)?(?:call|phone|ring|contact)\s+(?:us\s+)?(?:today\s+|now\s+)?(?:on\s+[\d\s()+.-]{6,20}\s*)?to\s+(?:book|make (?:an|a|your) (?:appointment|booking)|schedule|arrange (?:an|a|your) (?:appointment|visit))/i,
  /\bto\s+(?:book|make (?:an|a) (?:appointment|booking)|schedule (?:an|a) (?:appointment|visit))[^.\n]{0,40}?(?:please\s+)?(?:call|phone|ring|email)\b/i,
  /\b(?:bookings?|appointments?)\s+(?:are|can be)\s+(?:made|taken|arranged)\s+(?:by|via|over the)\s+(?:phone|telephone|email)/i,
  /\b(?:bookings?|appointments?)\s+by\s+(?:phone|telephone)\s+only\b/i,
  /\b(?:email|e-mail)\s+us\s+to\s+(?:book|make (?:an|a) (?:appointment|booking))/i,
];

const QUOTE_RE = [
  /\b(?:call|phone|ring)\s+(?:us\s+)?(?:today\s+|now\s+)?(?:on\s+[\d\s()+.-]{6,20}\s*)?for\s+(?:a|your)\s+(?:free\s+|no[- ]obligation\s+)?(?:quote|estimate)/i,
  /\b(?:email|e-mail|contact)\s+us\s+(?:today\s+)?for\s+(?:a|your)\s+(?:free\s+|no[- ]obligation\s+)?(?:quote|estimate)/i,
  /\bfor\s+(?:a|your)\s+(?:free\s+)?(?:quote|estimate),?\s+(?:please\s+)?(?:call|phone|ring|email)\b/i,
];

const HOURS_RE = /\b(?:mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\.?\s*(?:-|–|to|through|thru)\s*(?:mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\.?[:,]?\s*\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?\s*(?:-|–|to)\s*\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?/i;

const PDF_FORM_WORDS = /\b(form|intake|registration|new patient|new client|questionnaire|consent|application|medical history|health history|referral)\b/i;
const REVIEWS_RE = /\b(google reviews?|leave (?:us )?a review|read our reviews|5[- ]star reviews?|customer reviews|testimonials)\b/i;

function snippetAround(text, index, length) {
  const start = Math.max(0, index - 60);
  const end = Math.min(text.length, index + (length || 0) + 60);
  return truncate(clean((start > 0 ? '...' : '') + text.slice(start, end) + (end < text.length ? '...' : '')), 220);
}

function findInPages(pages, regexes) {
  const list = Array.isArray(regexes) ? regexes : [regexes];
  for (const p of pages) {
    for (const re of list) {
      const m = re.exec(p.text || '');
      if (m) return { url: p.url, match: clean(m[0]), snippet: snippetAround(p.text, m.index, m[0].length) };
    }
  }
  return null;
}

function channelOf(match) {
  const phone = /\b(call|phone|ring|telephone)\b/i.test(match);
  const email = /\be-?mail\b/i.test(match);
  return phone && email ? 'phone or email' : email ? 'email' : phone ? 'phone' : 'get in touch';
}

function signal(id, topic, claimType, statement, evidence, confidence, extra) {
  return Object.assign({
    id, topic, claim_type: claimType, statement,
    evidence_url: evidence.url || '', evidence_snippet: truncate(evidence.snippet || '', 240),
    confidence: Math.round(confidence * 100) / 100,
  }, extra || {});
}

/**
 * pages: extracted pages (lib/html.extractPage) each with .category;
 * pages[0] must be the homepage.
 * ctx: { industry_group, coverage: { page_count, has_contact_page, js_suspected } }
 */
function detectSignals(pages, ctx) {
  const out = [];
  if (!pages.length) return out;
  const home = pages[0];
  const cov = ctx.coverage || {};
  const canClaimAbsence = !cov.js_suspected && cov.page_count >= 2;
  const allLinks = [].concat(...pages.map((p) => p.links || []));
  const bookingWidgets = uniq([].concat(...pages.map((p) => p.booking_widgets || [])));
  const chatWidgets = uniq([].concat(...pages.map((p) => p.chat_widgets || [])));
  const formProviders = uniq([].concat(...pages.map((p) => p.form_providers || [])));
  const enquiryForms = [];
  for (const p of pages) for (const f of p.forms || []) if (f.kind === 'enquiry' && (f.has_email || f.has_message) && f.field_count >= 2) enquiryForms.push({ page: p, form: f });
  const contactPage = pages.find((p) => p.category === 'contact');

  // 1. Booking handled by phone/email
  const phoneBooking = findInPages(pages, PHONE_BOOKING_RE);
  if (phoneBooking) {
    out.push(signal('booking_by_phone_or_email', 'booking', 'observed',
      `The website asks people to ${channelOf(phoneBooking.match)} to book ("${truncate(phoneBooking.match, 90)}").`,
      phoneBooking, bookingWidgets.length ? 0.5 : 0.85));
  }

  // 2. No online booking found (appointment-based businesses only)
  const bookingLinks = allLinks.filter((l) => BOOKING_LINK_WORDS.test(l.text) || /\/(book|booking|appointments?|schedule)(\/|$|-)/i.test(l.href));
  const bookingButtons = [].concat(...pages.map((p) => (p.buttons || []).filter((b) => BOOKING_LINK_WORDS.test(b))));
  if (ctx.industry_group === 'appointment' && canClaimAbsence && !bookingWidgets.length && !bookingLinks.length && !bookingButtons.length && !phoneBooking) {
    out.push(signal('booking_not_found', 'booking', 'not_found',
      "I couldn't find an online booking option on the pages I reviewed.",
      { url: home.url, snippet: `Reviewed: ${pages.map((p) => p.url).join(', ')}` },
      cov.has_contact_page ? 0.7 : 0.6));
  }

  // 3. Quotes requested by phone/email
  const quote = findInPages(pages, QUOTE_RE);
  if (quote) {
    out.push(signal('quote_by_phone_or_email', 'quote', 'observed',
      `The website asks people to ${channelOf(quote.match)} for a quote ("${truncate(quote.match, 90)}").`,
      quote, enquiryForms.length || formProviders.length ? 0.55 : 0.8));
  }

  // 4/5. Enquiry form present / not found
  if (enquiryForms.length || formProviders.length) {
    const p = enquiryForms.length ? enquiryForms[0].page : pages.find((x) => (x.form_providers || []).length) || home;
    out.push(signal('contact_form_present', 'enquiry_form', 'observed',
      'The website has an enquiry form for people to get in touch.',
      { url: p.url, snippet: enquiryForms.length ? `Form with ${enquiryForms[0].form.field_count} fields on ${p.url}` : `Form provider: ${formProviders.join(', ')}` },
      0.65));
  } else if (canClaimAbsence && contactPage && ((contactPage.tel_links || []).length || (contactPage.emails || []).length)) {
    out.push(signal('no_contact_form_found', 'enquiry_form', 'not_found',
      "I couldn't find an enquiry form; the contact page lists phone and/or email details instead.",
      { url: contactPage.url, snippet: truncate(`Contact page lists: ${[].concat((contactPage.tel_links || []).map((t) => t.href), contactPage.emails || []).slice(0, 3).join(', ')}`, 200) },
      0.7));
  }

  // 6. Phone as a primary call to action
  const callCta = (home.tel_links || []).find((t) => /\b(call|phone|ring)\b/i.test(t.text)) ||
    ((home.tel_links || []).length && (home.buttons || []).find((b) => /\bcall (us|now|today)\b/i.test(b)) ? { text: (home.buttons || []).find((b) => /\bcall (us|now|today)\b/i.test(b)), href: home.tel_links[0].href } : null);
  if (callCta) {
    out.push(signal('phone_primary_contact', 'phone', 'observed',
      `The homepage has a prominent call link ("${truncate(callCta.text, 60)}").`,
      { url: home.url, snippet: `Link "${truncate(callCta.text, 60)}" -> tel:${callCta.href}` }, 0.6));
  }

  // 7. Opening hours
  const hours = findInPages(pages, HOURS_RE);
  if (hours) {
    out.push(signal('opening_hours_listed', 'hours', 'observed',
      `The website lists set opening hours ("${truncate(hours.match, 60)}").`, hours, 0.55));
  }

  // 8. FAQ with many questions
  for (const p of pages) {
    const isFaq = p.category === 'faq' || /faq|frequently asked/i.test(p.title + ' ' + p.headings.map((h) => h.text).join(' '));
    if (!isFaq) continue;
    const questions = uniq(p.headings.map((h) => h.text).concat((p.text || '').split('\n')).filter((t) => /\?\s*$/.test(t) && t.length > 12 && t.length < 200));
    if (questions.length >= 5) {
      out.push(signal('faq_extensive', 'faq', 'observed',
        `The website has an FAQ section answering ${questions.length} common questions.`,
        { url: p.url, snippet: truncate(questions.slice(0, 3).join(' | '), 220) }, 0.75, { question_count: questions.length }));
      break;
    }
  }

  // 9. Existing chat widget (mostly used to avoid recommending another one)
  if (chatWidgets.length) {
    out.push(signal('chat_widget_present', 'chat', 'observed',
      `The website already has a chat tool (${chatWidgets.join(', ')}).`,
      { url: home.url, snippet: `Detected chat embed: ${chatWidgets.join(', ')}` }, 0.5));
  }

  // 10. PDF intake/registration forms
  const pdfForms = [].concat(...pages.map((p) => (p.pdf_links || []).filter((l) => PDF_FORM_WORDS.test(l.text + ' ' + l.href)).map((l) => ({ page: p, link: l }))));
  if (pdfForms.length) {
    const f = pdfForms[0];
    out.push(signal('pdf_intake_forms', 'pdf_forms', 'observed',
      `Client forms are offered as PDF downloads ("${truncate(f.link.text || f.link.href, 70)}").`,
      { url: f.page.url, snippet: `PDF link "${truncate(f.link.text, 60)}" -> ${f.link.href}` }, 0.85));
  }

  // 11. Contact details not visible on the homepage
  const homeHasContact = (home.tel_links || []).length || (home.emails || []).length ||
    (home.links || []).some((l) => CONTACT_LINK_WORDS.test(l.text) || /\/contact/i.test(l.href)) ||
    (home.forms || []).some((f) => f.kind === 'enquiry') || (home.form_providers || []).length;
  if (!cov.js_suspected && home.text_chars >= 400 && !homeHasContact) {
    out.push(signal('contact_not_on_homepage', 'contact', 'not_found',
      "I couldn't spot contact details or a contact link on the homepage.",
      { url: home.url, snippet: `Homepage links checked: ${(home.links || []).length}; no tel:, mailto: or contact link found.` }, 0.6));
  }

  // 12. No clear call to action on the homepage
  const homeCtas = (home.links || []).filter((l) => CTA_WORDS.test(l.text)).length + (home.buttons || []).filter((b) => CTA_WORDS.test(b)).length + (home.tel_links || []).length;
  if (!cov.js_suspected && home.text_chars >= 400 && homeCtas === 0) {
    out.push(signal('no_clear_cta_homepage', 'cta', 'not_found',
      "I couldn't spot a clear next step (such as 'Book', 'Call' or 'Get a quote') on the homepage.",
      { url: home.url, snippet: `Homepage links/buttons reviewed: ${(home.links || []).length + (home.buttons || []).length}; none used action wording.` }, 0.55));
  }

  // 13. Many services listed
  const servicesPage = pages.find((p) => p.category === 'services');
  if (servicesPage) {
    const serviceHeadings = servicesPage.headings.filter((h) => h.level === 'h2' || h.level === 'h3').filter((h) => h.text.length < 80 && !/\?$/.test(h.text));
    if (serviceHeadings.length >= 6) {
      out.push(signal('many_services_listed', 'services', 'observed',
        `The services page lists a wide range of services (${serviceHeadings.length} headings).`,
        { url: servicesPage.url, snippet: truncate(serviceHeadings.slice(0, 5).map((h) => h.text).join(' | '), 220) }, 0.45));
    }
  }

  // 14. Reviews mentioned
  const reviews = findInPages(pages, REVIEWS_RE);
  if (reviews) out.push(signal('reviews_mentioned', 'reviews', 'observed', `The website highlights customer reviews ("${truncate(reviews.match, 50)}").`, reviews, 0.4));

  // 15. Missing mobile viewport tag (technical, needs human confirmation)
  if (!home.has_viewport && home.html_chars > 2000) {
    out.push(signal('no_mobile_viewport', 'mobile', 'observed',
      "The homepage's code doesn't include a mobile viewport setting, which usually affects how a page displays on phones.",
      { url: home.url, snippet: 'No <meta name="viewport"> tag in the homepage HTML.' }, 0.45, { requires_human_check: true }));
  }

  return out;
}

module.exports = { detectSignals, findInPages, PHONE_BOOKING_RE, QUOTE_RE, HOURS_RE };
