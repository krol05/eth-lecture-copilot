/**
 * lib/providers/catalog.js
 * Single source of truth for every supported AI provider.
 * Replaces lib/providers-config.js and the PROVIDER_MAP / DEFAULT_MODELS
 * tables in background.js (M2). Consumed by background (importScripts),
 * popup, sidebar and Node tests.
 *
 * Ground truth: docs/providers/*.md (official docs, retrieved 2026-08-23).
 *
 * Entry shape:
 *   id           unique key, also the chrome.storage key suffix
 *   label        UI display name
 *   adapter      'anthropic' | 'google' | 'oai' — which request adapter to use
 *   kind         'first' (first-class) | 'preset' (one-line OAI-compat) | 'local'
 *   base         base URL (locals: default, user-editable)
 *   keyLink      where to create an API key (omitted for locals)
 *   keyHint      key format placeholder (omitted for locals)
 *   note         optional UI hint
 *   models       [{id, label}] — static fallback list; live /models wins (M4)
 *   defaultModel used when the user never picked one
 *   customModel  true → free-text model input offered. Set on EVERY provider:
 *                the static lists are conveniences, never gates — any model ID
 *                the API still serves can be typed in directly. Live /models
 *                results (M4) and user overrides (M3) extend the lists further.
 *   customBase   true → base URL editable in the basic UI
 *   noAuth       true → no API key required (locals)
 *   quirks       documented per-provider deviations the adapter must honor
 *
 * Deliberately absent: any max-output-token table. Providers enforce their
 * own limits; adapters send a cap only where the API requires one.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined') module.exports = api;
  if (root) Object.assign(root, api);
})(typeof self !== 'undefined' ? self : this, function () {

  // ── First-class providers (dedicated adapter attention, docs/providers/<id>.md) ──
  const FIRST_CLASS = [
    {
      id: 'anthropic',
      label: 'Anthropic',
      adapter: 'anthropic',
      kind: 'first',
      base: 'https://api.anthropic.com',
      keyLink: 'https://console.anthropic.com/settings/keys',
      keyHint: 'sk-ant-...',
      defaultModel: 'claude-sonnet-5',
      models: [
        { id: 'claude-opus-5',     label: 'Claude Opus 5 (flagship, 1M ctx)' },
        { id: 'claude-sonnet-5',   label: 'Claude Sonnet 5 (balanced, 1M ctx)' },
        { id: 'claude-fable-5',    label: 'Claude Fable 5 (1M ctx)' },
        { id: 'claude-haiku-4-5',  label: 'Claude Haiku 4.5 (fast, cheap)' },
        { id: 'claude-opus-4-8',   label: 'Claude Opus 4.8 (legacy)' },
        { id: 'claude-opus-4-7',   label: 'Claude Opus 4.7 (legacy)' },
        { id: 'claude-opus-4-6',   label: 'Claude Opus 4.6 (legacy)' },
        { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (legacy)' },
        { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5 (legacy)' },
        { id: 'claude-opus-4-5',   label: 'Claude Opus 4.5 (legacy)' }
      ],
      // temperature/top_p/top_k deprecated on Opus 4.7+ — sending non-default
      // values returns HTTP 400 (docs/providers/anthropic.md §10)
      quirks: { noSamplingParams: true }
    },
    {
      id: 'openai',
      label: 'OpenAI',
      adapter: 'oai',
      kind: 'first',
      base: 'https://api.openai.com/v1',
      keyLink: 'https://platform.openai.com/api-keys',
      keyHint: 'sk-...',
      note: 'gpt-5.6 tiers: sol (frontier) / terra (balanced) / luna (cheap). Older gpt-5.x still served but no longer promoted.',
      defaultModel: 'gpt-5.6-terra',
      models: [
        { id: 'gpt-5.6-sol',   label: 'GPT-5.6 Sol (frontier)' },
        { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra (balanced)' },
        { id: 'gpt-5.6-luna',  label: 'GPT-5.6 Luna (cost-optimized)' },
        { id: 'gpt-5.5',       label: 'GPT-5.5' },
        { id: 'gpt-5.5-pro',   label: 'GPT-5.5 Pro' },
        { id: 'gpt-5.4',       label: 'GPT-5.4' },
        { id: 'gpt-5.4-mini',  label: 'GPT-5.4 mini' },
        { id: 'gpt-5.4-nano',  label: 'GPT-5.4 nano' },
        { id: 'gpt-5.2',       label: 'GPT-5.2' },
        { id: 'gpt-5.1',       label: 'GPT-5.1' },
        { id: 'gpt-5',         label: 'GPT-5' },
        { id: 'gpt-5-mini',    label: 'GPT-5 mini' },
        { id: 'gpt-5-nano',    label: 'GPT-5 nano' },
        { id: 'gpt-4.1',       label: 'GPT-4.1 (legacy)' },
        { id: 'gpt-4o',        label: 'GPT-4o (legacy)' },
        { id: 'gpt-4o-mini',   label: 'GPT-4o mini (legacy)' },
        { id: 'o3',            label: 'o3 (reasoning, legacy)' },
        { id: 'o4-mini',       label: 'o4 mini (reasoning, legacy)' }
      ],
      // gpt-5.6/o-series are reasoning models: max_completion_tokens instead of
      // max_tokens, sampling params rejected (docs/providers/openai.md §2–3)
      quirks: { reasoningModelPrefixes: ['gpt-5', 'o1', 'o3', 'o4'] }
    },
    {
      id: 'google',
      label: 'Google Gemini',
      adapter: 'google',
      kind: 'first',
      base: 'https://generativelanguage.googleapis.com',
      keyLink: 'https://aistudio.google.com/app/apikey',
      keyHint: 'AIza...',
      defaultModel: 'gemini-3.7-flash',
      models: [
        { id: 'gemini-3.7-flash',      label: 'Gemini 3.7 Flash (GA, newest)' },
        { id: 'gemini-3.6-flash',      label: 'Gemini 3.6 Flash (GA)' },
        { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro (preview, flagship reasoning)' },
        { id: 'gemini-3.5-flash',      label: 'Gemini 3.5 Flash' },
        { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite (cheapest)' },
        { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite' },
        { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash (preview)' },
        { id: 'gemini-2.5-pro',        label: 'Gemini 2.5 Pro (stable)' },
        { id: 'gemini-2.5-flash',      label: 'Gemini 2.5 Flash (stable)' },
        { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite (stable)' }
      ]
    },
    {
      id: 'deepseek',
      label: 'DeepSeek',
      adapter: 'oai',
      kind: 'first',
      // current docs use the bare host; /v1 is not part of the documented base
      base: 'https://api.deepseek.com',
      keyLink: 'https://platform.deepseek.com/api_keys',
      keyHint: 'sk-...',
      note: 'deepseek-chat / deepseek-reasoner retired Jul 2026. Reasoning is now a toggle on the V4 models.',
      defaultModel: 'deepseek-v4-flash',
      models: [
        { id: 'deepseek-v4-flash',            label: 'DeepSeek V4 Flash (1M ctx)' },
        { id: 'deepseek-v4-pro',              label: 'DeepSeek V4 Pro (1M ctx)' },
        { id: 'deepseek-v4-flash-vision-exp', label: 'DeepSeek V4 Flash Vision (experimental)' }
      ],
      // thinking via {thinking:{type:'enabled'}} + reasoning_effort; with tools,
      // reasoning_content must be echoed back (docs/providers/deepseek.md)
      quirks: { deepseekThinking: true }
    },
    {
      id: 'openrouter',
      label: 'OpenRouter',
      adapter: 'oai',
      kind: 'first',
      base: 'https://openrouter.ai/api/v1',
      keyLink: 'https://openrouter.ai/keys',
      keyHint: 'sk-or-...',
      note: 'Routes to 400+ models — pick from the list or paste any model ID below',
      customModel: true,
      defaultModel: 'anthropic/claude-sonnet-5',
      models: [
        { id: 'anthropic/claude-sonnet-5',   label: 'Claude Sonnet 5' },
        { id: 'anthropic/claude-opus-5',     label: 'Claude Opus 5' },
        { id: 'openai/gpt-5.6-terra',        label: 'GPT-5.6 Terra' },
        { id: 'openai/gpt-5.5',              label: 'GPT-5.5' },
        { id: 'google/gemini-3.5-flash',     label: 'Gemini 3.5 Flash' },
        { id: 'deepseek/deepseek-v4-flash',  label: 'DeepSeek V4 Flash (cheap)' },
        { id: 'meta-llama/llama-4-maverick', label: 'Llama 4 Maverick' }
      ],
      // can return HTTP 200 with an error in choices[].error / finish_reason
      // "error" (docs/providers/openrouter.md §8)
      quirks: { errorsInsideOk: true }
    }
  ];

  // ── One-line presets on the generic OAI adapter ─────────────────────────────
  // Model lists are hints, refreshed live via /models where available (M4);
  // rosters not re-verified against official docs are carried over unchanged.
  const PRESETS = [
    {
      id: 'groq', label: 'Groq', base: 'https://api.groq.com/openai/v1',
      keyLink: 'https://console.groq.com/keys', keyHint: 'gsk_...',
      note: 'Ultra-fast inference.',
      defaultModel: 'openai/gpt-oss-120b',
      models: [
        { id: 'openai/gpt-oss-120b',     label: 'GPT-OSS 120B (~500 t/s)' },
        { id: 'openai/gpt-oss-20b',      label: 'GPT-OSS 20B (fastest reasoning)' },
        { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B' },
        { id: 'llama-3.1-8b-instant',    label: 'Llama 3.1 8B (fastest small)' }
      ],
      // stream:true + response_format json_schema rejected outright
      quirks: { noJsonSchemaStream: true }
    },
    {
      id: 'xai', label: 'xAI (Grok)', base: 'https://api.x.ai/v1',
      keyLink: 'https://console.x.ai/', keyHint: 'xai-...',
      note: 'Model line moves fast — paste the current ID from docs.x.ai if the list is stale.',
      customModel: true,
      defaultModel: 'grok-4.3',
      models: [
        { id: 'grok-4.3',            label: 'Grok 4.3' },
        { id: 'grok-4.20-reasoning', label: 'Grok 4.20 Reasoning' }
      ]
    },
    {
      id: 'mistral', label: 'Mistral', base: 'https://api.mistral.ai/v1',
      keyLink: 'https://console.mistral.ai/api-keys/', keyHint: '...',
      defaultModel: 'mistral-large-latest',
      models: [
        { id: 'mistral-large-latest',    label: 'Mistral Large (latest alias)' },
        { id: 'mistral-medium-3-5',      label: 'Mistral Medium 3.5 (reasoning)' },
        { id: 'mistral-small-latest',    label: 'Mistral Small (latest alias)' },
        { id: 'magistral-medium-latest', label: 'Magistral Medium (reasoning)' },
        { id: 'codestral-latest',        label: 'Codestral (code)' }
      ]
    },
    {
      id: 'together', label: 'Together AI', base: 'https://api.together.ai/v1',
      keyLink: 'https://api.together.ai/settings/api-keys', keyHint: '...',
      defaultModel: 'deepseek-ai/DeepSeek-V4-Pro',
      models: [
        { id: 'deepseek-ai/DeepSeek-V4-Pro',                       label: 'DeepSeek V4 Pro' },
        { id: 'Qwen/Qwen3.5-397B-A17B',                            label: 'Qwen3.5 397B A17B' },
        { id: 'moonshotai/Kimi-K2.6',                              label: 'Kimi K2.6' },
        { id: 'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8', label: 'Llama 4 Maverick' },
        { id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',           label: 'Llama 3.3 70B Turbo' }
      ]
    },
    {
      id: 'cerebras', label: 'Cerebras', base: 'https://api.cerebras.ai/v1',
      keyLink: 'https://cloud.cerebras.ai', keyHint: 'csk-...',
      note: 'Free tier — GPT-OSS-120B at ~3000 t/s.',
      defaultModel: 'gpt-oss-120b',
      models: [
        { id: 'gpt-oss-120b', label: 'GPT-OSS 120B (~3000 t/s)' },
        { id: 'zai-glm-4.7',  label: 'GLM-4.7 (coding)' }
      ],
      // gpt-oss-120b rejects tools combined with response_format
      quirks: { noToolsWithResponseFormat: true }
    },
    {
      id: 'perplexity', label: 'Perplexity', base: 'https://api.perplexity.ai',
      keyLink: 'https://www.perplexity.ai/settings/api', keyHint: 'pplx-...',
      note: 'Sonar models have live web search built-in.',
      defaultModel: 'sonar-pro',
      models: [
        { id: 'sonar-pro',           label: 'Sonar Pro (web search)' },
        { id: 'sonar',               label: 'Sonar (web search)' },
        { id: 'sonar-reasoning-pro', label: 'Sonar Reasoning Pro' }
      ],
      // no /models endpoint exists — never offer live model fetch
      quirks: { noModelsEndpoint: true }
    },
    {
      id: 'nvidia_nim', label: 'NVIDIA NIM', base: 'https://integrate.api.nvidia.com/v1',
      keyLink: 'https://build.nvidia.com/explore/discover', keyHint: 'nvapi-...',
      note: 'Free tier with NVIDIA developer account.',
      defaultModel: 'deepseek-ai/deepseek-v4-pro',
      models: [
        { id: 'deepseek-ai/deepseek-v4-pro',             label: 'DeepSeek V4 Pro' },
        { id: 'meta/llama-4-maverick-17b-128e-instruct', label: 'Llama 4 Maverick' },
        { id: 'nvidia/nemotron-3-super-120b-a12b',       label: 'Nemotron 3 Super 120B' },
        { id: 'openai/gpt-oss-120b',                     label: 'GPT-OSS 120B' }
      ]
    },
    {
      id: 'fireworks', label: 'Fireworks AI', base: 'https://api.fireworks.ai/inference/v1',
      keyLink: 'https://fireworks.ai/api-keys', keyHint: 'fw_...',
      defaultModel: 'accounts/fireworks/models/kimi-k2p6',
      models: [
        { id: 'accounts/fireworks/models/kimi-k2p6',        label: 'Kimi K2.6' },
        { id: 'accounts/fireworks/models/deepseek-v4-pro',  label: 'DeepSeek V4 Pro' },
        { id: 'accounts/fireworks/models/gpt-oss-120b',     label: 'GPT-OSS 120B' },
        { id: 'accounts/fireworks/models/qwen3-235b-a22b',  label: 'Qwen3 235B A22B' }
      ]
    },
    {
      id: 'cohere', label: 'Cohere', base: 'https://api.cohere.ai/compatibility/v1',
      keyLink: 'https://dashboard.cohere.com/api-keys', keyHint: '...',
      defaultModel: 'command-a-03-2025',
      models: [
        { id: 'command-a-03-2025',           label: 'Command A (256K ctx)' },
        { id: 'command-a-reasoning-08-2025', label: 'Command A Reasoning' },
        { id: 'command-r-08-2024',           label: 'Command R' }
      ]
    },
    {
      id: 'huggingface', label: 'HuggingFace', base: 'https://router.huggingface.co/v1',
      keyLink: 'https://huggingface.co/settings/tokens', keyHint: 'hf_...',
      note: 'Routes to 15+ inference providers.',
      defaultModel: 'deepseek-ai/DeepSeek-V4-Pro',
      models: [
        { id: 'deepseek-ai/DeepSeek-V4-Pro',                   label: 'DeepSeek V4 Pro' },
        { id: 'Qwen/Qwen3.5-397B-A17B',                        label: 'Qwen3.5 397B A17B' },
        { id: 'meta-llama/Llama-4-Maverick-17B-128E-Instruct', label: 'Llama 4 Maverick' },
        { id: 'openai/gpt-oss-120b',                           label: 'GPT-OSS 120B' }
      ]
    },
    {
      id: 'hyperbolic', label: 'Hyperbolic', base: 'https://api.hyperbolic.xyz/v1',
      keyLink: 'https://app.hyperbolic.xyz/settings', keyHint: '...',
      defaultModel: 'deepseek-ai/DeepSeek-R1-0528',
      models: [
        { id: 'deepseek-ai/DeepSeek-R1-0528',      label: 'DeepSeek R1 (reasoning)' },
        { id: 'Qwen/Qwen3-235B-A22B',              label: 'Qwen3 235B A22B' },
        { id: 'meta-llama/Llama-3.3-70B-Instruct', label: 'Llama 3.3 70B' }
      ]
    },
    {
      id: 'sambanova', label: 'SambaNova', base: 'https://api.sambanova.ai/v1',
      keyLink: 'https://cloud.sambanova.ai/apis', keyHint: '...',
      defaultModel: 'Llama-4-Maverick-17B-128E-Instruct',
      models: [
        { id: 'Llama-4-Maverick-17B-128E-Instruct', label: 'Llama 4 Maverick' },
        { id: 'DeepSeek-V3.2',                      label: 'DeepSeek V3.2' },
        { id: 'gpt-oss-120b',                       label: 'GPT-OSS 120B' }
      ]
    },
    {
      id: 'moonshot', label: 'Moonshot (Kimi)', base: 'https://api.moonshot.ai/v1',
      keyLink: 'https://platform.kimi.ai/', keyHint: 'sk-...',
      defaultModel: 'kimi-k2.6',
      models: [
        { id: 'kimi-k2.6', label: 'Kimi K2.6 (262K ctx)' },
        { id: 'kimi-k2.5', label: 'Kimi K2.5 (vision, thinking)' }
      ]
    },
    {
      id: 'zhipu', label: 'Zhipu AI (Z.ai)', base: 'https://api.z.ai/api/paas/v4',
      keyLink: 'https://www.z.ai/', keyHint: '...',
      defaultModel: 'glm-5.1',
      models: [
        { id: 'glm-5.1',       label: 'GLM-5.1 (200K ctx)' },
        { id: 'glm-4.7-flash', label: 'GLM-4.7-Flash (free)' },
        { id: 'glm-5v-turbo',  label: 'GLM-5V-Turbo (vision)' }
      ]
    },
    {
      id: 'qwen', label: 'Qwen (Alibaba)', base: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
      keyLink: 'https://bailian.console.alibabacloud.com/', keyHint: 'sk-...',
      note: 'International endpoint; use dashscope-us.aliyuncs.com for US region.',
      defaultModel: 'qwen3.5-flash',
      models: [
        { id: 'qwen3.5-plus',  label: 'Qwen3.5-Plus (1M ctx)' },
        { id: 'qwen3.5-flash', label: 'Qwen3.5-Flash (1M ctx, fast)' },
        { id: 'qwen3-max',     label: 'Qwen3-Max (stable alias)' }
      ]
    }
  ].map(p => Object.assign({ adapter: 'oai', kind: 'preset' }, p));

  // ── Local runtimes: OAI-compat /v1, no auth, models discovered at runtime ──
  const LOCALS = [
    { id: 'local_ollama',      label: 'Ollama',         base: 'http://localhost:11434/v1',
      note: 'Run: ollama serve. Chrome extensions need OLLAMA_ORIGINS=chrome-extension://* set before starting.' },
    { id: 'local_lmstudio',    label: 'LM Studio',      base: 'http://localhost:1234/v1',
      note: 'Enable the local server in LM Studio → Developer tab' },
    { id: 'local_vllm',        label: 'vLLM',           base: 'http://localhost:8000/v1',
      note: 'python -m vllm.entrypoints.openai.api_server --model MODEL' },
    { id: 'local_jan',         label: 'Jan',            base: 'http://localhost:1337/v1',
      note: 'Enable the API server in Jan settings' },
    { id: 'local_textgenwebui', label: 'Text Gen WebUI', base: 'http://localhost:5000/v1',
      note: 'oobabooga — start with --api flag' },
    { id: 'local_koboldcpp',   label: 'KoboldCpp',      base: 'http://localhost:5001/v1',
      note: 'Single-binary GGUF runner' },
    { id: 'local_gpt4all',     label: 'GPT4All',        base: 'http://localhost:4891/v1',
      note: 'Enable Local Server in GPT4All settings' },
    { id: 'local_litellm',     label: 'LiteLLM Proxy',  base: 'http://localhost:4000/v1',
      note: 'Universal proxy — litellm --model MODEL' },
    { id: 'local_localai',     label: 'LocalAI',        base: 'http://localhost:8080/v1',
      note: 'docker run -p 8080:8080 localai/localai' },
    { id: 'local_tgi',         label: 'HF TGI',         base: 'http://localhost:8080/v1',
      note: 'HuggingFace Text Generation Inference' },
    { id: 'local_llamafile',   label: 'llamafile',      base: 'http://localhost:8080/v1',
      note: 'Run your .llamafile — server starts automatically' },
    { id: 'local_custom',      label: 'Custom (local)', base: 'http://localhost:11434/v1',
      note: 'Any OpenAI-compatible local server', customBase: true }
  ].map(p => Object.assign({ adapter: 'oai', kind: 'local', noAuth: true, models: [] }, p));

  // Universal invariant: the model field is never a closed list (see header).
  const PROVIDER_LIST = [...FIRST_CLASS, ...PRESETS, ...LOCALS]
    .map(p => Object.assign(p, { customModel: true }));
  const PROVIDER_INDEX = Object.fromEntries(PROVIDER_LIST.map(p => [p.id, p]));

  /** All providers in display order (first-class, presets, locals). */
  function listProviders() {
    return PROVIDER_LIST;
  }

  /** Lookup by id; returns undefined for unknown ids. */
  function getProvider(id) {
    return PROVIDER_INDEX[id];
  }

  /** Static default model for a provider ('' when discovery-only, e.g. locals). */
  function getDefaultModel(id) {
    const p = PROVIDER_INDEX[id];
    if (!p) return '';
    return p.defaultModel || (p.models[0] && p.models[0].id) || '';
  }

  return {
    Catalog: {
      list: listProviders,
      get: getProvider,
      defaultModel: getDefaultModel
    }
  };
});
