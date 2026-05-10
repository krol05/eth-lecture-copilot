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
      { id: 'claude-haiku-4-5',          label: 'Claude Haiku 4.5' },
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
    note: 'gpt-5.5 / gpt-5.5-pro require organization access. If a model 404s your org may not have access yet — try gpt-5.4 or gpt-4o.',
    models: [
      { id: 'gpt-5.5',       label: 'GPT-5.5 (frontier, 1M ctx)' },
      { id: 'gpt-5.5-pro',   label: 'GPT-5.5 Pro (extended compute)' },
      { id: 'gpt-5.4',       label: 'GPT-5.4 (1M ctx)' },
      { id: 'gpt-5.4-mini',  label: 'GPT-5.4 mini' },
      { id: 'gpt-5.4-nano',  label: 'GPT-5.4 nano (cheapest)' },
      { id: 'gpt-5',         label: 'GPT-5 (legacy)' },
      { id: 'gpt-5-mini',    label: 'GPT-5 mini (legacy)' },
      { id: 'gpt-4.1',       label: 'GPT-4.1 (legacy)' },
      { id: 'gpt-4o',        label: 'GPT-4o (legacy)' },
      { id: 'gpt-4o-mini',   label: 'GPT-4o mini' },
      { id: 'o4-mini',       label: 'o4 mini (reasoning)' }
    ]
  },
  {
    id: 'google',
    label: 'Google Gemini',
    type: 'google',
    base: 'https://generativelanguage.googleapis.com',
    keyLink: 'https://aistudio.google.com/app/apikey',
    keyHint: 'AIza...',
    note: 'IDs must match ai.google.dev "Models". gemini-2.0-flash shuts down June 1 2026 — use 2.5 or 3.x.',
    models: [
      { id: 'gemini-3.1-pro-preview',      label: 'Gemini 3.1 Pro (preview)' },
      { id: 'gemini-3-flash-preview',      label: 'Gemini 3 Flash (preview)' },
      { id: 'gemini-3.1-flash-lite',       label: 'Gemini 3.1 Flash-Lite (GA)' },
      { id: 'gemini-3.1-flash-lite-preview', label: 'Gemini 3.1 Flash-Lite (preview)' },
      { id: 'gemini-2.5-pro',              label: 'Gemini 2.5 Pro' },
      { id: 'gemini-2.5-flash',            label: 'Gemini 2.5 Flash' },
      { id: 'gemini-2.5-flash-lite',       label: 'Gemini 2.5 Flash-Lite' }
    ]
  },
  {
    id: 'xai',
    label: 'xAI (Grok)',
    type: 'openai_compat',
    base: 'https://api.x.ai/v1',
    keyLink: 'https://console.x.ai/',
    keyHint: 'xai-...',
    note: 'grok-4.1-fast and older models retire May 15 2026. Use grok-4.3 or grok-4.20-* series.',
    models: [
      { id: 'grok-4.3',                label: 'Grok 4.3 (current, May 2026)' },
      { id: 'grok-4.20-reasoning',     label: 'Grok 4.20 Reasoning (2M ctx)' },
      { id: 'grok-4.20-non-reasoning', label: 'Grok 4.20 Non-Reasoning (fast)' },
      { id: 'grok-4.20-multi-agent',   label: 'Grok 4.20 Multi-Agent' }
    ]
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    type: 'openai_compat',
    base: 'https://api.deepseek.com/v1',
    keyLink: 'https://platform.deepseek.com/api_keys',
    keyHint: 'sk-...',
    note: 'deepseek-chat and deepseek-reasoner retire July 24 2026 — migrate to V4 models.',
    models: [
      { id: 'deepseek-v4-flash',    label: 'DeepSeek V4 Flash (1M ctx)' },
      { id: 'deepseek-v4-pro',      label: 'DeepSeek V4 Pro (1M ctx, reasoning)' },
      { id: 'deepseek-chat',        label: 'DeepSeek Chat (retiring Jul 24 2026)' },
      { id: 'deepseek-reasoner',    label: 'DeepSeek Reasoner (retiring Jul 24 2026)' }
    ]
  },
  {
    id: 'mistral',
    label: 'Mistral',
    type: 'openai_compat',
    base: 'https://api.mistral.ai/v1',
    keyLink: 'https://console.mistral.ai/api-keys/',
    keyHint: '...',
    note: 'mistral-medium-latest alias no longer exists — use mistral-medium-3-5 directly.',
    models: [
      { id: 'mistral-large-latest',    label: 'Mistral Large 3 (latest alias)' },
      { id: 'mistral-large-2512',      label: 'Mistral Large 3 (Dec 2025 snapshot)' },
      { id: 'mistral-medium-3-5',      label: 'Mistral Medium 3.5 (Apr 2026, reasoning)' },
      { id: 'mistral-medium-2508',     label: 'Mistral Medium 3.1 (Aug 2025)' },
      { id: 'mistral-small-latest',    label: 'Mistral Small 4 (latest alias)' },
      { id: 'codestral-latest',        label: 'Codestral (code, latest)' },
      { id: 'devstral-2-latest',       label: 'Devstral 2 (coding agents)' },
      { id: 'magistral-medium-latest', label: 'Magistral Medium (reasoning)' },
      { id: 'magistral-small-latest',  label: 'Magistral Small (reasoning)' }
    ]
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    type: 'openai_compat',
    base: 'https://openrouter.ai/api/v1',
    keyLink: 'https://openrouter.ai/keys',
    keyHint: 'sk-or-...',
    note: 'Routes to 300+ models — pick from the list or paste any model ID below',
    customModel: true,
    models: [
      { id: 'anthropic/claude-sonnet-4-6',       label: 'Claude Sonnet 4.6' },
      { id: 'openai/gpt-5.4',                    label: 'GPT-5.4' },
      { id: 'google/gemini-2.5-flash',           label: 'Gemini 2.5 Flash' },
      { id: 'x-ai/grok-4.3',                     label: 'Grok 4.3' },
      { id: 'deepseek/deepseek-v4-flash',        label: 'DeepSeek V4 Flash' },
      { id: 'meta-llama/llama-4-maverick',       label: 'Llama 4 Maverick' },
      { id: 'moonshotai/kimi-k2.6',              label: 'Kimi K2.6' },
      { id: 'qwen/qwen3.5-flash-02-23',          label: 'Qwen3.5 Flash' }
    ]
  },
  {
    id: 'groq',
    label: 'Groq',
    type: 'openai_compat',
    base: 'https://api.groq.com/openai/v1',
    keyLink: 'https://console.groq.com/keys',
    keyHint: 'gsk_...',
    note: 'Ultra-fast inference. Llama 4 Maverick deprecated 03/09/26 — use gpt-oss models.',
    models: [
      { id: 'openai/gpt-oss-120b',                        label: 'GPT-OSS 120B (~500 t/s)' },
      { id: 'openai/gpt-oss-20b',                         label: 'GPT-OSS 20B (~1000 t/s, fastest reasoning)' },
      { id: 'llama-3.3-70b-versatile',                    label: 'Llama 3.3 70B' },
      { id: 'meta-llama/llama-4-scout-17b-16e-instruct',  label: 'Llama 4 Scout (preview, vision)' },
      { id: 'qwen/qwen3-32b',                             label: 'Qwen3 32B (preview)' },
      { id: 'llama-3.1-8b-instant',                       label: 'Llama 3.1 8B (fastest small)' }
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
      { id: 'deepseek-ai/DeepSeek-V4-Pro',                        label: 'DeepSeek V4 Pro (512K ctx)' },
      { id: 'Qwen/Qwen3.5-397B-A17B',                             label: 'Qwen3.5 397B A17B' },
      { id: 'moonshotai/Kimi-K2.6',                               label: 'Kimi K2.6' },
      { id: 'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8',  label: 'Llama 4 Maverick (1M ctx)' },
      { id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',            label: 'Llama 3.3 70B Turbo' },
      { id: 'Qwen/Qwen3-235B-A22B-Instruct-2507-tput',            label: 'Qwen3 235B A22B' }
    ]
  },
  {
    id: 'cerebras',
    label: 'Cerebras',
    type: 'openai_compat',
    base: 'https://api.cerebras.ai/v1',
    keyLink: 'https://cloud.cerebras.ai',
    keyHint: 'csk-...',
    note: 'Free tier — GPT-OSS-120B runs at ~3000 t/s (world fastest). GLM-4.7 is 200K context coding model.',
    models: [
      { id: 'gpt-oss-120b',   label: 'GPT-OSS 120B (~3000 t/s)' },
      { id: 'zai-glm-4.7',    label: 'GLM-4.7 (200K ctx, coding, preview)' }
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
      { id: 'deepseek-ai/deepseek-v4-pro',             label: 'DeepSeek V4 Pro (1M ctx)' },
      { id: 'meta/llama-4-maverick-17b-128e-instruct', label: 'Llama 4 Maverick (1M ctx, vision)' },
      { id: 'nvidia/llama-3.1-nemotron-ultra-253b-v1', label: 'Nemotron Ultra 253B v1 (reasoning)' },
      { id: 'nvidia/nemotron-3-super-120b-a12b',       label: 'Nemotron 3 Super 120B (MoE)' },
      { id: 'openai/gpt-oss-120b',                     label: 'GPT-OSS 120B' },
      { id: 'meta/llama-3.3-70b-instruct',             label: 'Llama 3.3 70B' }
    ]
  },
  {
    id: 'fireworks',
    label: 'Fireworks AI',
    type: 'openai_compat',
    base: 'https://api.fireworks.ai/inference/v1',
    keyLink: 'https://fireworks.ai/api-keys',
    keyHint: 'fw_...',
    note: 'Fast open-source inference — 100+ models. Dot notation: k2p6 = k2.6, v4 = v4, 2p5 = 2.5.',
    models: [
      { id: 'accounts/fireworks/models/kimi-k2p6',                   label: 'Kimi K2.6 (top ranked)' },
      { id: 'accounts/fireworks/models/deepseek-v4-pro',             label: 'DeepSeek V4 Pro (1M ctx)' },
      { id: 'accounts/fireworks/models/llama4-maverick-instruct-basic', label: 'Llama 4 Maverick (1M ctx)' },
      { id: 'accounts/fireworks/models/gpt-oss-120b',                label: 'GPT-OSS 120B' },
      { id: 'accounts/fireworks/models/qwen3-235b-a22b',             label: 'Qwen3 235B A22B' },
      { id: 'accounts/fireworks/models/deepseek-r1',                 label: 'DeepSeek R1 (reasoning)' }
    ]
  },
  {
    id: 'perplexity',
    label: 'Perplexity',
    type: 'openai_compat',
    base: 'https://api.perplexity.ai',
    keyLink: 'https://www.perplexity.ai/settings/api',
    keyHint: 'pplx-...',
    note: 'Sonar models have live web search built-in — great for fact-checking lecture content. r1-1776 and sonar-reasoning deprecated.',
    models: [
      { id: 'sonar-pro',           label: 'Sonar Pro (200K ctx, web search)' },
      { id: 'sonar',               label: 'Sonar (web search)' },
      { id: 'sonar-reasoning-pro', label: 'Sonar Reasoning Pro' },
      { id: 'sonar-deep-research', label: 'Sonar Deep Research' }
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
      { id: 'command-a-03-2025',              label: 'Command A (256K ctx, vision)' },
      { id: 'command-a-reasoning-08-2025',    label: 'Command A Reasoning (32K output)' },
      { id: 'command-a-vision-07-2025',       label: 'Command A Vision (multimodal)' },
      { id: 'command-r-plus-08-2024',         label: 'Command R+ (Aug 2024)' },
      { id: 'command-r-08-2024',              label: 'Command R (Aug 2024)' },
      { id: 'command-r7b-12-2024',            label: 'Command R 7B (cheapest)' }
    ]
  },
  {
    id: 'huggingface',
    label: 'HuggingFace',
    type: 'openai_compat',
    base: 'https://router.huggingface.co/v1',
    keyLink: 'https://huggingface.co/settings/tokens',
    keyHint: 'hf_...',
    note: 'Routes to 15+ inference providers. Append :cheapest or :fastest to model ID for routing hint.',
    models: [
      { id: 'deepseek-ai/DeepSeek-V4-Pro',                      label: 'DeepSeek V4 Pro (1M ctx)' },
      { id: 'Qwen/Qwen3.5-397B-A17B',                           label: 'Qwen3.5 397B A17B' },
      { id: 'meta-llama/Llama-4-Maverick-17B-128E-Instruct',    label: 'Llama 4 Maverick (1M ctx)' },
      { id: 'moonshotai/Kimi-K2.6',                             label: 'Kimi K2.6' },
      { id: 'meta-llama/Llama-3.3-70B-Instruct',                label: 'Llama 3.3 70B' },
      { id: 'openai/gpt-oss-120b',                              label: 'GPT-OSS 120B' }
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
      { id: 'deepseek-ai/DeepSeek-R1-0528',        label: 'DeepSeek R1 0528 (reasoning)' },
      { id: 'deepseek-ai/DeepSeek-V3-0324',        label: 'DeepSeek V3 0324' },
      { id: 'Qwen/Qwen3-235B-A22B',                label: 'Qwen3 235B A22B' },
      { id: 'Qwen/QwQ-32B',                        label: 'QwQ 32B (reasoning)' },
      { id: 'meta-llama/Llama-3.3-70B-Instruct',   label: 'Llama 3.3 70B' },
      { id: 'Qwen/Qwen2.5-72B-Instruct',           label: 'Qwen 2.5 72B' }
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
      { id: 'Llama-4-Maverick-17B-128E-Instruct',  label: 'Llama 4 Maverick (1M ctx, vision)' },
      { id: 'DeepSeek-V3.2',                       label: 'DeepSeek V3.2' },
      { id: 'MiniMax-M2.7',                        label: 'MiniMax M2.7 (agentic)' },
      { id: 'Meta-Llama-3.3-70B-Instruct',         label: 'Llama 3.3 70B' },
      { id: 'gpt-oss-120b',                        label: 'GPT-OSS 120B' }
    ]
  },
  {
    id: 'moonshot',
    label: 'Moonshot (Kimi)',
    type: 'openai_compat',
    base: 'https://api.moonshot.ai/v1',
    keyLink: 'https://platform.kimi.ai/',
    keyHint: 'sk-...',
    note: 'Kimi K2.6 is the current flagship (Apr 2026). kimi-k2-0711-preview retires May 25 2026.',
    models: [
      { id: 'kimi-k2.6',          label: 'Kimi K2.6 (current, 262K ctx)' },
      { id: 'kimi-k2.5',          label: 'Kimi K2.5 (vision, thinking)' },
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
    note: 'GLM-5.1 is the Apr 2026 flagship (754B MoE, 200K ctx, 128K output). Free flash tiers available.',
    models: [
      { id: 'glm-5.1',       label: 'GLM-5.1 (Apr 2026, 200K ctx, 128K out)' },
      { id: 'glm-5',         label: 'GLM-5 (Feb 2026)' },
      { id: 'glm-5v-turbo',  label: 'GLM-5V-Turbo (vision)' },
      { id: 'glm-4.7',       label: 'GLM-4.7' },
      { id: 'glm-4.7-flash', label: 'GLM-4.7-Flash (free)' },
      { id: 'glm-4.6v',      label: 'GLM-4.6V (vision)' }
    ]
  },
  {
    id: 'qwen',
    label: 'Qwen (Alibaba)',
    type: 'openai_compat',
    base: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    keyLink: 'https://bailian.console.alibabacloud.com/',
    keyHint: 'sk-...',
    note: 'Official Alibaba Cloud international endpoint. qwen3.5-* are 1M context models. Use dashscope-us.aliyuncs.com for US region.',
    models: [
      { id: 'qwen3.5-plus',         label: 'Qwen3.5-Plus (1M ctx, Feb-Apr 2026)' },
      { id: 'qwen3.5-flash',        label: 'Qwen3.5-Flash (1M ctx, fast)' },
      { id: 'qwen3-max',            label: 'Qwen3-Max (stable alias)' },
      { id: 'qwen3-235b-a22b',      label: 'Qwen3 235B A22B (open weight)' },
      { id: 'qwen3-72b',            label: 'Qwen3 72B' },
      { id: 'qwen3-30b-a3b',        label: 'Qwen3 30B A3B' },
      { id: 'qwq-plus',             label: 'QwQ-Plus (reasoning)' },
      { id: 'qwq-32b',              label: 'QwQ 32B (open weight reasoning)' },
      { id: 'qwen3-coder-plus',     label: 'Qwen3-Coder-Plus (1M ctx, code)' }
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
