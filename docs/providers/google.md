# Google Gemini API (Generative Language API / AI Studio, API-key flavor)

Retrieval date: 2026-08-23. Sources: https://ai.google.dev/api/generate-content · https://ai.google.dev/gemini-api/docs/generate-content/text-generation · https://ai.google.dev/gemini-api/docs/generate-content/thinking · https://ai.google.dev/gemini-api/docs/generate-content/structured-output · https://ai.google.dev/gemini-api/docs/generate-content/image-understanding · https://ai.google.dev/gemini-api/docs/generate-content/api-errors · https://ai.google.dev/api/models · https://ai.google.dev/gemini-api/docs/api-versions · https://ai.google.dev/gemini-api/docs/api-key · https://ai.google.dev/gemini-api/docs/changelog · https://ai.google.dev/gemini-api/docs/migrate-to-interactions

**IMPORTANT context discovered during research:** As of 2026, Google has introduced a new **Interactions API** (`/v1beta/interactions`, `input`/`generation_config`/typed content blocks) which the docs now present as the *primary/recommended* path for new development. The classic `contents`/`parts`/`generateContent` REST surface described below still exists but its docs are now labeled **"Gemini Generate Content API (Legacy)"** — Google states it "remains fully supported" but new features land on Interactions API first. This document covers the **legacy `contents`/`parts` generateContent/streamGenerateContent surface**, since that is what a simple browser-fetch adapter should target (stateless, no server-side history, matches the shape most third-party tooling still expects). Anything specific to the Interactions API is called out and out of scope otherwise.

## 1. Endpoints, versions, auth

- **v1beta vs v1**: `v1` is the stable major version; `v1beta` carries early/beta features and is required for many newer capabilities (latest models, some `thinkingConfig`/structured-output details) that are v1beta-first or v1beta-only. All current official docs examples use `v1beta`. Recommendation for a browser adapter: **use `v1beta`** — it's what every current doc example and every current model actually documented against uses; `v1` is narrower and lags behind for new models/features.
- **generateContent URL:**
  ```
  POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
  ```
- **streamGenerateContent URL (SSE):**
  ```
  POST https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse
  ```
  Without `?alt=sse` the streaming endpoint returns a JSON-array-chunked stream instead of SSE — for a browser `fetch` + `ReadableStream` adapter you want `?alt=sse` so chunks are `data: {...}\n\n` lines.
- **Auth — current recommendation: `x-goog-api-key` header, not `?key=` query param.** Query-param keys get logged in server/proxy logs and browser history and are explicitly discouraged by Google's own API-key best-practices guidance. All current official examples use the header form:
  ```bash
  curl "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent" \
    -H "x-goog-api-key: $GEMINI_API_KEY" \
    -H "Content-Type: application/json" \
    -X POST \
    -d '{"contents":[{"parts":[{"text":"Explain how AI works"}]}]}'
  ```
  `?key=$GEMINI_API_KEY` still works (legacy compatibility) but should not be used in new code.

## 2. Request body

Top-level `GenerateContentRequest` fields: `contents[]` (required), `systemInstruction` (formerly `system_instruction`, optional), `tools[]`, `safetySettings[]`, `generationConfig`, `cachedContent`.

```json
{
  "system_instruction": {
    "parts": [{"text": "You are a cat. Your name is Neko."}]
  },
  "contents": [
    {
      "role": "user",
      "parts": [{"text": "How many paws are in my house?"}]
    }
  ],
  "generationConfig": {
    "temperature": 1.0,
    "maxOutputTokens": 1000,
    "topP": 0.95,
    "topK": 40,
    "stopSequences": ["Title"],
    "candidateCount": 1
  }
}
```

- `contents[].role` is `"user"` or `"model"`; `role` may be omitted on a single-turn request with one content block.
- `contents[].parts[]` — each part is one of `text`, `inline_data`, `file_data`, `function_call`, `function_response`.
- `systemInstruction` is a `Content` object (same `parts` shape) with no `role`.
- `generationConfig.maxOutputTokens` is **optional**. If omitted, the model uses its own default output cap (varies per model; docs do not publish one universal default — treat as "unbounded up to the model's own max output token limit" reported by `GET /v1beta/models`). Note: as of the **2026-07-21** changelog entry, Google says the classic sampling knobs `temperature`, `top_p`, and `top_k` are being **deprecated** in favor of newer controls (this shows up first for Gemini 3.x — see §4/§10); for Gemini 2.5 models they still function normally. Also: Google explicitly recommends leaving `temperature` at its default `1.0` for Gemini 3 models — lowering it can cause looping/degraded reasoning on complex tasks.
- Field casing: the REST API is camelCase for `generationConfig` sub-fields (`maxOutputTokens`, `responseMimeType`, `responseSchema`, `thinkingConfig`) but snake_case for top-level `system_instruction` and part-level `inline_data`/`mime_type`/`file_data` in the official curl examples (SDKs normalize this to camelCase; the raw REST wire format accepts snake_case for those specific fields per Google's own examples — camelCase generally also works since protobuf JSON accepts both, but match the docs' casing to be safe).

## 3. JSON mode (structured output)

Config lives under `generationConfig.responseMimeType` + `generationConfig.responseSchema` (this is the field pair confirmed against the actual `GenerationConfig` reference — NOT `responseFormat`, which appears to be Interactions-API/SDK-only terminology that showed up in some secondary sources; treat `responseFormat` as **UNVERIFIED** for the legacy REST surface).

```json
{
  "contents": [{"parts": [{"text": "List a popular cookie recipe with grams of each ingredient."}]}],
  "generationConfig": {
    "responseMimeType": "application/json",
    "responseSchema": {
      "type": "object",
      "properties": {
        "recipe_name": {"type": "string"},
        "ingredients": {
          "type": "array",
          "items": {"type": "string"}
        }
      },
      "required": ["recipe_name", "ingredients"]
    }
  }
}
```

- `responseSchema` accepts an OpenAPI-3-style subset of JSON Schema (`type`, `properties`, `items`, `required`, `enum`, `format`, nested `object`/`array`).
- `responseJsonSchema` (a separate, more-permissive full-JSON-Schema field) is mentioned in some Go/newer-SDK docs — **UNVERIFIED** for this REST surface's exact wire name/behavior; did not find a verbatim REST example. Treat `responseSchema` as the confirmed/ground-truth field.
- **Streaming + JSON mode:** works together — official docs confirm structured outputs can be streamed ("You can stream structured outputs... The streamed chunks are valid partial JSON strings that can be concatenated to form the final JSON object"). Note this guarantee was stated in SDK-level docs; for raw `streamGenerateContent`, each SSE chunk's `candidates[0].content.parts[0].text` is a fragment of the overall JSON string when `responseMimeType: "application/json"` is set — concatenate `text` across chunks and parse once `finishReason` is present.

## 4. Thinking (`thinkingConfig`)

Two parallel mechanisms exist depending on model generation:

**Gemini 2.5 family** (`gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite`) — use `thinkingConfig.thinkingBudget` (+ optional `includeThoughts`):

```json
{
  "contents": [{"parts": [{"text": "Solve this math problem: ..."}]}],
  "generationConfig": {
    "thinkingConfig": {
      "thinkingBudget": 1024,
      "includeThoughts": true
    }
  }
}
```

- `thinkingBudget`: `-1` = dynamic (model decides), `0` = disabled, positive integer = explicit token budget.
- Defaults/ranges (per model, UNVERIFIED exact numbers beyond what's below — Google's docs give ranges but exact default budgets weren't captured verbatim in a single source this pass):
  - `gemini-2.5-pro`: thinking **on by default**, dynamic; thinking cannot be fully disabled on Pro.
  - `gemini-2.5-flash`: thinking **on by default**, dynamic, range ~0–24576.
  - `gemini-2.5-flash-lite`: thinking **off by default**; range ~512–24576 when enabled.

**Gemini 3.x family** — use `thinkingConfig.thinking_level` / `thinkingLevel` (string enum), NOT `thinkingBudget`:

```json
{
  "generationConfig": {
    "thinkingConfig": {
      "thinkingLevel": "low"
    }
  }
}
```

- Values: `"minimal"` (Flash/Flash-Lite only, lowest latency), `"low"`, `"medium"`, `"high"` (default for Pro-tier 3.x models).
- **You cannot set both `thinkingLevel` and `thinkingBudget` in the same request** (mutually exclusive; docs explicitly warn about this).
- `thinkingBudget` is still accepted on 3.x for backward compatibility but is not the recommended control.
- Thinking is **on by default** for essentially all current 2.5/3.x models except `gemini-2.5-flash-lite` (off by default).

**How thoughts appear in the response:** thought content comes back as extra `parts` entries flagged with `"thought": true`, interleaved before the final answer part(s):

```json
{
  "candidates": [{
    "content": {
      "parts": [
        {"text": "Internal reasoning about the problem...", "thought": true},
        {"text": "Final answer here."}
      ],
      "role": "model"
    },
    "finishReason": "STOP"
  }],
  "usageMetadata": {
    "thoughtsTokenCount": 1024,
    "candidatesTokenCount": 256,
    "totalTokenCount": 1400
  }
}
```

- `usageMetadata.thoughtsTokenCount` reports thinking-token spend separately from `candidatesTokenCount`.
- Some thought parts may instead/also carry a `thoughtSignature` (an opaque encrypted blob representing internal reasoning state, used for multi-turn continuity) rather than visible summary text — **UNVERIFIED** exact field name/shape (`signature` vs `thoughtSignature`); sources disagreed on naming during this research pass.

## 5. Vision (inline image data)

Confirmed REST (snake_case) shape, part of `contents[].parts[]`:

```json
{
  "contents": [{
    "parts": [
      {"text": "Caption this image."},
      {
        "inline_data": {
          "mime_type": "image/jpeg",
          "data": "BASE64_ENCODED_IMAGE_BYTES"
        }
      }
    ]
  }]
}
```

- Field names in the official REST curl examples: `inline_data` (not `inlineData`) and `mime_type` (not `mimeType`). SDKs (Python/JS/Go) normalize to camelCase `inlineData`/`mimeType` — if calling the raw REST endpoint directly from a browser `fetch`, use the snake_case names shown in the docs.
- Supported inline mime types include PNG, JPEG, WEBP, HEIC, HEIF (and audio/video/PDF types for those respective modalities).
- For large files, `file_data: {mime_type, file_uri}` (via the separate File API) is used instead of inline base64 — not needed for typical browser-extension-sized screenshots/images.

## 6. Streaming (`streamGenerateContent?alt=sse`)

```bash
curl "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse" \
  -H "x-goog-api-key: $GEMINI_API_KEY" \
  -H "Content-Type: application/json" \
  --no-buffer \
  -d '{"contents":[{"parts":[{"text":"Explain how AI works"}]}]}'
```

Each SSE event is a `data: {...}` line containing a full `GenerateContentResponse` chunk (not a diff):

```
data: {"candidates": [{"content": {"parts": [{"text": "Artificial"}],"role": "model"},"index": 0}],"modelVersion": "gemini-2.5-flash","responseId": "..."}

data: {"candidates": [{"content": {"parts": [{"text": " intelligence works by..."}],"role": "model"},"index": 0}],"modelVersion": "gemini-2.5-flash","responseId": "..."}

data: {"candidates": [{"content": {"parts": [{"text": ""}],"role": "model"},"finishReason": "STOP","index": 0}],"usageMetadata": {"promptTokenCount": 6,"candidatesTokenCount": 220,"totalTokenCount": 226},"modelVersion": "gemini-2.5-flash","responseId": "..."}
```

- Accumulate `candidates[0].content.parts[].text` across chunks in order to build the full response text.
- `finishReason` only appears on the final chunk (or the chunk where generation stops).
- `usageMetadata` (token counts) is typically only populated in the final chunk.
- Stream ends with the SSE connection closing (no explicit `data: [DONE]` sentinel is documented for this endpoint, unlike OpenAI's SSE convention — treat socket/stream close as end-of-stream, and also treat receipt of a `finishReason` as logical end).
- **Errors mid-stream:** if a fatal error occurs after the stream has started (HTTP 200 already sent, chunks already flowing), Google does not have a fully documented "error event" shape distinct from a normal chunk for this legacy endpoint — treat an abrupt stream termination without a `finishReason` as an error condition. **UNVERIFIED**: whether an in-stream `data:` line can itself carry an `{"error": {...}}` payload instead of a candidate — plan defensively for both a possible `data: {"error": {...}}` event and a plain connection drop.
- **Errors before any chunk is sent** (e.g. bad API key, bad model name, quota exceeded before generation starts) arrive as a normal non-SSE JSON HTTP error response with the standard error envelope (see §8), not as an SSE `data:` line — the HTTP status code itself will be 4xx/5xx.
- **Empty candidates / safety block case:** if the prompt itself is blocked (e.g. by safety filters) before any output is generated, the response has **no `candidates` array at all**, only `promptFeedback`:
  ```json
  {
    "promptFeedback": {
      "blockReason": "SAFETY",
      "safetyRatings": [
        {"category": "HARM_CATEGORY_DANGEROUS_CONTENT", "probability": "HIGH"}
      ]
    }
  }
  ```
  `blockReason` enum values observed in docs: `SAFETY`, `OTHER`, `BLOCKLIST`, `PROHIBITED_CONTENT`, `IMAGE_SAFETY`. A robust adapter must check for `candidates` being absent/empty and read `promptFeedback.blockReason` in that case, both for streaming and non-streaming calls.

## 7. Non-streaming response shape and `finishReason`

```json
{
  "candidates": [
    {
      "content": {
        "parts": [{"text": "At its core, Artificial Intelligence works by..."}],
        "role": "model"
      },
      "finishReason": "STOP",
      "index": 0,
      "safetyRatings": []
    }
  ],
  "usageMetadata": {
    "promptTokenCount": 6,
    "candidatesTokenCount": 220,
    "totalTokenCount": 226,
    "thoughtsTokenCount": 0
  },
  "modelVersion": "gemini-2.5-flash",
  "responseId": "mAitaLmkHPPlz7IPvtfUqQ4"
}
```

`finishReason` enum values documented: `STOP` (normal completion), `MAX_TOKENS` (hit `maxOutputTokens`), `SAFETY` (blocked by safety filters), `RECITATION` (blocked for reciting copyrighted/training data), plus others in the full enum such as `OTHER`, `LANGUAGE`, `BLOCKLIST`, `PROHIBITED_CONTENT`, `SPII`, `MALFORMED_FUNCTION_CALL` — **UNVERIFIED** complete authoritative list/spelling for every value beyond the four core ones (STOP/MAX_TOKENS/SAFETY/RECITATION), which are solidly confirmed; treat the extended list as best-effort from secondary sources.

## 8. Error envelope

```json
{
  "error": {
    "code": 400,
    "message": "API key not valid. Please pass a valid API key.",
    "status": "INVALID_ARGUMENT",
    "details": [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        "reason": "API_KEY_INVALID",
        "domain": "googleapis.com",
        "metadata": {"service": "generativelanguage.googleapis.com"}
      }
    ]
  }
}
```

Common `code`/`status` pairs:

| HTTP code | `status` | Cause |
|---|---|---|
| 400 | `INVALID_ARGUMENT` | Malformed request body, bad/invalid API key, unsupported field |
| 400 | `FAILED_PRECONDITION` | Free tier unavailable in your region without billing enabled |
| 403 | `PERMISSION_DENIED` | API key lacks permission for the requested model/resource |
| 404 | `NOT_FOUND` | Requested model or resource doesn't exist |
| 429 | `RESOURCE_EXHAUSTED` | Rate limit or quota exceeded — retry with backoff |
| 499 | `CANCELLED` | Caller cancelled the request |
| 500 | `INTERNAL` | Unexpected error on Google's side |
| 503 | `UNAVAILABLE` | Service temporarily overloaded/down — retry with backoff |
| 504 | `DEADLINE_EXCEEDED` | Request didn't finish before server-side deadline |

Note: a secondary/newer doc surface (possibly Interactions-API-specific) showed a *different*, simpler error shape (`{"error": {"code": "invalid_request", "message": "..."}}` with a *string* code and no `status` field). **This document treats the classic `{code: <int>, message, status: "<UPPER_SNAKE>"}` envelope above as ground truth** for the legacy `generateContent`/`streamGenerateContent` endpoints — it matches Google's general API error convention (`google.rpc.Status`) and was confirmed directly on the legacy API errors reference page. Flag the alternate string-code shape as **UNVERIFIED** for this endpoint family.

## 9. `GET /v1beta/models`

```
GET https://generativelanguage.googleapis.com/v1beta/models?pageSize=50&pageToken=...
-H "x-goog-api-key: $GEMINI_API_KEY"
```

Response shape:

```json
{
  "models": [
    {
      "name": "models/gemini-2.5-flash",
      "baseModelId": "gemini-2.5-flash",
      "version": "001",
      "displayName": "Gemini 2.5 Flash",
      "description": "...",
      "inputTokenLimit": 1048576,
      "outputTokenLimit": 65536,
      "supportedGenerationMethods": ["generateContent", "countTokens", "streamGenerateContent"],
      "temperature": 1.0,
      "maxTemperature": 2.0,
      "topP": 0.95,
      "topK": 64
    }
  ],
  "nextPageToken": "..."
}
```

- `models[].name` is always prefixed `models/...` (e.g. `models/gemini-2.5-pro`); use the suffix after `models/` when building `:generateContent` URLs, or pass the full `models/{id}` path — both forms are accepted in the `{model=models/*}` URL template.
- `supportedGenerationMethods` tells you whether a given model supports `generateContent`/`streamGenerateContent`/`countTokens`/etc — check this before calling a model to catch unsupported combinations (e.g. embedding-only or image-generation-only models won't list `generateContent`).
- `pageSize` default ~50, max 1000; `pageToken`/`nextPageToken` for pagination (standard Google API list pattern).

## 10. Current model IDs (as of 2026-08-23) and deprecations

Per the official changelog and models docs, current as of this pull:

**Gemini 3.x family (current):**
- `gemini-3.7-flash` — GA as of **2026-08-13** ("substantial improvements across software engineering, web development, and agentic workflows")
- `gemini-3.6-flash` — GA as of **2026-07-21** ("improved token efficiency and code/agentic planning at a lower price point")
- `gemini-3.5-flash-lite` — GA as of **2026-07-21** ("low-latency, highly cost-effective subagent option")
- `gemini-3.5-flash`
- `gemini-3.1-pro-preview` — preview, flagship reasoning model (replaces the now-retired `gemini-3-pro-preview`)
- `gemini-3.1-flash-lite`
- `gemini-3-flash-preview` — preview, launched **2025-12-17**
- `gemini-3.1-flash-image` / `gemini-3.1-flash-lite-image` / `gemini-3-pro-image` — image generation ("Nano Banana" family)
- `gemini-3.5-live-translate-preview`, `gemini-3.1-flash-live-preview`, `gemini-3.1-flash-tts-preview` — Live API / TTS variants

**Gemini 2.5 family (current, stable):**
- `gemini-2.5-pro`
- `gemini-2.5-flash`
- `gemini-2.5-flash-lite`
- `gemini-2.5-flash-image`, `gemini-2.5-*-preview-tts`, `gemini-2.5-computer-use-preview-*` — specialized variants

**Deprecations/retirements confirmed:**
- `gemini-3-pro-preview` (original Gemini 3 Pro Preview, launched Nov 2025) — **retired/shut down 2026-03-09**; migrate to `gemini-3.1-pro-preview`.
- `gemini-2.0-flash` and `gemini-2.0-flash-lite` — deprecated, **shutdown scheduled 2026-06-01**.
- **Gemini 1.5 family**: no `gemini-1.5-*` models appear anywhere in current model listings or docs pulled during this research — they are fully retired/removed from the current lineup as of this date (consistent with Google's historical 1.5 deprecation timeline being well before mid-2026). Treat any `gemini-1.5-pro`/`gemini-1.5-flash` reference in old code as **certainly broken** on the current API.

**Notable non-Gemini-text deprecations also flagged in the changelog:** `imagen-4.0-*-generate-001` (shutdown 2026-08-17), `veo-3.0-*` and `veo-2.0-generate-001` (shutdown 2026-06-30) — not relevant to a text/chat adapter but worth knowing if the extension also touches image/video generation.

**Also from the changelog (2026-07-21):** the classic sampling parameters `temperature`, `top_p`, and `top_k` were flagged as **being deprecated** going forward (direction of travel is toward `thinkingLevel`-style coarse controls for 3.x models) — **UNVERIFIED** exact scope/timeline of this deprecation (whether it's 3.x-only or API-wide, and whether the fields will actually stop working or just stop being recommended). For now they still appear in the `GenerationConfig` reference and function normally on 2.5 models.

---

## UNVERIFIED items summary

- Exact universal default value (if any) for `maxOutputTokens` when omitted — appears to be model-specific, no single documented default found.
- `responseJsonSchema` field's exact existence/behavior on the raw REST (non-SDK) surface — only `responseSchema` was confirmed verbatim on the REST reference.
- Exact field name for thought continuity metadata (`signature` vs `thoughtSignature`) and its precise shape.
- Exact complete enum list for `finishReason` beyond `STOP`, `MAX_TOKENS`, `SAFETY`, `RECITATION` (additional values like `OTHER`, `LANGUAGE`, `BLOCKLIST`, `PROHIBITED_CONTENT`, `SPII`, `MALFORMED_FUNCTION_CALL` are plausible/commonly cited but not verified verbatim against a single authoritative source this pass).
- Whether a mid-stream fatal error can appear as an in-band `data: {"error": {...}}` SSE event on `streamGenerateContent`, versus only as an abrupt connection close.
- Precise default `thinkingBudget` numeric values and ranges per Gemini 2.5 model variant (ranges given are best-effort from secondary sources, not a single verbatim table).
- Scope/timeline of the announced `temperature`/`top_p`/`top_k` deprecation (2026-07-21 changelog entry) — whether API-wide or 3.x-only, and whether it's a hard removal or soft deprecation.
- The alternate error envelope shape (`{"error": {"code": "invalid_request", "message": "..."}}` with string code, no `status`) seen in one fetch — likely belongs to the newer Interactions API rather than legacy `generateContent`, but not fully confirmed which surface it applies to.
