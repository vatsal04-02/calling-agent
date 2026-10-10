# Workflows

Every workflow starts with a **Config** node. It holds the static, non-secret configuration generated from `config/*.json`; secrets live only in n8n credentials. Code nodes carry a bundled copy of the tested `lib/` modules.

## Lead lifecycle (`outreach_status`)

```
01 Import:    VALIDATED | INVALID | DUPLICATE | SUPPRESSED | COUNTRY_NOT_ENABLED | SKIPPED_SOURCE_STATUS | MANUAL_REVIEW (country unknown)
02 Research:  VALIDATED -> RESEARCHED | MANUAL_REVIEW (blocked, robots, timeout, thin/JS site, no credible observations)
03 Generate:  RESEARCHED -> READY_FOR_APPROVAL | MANUAL_REVIEW (failed validation, no recommendation, site refuses unsolicited email)
              (temporary AI errors keep RESEARCHED; after 3 attempts -> MANUAL_REVIEW)
   Human:     approval_status: PENDING -> APPROVED | REJECTED
04 Send:      READY_FOR_APPROVAL + APPROVED -> SENDING -> SENT | TEST_SENT | RETRY_PENDING | FAILED | SEND_UNKNOWN
05 Inbox:     -> UNSUBSCRIBED | BOUNCED | REPLIED
06 Unsub:     -> UNSUBSCRIBED
```

To **reprocess** a lead (for example after fixing its website or country), set `reprocess` to `TRUE` and `outreach_status` to `VALIDATED`, or simply set `reprocess` to `TRUE` on a RESEARCHED or MANUAL_REVIEW row. Research then bypasses the cache for that lead.

## 00 Preflight check (manual, read-only)
Checks config placeholders, every tab and header (Sheets API `values:batchGet`), and Gmail OAuth (`users/me/profile`). It also reports the effective sending policy. It never writes or sends anything.

## 01 Import & validate leads (manual)
**Nodes:** Read source (read-only) → Read Leads → Read Suppression → *Prepare import* → Append to Leads.

- Maps columns through `config/field-mapping.json`. Explicit mappings win over aliases, and unknown columns are kept in `original_row_json`.
- **Emails:** lowercased, format-checked, multiple addresses in one cell rejected, system addresses (`noreply@`, `postmaster@`…) rejected, role addresses (`info@`) flagged.
- **Websites:** `https://` added if missing, tracking parameters removed, research starts at the site root. IP addresses, `localhost`, reserved domains and social or directory profiles are rejected.
- **Country:** normalised (US, GB, AU, NZ…). Only if the column is empty is it inferred from a ccTLD (`.com.au` → AU).
- **Contact names:** used only when one was actually provided. Generic entries like "Reception" or "Front Desk" are ignored, and "Dr Sarah Chen" becomes "Dr Chen".
- **Stable `lead_id`:** a hash of email, domain and business name when your sheet has no ID. Re-running the import skips rows already present.
- **Duplicates:** the same email, or (by default) another contact at the same domain, is marked DUPLICATE with `duplicate_of`.
- **Suppression:** anything on the list is marked SUPPRESSED. Source statuses like "do not contact" or "customer" are respected.

## 02 Research websites (hourly once active; batch from Settings `RESEARCH_BATCH_SIZE`)
**Nodes:** Read Settings/Leads/Cache → *Select leads* → Loop (one site at a time) → *Research website* → Update lead → Save research cache.

For each lead, inside one Code node using n8n's `helpers.httpRequest`:
1. **Cache:** if the domain was researched in the last `cache_days` (30), it reuses the result with no requests.
2. **robots.txt:** fetched first, following RFC 9309 (4xx = no rules; 5xx or unreachable = treat as disallowed). If the homepage is disallowed for `FlowHQ-ResearchBot`, nothing else is fetched.
3. **Homepage:** a 15-second timeout, an honest user agent, and HTML only. Responses are capped at 600,000 characters. Anti-bot challenge pages are detected and never bypassed.
4. **Up to 3 more pages** (4 in total), one per category: contact, booking, services, quote/pricing, FAQ, new clients. Each must be same-site and allowed by robots. Login, account, cart, file and legal pages are excluded. Requests are 1.5 seconds apart.
5. **Evidence detectors** (`lib/signals.js`) emit observations, each with the page URL and a quoted snippet:
   - `booking_by_phone_or_email`, `quote_by_phone_or_email`: quoted wording such as "call us to book".
   - `booking_not_found`: appointment-type businesses only, and only when at least 2 pages were reviewed with no booking widget, link or button.
   - `contact_form_present`, or `no_contact_form_found` (only if the contact page was reviewed).
   - `phone_primary_contact`, `opening_hours_listed`, `faq_extensive`, `pdf_intake_forms`, `many_services_listed`, `reviews_mentioned`.
   - `contact_not_on_homepage`, `no_clear_cta_homepage`.
   - `chat_widget_present`, used to avoid recommending a second chat tool.
   - `no_mobile_viewport`, which is never auto-selected and needs human confirmation.
6. **"Not found" findings** are worded as "I couldn't find…" and are suppressed entirely when the site looks JavaScript-rendered or coverage is too thin.
7. **Compliance evidence:** where the lead's email address appears on the site (`email_published_url`) and any "no unsolicited email" notice.

**Failures:** timeouts, DNS errors, 403/429, non-HTML responses, thin or JS-only sites and robots-disallowed sites go to MANUAL_REVIEW with the reason. Any unexpected exception is caught per lead, so one bad site never stops the batch.

## 03 Select opportunities & draft emails (hourly once active)
**Nodes:** Read Settings/Leads → *Plan drafts* → Loop → IF needs AI → **Call LLM** or *Template draft* → Update lead.

- **Selection is deterministic** (`lib/opportunities.js`). It scores signal confidence × service weight × industry fit using `config/service-catalogue.json`, and picks at most 2 observations and 2 services. Disabled services, excluded combinations and anything below `min_confidence` (0.6) are never chosen. If nothing qualifies, the lead goes to MANUAL_REVIEW with `no_recommendation`.
- **The AI only words the email.** It receives the selected observations, quotes and approved benefit statements, and must return structured JSON (Anthropic `output_config.format` JSON schema, or OpenAI-compatible JSON mode). It writes the subject, observation paragraph, suggestion, an optional second idea, an intro and a call to action. The prompt marks website quotes as untrusted data.
- **The greeting, signature and legal footer are deterministic**, so the model cannot invent a name or remove the opt-out.
- **Validation** (`lib/validate.js`) blocks the draft (MANUAL_REVIEW) if it finds any of the following:
  - placeholders;
  - claims about speed, SEO, rankings, accessibility, broken or outdated sites;
  - numbers, percentages, prices or revenue claims;
  - guarantees, testimonials or "our clients";
  - pretending to have called, tested or booked;
  - hype, urgency, exclamation marks or links;
  - "you don't have…" style absence claims, or "not found" observations not phrased as "I couldn't find";
  - any sentence about the website that mentions a topic outside the selected evidence;
  - mismatched evidence or service IDs, an unrequested second service, a missing company identification, an invented personal name, or wrong length.
- **AI errors:** a 429 or 5xx is retried 3 times by the node. If it still fails, the lead stays RESEARCHED for the next run, up to 3 runs. A refusal or 4xx goes to MANUAL_REVIEW. Malformed JSON is retried on the next run.
- **`llm.provider = "template"`** uses fixed, evidence-based phrasings with no AI call at all.

## Human review (in the Leads tab)
Read `email_subject` and `email_body` against `observed_issue_*`, `evidence_url_*` and `evidence_snippet_*`, then set `approval_status` to **APPROVED** or **REJECTED**. You may edit the subject or body: the send gate re-validates the final text before sending.

For **UK** leads, set `legal_basis_confirmed=TRUE` only after confirming the business is a corporate subscriber (see [COMPLIANCE.md](COMPLIANCE.md)). For **AU/NZ** leads, check that the email relates to the recipient's business role.

## 04 Send approved emails (every 30 min once active; keep inactive until go-live)
**Nodes:** Read Settings/Leads/Suppression/Send_Log → **Send gate** → (a) record block reasons, (b) Loop: Re-read Settings → *Kill-switch check* → Mark SENDING → **Gmail API send** → *Classify result* → Save result → Append Send_Log → Update Settings → Wait → next.

The **send gate** (`lib/sendgate.js`) sends a draft only if *all* of these hold:
- `SENDING_ENABLED` is true in the workflow config **and** TRUE in the Settings tab, and `KILL_SWITCH` is not TRUE. Any missing value fails closed.
- **Test mode** (default): the recipient is on `TEST_ALLOWLIST`, or the draft is redirected to `TEST_REDIRECT_TO` (which must itself be allowlisted) with a `[TEST]` subject and a banner showing the intended recipient. A lead is never emailed in test mode.
- **Live mode:** `TEST_MODE` is false in both places **and** `sending.live_approval.approved_by` and `approved_at` are filled in.
- `approval_status = APPROVED`, `factual_validation_status = PASSED`, and the status is READY_FOR_APPROVAL, or RETRY_PENDING once its retry time has passed.
- The address is valid; the email and domain are not suppressed; there is no opt-out; the address and lead were never sent before (per Send_Log); and the domain wasn't contacted in the last 180 days.
- The country is enabled and passes its compliance gate.
- The final text has no placeholders or banned content, contains the opt-out line and sender identity, and includes the postal address where required.
- The per-run limit, rolling 24-hour limit and minimum interval (90 seconds plus jitter) allow it.

**Gmail send:** a raw RFC 5322 message via `POST gmail/v1/users/me/messages/send` using the `FlowHQ Gmail` credential. It is plain text, with `Reply-To` and `List-Unsubscribe` (mailto, plus https and one-click if configured) headers and an `X-FlowHQ-Lead-Id` header. There are no tracking pixels or links. The From display name is "Your Name (FlowHQ)".

**Outcomes:**

| Result | Lead status | Notes |
|---|---|---|
| 2xx with message ID | `SENT` / `TEST_SENT` | Message and thread IDs and timestamp stored. |
| 429 / 5xx / network error | `RETRY_PENDING` | Backoff of 30, 60, then 120 minutes; `FAILED` after 3 attempts. |
| 400 invalid recipient | `FAILED` | `opt_out_status=INVALID_ADDRESS`. |
| 401 / 403 auth, or quota exceeded | back to `READY_FOR_APPROVAL` | **Trips `KILL_SWITCH`** in Settings, so the run stops before the next email. |
| Timeout (ambiguous) | `SEND_UNKNOWN` | Never retried automatically. Check Gmail's Sent folder. |

## 05 Inbox monitor (every 30 min once active; activate before going live)
Reads the last 7 days of the inbox (read-only Gmail node), skipping messages already in Inbox_Log.

- **Opt-out replies** ("unsubscribe", "remove me", "stop emailing", "not interested"…): added to Suppression, and every row with that address becomes UNSUBSCRIBED.
- **Hard bounces:** Suppression, and the lead becomes BOUNCED.
- **Genuine replies:** REPLIED, and follow-up eligibility is switched off so a human takes over.
- **Auto-replies:** ignored.
- **Hard-bounce rate above 5%** over the last live sends (minimum 20): trips the kill switch.

## 06 Unsubscribe link (optional)
**GET** shows a confirmation button, so link scanners can't unsubscribe anyone. **POST**, including RFC 8058 one-click, looks up the lead by its random `unsubscribe_token`, marks it UNSUBSCRIBED and adds it to Suppression. Unknown tokens get the same neutral page, and nothing changes.

## 99 Error logger
An Error Trigger that appends the workflow, node, message and execution ID to Error_Log. Set it as the error workflow of 00–06.

Lead-level problems (bad sites, AI errors, Gmail errors) are handled inside the workflows and never reach this logger. It catches infrastructure failures such as the Google Sheets API being unavailable. Those stop the run safely, and the next run resumes because state is per lead.

## Not built in v1
- **Automatic follow-up emails.** `follow_up_eligible` is recorded, but there is no follow-up sender. Add one only after the first wave is reviewed.
- **Per-recipient-timezone send windows.**
- **A headless browser** for JavaScript-only sites. These go to manual review instead.
