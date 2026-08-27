/**
 * lib/providers/catalog.js
 * Single source of truth for every supported AI provider — the STRUCTURE half
 * of the catalog. The model lists live in catalog-data.js (regenerated weekly
 * by scripts/update-catalog.mjs → PR), which must load before this file
 * (script tag / importScripts order; require() in tests).
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
 *   models       [{id, label}] — static fallback list from catalog-data.js;
 *                live /models results (M4), user overrides (M3), and the
 *                always-present free-text model field extend it at runtime
 *   defaultModel used when the user never picked one
 *   customModel  true → free-text model input offered. Set on EVERY provider:
 *                the static lists are conveniences, never gates.
 *   customBase   true → base URL editable in the basic UI
 *   noAuth       true → no API key required (locals)
 *   quirks       documented per-provider deviations the adapter must honor
 *
 * Deliberately absent: any max-output-token table. Providers enforce their
 * own limits; adapters send a cap only where the API requires one.
 */
(function (root, factory) {
  const api = factory(
    (typeof module !== 'undefined' && typeof require === 'function')
      ? require('./catalog-data.js').CATALOG_MODELS
      : (root && root.CATALOG_MODELS)
  );
  if (typeof module !== 'undefined') module.exports = api;
  if (root) Object.assign(root, api);
})(typeof self !== 'undefined' ? self : this, function (CATALOG_MODELS) {

  const M = id => (CATALOG_MODELS && CATALOG_MODELS[id]) || [];

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
      models: M('anthropic'),
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
      models: M('openai'),
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
      models: M('google')
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
      models: M('deepseek'),
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
      defaultModel: 'anthropic/claude-sonnet-5',
      models: M('openrouter'),
      // can return HTTP 200 with an error in choices[].error / finish_reason
      // "error" (docs/providers/openrouter.md §8)
      quirks: { errorsInsideOk: true }
    }
  ];

  // ── One-line presets on the generic OAI adapter ─────────────────────────────
  const PRESETS = [
    {
      id: 'groq', label: 'Groq', base: 'https://api.groq.com/openai/v1',
      keyLink: 'https://console.groq.com/keys', keyHint: 'gsk_...',
      note: 'Ultra-fast inference.',
      defaultModel: 'openai/gpt-oss-120b',
      // stream:true + response_format json_schema rejected outright
      quirks: { noJsonSchemaStream: true }
    },
    {
      id: 'xai', label: 'xAI (Grok)', base: 'https://api.x.ai/v1',
      keyLink: 'https://console.x.ai/', keyHint: 'xai-...',
      note: 'Model line moves fast — paste the current ID from docs.x.ai if the list is stale.',
      defaultModel: 'grok-4.3'
    },
    {
      id: 'mistral', label: 'Mistral', base: 'https://api.mistral.ai/v1',
      keyLink: 'https://console.mistral.ai/api-keys/', keyHint: '...',
      defaultModel: 'mistral-large-latest'
    },
    {
      id: 'together', label: 'Together AI', base: 'https://api.together.ai/v1',
      keyLink: 'https://api.together.ai/settings/api-keys', keyHint: '...',
      defaultModel: 'deepseek-ai/DeepSeek-V4-Pro'
    },
    {
      id: 'cerebras', label: 'Cerebras', base: 'https://api.cerebras.ai/v1',
      keyLink: 'https://cloud.cerebras.ai', keyHint: 'csk-...',
      note: 'Free tier — GPT-OSS-120B at ~3000 t/s.',
      defaultModel: 'gpt-oss-120b',
      // gpt-oss-120b rejects tools combined with response_format
      quirks: { noToolsWithResponseFormat: true }
    },
    {
      id: 'perplexity', label: 'Perplexity', base: 'https://api.perplexity.ai',
      keyLink: 'https://www.perplexity.ai/settings/api', keyHint: 'pplx-...',
      note: 'Sonar models have live web search built-in.',
      defaultModel: 'sonar-pro',
      // no /models endpoint exists — never offer live model fetch
      quirks: { noModelsEndpoint: true }
    },
    {
      id: 'nvidia_nim', label: 'NVIDIA NIM', base: 'https://integrate.api.nvidia.com/v1',
      keyLink: 'https://build.nvidia.com/explore/discover', keyHint: 'nvapi-...',
      note: 'Free tier with NVIDIA developer account.',
      defaultModel: 'deepseek-ai/deepseek-v4-pro'
    },
    {
      id: 'fireworks', label: 'Fireworks AI', base: 'https://api.fireworks.ai/inference/v1',
      keyLink: 'https://fireworks.ai/api-keys', keyHint: 'fw_...',
      defaultModel: 'accounts/fireworks/models/kimi-k2p6'
    },
    {
      id: 'cohere', label: 'Cohere', base: 'https://api.cohere.ai/compatibility/v1',
      keyLink: 'https://dashboard.cohere.com/api-keys', keyHint: '...',
      defaultModel: 'command-a-03-2025'
    },
    {
      id: 'huggingface', label: 'HuggingFace', base: 'https://router.huggingface.co/v1',
      keyLink: 'https://huggingface.co/settings/tokens', keyHint: 'hf_...',
      note: 'Routes to 15+ inference providers.',
      defaultModel: 'deepseek-ai/DeepSeek-V4-Pro'
    },
    {
      id: 'hyperbolic', label: 'Hyperbolic', base: 'https://api.hyperbolic.xyz/v1',
      keyLink: 'https://app.hyperbolic.xyz/settings', keyHint: '...',
      defaultModel: 'deepseek-ai/DeepSeek-R1-0528'
    },
    {
      id: 'sambanova', label: 'SambaNova', base: 'https://api.sambanova.ai/v1',
      keyLink: 'https://cloud.sambanova.ai/apis', keyHint: '...',
      defaultModel: 'Llama-4-Maverick-17B-128E-Instruct'
    },
    {
      id: 'moonshot', label: 'Moonshot (Kimi)', base: 'https://api.moonshot.ai/v1',
      keyLink: 'https://platform.kimi.ai/', keyHint: 'sk-...',
      defaultModel: 'kimi-k2.6'
    },
    {
      id: 'zhipu', label: 'Zhipu AI (Z.ai)', base: 'https://api.z.ai/api/paas/v4',
      keyLink: 'https://www.z.ai/', keyHint: '...',
      defaultModel: 'glm-5.1'
    },
    {
      id: 'qwen', label: 'Qwen (Alibaba)', base: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
      keyLink: 'https://bailian.console.alibabacloud.com/', keyHint: 'sk-...',
      note: 'International endpoint; use dashscope-us.aliyuncs.com for US region.',
      defaultModel: 'qwen3.5-flash'
    }
  ].map(p => Object.assign({ adapter: 'oai', kind: 'preset', models: M(p.id) }, p));

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
