/**
 * providers-config.js
 * Single source of truth for all supported AI providers and their models.
 * Shared between background.js, popup.js, and sidebar.js.
 *
 * type: 'anthropic' | 'google' | 'openai_compat' | 'local'
 *
 * 'local' providers:
 *   - noAuth: true  (no API key needed)
 *   - defaultBase: the default localhost URL (user can edit port)
 *   - models list is empty by default — populated at runtime via "Detect Models"
 *   - Discovery: background sends GET {base}/models → OAI-compat { data:[{id}] }
 *     All major local runtimes (Ollama, LM Studio, vLLM, Jan, LocalAI, llamafile,
 *     oobabooga, GPT4All, KoboldCpp, TGI) support this endpoint.
 */

const PROVIDERS_CONFIG = [
  // ── Tier 1: Major cloud providers ─────────────────────────────────────────
  {
    id: 'anthropic',
    label: 'Anthropic',
    type: 'anthropic',
    base: 'https://api.anthropic.com',
    keyLink: 'https://console.anthropic.com/settings/keys',
    keyHint: 'sk-ant-...',
    models: [
      { id: 'claude-opus-4-7',           label: 'Claude Opus 4.7' },
      { id: 'claude-opus-4-6',           label: 'Claude Opus 4.6' },
      { id: 'claude-sonnet-4-6',         label: 'Claude Sonnet 4.6' },
      { id: 'claude-haiku-4-5',          label: 'Claude Haiku 4.5 (alias)' },
      { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 (snapshot)' }
    ]
  },
  {
    id: 'openai',
    label: 'OpenAI',
    type: 'openai_compat',
    base: 'https://api.openai.com/v1',
    keyLink: 'https://platform.openai.com/api-keys',
    keyHint: 'sk-...',
    note: 'If a model 404s, your key or org may not have access — pick GPT-4o or check platform.openai.com/docs/models.',
    models: [
      { id: 'gpt-4o',          label: 'GPT-4o' },
      { id: 'gpt-4o-mini',     label: 'GPT-4o mini' },
      { id: 'gpt-4.1',         label: 'GPT-4.1' },
      { id: 'gpt-4.1-mini',    label: 'GPT-4.1 mini' },
      { id: 'gpt-5',           label: 'GPT-5' },
      { id: 'gpt-5.1',         label: 'GPT-5.1' },
      { id: 'o4-mini',         label: 'o4 mini' },
      { id: 'o3',              label: 'o3' },
      { id: 'o3-pro',          label: 'o3 Pro' },
      { id: 'gpt-oss-120b',    label: 'GPT OSS 120B' }
    ]
  },
  {
    id: 'google',
    label: 'Google Gemini',
    type: 'google',
    base: 'https://generativelanguage.googleapis.com',
    keyLink: 'https://aistudio.google.com/app/apikey',
    keyHint: 'AIza...',
    note: 'IDs must match ai.google.dev "Models". If you get NOT_FOUND, check the exact name in Google AI Studio.',
    models: [
      { id: 'gemini-2.5-flash',                label: 'Gemini 2.5 Flash' },
      { id: 'gemini-2.5-flash-lite',           label: 'Gemini 2.5 Flash Lite' },
      { id: 'gemini-2.5-pro',                  label: 'Gemini 2.5 Pro' },
      { id: 'gemini-3-flash-preview',          label: 'Gemini 3 Flash (preview)' },
      { id: 'gemini-3.1-flash-lite-preview',   label: 'Gemini 3.1 Flash Lite (preview)' },
      { id: 'gemini-3.1-pro-preview',          label: 'Gemini 3.1 Pro (preview)' },
      { id: 'gemini-2.0-flash',                label: 'Gemini 2.0 Flash' }
    ]
  },
  {
    id: 'xai',
    label: 'xAI (Grok)',
    type: 'openai_compat',
    base: 'https://api.x.ai/v1',
    keyLink: 'https://console.x.ai/',
    keyHint: 'xai-...',
    models: [
      { id: 'grok-4',                          label: 'Grok 4' },
      { id: 'grok-4.3',                        label: 'Grok 4.3' },
      { id: 'grok-4.1-fast-reasoning',         label: 'Grok 4.1 Fast (Reasoning)' },
      { id: 'grok-4.1-fast-non-reasoning',     label: 'Grok 4.1 Fast' },
      { id: 'grok-code-fast-1',                label: 'Grok Code Fast 1' },
      { id: 'grok-3',                          label: 'Grok 3 (legacy)' },
      { id: 'grok-3-mini',                     label: 'Grok 3 Mini (legacy)' }
    ]
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    type: 'openai_compat',
    base: 'https://api.deepseek.com/v1',
    keyLink: 'https://platform.deepseek.com/api_keys',
    keyHint: 'sk-...',
    note: 'deepseek-chat and deepseek-reasoner retire July 2026 — use V4 models.',
    models: [
      { id: 'deepseek-v4-flash',    label: 'DeepSeek V4 Flash (current)' },
      { id: 'deepseek-v4-pro',      label: 'DeepSeek V4 Pro / Reasoner (current)' },
      { id: 'deepseek-chat',        label: 'DeepSeek V3.2 Chat (retiring Jul 2026)' },
      { id: 'deepseek-reasoner',    label: 'DeepSeek V3.2 Reasoner (retiring Jul 2026)' }
    ]
  },
  {
    id: 'mistral',
    label: 'Mistral',
    type: 'openai_compat',
    base: 'https://api.mistral.ai/v1',
    keyLink: 'https://console.mistral.ai/api-keys/',
    keyHint: '...',
    models: [
      { id: 'mistral-large-latest',    label: 'Mistral Large (latest)' },
      { id: 'mistral-large-2512',      label: 'Mistral Large 3' },
      { id: 'mistral-medium-latest',   label: 'Mistral Medium (latest)' },
      { id: 'mistral-medium-2508',     label: 'Mistral Medium 3.5' },
      { id: 'mistral-small-latest',    label: 'Mistral Small (latest)' },
      { id: 'mistral-small-2506',      label: 'Mistral Small 4' },
      { id: 'pixtral-large-latest',    label: 'Pixtral Large (vision)' },
      { id: 'magistral-medium-latest', label: 'Magistral Medium (reasoning)' },
      { id: 'magistral-small-latest',  label: 'Magistral Small (reasoning)' },
      { id: 'codestral-25-08',         label: 'Codestral (code)' }
    ]
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    type: 'openai_compat',
    base: 'https://openrouter.ai/api/v1',
    keyLink: 'https://openrouter.ai/keys',
    keyHint: 'sk-or-...',
    note: 'Routes to 300+ models — paste any model ID below',
    customModel: true,
    models: [
      { id: 'anthropic/claude-sonnet-4-6',       label: 'Claude Sonnet 4.6' },
      { id: 'openai/gpt-4o',                     label: 'GPT-4o' },
      { id: 'google/gemini-2.5-flash',           label: 'Gemini 2.5 Flash' },
      { id: 'x-ai/grok-4',                       label: 'Grok 4' },
      { id: 'deepseek/deepseek-v4-flash',        label: 'DeepSeek V4 Flash' },
      { id: 'meta-llama/llama-4-maverick',       label: 'Llama 4 Maverick' },
      { id: 'qwen/qwen3.5-max',                  label: 'Qwen 3.5 Max' },
      { id: 'nvidia/llama-3.1-nemotron-70b-instruct', label: 'Nemotron 70B' }
    ]
  },
  {
    id: 'groq',
    label: 'Groq',
    type: 'openai_compat',
    base: 'https://api.groq.com/openai/v1',
    keyLink: 'https://console.groq.com/keys',
    keyHint: 'gsk_...',
    note: 'Ultra-fast inference. Use full model ID including provider prefix (e.g. meta-llama/...).',
    models: [
      { id: 'meta-llama/llama-4-maverick-17b-128e-instruct', label: 'Llama 4 Maverick' },
      { id: 'meta-llama/llama-4-scout-17b-16e-instruct',     label: 'Llama 4 Scout (vision)' },
      { id: 'llama-3.3-70b-versatile',                       label: 'Llama 3.3 70B' },
      { id: 'llama3.1-8b-instant',                           label: 'Llama 3.1 8B (fastest)' },
      { id: 'gpt-oss-20b',                                   label: 'GPT OSS 20B (1000 tps)' }
    ]
  },
  {
    id: 'together',
    label: 'Together AI',
    type: 'openai_compat',
    base: 'https://api.together.ai/v1',
    keyLink: 'https://api.together.ai/settings/api-keys',
    keyHint: '...',
    models: [
      { id: 'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8', label: 'Llama 4 Maverick' },
      { id: 'meta-llama/Llama-4-Scout-17B-16E-Instruct',         label: 'Llama 4 Scout' },
      { id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',           label: 'Llama 3.3 70B' },
      { id: 'Qwen/Qwen3-235B-A22B-fp8-tput',                     label: 'Qwen 3 235B' },
      { id: 'deepseek-ai/DeepSeek-V3',                           label: 'DeepSeek V3' }
    ]
  },
  {
    id: 'cerebras',
    label: 'Cerebras',
    type: 'openai_compat',
    base: 'https://api.cerebras.ai/v1',
    keyLink: 'https://cloud.cerebras.ai',
    keyHint: 'csk-...',
    note: 'Free tier available — extremely fast inference',
    models: [
      { id: 'llama-4-scout-17b-16e-instruct', label: 'Llama 4 Scout' },
      { id: 'gpt-oss-120b',                   label: 'GPT OSS 120B' },
      { id: 'llama-3.3-70b',                  label: 'Llama 3.3 70B' },
      { id: 'llama3.1-8b',                    label: 'Llama 3.1 8B' }
    ]
  },

  // ── Tier 2: Specialist & regional providers ────────────────────────────────
  {
    id: 'nvidia_nim',
    label: 'NVIDIA NIM',
    type: 'openai_compat',
    base: 'https://integrate.api.nvidia.com/v1',
    keyLink: 'https://build.nvidia.com/explore/discover',
    keyHint: 'nvapi-...',
    note: 'Free tier with NVIDIA developer account — 100+ hosted models.',
    models: [
      { id: 'meta/llama-4-maverick-17b-128e-instruct', label: 'Llama 4 Maverick' },
      { id: 'nvidia/llama-3.1-nemotron-nano-8b-v1',    label: 'Nemotron Nano 8B VL (vision)' },
      { id: 'qwen/qwen2.5-vl-72b-instruct',            label: 'Qwen2.5-VL 72B (vision)' },
      { id: 'meta/llama-3.3-70b-instruct',             label: 'Llama 3.3 70B' },
      { id: 'mistralai/mistral-large-2-instruct',      label: 'Mistral Large 2' },
      { id: 'deepseek-ai/deepseek-v3-0324',            label: 'DeepSeek V3' }
    ]
  },
  {
    id: 'fireworks',
    label: 'Fireworks AI',
    type: 'openai_compat',
    base: 'https://api.fireworks.ai/inference/v1',
    keyLink: 'https://fireworks.ai/api-keys',
    keyHint: 'fw_...',
    note: 'Fast open-source inference — 100+ models. Use accounts/{id}/models/{name} format.',
    models: [
      { id: 'accounts/fireworks/models/llama-v4-maverick-instruct',    label: 'Llama 4 Maverick' },
      { id: 'accounts/fireworks/models/llama-v4-scout-instruct-basic', label: 'Llama 4 Scout' },
      { id: 'accounts/fireworks/models/qwen3-235b-a22b',               label: 'Qwen 3 235B' },
      { id: 'accounts/fireworks/models/deepseek-r1',                   label: 'DeepSeek R1' },
      { id: 'accounts/fireworks/models/qwen2p5-vl-72b-instruct',       label: 'Qwen2.5-VL 72B (vision)' },
      { id: 'accounts/fireworks/models/phi-4-vision-instruct',         label: 'Phi-4 Vision' }
    ]
  },
  {
    id: 'perplexity',
    label: 'Perplexity',
    type: 'openai_compat',
    base: 'https://api.perplexity.ai',
    keyLink: 'https://www.perplexity.ai/settings/api',
    keyHint: 'pplx-...',
    note: 'Sonar models have live web search built-in — great for fact-checking lecture content.',
    models: [
      { id: 'sonar-pro',              label: 'Sonar Pro (web search + vision)' },
      { id: 'sonar',                  label: 'Sonar (web search)' },
      { id: 'sonar-reasoning-pro',    label: 'Sonar Reasoning Pro' },
      { id: 'sonar-reasoning',        label: 'Sonar Reasoning' },
      { id: 'sonar-deep-research',    label: 'Sonar Deep Research' },
      { id: 'r1-1776',                label: 'R1-1776 (no web search)' }
    ]
  },
  {
    id: 'cohere',
    label: 'Cohere',
    type: 'openai_compat',
    base: 'https://api.cohere.ai/compatibility/v1',
    keyLink: 'https://dashboard.cohere.com/api-keys',
    keyHint: '...',
    note: 'Uses OpenAI-compatible endpoint. Strong on long-context and RAG tasks.',
    models: [
      { id: 'command-a-03-2025',   label: 'Command A (vision, 256K ctx)' },
      { id: 'command-r-plus',      label: 'Command R+' },
      { id: 'command-r',           label: 'Command R' },
      { id: 'command-r7b',         label: 'Command R 7B' }
    ]
  },
  {
    id: 'huggingface',
    label: 'HuggingFace',
    type: 'openai_compat',
    base: 'https://router.huggingface.co/v1',
    keyLink: 'https://huggingface.co/settings/tokens',
    keyHint: 'hf_...',
    note: 'Routes to 15+ inference providers. Model format: Provider/Name:backend (e.g. Qwen/Qwen2.5-VL-72B-Instruct:nebius).',
    models: [
      { id: 'meta-llama/Llama-3.3-70B-Instruct',    label: 'Llama 3.3 70B' },
      { id: 'Qwen/Qwen2.5-72B-Instruct',            label: 'Qwen 2.5 72B' },
      { id: 'Qwen/Qwen2.5-VL-72B-Instruct',         label: 'Qwen2.5-VL 72B (vision)' },
      { id: 'mistralai/Mistral-7B-Instruct-v0.3',   label: 'Mistral 7B' },
      { id: 'google/gemma-3-27b-it',                label: 'Gemma 3 27B' }
    ]
  },
  {
    id: 'hyperbolic',
    label: 'Hyperbolic',
    type: 'openai_compat',
    base: 'https://api.hyperbolic.xyz/v1',
    keyLink: 'https://app.hyperbolic.xyz/settings',
    keyHint: '...',
    note: 'Affordable large-model inference — not on OpenRouter.',
    models: [
      { id: 'deepseek-ai/DeepSeek-V3',              label: 'DeepSeek V3' },
      { id: 'meta-llama/Llama-3.3-70B-Instruct',    label: 'Llama 3.3 70B' },
      { id: 'Qwen/Qwen2.5-72B-Instruct',            label: 'Qwen 2.5 72B' },
      { id: 'meta-llama/Llama-3.1-405B-Instruct',   label: 'Llama 3.1 405B' }
    ]
  },
  {
    id: 'sambanova',
    label: 'SambaNova',
    type: 'openai_compat',
    base: 'https://api.sambanova.ai/v1',
    keyLink: 'https://cloud.sambanova.ai/apis',
    keyHint: '...',
    note: 'Fastest Llama inference on custom RDU hardware. Free tier available.',
    models: [
      { id: 'Meta-Llama-4-Maverick-17B-128E-Instruct',  label: 'Llama 4 Maverick (vision)' },
      { id: 'Meta-Llama-4-Scout-17B-16E-Instruct',      label: 'Llama 4 Scout' },
      { id: 'Meta-Llama-3.3-70B-Instruct',              label: 'Llama 3.3 70B' },
      { id: 'Meta-Llama-3.1-405B-Instruct',             label: 'Llama 3.1 405B' },
      { id: 'DeepSeek-R1',                              label: 'DeepSeek R1' },
      { id: 'Qwen3-235B-A22B',                          label: 'Qwen 3 235B' }
    ]
  },
  {
    id: 'moonshot',
    label: 'Moonshot (Kimi)',
    type: 'openai_compat',
    base: 'https://api.moonshot.ai/v1',
    keyLink: 'https://platform.kimi.ai/',
    keyHint: 'sk-...',
    note: 'Kimi K2 is a top open-weight model. K2.5 supports vision (text + images).',
    models: [
      { id: 'kimi-k2.5',          label: 'Kimi K2.5 (vision)' },
      { id: 'kimi-k2',            label: 'Kimi K2' },
      { id: 'moonshot-v1-128k',   label: 'Moonshot v1 128K' },
      { id: 'moonshot-v1-32k',    label: 'Moonshot v1 32K' },
      { id: 'moonshot-v1-8k',     label: 'Moonshot v1 8K' }
    ]
  },
  {
    id: 'zhipu',
    label: 'Zhipu AI (Z.ai)',
    type: 'openai_compat',
    base: 'https://api.z.ai/api/paas/v4',
    keyLink: 'https://www.z.ai/',
    keyHint: '...',
    note: 'GLM-4/5 series. Not on OpenRouter. Use open.bigmodel.cn for China mainland.',
    models: [
      { id: 'glm-4.6v',      label: 'GLM-4.6V (vision, 128K)' },
      { id: 'glm-4.5v',      label: 'GLM-4.5V (vision)' },
      { id: 'glm-5',         label: 'GLM-5' },
      { id: 'glm-4',         label: 'GLM-4' },
      { id: 'glm-4-flash',   label: 'GLM-4 Flash (free)' },
      { id: 'glm-z1-flash',  label: 'GLM Z1 Flash (reasoning)' }
    ]
  },
  {
    id: 'qwen',
    label: 'Qwen (Alibaba)',
    type: 'openai_compat',
    base: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    keyLink: 'https://bailian.console.alibabacloud.com/',
    keyHint: 'sk-...',
    note: 'Official Alibaba Cloud endpoint. Strong vision models. Use dashscope-us.aliyuncs.com for US region.',
    models: [
      { id: 'qwen3-235b-a22b',            label: 'Qwen 3 235B A22B' },
      { id: 'qwen3-72b',                  label: 'Qwen 3 72B' },
      { id: 'qwen3-30b-a3b',              label: 'Qwen 3 30B A3B' },
      { id: 'qwq-32b',                    label: 'QwQ 32B (reasoning)' },
      { id: 'qwen2.5-vl-72b-instruct',    label: 'Qwen2.5-VL 72B (vision)' },
      { id: 'qwen2.5-vl-7b-instruct',     label: 'Qwen2.5-VL 7B (vision)' }
    ]
  }
];

// ─── Local providers ────────────────────────────────────────────────────────
// All local runtimes speak OpenAI-compat /v1/chat/completions with no auth.
// Models are discovered at runtime; the list here is just a fallback hint.

const LOCAL_PROVIDERS = [
  {
    id: 'local_ollama',
    label: 'Ollama',
    type: 'local',
    defaultBase: 'http://localhost:11434/v1',
    note: 'Run: ollama serve — then click Detect Models',
    models: []
  },
  {
    id: 'local_lmstudio',
    label: 'LM Studio',
    type: 'local',
    defaultBase: 'http://localhost:1234/v1',
    note: 'Enable the local server in LM Studio → Developer tab',
    models: []
  },
  {
    id: 'local_vllm',
    label: 'vLLM',
    type: 'local',
    defaultBase: 'http://localhost:8000/v1',
    note: 'Production GPU inference: python -m vllm.entrypoints.openai.api_server --model MODEL',
    models: []
  },
  {
    id: 'local_jan',
    label: 'Jan',
    type: 'local',
    defaultBase: 'http://localhost:1337/v1',
    note: 'Enable the API server in Jan settings',
    models: []
  },
  {
    id: 'local_textgenwebui',
    label: 'Text Gen WebUI',
    type: 'local',
    defaultBase: 'http://localhost:5000/v1',
    note: 'oobabooga — start with --api flag enabled',
    models: []
  },
  {
    id: 'local_koboldcpp',
    label: 'KoboldCpp',
    type: 'local',
    defaultBase: 'http://localhost:5001/v1',
    note: 'Single-binary GGUF runner — OpenAI-compat API built in',
    models: []
  },
  {
    id: 'local_gpt4all',
    label: 'GPT4All',
    type: 'local',
    defaultBase: 'http://localhost:4891/v1',
    note: 'Enable Local Server in GPT4All settings',
    models: []
  },
  {
    id: 'local_litellm',
    label: 'LiteLLM Proxy',
    type: 'local',
    defaultBase: 'http://localhost:4000/v1',
    note: 'Universal proxy for 100+ providers — litellm --model MODEL',
    models: []
  },
  {
    id: 'local_localai',
    label: 'LocalAI',
    type: 'local',
    defaultBase: 'http://localhost:8080/v1',
    note: 'docker run -p 8080:8080 localai/localai',
    models: []
  },
  {
    id: 'local_tgi',
    label: 'HF TGI',
    type: 'local',
    defaultBase: 'http://localhost:8080/v1',
    note: 'HuggingFace Text Generation Inference — docker run ghcr.io/huggingface/text-generation-inference',
    models: []
  },
  {
    id: 'local_llamafile',
    label: 'llamafile',
    type: 'local',
    defaultBase: 'http://localhost:8080/v1',
    note: 'Run your .llamafile — server starts automatically',
    models: []
  },
  {
    id: 'local_custom',
    label: 'Custom (local)',
    type: 'local',
    defaultBase: 'http://localhost:11434/v1',
    note: 'Any OpenAI-compatible local server',
    customBase: true,
    models: []
  }
];

PROVIDERS_CONFIG.push(...LOCAL_PROVIDERS);

// Quick lookup by provider id
const PROVIDER_MAP = Object.fromEntries(PROVIDERS_CONFIG.map(p => [p.id, p]));

if (typeof module !== 'undefined') {
  module.exports = { PROVIDERS_CONFIG, PROVIDER_MAP };
}
