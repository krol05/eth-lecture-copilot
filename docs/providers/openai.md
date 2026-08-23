# OpenAI API — ground truth for browser-fetch adapter

Retrieval date: 2026-08-23

Sources consulted (some fetched directly, some via `r.jina.ai` proxy due to 403s from `platform.openai.com` on direct WebFetch, some via the `openai-python` SDK source on GitHub which mirrors the generated OpenAPI spec and is treated as authoritative for exact field names):
- https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create
- https://developers.openai.com/api/docs/guides/reasoning
- https://developers.openai.com/api/docs/guides/migrate-to-responses
- https://platform.openai.com/docs/api-reference/chat (via r.jina.ai)
- https://platform.openai.com/docs/api-reference/errors (via r.jina.ai)
- https://platform.openai.com/docs/guides/error-codes (via r.jina.ai)
- https://platform.openai.com/docs/models (via r.jina.ai)
- https://platform.openai.com/docs/deprecations (via r.jina.ai)
- https://raw.githubusercontent.com/openai/openai-python/main/src/openai/types/chat/completion_create_params.py
- https://raw.githubusercontent.com/openai/openai-python/main/src/openai/types/chat/chat_completion.py
- https://raw.githubusercontent.com/openai/openai-python/main/src/openai/types/chat/chat_completion_chunk.py
- https://raw.githubusercontent.com/openai/openai-python/main/src/openai/types/chat/chat_completion_content_part_image_param.py
- https://raw.githubusercontent.com/openai/openai-python/main/src/openai/types/shared_params/response_format_json_schema.py
- https://raw.githubusercontent.com/openai/openai-python/main/src/openai/_exceptions.py
- General web search (community threads, OpenAI Help Center, Wikipedia model pages) used for corroboration where docs pages returned incomplete/JS-rendered content.

**Caveat**: `platform.openai.com/docs/*` pages are a JS-rendered SPA; several fetches (direct and proxied) returned partial/navigation-only content instead of full body text. Where a claim could not be pinned to a verbatim doc excerpt, it is marked **UNVERIFIED** below. Treat this file as strong-but-not-100%-certified ground truth; spot-check against a live `curl` call before hardening error-handling code paths.

## 1. Endpoint: Chat Completions vs Responses API

- **Auth header**: `Authorization: Bearer $OPENAI_API_KEY` (standard Bearer token, unchanged).
- Base host: `https://api.openai.com` (docs paths reference `/v1/chat/completions`, `/v1/responses`, `/v1/models`).
- Official current guidance (from the migration guide): **"While Chat Completions remains supported, Responses is recommended for all new projects."** There is no published sunset date for Chat Completions itself. Only the separate **Assistants API** has an announced sunset date (August 26, 2026) — do not confuse the two.
- Reasoning-model guide states: **"Reasoning models work better with the Responses API. While the Chat Completions API is still supported, you'll get improved model intelligence and performance by using Responses."** This is a performance/feature recommendation, not a hard requirement — `/v1/chat/completions` still accepts o-series and gpt-5.x models.
- Responses API requires `model` + `input` (string or array of input items) instead of `model` + `messages`, and supports a top-level `instructions` field instead of a `system`/`developer` message. Chat Completions keeps the classic `model` + `messages` shape.
- **Conclusion for this adapter**: `/v1/chat/completions` remains fully functional for all current models (including gpt-5.6 family and o-series) as of this date. No forced migration.

## 2. Request body: model, messages, token-limit param

Required fields: `model` (string) and `messages` (array of message objects).

Token cap field — **UNVERIFIED exact error text via live call, but strongly corroborated across sources**:

- `max_tokens` — present in the SDK types with docstring: *"Maximum tokens in chat completion. Deprecated in favor of `max_completion_tokens`; incompatible with o-series models."* Sending `max_tokens` to an o-series/reasoning model returns a 400 `invalid_request_error` (community reports and Azure docs corroborate: "reasoning models require `max_completion_tokens`... Chat Completions API"). Non-reasoning models (gpt-4o-class, gpt-5.6 non-reasoning variants) still accept `max_tokens` for backward compatibility.
- `max_completion_tokens` — *"Upper bound for tokens generated for completion, including visible and reasoning tokens."* Required (or at least the correct field) for o-series and reasoning gpt-5.x variants; caps **total** output tokens (reasoning tokens included), not just visible text.
- **Omitting the cap entirely is valid** — both fields are `Optional[int]`; there is no required minimum. Absence just means the model can generate up to the model's max output limit.

```json
{
  "model": "gpt-5.6-terra",
  "messages": [
    {"role": "developer", "content": "You are a concise assistant."},
    {"role": "user", "content": "Summarize photosynthesis in one sentence."}
  ],
  "max_completion_tokens": 500
}
```

Practical adapter rule: send `max_completion_tokens` for any model whose id starts with `o1`, `o3`, `o4`, or is in the `gpt-5*` reasoning-capable family; send `max_tokens` (or omit) for older non-reasoning models (`gpt-4o`, `gpt-4-turbo`, etc.).

## 3. Reasoning models (o-series, gpt-5.x family)

- `reasoning_effort` (top-level Chat Completions param): *"Constrains effort on reasoning for reasoning models. Currently supported values are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`."* (Responses API uses the nested `reasoning.effort` with the same value set.)
- `verbosity`: `"low" | "medium" | "high"`, default `"medium"` — controls response length/verbosity, separate from reasoning effort.
- **Role change**: *"With o1 models and newer, developer messages replace the previous system messages."* A `developer` role message is now the recommended way to give system-level instructions; `system` role is still accepted on the latest reasoning models "to make migration easier," but the docs explicitly warn: *"you should not use both a developer message and a system message in the same API request."*
- **Rejected sampling parameters** on reasoning models (400 `invalid_request_error`, `type: "invalid_request_error"`, `param` naming the offending field): `temperature`, `top_p`, `frequency_penalty`, `presence_penalty`, `logit_bias`, `n`, `logprobs`, `top_logprobs`. Community reports (o3-mini) show the exact message shape:

```json
{
  "error": {
    "message": "Unsupported parameter: 'temperature' is not supported with this model.",
    "type": "invalid_request_error",
    "param": "temperature",
    "code": "unsupported_parameter"
  }
}
```
(`code` value **UNVERIFIED** verbatim — seen in community reports as similar to `unsupported_parameter`; treat presence/absence of `code` as unreliable and key off `type`/`param`/message substring instead.)

- `stop` docstring explicitly notes: *"Not supported with latest reasoning models `o3` and `o4-mini`."*
- On newer gpt-5.6-class models there is a specific interaction reported in the community: a Chat Completions request that includes function `tools` can fail unless `reasoning_effort` is set to `none` (**UNVERIFIED** — single community thread, not confirmed in official docs; treat as a possible edge case to handle defensively, not a hard rule to code against blindly).

Adapter rule of thumb: for any model id matching `o1*`, `o3*`, `o4*`, or `gpt-5*`, omit `temperature`/`top_p`/`frequency_penalty`/`presence_penalty`/`logit_bias`/`n`/`logprobs`/`stop`, use `max_completion_tokens` instead of `max_tokens`, and prefer `developer` role over `system` role (never send both).

## 4. JSON mode and Structured Outputs

Two forms of `response_format`, both confirmed via SDK types:

**Legacy JSON mode:**
```json
{ "response_format": { "type": "json_object" } }
```
Requires the word "json" to appear somewhere in the messages, or the API returns:
```json
{
  "error": {
    "message": "'messages' must contain the word 'json' in some form, to use 'response_format' of type 'json_object'.",
    "type": "invalid_request_error",
    "param": "messages",
    "code": null
  }
}
```

**Structured Outputs (recommended, strict schema enforcement):**
```json
{
  "response_format": {
    "type": "json_schema",
    "json_schema": {
      "name": "lecture_summary",
      "description": "A structured summary of a lecture segment",
      "strict": true,
      "schema": {
        "type": "object",
        "properties": {
          "title": { "type": "string" },
          "bullet_points": { "type": "array", "items": { "type": "string" } }
        },
        "required": ["title", "bullet_points"],
        "additionalProperties": false
      }
    }
  }
}
```
Field shapes (from `ResponseFormatJSONSchema` / `JSONSchema` types):
- `type`: `"json_schema"` (required, literal)
- `json_schema.name`: required string, `a-z A-Z 0-9 _ -`, max length 64
- `json_schema.description`: optional string, used by the model to understand the format's purpose
- `json_schema.schema`: `Dict[str, object]` — a JSON Schema object
- `json_schema.strict`: optional bool — when `true`, model always follows the exact schema (only a **subset of JSON Schema** is supported in strict mode — e.g. `additionalProperties: false` and all properties typically must be `required`; exact subset rules are **UNVERIFIED** in this pass, consult the Structured Outputs guide before relying on advanced schema features like `oneOf`/recursive refs).
- Model support: Structured Outputs (`json_schema`) requires a model released after ~August 2024 (gpt-4o-2024-08-06 and later, all gpt-5.x, o-series that support function calling). Older models only support `json_object`.
- **Streaming interaction**: both `json_object` and `json_schema` response formats work with `stream: true` — content arrives incrementally in `delta.content` chunks as usual; the client must buffer and parse the full concatenated string as JSON only once the stream completes (there is no partial-JSON-validation guarantee mid-stream). **UNVERIFIED**: exact behavior/guarantees for partial validity of intermediate chunks — treat mid-stream JSON as unparseable until `[DONE]`.

## 5. Vision input (image content parts)

From `ChatCompletionContentPartImageParam` (SDK types, verified):
```json
{
  "role": "user",
  "content": [
    { "type": "text", "text": "What is in this image?" },
    {
      "type": "image_url",
      "image_url": {
        "url": "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQAB...",
        "detail": "auto"
      }
    }
  ]
}
```
- `type`: literal `"image_url"` (required)
- `image_url.url`: required string — *"Either a URL of the image or the base64 encoded image data."* Base64 form uses the standard data-URL prefix `data:<mime>;base64,<data>` (e.g. `data:image/png;base64,...`, `data:image/jpeg;base64,...`).
- `image_url.detail`: optional, one of `"auto" | "low" | "high"` — controls image processing fidelity/token cost.
- An optional `prompt_cache_breakpoint` field also exists on the content part (marks end of a reusable cached prefix) — **UNVERIFIED** as broadly relevant to a browser adapter; safe to ignore.

## 6. Streaming

Request: `"stream": true`. Optional `stream_options: { "include_usage": true }` to get a final usage-only chunk.

Response is Server-Sent Events (`Content-Type: text/event-stream`), each event body is `data: <json>\n\n`, terminated by a final literal sentinel line:
```
data: [DONE]

```

Each chunk is a `chat.completion.chunk` object:
```json
{
  "id": "chatcmpl-abc123",
  "object": "chat.completion.chunk",
  "created": 1734000000,
  "model": "gpt-5.6-terra",
  "choices": [
    {
      "index": 0,
      "delta": { "role": "assistant", "content": "Hello" },
      "finish_reason": null,
      "logprobs": null
    }
  ]
}
```
- `choices[].delta`: partial message — fields (`role`, `content`, `tool_calls`, `refusal`) appear incrementally; the first chunk typically carries `delta.role`, subsequent chunks carry `delta.content` fragments, the last content-bearing choice chunk has `delta: {}` and a non-null `finish_reason`.
- With `stream_options.include_usage: true`, a **final extra chunk** is sent after the last content chunk with an empty `choices: []` array and a populated `usage` object (mirrors the non-streaming `usage` shape) — then the `[DONE]` sentinel follows.
- `id`/`object`/`created`/`model` are repeated per-chunk (same `id` across the whole stream). `object` is always `"chat.completion.chunk"`.
- **Mid-stream errors**: **UNVERIFIED exact wire shape.** Community/ecosystem behavior indicates a mid-stream failure (e.g. content filter trip, backend error) typically either (a) terminates the SSE stream early with an HTTP-level error before any bytes are sent (if it happens before generation starts), or (b) sends a final chunk with `finish_reason: "content_filter"` and then `[DONE]`, without a distinct SSE `error` event type documented for Chat Completions. Do not assume a `event: error` SSE frame exists for this endpoint — build the adapter to also handle the SSE connection simply closing/erroring without a clean `[DONE]`.

## 7. Non-streaming response shape

```json
{
  "id": "chatcmpl-abc123",
  "object": "chat.completion",
  "created": 1734000000,
  "model": "gpt-5.6-terra",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Photosynthesis converts light energy into chemical energy."
      },
      "finish_reason": "stop",
      "logprobs": null
    }
  ],
  "usage": {
    "prompt_tokens": 20,
    "completion_tokens": 12,
    "total_tokens": 32,
    "completion_tokens_details": { "reasoning_tokens": 0 },
    "prompt_tokens_details": { "cached_tokens": 0 }
  },
  "system_fingerprint": "fp_abc123",
  "service_tier": "default"
}
```
- `choices[].finish_reason` possible values (from SDK type, verbatim): `"stop"`, `"length"`, `"tool_calls"`, `"content_filter"`, and the deprecated `"function_call"`.
  - `stop`: natural completion or hit a `stop` sequence
  - `length`: hit the token cap (`max_tokens`/`max_completion_tokens`)
  - `content_filter`: content omitted/filtered for safety
  - `tool_calls`: model invoked a tool/function
  - `function_call`: deprecated legacy function-calling equivalent
- `usage.completion_tokens_details.reasoning_tokens`: present for reasoning models — internal reasoning tokens are counted separately from visible `completion_tokens` but both count toward `max_completion_tokens`.
- `choices` is an array because `n > 1` can request multiple completions; default `n` is 1.

## 8. Error envelope and status codes

Standard envelope (confirmed via community examples matching the documented `error.{message,type,param,code}` shape and the SDK's exception typing):
```json
{
  "error": {
    "message": "Invalid parameter: 'response_format' of type 'json_object' is not supported with this model.",
    "type": "invalid_request_error",
    "param": "response_format",
    "code": null
  }
}
```
`code` is frequently `null` for generic invalid-request errors and populated with a machine-readable string for specific known conditions (e.g. billing/quota codes below).

HTTP status → SDK exception mapping (verbatim from `openai-python` `_exceptions.py`):
| Status | Exception | Meaning |
|---|---|---|
| 400 | `BadRequestError` | Invalid request (bad params, unsupported param for model, etc.) |
| 401 | `AuthenticationError` | Invalid/missing API key, wrong org |
| 403 | `PermissionDeniedError` | Access forbidden (e.g. unsupported country/region) |
| 404 | `NotFoundError` | Resource/model not found (bad model id) |
| 409 | `ConflictError` | Conflict |
| 422 | `UnprocessableEntityError` | Invalid entity data |
| 429 | `RateLimitError` | Rate limit **or** quota/billing exhaustion (see below) |
| 500 | `InternalServerError` | Server-side error |
| 503 | (5xx, `InternalServerError`) | Engine overload / high traffic |

**429 rate limit vs quota — distinguish by `error.type`/`error.code`, not just status code:**
- Rate limit (true "too fast"): message like "You are sending requests too quickly" — respect `Retry-After` header, back off and retry.
- Quota/billing exhaustion (retrying will NOT help until the account is fixed): `error.type` such as `insufficient_quota`, and `error.code` values reported as `credit_balance_exhausted`, `organization_spend_limit_exceeded`, `project_spend_limit_exceeded`, `organization_usage_limit_exceeded`. Docs explicitly warn: *"Retrying billing, spend, or quota errors won't restore API access. Update the relevant credits or limits before sending another request."*
- 401 causes (per error-codes guide): invalid authentication, incorrect API key, missing organization membership, IP not authorized.
- 404 model: requesting a model id that doesn't exist or isn't available to the account returns 404, `type: "invalid_request_error"` (exact body **UNVERIFIED** verbatim, but consistent with the general envelope and the `NotFoundError` SDK mapping).

Useful response headers: `x-request-id` (for support/troubleshooting) and rate-limit headers tracking request/token budgets (exact header names, e.g. `x-ratelimit-remaining-requests`, **UNVERIFIED** in this pass — not confirmed verbatim from a fully-rendered docs page).

## 9. GET /v1/models

Request: `GET https://api.openai.com/v1/models` with the same `Authorization: Bearer` header. Response:
```json
{
  "object": "list",
  "data": [
    {
      "id": "gpt-5.6-terra",
      "object": "model",
      "created": 1686935002,
      "owned_by": "openai",
      "shutdown_date": null
    }
  ]
}
```
- Top-level: `object: "list"`, `data: [...]`.
- Each model entry: `id`, `object: "model"`, `created` (unix seconds), `owned_by`, and a `shutdown_date` field (null if no retirement scheduled, else a date string) — this `shutdown_date` field's exact presence/format is **UNVERIFIED** as a stable documented field (surfaced via a search snippet, not a directly fetched doc page); don't rely on it being present for every model.
- `GET /v1/models/{model}` (retrieve single model) returns the same per-model object shape.

## 10. Current model IDs (August 2026) and deprecations

Flagship family in production as of this date is **GPT-5.6**, released July 9, 2026, replacing the GPT-5.5/5.1 line (GPT-5.1 was already pulled from ChatGPT by March 11, 2026). Three tiers, confirmed from the live models page:
- `gpt-5.6-sol` (top/frontier tier — also referenced by the bare alias `gpt-5.6`) — "Frontier model for complex professional work"
- `gpt-5.6-terra` — balances intelligence and cost (mid tier)
- `gpt-5.6-luna` — optimized for cost-sensitive workloads (small/cheap tier)
- `gpt-5.6-cyber` — cybersecurity-specialized variant

These are reasoning-capable models — treat as subject to the section 3 restrictions (no `temperature`/`top_p`/etc., use `max_completion_tokens`, `reasoning_effort` applies).

Other current/adjacent models seen on the models page: `gpt-realtime-2.1`, `gpt-realtime-2.1-mini`, `gpt-realtime-2`, `gpt-realtime-translate`, `gpt-realtime-1.5` (voice/realtime), `gpt-transcribe`, `gpt-live-transcribe`, `gpt-realtime-whisper`, `gpt-4o-transcribe`, `gpt-4o-mini-transcribe` (transcription), `gpt-image-2`, `gpt-4o-mini-tts`. `gpt-realtime-mini` was flagged as deprecated on that page. **UNVERIFIED**: whether an o-series id (e.g. `o3`, `o4-mini`) is still separately listed as a current/available model alongside gpt-5.6, versus fully folded into the gpt-5.6 reasoning line — treat any hardcoded `o3`/`o4-mini` references in the adapter as needing a live-list check (`GET /v1/models`) rather than an assumption.

**Deprecations (from the deprecations page, shutdown dates as fetched):**
- `gpt-4-0613`, `gpt-4-turbo`: shutdown date **October 23, 2026** — replacement `gpt-5.6-sol`. (This is roughly two months after this doc's retrieval date — treat gpt-4/gpt-4-turbo as imminently end-of-life.)
- `gpt-3.5-turbo-0125`: shutdown date **October 23, 2026** — replacement `gpt-5.6-terra`. **gpt-3.5-turbo is effectively end-of-life.**
- `gpt-4o-2024-05-13`: shutdown date **October 23, 2026** — replacement `gpt-5.6-sol`. Note this is a dated snapshot id; the bare `gpt-4o` alias's status was **not independently confirmed** in this pass — check `GET /v1/models` for whether `gpt-4o` still resolves before assuming it's fully retired.
- `gpt-4-32k` variants: already shut down (fetched date `2025-06-06`, in the past relative to today).
- Already fully sunset: `gpt-4-0314` (June 13, 2024), `gpt-4-vision-preview` (Dec 6, 2024), `gpt-3.5-turbo-0613` (Sep 13, 2024).
- General policy: OpenAI provides "at least 6 months" notice before retiring a generally-available model.

**Adapter implication**: if this Chrome extension currently hardcodes `gpt-4`, `gpt-3.5-turbo`, or a dated `gpt-4o-2024-05-13` id, those are all scheduled to stop working October 23, 2026 — migrate default model ids to the `gpt-5.6-*` family (or fetch `GET /v1/models` dynamically) well before then.

---

## Summary of UNVERIFIED items

- Exact `error.code` value(s) returned for "unsupported parameter on reasoning model" errors (e.g. whether it's literally `unsupported_parameter`).
- Whether Chat Completions requests with function `tools` on gpt-5.6-class models truly require `reasoning_effort: "none"` to succeed (single community report, not confirmed in official docs).
- The precise subset-of-JSON-Schema rules enforced when `response_format.json_schema.strict: true` (e.g. exact restrictions on `oneOf`, recursive `$ref`, unsupported keywords).
- Exact guarantees (or lack thereof) for partial/incremental JSON validity mid-stream when using `json_object`/`json_schema` with `stream: true`.
- Exact wire-level shape of a mid-stream error for Chat Completions SSE (no confirmed `event: error` frame type was found in docs; behavior inferred from ecosystem reports only).
- Exact 404 error body for an unknown/unavailable model id (envelope shape assumed consistent with the general error envelope, but not fetched verbatim).
- Exact rate-limit response header names (e.g. `x-ratelimit-remaining-requests`) — only their existence and general purpose were confirmed, not verbatim names.
- The `shutdown_date` field on `GET /v1/models` list entries — its presence/format was seen only in a search-engine summary, not a directly fetched raw doc/spec page.
- Whether standalone o-series model ids (`o3`, `o4-mini`, etc.) remain independently listed/available in the current model catalog alongside `gpt-5.6-*`, versus being superseded.
- Bare `gpt-4o` alias's exact current status (only the dated snapshot `gpt-4o-2024-05-13` deprecation was confirmed).
