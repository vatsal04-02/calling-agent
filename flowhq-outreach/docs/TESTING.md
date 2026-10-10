# Testing: results, evidence and known limitations

## What was verified, and how

| Layer | How | Result |
|---|---|---|
| Core logic (`lib/`) | `npm test`: 50 tests with Node's test runner, including live HTTP against a local fixture web server | **50/50 pass** |
| End-to-end, offline | `test/e2e.test.js`: the full pipeline on 18 synthetic leads with **mock** LLM and **mock** Gmail | pass |
| **Inside real n8n 2.41.6** | `scripts/n8n-harness.js`: the generated workflows imported into a fresh n8n 2.41.6 and executed with `n8n execute` and `n8n start` (webhooks). Google Sheets, Gmail and the LLM are replaced by **local mocks**; websites come from the fixture server. | **28/28 checks pass** |
| Production workflow import | `workflows/*.json` (real Google Sheets, Gmail and Anthropic nodes) imported into a clean n8n 2.41.6 | all 8 import |

### Not verified (needs your real accounts; see the procedure below)
- **Google Sheets node:** reading and writing your real spreadsheet, auto-mapping columns, RAW cell format. The node parameters were taken from the installed n8n 2.41.6 node source but never executed against Google.
- **Gmail:** OAuth, real sending with `users.messages.send`, the `getAll` inbox read, real bounce message formats, and how Gmail handles the From display name and Reply-To.
- **Real AI model output:** the quality, JSON-schema compliance and validation pass rate of a real model's drafts. The mock LLM only exercised the plumbing. No API calls were made and no money was spent.
- **Real websites:** detectors were tested on synthetic fixture sites, not the variety of real business sites.
- **The Error Trigger workflow (99):** n8n fires it only for non-manual executions, so it couldn't be triggered from the CLI.
- **Google's preflight `values:batchGet` call.**

## Required test cases → evidence

| # | Required case | Where it's tested | Outcome |
|---|---|---|---|
| 1 | Normal business website | e2e, research, harness "normal site researched…" | Evidence with URLs and quotes → validated draft → READY_FOR_APPROVAL |
| 2 | No named contact | leads, generate, e2e (`Harbour Plumbing`) | Greeting "Hi Harbour Plumbing team,"; never an invented name |
| 3 | Multiple services | research (`Kiwi Physio`: 8 services, FAQ, booking widget) | At most 2 observations and 2 services; existing booking means no booking claims |
| 4 | Inaccessible website | research, harness (`Greenleaf`: HTTP 403) | MANUAL_REVIEW, `website_access_status=BLOCKED`, no findings |
| 5 | Very little content | research, harness (`Tiny Bakes`; `Serenity` is JS-only) | MANUAL_REVIEW (`INSUFFICIENT_CONTENT` / `JS_RENDERED_SUSPECTED`) |
| 6 | Clearly observed opportunity | sample drafts (`Bright Smile`: "Please call us to book" + PDF forms) | Quoted evidence → online booking recommendation |
| 7 | Invalid email | leads, e2e (`Bad Email Co`) | INVALID, never researched |
| 8 | Duplicate lead | leads, e2e, harness (row 8 duplicates row 1) | DUPLICATE with `duplicate_of`; opt-outs apply to every row with the address |
| 9 | Opted-out recipient | leads, send, e2e (`Coastal Vets` on Suppression) | SUPPRESSED at import; the gate also blocks suppressed emails and domains |
| 10 | No credible recommendation | generate, harness (`Northside Florist`: only a chat widget) | MANUAL_REVIEW `no_recommendation`, **no AI call** |
| 11 | AI response with unsupported claims | generate, harness (mock returns "slow… losing 30%… guaranteed… our clients") | FAILED validation with 7 blocking issues → MANUAL_REVIEW |
| 12 | Temporary provider failure | generate (LLM 529), harness (LLM 529 retried by node; Gmail 503 → RETRY_PENDING with backoff) | Retried; nothing lost; no duplicate |
| 13 | Repeated workflow execution | leads, e2e, harness (import ×2, send ×3, inbox ×2) | No new rows, no refetch, no extra AI calls, no lead emailed twice |

Additional cases covered:
- robots.txt disallow: only `/robots.txt` was ever requested from that site.
- A site that refuses unsolicited email is never drafted.
- Gmail 401 trips the kill switch mid-run, so the second email is never attempted.
- Kill switch on: nothing attempted.
- Per-run and daily caps.
- Test mode never emails a lead.
- Live mode impossible without the approval record.
- Per-country compliance gates.
- Human edits re-validated at send time.
- MIME header-injection guard.
- Unsubscribe GET/POST and bogus tokens.
- Bounce-rate circuit breaker.
- Email addresses redacted from AI input.

## Bugs found and fixed by running in real n8n (the reason the harness exists)
1. **Triple logging on every send.** n8n's retry logic treats any output item with an `error` field as failed, even an empty string. The Send_Log row had an empty `error` column, so every append would have been retried and written three times. The column is now `error_message`, with a regression test.
2. A Code-node prelude referenced the Config node from a branch that has no Config node, which broke the unsubscribe page.
3. n8n's Code sandbox has no global `URL` or `crypto` and stubs `Object.defineProperty`. The library avoids all three, and this was confirmed by running in the task runner.

Found by the unit tests: links inside `<script>` strings were treated as page links; the placeholder regex missed `REPLACE_WITH_…`; opt-outs were applied to a duplicate row instead of the contacted one; a failed *test copy* wrongly marked the lead's own address invalid.

## Re-running the evidence yourself
```bash
npm test                                         # Node >= 20
# n8n harness: needs Node >= 24 and n8n 2.41.6 in a scratch folder (never your real instance)
npm i --prefix /tmp/n8n-h n8n@2.41.6
N8N_BIN=/tmp/n8n-h/node_modules/.bin/n8n N8N_USER_FOLDER=/tmp/n8n-h/data npm run harness
```

## Safe test procedure (with your real setup)

**Stage A: dry run, no email at all**
1. Complete [SETUP.md](SETUP.md) and get a clean **00 Preflight** report.
2. Put **10–20 real leads** in Leads_Source. Start with businesses you are comfortable contacting, ideally in one country.
3. Run **01 Import**. Check `outreach_status`, `status_reason` and the column mapping.
4. Run **02 Research**. Open `pages_reviewed`, `observed_issue_*`, `evidence_url_*` and `evidence_snippet_*`, and click the evidence URLs. **Is every observation true?** Record false positives; they tell me which detectors to tighten.
5. Run **03 Generate** with `llm.provider = "template"` first, then with your AI model. Read every draft against its evidence. Check the AI's `llm_usage` column for real token counts.
6. Run **04 Send** with the shipped settings. It sends nothing. In the execution view, the first output item of the **Send gate** node (`route: "summary"`) lists `would_send` (who would have been emailed, and in which mode) and `blocked` (every other approved lead, with its reason). Block reasons are also written to `send_block_reason` in the Leads tab.

**Stage B: test sends to your own inboxes only**
7. In Settings, set `TEST_ALLOWLIST` to one or two inboxes you own and `TEST_REDIRECT_TO` to one of them. In the config, set `sending.SENDING_ENABLED: true` (keeping `TEST_MODE: true`), rebuild and re-import. Then set Settings `SENDING_ENABLED=TRUE`.
8. Approve 2–3 drafts and run **04 Send**. The emails arrive **only in your test inbox**, marked `[TEST]`, with the intended recipient in a banner.
9. Check in that inbox: the formatting, the From name and Reply-To, the `List-Unsubscribe` header ("Show original" in Gmail), and whether it lands in Inbox or Spam.
10. Reply "unsubscribe" from the test inbox and run **05 Inbox**. Confirm the address appears in Suppression.
11. Set `KILL_SWITCH=TRUE`, run **04 Send**, and confirm nothing is sent. Then set it back.
12. Run **04 Send** again. Nothing should be re-sent (Send_Log has one row per email).

Report the results back to me, including any false observations, odd wording and spam placement, before moving on to [GO_LIVE_CHECKLIST.md](GO_LIVE_CHECKLIST.md).

## Known limitations
- **Detection is heuristic.** It sees the HTML that was served, not what JavaScript renders afterwards, and it reviews at most 4 pages. That is why absence is phrased as "I couldn't find…" and suppressed on thin or JS sites. Expect some manual-review volume.
- **Booking and chat widget detection** relies on a list of known providers (`lib/html.js`). Unknown tools may lead to a wrong "couldn't find online booking". The wording stays truthful to the review, and a human approves each draft.
- **Opening-hours detection** recognises common English formats only.
- **One-click unsubscribe** needs workflow 06 to be reachable from the internet. Without it, unsubscribing works by reply only.
- **Bounce parsing** covers common Gmail and Postfix formats. Unusual bounce formats may be classified as "other".
- **Unsubscribe tokens** use `Math.random` because the n8n sandbox has no `crypto`. They are long (24 characters) and only allow opting *out*, so the risk is low.
- **No automatic follow-ups** in v1.
- **The Sheets API** is called once per lead per stage. For thousands of leads per day, a batched writer would be more efficient.
