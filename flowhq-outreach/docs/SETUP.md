# Setup

The steps below assume your existing self-hosted n8n runs in Docker alongside Grist and the clinic automation. None of them requires stopping, recreating or reconfiguring any container. The one optional change that would need a restart (SSRF protection) is clearly marked, and it needs your decision first.

The FlowHQ workflows are fully separate from the clinic automation:
- **Workflow IDs:** `FlowHQ0Preflight`, `FlowHQ01Import00` … `FlowHQ99ErrorLog`.
- **Names:** all start with "FlowHQ".
- **Credentials:** three new ones, all named "FlowHQ …".
- **Spreadsheet:** a new spreadsheet of their own.

They do not read or write anything the clinic workflows use.

## 0. Check your environment (read-only)

```bash
docker ps --format '{{.Names}}\t{{.Image}}'          # find the n8n container name
docker exec <n8n-container> n8n --version            # expect 2.41.6 (the workflows were tested on 2.41.6)
```

The workflows use these node versions: Code v2 (JavaScript), HTTP Request v4.2, Google Sheets v4.7, Gmail v2.1, IF v2.2, Loop Over Items v3, Wait v1.1, Webhook v2, Respond to Webhook v1.1, Schedule Trigger v1.2 and Error Trigger v1. If your n8n is older than 2.x, tell me before importing.

The Code nodes need n8n's JavaScript task runner, which is the default in 2.x. If your existing Code nodes run, these will too. They use no `$env`, no `require()` and no Node built-ins, so `N8N_BLOCK_ENV_ACCESS_IN_NODE` and `NODE_FUNCTION_ALLOW_*` can stay at their defaults.

## 1. Create the spreadsheet

1. Upload `templates/FlowHQ-Outreach-Template.xlsx` to Google Drive, open it, and choose **File > Save as Google Sheets**.
2. Copy the spreadsheet ID from the URL: `https://docs.google.com/spreadsheets/d/<THIS_PART>/edit`.
3. Put your leads in the **Leads_Source** tab. Your own column names are fine; see [SPREADSHEET.md](SPREADSHEET.md). If your leads live in a different spreadsheet, leave them there and set `source.spreadsheet_id` and `source.sheet_name` instead. That sheet is only ever read.

Don't rename tabs or header cells, and keep `lead_id` in column A of **Leads**.

## 2. Google Cloud OAuth client (one-time)

1. In Google Cloud Console, open a project you control and enable the **Gmail API** and the **Google Sheets API**.
2. Set up the OAuth consent screen. If FlowHQ uses Google Workspace, choose **Internal**. An External app in "Testing" status issues refresh tokens that expire after about 7 days, so the workflows would silently lose access every week.
3. Create an OAuth client ID of type **Web application**. Use the redirect URL that n8n shows in its credential dialog, which looks like `https://<your-n8n-host>/rest/oauth2-credential/callback`.

## 3. Create three credentials in n8n

In n8n, go to **Credentials > Add credential**. Use these exact names so the imported nodes link to them automatically:

| Name | Type | Notes |
|---|---|---|
| `FlowHQ Google Sheets` | Google Sheets OAuth2 API | Sign in with the Google account that owns the spreadsheet. |
| `FlowHQ Gmail` | Gmail OAuth2 API | Sign in with the mailbox you will send from. n8n's default Gmail scopes include sending and reading the inbox. |
| `FlowHQ LLM` | Anthropic (default) | Paste your API key here, in n8n only, and never in chat or files. For an OpenAI-compatible provider, set `llm.credential_type` to `openAiApi` or `httpHeaderAuth`. See [COSTS.md](COSTS.md). |

If you use a different name, reselect the credential on each affected node after import.

If you'd rather use **no AI model** (zero cost), set `llm.provider` to `"template"`. You then don't need an LLM credential.

## 4. Fill in your configuration

```bash
cp config/settings.default.json config/settings.local.json   # git-ignored
```

Edit `config/settings.local.json`:

| Key | Set to |
|---|---|
| `spreadsheet_id` | ID from step 1 |
| `sender.name`, `sender.email` | Your name and the Gmail/Workspace address in the `FlowHQ Gmail` credential |
| `sender.postal_address` | A valid postal address. CAN-SPAM requires one for US recipients, and drafts are blocked while this is a placeholder. |
| `sender.reply_to` | Optional |
| `llm.*` | Provider and model; see [COSTS.md](COSTS.md) |
| `sending.*` | **Leave as shipped for now**: `SENDING_ENABLED:false`, `TEST_MODE:true` |

Then build:

```bash
npm run build      # writes out/workflows-local/*.json  (git-ignored, contains your config)
```

Alternatively, import `workflows/*.json` as-is and edit the **Config** node in each workflow. Rebuilding is less error-prone because all eight workflows embed the same config.

## 5. Import into n8n

**Option A, UI (recommended; doesn't touch the container):** for each file, go to **Workflows > Create > ⋯ > Import from File**. Then for each workflow:
- Open **Settings > Error workflow** and choose "FlowHQ 99 - Error logger". UI import assigns new IDs, so this link has to be set by hand.
- Open any node flagged with a credential warning and select the FlowHQ credential.

**Option B, CLI inside the running container** (keeps the fixed IDs, so the error-workflow link works automatically):

```bash
docker cp out/workflows-local <n8n-container>:/tmp/flowhq-workflows
docker exec <n8n-container> n8n import:workflow --separate --input=/tmp/flowhq-workflows
```

CLI import overwrites a workflow only if it has the same ID. The `FlowHQ…` IDs are unique, so your clinic workflows are not affected.

All workflows import **inactive**. Leave them that way for now.

## 6. Run the preflight check

Open **FlowHQ 00 - Preflight check** and click **Execute workflow**. It is read-only and sends nothing. It confirms that:
- config placeholders are filled,
- every tab and column exists in the spreadsheet,
- the Gmail OAuth credential works (it reads the mailbox profile) and matches `sender.email`.

Fix anything it reports, then continue with the [safe test procedure](TESTING.md#safe-test-procedure-with-your-real-setup).

## 7. Optional: unsubscribe link (workflow 06)

By default, emails offer reply-to-unsubscribe plus a `mailto:` List-Unsubscribe header, and workflow 05 processes those replies. For a clickable link with RFC 8058 one-click unsubscribe:

1. Activate **FlowHQ 06** and copy its **production** webhook URL (`https://<your-n8n>/webhook/flowhq-unsubscribe`). This needs your n8n to be reachable from the internet with `WEBHOOK_URL` set correctly.
2. Set `sender.unsubscribe_url_base` to that URL, rebuild and re-import.

## 8. Optional: SSRF protection (needs your decision; restarts n8n)

The research workflow fetches URLs that come from a spreadsheet. The importer already rejects IP addresses, `localhost` and reserved domains. n8n 2.41.6 can additionally block requests that resolve to private networks (`N8N_SSRF_PROTECTION_ENABLED=true`), but it is **off by default**.

Turning it on applies to **all** workflows and requires restarting the n8n container. It could break clinic workflows that call internal services such as Grist over the Docker network, unless you allow those with `N8N_SSRF_ALLOWED_HOSTNAMES` or `N8N_SSRF_ALLOWED_IP_RANGES`. I have not changed this. Decide after checking which internal hosts your other workflows call.

## Schedules

Research and Generate run hourly, Send every 30 minutes and Inbox every 30 minutes, but only once you **activate** them. The schedules use n8n's `GENERIC_TIMEZONE`. Keep **04 Send** inactive until you complete [GO_LIVE_CHECKLIST.md](GO_LIVE_CHECKLIST.md). You can also run any workflow manually.
