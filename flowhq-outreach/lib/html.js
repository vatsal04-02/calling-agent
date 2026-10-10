'use strict';
// Lightweight HTML extraction with regular expressions. It is deliberately
// conservative: it records what is present in the HTML that was served, and
// never tries to execute JavaScript.
const { decodeEntities, clean, uniq, truncate } = require('./util');
const { resolveUrl } = require('./url');

const BOOKING_WIDGETS = {
  calendly: /calendly\.com/i, acuity: /acuityscheduling\.com|as\.me\//i, square_appointments: /squareup\.com\/appointments|square\.site\/book|book\.squareup/i,
  setmore: /setmore\.com/i, simplybook: /simplybook\.(me|it)/i, fresha: /fresha\.com/i, mindbody: /mindbodyonline\.com|clients\.mindbodyonline/i,
  booksy: /booksy\.com/i, vagaro: /vagaro\.com/i, jane_app: /\.janeapp\.com|jane\.app/i, cliniko: /cliniko\.com/i, hotdoc: /hotdoc\.com\.au/i,
  healthengine: /healthengine\.com\.au/i, nookal: /nookal\.com/i, timely: /gettimely\.com|bookings\.gettimely/i, zocdoc: /zocdoc\.com/i,
  opentable: /opentable\.(com|co\.uk|com\.au)/i, resy: /resy\.com/i, tock: /exploretock\.com/i, housecall_pro: /housecallpro\.com/i,
  servicetitan: /servicetitan\.com/i, jobber: /getjobber\.com/i, servicem8: /servicem8\.com/i, google_appointments: /calendar\.app\.google|calendar\.google\.com\/calendar\/appointments/i,
  youcanbookme: /youcanbook\.me/i, bookwhen: /bookwhen\.com/i, appointy: /appointy\.com/i, halaxy: /halaxy\.com/i, phorest: /phorest\.com/i,
  dentally: /dentally\.co/i, nexhealth: /nexhealth\.com/i, localmed: /localmed\.com/i, zenoti: /zenoti\.com/i, boulevard: /joinblvd\.com|blvd\.co/i,
  glossgenius: /glossgenius\.com/i, healthcode: /healthcode\.co\.uk/i, doctolib: /doctolib\./i, practice_better: /practicebetter\.io/i,
};

const CHAT_WIDGETS = {
  intercom: /widget\.intercom\.io|intercomcdn/i, drift: /js\.driftt\.com|drift\.com\/include/i, tidio: /code\.tidio\.co/i,
  tawk: /embed\.tawk\.to/i, livechat: /cdn\.livechatinc\.com/i, crisp: /client\.crisp\.chat/i, zendesk: /static\.zdassets\.com|zopim/i,
  hubspot_chat: /js\.usemessages\.com|hs-scripts\.com/i, olark: /static\.olark\.com/i, freshchat: /wchat\.freshchat\.com|freshworks\.com\/live-chat/i,
  smartsupp: /smartsuppchat\.com/i, chatra: /call\.chatra\.io/i, podium: /connect\.podium\.com|podium\.com\/widget/i,
  birdeye: /birdeye\.com\/embed/i, facebook_messenger: /customerchat|connect\.facebook\.net\/[^"']*\/sdk\/xfbml\.customerchat/i,
  whatsapp: /wa\.me\/|api\.whatsapp\.com\/send/i, chatbase: /chatbase\.co/i, voiceflow: /voiceflow\.com/i,
};

const FORM_PROVIDERS = {
  hubspot_form: /js\.hsforms\.net|hsforms\.com/i, gravity_forms: /gform_wrapper|gravityforms/i, wpforms: /wpforms-form|wpforms/i,
  contact_form_7: /wpcf7/i, typeform: /typeform\.com/i, jotform: /jotform\.com/i, google_forms: /docs\.google\.com\/forms/i,
  wix_form: /wixforms|wix-forms/i, squarespace_form: /sqs-block-form|squarespace-form/i, formstack: /formstack\.com/i,
  cognito: /cognitoforms\.com/i, ninja_forms: /nf-form-cont|ninja-forms/i, elementor_form: /elementor-form/i,
};

function stripNonContent(html) {
  return String(html || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|iframe|canvas)\b[\s\S]*?<\/\1\s*>/gi, ' ');
}

function textOf(fragment) {
  return clean(decodeEntities(String(fragment || '').replace(/<[^>]+>/g, ' ')));
}

function attr(tagAttrs, name) {
  const re = new RegExp('\\b' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i');
  const m = re.exec(tagAttrs || '');
  return m ? decodeEntities(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]) : '';
}

function pageText(html) {
  const body = stripNonContent(html)
    .replace(/<head\b[\s\S]*?<\/head\s*>/i, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article|\/header|\/footer|\/nav|\/td|\/dt|\/dd)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(body)
    .split('\n')
    .map((l) => l.replace(/[ \t\f\v\u00a0]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

function extractPage(html, url, opts) {
  const options = opts || {};
  const raw = String(html || '').slice(0, options.maxChars || 600000);
  const cleaned = stripNonContent(raw);
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(raw);
  const metaDesc = /<meta\b[^>]*name\s*=\s*["']description["'][^>]*>/i.exec(raw);

  const headings = [];
  const hRe = /<(h[1-4])\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;
  let m;
  while ((m = hRe.exec(cleaned)) && headings.length < 80) {
    const t = textOf(m[2]);
    if (t) headings.push({ level: m[1].toLowerCase(), text: truncate(t, 160) });
  }

  const links = [];
  const telLinks = [];
  const mailtoLinks = [];
  const aRe = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
  while ((m = aRe.exec(cleaned)) && links.length < 400) {
    const href = attr(m[1], 'href');
    const text = truncate(textOf(m[2]) || attr(m[1], 'aria-label') || attr(m[1], 'title'), 120);
    const cls = attr(m[1], 'class');
    if (/^tel:/i.test(href)) { telLinks.push({ href: href.slice(4).trim(), text }); continue; }
    if (/^mailto:/i.test(href)) { mailtoLinks.push(href.slice(7).split('?')[0].trim().toLowerCase()); continue; }
    const abs = resolveUrl(url, href);
    if (abs) links.push({ href: abs, text, button: /\b(btn|button|cta)\b/i.test(cls) });
  }

  const buttons = [];
  const bRe = /<button\b[^>]*>([\s\S]*?)<\/button\s*>/gi;
  while ((m = bRe.exec(cleaned)) && buttons.length < 60) {
    const t = textOf(m[1]);
    if (t) buttons.push(truncate(t, 80));
  }

  const forms = [];
  const fRe = /<form\b([^>]*)>([\s\S]*?)<\/form\s*>/gi;
  while ((m = fRe.exec(cleaned)) && forms.length < 20) {
    const inner = m[2];
    const inputs = [];
    const iRe = /<(input|textarea|select)\b([^>]*)>/gi;
    let im;
    while ((im = iRe.exec(inner))) {
      const type = im[1].toLowerCase() === 'input' ? (attr(im[2], 'type') || 'text').toLowerCase() : im[1].toLowerCase();
      if (['hidden', 'submit', 'button', 'image', 'reset'].includes(type)) continue;
      inputs.push({ type, name: (attr(im[2], 'name') || attr(im[2], 'id') || attr(im[2], 'placeholder')).toLowerCase() });
    }
    const isSearch = /search/i.test(m[1]) || (inputs.length === 1 && (inputs[0].type === 'search' || /^(s|q|search)$/.test(inputs[0].name)));
    const isNewsletter = inputs.length <= 2 && inputs.some((i) => i.type === 'email') && !inputs.some((i) => i.type === 'textarea') && /newsletter|subscribe|mailchimp|mc-embedded/i.test(m[0]);
    forms.push({
      action: attr(m[1], 'action'),
      field_count: inputs.length,
      has_email: inputs.some((i) => i.type === 'email' || /email/.test(i.name)),
      has_message: inputs.some((i) => i.type === 'textarea' || /message|enquiry|inquiry|comment/.test(i.name)),
      has_file: inputs.some((i) => i.type === 'file'),
      kind: isSearch ? 'search' : isNewsletter ? 'newsletter' : 'enquiry',
    });
  }

  const detect = (table) => Object.keys(table).filter((k) => table[k].test(raw));
  const text = pageText(raw);
  const emailsInText = (text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}/gi) || []).map((e) => e.toLowerCase());
  const scriptCount = (raw.match(/<script\b/gi) || []).length;

  return {
    url,
    title: truncate(textOf(titleMatch ? titleMatch[1] : ''), 160),
    meta_description: metaDesc ? truncate(attr(metaDesc[0], 'content'), 300) : '',
    has_viewport: /<meta\b[^>]*name\s*=\s*["']viewport["']/i.test(raw),
    headings,
    links,
    buttons,
    forms,
    tel_links: telLinks,
    emails: uniq(mailtoLinks.concat(emailsInText)),
    booking_widgets: detect(BOOKING_WIDGETS),
    chat_widgets: detect(CHAT_WIDGETS),
    form_providers: detect(FORM_PROVIDERS),
    pdf_links: links.filter((l) => /\.pdf(\?|$)/i.test(l.href)),
    text,
    text_chars: text.length,
    script_count: scriptCount,
    html_chars: raw.length,
  };
}

module.exports = { extractPage, pageText, BOOKING_WIDGETS, CHAT_WIDGETS };
