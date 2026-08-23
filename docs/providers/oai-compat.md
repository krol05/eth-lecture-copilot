# OpenAI-Compatible Provider Family — Research Notes

Retrieval date: 2026-08-23

Primary sources consulted (see per-section notes for which applied where):
- https://console.groq.com/docs/openai
- https://console.groq.com/docs/models
- https://console.groq.com/docs/structured-outputs
- https://console.groq.com/docs/deprecations
- https://console.groq.com/docs/changelog
- https://docs.mistral.ai/getting-started/models/models_overview/
- https://docs.mistral.ai/capabilities/structured-output/json_mode
- https://docs.mistral.ai/capabilities/structured_output/custom
- https://docs.x.ai/overview
- https://docs.x.ai/developers/model-capabilities/text/structured-outputs
- https://docs.together.ai/docs/openai-api-compatibility
- https://docs.together.ai/docs/inference/chat/structured-outputs
- https://inference-docs.cerebras.ai/resources/openai
- https://docs.perplexity.ai/docs/sonar/overview
- https://docs.ollama.com/api/openai-compatibility
- https://ollama.com/blog/openai-compatibility
- https://lmstudio.ai/docs/developer/openai-compat/structured-output
- https://lmstudio.ai/docs/developer
- https://llama-cpp-python.readthedocs.io/en/latest/server/
- https://docs.unsloth.ai/basics/inference-and-deployment/llama-server-and-openai-endpoint
- https://docs.vllm.ai/en/latest/features/structured_outputs/
- https://docs.vllm.ai/en/v0.21.0/serving/openai_compatible_server/

Note on method: several pages were retrieved through an AI-summarizing fetch tool rather than raw HTML, and some current-model listings were cross-checked against secondary aggregator/blog sources (dated 2026) because official docs pages tend to only show the *current* table with no changelog of exact IDs. Anything not confirmed against an official page directly is marked **UNVERIFIED**. Given the fast pace of model releases, treat every specific model ID below as "best known as of retrieval date" rather than guaranteed-current — a live `/models` call should be the adapter's source of truth wherever the provider exposes one.

---

## 1. Groq

- **Base URL:** `https://api.groq.com/openai/v1`
- **Auth header:** `Authorization: Bearer <GROQ_API_KEY>` (standard OpenAI client `api_key` param works unchanged)
- **`/models`:** Supported — `GET https://api.groq.com/openai/v1/models` returns the active model roster. Treat this as the live source of truth over any hardcoded list.
- **JSON mode / structured outputs:**
  - `response_format: {"type": "json_object"}` — basic JSON-mode, syntactically valid JSON but **not** schema-guaranteed.
  - `response_format: {"type": "json_schema", "json_schema": {...}, "strict": true|false}` — real structured outputs.
    - `strict: true` (constrained decoding, guaranteed schema adherence) is currently only confirmed for `gpt-oss-20b` and `gpt-oss-120b`.
    - `strict: false` (best-effort) additionally works on `gpt-oss-safeguard-20b`.
    - All other models fall back to JSON-object mode only.
  - **Quirk:** "Streaming and tool use are not currently supported with Structured Outputs" per Groq's own docs — an adapter must not silently combine `stream: true` with `json_schema` for Groq.
- **Streaming:** Standard SSE `chat.completion.chunk` events; `stream_options.include_usage` not explicitly confirmed in docs retrieved — **UNVERIFIED**, test before relying on it.
- **Deviations from vanilla OpenAI Chat Completions:**
  - Unsupported request fields: `logprobs`, `logit_bias`, `top_logprobs`, `messages[].name`; `n` must be `1` if supplied at all.
  - `temperature: 0` is silently rewritten to `1e-8` server-side (valid range documented as `> 0` and `<= 2`).
  - Audio: `vtt`/`srt` transcription response formats unsupported.
  - Reasoning models expose `reasoning_effort` and an `include_reasoning` param controlling whether a `reasoning` field appears in the response.
- **Notable current model IDs** (cross-checked against docs + deprecation/changelog pages, Aug 2026):
  - `openai/gpt-oss-120b`, `openai/gpt-oss-20b`, `openai/gpt-oss-safeguard-20b` — current flagship open-weight lineup, strict structured-output support.
  - `moonshotai/kimi-k2-instruct` — Kimi K2 (1T-param MoE, 128K context). Note: `moonshotai/kimi-k2-instruct-0905` was **deprecated March 23, 2026** in favor of `gpt-oss-120b`; whether the base `kimi-k2-instruct` id is still live should be confirmed via `/models`. **UNVERIFIED (possible further deprecation)**.
  - `meta-llama/llama-4-maverick-17b-128e-instruct` — Llama 4 Maverick, appears in current listings.
  - `meta-llama/llama-4-scout-17b-16e-instruct` — Llama 4 Scout was flagged as **deprecated June 17, 2026** — do not assume it is still callable. **UNVERIFIED (may already be removed)**.
  - `llama-3.3-70b-versatile`, `llama-3.1-8b-instant` — still commonly referenced legacy Llama 3.x models.
  - `qwen/qwen3-32b` — also flagged for deprecation June 17, 2026; a newer `qwen3.6-27b`-style preview id was mentioned in secondary sources but is **UNVERIFIED**.
  - `whisper-large-v3`, `whisper-large-v3-turbo` — speech-to-text, not chat.
  - `groq/compound`, `groq/compound-mini` — Groq's own agentic system with built-in web search/code execution, not a plain chat model; treat separately in a generic adapter (it may add response fields beyond vanilla chat completions).
  - **Action item for adapter:** because Groq deprecates/renames models on a roughly monthly cadence, hardcode only 2–3 "known good" defaults (`openai/gpt-oss-120b` is the safest bet) and always offer a live `/models` fetch for the picker UI.

## 2. Mistral

- **Base URL:** `https://api.mistral.ai/v1`
- **Auth header:** `Authorization: Bearer <MISTRAL_API_KEY>`
- **`/models`:** Supported (standard `GET /v1/models`), matches OpenAI shape.
- **JSON mode / structured outputs:**
  - `response_format: {"type": "json_object"}` — available on **all** current Mistral models.
  - `response_format: {"type": "json_schema", "json_schema": {...}}` — custom structured output, described in Mistral's "Custom Structured Outputs" docs.
  - **Quirk:** for structured outputs combined with streaming, Mistral's docs specifically note the schema must be passed as a plain JSON Schema object, not a framework-native model class (e.g. not a raw Pydantic object) — relevant only to SDK users, not to a raw HTTP adapter, but worth noting if the extension ever accepts schema objects from a UI helper library.
- **Streaming:** Standard OpenAI-style SSE chunks via `stream: true`.
- **Notable current model IDs:** Mistral versions its models with date suffixes and also offers `-latest` aliases. Confirmed via official deprecation table plus recent-model cross-checks:
  - `mistral-large-latest` (currently resolves to a 2025-era Large; exact dated id e.g. `mistral-large-2411` was the last officially documented snapshot — a newer "Mistral Large 3" generation is reported in 2026 secondary sources but its exact dated id is **UNVERIFIED**).
  - `mistral-medium-latest` (secondary sources report the underlying snapshot as `mistral-medium-2508`; a further "Medium 3.5" generation reported in 2026 press is **UNVERIFIED** for exact id).
  - `mistral-small-latest` (last confirmed dated snapshot `mistral-small-2506`; reports of a unified "Mistral Small 4" — merging Magistral reasoning, Pixtral vision, and Devstral coding into one small model — are **UNVERIFIED** for exact id/date).
  - `magistral-medium-latest`, `magistral-small-latest` — the reasoning-tuned line; exact current dated snapshot **UNVERIFIED**.
  - `codestral-latest` (last confirmed dated snapshot `codestral-2501`).
  - `pixtral-large-latest` (last confirmed dated snapshot `pixtral-large-2411`) — vision.
  - `open-mistral-nemo`, `open-mixtral-8x22b` — still-documented open-weight legacy ids.
  - `mistral-embed`, `codestral-embed` — embeddings, not chat.
  - **Recommendation for adapter:** prefer the `-latest` aliases (`mistral-large-latest`, `mistral-medium-latest`, `mistral-small-latest`, `magistral-medium-latest`) as the one-line preset defaults rather than dated snapshots, since Mistral rotates the dated ids underneath the alias and the alias is documented as the stable pointer.
- **Deviations from vanilla OpenAI:** otherwise very close to OpenAI Chat Completions; `safe_prompt` is a Mistral-specific boolean request field (adds a safety system prompt) with no OpenAI equivalent — adapter should treat it as optional/ignorable.

## 3. xAI (Grok)

- **Base URL:** `https://api.x.ai/v1`
- **Auth header:** `Authorization: Bearer <XAI_API_KEY>`
- **`/models`:** Supported, standard shape (per xAI SDK/docs conventions) — **not independently re-verified against a raw fetch in this pass**, treat as likely-supported but **UNVERIFIED**.
- **JSON mode / structured outputs:**
  - `response_format: {"type": "json_schema", "json_schema": {...}}` — primary structured-output mechanism, schema-guaranteed "when using supported schema features."
  - Accepts a **practical subset** of JSON Schema Draft 2020-12/Draft-07: string, number, integer, boolean, null, enum, array, object, `anyOf`, `oneOf`, non-circular `$ref`.
  - **Quirk:** `additionalProperties` defaults to `false` and the API requires it be **explicitly set to `true`** if you want extra properties allowed — opposite-feeling from some other providers' defaults, worth a note in adapter validation.
  - String format enforcement limited to: `date`, `time`, `date-time`, `email`, `uuid`, `ipv4`, `ipv6`, `uri`.
  - `minLength`/`maxLength` guaranteed only up to 2,048 chars; `minItems`/`maxItems` guaranteed only up to 256 items — larger bounds are best-effort, not guaranteed.
  - Tool calling also supports strict schema conformance (implicit `strict: true` on tool arguments).
- **Streaming:** xAI's own SDK supports streaming structured outputs (`response_format` + `stream()`), chunks build up a partial JSON string progressively. Raw HTTP SSE shape is standard OpenAI-style `chat.completion.chunk` — **not independently confirmed byte-for-byte in this pass**.
- **Reasoning model quirks:** Grok's reasoning models (the "Grok 4.x" line) expose configurable reasoning effort; per secondary sources, "Grok 4.6" (flagship as of mid-2026) supports agentic tool calling and a large (~500K token, per one secondary source) context window with configurable reasoning — **model naming/specs UNVERIFIED against a primary spec page**, treat as indicative only.
- **Notable current model IDs:** exact current ids (e.g. `grok-4`, `grok-4-fast`, `grok-4.1`, `grok-4.6`) are **UNVERIFIED** — xAI's model line has moved fast through 2025–2026 and official docs pages were not directly confirmed for a dated table in this pass. Adapter should treat the model id as a free-text field for xAI rather than hardcoding a specific version, or fetch `/v1/models` live.
- **Deviations from vanilla OpenAI:** structured-outputs JSON-Schema subset restrictions above are the main functional deviation; otherwise xAI markets itself as a near-drop-in OpenAI-compatible endpoint.

## 4. Together AI

- **Base URL:** `https://api.together.xyz/v1` (Together's own docs also reference `https://api.together.ai/v1` — both host names have been seen in official material; prefer `api.together.xyz/v1` as the long-standing documented one, but treat the `.ai` host as **UNVERIFIED**-equivalent alias).
- **Auth header:** `Authorization: Bearer <TOGETHER_API_KEY>`
- **`/models`:** Supported, standard OpenAI-shaped listing across Together's large catalog (200+ models).
- **JSON mode / structured outputs:**
  - `response_format` with a JSON Schema — Together documents this as following "the official OpenAI Structured Outputs specification," i.e. `{"type": "json_schema", "json_schema": {...}, "strict": true}`.
  - **Streaming + structured outputs supported**, but the adapter must accumulate: Together's own docs describe the model streaming *valid partial JSON* and recommend collecting all chunks and parsing once the stream completes rather than parsing each chunk independently — same general pattern OpenAI itself recommends, but worth calling out explicitly since not all providers stream schema-constrained output incrementally at all (see Groq above, which disallows streaming + structured outputs entirely).
  - `strict: true` enforcement guarantee varies by underlying model — Together is a multi-vendor router, so whether strict mode is truly guaranteed depends on which of the 200+ hosted models is selected.
- **Notable current model IDs:** Together's catalog spans Llama, Qwen, DeepSeek, GLM, Kimi (K2-class), and Mistral families served through one API. Exact current headline ids (e.g. specific Llama 4 or DeepSeek variant strings) were **not confirmed against a raw model table** in this pass — **UNVERIFIED**, use `/v1/models` live.
- **Deviations from vanilla OpenAI:** functionally closest to a full-catalog OpenAI-compatible reseller; main adapter-relevant quirk is the sheer model-id sprawl (organization-prefixed ids like `meta-llama/Llama-4-...`) and that structured-output guarantees are model-dependent rather than API-dependent.

## 5. Cerebras

- **Base URL:** `https://api.cerebras.ai/v1`
- **Auth header:** `Authorization: Bearer <CEREBRAS_API_KEY>` (standard OpenAI client — pass key via `apiKey`)
- **`/models`:** Presumed supported (OpenAI-compatible client works against the base URL) — exact confirmation of a `/v1/models` listing endpoint is **UNVERIFIED** in this pass; Cerebras' docs point to a separate `llms.txt` reference for the model roster rather than emphasizing a live endpoint.
- **JSON mode / structured outputs:**
  - `response_format` with JSON Schema is supported.
  - **Quirk — important:** tool calling and structured outputs are documented as working **individually but not reliably combined**: "Support for combining `tools` and `response_format` is model-dependent. `gpt-oss-120b` rejects requests containing both fields." An adapter should not send both params together for Cerebras, or should special-case per-model.
  - Non-standard/extra params (e.g. custom sampling knobs) should be passed through `extra_body` when using the OpenAI client, or as regular kwargs via Cerebras' own SDK.
  - `system` / `developer` message roles: for `gpt-oss-120b` specifically, a `developer` role message is mapped internally to developer-level instructions — a nuance versus plain OpenAI role handling.
- **Streaming:** Not explicitly detailed in the retrieved docs — **UNVERIFIED**, assume standard SSE `chat.completion.chunk` given general OpenAI-compat framing, but test `stream_options.include_usage` before relying on it.
- **Notable current model IDs:** Cerebras has trimmed its public catalog significantly through 2026. As of the retrieval-adjacent sources:
  - `gpt-oss-120b` — the one model explicitly called "production-sanctioned" in a mid-2026 rate card, `$0.35`/`$0.75` per M tokens (in/out) per a secondary source.
  - `llama3.1-8b`, `qwen-3-235b-a22b-instruct-2507`, `zai-glm-4.7` — appear in a secondary-sourced catalog snapshot; `zai-glm-4.7` was reportedly slated for deprecation **August 17, 2026** (i.e. possibly already gone as of this doc's retrieval date of Aug 23, 2026). All of these ids are **UNVERIFIED** against a primary current table — Cerebras' catalog appears to be actively shrinking/rotating, so the adapter should fetch models live rather than hardcode beyond `gpt-oss-120b`.
  - Additional families (Llama 3.3 70B, Llama 4 Scout/Maverick, DeepSeek R1 distills, Qwen3-32B) are reportedly available only via **Dedicated Endpoints** (reserved capacity, separate from the shared/public endpoint) rather than the shared `/v1` base — relevant if the adapter assumes any model id works on the shared key.

## 6. Perplexity (Sonar)

- **Base URL:** `https://api.perplexity.ai`
- **Auth header:** `Authorization: Bearer <PERPLEXITY_API_KEY>`
- **`/models`:** **No `/models` endpoint** is documented — confirms the task brief's suspicion. The adapter must hardcode/allow-list Sonar model ids for Perplexity rather than offering a live-fetched picker.
- **Current Sonar model IDs:** `sonar`, `sonar-pro` are the two headline tiers (`sonar` = faster/simpler queries, `sonar-pro` = deeper research, runs multiple searches per query and typically returns roughly 2x the citations of base `sonar`). Additional/reasoning-oriented tiers (e.g. a `sonar-reasoning` family) have existed historically; exact current full lineup as of Aug 2026 is **UNVERIFIED** beyond `sonar`/`sonar-pro`.
- **Response shape deviations from vanilla OpenAI:**
  - Standard fields present: `id`, `model`, `created`, `choices`, `usage`, `object`, `choices[].message.{role,content}`, `choices[].finish_reason`.
  - **Extra, Perplexity-specific top-level fields:**
    ```json
    {
      "citations": ["https://example.com/a", "https://example.com/b"],
      "search_results": [
        {
          "title": "...",
          "url": "https://...",
          "date": "2026-08-01",
          "last_updated": "2026-08-20",
          "snippet": "...",
          "source": "..."
        }
      ],
      "usage": {
        "prompt_tokens": 0,
        "completion_tokens": 0,
        "total_tokens": 0,
        "cost": {
          "input_tokens_cost": 0,
          "output_tokens_cost": 0,
          "citation_tokens_cost": 0
        }
      }
    }
    ```
    A generic adapter should treat `citations` and `search_results` as optional bonus fields to surface in the UI when present, and not choke if they're absent for non-Sonar-style responses.
- **Streaming:** `stream: true` produces OpenAI-style delta chunks; per docs, citations/search_results are attached to (or reconstructable from) the final aggregated response rather than necessarily on every chunk — adapter should not assume `citations` appears until stream completion.
- **Deprecation note (time-sensitive, confirm before shipping):** Perplexity's docs (as retrieved) state the classic Sonar Chat Completions surface is being migrated toward a newer "Agent API," with the old surface supported only **until September 27, 2026**. Since that is roughly a month after this doc's retrieval date, **this is a near-term breaking change the adapter should track** — worth a follow-up check closer to ship date. Marked **UNVERIFIED** only in the sense that the exact cutover mechanics (does the URL/shape change, or just get deprecated in favor of a new path?) were not confirmed in depth here.
- **No JSON-mode/structured-output confirmation:** Perplexity's docs emphasize the search-grounded response shape; explicit `response_format` JSON-schema support was **not confirmed** in the retrieved material — **UNVERIFIED**, don't assume parity with OpenAI structured outputs here.

---

## Local Inference Servers

## 7. Ollama

- **OpenAI-compatible endpoint:** `http://localhost:11434/v1` — exposes `/v1/chat/completions`, `/v1/completions`, `/v1/embeddings`, `/v1/models`, `/v1/models/{model}`, and (as of Ollama v0.13.3+) a non-stateful `/v1/responses`.
- **Native endpoint (richer, Ollama-specific):** `/api/chat`, `/api/generate`, etc. on the same host/port — not OpenAI-shaped, uses a `format` parameter (either `"json"` or a full JSON-schema object) for structured output rather than `response_format`. The OpenAI-compat surface is a translation layer on top of this native API, so it inherits some rough edges rather than being a from-scratch OpenAI clone.
- **Auth:** No real authentication. The OpenAI-compat layer requires *an* `api_key` be present in the client (many OpenAI SDKs error on empty key), but Ollama **ignores its value** — the documented convention is to pass a dummy string, e.g. `api_key: "ollama"`.
- **`/v1/models`:** Supported — lists locally pulled models in OpenAI-list shape.
- **JSON mode / structured outputs via the OpenAI-compat path:** `response_format` is supported on `/v1/chat/completions` and `/v1/completions` for JSON mode. Explicit `json_schema`-style structured outputs (schema-guaranteed) through the OpenAI-compat surface were **not clearly confirmed** in the retrieved docs — Ollama's schema-constrained generation is documented primarily via the native `/api/chat` `format` field (which accepts a full JSON Schema object directly, not wrapped in `response_format`). If the adapter wants guaranteed schema output from Ollama, using the native `format` field via a provider-specific code path may be more reliable than `response_format: json_schema` through the compat shim — **flag this as worth a direct test**, marked **UNVERIFIED** at the compat-layer level.
- **Streaming:** Both `/v1/chat/completions` and `/v1/completions` support `stream: true`; `stream_options.include_usage` is documented as available.
- **CORS / `OLLAMA_ORIGINS`:** This is the sharpest practical gotcha for a Chrome extension.
  - By default, Ollama's server only allows a narrow set of origins (localhost variants, `127.0.0.1`, etc.) — a `chrome-extension://<id>` origin is **not** allowed by default and requests will fail CORS preflight.
  - Fix: set the `OLLAMA_ORIGINS` environment variable before starting the server, e.g. `OLLAMA_ORIGINS="chrome-extension://*"` (or the extension's specific `chrome-extension://<id>` origin) to allow it. On macOS with the packaged app, this typically requires `launchctl setenv OLLAMA_ORIGINS "chrome-extension://*"` followed by an app restart (env vars set in a shell won't reach a GUI-launched app); on Windows, set it via the system environment-variables panel; in Docker, pass `-e OLLAMA_ORIGINS="*"` (or a scoped value) to the container.
  - **Adapter implication:** the extension's setup/onboarding UI for the Ollama preset should explicitly surface this — a plain "point at localhost:11434" instruction will silently fail with a CORS error for most users until they set `OLLAMA_ORIGINS`. This is worth a dedicated troubleshooting note/link in the preset's UI copy.

## 8. LM Studio

- **Base URL:** `http://localhost:1234/v1` (default; user-configurable port in LM Studio's server settings).
- **Endpoints:** `/v1/chat/completions`, `/v1/completions`, `/v1/embeddings`, `/v1/models` — designed to be a drop-in for any tool that speaks the OpenAI Chat Completions schema, "just swap the base URL."
- **`/v1/models`:** Supported, lists currently-loaded model(s).
- **`response_format` / structured output (`json_schema`):** Supported directly at `/v1/chat/completions` — LM Studio can enforce a JSON Schema and produce typed/validated JSON output, documented at LM Studio's own "Structured Output" dev docs page. This is a stronger guarantee than several cloud providers above (no combine-with-tools caveat mentioned).
- **Streaming:** Supported, standard SSE.
- **CORS:** LM Studio's local server documents CORS support as one of its built-in server features (alongside streaming). Exact default-allowed-origins behavior (whether `chrome-extension://` origins work out of the box or need an explicit toggle) was **not independently confirmed** in this pass — **UNVERIFIED**; recommend the adapter treat it the same cautious way as Ollama (assume it may need an explicit "allow CORS" toggle in LM Studio's server settings UI) until verified against a running instance.
- **Auth:** No real API key required; LM Studio typically accepts any string for `api_key` on the client side (consistent with other local servers), though whether it silently ignores an `Authorization` header entirely vs. optionally checking one was **UNVERIFIED** in the retrieved docs.
- Also newer: LM Studio has started supporting the OpenAI *Responses* API surface for local models (per an LM Studio v0.3.29 blog post) in addition to Chat Completions — likely not needed for a generic Chat-Completions-based adapter, but worth knowing it exists if the extension ever adds Responses-API support.

## 9. llama.cpp server / vLLM

- **llama.cpp server (`llama-server`):** Base URL convention `http://<host>:<port>/v1` (default port `8080`, configurable via `--port`). Exposes `/v1/chat/completions` and related OpenAI-shaped paths; the OpenAI Python SDK works by just swapping `base_url` and passing any placeholder string as `api_key` (e.g. `"no-key-required"`) since llama.cpp doesn't enforce auth by default. Compatibility level is high for the core Chat Completions shape (streaming, basic tool calling in recent builds) but it's a single-binary, single-model-at-a-time server with fewer of the provider-grade guarantees (structured-output schema enforcement, `/v1/models` richness, `stream_options.include_usage`) — treat it as "good enough for the happy path, verify edge-case fields before relying on them." It additionally ships an Ollama-API-compatible shim on the same binary, which is a llama.cpp-specific bonus not present in vanilla OpenAI compat.
- **vLLM (`vllm serve`):** Base URL convention `http://localhost:8000/v1` by default. Very strong OpenAI-compat coverage — it's frequently used as the reference self-hosted implementation — including chat completions, completions, embeddings, and (from recent versions) a unified `structured_outputs` request field for schema-constrained generation (superseding the older provider-specific `guided_json`/`guided_choice`/etc. params, which are now deprecated in favor of `{"structured_outputs": {"json": ...}}` or an equivalent `extra_body` payload). Because vLLM is typically run by more technical/self-hosting users, an adapter can generally assume closer-to-spec behavior here than with llama.cpp, but the exact param name for structured outputs has changed across vLLM versions (`guided_json` → `structured_outputs`), so a generic adapter targeting "any vLLM instance" should tolerate both older and newer param names or make the structured-output path a soft-fail/no-op if unsupported.

---

## Cross-Cutting: Common Failure Modes of "OpenAI-Compatible" Claims

A generic OpenAI-compat adapter should be defensive about all of the following, since "OpenAI-compatible" in provider marketing rarely means byte-for-byte spec parity:

1. **`stream_options.include_usage` is not universally honored.** Some providers silently ignore it (no usage chunk ever arrives), some error on the unknown field, some support it fully. Treat a missing final usage chunk as expected-possible, not an error condition.
2. **`response_format: json_schema` support is inconsistent and sometimes mutually exclusive with other features.** Seen directly in this research: Groq disallows `stream: true` + structured outputs entirely; Cerebras disallows `tools` + `response_format` together on at least one model; strict-mode schema *guarantees* vs. best-effort vary per provider and even per model within a provider. The adapter should treat structured-output "strict" guarantees as a spectrum, not a boolean capability flag, and should let request construction degrade gracefully (e.g. drop `strict` or fall back to `json_object` mode) rather than hard-fail.
3. **Different error envelopes.** OpenAI's error shape (`{"error": {"message", "type", "param", "code"}}`) is not guaranteed to be replicated verbatim — some providers wrap errors differently, use different HTTP status conventions for rate limits vs. invalid requests, or return plain-text/non-JSON bodies on 5xx. A generic adapter should parse errors defensively (try the standard shape, fall back to raw body/status text) rather than assuming `error.message` always exists.
4. **SSE stream framing quirks.** Some servers send `: keep-alive` comment lines or blank heartbeat events during long-running/thinking phases (particularly reasoning models) that a naive SSE parser might mishandle if it assumes every `data:` line is a JSON chunk. The adapter's stream parser must skip non-`data:` lines and tolerate `data: [DONE]` sentinel handling that may or may not be followed by a final usage-only chunk.
5. **Missing or partial `/models` endpoint.** Perplexity has none at all; several local servers only list *currently loaded* models rather than "all installable" ones; a generic adapter's model-picker UI needs a manual-entry fallback for any preset, not just a dropdown wired to `/models`.
6. **Auth header presence-but-ignored vs. genuinely required.** Local servers (Ollama, LM Studio, llama.cpp) generally accept any placeholder API key because the underlying OpenAI SDK client requires a non-empty string, but don't actually validate it — different from cloud providers where a bad key is a hard 401. An adapter's "test connection" flow should not assume a 200 response proves the key is real when the base URL is a local server.
7. **CORS is the silent killer for a browser extension specifically.** This is arguably the single most extension-relevant failure mode: cloud providers generally send permissive CORS headers (or the extension's declared host permissions bypass the issue via background-script fetches), but local servers default to same-origin-ish allowlists (Ollama's `OLLAMA_ORIGINS` is the clearest documented example) that do **not** include `chrome-extension://` origins out of the box. A request that works fine from `curl` or a Node script can fail silently/cryptically from the extension's fetch context. The adapter should special-case local-server presets with explicit setup instructions (env vars / server-settings toggles) rather than assuming "OpenAI-compatible" implies "CORS-permissive."
8. **Model-id churn.** Several providers researched here (Groq, Cerebras especially) rotate/deprecate model ids on a monthly-ish cadence. Hardcoded default model ids in a one-line preset will go stale; prefer live `/models` fetches wherever available, and treat any hardcoded default as a "known good as of doc date" fallback rather than a permanent constant.

---

## Summary of UNVERIFIED Items

- Groq: `stream_options.include_usage` support; whether `moonshotai/kimi-k2-instruct` (undated) is still live vs. only the deprecated `-0905` variant; whether `llama-4-scout` / `qwen3-32b` are still callable post their flagged June 2026 deprecations; exact current Qwen preview id.
- Mistral: exact current dated snapshot ids behind `mistral-large-latest`, `mistral-medium-latest`, `mistral-small-latest`, `magistral-medium-latest` (reports of "Large 3," "Medium 3.5," and a unified "Small 4" generation in 2026 press are UNVERIFIED against a primary dated table).
- xAI: `/v1/models` support; exact raw SSE chunk shape; current flagship model id(s) (e.g. "Grok 4.6") and their exact specs (context window, pricing) — sourced only from secondary material.
- Together AI: correct canonical base URL host (`api.together.xyz` vs `api.together.ai` — both seen in official-adjacent material); exact current headline model ids.
- Cerebras: `/v1/models` endpoint existence; streaming quirks generally; current full model roster and exact deprecation dates (`zai-glm-4.7` reportedly deprecated Aug 17, 2026, i.e. possibly already gone by this doc's retrieval date); which models beyond `gpt-oss-120b` are on the shared endpoint vs. Dedicated-Endpoints-only.
- Perplexity: full current Sonar model lineup beyond `sonar`/`sonar-pro`; explicit structured-output (`response_format`) support; exact mechanics of the Sonar Chat Completions → Agent API migration ahead of its Sep 27, 2026 cutover.
- Ollama: whether `response_format: json_schema` (schema-guaranteed, not just JSON-mode) is supported through the OpenAI-compat layer specifically, vs. only via the native `/api/chat` `format` field.
- LM Studio: default CORS-allowed-origins behavior for `chrome-extension://` origins specifically (assume it needs an explicit allow, unverified); whether an `Authorization` header is checked at all vs. fully ignored.
- llama.cpp / vLLM: general "high compatibility" characterization is directionally solid but specific edge-case field support (e.g. `stream_options`, exact structured-output param name per version) was not exhaustively verified per version.

File written to: `/home/karol/Documents/GitHub/eth-lecture-copilot/docs/providers/oai-compat.md`
