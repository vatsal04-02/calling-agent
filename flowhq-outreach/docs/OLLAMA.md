# Local Ollama + Qwen3 4B (FH03)

Importable file: `workflows/presets/ollama-qwen3-4b/03-generate-emails.json`. To rebuild it with your own config, run `node scripts/build-workflows.js --preset ollama-qwen3-4b`.

## Why Send_Log stays empty after drafting (this is by design)
- **FH03 only drafts.** It writes the draft into the lead's own row in **Leads**: `email_subject`, `email_body`, `factual_validation_status`, `generator`, `generated_at`, and `outreach_status` set to `READY_FOR_APPROVAL` or `MANUAL_REVIEW`. It has no Send_Log node.
- **The only Send_Log writer** is FH04's **Append Send Log** node. It runs only after **Gmail API send** has actually been attempted, inside the "One email at a time" loop.
- **The loop only receives leads when all of these hold:**
  - `SENDING_ENABLED` is true in FH04's Config **and** TRUE in the Settings tab;
  - `KILL_SWITCH` is not TRUE;
  - `approval_status` is `APPROVED`;
  - `factual_validation_status` is `PASSED`;
  - `outreach_status` is `READY_FOR_APPROVAL`;
  - in TEST_MODE, the recipient (or `TEST_REDIRECT_TO`) is on `TEST_ALLOWLIST`.
- **With `SENDING_ENABLED=false` an empty Send_Log is correct.** That's the safe setting to keep while debugging. The updated FH04 now writes the reason on the lead row instead: `send_block_reason = "NOT SENT - sending is off (...). Would send in TEST mode to ..."`.

## Settings in the preset

| Setting | Value | Reason |
|---|---|---|
| `provider` | `ollama` | Uses the native `/api/chat` API, not `/v1/chat/completions`. That endpoint ignores `think` and context size. |
| `endpoint` | `http://host.docker.internal:11434/api/chat` | See the networking notes below. |
| `think` | `false` | Turns off Qwen3's reasoning so the output budget goes to the email. If Ollama returns an error about `think`, set `llm.ollama_think` to `null` in the Config node. |
| `format` | the email JSON schema | Ollama constrains the output to valid JSON. |
| `num_ctx` | 8192 | The prompt is about 2,000 tokens; Ollama's default context can be 2,048, which silently cuts the prompt. |
| `num_predict` (`max_tokens`) | 1200 | |
| `timeout_ms` | 300000 | CPU inference can take minutes. |
| `max_tries` | 2 | |
| `batch_size` | 5 | |
| `fallback_to_template` | true | If Qwen's draft fails validation, the deterministic template draft is used instead. The rejected AI draft's issues are recorded in `validation_issues` as `ai_fallback`. |

## Networking (check, don't change containers without deciding)
- Ollama listens on `127.0.0.1` by default, which a container can't reach. Set `OLLAMA_HOST=0.0.0.0:11434` for the Ollama service if n8n runs in Docker and Ollama runs on the host.
- On Linux, `host.docker.internal` only resolves if the n8n service has `extra_hosts: ["host.docker.internal:host-gateway"]`. Changing that means recreating the n8n container, so it's your call. Alternatives: the Docker bridge IP (often `http://172.17.0.1:11434`), or the Ollama container's name if both share a Docker network.
- Test from inside the n8n container. This is read-only and lists your models:

  ```bash
  docker exec <n8n-container> node -e "fetch('http://host.docker.internal:11434/api/tags').then(r=>r.text()).then(console.log).catch(e=>console.error(e.message))"
  ```

  `qwen3:4b` must appear in the list (`ollama pull qwen3:4b`).

## Reading results
`llm_usage` shows Ollama's `prompt_eval_count` and `eval_count`. `generator` shows `ollama:qwen3:4b`, or `template (fallback; ollama:qwen3:4b)`.

| `status_reason` | Meaning |
|---|---|
| `sender_settings_incomplete` | The Config node still has `REPLACE_WITH` sender values. |
| `generation_retry_pending:temporary` | Ollama was unreachable or timed out. |
| `generation_retry_pending:malformed` | Truncated or invalid JSON. Retried on the next run, then the template fallback is used. |
