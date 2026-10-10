# FH03 → Send_Log → FH04: root cause, fix and test evidence

Files: `workflows/presets/ollama-qwen3-4b/03-generate-emails.json` and `04-send-approved-emails.json`. Both use Ollama Qwen3 4B, and both are built with `SENDING_ENABLED=false`, `TEST_MODE=true` and `REQUIRE_APPROVAL=true`.

## 1. Root cause

**The hypothesis "FH04 cannot process drafts because Send_Log is empty" is false.** Send_Log is the history of *send attempts*, written only by FH04 after a Gmail API call. An empty log is the valid initial state.
- In `lib/sendgate.js`, the gate reads Send_Log only to count rows with status `SENT` or `TEST_SENT`. Those counts feed the daily limit, the "already contacted" check and the domain cooldown. An empty log means no limits are used and no duplicates exist.
- Eligibility (`isEligibleStatus`) is decided from the **Leads** row and never requires a log row.

**Evidence:**
- **Executed, library level:** with an empty Send_Log and an approved, validated draft, the gate queues the email (`queued_for_gmail=1`).
- **Executed, in n8n 2.41.6 with mocks:** "EMPTY Send_Log does not block the first eligible sends" passes.

**What actually stops approved drafts:**

| # | Cause | Evidence |
|---|---|---|
| 1 | The uploaded FH03 **Config** node still has `sender.name`, `email` and `postal_address` = `REPLACE_WITH_…` (and `spreadsheet_id = REPLACE_WITH_OUTREACH_SPREADSHEET_ID`). The assembled footer then contains `REPLACE_WITH`, so validation fails every draft: `factual_validation_status=FAILED`, `outreach_status=MANUAL_REVIEW`. | Executed with your Config: `outreach_status=MANUAL_REVIEW factual_validation_status=FAILED status_reason=sender_settings_incomplete` |
| 2 | **Approving such a row was silently ignored.** In the "Send gate" node, `evaluateSendQueue` ran `if (!isEligibleStatus(lead…)) continue;` before looking at approval, so an APPROVED but MANUAL_REVIEW row produced no reason anywhere. | Executed: `blocked=[] lead_update=[]` for an approved MANUAL_REVIEW row |
| 3 | `SENDING_ENABLED=false` (your safety setting) is **by design** a dry run. The gate returns `send: []`, so "Email to send?" outputs nothing; "One email at a time", "Gmail API send" and "Append Send Log" never run; and Send_Log stays empty. The row only showed a secondary reason (allowlist), not "sending is off". | `lib/sendgate.js`: `send: policy.sending_enabled ? send : []` |

**Robustness gaps found while tracing (not the cause, now fixed):**
- **Overlapping runs:** two overlapping FH04 executions could both claim a lead read in the same window. "Kill-switch check" re-read Settings but not the lead row.
- **Duplicate log rows:** "Append Send Log" used `append` with node retries, so a write that succeeded but lost its response would add a duplicate row.

**Checked and consistent:** both workflows use the same `documentId` expression (`settings.spreadsheet_id`) and the same tab names (`Leads`, `Settings`, `Send_Log`, …). Lead updates match on `lead_id`. Send_Log headers: `log_id, timestamp, run_id, lead_id, mode, intended_recipient, actual_recipient, subject, status, http_status, provider_message_id, thread_id, error_message`.

## 2. State transitions (unchanged architecture)

```
FH03: RESEARCHED -> draft + validation -> Leads: READY_FOR_APPROVAL (PASSED, approval PENDING) | MANUAL_REVIEW (+ reason)
Human: approval_status = APPROVED
FH04 gate (reads Leads, Settings, Suppression, Send_Log): eligible only if READY_FOR_APPROVAL + PASSED + APPROVED + all safety gates
  sending off      -> no Gmail call, no Send_Log row; reason written to Leads.send_block_reason
  sending on (TEST)-> take SEND_LOCK -> per email: re-read Settings + Leads -> re-check -> mark SENDING -> Gmail API
                      2xx + message id -> Leads TEST_SENT/SENT + Send_Log row (status TEST_SENT/SENT)
                      503/429/network  -> Leads RETRY_PENDING   + Send_Log row (status RETRY_PENDING)
                      401/403/quota    -> Leads READY_FOR_APPROVAL + Send_Log NOT_SENT_* + KILL_SWITCH=TRUE
                      400              -> Leads FAILED + Send_Log FAILED
                      timeout          -> Leads SEND_UNKNOWN (never auto-retried)
                   -> release SEND_LOCK
```

No record is ever written as sent unless Gmail returned 2xx **and** a message ID. FH03 never writes Send_Log.

## 3. Changes

### FH03 (Ollama Qwen3 4B)
Same workflow ID, the same 15 nodes and the same node IDs and connections as your upload. The Code-node logic is updated:
- native Ollama `/api/chat` (`think:false`, JSON-schema `format`, `num_ctx 8192`);
- `<think>` stripping;
- template fallback when the AI draft fails validation;
- `status_reason=sender_settings_incomplete` when the sender settings are placeholders.

### FH04
Same workflow ID; all 31 original nodes keep their IDs. Six nodes were added and none removed:

| Change | Node(s) | Why |
|---|---|---|
| Visible reasons | **Send gate** (code) | An APPROVED row without a sendable draft gets `send_block_reason = "APPROVED but not sendable: outreach_status=… (reason)…"`, written once and with its status unchanged. With sending off the reason starts `NOT SENT - sending is off (…)`. |
| Run lock | **Take send lock** → **Write send lock** (Settings `appendOrUpdate` on `key`) → **Send queue**, between "Email to send?" and "One email at a time". **Release send lock** → **Clear send lock** after "Send summary". | Overlapping executions cannot work the same queue. A lock older than 30 minutes is ignored, so a crashed run can't block sending forever. |
| Fresh lead re-check | **Re-read Leads** between "Re-read Settings" and "Kill-switch check". **Kill-switch check** now also requires the lead's *current* row to be READY_FOR_APPROVAL or RETRY_PENDING, still APPROVED, not opted out, and the lock not taken by another run. | A lead claimed or sent by another run, or un-approved since the gate ran, is skipped. |
| Retry-safe log | **Append Send Log**: `append` → `appendOrUpdate` matching `log_id` | A retried write can't create a second row. |

The Gmail API send node still has **no** auto-retry, since a retry could send the same email twice.

### Google Sheets changes
- **Settings tab:** a `SEND_LOCK` row. FH04 adds it automatically on first use, or you can add `SEND_LOCK` with an empty value. The regenerated template already includes it.
- **No other column changes.**

## 4. Test evidence

**Executed:**
- `npm test`: 59/59 pass.
- `HARNESS_PRESET=ollama-qwen3-4b npm run harness`: **37/37 pass** inside a fresh n8n 2.41.6, with Google Sheets, Gmail and Ollama replaced by local mock servers (127.0.0.1). No real email can be sent by this setup. The harness build uses test-only settings with sending enabled against the mock Gmail; the delivered files keep sending disabled.

| Your requirement | Executed check (n8n harness unless noted) |
|---|---|
| 1. FH03 creates a valid draft and updates the lead row | "Qwen3 `<think>` preamble stripped -> draft created", "AI draft with fabricated claims -> rejected, validated template draft used instead" |
| 2. Empty Send_Log doesn't block the first send | "EMPTY Send_Log does not block the first eligible sends"; unit test of the same name |
| 3. Unapproved draft rejected | "nothing is sent without human approval" |
| 4. Suppressed lead rejected | Unit: "duplicates, suppression, opt-outs and invalid addresses are hard stops". The inbox harness also covers suppression. |
| 5. Kill switch blocks sending | "kill switch on -> nothing attempted", "Gmail 401 -> kill switch tripped mid-run" |
| 6. Test mode never emails a lead | "test mode: only the allowlisted inbox receives mail, subject marked [TEST]" |
| 7. Simulated success → correct success record | "success record: TEST mode, allowlisted actual recipient, real lead as intended recipient, Gmail id" |
| 8. Simulated failure → no false success | "failed sends (401, 503) never produce a success record"; unit: "a failed send never produces a success record" |
| 9. Re-run → no duplicate success records | "repeated runs: remaining lead sent once, no duplicates" (unique `log_id`, 3 rows for 3 sends) |
| 10. FH04 reads the resulting state correctly | "approved row without a sendable draft gets a visible reason", "dry run: approved draft shows WHY it was not sent", "overlapping run: a fresh SEND_LOCK held by another execution -> nothing attempted", "send lock … released at the end" |

**Not executed:**
- **The real Qwen3 4B model.** Ollama and the model weights can't be downloaded in this environment; the Ollama mock reproduces its response format and known quirks.
- **Real Google Sheets and Gmail.**
- **The default (Anthropic) build of the harness** after these changes. Only the Ollama build was re-run.

## 5. Import and test (no real emails)
1. **Back up first:** in n8n, open your current FH03 and FH04 and use **⋯ > Download**.
2. **Import:** use **Import from File** with `workflows/presets/ollama-qwen3-4b/03-generate-emails.json` and `04-send-approved-emails.json`. Same IDs means a CLI import replaces the old versions; a UI import creates copies, so delete the old ones afterwards. Keep both **inactive**.
3. **Fill in the Config node in both workflows:** the real `spreadsheet_id`, plus `sender.name`, `sender.email` and `sender.postal_address`. Leave `sending.*` as is. Without the sender values, every draft goes to `MANUAL_REVIEW` with `sender_settings_incomplete`.
4. **Re-attach credentials:** "FlowHQ Google Sheets" on the Sheets nodes and "FlowHQ Gmail" on FH04's Gmail node. "Call LLM" needs none.
5. **Check Ollama reachability** from the n8n container (see `docs/OLLAMA.md`).
6. **Regenerate the drafts that failed earlier:** in Leads, set `reprocess=TRUE` and `outreach_status=RESEARCHED` for them. Run **FH03** manually. Expect `READY_FOR_APPROVAL` + `PASSED`, `generator = ollama:qwen3:4b` (or `template (fallback; …)`) and `llm_usage` filled in.
7. **Set `approval_status=APPROVED`** on one or two drafts.
8. **Run FH04 manually (dry run).** It sends nothing and Send_Log stays empty, as designed. Check `send_block_reason` on the approved rows; it should read `NOT SENT - sending is off (SENDING_ENABLED=false in workflow config; …)`. Any approved MANUAL_REVIEW row shows `APPROVED but not sendable: …`.
9. **Only when you decide to do test sends to your own inbox:** follow `docs/TESTING.md` Stage B. That means sending on in Config and Settings, `TEST_MODE` kept TRUE, and your inbox on `TEST_ALLOWLIST` and in `TEST_REDIRECT_TO`. Send_Log rows then appear with `mode=TEST`, `status=TEST_SENT` and a Gmail `provider_message_id`.
