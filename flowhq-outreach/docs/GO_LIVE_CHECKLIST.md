# Go-live checklist (live sending)

Live sending stays impossible until **all three** of these are true:
1. `sending.SENDING_ENABLED = true` **and** `sending.TEST_MODE = false` in the workflow config.
2. `sending.live_approval.approved_by` and `approved_at` are filled in, as a written record of your decision.
3. In the Settings tab: `SENDING_ENABLED = TRUE`, `TEST_MODE = FALSE` and `KILL_SWITCH = FALSE`.

Do not flip these until every box below is ticked.

## Before going live
- [ ] The [safe test procedure](TESTING.md#safe-test-procedure-with-your-real-setup) is complete: real research checked against the websites, drafts reviewed, test sends received, unsubscribe and kill switch tested.
- [ ] Test emails land in the **Inbox**, not Spam, at your test addresses (try a Gmail and an Outlook address).
- [ ] **SPF, DKIM and DMARC** pass for the sending domain. In Gmail, "Show original" should show `PASS` for all three.
- [ ] `sender.name`, `sender.email` and `sender.postal_address` are real values, and `sender.email` matches the Gmail credential (or a verified send-as alias).
- [ ] A privacy notice on flowhq.in explains how business contact details are obtained and used (needed for the UK; good practice everywhere).
- [ ] [COMPLIANCE.md](COMPLIANCE.md) has been read and the per-country rules accepted, with legal confirmation for the countries you'll contact.
- [ ] The service catalogue has been reviewed: every enabled service is something FlowHQ can actually deliver now.
- [ ] **05 Inbox monitor is ACTIVE**, so opt-outs and bounces are processed every 30 minutes.
- [ ] The Error workflow is set on all FlowHQ workflows, and you know where Error_Log is.
- [ ] You know how to stop everything: set Settings `KILL_SWITCH=TRUE`, or deactivate workflow 04.

## Turning it on (do these yourself)
1. Edit `config/settings.local.json`:
   ```json
   "sending": {
     "SENDING_ENABLED": true,
     "TEST_MODE": false,
     "live_approval": { "approved_by": "<your name>", "approved_at": "<YYYY-MM-DD>" }
   }
   ```
2. Run `npm run build` and re-import **04 Send** (or edit its Config node).
3. Settings tab: `TEST_MODE=FALSE`, `SENDING_ENABLED=TRUE`, `MAX_SENDS_PER_RUN=5`, `MAX_SENDS_PER_DAY=10` for the first week.
4. Approve a **small first batch (5–10)** and run **04 Send manually**. Watch the Send_Log fill in.
5. Check the next day: bounces, replies, opt-outs and spam complaints. Only then activate the 04 schedule.

## Ramp-up (suggested)
| Week | Max per day | Condition to move on |
|---|---|---|
| 1 | 10 | 0–1 bounces, no spam complaints |
| 2 | 20 | bounce rate under 2% |
| 3+ | 30–50 | keep reviewing replies; never exceed what you can follow up personally |

The shipped hard cap (`max_sends_per_day: 20` in config) still applies until you change it in the config, not just the sheet.

## Ongoing
- **Daily:** review READY_FOR_APPROVAL drafts. Approve or reject, and edit if needed; edits are re-validated.
- **Daily:** check MANUAL_REVIEW rows for fixable issues (wrong country or website), then set `reprocess=TRUE`.
- **Weekly:** check Error_Log, `SEND_UNKNOWN` rows (look in Gmail's Sent folder), and Suppression growth.
- If the kill switch trips automatically, read `KILL_SWITCH_REASON`. Typical causes: Gmail OAuth expired (reconnect the credential), the daily quota was hit, or a high bounce rate (clean the list).
- **Follow-up emails are not automated in v1.** Replies are marked REPLIED for you to handle personally.
