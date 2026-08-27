# Reasoning / thinking controls per provider (OpenAI-compatible `/chat/completions`)

**Retrieved: 2026-08-27.** All quotes are verbatim from the provider's own documentation as fetched on
that date. Where a provider does not document something, it is marked **UNVERIFIED** — do not guess a
value, a wrong parameter is an HTTP 400 that takes the whole provider down for our users.

## Sources actually fetched

| Provider | URL |
| --- | --- |
| Groq | https://console.groq.com/docs/reasoning |
| xAI | https://docs.x.ai/docs/guides/reasoning · https://docs.x.ai/docs/models |
| Alibaba Model Studio (DashScope) | https://www.alibabacloud.com/help/en/model-studio/deep-thinking |
| Z.ai / Zhipu GLM | https://docs.z.ai/guides/capabilities/thinking.md · https://docs.z.ai/guides/capabilities/thinking-mode.md |
| Moonshot / Kimi | https://platform.moonshot.ai/docs/guide/use-kimi-k2-thinking-model (`.md`) · https://platform.moonshot.ai/docs/api/models-overview.md |
| Mistral | https://docs.mistral.ai/capabilities/reasoning/ |
| Cerebras | https://inference-docs.cerebras.ai/capabilities/reasoning.md · https://inference-docs.cerebras.ai/api-reference/chat-completions.md · https://inference-docs.cerebras.ai/models/openai-oss.md |
| Together AI | https://docs.together.ai/docs/inference/chat/reasoning |
| Fireworks AI | https://docs.fireworks.ai/guides/reasoning.md · https://docs.fireworks.ai/api-reference/post-chatcompletions.md |
| NVIDIA NIM | https://docs.nvidia.com/nim/vision-language-models/1.7.0/examples/qwen3.6/api.html · .../gemma-4-31b-it/api.html · https://docs.nvidia.com/nim/large-language-models/1.8.0/reasoning-model.html |
| Perplexity | https://docs.perplexity.ai/api-reference/chat-completions-post.md |
| Cohere | https://docs.cohere.com/docs/reasoning.md · https://docs.cohere.com/docs/compatibility-api.md |
| HuggingFace router | https://huggingface.co/docs/inference-providers/en/tasks/chat-completion |
| SambaNova | https://docs.sambanova.ai/docs/api-reference/chat-completions/create-chat-based-completion.md · https://docs.sambanova.ai/docs/en/build/reasoning |
| Hyperbolic | https://www.hyperbolic.ai/docs/inference/overview |
| Ollama | https://docs.ollama.com/api/openai-compatibility · https://docs.ollama.com/capabilities/thinking |
| LM Studio | https://lmstudio.ai/docs/developer/openai-compat/chat-completions · .../responses · https://lmstudio.ai/docs/app/modelyaml |

---

## Groq (`https://api.groq.com/openai/v1`) — CONFIRMED

**1. Reasoning models.** The docs list exactly these under "Supported Models":

> `openai/gpt-oss-20b`, `openai/gpt-oss-120b`, `openai/gpt-oss-safeguard-20b`, `qwen/qwen3.6-27b`,
> `qwen/qwen3.8-27b`, `minimaxai/minimax-m2.7`

**2. Parameters.** Three separate ones: `reasoning_effort`, `reasoning_format`, `include_reasoning`.

**3. Accepted values.** From the "Recommended Configuration Parameters" table (verbatim):

> `reasoning_effort` — default `default` — `"none"`, `"default"`, `"low"`, `"medium"`, `"high"` —
> Controls the level of effort the model will put into reasoning. **`none` and `default` are only
> supported by Qwen 3.6 27B and Qwen 3.8 27B. `low`, `medium`, and `high` are only supported by
> GPT-OSS 20B, GPT-OSS 120B, and Qwen 3.8 27B.**

Per-model tables:

> Options for Reasoning Effort (Qwen 3.6 27B) … `none` Disable reasoning. The model will not use any
> reasoning tokens. `default` Enable reasoning.

> Options for Reasoning Effort (GPT-OSS) … The `reasoning_effort` parameter … **is only supported by
> GPT-OSS 20B and GPT-OSS 120B.** `low` … `medium` … `high`

So **there is no off value for gpt-oss on Groq.** The floor is `"low"`. Sending `"none"` to gpt-oss is
outside the documented value set for that model.

`reasoning_format` (non-GPT-OSS models only) — default `raw`:

> `parsed` Separates reasoning into a dedicated `message.reasoning` field while keeping the response
> concise. `raw` Includes reasoning within `<think>` tags in the main text content. `hidden` Returns
> only the final answer.

> Note: The format defaults to `raw` or `parsed` when JSON mode or tool use are enabled as those modes
> do not support `raw`. **If reasoning is explicitly set to `raw` with JSON mode or tool use enabled, we
> will return a 400 error.**

`include_reasoning` (GPT-OSS only):

> `true` Includes the reasoning in a dedicated `message.reasoning` field. **This is the default
> behavior.** `false` Excludes reasoning from the response.
> Note: The `include_reasoning` parameter **cannot be used together with `reasoning_format`. These
> parameters are mutually exclusive.**

Important: `include_reasoning: false` only hides the trace — the model still reasons and still burns
the tokens/latency. For gpt-oss the only latency lever is `reasoning_effort: "low"`.

**4. Omitted.** `reasoning_effort` defaults to `"default"`; gpt-oss defaults to reasoning on (the
docs' plain example with no parameters returns a populated `reasoning` field).

**5. Off-value on a non-reasoning Groq model (e.g. Llama).** UNVERIFIED — the docs do not say.

```json
{ "model": "qwen/qwen3.6-27b", "reasoning_effort": "none", "reasoning_format": "hidden" }
{ "model": "openai/gpt-oss-120b", "reasoning_effort": "low", "include_reasoning": false }
```

---

## xAI (`https://api.x.ai/v1`) — CONFIRMED (and the answer is: you cannot turn it off)

**1. Reasoning models.** All current text models: `grok-4.6`, `grok-4.5`, `grok-4.20-multi-agent`. The
models page lists Grok 4.6 with "Reasoning: Configurable".

**2. Parameter.** `reasoning_effort` (Chat Completions) / `reasoning.effort` (Responses API).

**3. Values.** `"low"`, `"medium"`, `"high"`, `"xhigh"`. **There is no off value.**

> `grok-4.6` and `grok-4.5` support the `reasoning_effort` parameter, which controls how much effort
> the model spends thinking before responding. **If not specified, `reasoning_effort` defaults to
> `"high"`. Reasoning cannot be disabled.**

> `"xhigh"` is available on `grok-4.6` and later. On models that do not support it, such as `grok-4.5`,
> requests with `"xhigh"` are treated as `"high"`.

Summary table in the docs:

> | grok-4.6 | `reasoning.effort`: `"low"` / `"medium"` / `"high"` (default) / `"xhigh"` | Controls reasoning depth (cannot be disabled) |
> | grok-4.5 | `reasoning.effort`: `"low"` / `"medium"` / `"high"` (default) | Controls reasoning depth (cannot be disabled) |
> | grok-4.20-multi-agent | `reasoning.effort`: … | Controls agent count (4 or 16) |

**4. Omitted.** Defaults to `"high"` — i.e. maximum-latency reasoning. **Always send `"low"`.**

**5. Non-reasoning models.** N/A — xAI currently ships no non-reasoning text model.

Also relevant to a hanging-request bug:

> `presencePenalty`, `frequencyPenalty`, and `stop` cannot be used with reasoning models. **Requests
> that include them return an error.**

```json
{ "model": "grok-4.6", "reasoning_effort": "low" }
```

---

## Alibaba Cloud Model Studio / Qwen DashScope (`…/compatible-mode/v1`) — CONFIRMED

**1. Reasoning models.** Large list; the mode differs per model. Verbatim excerpts:

> Qwen3.7 Max series (hybrid thinking mode, **thinking enabled by default**): qwen3.7-max, qwen3.7-max-us, …
> Qwen3.7 Max series (**thinking mode only**): qwen3.7-max-preview, qwen3.7-max-2026-05-17
> Qwen3.6 Plus / Flash series (hybrid thinking mode, **thinking enabled by default**): qwen3.6-plus, qwen3.6-flash, …
> Qwen3.5 … Hybrid thinking mode, **thinking enabled by default**: qwen3.5-397b-a17b, qwen3.5-122b-a10b, qwen3.5-27b, qwen3.5-35b-a3b
> Qwen Max/Plus/Flash/Turbo series (hybrid thinking mode, **thinking disabled by default**): qwen3-max, qwen-plus, qwen-flash, qwen-turbo …
> Open-source [Qwen3] Hybrid thinking mode, **thinking enabled by default**: qwen3-235b-a22b, qwen3-32b, qwen3-30b-a3b, qwen3-14b, qwen3-8b
> **Thinking-only mode**: qwen3-next-80b-a3b-thinking, qwen3-235b-a22b-thinking-2507, qwq-plus, deepseek-r1 …
> GLM Hybrid thinking mode, **thinking enabled by default**: glm-5.2, glm-5.1, glm-5, glm-4.7, glm-4.6, glm-4.5, glm-4.5-air
> Kimi (on Model Studio) Hybrid thinking mode, **thinking disabled by default**: kimi-k2.6, kimi-k2.5

**2. Parameter.** `enable_thinking` (boolean), plus optional `thinking_budget` (int).

> Hybrid thinking mode: Use the `enable_thinking` parameter to switch between thinking and
> non-thinking on a per-request basis: Set to `true` — the model reasons before responding. **Set to
> `false` — the model responds directly, skipping the reasoning step.**

> Since `enable_thinking` is not a standard OpenAI parameter, pass it in `extra_body`.

**3. Off value.** `"enable_thinking": false`. Prompt-suffix alternative on some models:

> For the Qwen3 open-source hybrid thinking models, along with the `qwen-plus-2025-04-28` and models,
> you can also control thinking mode with prompt suffixes. When `enable_thinking` is `true`, append
> `/no_think` to a prompt to skip reasoning for that turn, or append `/think` to re-enable it.

**4. Omitted.** Model-dependent — see the list above. Modern models (Qwen3.5/3.6/3.7, GLM) are
**thinking-enabled by default**; the older `qwen-plus`/`qwen-max`/`qwen-turbo`/DeepSeek-V3.x line is
disabled by default. Send `enable_thinking: false` explicitly rather than relying on the default.

**5. Sending the off value where it doesn't apply.** For thinking-only models:

> Thinking-only mode: The model always reasons before responding — this behavior cannot be disabled.
> The request format is the same as hybrid thinking mode; **no `enable_thinking` parameter is needed.**

Whether `false` errors on a thinking-only model is UNVERIFIED. One error IS documented and is the
likely cause of an apparent hang:

> Some models (such as the open-source `qwen3-235b-a22b` and `qwen3-32b`) support streaming only. A
> non-streaming call returns the error **`parameter.enable_thinking only support stream call`**; use
> streaming for these models.

```json
{ "model": "qwen3.6-flash", "messages": [...], "enable_thinking": false }
```

---

## Z.ai / Zhipu GLM (`https://api.z.ai/api/paas/v4`) — CONFIRMED

**1. Reasoning models.** GLM-5.3, GLM-5.3-Flash, GLM-5.2, GLM-5.1, GLM-5, GLM-5-Turbo, GLM-5V-Turbo,
GLM-4.7, GLM-4.6, GLM-4.5, GLM-4.5V.

**2. Parameters.** `thinking: {"type": …}` and `reasoning_effort`.

**3. Values.** Verbatim from "Core Parameters":

> Note: **GLM-5.3 and GLM-5.3-FLASH no longer support disabling thinking (an error will occur if the
> `thinking.type` parameter in the API request is set to `disabled`).** Please ensure that thinking is
> enabled.
>
> * **`thinking.type`**: Controls the deep thinking mode
>   * `enabled` (default): Enable dynamic thinking. The model automatically determines whether to
>     think: `GLM-5.2`, `GLM-5.1`, `GLM-5`, `GLM-5-Turbo`, `GLM-5V-Turbo`, `GLM-4.6`, and `GLM-4.5`
>     auto-decide whether to think, while `GLM-5.3`, `GLM-5.3-FLASH`, `GLM-4.7` and `GLM-4.5V` use
>     forced thinking
>   * `disabled`: Disable deep thinking, provide direct answers
> * **`reasoning_effort`**: Controls the degree of reasoning within the thought chain, and is only
>   supported by `GLM-5.2` and above.
>   * For GLM-5.3 and GLM-5.3-FLASH, **only `max`, `high` and `low` are supported. Any other input will
>     result in an error.**
>   * For GLM-5.2, the supported options are `max` (default), `xhigh`, `high`, `medium`, `low`,
>     `minimal`, and `none`. Among them, **`none` or `minimal` indicate that the model stops
>     thinking**; `low`/`medium` are mapped to `high`; `xhigh` is mapped to `max`.

Thinking Mode page:

> Thinking is activated by default in GLM-5.3 GLM-5.3-FLASH GLM-5.2 GLM-5.1 GLM-5 GLM-4.7 series,
> different from the default hybrid thinking in GLM-4.6.
> If you want to disable thinking, use the following (note that **`GLM-5.3` and `GLM-5.3-FLASH` use
> forced thinking and cannot be disabled**):
> ```
> "thinking": { "type": "disabled" }
> ```

**4. Omitted.** `thinking.type` defaults to `enabled`; thinking is on by default for the whole
5.x/4.7 line.

**5. Off value on a model that forbids it.** Documented to **error**: GLM-5.3 / GLM-5.3-Flash reject
`thinking.type: "disabled"`, and reject any `reasoning_effort` outside `max`/`high`/`low` (so
`"none"` errors there too). **Per-model gating is mandatory for this provider.**

```json
{ "model": "glm-5.2", "thinking": { "type": "disabled" } }
{ "model": "glm-5.3", "reasoning_effort": "low" }
```

---

## Moonshot / Kimi (`https://api.moonshot.ai/v1`) — CONFIRMED

**1. Reasoning models.** `kimi-k3`, `kimi-k2.7-code` (+ `-highspeed`), `kimi-k2.6`, `kimi-k2.5`.

**2. Parameters.** `reasoning_effort` (K3 only) and `thinking: {type, keep}` (K2.x only).

**3. Values.** The docs' own comparison table, verbatim:

> | Request field | `kimi-k3` | `kimi-k2.7-code` | `kimi-k2.6` | `kimi-k2.5` |
> | `reasoning_effort` | `"low"` / `"high"` / `"max"` (default `"max"`) | Not supported | Not supported | Not supported |
> | `thinking.type` | — | Only `"enabled"`; always thinks. **Passing `"disabled"` errors** | `"enabled"` (default) / `"disabled"` | `"enabled"` (default) / `"disabled"` |
> | `thinking.keep` | — | Omitting it or passing `"all"` is treated as `"all"`; any other invalid value errors | `null` (default) / `"all"` | No such parameter; not supported |

> `kimi-k3`: the flagship thinking model; **reasoning and Preserved Thinking are always on**.
> `kimi-k2.7-code`: code-focused; **thinking is always on**.
> `kimi-k2.6`: thinking is **on by default, can be disabled**.

> `kimi-k2.7-code` … its **thinking is always on and cannot be disabled** (passing
> `{"type": "disabled"}` errors).

**4. Omitted.** K3 → `reasoning_effort` defaults to `"max"` (worst case for latency; send `"low"`).
K2.6/K2.5 → `thinking.type` defaults to `"enabled"`. K2.7-code → always on.

**5. Off value on a model that forbids it.** Documented to **error** for `kimi-k2.7-code`. Also note
`temperature` is constrained: "`kimi-k2.6` / `kimi-k2.5`: fixed at `1.0` in thinking mode and `0.6` in
non-thinking mode; **other values return an error**."

```json
{ "model": "kimi-k2.6", "thinking": { "type": "disabled" }, "temperature": 0.6 }
{ "model": "kimi-k3", "reasoning_effort": "low" }
```

---

## Mistral (`https://api.mistral.ai/v1`) — CONFIRMED (values), UNVERIFIED (default)

**1. Reasoning models.** `mistral-small-latest` and `mistral-medium-3-5` have adjustable reasoning.
Magistral is gone:

> Looking for native reasoning models (`magistral-small-latest`, `magistral-medium-latest`)? **These
> have been deprecated.**

**2. Parameter.** `reasoning_effort`.

**3. Values.** Verbatim:

> `mistral-small-latest`: Supports adjustable reasoning via the `reasoning_effort` parameter. No extra
> configuration required — just add the parameter to any chat completion request.
> `mistral-medium-3-5`: Supports adjustable reasoning via the `reasoning_effort` parameter. For agentic
> and code use cases, `reasoning_effort="high"` is recommended.
>
> * `reasoning_effort = "high"`: The response includes a full thinking chunk before the final answer,
>   at the cost of increased token usage.
> * **`reasoning_effort = "none"`: The model thinks minimally and the thinking chunk is omitted from
>   the response.**

Only `"high"` and `"none"` are documented; intermediate values are not stated.

**4. Omitted.** **UNVERIFIED** — the page never states a default. Send `"none"` explicitly.

**5. Off value on other Mistral models.** UNVERIFIED.

```json
{ "model": "mistral-small-latest", "reasoning_effort": "none" }
```

---

## Cerebras (`https://api.cerebras.ai/v1`) — CONFIRMED

**1. Reasoning models.** `gpt-oss-120b` and `gemma-4-31b`.

**2. Parameters.** `reasoning_effort` (standard), `reasoning_format` (non-standard, needs `extra_body`
with the OpenAI SDK).

**3. Values.** OpenAPI schema enum is `low | medium | high | none`, but the description gates it per
model, verbatim:

> Controls the amount of reasoning the model performs. **Supported values vary by model:**
> - **gpt-oss-120b**: `low`, `medium` (default), `high`
> - **gemma-4-31b**: `none` (default), `low`, `medium`, `high` (all enable reasoning equivalently).
>   `raw` and `hidden` reasoning formats are not supported.

Guide page:

> ### GPT-OSS-120B: `reasoning_effort` … `"medium"` - Moderate reasoning (default)
> ### Gemma 4 31B: `reasoning_effort` — **Reasoning is disabled by default on `gemma-4-31b`** …
> `"none"` — Reasoning disabled (default)

Model card note:

> Use the `reasoning_effort` parameter to control reasoning for this model. **The default effort level
> is `medium`.**

**So `gpt-oss-120b` on Cerebras has no off value — floor is `"low"`.**

**4. Omitted.** gpt-oss-120b → `medium` (reasons). gemma-4-31b → `none` (does not reason).

**5. Off value on gpt-oss.** `"none"` is not in gpt-oss's supported set. UNVERIFIED whether it 400s or
is silently ignored — treat as unsafe and send `"low"`.

```json
{ "model": "gpt-oss-120b", "reasoning_effort": "low" }
```

---

## Together AI (`https://api.together.xyz/v1`) — CONFIRMED

**1. Reasoning models.** Verbatim serverless table: `MiniMaxAI/MiniMax-M3`,
`deepseek-ai/DeepSeek-V4-Pro`, `zai-org/GLM-5.2`, `moonshotai/Kimi-K3`, `Qwen/Qwen3.6-Plus`,
`Qwen/Qwen3.5-9B`, `nvidia/nemotron-3-ultra-550b-a55b` — all "Hybrid (**on by default**)" — plus
`openai/gpt-oss-120b` and `openai/gpt-oss-20b` — "Adjustable effort".

**2. Parameters.** `reasoning: {"enabled": bool}`, `chat_template_kwargs`, `reasoning_effort`.

**3. Values.**

> **Hybrid**: Supports both reasoning and non-reasoning modes via `reasoning={"enabled": True/False}`.
> **Adjustable effort**: Supports the `reasoning_effort` parameter to control reasoning depth
> (`"low"`, `"medium"`, or `"high"`).
> **Reasoning only**: Always produces reasoning tokens. Cannot be toggled off.

> Hybrid models let you toggle reasoning on or off using the `reasoning` parameter.
> Alternatively, you can enable or disable reasoning using `chat_template_kwargs`:
> `chat_template_kwargs={"thinking": True, # or use "enable_thinking": True}`
> **GLM-5.2 has thinking enabled by default. Pass `reasoning={"enabled": False}` to disable it** for
> simple tasks where reasoning overhead isn't needed.

> `DeepSeek-V4-Pro` accepts only `"high"` and `"max"` for `reasoning_effort`. Other values are mapped
> automatically: `"low"` and `"medium"` map to `"high"`; `"high"` and `"xhigh"` map to `"max"`.

**No off value for gpt-oss on Together** — floor is `"low"`.

**4. Omitted.** Every hybrid serverless model is "on by default". gpt-oss defaults are not stated
(UNVERIFIED); send `reasoning_effort: "low"`.

**5. Off value elsewhere.** UNVERIFIED.

```json
{ "model": "zai-org/GLM-5.2", "reasoning": { "enabled": false } }
{ "model": "openai/gpt-oss-120b", "reasoning_effort": "low" }
```

---

## Fireworks AI (`https://api.fireworks.ai/inference/v1`) — CONFIRMED (best-documented of the lot)

**1. Reasoning models.** Qwen3/3.5, MiniMax M2, DeepSeek V3.1/V3.2/V4, GLM 4.5/4.5-Air/4.6/4.7/5.1/5.2,
GPT-OSS 120B/20B, Kimi K2.x.

**2. Parameters.** `reasoning_effort` (string | integer | boolean) or `thinking` (Anthropic-shaped).

> You cannot specify both `thinking` and `reasoning_effort` in the same request. **If both are
> provided, a validation error will be raised.**

**3. Values.** Schema enum: `low | medium | high | xhigh | max | none | adaptive`, plus integer and
boolean. Verbatim:

> - **String** (OpenAI-compatible): `'low'`, `'medium'`, `'high'`, or `'max'` to enable reasoning with
>   varying effort levels; **`'none'` to disable reasoning.**
> - **Boolean** (Fireworks extension): `true` to enable reasoning, `false` to disable it.
> - **Important:** Boolean values are normalized internally: `true` becomes `'medium'`, and `false`
>   becomes `'none'`. This normalization happens before model-specific validation, so **if a model
>   doesn't support `'none'`, passing `false` will produce an error referencing `'none'`.**

Model-specific, verbatim:

> - **MiniMax M2**: Reasoning is required (always on). Defaults to `'medium'` when omitted. Accepts only
>   string `reasoning_effort`: `'low'`, `'medium'`, or `'high'`. **`'none'` and boolean values are rejected.**
> - **DeepSeek V3.1**: Binary on/off reasoning. **Default reasoning off** … Use `'none'` or `false` to disable.
> - **DeepSeek V3.2**: Binary on/off reasoning. **Default reasoning on.** Use `'none'` or `false` to disable.
> - **DeepSeek V4**: … **Default reasoning on (`'high'`)** … `'none'` or `false` disables thinking.
> - **GLM 4.5, GLM 4.5 Air, GLM 4.6, GLM 4.7, GLM 5.1**: Binary on/off reasoning. **Default reasoning on.**
>   Use `'none'` or `false` to disable.
> - **GLM 5.2**: … when omitted, the model default (`Max`) applies. `'none'` or `false` disables thinking.
> - **Harmony (OpenAI GPT-OSS 120B, GPT-OSS 20B)**: **Accepts only `'low'`, `'medium'`, or `'high'`. Does
>   not support `'none'`, `false`, or integer values — using these will return an error (e.g., "Invalid
>   reasoning effort: none").** When omitted, defaults to `'medium'`.

**4. Omitted.** Reasoning on by default for DeepSeek V3.2/V4, all GLM, MiniMax M2, gpt-oss (`medium`).
Off by default only for DeepSeek V3.1.

**5. Off value where unsupported.** **Documented to 400** for gpt-oss (`"Invalid reasoning effort:
none"`) and rejected for MiniMax M2. Per-model gating mandatory.

```json
{ "model": "accounts/fireworks/models/glm-4p7", "reasoning_effort": "none" }
{ "model": "accounts/fireworks/models/gpt-oss-120b", "reasoning_effort": "low" }
```

---

## NVIDIA NIM (`/v1/chat/completions`) — CONFIRMED

**1. Reasoning models.** Per-model; Qwen3.x, Nemotron reasoning variants, Gemma 4, Kimi, Step, etc.

**2. Parameters.** `chat_template_kwargs.enable_thinking` (boolean) — controls whether the model
reasons; `include_reasoning` (boolean) — controls only whether the trace is returned. Older
Nemotron models use a system-prompt switch instead.

**3. Values / off value.** Verbatim (Qwen3.6 NIM page):

> This model supports reasoning. **It is on by default. To turn it off, add
> `"chat_template_kwargs": { "enable_thinking": false }` in the request body.**
> You can also omit the reasoning tokens from the response by setting `"include_reasoning": false` in
> the request body. **The model will still reason internally.** Setting `"include_reasoning": false` is
> not supported for streaming responses.

Gemma 4 NIM page (opposite default):

> This model supports reasoning. **Reasoning is off by default. To turn it on, add
> `"chat_template_kwargs": { "enable_thinking": true }`** … To explicitly disable reasoning, set
> `"chat_template_kwargs": { "enable_thinking": false }`.

Legacy Nemotron reasoning models are controlled by system prompt only:

> Reasoning mode is controlled entirely by the system prompt … `detailed thinking on` … `detailed
> thinking off` Generates more concise responses without extended chain-of-thought or thinking tokens.

**4. Omitted.** Per-model — Qwen-family NIMs default ON, Gemma 4 defaults OFF.

**5. Off value on a non-reasoning NIM.** UNVERIFIED. `chat_template_kwargs` is passed through to the
Jinja template, so an unrecognised key is usually ignored rather than rejected — but that is inference,
not documentation.

```json
{ "model": "qwen/qwen3.6-35b-a3b", "chat_template_kwargs": { "enable_thinking": false } }
```

---

## Perplexity (`https://api.perplexity.ai`) — CONFIRMED (no off value exists)

**1. Reasoning models.** OpenAPI model enum: `sonar`, `sonar-pro`, `sonar-deep-research`,
`sonar-reasoning-pro`. (Plain `sonar-reasoning` is no longer in the enum.) Note the deprecation banner:

> Sonar Chat Completions is now Agent API. **Sonar will be supported until September 27, 2026.**

**2. Parameter.** `reasoning_effort`.

**3. Values.** OpenAPI schema, verbatim enum: `minimal`, `low`, `medium`, `high`. Description:
"Controls how much effort the model spends on reasoning". **There is no `none`/`off` value** — the
minimum is `"minimal"`.

**4. Omitted.** **UNVERIFIED** — the schema declares no default and the docs do not state one.

**5. Off value on a non-reasoning Sonar model.** UNVERIFIED — the parameter is on the shared request
schema, so it is likely accepted, but this is not stated.

```json
{ "model": "sonar-reasoning-pro", "reasoning_effort": "minimal" }
```

---

## Cohere (`https://api.cohere.ai/compatibility/v1`) — CONFIRMED

**1. Reasoning models.** `command-a-reasoning-08-2025` (hybrid).

> Cohere's reasoning models are *hybrid*, meaning reasoning can be enabled … or disabled (in which case
> they function the way any other LLM would).

**2. Parameter.** Native v2 Chat API: `thinking`. OpenAI-compatibility endpoint: `reasoning_effort`.

**3. Values.** Native, verbatim:

> For reasoning models, `thinking` is **enabled by default**. To disable it, send the following value to
> the `"thinking"` parameter:
> ```python
> thinking={ "type": "disabled" }  # turns off thinking. It is set to "enabled" by default.
> ```

OpenAI-compatibility endpoint, verbatim:

> `reasoning_effort` (**Only "none" and "high" are currently supported.**)
> Currently, only **`none`** and **`high`** are supported for `reasoning_effort`. These correspond to
> enabling or disabling `thinking` in the Cohere Chat API. **Passing `medium` or `low` is not supported
> at this time.**

**4. Omitted.** Thinking is enabled by default.

**5. Off value on a non-reasoning Cohere model.** UNVERIFIED.

```json
{ "model": "command-a-reasoning-08-2025", "reasoning_effort": "none" }
```

---

## HuggingFace router (`https://router.huggingface.co/v1`) — CONFIRMED (parameter), UNVERIFIED (defaults)

**1. Reasoning models.** Depends entirely on the upstream provider routed to.

**2. Parameter.** `reasoning_effort`.

**3. Values.** API specification, verbatim:

> `reasoning_effort` string — Optional. Constrains effort on reasoning for models that support
> reasoning. Reducing reasoning effort can result in faster responses and fewer tokens used on
> reasoning. **Common values: none, minimal, low, medium, high, xhigh. Support and defaults are
> provider and model-dependent.**

`chat_template_kwargs: {"enable_thinking": false}` also appears in HF model cards, but it is **not** in
the router's documented payload schema — treat it as UNVERIFIED at the router level.

**4. Omitted.** Explicitly **provider- and model-dependent** by the docs' own words. UNVERIFIED.

**5. Off value on a non-reasoning model.** UNVERIFIED — and because the router forwards to backends
that reject `none` (Groq gpt-oss, Fireworks Harmony), this is the highest-risk provider for a 400.

---

## SambaNova (`https://api.sambanova.ai/v1`) — CONFIRMED (schema), UNVERIFIED (defaults)

**1. Reasoning models.** DeepSeek-R1, DeepSeek-V3.1/V3.2 (hybrid), gpt-oss.

**2. Parameters.** `chat_template_kwargs.enable_thinking` (boolean) and `reasoning_effort`.

**3. Values.** OpenAPI schema, verbatim:

> `EnableThinking` — type: boolean — Enables the model's internal reasoning or "thinking" mode, **if
> supported by the chat template (deepseek models)**. example: true

> `reasoning_effort` — Value specifying the amount of reasoning the model is allowed to do … **allowed
> values are 'low', 'medium', 'high'** — enum: low, medium, high

So the off switch is `chat_template_kwargs.enable_thinking: false`; `reasoning_effort` has **no** off
value on SambaNova.

**4. Omitted.** UNVERIFIED for SambaCloud generally. One data point:

> Looking for DeepSeek-V3.2 thinking mode on SambaStack? **It is optional and disabled by default.**

**5. Off value on other models.** UNVERIFIED. `chat_template_kwargs` has `additionalProperties: true`,
so unknown keys are schema-valid, but template-level behaviour is not documented.

```json
{ "model": "DeepSeek-V3.1", "chat_template_kwargs": { "enable_thinking": false } }
```

---

## Hyperbolic (`https://api.hyperbolic.xyz/v1`) — UNVERIFIED

**1. Reasoning models.** From the model table: `Qwen/Qwen3-Next-80B-A3B-Thinking` (a thinking-only
checkpoint), `openai/gpt-oss-120b`, `openai/gpt-oss-20b`.

**2–5.** **UNVERIFIED.** Hyperbolic's inference docs show only `messages`, `max_tokens`,
`temperature`, `top_p`. No `reasoning_effort`, no `thinking`, no `chat_template_kwargs`, no statement
of defaults. Do not send any reasoning parameter to Hyperbolic without testing it live first.

---

## Ollama (`http://localhost:11434/v1`) — CONFIRMED

**1. Reasoning models.** Docs list: Qwen 3, GPT-OSS, DeepSeek-v3.1, DeepSeek R1 (and anything tagged
"thinking" in the library).

**2. Parameter.** On the **OpenAI-compatible** endpoint it is `reasoning_effort` (or
`reasoning.effort`) — **not** `think`. `think` is the native `/api/chat` field only.

**3. Values.** Supported request fields for `/v1/chat/completions`, verbatim:

> `reasoning_effort` (`"high"`, `"medium"`, `"low"`, `"max"`, `"none"`)
> `reasoning` → `effort` (`"high"`, `"medium"`, `"low"`, `"max"`, `"none"`)

Off value is `"none"`. Note the GPT-OSS carve-out on the native side:

> GPT-OSS (use think levels: `low`, `medium`, `high` — **the trace cannot be fully disabled**)
> **GPT-OSS requires `think` to be set to `"low"`, `"medium"`, or `"high"`. Passing `true`/`false` is
> ignored for that model.**

Treat `reasoning_effort: "none"` as unsafe for gpt-oss on Ollama and send `"low"`.

**4. Omitted.** Verbatim:

> **Thinking is enabled by default in the CLI and API for supported models.**

**5. Off value on a non-thinking local model.** UNVERIFIED.

```json
{ "model": "qwen3", "reasoning_effort": "none" }
{ "model": "gpt-oss:20b", "reasoning_effort": "low" }
```

---

## LM Studio (`http://localhost:1234/v1`) — UNVERIFIED on `/chat/completions`

**1. Reasoning models.** Any local reasoning GGUF/MLX the user loads (gpt-oss, Qwen3, etc.).

**2–3. Parameter.** The documented "Supported payload parameters" for `POST /v1/chat/completions` are,
verbatim and in full:

> `model`, `top_p`, `top_k`, `messages`, `temperature`, `max_tokens`, `stream`, `stop`,
> `presence_penalty`, `frequency_penalty`, `logit_bias`, `repeat_penalty`, `seed`

**`reasoning_effort` is not in that list.** There is therefore **no documented way to disable thinking
on LM Studio's `/v1/chat/completions`.** UNVERIFIED whether an undocumented `reasoning_effort` is
silently ignored or rejected.

What *is* documented:

- `POST /v1/responses` accepts `"reasoning": { "effort": "low" }` (example uses `openai/gpt-oss-20b`).
- `model.yaml` can expose an `enableThinking` custom field that sets the Jinja variable
  `enable_thinking`:
  > `customFields: - key: enableThinking / displayName: Enable Thinking … - type: setJinjaVariable /
  > variable: enable_thinking`
  > In order for the above example to work, **the jinja template needs to have a variable named
  > `enable_thinking`.**
  This is a model-config / UI setting, not a per-request API field.

**4. Omitted.** UNVERIFIED — depends on the loaded model's chat template.

**5.** UNVERIFIED.

The practical fallback for LM Studio (and any local template-driven server) is the `/no_think` prompt
suffix on Qwen3-family models — documented by Alibaba, not by LM Studio, so treat it as a heuristic.

---

## Summary table

| Provider | Reasoning models | Param | Off value | Default when omitted | Confidence |
| --- | --- | --- | --- | --- | --- |
| **Groq** (qwen) | `qwen/qwen3.6-27b`, `qwen/qwen3.8-27b` | `reasoning_effort` | `"none"` | `"default"` = reasoning ON | CONFIRMED |
| **Groq** (gpt-oss) | `openai/gpt-oss-20b`, `-120b`, `-safeguard-20b` | `reasoning_effort` | **none exists** — floor `"low"`; `include_reasoning:false` only hides trace | reasoning ON | CONFIRMED |
| **Groq** (minimax) | `minimaxai/minimax-m2.7` | `reasoning_format` | `"hidden"` (hides only) | `raw` | CONFIRMED |
| **xAI** | `grok-4.6`, `grok-4.5`, `grok-4.20-multi-agent` | `reasoning_effort` | **none exists** — "Reasoning cannot be disabled"; floor `"low"` | `"high"` | CONFIRMED |
| **Alibaba DashScope** | qwen3.x, GLM, Kimi, DeepSeek hybrids | `enable_thinking` (in `extra_body`) | `false` | ON for qwen3.5/3.6/3.7 + GLM; OFF for qwen-plus/max/turbo, deepseek-v3.x, kimi-k2.5/2.6 | CONFIRMED |
| **DashScope** thinking-only | qwq-plus, `*-thinking-*`, deepseek-r1, MiniMax | — | **none exists** | ON | CONFIRMED |
| **Z.ai GLM ≤5.2** | GLM-4.5/4.6/4.7/5/5.1/5.2 | `thinking.type` (+ `reasoning_effort` on 5.2+) | `{"type":"disabled"}`; or `reasoning_effort:"none"`/`"minimal"` on 5.2 | `"enabled"` = ON | CONFIRMED |
| **Z.ai GLM-5.3 / 5.3-Flash** | GLM-5.3, GLM-5.3-Flash | `reasoning_effort` | **none exists — `disabled` errors**; floor `"low"` | forced thinking, `max` | CONFIRMED |
| **Moonshot** K2.6 / K2.5 | `kimi-k2.6`, `kimi-k2.5` | `thinking.type` | `{"type":"disabled"}` | `"enabled"` = ON | CONFIRMED |
| **Moonshot** K3 | `kimi-k3` | `reasoning_effort` | **none exists** — floor `"low"` | `"max"` | CONFIRMED |
| **Moonshot** K2.7-code | `kimi-k2.7-code(-highspeed)` | — | **none — `"disabled"` errors** | always ON | CONFIRMED |
| **Mistral** | `mistral-small-latest`, `mistral-medium-3-5` (magistral deprecated) | `reasoning_effort` | `"none"` | **not stated** | CONFIRMED (values) / UNVERIFIED (default) |
| **Cerebras** gpt-oss | `gpt-oss-120b` | `reasoning_effort` | **none exists** — floor `"low"` | `"medium"` = ON | CONFIRMED |
| **Cerebras** gemma | `gemma-4-31b` | `reasoning_effort` | `"none"` | `"none"` = OFF | CONFIRMED |
| **Together** hybrid | MiniMax-M3, DeepSeek-V4-Pro, GLM-5.2, Kimi-K3, Qwen3.6-Plus, Qwen3.5-9B, Nemotron-3-Ultra | `reasoning:{"enabled":false}` (or `chat_template_kwargs.enable_thinking`) | `{"enabled": false}` | ON by default | CONFIRMED |
| **Together** gpt-oss | `openai/gpt-oss-120b`, `-20b` | `reasoning_effort` | **none exists** — floor `"low"` | not stated | CONFIRMED (values) / UNVERIFIED (default) |
| **Fireworks** general | GLM 4.5–5.2, DeepSeek V3.1/V3.2/V4, Qwen3 | `reasoning_effort` | `"none"` (or `false`) | ON (except DeepSeek V3.1 = OFF) | CONFIRMED |
| **Fireworks** gpt-oss / MiniMax M2 | Harmony gpt-oss 120b/20b, MiniMax M2 | `reasoning_effort` | **none — `"none"` returns 400** ("Invalid reasoning effort: none"); floor `"low"` | `"medium"` = ON | CONFIRMED |
| **NVIDIA NIM** | per-model (Qwen3.x ON, Gemma 4 OFF) | `chat_template_kwargs.enable_thinking` | `false` | model-dependent (Qwen ON, Gemma 4 OFF) | CONFIRMED |
| **NIM** legacy Nemotron | Llama-Nemotron reasoning | system prompt | `detailed thinking off` | n/a | CONFIRMED |
| **Perplexity** | `sonar-reasoning-pro`, `sonar-deep-research` | `reasoning_effort` | **none exists** — floor `"minimal"` | **not stated** | CONFIRMED (values) / UNVERIFIED (default) |
| **Cohere** | `command-a-reasoning-08-2025` | `reasoning_effort` (compat API) / `thinking` (native) | `"none"` / `{"type":"disabled"}` | thinking ON | CONFIRMED |
| **HuggingFace router** | provider-dependent | `reasoning_effort` | `"none"` listed as a *common* value | "provider and model-dependent" | UNVERIFIED |
| **SambaNova** | DeepSeek R1/V3.1/V3.2, gpt-oss | `chat_template_kwargs.enable_thinking` (`reasoning_effort` = low/medium/high only) | `false` | not stated (V3.2 on SambaStack = OFF) | CONFIRMED (schema) / UNVERIFIED (default) |
| **Hyperbolic** | Qwen3-Next-80B-Thinking, gpt-oss 120b/20b | **none documented** | **unknown** | unknown | UNVERIFIED |
| **Ollama** (OpenAI endpoint) | Qwen3, DeepSeek R1/v3.1, gpt-oss | `reasoning_effort` | `"none"` (gpt-oss: floor `"low"`) | **thinking ENABLED by default** | CONFIRMED |
| **LM Studio** `/v1/chat/completions` | any loaded reasoning model | **not in documented param list** | **unknown** | unknown | UNVERIFIED |
| **LM Studio** `/v1/responses` | same | `reasoning.effort` | not stated (`"low"` documented) | unknown | CONFIRMED (param) / UNVERIFIED (off value) |

### Adapter rules that follow from the above

1. **Never send a bare `reasoning_effort: "none"` on a model family you have not gated.** It is a
   documented 400 on Fireworks Harmony/MiniMax and on Z.ai GLM-5.3, and outside the documented set on
   Groq gpt-oss, Cerebras gpt-oss, Together gpt-oss, Perplexity, SambaNova and Cohere-with-`low`.
2. **gpt-oss anywhere = `"low"`, never `"none"`.** Every host that serves it (Groq, Cerebras, Together,
   Fireworks, Ollama) documents the same three-value set.
3. **Omitting the parameter means reasoning ON** for: xAI (all), Groq qwen/gpt-oss, Z.ai 4.7+/5.x,
   Moonshot K3/K2.6/K2.7, Fireworks (all but DeepSeek V3.1), Together hybrids, Cohere, Ollama,
   NIM Qwen-family, DashScope qwen3.5+/GLM. This is the hang.
4. **Hiding the trace is not disabling it.** Groq `include_reasoning:false`, Groq
   `reasoning_format:"hidden"` and NIM `include_reasoning:false` all keep the latency and token cost.
5. **UNVERIFIED providers — do not ship a reasoning parameter without a live probe:** Hyperbolic,
   LM Studio `/v1/chat/completions`, HuggingFace router.
