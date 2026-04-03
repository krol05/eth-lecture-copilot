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
 *     All major local runtimes (Ollama, LM Studio, Jan, LocalAI, llamafile,
 *     oobabooga, GPT4All) support this endpoint.
 */

const PROVIDERS_CONFIG = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    type: 'anthropic',
    base: 'https://api.anthropic.com',
    keyLink: 'https://console.anthropic.com/settings/keys',
    keyHint: 'sk-ant-...',
    models: [
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
      { id: 'gpt-4o',          label: 'GPT-4o (widely available)' },
      { id: 'gpt-4o-mini',     label: 'GPT-4o mini' },
      { id: 'gpt-4.1',         label: 'GPT-4.1' },
      { id: 'gpt-4.1-mini',    label: 'GPT-4.1 mini' },
      { id: 'gpt-5.4',         label: 'GPT-5.4' },
      { id: 'gpt-5.4-mini',    label: 'GPT-5.4 mini' },
      { id: 'gpt-5.4-nano',    label: 'GPT-5.4 nano' },
      { id: 'o3-pro',          label: 'o3 Pro' },
      { id: 'o3',              label: 'o3' },
      { id: 'o1',              label: 'o1' },
      { id: 'gpt-oss-120b',    label: 'GPT OSS 120B' }
    ]
  },
  {
    id: 'google',
    label: 'Google',
    type: 'google',
    base: 'https://generativelanguage.googleapis.com',
    keyLink: 'https://aistudio.google.com/app/apikey',
    keyHint: 'AIza...',
    note: 'IDs must match ai.google.dev “Models” (preview models need the -preview suffix). If you get NOT_FOUND, check the exact name in Google AI Studio.',
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
      { id: 'grok-4.20-beta',                 label: 'Grok 4.20 Beta' },
      { id: 'grok-4',                         label: 'Grok 4' },
      { id: 'grok-4.1-fast-reasoning',        label: 'Grok 4.1 Fast (Reasoning)' },
      { id: 'grok-4.1-fast-non-reasoning',    label: 'Grok 4.1 Fast' },
      { id: 'grok-code-fast-1',               label: 'Grok Code Fast 1' },
      { id: 'grok-3',                         label: 'Grok 3' },
      { id: 'grok-3-mini',                    label: 'Grok 3 Mini' }
    ]
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    type: 'openai_compat',
    base: 'https://api.deepseek.com/v1',
    keyLink: 'https://platform.deepseek.com/api_keys',
    keyHint: 'sk-...',
    note: 'Official DeepSeek API uses deepseek-chat (V3.2 chat) and deepseek-reasoner (thinking). Other names often 404.',
    models: [
      { id: 'deepseek-chat',    label: 'DeepSeek V3.2 — chat' },
      { id: 'deepseek-reasoner',label: 'DeepSeek V3.2 — reasoner' }
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
      { id: 'mistral-medium-latest',   label: 'Mistral Medium (latest)' },
      { id: 'mistral-small-latest',    label: 'Mistral Small (latest)' },
      { id: 'mistral-small-4',         label: 'Mistral Small 4' },
      { id: 'pixtral-large-latest',    label: 'Pixtral Large (latest)' },
      { id: 'magistral-medium-latest', label: 'Magistral Medium (latest)' },
      { id: 'magistral-small-latest',  label: 'Magistral Small (latest)' }
    ]
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    type: 'openai_compat',
    base: 'https://openrouter.ai/api/v1',
    keyLink: 'https://openrouter.ai/keys',
    keyHint: 'sk-or-...',
    note: 'Routes to 100+ models — paste any model ID below',
    customModel: true,   // shows a text input instead of dropdown
    models: [
      { id: 'anthropic/claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
      { id: 'openai/gpt-5.4-mini',         label: 'GPT-5.4 mini' },
      { id: 'google/gemini-3-flash-preview', label: 'Gemini 3 Flash (preview)' },
      { id: 'x-ai/grok-4',                label: 'Grok 4' },
      { id: 'deepseek/deepseek-v4',        label: 'DeepSeek V4' },
      { id: 'meta-llama/llama-4-maverick', label: 'Llama 4 Maverick' },
      { id: 'qwen/qwen3.5-max',            label: 'Qwen 3.5 Max' }
    ]
  },
  {
    id: 'groq',
    label: 'Groq',
    type: 'openai_compat',
    base: 'https://api.groq.com/openai/v1',
    keyLink: 'https://console.groq.com/keys',
    keyHint: 'gsk_...',
    note: 'Ultra-fast inference',
    note: 'Groq expects the full model string including the meta-llama/ prefix.',
    models: [
      { id: 'meta-llama/llama-4-maverick-17b-128e-instruct', label: 'Llama 4 Maverick' },
      { id: 'meta-llama/llama-4-scout-17b-16e-instruct',     label: 'Llama 4 Scout' },
      { id: 'llama-3.3-70b-versatile',                       label: 'Llama 3.3 70B' },
      { id: 'mixtral-8x7b-32768',                            label: 'Mixtral 8x7B' }
    ]
  },
  {
    id: 'together',
    label: 'Together AI',
    type: 'openai_compat',
    base: 'https://api.together.xyz/v1',
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
    note: 'Free tier available — extremely fast',
    models: [
      { id: 'llama-4-scout-17b-16e-instruct', label: 'Llama 4 Scout' },
      { id: 'llama-3.3-70b',                  label: 'Llama 3.3 70B' },
      { id: 'llama3.1-8b',                    label: 'Llama 3.1 8B' }
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
    id: 'local_litellm',
    label: 'LiteLLM (local proxy)',
    type: 'local',
    defaultBase: 'http://localhost:4000/v1',
    note: 'Run LiteLLM proxy locally, then click Detect Models',
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
    id: 'local_jan',
    label: 'Jan',
    type: 'local',
    defaultBase: 'http://localhost:1337/v1',
    note: 'Enable the API server in Jan settings',
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
    customBase: true,   // shows editable URL field
    models: []
  }
];

PROVIDERS_CONFIG.push(...LOCAL_PROVIDERS);

// Quick lookup by provider id
const PROVIDER_MAP = Object.fromEntries(PROVIDERS_CONFIG.map(p => [p.id, p]));

if (typeof module !== 'undefined') {
  module.exports = { PROVIDERS_CONFIG, PROVIDER_MAP };
}
 