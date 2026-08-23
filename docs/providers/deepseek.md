# DeepSeek API — Ground Truth for Browser-Fetch Adapter

Retrieval date: 2026-08-23

Sources:
- https://api-docs.deepseek.com/quick_start/pricing
- https://api-docs.deepseek.com/quick_start/your_first_api_call
- https://api-docs.deepseek.com/api/create-chat-completion
- https://api-docs.deepseek.com/api/list-models
- https://api-docs.deepseek.com/quick_start/error_codes
- https://api-docs.deepseek.com/quick_start/rate_limit/
- https://api-docs.deepseek.com/guides/json_mode
- https://api-docs.deepseek.com/guides/thinking_mode
- https://api-docs.deepseek.com/guides/vision
- https://api-docs.deepseek.com/guides/kv_cache
- https://api-docs.deepseek.com/guides/multi_round_chat
- https://api-docs.deepseek.com/updates/
- https://api-docs.deepseek.com/news/news260424/ (V4 preview / legacy-model deprecation announcement)

> **Big context note:** DeepSeek retired the `deepseek-chat` / `deepseek-reasoner` model names on **2026-07-24 15:59 UTC**. If your extension currently hardcodes those IDs, requests now fail outright (they no longer alias to anything — see Deprecations section). The current model family is **DeepSeek-V4** (`deepseek-v4-flash`, `deepseek-v4-pro`, plus the new `deepseek-v4-flash-vision-exp`). Thinking/reasoning is now a *request parameter* (`thinking`, `reasoning_effort`) on these models rather than a separate model name.

---

## 1. Base URL, endpoint, auth header

- OpenAI-compatible base URL: `https://api.deepseek.com`
- Anthropic-compatible base URL (separate, not relevant to an OpenAI-format adapter): `https://api.deepseek.com/anthropic`
- **`/v1` is not mentioned anywhere in current docs as required or even present.** The documented endpoint path is `https://api.deepseek.com/chat/completions` (no `/v1` segment). The docs note `/v1` is accepted "for compatibility reasons" in older material, but the canonical, current examples omit it entirely. Treat `/v1` as optional/legacy, not required.
- Chat completions endpoint: `POST /chat/completions`
- Models list endpoint: `GET /models`
- Auth header: `Authorization: Bearer ${DEEPSEEK_API_KEY}`
- Content type: `Content-Type: application/json`

```bash
curl https://api.deepseek.com/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${DEEPSEEK_API_KEY}" \
  -d '{
    "model": "deepseek-v4-pro",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant."},
      {"role": "user", "content": "Hello!"}
    ],
    "thinking": {"type": "enabled"},
    "reasoning_effort": "high",
    "stream": false
  }'
```

---

## 2. Current model IDs

| Model ID | What it points to (Aug 2026) | Context length | Max output |
|---|---|---|---|
| `deepseek-v4-flash` | DeepSeek-V4-Flash, checkpoint rolled to **V4-Flash-0731** (2026-07-31). Both non-thinking and thinking modes live under this one model ID, toggled by the `thinking` param. | 1,000,000 tokens | 384,000 tokens |
| `deepseek-v4-pro` | DeepSeek-V4-Pro, GA, checkpoint **V4-Pro-0813** (2026-08-13). Also unifies thinking/non-thinking under one ID. | 1,000,000 tokens | 384,000 tokens |
| `deepseek-v4-flash-vision-exp` | New (2026-08-21) multimodal/vision variant, "on par with … V4-Flash" on pure-text tasks, adds image input. | 1,000,000 tokens (docs did not separately state a smaller vision-specific context cap — UNVERIFIED whether identical) | 384,000 tokens |

- `deepseek-chat` and `deepseek-reasoner` are **retired** (see Deprecations, item 10).
- No R-series (`deepseek-r1`/`r2`-style standalone reasoner model) currently listed in the pricing/models docs as of this retrieval — reasoning is delivered via the `thinking`/`reasoning_effort` params on V4-Flash/V4-Pro instead of a dedicated reasoner model.
- GET /models (see item 9) only enumerates the three IDs above as of retrieval.

---

## 3. Request body specifics: `max_tokens`

From `POST /chat/completions` schema (api-docs.deepseek.com/api/create-chat-completion):

- `max_tokens` (integer, nullable, optional): "The total length of input tokens and generated tokens is limited by the model's context length."
- **Exact default value when omitted: UNVERIFIED** — the current API reference page does not state a numeric default (older docs for the retired `deepseek-chat` documented a default of 4096 and a cap of 8192; those numbers do **not** carry over to V4 and should not be assumed).
- **Per-model hard cap:** 384,000 tokens (the documented "Maximum output" for both `deepseek-v4-flash` and `deepseek-v4-pro`), further bounded by whatever context room remains after the prompt within the shared 1,000,000-token window.
- Recommendation for the adapter: always send `max_tokens` explicitly rather than relying on an undocumented default.

---

## 4. JSON mode

- Field: `response_format`, value `{"type": "json_object"}`.
- Confirmed supported on `deepseek-v4-pro` in the docs' own example; not explicitly restricted to one model, but the guide only demonstrates it on `deepseek-v4-pro` — treat `deepseek-v4-flash` support as likely-but-UNVERIFIED-by-explicit-doc-statement.
- **Caveat, verbatim from docs:** "Include the word 'json' in the system or user prompt, and provide an example of the desired JSON format." This is a hard requirement — omitting the literal word "json" from the prompt can produce malformed/endless output.
- Docs explicitly warn: "The API may occasionally return empty content." The adapter should handle empty-content JSON-mode responses defensively (retry or fallback).
- Also recommended by docs: set `max_tokens` high enough to avoid truncation cutting off the JSON.
- **Streaming + JSON mode interaction: UNVERIFIED** — the JSON mode guide page did not state whether `response_format: {"type": "json_object"}` is compatible with `"stream": true`. Treat as unconfirmed; test empirically before relying on it in the extension.

```python
response = client.chat.completions.create(
    model="deepseek-v4-pro",
    messages=messages,
    response_format={'type': 'json_object'}
)
```

Example valid output:
```json
{
    "question": "Which is the longest river in the world?",
    "answer": "The Nile River"
}
```

---

## 5. Reasoner ("thinking mode") specifics

Reasoning is now invoked on `deepseek-v4-flash` / `deepseek-v4-pro` via request params, not a separate `deepseek-reasoner` model:

```json
{
  "model": "deepseek-v4-pro",
  "thinking": {"type": "enabled"},
  "reasoning_effort": "high"
}
```

- `thinking.type`: `"enabled"` / `"disabled"`.
- `reasoning_effort`: `"low"`, `"high"`, `"max"`. Documented mapping: `medium` and `xhigh` both normalize to `high`; only `max` stays `max`. **Default effort: `high`** (per docs).
- `reasoning_content` field: appears in the response `message` object alongside `content` (non-streaming), and as a separate field inside `delta` chunks during streaming (i.e. deltas carry `delta.reasoning_content` distinct from `delta.content`).
- **Params ignored (not erroring, just silently ignored) when thinking is enabled:** `temperature`, `top_p`, `presence_penalty`, `frequency_penalty`.
- `logprobs` behavior under thinking mode: **UNVERIFIED** (not stated in the fetched thinking-mode guide, though the base chat-completion schema does show a `logprobs`/`reasoning_content` field nested under `choices[].logprobs` in the general response schema — see item 7 below).
- JSON mode compatibility with thinking enabled: **UNVERIFIED** — not addressed by either the JSON mode guide or the thinking mode guide.
- Function/tool calling compatibility with thinking enabled: the docs describe explicit rules for **multi-turn conversations that use tools while thinking is enabled**:
  - Without tools: previous-turn `reasoning_content` is dropped/ignored by the API when you send the next turn.
  - With tools: `reasoning_content` **must** be passed back in every subsequent request (even turns with no tool call), or the API returns an **HTTP 400 error**. This is a load-bearing detail for any adapter that manages conversation state across tool-using turns.
- Non-streaming response shows `reasoning_content` as a string field on `choices[0].message`, and `usage.completion_tokens_details.reasoning_tokens` reports reasoning-token count separately from output tokens.

---

## 6. Vision support

Yes — new as of 2026-08-21: **`deepseek-v4-flash-vision-exp`** accepts images. No vision support confirmed on `deepseek-v4-flash` or `deepseek-v4-pro` themselves.

Message format (OpenAI-style content array):

```json
{
  "role": "user",
  "content": [
    {"type": "text", "text": "What is in this image?"},
    {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,<BASE64_DATA>"}}
  ]
}
```

Three supported input methods for `image_url.url`:
1. Base64 data URI: `data:image/jpeg;base64,{b64}`
2. Public external URL: `https://example.com/image.jpg`
3. Files API reference: replace the `image_url` block with `{"type": "file", "file_id": "file-api-..."}`

Limits (as documented):
- Max request body size: 48 MiB
- Max single image (base64/URL): 32 MiB
- Max single image (Files API): 64 MiB
- Max images per request: 600
- Total per request: 64 MiB (or 200 MiB if using Files API-referenced images)
- Supported formats: JPEG, PNG, GIF, WebP — detected from file content, not filename/extension
- Token cost: up to 384 tokens per image, based on automatic resizing that preserves aspect ratio

---

## 7. Streaming

- Enable via `"stream": true`. Add `"stream_options": {"include_usage": true}` to get token usage in the final chunk.
- Chunks are standard OpenAI-style SSE: `data: {...}` lines, object type `chat.completion.chunk`, same `id`/`created`/`model` fields as the non-streaming response, with `choices[].delta` instead of `choices[].message`.
- Final chunk carries `usage` (when `stream_options.include_usage` is set), and the stream is terminated by a literal `data: [DONE]` line.
- **Keep-alive behavior (documented, verbatim):** "For streaming requests, DeepSeek continuously returns SSE keep-alive comments (`: keep-alive`), while non-streaming requests continuously return empty lines. These contents do not affect the parsing of the JSON body of the response." A conforming client must treat any line starting with `:` as a comment/keep-alive and ignore it, not treat it as an error or as data.
- **Connection timeout:** "If the request has not started inference after 10 minutes, the server will close the connection." Relevant for very long queue waits under heavy load.
- **Mid-stream error format: UNVERIFIED** — the fetched docs did not show an explicit example of an SSE-framed error event (e.g., an `event: error` or an error object arriving as a `data:` payload mid-stream instead of a normal `delta`). Do not assume a specific shape; handle unexpected/malformed `data:` payloads defensively.
- Exact raw chunk JSON example was **not directly reproduced verbatim** in the fetched guide (it referenced identical id/created/model fields to non-streaming plus `choices[].delta`, but did not print a full literal chunk). Treat the shape below as inferred-from-schema, not verbatim-quoted:

```
data: {"id":"...","object":"chat.completion.chunk","created":1705651092,"model":"deepseek-v4-pro","choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"},"finish_reason":null}]}

data: {"id":"...","object":"chat.completion.chunk","created":1705651092,"model":"deepseek-v4-pro","choices":[{"index":0,"delta":{"content":"lo!"},"finish_reason":null}]}

data: {"id":"...","object":"chat.completion.chunk","created":1705651092,"model":"deepseek-v4-pro","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":16,"completion_tokens":10,"total_tokens":26}}

data: [DONE]
```

For thinking mode while streaming, `delta.reasoning_content` carries reasoning tokens as a separate field from `delta.content` in each chunk (per item 5).

---

## 8. Error envelope and common statuses

Documented HTTP status table (verbatim causes/solutions summarized):

| Status | Error type | Cause | Notes |
|---|---|---|---|
| 400 | Invalid Format | Invalid request body format | Fix request body per error message |
| 401 | Authentication Fails | Wrong/invalid API key | Verify or rotate key |
| 402 | Insufficient Balance | Account out of balance | Top up account |
| 422 | Invalid Parameters | Request contains invalid parameter values | Adjust per error hint |
| 429 | Rate Limit Reached | Sending requests too fast / concurrency exceeded | Back off, pace requests |
| 500 | Server Error | Server-side issue | Retry after brief wait |
| 503 | Server Overloaded | High traffic overload | Retry after brief wait |

- **Exact JSON error envelope field names: UNVERIFIED.** The fetched error-codes page gave the status/cause/solution table but did not print a literal error-response JSON body (no confirmed field names like `error.type`/`error.message`/`error.code`). Since the API is OpenAI-compatible, an OpenAI-style envelope (`{"error": {"message": ..., "type": ..., "code": ...}}`) is a reasonable implementation assumption but is **not directly confirmed** by the docs fetched here — verify by triggering a real 400/401 against the live API before hardcoding a parse path.
- Rate limiting is concurrency-based, not strictly RPM-based: 429 is returned once you exceed the account's (or `user_id`'s, if using isolation) concurrent in-flight request ceiling. Documented concurrency ceilings: `deepseek-v4-pro` 500 concurrent, `deepseek-v4-flash` 2500 concurrent, `deepseek-v4-flash-vision-exp` 2500 concurrent. "A request counts as one concurrent connection from the time it is sent until the model response is complete."
- No documented `Retry-After` header behavior was found — UNVERIFIED.

---

## 9. GET /models response shape

```json
{
  "object": "list",
  "data": [
    {
      "id": "deepseek-v4-flash",
      "object": "model",
      "owned_by": "deepseek"
    },
    {
      "id": "deepseek-v4-pro",
      "object": "model",
      "owned_by": "deepseek"
    }
  ]
}
```

Fields: `object` ("list" for the envelope, "model" per entry), `data` (array), `id` (usable model string), `owned_by`.

(`deepseek-v4-flash-vision-exp` would be expected to also appear as a third entry post-2026-08-21, though the specific example fetched only showed two entries.)

---

## 10. Deprecations, off-peak pricing, context caching (request-shape-relevant only)

**Deprecation — directly relevant to the adapter:**
- `deepseek-chat` and `deepseek-reasoner` model names were retired/stopped resolving as of **2026-07-24 15:59 UTC**. Between the 2026-04-24 V4 preview announcement and the retirement date, they temporarily aliased to `deepseek-v4-flash` non-thinking mode (`deepseek-chat`) and thinking mode (`deepseek-reasoner`) respectively — that grace-period aliasing is now over. **Any hardcoded `deepseek-chat`/`deepseek-reasoner` model string in the extension will now fail** and must be migrated to `deepseek-v4-flash` / `deepseek-v4-pro` plus the `thinking`/`reasoning_effort` params.

**Off-peak pricing (does not affect request shape, no request field needed):**
- Peak hours: 01:00–04:00 and 06:00–10:00 UTC, Monday–Friday. Off-peak = half the peak-hour price. This is purely a billing-time-window effect — it is applied automatically server-side based on request timestamp, not a parameter you set.
- New pricing (peak/off-peak split by cache-hit vs cache-miss input) took effect 2026-08-16.

**Context (KV) caching (does not require a request field):**
- Enabled by default for all users automatically; requires no request changes.
- Exposed only via two extra `usage` response fields: `usage.prompt_cache_hit_tokens` and `usage.prompt_cache_miss_tokens`.
- Caches prefixes at request boundaries, common cross-request prefixes, and fixed intervals for long input; only full-prefix-unit matches hit the cache. Output is still generated by inference (not replayed from cache), so caching does not make responses deterministic.

---

## UNVERIFIED items summary

- Exact numeric default for `max_tokens` when omitted (no longer documented; do not assume the old `deepseek-chat` default of 4096 carries over).
- Whether `response_format: {"type": "json_object"}` works together with `"stream": true`.
- Whether `deepseek-v4-flash` (not just `deepseek-v4-pro`) is confirmed to support JSON mode — only `-pro` appeared in the docs' own example.
- `logprobs` behavior specifically under thinking mode (ignored, honored, or erroring).
- Whether JSON mode and thinking/reasoning mode can be combined in one request.
- Whether `deepseek-v4-flash-vision-exp` has a context length different from the 1,000,000-token figure shared by the text-only models.
- Exact JSON error envelope field names (`error.message`/`error.type`/`error.code` or otherwise) — status codes and causes are confirmed, but no literal error-body JSON was found in the fetched pages.
- Exact mid-stream error event framing/shape.
- Verbatim raw SSE chunk JSON (the shape given in section 7 is inferred from the documented schema, not copy-pasted from a live example in the docs).
- Whether a `Retry-After` header (or similar) accompanies 429/503 responses.
