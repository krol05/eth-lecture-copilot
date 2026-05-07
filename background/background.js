/**
 * background.js — Service Worker
 * Handles all cross-origin AI API calls via message passing from content/sidebar scripts.
 *
 * Architecture:
 *   - 'anthropic'    → custom handler (unique /v1/messages format)
 *   - 'google'       → custom handler (generateContent format)
 *   - 'openai_compat'→ one generic handler covering OpenAI, xAI, DeepSeek, Mistral,
 *                      OpenRouter, Groq, Together, Cerebras, and any other OAI-compat provider
 */

importScripts(chrome.runtime.getURL('lib/guide-parse.js'));

// ─── Provider config (must match lib/providers-config.js) ────────────────────
// Inlined here because service workers can't import arbitrary files in MV3.

const PROVIDER_MAP = {
  // ── Cloud providers ──────────────────────────────────────────────────────
  anthropic:       { type: 'anthropic',    base: 'https://api.anthropic.com' },
  openai:          { type: 'openai_compat',base: 'https://api.openai.com/v1' },
  google:          { type: 'google',       base: 'https://generativelanguage.googleapis.com' },
  xai:             { type: 'openai_compat',base: 'https://api.x.ai/v1' },
  deepseek:        { type: 'openai_compat',base: 'https://api.deepseek.com/v1' },
  mistral:         { type: 'openai_compat',base: 'https://api.mistral.ai/v1' },
  openrouter:      { type: 'openai_compat',base: 'https://openrouter.ai/api/v1' },
  groq:            { type: 'openai_compat',base: 'https://api.groq.com/openai/v1' },
  together:        { type: 'openai_compat',base: 'https://api.together.ai/v1' },
  cerebras:        { type: 'openai_compat',base: 'https://api.cerebras.ai/v1' },
  // ── Tier 2 cloud providers ───────────────────────────────────────────────
  nvidia_nim:      { type: 'openai_compat',base: 'https://integrate.api.nvidia.com/v1' },
  fireworks:       { type: 'openai_compat',base: 'https://api.fireworks.ai/inference/v1' },
  perplexity:      { type: 'openai_compat',base: 'https://api.perplexity.ai' },
  cohere:          { type: 'openai_compat',base: 'https://api.cohere.ai/compatibility/v1' },
  huggingface:     { type: 'openai_compat',base: 'https://router.huggingface.co/v1' },
  hyperbolic:      { type: 'openai_compat',base: 'https://api.hyperbolic.xyz/v1' },
  sambanova:       { type: 'openai_compat',base: 'https://api.sambanova.ai/v1' },
  moonshot:        { type: 'openai_compat',base: 'https://api.moonshot.ai/v1' },
  zhipu:           { type: 'openai_compat',base: 'https://api.z.ai/api/paas/v4' },
  qwen:            { type: 'openai_compat',base: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' },
  // ── Local providers — base URL comes from message payload (user-configurable)
  local_ollama:       { type: 'local' },
  local_lmstudio:     { type: 'local' },
  local_vllm:         { type: 'local' },
  local_jan:          { type: 'local' },
  local_textgenwebui: { type: 'local' },
  local_koboldcpp:    { type: 'local' },
  local_gpt4all:      { type: 'local' },
  local_litellm:      { type: 'local' },
  local_localai:      { type: 'local' },
  local_tgi:          { type: 'local' },
  local_llamafile:    { type: 'local' },
  local_custom:       { type: 'local' }
};

// Default model per provider — first/best model in the list
const DEFAULT_MODELS = {
  anthropic:   'claude-sonnet-4-6',
  openai:      'gpt-4o',
  google:      'gemini-2.5-flash',
  xai:         'grok-4',
  deepseek:    'deepseek-v4-flash',
  mistral:     'mistral-large-latest',
  openrouter:  'anthropic/claude-sonnet-4-6',
  groq:        'meta-llama/llama-4-maverick-17b-128e-instruct',
  together:    'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8',
  cerebras:    'llama-4-scout-17b-16e-instruct',
  nvidia_nim:  'meta/llama-4-maverick-17b-128e-instruct',
  fireworks:   'accounts/fireworks/models/llama-v4-maverick-instruct',
  perplexity:  'sonar-pro',
  cohere:      'command-a-03-2025',
  huggingface: 'meta-llama/Llama-3.3-70B-Instruct',
  hyperbolic:  'meta-llama/Llama-3.3-70B-Instruct',
  sambanova:   'Meta-Llama-4-Maverick-17B-128E-Instruct',
  moonshot:    'kimi-k2',
  zhipu:       'glm-4',
  qwen:        'qwen3-72b'
};

// ─── OpenAI-compatible handler (covers ~80% of providers) ────────────────────

function normalizeOAIBase(base) {
  const raw = String(base || '').trim();
  if (!raw) throw new Error('Missing OpenAI-compatible base URL');
  return raw.replace(/\/+$/, '');
}

function maybeTimeoutSignal(timeoutMs) {
  return Number.isFinite(timeoutMs) && timeoutMs > 0
    ? AbortSignal.timeout(timeoutMs)
    : undefined;
}

function emitApiProgress(sender, requestId, stage, detail = '') {
  const tabId = sender?.tab?.id;
  if (!tabId || !requestId) return;
  chrome.tabs.sendMessage(tabId, {
    type: 'API_PROGRESS',
    requestId,
    stage,
    detail
  }).catch(() => {});
}

async function callOAICompat(base, model, apiKey, messages, systemPrompt, opts = {}) {
  const normalizedBase = normalizeOAIBase(base);
  opts.onProgress?.('request_sent', normalizedBase);
  const oaiMessages = messages.map(m => {
    if (m.role === 'user' && m.imageBase64) {
      return {
        role: 'user',
        content: [
          { type: 'text', text: m.content },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${m.imageBase64}` } }
        ]
      };
    }
    return { role: m.role, content: m.content };
  });

  const isOSeries = /^o[0-9]/.test(model);

  // o-series uses max_completion_tokens (max_tokens is deprecated for o-series)
  const maxTokensKey = isOSeries ? 'max_completion_tokens' : 'max_tokens';

  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      ...oaiMessages
    ],
    ...(opts.maxTokens ? { [maxTokensKey]: opts.maxTokens } : {}),
    ...(opts.jsonMode ? { response_format: { type: 'json_object' } } : {})
  };

  if (isOSeries) {
    const thinking = opts.thinking || 'none';
    if (thinking !== 'none') {
      body.reasoning_effort = thinking;
    }
  } else {
    body.temperature = opts.temperature ?? 0.4;
  }

  const authHeader = apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {};

  const resp = await fetch(`${normalizedBase}/chat/completions`, {
    method: 'POST',
    ...(maybeTimeoutSignal(opts.timeoutMs) ? { signal: maybeTimeoutSignal(opts.timeoutMs) } : {}),
    headers: {
      'Content-Type': 'application/json',
      ...authHeader,
      ...(opts.extraHeaders || {})
    },
    body: JSON.stringify(body)
  });
  opts.onProgress?.('provider_responding', String(resp.status));

  if (!resp.ok) throw new Error(`${normalizedBase} → ${resp.status}: ${await resp.text()}`);
  const d = await resp.json();
  return d.choices?.[0]?.message?.content ?? '';
}

// ─── Anthropic handler ────────────────────────────────────────────────────────

async function callAnthropic(model, apiKey, messages, systemPrompt, opts = {}) {
  opts.onProgress?.('request_sent', 'anthropic');
  const anthropicMessages = messages.map(m => {
    if (m.role === 'user' && m.imageBase64) {
      return {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: m.imageBase64 } },
          { type: 'text', text: m.content }
        ]
      };
    }
    return { role: m.role, content: m.content };
  });

  const thinking = opts.thinking || 'none';
  const thinkingBudgets = { low: 2048, medium: 10000, high: 32768 };
  const useThinking = thinking !== 'none' && thinkingBudgets[thinking];

  const body = {
    model,
    max_tokens: opts.maxTokens ?? 8192,
    system: systemPrompt,
    messages: anthropicMessages
  };

  if (useThinking) {
    const budgetTokens = thinkingBudgets[thinking];
    // Claude Opus 4.7+ uses adaptive thinking (no budget_tokens parameter)
    const isAdaptiveModel = /claude-opus-4-7/.test(model);
    if (isAdaptiveModel) {
      body.thinking = { type: 'adaptive' };
    } else {
      body.thinking = { type: 'enabled', budget_tokens: budgetTokens };
      body.max_tokens = Math.max(body.max_tokens, budgetTokens + 16000);
    }
    body.temperature = 1;
  } else {
    body.temperature = opts.temperature ?? 0.4;
  }

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    ...(maybeTimeoutSignal(opts.timeoutMs) ? { signal: maybeTimeoutSignal(opts.timeoutMs) } : {}),
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body)
  });
  opts.onProgress?.('provider_responding', String(resp.status));

  if (!resp.ok) throw new Error(`Anthropic → ${resp.status}: ${await resp.text()}`);
  const d = await resp.json();
  if (useThinking) {
    const textBlock = d.content?.find(b => b.type === 'text');
    return textBlock?.text ?? '';
  }
  return d.content?.[0]?.text ?? '';
}

// ─── Google Gemini handler ────────────────────────────────────────────────────

async function callGoogle(model, apiKey, messages, systemPrompt, opts = {}) {
  opts.onProgress?.('request_sent', 'google');
  // Use stable v1 endpoint (v1beta is deprecated for production)
  const url = `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${apiKey}`;

  const contents = messages.map(m => {
    // Google docs: image parts must come before text parts for best results
    const parts = [];
    if (m.imageBase64) {
      parts.push({ inlineData: { mimeType: 'image/jpeg', data: m.imageBase64 } });
    }
    parts.push({ text: m.content });
    return { role: m.role === 'assistant' ? 'model' : 'user', parts };
  });

  const thinking = opts.thinking || 'none';
  const thinkingBudgets = { low: 1024, medium: 8192, high: 24576 };

  const generationConfig = {
    temperature: opts.temperature ?? 0.4,
    ...(opts.maxTokens ? { maxOutputTokens: opts.maxTokens } : {}),
    ...(opts.jsonMode ? { responseMimeType: 'application/json' } : {})
  };

  if (thinking !== 'none' && thinkingBudgets[thinking]) {
    // Gemini 3+ uses thinkingLevel ('low'|'medium'|'high'); older Gemini uses thinkingBudget
    const isGemini3 = /^gemini-3/.test(model);
    generationConfig.thinkingConfig = isGemini3
      ? { thinkingLevel: thinking }
      : { thinkingBudget: thinkingBudgets[thinking] };
  }

  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents,
    generationConfig
  };

  const resp = await fetch(url, {
    method: 'POST',
    ...(maybeTimeoutSignal(opts.timeoutMs) ? { signal: maybeTimeoutSignal(opts.timeoutMs) } : {}),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  opts.onProgress?.('provider_responding', String(resp.status));

  if (!resp.ok) throw new Error(`Google → ${resp.status}: ${await resp.text()}`);
  const d = await resp.json();
  const cand = d.candidates?.[0];
  const text = cand?.content?.parts?.[0]?.text ?? '';
  if (cand?.finishReason === 'MAX_TOKENS') {
    console.warn('[BG] Gemini finishReason=MAX_TOKENS — guide output may be incomplete');
  }
  return text;
}

// ─── Unified call dispatcher ──────────────────────────────────────────────────

async function callAI(provider, model, apiKey, messages, systemPrompt, opts = {}) {
  let cfg = PROVIDER_MAP[provider];
  // Forward-compatible fallback: treat any local_* provider as OpenAI-compatible local.
  if (!cfg && String(provider || '').startsWith('local_')) {
    cfg = { type: 'local' };
  }
  if (!cfg) throw new Error(`Unknown provider: ${provider}`);

  switch (cfg.type) {
    case 'anthropic':    return callAnthropic(model, apiKey, messages, systemPrompt, opts);
    case 'google':       return callGoogle(model, apiKey, messages, systemPrompt, opts);
    case 'openai_compat':return callOAICompat(cfg.base, model, apiKey, messages, systemPrompt, opts);
    // local: base URL comes from opts.localBase (user-configurable per provider)
    case 'local':        return callOAICompat(opts.localBase, model, null, messages, systemPrompt, opts);
    default: throw new Error(`Unknown provider type: ${cfg.type}`);
  }
}

// parseGuideResponse loaded from lib/guide-parse.js (shared with Jest tests).

// ─── Single message handler for ALL operations ──────────────────────────────
// sendMessage + return true keeps the service worker alive until sendResponse
// is called (up to Chrome's 5-minute hard limit — plenty for any API call).

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[BG] onMessage:', message?.type);

  if (message?.type === 'OPEN_OPTIONS') {
    chrome.runtime.openOptionsPage();
    sendResponse({ success: true });
    return;
  }

  if (message?.type === 'CAPTURE_VISIBLE_TAB') {
    const wid = sender?.tab?.windowId ?? null;
    chrome.tabs.captureVisibleTab(wid, { format: 'jpeg', quality: 85 })
      .then(dataUrl => sendResponse({ success: true, data: dataUrl }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  const requestId = message?._copilotRequestId || null;
  const progress = (stage, detail = '') => emitApiProgress(sender, requestId, stage, detail);
  handleMessage(message, progress).then(
    result => sendResponse({ success: true, data: result }),
    err    => sendResponse({ success: false, error: err.message })
  );
  return true;
});

async function handleMessage(msg, progress = () => {}) {
  if (msg.type === 'PING') return 'pong';

  const { type, provider, apiKey, localBase } = msg;
  const model = msg.model || DEFAULT_MODELS[provider];
  // localBase is passed for 'local' type providers; included in opts so callAI can forward it
  const baseOpts = localBase ? { localBase } : {};

  switch (type) {

    case 'DISCOVER_LOCAL_MODELS': {
      // Universal model discovery — all OAI-compat runtimes expose GET /v1/models
      // Works for: Ollama, LM Studio, Jan, LocalAI, llamafile, oobabooga, GPT4All, etc.
      const base = normalizeOAIBase(msg.localBase);
      if (!base) throw new Error('localBase required for model discovery');

      const resp = await fetch(`${base}/models`, {
        signal: AbortSignal.timeout(4000)   // fail fast if server not running
      });
      if (!resp.ok) throw new Error(`Server at ${base} returned ${resp.status}`);
      const d = await resp.json();

      // OAI format: { data: [{ id: "model-name" }] }
      if (Array.isArray(d.data)) return d.data.map(m => m.id).filter(Boolean);
      // Ollama legacy /api/tags fallback: { models: [{ name: "..." }] }
      if (Array.isArray(d.models)) return d.models.map(m => m.name || m.id).filter(Boolean);

      throw new Error('Unrecognised model list format from local server');
    }

    case 'GENERATE_GUIDE': {
      progress('queued', 'Guide request received');
      const { transcriptText, systemPrompt } = msg;
      const useFallback = !!msg.guideFallback;
      const defaultMax = provider === 'google' ? 64000 : 32768;
      const maxGuideTokens = msg.guideMaxTokens || defaultMax;

      let guideTemp, guideThinking;
      if (useFallback) {
        guideTemp = provider === 'google' ? 0.22 : 0.1;
        guideThinking = 'none';
      } else {
        guideTemp = msg.guideTemperature ?? (provider === 'google' ? 0.22 : 0.1);
        guideThinking = msg.guideThinking || 'none';
      }

      const opts = {
        ...baseOpts,
        temperature: guideTemp,
        maxTokens: maxGuideTokens,
        timeoutMs: null,
        jsonMode: true,
        onProgress: progress,
        thinking: guideThinking
      };

      const raw = await callAI(provider, model, apiKey,
        [{ role: 'user', content: transcriptText }], systemPrompt, opts);
      progress('provider_finished', 'Response body received');
      return parseGuideResponse(raw);
    }

    case 'CHAT': {
      const { messages, systemPrompt } = msg;
      const chatTemp = msg.chatTemperature ?? 0.35;
      return callAI(provider, model, apiKey, messages, systemPrompt,
        { ...baseOpts, temperature: chatTemp, timeoutMs: 120000 });
    }

    case 'FETCH_VTT': {
      const resp = await fetch(msg.url, { signal: AbortSignal.timeout(45000) });
      if (!resp.ok) throw new Error(`VTT fetch failed: ${resp.status}`);
      return resp.text();
    }

    case 'FETCH_JSON': {
      const resp = await fetch(msg.url, { signal: AbortSignal.timeout(45000) });
      if (!resp.ok) throw new Error(`JSON fetch failed: ${resp.status}`);
      return resp.json();
    }

    default:
      throw new Error(`Unknown message type: ${type}`);
  }
}
