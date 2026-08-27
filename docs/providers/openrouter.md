# OpenRouter API — ground truth for a browser-fetch adapter

Retrieval date: 2026-08-23. Sources: https://openrouter.ai/docs/quickstart, https://openrouter.ai/docs/api_reference/overview, https://openrouter.ai/docs/app-attribution, https://openrouter.ai/docs/api_reference/streaming, https://openrouter.ai/docs/api_reference/errors-and-debugging, https://openrouter.ai/docs/api_reference/parameters, https://openrouter.ai/docs/guides/best-practices/reasoning-tokens, https://openrouter.ai/docs/guides/features/structured-outputs, https://openrouter.ai/docs/guides/overview/multimodal/image-understanding, https://openrouter.ai/docs/guides/routing/provider-selection, https://openrouter.ai/docs/guides/routing/model-fallbacks, https://openrouter.ai/docs/guides/routing/model-variants/{free,nitro,floor}, https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties, and a **live** `GET https://openrouter.ai/api/v1/models` fetch performed during research (422 models returned at time of writing).

Fetched via raw markdown (`<page>.md` suffix), not through an AI summarizer, so quoted text/JSON below is verbatim from the docs unless marked otherwise.

---

## 1. Base URL, endpoint, auth, attribution headers

- Base URL: `https://openrouter.ai/api/v1`
- Chat completions endpoint: `POST /chat/completions` → full URL `https://openrouter.ai/api/v1/chat/completions`
- Auth header:
  ```
  Authorization: Bearer <OPENROUTER_API_KEY>
  ```
- Attribution headers (all optional, but recommended for a browser extension so it shows up in OpenRouter rankings/analytics under its own identity):
  - `HTTP-Referer` — your app/site URL. **Required if you want an app page created at all** — without it no ranking entry is made.
  - `X-OpenRouter-Title` — display name for your app. **This is the current (Aug 2026) header name.** The old header `X-Title` still works for backward compatibility, but new integrations should send `X-OpenRouter-Title`. Setting only the title without `HTTP-Referer` does nothing (no app page is created).
  - `X-OpenRouter-Categories` — comma-separated marketplace categories (max 2 per request, max 10 total), e.g. `cli-agent,cloud-agent`. Unrecognized values are silently dropped.
  - For `localhost` development, `X-OpenRouter-Title` must also be set for tracking to work.

Minimal curl example (from the live quickstart doc, verbatim field names):

```shell
curl https://openrouter.ai/api/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  -H "HTTP-Referer: <YOUR_SITE_URL>" \
  -H "X-OpenRouter-Title: <YOUR_SITE_NAME>" \
  -d '{
    "model": "~openai/gpt-latest",
    "messages": [
      { "role": "user", "content": "What is the meaning of life?" }
    ]
  }'
```

Note: `~openai/gpt-latest` is a "latest alias" that resolves to the newest flagship in a family (see §10). For a pinned model, use a concrete slug like `openai/gpt-5.5`.

---

## 2. Request body — messages, model ID format, max_tokens

Core fields (OpenAI-compatible):
- `messages`: array of `{ role, content }` (or multi-part `content` array for images — see §6). Roles: `system`, `user`, `assistant`, `tool`.
- `model`: string, format `vendor/model-slug`, e.g. `anthropic/claude-sonnet-5`, `openai/gpt-5.5`, `google/gemini-3.5-flash`.
  - Variant suffixes append directly to the slug: `:free`, `:nitro`, `:floor`, `:extended`, `:thinking` (legacy — no longer supported for Anthropic models, use the `reasoning` param instead), `:online`, `:exacto`, `:batch`.
  - Example: `meta-llama/llama-3.2-3b-instruct:free`, `openai/gpt-5.2:nitro`, `openai/gpt-5.2:floor`.
  - `~vendor/model-family-latest` alias slugs (e.g. `~anthropic/claude-sonnet-latest`, `~openai/gpt-latest`, `~openai/gpt-mini-latest`) always resolve to the current flagship — useful as stable defaults that don't need updating when a new model ships.
- `max_tokens`: **optional**, integer ≥ 1, "the maximum value is the context length minus the prompt length." When omitted, OpenRouter does not substitute a hardcoded value — it's passed through unset and the underlying provider applies its own default/cap.
  - `max_completion_tokens` is also accepted (same semantics); some providers require a minimum (docs mention some enforce a floor of 16).
- `stream`: optional boolean, default `false`.
- Standard sampling params also accepted and forwarded when supported by the routed provider: `temperature`, `top_p`, `top_k`, `frequency_penalty`, `presence_penalty`, `repetition_penalty`, `min_p`, `top_a`, `seed`, `stop`, `logit_bias`, `logprobs`, `top_logprobs`, `tools`, `tool_choice`, `parallel_tool_calls`, `response_format`, `structured_outputs`.
- Unsupported parameters sent to a provider that doesn't support them are, by default, silently ignored by that provider (not rejected) — see `require_parameters` in §3 to instead exclude non-supporting providers from routing.

Minimal example body:
```json
{
  "model": "anthropic/claude-sonnet-5",
  "messages": [
    { "role": "user", "content": "What is the meaning of life?" }
  ]
}
```

---

## 3. Routing extras: `models` fallback array, `provider` preferences, `transforms`

### `models` (fallback array)
Array of model IDs tried in priority order if the primary `model` errors (rate limit, downtime, moderation refusal, context-length validation error, etc.). The primary model still goes in `model`; `models` is the ordered fallback list.

```json
{
  "model": "anthropic/claude-sonnet-5",
  "models": ["openai/gpt-5.5", "gryphe/mythomax-l2-13b"],
  "messages": [{ "role": "user", "content": "..." }]
}
```
The response's `model` field reports whichever model actually served the request; billing follows that model.

### `provider` (routing preferences object)
Relevant fields for a simple adapter — most adapters only need `order`/`sort`/`allow_fallbacks`, the rest are for advanced control:

| field | type | default | purpose |
|---|---|---|---|
| `order` | `string[]` | – | Provider slugs to try in order, e.g. `["anthropic","openai"]` |
| `allow_fallbacks` | boolean | `true` | Allow other providers if the preferred one is unavailable |
| `require_parameters` | boolean | `false` | Only route to providers supporting every param in your request (relevant for structured outputs — see §4) |
| `data_collection` | `"allow"\|"deny"` | `"allow"` | Exclude providers that may retain data |
| `only` / `ignore` | `string[]` | – | Allow-list / deny-list of provider slugs |
| `sort` | `string \| object` | – | `"price"`, `"throughput"`, or `"latency"` — disables load balancing, tries in that priority order |
| `max_price` | object | – | `{ "prompt": n, "completion": n }` — hard cap, request fails if unmet (unlike soft preferences) |
| `zdr` | boolean | – | Restrict to Zero Data Retention endpoints only |
| `quantizations` | `string[]` | – | Filter by quantization level, e.g. `["int4","int8"]` |

```json
{
  "provider": {
    "order": ["anthropic", "openai"],
    "allow_fallbacks": false,
    "require_parameters": true,
    "data_collection": "deny",
    "sort": "throughput"
  }
}
```

For a simple browser adapter: `order` + `allow_fallbacks` (pin to a provider, no silent failover) and `require_parameters: true` (when using structured outputs / JSON schema, so you're not silently routed to a provider that ignores it) are the two worth wiring up. `sort`/`max_price`/`zdr`/`quantizations` are advanced/cost-control knobs, safe to skip initially.

### `transforms`
Only briefly documented as a legacy top-level array (e.g. `["middle-out"]` for context compression on models with small context windows) — largely superseded by the newer `plugins` array (web search, PDF parsing, response healing, context compression) mentioned in the API overview. Not relevant for a simple chat adapter; skip unless you hit context-length issues with long conversations on small-context models.

### Model variant suffix shortcuts (equivalent to some provider prefs)
- `:free` — free-tier variant of a model, if one exists.
- `:nitro` — shortcut for `provider.sort: "throughput"` (also admits priority-tier endpoints).
- `:floor` — shortcut for `provider.sort: "price"` (also admits flex-tier endpoints).

---

## 4. JSON mode / structured outputs

Two `response_format` modes:

**`json_object`** (loose JSON mode):
```json
{ "response_format": { "type": "json_object" } }
```
"Guarantees the message the model generates is valid JSON." You should still instruct the model to produce JSON via a system/user message — this only enforces syntactic validity, not a specific shape.

**`json_schema`** (structured outputs, strict shape enforcement):
```json
{
  "response_format": {
    "type": "json_schema",
    "json_schema": {
      "name": "weather",
      "strict": true,
      "schema": {
        "type": "object",
        "properties": {
          "location": { "type": "string", "description": "City or location name" },
          "temperature": { "type": "number", "description": "Temperature in Celsius" },
          "conditions": { "type": "string", "description": "Weather conditions description" }
        },
        "required": ["location", "temperature", "conditions"],
        "additionalProperties": false
      }
    }
  }
}
```
Response content (a JSON string inside `message.content`, same as always):
```json
{ "location": "London", "temperature": 18, "conditions": "Partly cloudy with light drizzle" }
```

### Support varies by underlying model/endpoint
"Structured outputs are supported by select models... Support is determined **per endpoint, not just per model**: the same model may be served by multiple providers, and only some of those providers may support structured outputs." Check the model's `supported_parameters` array (contains `"response_format"` and/or `"structured_outputs"`) from `GET /api/v1/models` (§9), or filter the models page with `supported_parameters=structured_outputs`.

`strict: true` enforcement quality varies by provider — "some guarantee schema-conforming output, while others translate your schema into their own structured-output format or treat it as a strong hint, so exact compliance is not guaranteed on every endpoint."

### Behavior when the model/provider doesn't support it
Per the docs' own "Error Handling" section:
1. **Model doesn't support structured outputs at all**: "The request will fail with an error indicating lack of support" — i.e. an error, not silent ignoring.
2. **Invalid JSON Schema you provided**: the model/provider returns an error.
3. By default (`require_parameters` unset/`false`), routing may still land on a provider that doesn't support `response_format` — but a *soft* preference kicks in: "a small set of parameters is used as a soft preference when choosing between providers of the same model: `tools`, `response_format`..., and `verbosity`. If some of a model's providers support [it] and others don't, the request is only routed to the supporting providers. If **none** of a model's providers support the parameter, the request is still routed to that model **and the parameter is ignored**" — this is the one place silent-ignore genuinely happens (all providers lack support).
4. To force a hard failure/skip instead of silent ignoring, set `provider.require_parameters: true` — then a provider lacking support is excluded from routing entirely (combine with `models` fallback array to have somewhere to fall back to).

Streaming works too: model streams valid partial JSON that forms a complete schema-conforming document once finished.

---

## 5. Reasoning

Unified `reasoning` request parameter (replaces provider-specific knobs):

```json
{
  "model": "your-model",
  "messages": [],
  "reasoning": {
    "effort": "high",       // "max" | "xhigh" | "high" | "medium" | "low" | "minimal" | "none" — OpenAI-style
    "max_tokens": 2000,     // Anthropic/Gemini/some-Qwen-style direct token budget (mutually exclusive with effort)
    "exclude": false,       // default false; true = model reasons internally but doesn't return it
    "enabled": true         // default: inferred from effort/max_tokens; true = reasoning at "medium" effort, no exclusions
  }
}
```
- Effort → token-budget mapping (approximate): `max`/`xhigh` ≈ 95%, `high` ≈ 80%, `medium` ≈ 50%, `low` ≈ 20%, `minimal` ≈ 10% of `max_tokens`. `none` disables reasoning.
- For Anthropic specifically: `budget_tokens = max(min(max_tokens * effort_ratio, 128000), 1024)`, and the request's `max_tokens` must be strictly greater than the reasoning budget.
- Legacy params still supported: `include_reasoning: true` ≡ `reasoning: {}`; `include_reasoning: false` ≡ `reasoning: { exclude: true }`.
- Discover per-model reasoning capabilities via `GET /api/v1/models` — each model may carry a `reasoning` object:
  ```json
  {
    "id": "google/gemini-3.5-flash",
    "reasoning": {
      "supported_efforts": ["high", "medium", "low", "minimal"],
      "default_effort": "medium",
      "default_enabled": true,
      "mandatory": true
    }
  }
  ```
  `mandatory: true` means the model rejects `effort: "none"`. Non-reasoning models omit the `reasoning` field entirely.

### How reasoning comes back
- **Non-streaming**: `choices[].message.reasoning` (plain string) and/or `choices[].message.reasoning_details` (array of typed objects — `reasoning.summary`, `reasoning.encrypted`, `reasoning.text`, each with `id`, `format`, `index`).
- **Streaming**: `choices[].delta.reasoning_details` per chunk (same object shapes, arriving incrementally); some SDKs also alias a plain `delta.reasoning` string.
- Example non-streaming:
  ```json
  {
    "choices": [{
      "message": {
        "role": "assistant",
        "content": "Based on my analysis...",
        "reasoning_details": [
          { "type": "reasoning.summary", "summary": "Analyzed the problem...", "id": "reasoning-summary-1", "format": "anthropic-claude-v1", "index": 0 },
          { "type": "reasoning.text", "text": "Let me work through this...", "signature": null, "id": "reasoning-text-1", "format": "anthropic-claude-v1", "index": 1 }
        ]
      }
    }]
  }
  ```
- Reasoning tokens are billed as output tokens. **Some models (e.g. OpenAI o-series) never return reasoning content even though they use it internally** — don't assume `reasoning`/`reasoning_details` will be populated just because a model is a "reasoning model."
- To preserve reasoning across turns (needed for tool-use continuity with Claude), echo back `message.reasoning` (string) or the full `message.reasoning_details` array unmodified on the next request.

---

## 6. Vision (image inputs)

OpenAI-style multi-part `content` with `image_url` parts, on the same `/chat/completions` endpoint:

```json
{
  "model": "google/gemini-3-flash-preview",
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "What's in this image?" },
        { "type": "image_url", "image_url": { "url": "https://example.com/photo.jpg" } }
      ]
    }
  ]
}
```
- `image_url.url` accepts either an **HTTP(S) URL** or a **base64 data URL** (`data:image/jpeg;base64,...`) — base64 required for local/private files.
- Supported image content types: `image/png`, `image/jpeg`, `image/webp`, `image/gif`.
- Multiple images: separate `content` array entries. Max count varies per provider/model.
- Docs recommend sending the text prompt **before** the images in the content array (or, if images must lead, put them in the system prompt) due to how providers parse multi-part content.

### Determining which models accept images
From `GET /api/v1/models`, check `architecture.input_modalities` — it's an array that includes `"image"` when supported:
```json
"architecture": {
  "modality": "text+image+file->text",
  "input_modalities": ["text", "image", "file"],
  "output_modalities": ["text"]
}
```
You can also filter server-side: `GET /api/v1/models?input_modalities=text,image`.

---

## 7. Streaming (SSE)

Enable with `"stream": true`. Standard SSE framing: lines prefixed `data: `, terminated by a literal `data: [DONE]` line.

### Keep-alive comment lines
OpenRouter periodically sends SSE comment lines to prevent connection timeouts:
```
: OPENROUTER PROCESSING
```
These start with `:` per the SSE spec and **must be skipped before `JSON.parse`** — passing one to `JSON.parse` throws and (if unhandled) crashes a hand-rolled parse loop. This is explicitly called out as a common bug source. Use a spec-compliant parser (`eventsource-parser`) or manually skip any line starting with `:`.

### A normal delta chunk
```json
{
  "id": "chatcmpl-123",
  "object": "chat.completion.chunk",
  "created": 1677652288,
  "model": "openai/gpt-4o",
  "choices": [{
    "index": 0,
    "delta": { "role": "assistant", "content": "Hello" },
    "finish_reason": null
  }]
}
```

### Usage in the final chunk
The **final** chunk before `[DONE]` includes a top-level `usage` object (prompt/completion/total tokens, and OpenRouter also reports `cost`). Check `chunk.usage` on each chunk and only act on it once present.

### Mid-stream errors
Once the first token has been sent, HTTP 200 and headers are already committed — errors can no longer become a different status code, so they arrive **in-band** as a normal-shaped `chat.completion.chunk` with an added top-level `error` field and `finish_reason: "error"`:
```
data: {"id":"gen-abc123","object":"chat.completion.chunk","created":1234567890,"model":"openai/gpt-4o","provider":"OpenAI","error":{"code":429,"message":"Rate limit exceeded","metadata":{"error_type":"rate_limit_exceeded"}},"choices":[{"index":0,"delta":{"content":""},"finish_reason":"error"}]}
```
Key points:
- The `error` object sits at the **top level**, alongside `id`/`object`/`created`/`model`, not nested inside `choices[]`.
- `choices[0].finish_reason` is `"error"` and terminates the stream (no `[DONE]` follows meaningfully, though the connection may still close after).
- HTTP status remains 200 for the whole response.
- On `error.code` 500-class failures, `error.message` is replaced with a generic string and `error.metadata.provider_code` is omitted to avoid leaking upstream details; `error.metadata.error_type` is still present (`"server"`).
- **Pre-stream errors** (before any token sent) are plain JSON with a real non-2xx HTTP status — see §8. This is the "errors before any tokens are sent" vs "mid-stream" distinction your adapter needs to branch on.
- The generation ID is also returned in the `X-Generation-Id` response header on every chat-completions call (streaming or not).

---

## 8. Error envelope (non-2xx) and the 200-with-error-in-body case

### Standard non-streaming error shape
```typescript
type ErrorResponse = {
  error: {
    code: number;
    message: string;
    metadata?: Record<string, unknown>;
  };
};
```
HTTP status equals `error.code` when the error is a *request* error (invalid request, out of credits, etc.) — i.e. failed before the LLM started producing output.

### Common statuses
| Status | Meaning |
|---|---|
| 400 | Bad Request — invalid/missing params, CORS |
| 401 | Invalid credentials (expired OAuth session, disabled/invalid key) |
| 402 | Payment Required — account/key out of credits |
| 403 | Forbidden — insufficient permission, guardrail block, or moderation flag |
| 408 | Request timeout |
| 429 | Rate limited (may include `Retry-After` header, seconds) |
| 502 | Bad Gateway — chosen model down / invalid provider response |
| 503 | Service Unavailable — no provider meets your routing requirements (may include `Retry-After`) |

### Moderation error metadata
```typescript
type ModerationErrorMetadata = {
  reasons: string[];        // why flagged
  flagged_input: string;    // flagged text, truncated to 100 chars (middle-truncated with "...")
  provider_name: string;
  model_slug: string;
};
```

### Provider error metadata (typed error codes)
Non-500 provider errors surface the upstream code:
```json
{
  "error": {
    "code": 429,
    "message": "Rate limit exceeded",
    "metadata": { "error_type": "rate_limit_exceeded", "provider_code": "rate_limited" }
  }
}
```
`error.metadata.error_type` is the stable, typed field to switch on (categories include token/length limits, auth, rate-limiting/availability, request validation, content policy, image errors, and generic `server`/`timeout`/`unmapped`). Prefer `error_type` over the raw HTTP status or `provider_code` for programmatic handling — it's stable across the Chat Completions, Responses, and Anthropic Messages API skins even when the native protocol's own code is lossy.

### Does OpenRouter return HTTP 200 with an error embedded in the response body? — VERIFIED YES
Confirmed directly in the docs (not just streaming). For **non-streaming** requests where a provider error interrupts generation after partial output was already produced upstream, the error is embedded in the final response body alongside any partial content, with the outer HTTP status still 200:
```json
{
  "choices": [{
    "message": { "role": "assistant", "content": "partial output..." },
    "finish_reason": "error",
    "error": {
      "code": 502,
      "message": "Provider disconnected mid-stream",
      "metadata": { "error_type": "provider_unavailable" }
    }
  }]
}
```
For **streaming**, the equivalent is the mid-stream SSE error chunk shown in §7 (also 200 OK, error at top level, `finish_reason: "error"`). **Adapter implication: always check for a `choices[].error` / `finish_reason === "error"` field even on a 200 response — don't assume 200 means success.**

### Model-availability errors (additive `error.availability` object)
When a model can't be served at all (unknown, deprecated, no routable endpoints, region/privacy/quantization filtered out, capacity exhausted, etc.), the error response gets an additional `error.availability` object without changing `error_type`/`http_status`/`message`:
```typescript
type AvailabilityError = {
  code: string;                         // e.g. "model_not_found", "capacity_exhausted", "model_deprecated", "privacy_restricted", "constraint_filtered", "region_restricted", "no_endpoints", "free_variant_ended"
  retryable: boolean;
  retry_after?: number | null;
  requested_models: string[];
  affected_providers?: string[] | null;
  excluded_by?: string[];
  fallback_models?: string[];           // suggested replacement slugs
  constraint?: { field: string; detail: string };
  docs_url: string;
};
```
Example (capacity exhausted, retryable):
```json
{
  "error": {
    "message": "All providers for anthropic/claude-sonnet-4.5 are at capacity. Retry after 40 seconds.",
    "error_type": "rate_limit_exceeded",
    "http_status": 429,
    "availability": {
      "code": "capacity_exhausted",
      "retryable": true,
      "retry_after": 40,
      "requested_models": ["anthropic/claude-sonnet-4.5"],
      "fallback_models": ["anthropic/claude-haiku-4.5"],
      "docs_url": "https://openrouter.ai/docs/errors#capacity_exhausted"
    }
  }
}
```
Useful for an adapter: `availability.fallback_models` gives you a ready-made retry target when a slug goes stale/deprecated.

---

## 9. `GET /api/v1/models` — response shape (powers model auto-fetch)

No auth required for this endpoint. Verified against a **live** fetch on 2026-08-23 (422 models returned). Query params of note: `limit`/`offset` (pagination, max limit 1000), `category`, `supported_parameters` (comma-separated filter), `input_modalities` / `output_modalities`, `q` (free-text search), `context` (min context length), `min_price`/`max_price` (per-M-token, prompt side), `arch`, `model_authors`, `providers`, `sort` (`newest`, `pricing-low-to-high`, `context-high-to-low`, `top-weekly`, etc.).

Top-level response:
```json
{
  "data": [ /* array of model objects, shape below */ ],
  "total_count": 422,
  "links": { /* pagination links */ }
}
```

Actual model object (verbatim, live-fetched):
```json
{
  "id": "meta/muse-spark-1.2-contributor",
  "canonical_slug": "meta/muse-spark-1.2-contributor-20260805",
  "hugging_face_id": null,
  "name": "Meta: Muse Spark 1.2 Contributor",
  "created": 1787336476,
  "description": "Muse Spark 1.2 contributor tier is a reasoning model from Meta...",
  "context_length": 1048576,
  "architecture": {
    "modality": "text+image+file+audio+video->text",
    "input_modalities": ["text", "image", "video", "file", "audio"],
    "output_modalities": ["text"],
    "tokenizer": "Other",
    "instruct_type": null
  },
  "pricing": {
    "prompt": "0.0000001",
    "completion": "0.0000002",
    "web_search": "0.0025",
    "input_cache_read": "0.000000002"
  },
  "top_provider": {
    "context_length": 1048576,
    "max_completion_tokens": null,
    "is_moderated": true
  },
  "per_request_limits": null,
  "supported_parameters": [
    "include_reasoning", "max_tokens", "reasoning", "reasoning_effort",
    "repetition_penalty", "response_format", "structured_outputs",
    "temperature", "tool_choice", "tools", "top_k", "top_p"
  ],
  "default_parameters": {},
  "supported_voices": null,
  "knowledge_cutoff": null,
  "expiration_date": null,
  "links": { "details": "/api/v1/models/meta/muse-spark-1.2-contributor-20260805/endpoints" },
  "reasoning": {
    "mandatory": true,
    "supported_efforts": ["xhigh", "high", "medium", "low", "minimal"],
    "default_effort": "medium"
  }
}
```

Field notes for building an auto-fetch/model-picker adapter:
- `id` is what you send as `model` in chat requests; `canonical_slug` is the fully-resolved dated slug (useful for display/dedup, not required in requests).
- `pricing.*` values are **strings**, in **USD per token** (not per million) — e.g. `"0.000005"` = $5/M tokens. Fields present vary by model: `prompt`, `completion`, and optionally `web_search`, `image`, `audio`, `input_audio_cache`, `internal_reasoning`, `input_cache_read`, `input_cache_write`, `input_cache_write_1h`, and an `overrides` array for tiered/long-context pricing.
- `context_length` is the provider-wide context window; `top_provider.context_length` / `top_provider.max_completion_tokens` are for whichever endpoint OpenRouter currently ranks as primary for that model (may be `null`).
- `architecture.modality` is a compact string like `"text+image+file->text"`; `architecture.input_modalities` / `output_modalities` are the arrays to filter on programmatically (`"image"` present ⇒ vision support, per §6).
- `supported_parameters` is the array your adapter should check before sending `response_format`, `reasoning`, `tools`, etc. — it's the ground truth for what that model/endpoint accepts (values seen include `structured_outputs`, `response_format`, `reasoning`, `reasoning_effort`, `include_reasoning`, `tools`, `tool_choice`, `temperature`, `top_p`, `top_k`, `max_tokens`, `repetition_penalty`, `seed`, `logprobs`, etc.).
- `reasoning` (optional) — see §5 for shape; absent for non-reasoning and dynamic router models (`openrouter/auto`).
- `per_request_limits` — UNVERIFIED what this contains in practice (was `null` on every model checked); older docs describe it as provider-side rate-limit hints, but no live example populated it in this fetch.

### Other model/key endpoints (from the OpenAPI index, not deep-verified this session)
- `GET /api/v1/models/{author}/{slug}/endpoints` — per-model list of provider endpoints (referenced via each model's `links.details`).
- `GET /api/v1/key` — returns info about the current API key (credit balance/limits). Commonly used pattern in the wild; UNVERIFIED exact response shape in this session — did not fetch it live.
- `GET /api/v1/models/user` — UNVERIFIED; not confirmed to exist under this exact path in the current docs tree browsed this session (the docs index lists model endpoints under `/docs/api/api-reference/models/...` but this specific "user" variant wasn't located).

---

## 10. Popular current model IDs (live-verified, 2026-08-23) and free-tier options

Pulled directly from a live `GET /api/v1/models` response (422 models total). Slugs change over time — always resolve dynamically via §9 in production rather than hardcoding, but these are reasonable defaults today:

**Claude (Anthropic)** — 32 Claude models present, including:
- `anthropic/claude-opus-5`, `anthropic/claude-opus-5-fast`, `anthropic/claude-opus-5:batch`
- `anthropic/claude-sonnet-5`, `anthropic/claude-sonnet-5:batch`
- `anthropic/claude-fable-5` (plus `~anthropic/claude-fable-latest`)
- `anthropic/claude-opus-4.8`, `anthropic/claude-opus-4.8-fast`, `anthropic/claude-opus-4.7-fast` (previous-gen, still live)
- Latest-alias slugs: `~anthropic/claude-opus-latest`, `~anthropic/claude-sonnet-latest`, `~anthropic/claude-haiku-latest`
- Pricing example — `anthropic/claude-sonnet-5`: context 1,000,000; prompt $2/M, completion $10/M tokens.

**GPT (OpenAI)** — 48 GPT-5-family models present, including:
- `openai/gpt-5.6-luna` / `-luna-pro`, `openai/gpt-5.6-terra` / `-terra-pro`, `openai/gpt-5.6-sol` / `-sol-pro` (GPT-5.6 sub-variants, `-pro` = deeper reasoning mode per §5)
- `openai/gpt-5.5`, `openai/gpt-5.5-pro`
- Latest-alias slugs: `~openai/gpt-latest`, `~openai/gpt-mini-latest`
- Pricing example — `openai/gpt-5.5`: context 1,050,000; prompt $5/M, completion $30/M (with a long-context override tier above 272k prompt tokens: $10/M prompt, $45/M completion).

**Gemini (Google)** — 21 Gemini-3 models present, including:
- `google/gemini-3.7-flash`, `google/gemini-3.6-flash`, `google/gemini-3.5-flash`, `google/gemini-3.5-flash-lite`
- `google/gemini-3.1-flash`, `google/gemini-3.1-flash-lite`, `google/gemini-3-pro-image`, `google/gemini-3.1-flash-image`
- Pricing example — `google/gemini-3.5-flash`: context 1,048,576; prompt $1.50/M, completion $9/M (plus separate image/audio/reasoning line items).

**DeepSeek** — V4 family present:
- `deepseek/deepseek-v4-flash`, `deepseek/deepseek-v4-pro`, `deepseek/deepseek-v4-pro-0813`, `deepseek/deepseek-v4-flash-vision-exp`, `~deepseek/deepseek-v4-flash-latest`
- Older but still live: `deepseek/deepseek-v3.2`, `deepseek/deepseek-chat-v3.1`, `deepseek/deepseek-r1`
- Pricing example — `deepseek/deepseek-v4-flash`: context 1,048,576; prompt ~$0.05/M, completion ~$0.10/M — very cheap.

**Llama (Meta)** — 4.x family present:
- `meta-llama/llama-4-maverick`, `meta-llama/llama-4-scout`
- Still live from 3.x: `meta-llama/llama-3.3-70b-instruct`, `meta-llama/llama-3.1-70b-instruct/8b-instruct`, `meta-llama/llama-3.2-3b-instruct/1b-instruct`
- Pricing example — `meta-llama/llama-4-maverick`: context 1,048,576; prompt $0.20/M, completion $0.80/M.

**Free-tier options** (`:free` suffix or `$0` pricing, 18 seen live) — good defaults for a no-cost dev/testing path:
- `google/gemma-4-26b-a4b-it:free`, `google/gemma-4-31b-it:free`
- `z-ai/glm-5.2:free`
- `nvidia/nemotron-3-ultra-550b-a55b:free`, `nvidia/nemotron-3-super-120b-a12b:free`, `nvidia/nemotron-3.5-lightning:free`
- `liquid/lfm-2.5-2.6b:free`
- Confirm current availability at request time — `:free` variants can end their promotion (`error.availability.code: "free_variant_ended"`, see §8) and rotate over time; treat this list as illustrative, not permanent.

---

## UNVERIFIED items

- `GET /api/v1/key` exact response schema (balance/limit fields) — referenced in ecosystem knowledge but not fetched live this session.
- `GET /api/v1/models/user` — could not confirm this exact endpoint path exists in the current docs tree.
- `per_request_limits` field's actual populated shape — always `null` in the live sample fetched; couldn't find a live example with a non-null value.
- The precise conditions under which OpenRouter chooses to retry with a different provider transparently vs. surface a mid-stream error — general behavior is documented (retry only possible pre-first-token) but exhaustive provider-by-provider behavior wasn't verified.
- Long-term stability of the specific model IDs listed in §10 — these are a live snapshot on 2026-08-23; OpenRouter model catalogs change frequently (deprecations, new releases), so treat as illustrative defaults, not a permanent list. Always resolve via `GET /api/v1/models` at runtime.
