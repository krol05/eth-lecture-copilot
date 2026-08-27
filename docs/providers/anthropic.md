# Anthropic Messages API — Reference for Browser-Fetch Adapter

**Retrieval date:** 2026-08-23

**Sources used (fetched live on retrieval date, current docs domain `platform.claude.com`; `docs.anthropic.com` now 301-redirects there):**
- https://platform.claude.com/docs/en/api/messages
- https://platform.claude.com/docs/en/build-with-claude/streaming
- https://platform.claude.com/docs/en/api/errors
- https://platform.claude.com/docs/en/api/overview
- https://platform.claude.com/docs/en/build-with-claude/extended-thinking
- https://platform.claude.com/docs/en/build-with-claude/vision
- https://platform.claude.com/docs/en/api/models/list
- https://platform.claude.com/docs/en/about-claude/models/overview
- https://platform.claude.com/docs/en/about-claude/model-deprecations
- https://platform.claude.com/docs/en/build-with-claude/structured-outputs
- https://platform.claude.com/docs/en/cli-sdks-libraries/overview
- Web search on `anthropic-dangerous-direct-browser-access` (see §1 — this specific header could not be re-confirmed on the current official docs pages fetched above; flagged UNVERIFIED)

This document is written as ground truth for a browser-based (Chrome extension) `fetch` adapter talking directly to the Anthropic Messages API. All JSON shown is copied verbatim from the fetched documentation except where noted.

---

## 1. Endpoint URL and required headers

**Base URL:** `https://api.anthropic.com` (RESTful; the docs site itself is served from `platform.claude.com`, but that is documentation only — actual API calls go to `api.anthropic.com`).

**Messages endpoint:**

```
POST https://api.anthropic.com/v1/messages
```

**Required headers on every request** (per the current official "API overview" page):

| Header | Value | Required |
|---|---|---|
| `x-api-key` | Your API key | One of `x-api-key` or `Authorization` |
| `Authorization` | `Bearer <token>` (only for Workload Identity Federation short-lived tokens — not the typical API-key flow) | One of `x-api-key` or `Authorization` |
| `anthropic-version` | API version string, currently `2023-06-01` | Yes |
| `content-type` | `application/json` | Yes |

Note: `anthropic-version` is a *date-stamped protocol version identifier*, not a model version — `2023-06-01` is still the current/only value used in all fetched 2026 examples (including brand-new Claude 5-family requests). Do not confuse it with model IDs.

### CORS / browser-direct access header

**UNVERIFIED (current status uncertain):** The header `anthropic-dangerous-direct-browser-access: true` was introduced in August 2024 to allow direct browser `fetch`/XHR calls to `api.anthropic.com` by satisfying Anthropic's CORS preflight checks. It is well documented in third-party sources (Simon Willison's write-up, the TypeScript SDK's `dangerouslyAllowBrowser` client option) as of its introduction. However, none of the current official docs pages fetched today (`api/overview`, `api/messages`, `api/errors`) mention this header or CORS behavior at all — the official docs describe only server-side/SDK usage. I could not find a current official-docs confirmation that this header is still required or still works exactly as in 2024.

**Recommendation for the extension adapter:** Send `anthropic-dangerous-direct-browser-access: true` on every direct browser request (it is a no-op if unnecessary but was the documented CORS unlock mechanism), and treat the request as best-effort — if the browser fetch fails with a CORS error, that header (or a change in its accepted value/behavior) is the first thing to check against Anthropic's current TypeScript SDK source (`dangerouslyAllowBrowser` client option) or a fresh support ticket, since this could not be re-verified against current official docs.

Also note: The official docs explicitly warn that embedding an API key in client-side code exposes it to anyone with browser dev tools — this is the documented rationale for the header's "dangerous" naming. A BYOK (bring-your-own-key) pattern, where the extension user supplies their own key stored locally, is the intended safe use case for direct browser calls.

---

## 2. Request body shape

### Required fields

```json
{
  "model": "claude-opus-5",
  "max_tokens": 1024,
  "messages": [
    { "role": "user", "content": "Hello, Claude" }
  ]
}
```

- `model` (string, required) — exact model ID (see §10).
- `max_tokens` (integer) — **the official docs state it is "NOT required but recommended; models stop naturally if omitted."** However, in practice essentially every documented example sends it, and for a browser adapter you should always send it explicitly to bound cost/latency and avoid ambiguous timeout behavior. **Safe generous default:**
  - Non-streaming requests: **~16,000** (keeps responses under typical HTTP timeouts).
  - Streaming requests: up to **~64,000–128,000** is fine since timeouts aren't a concern when streaming; current top-tier models (Opus 5, Sonnet 5, Fable 5, and the 4.6/4.7/4.8 family) support up to **128,000** max output tokens, but the docs explicitly warn: *"Avoid setting a large `max_tokens` value without using the streaming Messages API... some networks may drop idle connections."* For `max_tokens` above ~4096–8192 on a non-streaming call, prefer switching to `stream: true`.
- `messages` (array, required) — see §2.3.

### Optional fields (from the current Messages API reference)

- `system` (string or array of text blocks) — system prompt (see §2.2).
- `temperature` (number, 0.0–1.0, default 1.0) — **deprecated/rejected on Claude 4.7+ models**: returns 400 if set to a non-default value on Opus 4.7 and later, Sonnet 5, Fable 5, etc. Omit it for current models.
- `top_p`, `top_k` — same deprecation as `temperature` on 4.7+ models.
- `stop_sequences` (array of strings)
- `stream` (boolean) — enables SSE streaming (§6).
- `tools` (array) — tool definitions.
- `tool_choice` (object) — `"auto"`, `"any"`, `"none"`, or a specific tool.
- `metadata` (object) — e.g. `{"user_id": "..."}`.
- `output_config` (object) — structured output / effort control (§3, and the Thinking quick reference).
- `thinking` (object) — extended/adaptive thinking configuration (§4).
- `service_tier` (string) — `"auto"` or `"standard_only"`.
- `cache_control` (object) — top-level prompt-cache control.
- `container` (string or object) — code-execution container config.

### System prompt placement

The system prompt is **not** a message with `role: "system"` in the base (non-beta) API — it is a dedicated top-level `system` field, either a plain string or an array of text blocks (the array form is needed for cache-control breakpoints):

```json
{
  "model": "claude-opus-5",
  "max_tokens": 1024,
  "system": "You are a helpful coding assistant. Always provide examples in Python.",
  "messages": [
    { "role": "user", "content": "How do I read a JSON file?" }
  ]
}
```

Note: Some current models (Opus 5, Opus 4.8, Fable 5, Mythos 5 — not Sonnet 5) additionally support appending `{"role": "system", "content": "..."}` as an entry inside the `messages` array for **mid-conversation** operator instructions (preserves prompt cache). This is separate from the top-level `system` field and not required for a basic adapter.

### Messages array format

Each entry needs `role` (`"user"` or `"assistant"`) and `content` (either a plain string or an array of content blocks):

```json
{ "role": "user", "content": "Hello" }
```

Or with content blocks (needed for images, tool results, etc.):

```json
{
  "role": "user",
  "content": [
    { "type": "text", "text": "What's in this image?" },
    {
      "type": "image",
      "source": {
        "type": "base64",
        "media_type": "image/jpeg",
        "data": "base64-encoded-data"
      }
    }
  ]
}
```

Rules:
- The conversation must start with a `user` message.
- Consecutive same-role messages are combined into a single turn by the API.
- Content block `type` values include: `text`, `image`, `document`, `tool_use`, `tool_result`, `thinking`, `server_tool_use`.
- **No assistant message prefill** on current-generation models (Fable 5, Opus 5, Sonnet 5, and the 4.6/4.7/4.8 family) — sending a request whose last message is a non-empty `assistant` turn returns HTTP 400 `invalid_request_error` with message: *"This model does not support assistant message prefill. The conversation must end with a user message."*

---

## 3. Structured / JSON output

Anthropic **does** have a native structured-output feature: `output_config.format` with `type: "json_schema"`. The older top-level `output_format` parameter is deprecated — use `output_config.format` on `POST /v1/messages`.

### Request shape

```json
{
  "model": "claude-opus-5",
  "max_tokens": 1024,
  "messages": [
    {
      "role": "user",
      "content": "Extract the key information from this email: John Smith (john@example.com) is interested in our Enterprise plan and wants to schedule a demo for next Tuesday at 2pm."
    }
  ],
  "output_config": {
    "format": {
      "type": "json_schema",
      "schema": {
        "type": "object",
        "properties": {
          "name": { "type": "string" },
          "email": { "type": "string" },
          "plan_interest": { "type": "string" },
          "demo_requested": { "type": "boolean" }
        },
        "required": ["name", "email", "plan_interest", "demo_requested"],
        "additionalProperties": false
      }
    }
  }
}
```

### Response

The result still comes back as a normal `text` content block, but its `text` string is guaranteed-valid JSON matching your schema — you must `JSON.parse()` it yourself:

```json
{
  "content": [
    {
      "type": "text",
      "text": "{\"name\": \"John Smith\", \"email\": \"john@example.com\", \"plan_interest\": \"Enterprise\", \"demo_requested\": true}"
    }
  ],
  "stop_reason": "end_turn"
}
```

**Models supporting JSON outputs / strict tool use** (as documented): `claude-opus-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-6`, `claude-sonnet-5`, `claude-sonnet-4-6`, `claude-sonnet-4-5-20250929`, `claude-opus-4-5-20251101`, `claude-haiku-4-5-20251001`, `claude-fable-5`, `claude-mythos-5`, `claude-mythos-preview`.

**Caveat:** `output_config.format` is incompatible with document `citations: {enabled: true}` (returns 400 if both set).

**Related — strict tool use** (separate mechanism, also constrains output): set `"strict": true` as a top-level field on a tool definition (alongside `name`/`description`/`input_schema`), with `additionalProperties: false` and `required` set in the schema, to guarantee `tool_use.input` validates exactly against the schema.

**Fallback for models/cases without structured outputs:** prompt-based JSON — instruct the model in the system prompt to "respond with only valid JSON matching this schema: ..." and parse defensively; this remains necessary for older models not in the list above.

---

## 4. Extended thinking

Two distinct modes exist depending on model generation. **For current models (Claude 5 family and the 4.6/4.7/4.8 family), use adaptive thinking, not the legacy fixed-budget mode.**

### Adaptive thinking (current models: Fable 5, Mythos 5, Opus 5, Opus 4.8, Opus 4.7, Opus 4.6, Sonnet 5, Sonnet 4.6)

```json
{
  "thinking": { "type": "adaptive", "display": "summarized" }
}
```

- `type: "adaptive"` — Claude decides whether/how much to think per request. This is the **only** supported "on" mode for thinking on Opus 4.7/4.8, Sonnet 5, and (with caveats) Fable 5/Mythos 5.
- `display` — controls whether the model's reasoning content is exposed in the response/stream:
  - `"summarized"` — returns a readable summary of the reasoning in `thinking` content blocks.
  - `"omitted"` (**default** on Fable 5, Mythos 5, Opus 5, Opus 4.8, Opus 4.7, Sonnet 5) — `thinking` blocks are still present in the response/stream but their text content is empty. If you want to show reasoning progress in a UI, you must explicitly set `display: "summarized"`.
- The **raw** chain of thought is never returned by the API on any model — `"summarized"` gives a model-generated summary, not the literal internal reasoning.
- No `budget_tokens` on current models — sending `thinking: {"type": "enabled", "budget_tokens": N}` to Opus 4.7+/Sonnet 5/Fable 5/Mythos 5 returns HTTP 400 with: `"thinking.type.enabled" is not supported for this model. Use "thinking.type.adaptive" and "output_config.effort" to control thinking behavior.`
- Depth of thinking is instead controlled via `output_config.effort`: `"low" | "medium" | "high" | "xhigh" | "max"` (default `"high"`).
- On **Claude Fable 5 / Mythos 5**, thinking is *always on* — explicitly sending `thinking: {"type": "disabled"}` returns 400. Omit the `thinking` param entirely (or send `{type: "adaptive"}`) and control depth via `output_config.effort` only.
- On **Claude Opus 5**, `{type: "disabled"}` is accepted only at effort `high` or below (400 at `xhigh`/`max`); thinking is on by default when `thinking` is omitted (unlike Opus 4.8/4.7, where omitting it means no thinking).

### Legacy fixed-budget thinking (older models only — Sonnet 4.5, Opus 4.5, Haiku 4.5, and earlier; deprecated-but-functional on Opus 4.6/Sonnet 4.6)

```json
{
  "thinking": { "type": "enabled", "budget_tokens": 10000 }
}
```

- `budget_tokens`: minimum 1024, must be **less than** `max_tokens` (thinking tokens count against `max_tokens`), except with interleaved thinking (tool use) where the budget can span the whole turn and exceed `max_tokens`.
- Rejected outright (400) on Claude 4.7 and later models, Sonnet 5, Fable 5, Mythos 5.

### Response shape (non-streaming)

Thinking content appears as its own content block, ahead of the `text` block, in the `content` array:

```json
{
  "content": [
    { "type": "thinking", "thinking": "I need to find the GCD of 1071 and 462...", "signature": "EqQBCgIYAhIM..." },
    { "type": "text", "text": "The greatest common divisor of 1071 and 462 is **21**." }
  ]
}
```

- `signature` is an opaque integrity token; when replaying thinking blocks back to the API in multi-turn/tool-use flows, they **must be passed back byte-for-byte unmodified** — editing, reordering, or filtering them (even ones with empty `thinking` text) causes a 400 error.

### Streaming shape

See §6 for the general SSE flow. Thinking-specific deltas:

```
event: content_block_start
data: {"type": "content_block_start", "index": 0, "content_block": {"type": "thinking", "thinking": "", "signature": ""}}

event: content_block_delta
data: {"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "I need to find the GCD..."}}

event: content_block_delta
data: {"type": "content_block_delta", "index": 0, "delta": {"type": "signature_delta", "signature": "EqQBCgIYAhIM..."}}

event: content_block_stop
data: {"type": "content_block_stop", "index": 0}
```

- A `signature_delta` event always arrives right before `content_block_stop` for a thinking block, even under `display: "omitted"` (in which case no `thinking_delta` events are sent at all — just the empty open, the signature, and the close).

---

## 5. Vision / image input format

Three source types for `image` content blocks: `base64`, `url`, and `file` (Files API `file_id`). For a browser extension without a Files-API upload step, `base64` is the most direct.

### Base64 (exact shape)

```json
{
  "type": "image",
  "source": {
    "type": "base64",
    "media_type": "image/jpeg",
    "data": "<base64-encoded-bytes-no-data-uri-prefix>"
  }
}
```

Full example, embedded in a user message:

```json
{
  "model": "claude-opus-5",
  "max_tokens": 1024,
  "messages": [
    {
      "role": "user",
      "content": [
        {
          "type": "image",
          "source": {
            "type": "base64",
            "media_type": "image/jpeg",
            "data": "$BASE64_IMAGE_DATA"
          }
        },
        { "type": "text", "text": "Describe this image." }
      ]
    }
  ]
}
```

- `data` must be the **raw base64 string** (e.g. the output of `btoa`/`FileReader.readAsDataURL` with the `data:image/...;base64,` prefix stripped) — no newlines.
- Supported `media_type` values: `image/jpeg`, `image/png`, `image/gif`, `image/webp`. Animations unsupported (first frame only used).
- Size limits: 10 MB base64-encoded per image on the direct Claude API (5 MB on Bedrock/Vertex). Max 8000×8000 px dimensions. Up to 100 images per request on 200k-context models, 600 on others (but the overall 32 MB request-size cap usually binds first for many images).
- Image-then-text ordering in content blocks performs slightly better than text-then-image, per docs guidance, though both work.

### URL source (alternative, no base64 needed)

```json
{
  "type": "image",
  "source": { "type": "url", "url": "https://example.com/image.png" }
}
```

---

## 6. Streaming

### Enabling

Set `"stream": true` in the request body. The response is `text/event-stream` (SSE).

### Overall event flow

1. `message_start` — a `Message` object with empty `content`.
2. Per content block: `content_block_start` → one or more `content_block_delta` → `content_block_stop`. Each block carries an `index` matching its position in the final `content` array.
3. One or more `message_delta` events — top-level changes to the final message (`stop_reason`, cumulative `usage`).
4. A final `message_stop` event.
5. `ping` events may appear anywhere in the stream and should be ignored.

### Basic text streaming — verbatim example

Request:
```json
{
  "model": "claude-opus-5",
  "messages": [{ "role": "user", "content": "Hello" }],
  "max_tokens": 256,
  "stream": true
}
```

Response (SSE):
```
event: message_start
data: {"type": "message_start", "message": {"id": "msg_1nZdL29xx5MUA1yADyHTEsnR8uuvGzszyY", "type": "message", "role": "assistant", "content": [], "model": "claude-opus-5", "stop_reason": null, "stop_sequence": null, "usage": {"input_tokens": 25, "output_tokens": 1}}}

event: content_block_start
data: {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}

event: ping
data: {"type": "ping"}

event: content_block_delta
data: {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Hello"}}

event: content_block_delta
data: {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "!"}}

event: content_block_stop
data: {"type": "content_block_stop", "index": 0}

event: message_delta
data: {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": null}, "usage": {"output_tokens": 15}}

event: message_stop
data: {"type": "message_stop"}
```

### Content-block delta shapes

**Text delta:**
```
event: content_block_delta
data: {"type": "content_block_delta","index": 0,"delta": {"type": "text_delta", "text": "ello frien"}}
```

**Tool-use / input JSON delta** (partial JSON strings — accumulate then `JSON.parse` on `content_block_stop`):
```
event: content_block_delta
data: {"type": "content_block_delta","index": 1,"delta": {"type": "input_json_delta","partial_json": "{\"location\": \"San Fra"}}}
```

**Thinking delta:**
```
event: content_block_delta
data: {"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "I need to find the GCD of 1071 and 462..."}}
```

**Signature delta** (thinking-block integrity token, sent immediately before that block's `content_block_stop`):
```
event: content_block_delta
data: {"type": "content_block_delta", "index": 0, "delta": {"type": "signature_delta", "signature": "EqQBCgIYAhIM1gbcDa9GJwZA2b3hGgxBdjrkzLoky3dl1pkiMOYds..."}}
```

### message_delta / message_stop

`message_delta` carries top-level changes including the final `stop_reason` and **cumulative** `usage` (not incremental):

```
event: message_delta
data: {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": null}, "usage": {"output_tokens": 15}}
```

For thinking requests, `usage.output_tokens_details.thinking_tokens` appears only on this final `message_delta` event.

`message_stop` has no payload beyond its type:
```
event: message_stop
data: {"type": "message_stop"}
```

### Mid-stream errors

Errors can arrive as an `error` SSE event **after** the initial HTTP 200 has already been sent — this does not follow normal HTTP-status error handling:

```
event: error
data: {"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}}
```

This is the same envelope shape as a non-streaming error body (§8), just delivered as an SSE event instead of the HTTP response body/status.

### Unknown event types

Per Anthropic's API versioning policy, new event types may be added over time — client code should ignore/skip any `event:` name it doesn't recognize rather than erroring.

---

## 7. Non-streaming response shape

```json
{
  "id": "msg_013Zva2CMHLNAmqYWvI1xIK9",
  "type": "message",
  "role": "assistant",
  "content": [
    { "type": "text", "text": "Response text here" }
  ],
  "model": "claude-opus-4-5",
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": {
    "input_tokens": 10,
    "output_tokens": 20,
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 0
  }
}
```

- The primary answer text lives in `content`, an array of content blocks; find the block(s) with `type: "text"` and read `.text`. A response can contain multiple blocks (e.g. `thinking` then `text`, or `text` then `tool_use`).
- `stop_reason` values:
  - `"end_turn"` — completed naturally.
  - `"max_tokens"` — hit the `max_tokens` cap (output likely truncated mid-thought).
  - `"stop_sequence"` — hit a custom stop sequence.
  - `"tool_use"` — model wants to call a tool; inspect `content` for `tool_use` blocks, execute, and send back `tool_result` blocks in a new user message.
  - `"pause_turn"` — agentic/long-running flow paused; can be resumed.
  - `"refusal"` — safety-classifier decline (Fable 5/Mythos 5 in particular); check `stop_details` (see below) before reading `content`.
- `stop_details` — populated **only** when `stop_reason == "refusal"` (fields: `type: "refusal"`, `category`, `explanation`); `null` for every other `stop_reason`. Always null-guard before reading.
- `usage` fields: `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens` (and, for thinking requests, a nested `output_tokens_details.thinking_tokens`).

---

## 8. Error response shape (non-2xx)

Always JSON, with a top-level `error` object with `type` and `message`, plus a top-level `request_id`:

```json
{
  "type": "error",
  "error": {
    "type": "not_found_error",
    "message": "The requested resource could not be found."
  },
  "request_id": "req_011CSHoEeqs5C35K2UUqR7Fy"
}
```

### Status codes and error types

| HTTP status | `error.type` | Meaning |
|---|---|---|
| 400 | `invalid_request_error` | Malformed/invalid request; also used for other unlisted 4xx cases; also returned when an org/workspace spend limit is hit (except the Claude Code workspace, which can return 429 instead) |
| 401 | `authentication_error` | Bad/expired/revoked API key (or bad AWS SigV4 credentials on Claude Platform on AWS) |
| 402 | `billing_error` | Billing/payment issue |
| 403 | `permission_error` | API key lacks permission for the resource |
| 404 | `not_found_error` | Resource/endpoint not found |
| 409 | `conflict_error` | Conflicts with current resource state (e.g. concurrent modification) |
| 413 | `request_too_large` | Request exceeds max byte size for the endpoint (32 MB for Messages) |
| 429 | `rate_limit_error` | Rate limit, monthly spend cap, or Claude Code workspace spend limit hit |
| 500 | `api_error` | Unexpected internal error — retry with exponential backoff |
| 504 | `timeout_error` | Request timed out — use streaming or Batches for long-running requests |
| 529 | `overloaded_error` | API temporarily overloaded (high traffic across all users) |

Every response also carries a `request-id` HTTP header (same value as the `request_id` body field on errors) — useful to log for support requests.

**Common validation error message texts** worth pattern-matching on in an adapter's error handling (all HTTP 400 `invalid_request_error`):
- Prefill sent to a model that forbids it: `"This model does not support assistant message prefill. The conversation must end with a user message."`
- Modified thinking/redacted_thinking blocks replayed: message starts with the offending block's position (e.g. `messages.1.content.0`) followed by `"thinking" or "redacted_thinking" blocks in the latest assistant message cannot be modified...`
- Legacy `thinking.type.enabled` sent to a 4.7+/Sonnet-5/Fable-5 model: `"thinking.type.enabled" is not supported for this model. Use "thinking.type.adaptive" and "output_config.effort" to control thinking behavior.`
- `thinking.type.adaptive` sent to a pre-adaptive model: `adaptive thinking is not supported on this model`
- `thinking.type.disabled` sent to Fable 5 / Mythos 5: `"thinking.type.disabled" is not supported for this model. Thinking defaults to adaptive mode when not specified...`

---

## 9. Models endpoint

**Yes**, `GET /v1/models` exists and requires the same auth headers as Messages (`x-api-key` + `anthropic-version`; no request body).

```
GET https://api.anthropic.com/v1/models
```

```
curl https://api.anthropic.com/v1/models \
    -H 'anthropic-version: 2023-06-01' \
    -H "X-Api-Key: $ANTHROPIC_API_KEY"
```

### Query parameters
- `after_id` / `before_id` (string) — cursor pagination.
- `limit` (number) — default 20, range 1–1000.

### Response shape

```json
{
  "data": [
    {
      "id": "claude-opus-5",
      "capabilities": {
        "batch": { "supported": true },
        "citations": { "supported": true },
        "code_execution": { "supported": true },
        "context_management": {
          "clear_thinking_20251015": { "supported": true },
          "clear_tool_uses_20250919": { "supported": true },
          "compact_20260112": { "supported": true },
          "supported": true
        },
        "effort": {
          "high": { "supported": true },
          "low": { "supported": true },
          "max": { "supported": true },
          "medium": { "supported": true },
          "supported": true,
          "xhigh": { "supported": true }
        },
        "image_input": { "supported": true },
        "pdf_input": { "supported": true },
        "structured_outputs": { "supported": true },
        "thinking": {
          "supported": true,
          "types": {
            "adaptive": { "supported": true },
            "enabled": { "supported": true }
          }
        }
      },
      "created_at": "2026-07-24T00:00:00Z",
      "display_name": "Claude Opus 5",
      "max_input_tokens": 1000000,
      "max_tokens": 128000,
      "type": "model"
    }
  ],
  "first_id": "first_id",
  "has_more": true,
  "last_id": "last_id"
}
```

(Note: the live doc's example response shows `"max_input_tokens": 0, "max_tokens": 0"` as placeholder-looking zeros — real API responses populate these with the model's actual context window / max output token values, e.g. 1,000,000 and 128,000 for `claude-opus-5`. Treat the `0` values in the doc's example as documentation artifacts, not real data — this is UNVERIFIED against a live response and should be confirmed empirically once you have API access.)

This is useful for a Chrome extension adapter to do live capability discovery (e.g. does this model support `thinking`/`effort`/`structured_outputs`) rather than hardcoding a model table.

---

## 10. Current model IDs and deprecations (as of 2026-08-23)

### Active, current-generation models

| Model | API model ID | Context window | Max output |
|---|---|---|---|
| Claude Fable 5 | `claude-fable-5` | 1M tokens | 128K |
| Claude Mythos 5 (invitation-only, Project Glasswing) | `claude-mythos-5` | 1M tokens | 128K |
| Claude Opus 5 | `claude-opus-5` | 1M tokens | 128K |
| Claude Sonnet 5 | `claude-sonnet-5` | 1M tokens | 128K |
| Claude Haiku 4.5 | `claude-haiku-4-5-20251001` (alias: `claude-haiku-4-5`) | 200K tokens | 64K |

### Active legacy models (still supported, not recommended for new integrations)

| Model | API model ID |
|---|---|
| Claude Opus 4.8 | `claude-opus-4-8` |
| Claude Opus 4.7 | `claude-opus-4-7` |
| Claude Opus 4.6 | `claude-opus-4-6` |
| Claude Sonnet 4.6 | `claude-sonnet-4-6` |
| Claude Sonnet 4.5 | `claude-sonnet-4-5-20250929` (alias: `claude-sonnet-4-5`) |
| Claude Opus 4.5 | `claude-opus-4-5-20251101` (alias: `claude-opus-4-5`) |

Every model ID is a pinned snapshot (dateless IDs starting with the 4.6 generation are still pinned snapshots, not evergreen pointers — despite lacking a date suffix).

### Retired models (requests fail — HTTP error, not silently routed)

| Retired model ID | Deprecated on | Retired on | Recommended replacement |
|---|---|---|---|
| `claude-opus-4-1-20250805` | 2026-06-05 | 2026-08-05 | `claude-opus-4-8` |
| `claude-opus-4-20250514` | 2026-04-14 | 2026-06-15 | `claude-opus-4-8` |
| `claude-sonnet-4-20250514` | 2026-04-14 | 2026-06-15 | `claude-sonnet-4-6` |
| `claude-3-7-sonnet-20250219` | 2025-10-28 | 2026-02-19 | `claude-sonnet-4-6` |
| `claude-3-5-haiku-20241022` | 2025-12-19 | 2026-02-19 | `claude-haiku-4-5-20251001` |
| `claude-3-haiku-20240307` | 2026-02-19 | 2026-04-20 | `claude-haiku-4-5-20251001` |
| `claude-3-5-sonnet-20240620` | 2025-08-13 | 2025-10-28 | `claude-sonnet-4-6` |
| `claude-3-5-sonnet-20241022` | 2025-08-13 | 2025-10-28 | `claude-sonnet-4-6` |
| `claude-3-opus-20240229` | 2025-06-30 | 2026-01-05 | `claude-opus-4-8` |
| `claude-2.0`, `claude-2.1` | 2025-01-21 | 2025-07-21 | `claude-opus-4-8` |
| `claude-3-sonnet-20240229` | 2025-01-21 | 2025-07-21 | `claude-sonnet-4-6` |
| `claude-1.0`–`claude-1.3`, `claude-instant-1.0`–`1.2` | 2024-09-04 | 2024-11-06 | `claude-haiku-4-5-20251001` |

Also deprecated (functional, but discouraged): `claude-mythos-preview` → migrate to `claude-mythos-5`.

**Important for a browser adapter:** requests to a retired model ID fail outright (do not assume graceful fallback). If you hardcode a default model, prefer `claude-opus-5` or `claude-sonnet-5`; if you want to future-proof against retirements without redeploying the extension, query `GET /v1/models` at runtime (§9) rather than hardcoding IDs, or at minimum fail with a clear error message pointing at the model-deprecations page when the API returns 404/400 for an unrecognized/retired model.

**Parameter deprecation note:** `temperature`, `top_p`, `top_k` are deprecated on Claude Opus 4.7 and later (including Fable 5, Opus 5, Sonnet 5) — sending a non-default value returns HTTP 400. Omit these params for current models; use prompting to steer behavior instead.
