# Compliance notes: US, UK, Australia, New Zealand

> **These notes are not legal advice.** They summarise what I found while researching in October 2026, map it to the controls built into the workflows, and point to primary sources. Several of the sources were secondary summaries, and I've flagged where they conflict. Have a lawyer confirm before you enable live sending. **A publicly listed email address does not, on its own, authorise marketing email in the UK, Australia or New Zealand.**

## Summary of the rules and how the system enforces them

| | United States | United Kingdom | Australia | New Zealand |
|---|---|---|---|---|
| Law | CAN-SPAM Act and FTC rule | PECR 2003 + UK GDPR | Spam Act 2003 (ACMA) | Unsolicited Electronic Messages Act 2007 (DIA) |
| Consent for B2B cold email | Not required (opt-out regime). No B2B exemption from the other rules. | **Corporate subscribers** (Ltd, LLP, Scottish partnership, public bodies): no prior consent needed. **Sole traders and ordinary partnerships** generally need consent. | Required. **Inferred consent** may apply if the address is conspicuously published, the publication doesn't refuse marketing, and the message relates directly to the recipient's role. | Required. **Deemed consent** may apply on similar terms: a conspicuously published business address, no refusal statement, and relevance to the recipient's business role. The sender carries the burden of proof. |
| Must include | Accurate headers, a non-deceptive subject, a clear identification as an advertisement, a valid **physical postal address**, and a working opt-out | Sender identity and a valid opt-out. UK GDPR: a lawful basis (usually a documented legitimate-interests assessment) and a privacy notice. | Sender identification and a functional unsubscribe | Sender identification and a functional unsubscribe |
| Opt-out timing | Honour promptly. The commonly cited deadline is 10 business days, but I couldn't confirm that from the sources I retrieved; check the FTC guide. | Promptly | Within 5 business days | Within 5 working days |

### What the workflows enforce (`config/compliance.json` + `lib/sendgate.js`)
- **Every email:**
  - a deterministic footer with your name, FlowHQ, the website, the postal address where configured, and a reply-"unsubscribe" opt-out;
  - a `List-Unsubscribe` header, plus a one-click link if workflow 06 is enabled;
  - a plain, non-deceptive subject: `Re:`/`Fwd:`, exclamation marks, all-caps and emoji are blocked.
- **US:** the footer adds "This is a business solicitation from FlowHQ." A US send is **blocked** unless `sender.postal_address` is set and present in the footer.
- **UK:** a live send is **blocked** unless you set `legal_basis_confirmed=TRUE` on the lead. Only do that after confirming the business is a corporate subscriber, for example by checking Companies House for a Ltd or LLP, and after your legitimate-interests assessment is in place.
- **AU and NZ:** a live send is **blocked** unless research found the lead's email address published on their website (`email_published_url`, which records the page) or you set `legal_basis_confirmed=TRUE`. A human must still judge **relevance to the recipient's role** at approval. Role addresses such as `info@` or `office@` are flagged in `role_address`.
- **All countries:** if the website says it doesn't want unsolicited or marketing messages, the lead is never drafted and a live send is blocked.
- **Opt-outs:** workflow 05 processes unsubscribe replies within its 30-minute schedule, and workflow 06 handles link clicks immediately. Opted-out and bounced addresses go on the Suppression list and are never contacted again.
- **Countries outside US, GB, AU and NZ:** blocked (COUNTRY_NOT_ENABLED). To add a country, add a profile to `compliance.json` and to `countries.enabled`. India (DPDP Act) and Canada (CASL, consent-based) are not configured.

### What you still need to do
1. **UK:** write a short legitimate-interests assessment and publish a privacy notice on flowhq.in covering how you obtained business contact details. UK GDPR Article 14 requires informing people whose data you collected indirectly.
2. **Postal address:** add a real one to `sender.postal_address`. This is required for US recipients and good practice everywhere.
3. **Sources of leads:** don't use purchased lists. NZ's DIA specifically warns against them. Keep `source` filled in for every lead.
4. **Records:** keep the Leads, Send_Log and Suppression tabs. NZ and AU place the burden of proving consent on the sender, and `email_published_url` plus `evidence_url_*` are that record.

## Sources
- FTC, *CAN-SPAM Act: A Compliance Guide for Business*: https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business. The page was not reachable from my research environment; the details above come from search summaries of it.
- ACMA guidance on inferred consent, as described by secondary sources: [Mondaq: spamming and the Spam Act](https://www.mondaq.com/australia/consumer-law/996226/spamming-and-the-spam-act), [Pointon Partners: Spam Act](https://pointonpartners.com.au/spam-act/), [University of Adelaide: Spam 101](https://www.adelaide.edu.au/legalandrisk/ua/media/1832/Spam_101.pdf). One source says publication alone isn't enough to infer consent, and another says the address must be "prominently" displayed. Treat AU inferred consent conservatively.
- New Zealand: [Unsolicited Electronic Messages Act 2007](https://legislation.govt.nz/act/public/2007/7/en/latest), [DIA: spam and electronic address harvesting](https://www.dia.govt.nz/Spam-Electronic-Address-Harvesting-Software), [Scoop: UEMA checklist (2007)](https://www.scoop.co.nz/stories/BU0709/S00038.htm).
- UK PECR for B2B, secondary summaries: [Harper James: B2B marketing and GDPR](https://harperjames.co.uk/article/b2b-marketing-and-gdpr-the-basics/), [SCL: B2B communications](https://www.scl.org/10176-b2b-communications-a-welcome-ico-turnaround/). Check the ICO's current guidance on electronic mail marketing before relying on these.
- Gmail sending limits: [Google Workspace: Gmail sending limits](https://knowledge.workspace.google.com/admin/gmail/gmail-sending-limits-in-google-workspace?hl=en). Workspace allows 2,000 messages per user per day (500 for trial accounts). The often-quoted 500 per day for personal Gmail comes from third-party sources only.

## Deliverability (not legal, but it protects your domain)
- Set up SPF, DKIM and DMARC for flowhq.in before going live. Consider a separate sending subdomain or mailbox so outreach can't damage your main domain's reputation.
- Start slowly. The shipped limits are 5 emails per run and 20 per day, at least 90 seconds apart. Increase gradually only while bounces and complaints stay near zero. These limits are deliberately far below Gmail's caps; staying under spam thresholds matters more than the cap.
- Emails are plain text with no tracking pixels or tracked links.
- The bounce-rate circuit breaker trips the kill switch above 5% hard bounces.
