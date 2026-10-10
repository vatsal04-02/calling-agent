# Spreadsheet

The workspace is one Google Sheet created from `templates/FlowHQ-Outreach-Template.xlsx`. The column lists are generated from `lib/schema.js`, which the workflows also use.

## Connecting your real lead spreadsheet later

Nothing in the workflows depends on a particular spreadsheet or column names:

1. Put your leads in the `Leads_Source` tab, **or** keep them in their own spreadsheet and set `source.spreadsheet_id` and `source.sheet_name`. The source is only ever **read**, never modified.
2. Column names are matched case- and punctuation-insensitively against the aliases in `config/field-mapping.json`. For example, "Company Name", "Organisation" and "Practice name" all map to `business_name`, and "E-mail" maps to `email`.
3. If a column isn't recognised, add it under `explicit`, for example `"explicit": { "business_name": "Trading As", "website": "Primary URL" }`. Then rebuild, or edit the Config node.
4. Extra columns are fine: they are kept, untouched, in `original_row_json`.
5. Run **01 Import** and check the counts. The `status_reason` and `validation_errors` columns explain every row that wasn't VALIDATED.

**Required:** `business_name`, `email`, `website`.

**Optional:** `lead_id` (generated if missing), `contact_name` or `first_name` plus `last_name`, `country` (inferred from `.com.au`, `.co.nz` or `.co.uk` only if blank), `industry`, `source`, `notes`, `outreach_status`, `phone`, `city`, `state` and `legal_basis_confirmed`.

**Source statuses** such as "contacted", "customer" or "do not contact" are skipped (`config/field-mapping.json > source_statuses_to_skip`).

## Tabs and columns

### Leads (working table; written by the workflows)

| Group | Columns |
|---|---|
| Identity | `lead_id` (**column A**), `business_name`, `contact_name`, `first_name` (greeting name, only if provided), `email`, `role_address`, `website`, `domain`, `country`, `country_inferred`, `industry`, `industry_group`, `source`, `notes`, `phone`, `source_row_number`, `original_row_json`, `imported_at` |
| State | `outreach_status`, `status_reason`, `validation_errors`, `duplicate_of`, `legal_basis_confirmed` (you set this for UK leads), `reprocess` (set TRUE to redo) |
| Research | `website_access_status`, `pages_reviewed`, `observed_issue_1`, `evidence_url_1`, `evidence_snippet_1`, `observed_issue_2`, `evidence_url_2`, `evidence_snippet_2`, `signals_json` (all observations), `email_published_url`, `no_unsolicited_notice`, `research_summary`, `researched_at` |
| Personalisation | `selected_signals`, `recommended_solution`, `secondary_solution`, `business_benefit`, `confidence_score`, `email_subject`, `email_body`, `factual_validation_status`, `validation_issues`, `generator`, `llm_usage`, `generation_attempts`, `generated_at` |
| Approval (you) | `approval_status` (PENDING / APPROVED / REJECTED, as a dropdown), `approved_by`, `reviewer_notes` |
| Sending | `send_block_reason`, `send_mode`, `sent_to`, `sending_timestamp`, `provider_message_id`, `provider_thread_id`, `delivery_or_error_status`, `retry_count`, `next_retry_at`, `follow_up_eligible`, `opt_out_status`, `unsubscribe_token`, `last_error`, `updated_at` |

### Settings (runtime switches; change them any time)

| key | default | effect |
|---|---|---|
| `KILL_SWITCH` | FALSE | TRUE stops all sending, including mid-run. Set automatically on Gmail auth or quota errors and when the bounce rate exceeds 5%. |
| `SENDING_ENABLED` | FALSE | Must be TRUE here **and** in the workflow config. |
| `TEST_MODE` | TRUE | Only allowlisted inboxes receive mail. Live mode also needs the config approval record. |
| `TEST_ALLOWLIST` | (empty) | Your own test inboxes, comma-separated. |
| `TEST_REDIRECT_TO` | (empty) | An allowlisted inbox that receives a `[TEST]` copy of each approved draft. |
| `MAX_SENDS_PER_RUN`, `MAX_SENDS_PER_DAY` | 5, 20 | The lower of the sheet and config values applies. |
| `SEND_INTERVAL_SECONDS` | 90 | The higher of the sheet and config values applies. |
| `SEND_LOCK` | (empty) | Managed by FH04: holds `<run>\|<time>` while a send run is in progress so overlapping runs cannot work the same queue; ignored after 30 minutes. Leave it alone. |
| `RESEARCH_BATCH_SIZE`, `GENERATION_BATCH_SIZE` | 10, 10 | Leads per run. The lower value applies. |

### Other tabs
- **Research_Cache:** one row per domain, reused for 30 days.
- **Send_Log:** append-only. Every send attempt, test or live, with Gmail IDs. It is used for deduplication and daily limits.
- **Suppression:** `value` (email or domain) and `type` (`email` or `domain`). Add anyone who must never be contacted.
- **Inbox_Log:** processed inbox messages, used for idempotency.
- **Error_Log:** workflow failures.

Every write uses `RAW` cell format, so text copied from websites can never be interpreted as a spreadsheet formula.

## Data protection
- Lead data stays in your Google account and your n8n. Do not commit real lead files to git: `.gitignore` excludes `data/real/`, `*.real.csv` and `config/settings.local.json`.
- What the AI model receives: the business name, industry, country, website URL, the selected observations and short quotes, and FlowHQ's service text. It does **not** receive contact names or email addresses: addresses inside website quotes are redacted before the request (tested). Check your AI provider's data-retention terms; free tiers may use inputs for training.
