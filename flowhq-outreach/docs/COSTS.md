# Operating costs

## What costs money and what doesn't

| Component | Cost | Notes |
|---|---|---|
| n8n (your existing self-hosted instance) | $0 extra | Runs inside the n8n you already operate. |
| Website research | $0 | Plain HTTP requests from n8n; no paid scraping API, no headless browser. At most 5 requests per lead (robots.txt + 4 pages), cached for 30 days per domain. Roughly 0.2–1 MB of bandwidth per lead. |
| Google Sheets API | $0 | Free, but has per-minute request quotas. Batches of 10–25 leads per run stay well inside them. |
| Gmail API | $0 | Free. The limit is your mailbox's sending allowance (Google Workspace: 2,000 messages per user per day). The shipped limits are far lower on purpose. |
| Google Workspace mailbox | Your existing plan | Recommended over a personal Gmail account. |
| **AI model** | **The only variable cost** | Optional: `llm.provider = "template"` costs $0. |

## AI cost per lead

**Measured request size:** the five synthetic drafts produced prompts of about 1,250–1,300 tokens (characters ÷ 4, including the JSON schema).

**Assumptions:**
- **Input:** 2,000 tokens per call, rounded up for tokenizer differences and structured-output overhead.
- **Output:** 1,000 tokens per call. That is about 300 tokens of JSON plus up to about 700 tokens of model reasoning, which is billed as output.
- **Calls:** one per lead that reaches drafting. Leads that are invalid, duplicated, inaccessible or have no recommendation make **no** AI call.
- **Retries:** a retried temporary failure adds at most 2 more calls, and is rare.

| Model | Price per million tokens (input / output) | Per lead | **Per 100 leads** | **Per 1,000 leads** |
|---|---|---|---|---|
| Template mode (no AI) | – | $0 | **$0** | **$0** |
| Claude Haiku 5.5 (`claude-haiku-5-5`, the config default) | $0.10 / $0.50 | ≈ $0.0007 | **≈ $0.07** | **≈ $0.70** |
| Gemini 3.1 Flash-Lite (via its OpenAI-compatible endpoint) | $0.25 / $1.50 (third-party figure, unverified) | ≈ $0.002 | ≈ $0.20 | ≈ $2.00 |
| Claude Sonnet 5.5 (`claude-sonnet-5-5`) | $2 / $10 | ≈ $0.014 | ≈ $1.40 | ≈ $14 |
| Claude Opus 5.5 (`claude-opus-5-5`) | $4 / $20 | ≈ $0.028 | ≈ $2.80 | ≈ $28 |

These figures are upper bounds, because they assume every lead reaches drafting; in practice a share are filtered out earlier. The Anthropic prices are Anthropic's published rates as of October 2026. The Gemini figure is from third-party pricing pages that disagreed with each other, so check [ai.google.dev](https://ai.google.dev) before relying on it.

### Hard caps per lead
- **AI:** `llm.max_tokens = 3000` caps one call's output. With 3 attempts, the worst case per lead is about $0.005 on Haiku 5.5 and about $0.20 on Opus 5.5.
- **Research:** a fixed maximum of 5 HTTP requests, with no per-page charge.
- **Batch sizes:** `RESEARCH_BATCH_SIZE` and `GENERATION_BATCH_SIZE` (default 10 per hourly run) limit how much can be spent in one run.

### Free tiers
Google AI Studio offers a rate-limited free tier for Gemini Flash and Flash-Lite. That would make AI drafting free within its quota, but free-tier inputs may be used to improve Google's products. The AI only receives business-level information (see [SPREADSHEET.md](SPREADSHEET.md#data-protection)), but decide whether that's acceptable to you. A local model (for example Ollama with `provider: "openai_compatible"`) is also free, but quality and JSON reliability vary, and failed validations simply go to manual review. Nothing is unlimited: free tiers have per-minute and per-day caps.

## Recommendation
Start with **template mode** to test the whole pipeline at $0. Then switch to **Claude Haiku 5.5** for more natural wording, at well under $1 per 1,000 leads. Use Sonnet or Opus only if review shows Haiku's drafts need too much editing. The model choice is a single config line.

To use an OpenAI-compatible provider, set `provider: "openai_compatible"`, `endpoint` (for example `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions` for Gemini), `model`, and `credential_type: "httpHeaderAuth"`. Then create a Header Auth credential named `FlowHQ LLM API key` with `Authorization: Bearer <key>`.

## Time per batch (not money)
Research takes about 10–30 seconds per site because requests are spaced 1.5 seconds apart. Drafting takes 3–10 seconds per lead. Sending is deliberately slow, at 90 seconds or more between emails. At the defaults (10 leads per hourly run), 100 leads are researched and drafted in about 10 hours of scheduled runs. Raise the batch sizes in the Settings tab to go faster.
