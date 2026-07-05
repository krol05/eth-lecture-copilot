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

importScripts(
  chrome.runtime.getURL('lib/debug.js'),
  chrome.runtime.getURL('lib/guide-parse.js')
);

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
  openai:      'gpt-5.4',
  google:      'gemini-2.5-flash',
  xai:         'grok-4.3',
  deepseek:    'deepseek-v4-flash',
  mistral:     'mistral-large-latest',
  openrouter:  'anthropic/claude-sonnet-4-6',
  groq:        'openai/gpt-oss-120b',
  together:    'deepseek-ai/DeepSeek-V4-Pro',
  cerebras:    'gpt-oss-120b',
  nvidia_nim:  'deepseek-ai/deepseek-v4-pro',
  fireworks:   'accounts/fireworks/models/kimi-k2p6',
  perplexity:  'sonar-pro',
  cohere:      'command-a-03-2025',
  huggingface: 'deepseek-ai/DeepSeek-V4-Pro',
  hyperbolic:  'deepseek-ai/DeepSeek-R1-0528',
  sambanova:   'Llama-4-Maverick-17B-128E-Instruct',
  moonshot:    'kimi-k2.6',
  zhipu:       'glm-5.1',
  qwen:        'qwen3.5-plus'
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

function isGeminiModel(model) {
  return /(^|\/)gemini-/.test(String(model || '').toLowerCase());
}

function isClaudeModel(model) {
  return /(^|\/)claude-/.test(String(model || '').toLowerCase());
}

function providerMaxOutputTokens(provider, model) {
  const m = String(model || '').toLowerCase();
  const p = String(provider || '').toLowerCase();

  if (p === 'google' || isGeminiModel(m)) return 65536;

  if (p === 'anthropic' || isClaudeModel(m)) {
    // Opus 4.7 supports 131072; Sonnet/Haiku cap at 65536
    if (/opus-4-7/.test(m)) return 131072;
    return 65536;
  }

  // OpenAI GPT-5.x and o-series
  if (/^o[0-9]/.test(m)) return 100000;
  if (/gpt-5\.(4|5)/.test(m)) return 128000;
  if (/gpt-5(?:\.|-)mini/.test(m)) return 128000;
  if (/^gpt-5$/.test(m)) return 128000;
  if (/gpt-4\.1/.test(m)) return 32768;
  if (/gpt-4o/.test(m)) return 16384;
  if (/gpt-oss/.test(m)) return 65536;

  if (p === 'openai') return 16384;

  // xAI Grok 4.20 supports 131072 output
  if (p === 'xai') {
    if (/4\.20/.test(m)) return 131072;
    return 32768;
  }

  if (p === 'mistral') return 32768;

  // DeepSeek V4 supports up to 384000 output tokens (reasoning + content share the budget)
  if (p === 'deepseek') {
    if (/v4|reasoner/.test(m)) return 384000;
    return 8192;
  }

  // Cohere Command A Reasoning supports 32768
  if (p === 'cohere') {
    if (/reasoning/.test(m)) return 32768;
    return 8192;
  }

  if (p === 'groq') return 32768;
  if (p === 'together') return 16384;
  if (p === 'cerebras') return 40960;
  if (p === 'fireworks') return 16384;
  if (p === 'nvidia_nim') return 16384;
  if (p === 'perplexity') return 8192;
  if (p === 'huggingface') return 16384;
  if (p === 'hyperbolic') return 16384;
  if (p === 'sambanova') return 16384;

  // Moonshot / Kimi K2.6 supports 16K output
  if (p === 'moonshot') return 16384;

  // Zhipu GLM-5.1 supports 128K output
  if (p === 'zhipu') {
    if (/glm-5/.test(m)) return 65536;
    return 8192;
  }

  // Qwen 3.5 series supports 65536 output
  if (p === 'qwen') {
    if (/qwen3\.5/.test(m)) return 65536;
    return 8192;
  }

  // Local and proxy providers vary by backend. Start high and let the retry
  // logic below honor provider-reported limits when available.
  if (p.startsWith('local_')) return 81920;

  return 8192;
}

function outputTokensFor(provider, model, requestedMax) {
  const providerCap = providerMaxOutputTokens(provider, model);
  const requested = Number.isFinite(requestedMax) && requestedMax > 0
    ? requestedMax
    : providerCap;
  return Math.max(1, Math.min(requested, providerCap));
}

function providerReportedMaxTokens(error) {
  const text = String(error?.message || error || '');
  const match = text.match(/supported range is from\s+\d+\s+to\s+(\d+)(?:\s*\((exclusive|inclusive)\))?/i);
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  return match[2]?.toLowerCase() === 'exclusive' ? n - 1 : n;
}

function guideMaxTokensFor(provider, model, requestedMax) {
  return outputTokensFor(provider, model, requestedMax);
}

function geminiThinkingConfig(model, thinking) {
  const m = String(model || '').toLowerCase();
  const level = thinking || 'none';
  const isGemini3 = /^gemini-3/.test(m) || /\/gemini-3/.test(m);

  if (isGemini3) {
    if (level === 'none') {
      // Gemini 3 Pro cannot fully disable thinking; Flash/Lite support minimal.
      return { thinkingLevel: /pro/.test(m) ? 'low' : 'minimal' };
    }
    return { thinkingLevel: level };
  }

  const budgets = { low: 1024, medium: 8192, high: 24576 };
  if (level === 'none') {
    // Gemini 2.5 Pro cannot disable thinking; use the smallest allowed budget.
    return { thinkingBudget: /pro/.test(m) ? 128 : 0 };
  }
  return { thinkingBudget: budgets[level] || 0 };
}

function oaiReasoningEffort(provider, model, thinking) {
  const level = thinking || 'none';
  const m = String(model || '').toLowerCase();
  const p = String(provider || '').toLowerCase();

  if (/^o[0-9]/.test(m)) return level === 'none' ? null : level;

  // LiteLLM maps reasoning_effort to Gemini thinking controls. Omit it for
  // other OpenAI-compatible providers because many reject unknown reasoning args.
  if (p === 'local_litellm' && isGeminiModel(m)) {
    if (level === 'none') return /^gemini-3/.test(m) ? 'none' : 'disable';
    return level;
  }

  return null;
}

function emitApiProgress(sender, requestId, stage, detail = '') {
  globalThis.CopilotDebug?.log('background.progress', { requestId, stage, detail });
  const tabId = sender?.tab?.id;
  if (!tabId || !requestId) return;
  chrome.tabs.sendMessage(tabId, {
    type: 'API_PROGRESS',
    requestId,
    stage,
    detail
  }).catch(() => {});
}

function debugRequestMeta(type, requestId, provider, model, msg) {
  globalThis.CopilotDebug?.log('background.request.received', {
    requestId,
    type,
    provider,
    model,
    systemPrompt: msg?.systemPrompt,
    message: msg
  });
}

function debugRawResponse(type, requestId, raw) {
  globalThis.CopilotDebug?.log('background.response.raw', {
    requestId,
    type,
    raw,
    length: typeof raw === 'string' ? raw.length : null
  });
}

function debugParsedResponse(type, requestId, parsed) {
  globalThis.CopilotDebug?.log('background.response.parsed', { requestId, type, parsed });
}

async function callOAICompat(base, model, apiKey, messages, systemPrompt, opts = {}) {
  const normalizedBase = normalizeOAIBase(base);
  opts.onProgress?.('request_sent', normalizedBase);
  const oaiMessages = messages.map(m => {
    const imgs = m.images?.length ? m.images
               : m.imageBase64   ? [`data:image/jpeg;base64,${m.imageBase64}`]
               : [];
    if (m.role === 'user' && imgs.length) {
      return {
        role: 'user',
        content: [
          { type: 'text', text: m.content },
          ...imgs.map(url => ({ type: 'image_url', image_url: { url } }))
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

  const reasoningEffort = oaiReasoningEffort(opts.provider, model, opts.thinking || 'none');
  if (reasoningEffort) {
    body.reasoning_effort = reasoningEffort;
  }

  if (!isOSeries) {
    body.temperature = opts.temperature ?? 0.4;
  }

  const authHeader = apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {};
  globalThis.CopilotDebug?.log('background.provider.oai.request', {
    url: `${normalizedBase}/chat/completions`,
    model,
    systemPrompt,
    messages,
    body
  });

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
  const text = d.choices?.[0]?.message?.content ?? '';
  globalThis.CopilotDebug?.log('background.provider.oai.response', { status: resp.status, json: d, text });
  return text;
}

// ─── Anthropic handler ────────────────────────────────────────────────────────

async function callAnthropic(model, apiKey, messages, systemPrompt, opts = {}) {
  opts.onProgress?.('request_sent', 'anthropic');
  const anthropicMessages = messages.map(m => {
    const imgs = m.images?.length ? m.images
               : m.imageBase64   ? [`data:image/jpeg;base64,${m.imageBase64}`]
               : [];
    if (m.role === 'user' && imgs.length) {
      return {
        role: 'user',
        content: [
          ...imgs.map(url => {
            const [meta, data] = url.split(',');
            const mimeType = meta.replace('data:', '').replace(';base64', '');
            return { type: 'image', source: { type: 'base64', media_type: mimeType, data } };
          }),
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
    // Claude Opus 4.7+ uses adaptive thinking (no budget_tokens parameter).
    const isAdaptiveModel = /claude-opus-4-[67]|claude-sonnet-4-6/.test(model);
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
  globalThis.CopilotDebug?.log('background.provider.anthropic.request', {
    url: 'https://api.anthropic.com/v1/messages',
    model,
    systemPrompt,
    messages,
    body
  });

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
  globalThis.CopilotDebug?.log('background.provider.anthropic.response', { status: resp.status, json: d });
  if (useThinking) {
    const textBlock = d.content?.find(b => b.type === 'text');
    return textBlock?.text ?? '';
  }
  return d.content?.[0]?.text ?? '';
}

// ─── Google Gemini handler ────────────────────────────────────────────────────

async function callGoogle(model, apiKey, messages, systemPrompt, opts = {}) {
  opts.onProgress?.('request_sent', 'google');
  // v1beta required: systemInstruction, thinkingConfig, and responseMimeType JSON mode
  // are not accepted on the /v1 generateContent schema (400 Unknown name).
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const contents = messages.map(m => {
    // Google docs: image parts must come before text parts for best results
    const imgs = m.images?.length ? m.images
               : m.imageBase64   ? [`data:image/jpeg;base64,${m.imageBase64}`]
               : [];
    const parts = [
      ...imgs.map(url => {
        const [meta, data] = url.split(',');
        const mimeType = meta.replace('data:', '').replace(';base64', '');
        return { inlineData: { mimeType, data } };
      }),
      { text: m.content }
    ];
    return { role: m.role === 'assistant' ? 'model' : 'user', parts };
  });

  const generationConfig = {
    temperature: opts.temperature ?? 0.4,
    ...(opts.maxTokens ? { maxOutputTokens: opts.maxTokens } : {}),
    ...(opts.jsonMode ? { responseMimeType: 'application/json' } : {}),
    thinkingConfig: geminiThinkingConfig(model, opts.thinking || 'none')
  };

  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents,
    generationConfig
  };
  globalThis.CopilotDebug?.log('background.provider.google.request', {
    url,
    model,
    systemPrompt,
    messages,
    body
  });

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
  const text = cand?.content?.parts?.find(part => !part.thought && part.text)?.text ?? '';
  if (cand?.finishReason === 'MAX_TOKENS') {
    console.warn('[BG] Gemini finishReason=MAX_TOKENS — guide output may be incomplete');
  }
  globalThis.CopilotDebug?.log('background.provider.google.response', { status: resp.status, json: d, text });
  return text;
}

// ─── Streaming helpers ────────────────────────────────────────────────────────

function emitStreamChunk(sender, requestId, text) {
  globalThis.CopilotDebug?.log('background.stream.chunk.toContent', {
    requestId,
    text,
    length: typeof text === 'string' ? text.length : null
  });
  const tabId = sender?.tab?.id;
  if (!tabId || !requestId) return;
  chrome.tabs.sendMessage(tabId, {
    type: 'API_STREAM_CHUNK',
    requestId,
    text
  }).catch(() => {});
}

async function readSSEStream(resp, onChunk) {
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop(); // keep incomplete last line
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === 'data: [DONE]') continue;
      if (trimmed.startsWith('data: ')) {
        try {
          const json = JSON.parse(trimmed.slice(6));
          globalThis.CopilotDebug?.log('background.sse.parsed', { line: trimmed, json });
          onChunk(json);
        } catch (err) {
          globalThis.CopilotDebug?.warn('background.sse.parseError', { line: trimmed, error: err.message });
        }
      }
    }
  }
  // flush remaining
  if (buf.trim() && buf.trim() !== 'data: [DONE]' && buf.trim().startsWith('data: ')) {
    try {
      const json = JSON.parse(buf.trim().slice(6));
      globalThis.CopilotDebug?.log('background.sse.parsedFlush', { line: buf.trim(), json });
      onChunk(json);
    } catch (err) {
      globalThis.CopilotDebug?.warn('background.sse.parseFlushError', { line: buf.trim(), error: err.message });
    }
  }
}

async function callOAICompatStream(base, model, apiKey, messages, systemPrompt, opts = {}) {
  const normalizedBase = normalizeOAIBase(base);
  opts.onProgress?.('request_sent', normalizedBase);

  const oaiMessages = messages.map(m => {
    const imgs = m.images?.length ? m.images
               : m.imageBase64   ? [`data:image/jpeg;base64,${m.imageBase64}`]
               : [];
    if (m.role === 'user' && imgs.length) {
      return { role: 'user', content: [
        { type: 'text', text: m.content },
        ...imgs.map(url => ({ type: 'image_url', image_url: { url } }))
      ]};
    }
    return { role: m.role, content: m.content };
  });

  const isOSeries = /^o[0-9]/.test(model);
  const maxTokensKey = isOSeries ? 'max_completion_tokens' : 'max_tokens';
  const body = {
    model,
    messages: [{ role: 'system', content: systemPrompt }, ...oaiMessages],
    stream: true,
    ...(opts.maxTokens ? { [maxTokensKey]: opts.maxTokens } : {}),
    ...(opts.jsonMode ? { response_format: { type: 'json_object' } } : {})
  };
  if (!isOSeries) body.temperature = opts.temperature ?? 0.1;

  const authHeader = apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {};
  globalThis.CopilotDebug?.log('background.provider.oai.stream.request', {
    url: `${normalizedBase}/chat/completions`,
    model,
    systemPrompt,
    messages,
    body
  });
  const resp = await fetch(`${normalizedBase}/chat/completions`, {
    method: 'POST',
    ...(maybeTimeoutSignal(opts.timeoutMs) ? { signal: maybeTimeoutSignal(opts.timeoutMs) } : {}),
    headers: { 'Content-Type': 'application/json', ...authHeader, ...(opts.extraHeaders || {}) },
    body: JSON.stringify(body)
  });
  opts.onProgress?.('provider_responding', String(resp.status));
  if (!resp.ok) throw new Error(`${normalizedBase} → ${resp.status}: ${await resp.text()}`);

  let fullText = '';
  await readSSEStream(resp, chunk => {
    const delta = chunk.choices?.[0]?.delta?.content;
    if (delta) {
      fullText += delta;
      globalThis.CopilotDebug?.log('background.provider.oai.stream.delta', { delta, fullText });
      opts.onChunk?.(delta, fullText);
    }
  });
  globalThis.CopilotDebug?.log('background.provider.oai.stream.complete', { fullText, length: fullText.length });
  return fullText;
}

async function callAnthropicStream(model, apiKey, messages, systemPrompt, opts = {}) {
  opts.onProgress?.('request_sent', 'anthropic');
  const anthropicMessages = messages.map(m => {
    const imgs = m.images?.length ? m.images
               : m.imageBase64   ? [`data:image/jpeg;base64,${m.imageBase64}`]
               : [];
    if (m.role === 'user' && imgs.length) {
      return { role: 'user', content: [
        ...imgs.map(url => {
          const [meta, data] = url.split(',');
          const mimeType = meta.replace('data:', '').replace(';base64', '');
          return { type: 'image', source: { type: 'base64', media_type: mimeType, data } };
        }),
        { type: 'text', text: m.content }
      ]};
    }
    return { role: m.role, content: m.content };
  });

  const body = {
    model,
    max_tokens: opts.maxTokens ?? 8192,
    system: systemPrompt,
    messages: anthropicMessages,
    stream: true,
    temperature: opts.temperature ?? 0.1
  };
  globalThis.CopilotDebug?.log('background.provider.anthropic.stream.request', {
    url: 'https://api.anthropic.com/v1/messages',
    model,
    systemPrompt,
    messages,
    body
  });

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

  let fullText = '';
  await readSSEStream(resp, chunk => {
    // Anthropic stream event types: content_block_delta, message_delta, etc.
    if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') {
      const delta = chunk.delta.text || '';
      if (delta) {
        fullText += delta;
        globalThis.CopilotDebug?.log('background.provider.anthropic.stream.delta', { delta, fullText });
        opts.onChunk?.(delta, fullText);
      }
    }
  });
  globalThis.CopilotDebug?.log('background.provider.anthropic.stream.complete', { fullText, length: fullText.length });
  return fullText;
}

async function callGoogleStream(model, apiKey, messages, systemPrompt, opts = {}) {
  opts.onProgress?.('request_sent', 'google');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?key=${apiKey}&alt=sse`;

  const contents = messages.map(m => {
    const imgs = m.images?.length ? m.images
               : m.imageBase64   ? [`data:image/jpeg;base64,${m.imageBase64}`]
               : [];
    const parts = [
      ...imgs.map(url => {
        const [meta, data] = url.split(',');
        const mimeType = meta.replace('data:', '').replace(';base64', '');
        return { inlineData: { mimeType, data } };
      }),
      { text: m.content }
    ];
    return { role: m.role === 'assistant' ? 'model' : 'user', parts };
  });

  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents,
    generationConfig: {
      temperature: opts.temperature ?? 0.1,
      ...(opts.maxTokens ? { maxOutputTokens: opts.maxTokens } : {}),
      thinkingConfig: geminiThinkingConfig(model, 'none')
    }
  };
  globalThis.CopilotDebug?.log('background.provider.google.stream.request', {
    url,
    model,
    systemPrompt,
    messages,
    body
  });

  const resp = await fetch(url, {
    method: 'POST',
    ...(maybeTimeoutSignal(opts.timeoutMs) ? { signal: maybeTimeoutSignal(opts.timeoutMs) } : {}),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  opts.onProgress?.('provider_responding', String(resp.status));
  if (!resp.ok) throw new Error(`Google → ${resp.status}: ${await resp.text()}`);

  let fullText = '';
  await readSSEStream(resp, chunk => {
    const text = chunk.candidates?.[0]?.content?.parts?.[0]?.text;
    if (text) {
      fullText += text;
      globalThis.CopilotDebug?.log('background.provider.google.stream.delta', { delta: text, fullText });
      opts.onChunk?.(text, fullText);
    }
  });
  globalThis.CopilotDebug?.log('background.provider.google.stream.complete', { fullText, length: fullText.length });
  return fullText;
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

async function callAIStream(provider, model, apiKey, messages, systemPrompt, opts = {}) {
  let cfg = PROVIDER_MAP[provider];
  if (!cfg && String(provider || '').startsWith('local_')) cfg = { type: 'local' };
  if (!cfg) throw new Error(`Unknown provider: ${provider}`);

  switch (cfg.type) {
    case 'anthropic':    return callAnthropicStream(model, apiKey, messages, systemPrompt, opts);
    case 'google':       return callGoogleStream(model, apiKey, messages, systemPrompt, opts);
    case 'openai_compat':return callOAICompatStream(cfg.base, model, apiKey, messages, systemPrompt, opts);
    case 'local':        return callOAICompatStream(opts.localBase, model, null, messages, systemPrompt, opts);
    // Fallback: non-streaming for unsupported provider types
    default:             return callAI(provider, model, apiKey, messages, systemPrompt, opts);
  }
}

// parseGuideResponse loaded from lib/guide-parse.js (shared with Jest tests).

// ─── Single message handler for ALL operations ──────────────────────────────
// sendMessage + return true keeps the service worker alive until sendResponse
// is called (up to Chrome's 5-minute hard limit — plenty for any API call).

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  globalThis.CopilotDebug?.log('background.onMessage', {
    type: message?.type,
    requestId: message?._copilotRequestId,
    message
  });

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
  handleMessage(message, progress, sender, requestId).then(
    result => {
      globalThis.CopilotDebug?.log('background.onMessage.success', {
        requestId,
        type: message?.type,
        result
      });
      sendResponse({ success: true, data: result });
    },
    err => {
      globalThis.CopilotDebug?.error('background.onMessage.error', {
        requestId,
        type: message?.type,
        error: err?.message || String(err),
        stack: err?.stack
      });
      sendResponse({ success: false, error: err.message });
    }
  );
  return true;
});

async function handleMessage(msg, progress = () => {}, sender = null, requestId = null) {
  if (msg.type === 'PING') return 'pong';

  const { type, provider, apiKey, localBase } = msg;
  const model = msg.model || DEFAULT_MODELS[provider];
  debugRequestMeta(type, requestId, provider, model, msg);
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
      const useStream   = !!msg.useStream;
      const maxGuideTokens = guideMaxTokensFor(provider, model, msg.guideMaxTokens);

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
        provider,
        temperature: guideTemp,
        maxTokens: maxGuideTokens,
        timeoutMs: null,
        jsonMode: true,
        onProgress: progress,
        thinking: guideThinking,
        ...(useStream ? { onChunk: (delta) => emitStreamChunk(sender, requestId, delta) } : {})
      };

      let raw;
      try {
        raw = useStream
          ? await callAIStream(provider, model, apiKey,
              [{ role: 'user', content: transcriptText }], systemPrompt, opts)
          : await callAI(provider, model, apiKey,
              [{ role: 'user', content: transcriptText }], systemPrompt, opts);
      } catch (err) {
        const reportedMax = providerReportedMaxTokens(err);
        if (!reportedMax || reportedMax >= opts.maxTokens) throw err;
        const retryTokens = guideMaxTokensFor(provider, model, reportedMax);
        if (retryTokens >= opts.maxTokens) throw err;
        progress('queued', `Retrying with provider max output ${retryTokens}`);
        raw = useStream
          ? await callAIStream(provider, model, apiKey,
              [{ role: 'user', content: transcriptText }], systemPrompt, { ...opts, maxTokens: retryTokens })
          : await callAI(provider, model, apiKey,
              [{ role: 'user', content: transcriptText }], systemPrompt, { ...opts, maxTokens: retryTokens });
      }
      progress('provider_finished', 'Response body received');
      debugRawResponse(type, requestId, raw);
      try {
        const parsed = parseGuideResponse(raw);
        debugParsedResponse(type, requestId, parsed);
        return parsed;
      } catch (err) {
        globalThis.CopilotDebug?.error('background.parse.guide.error', {
          requestId,
          type,
          error: err?.message || String(err),
          raw
        });
        throw err;
      }
    }

    case 'CHAT': {
      const { messages, systemPrompt } = msg;
      const chatTemp = msg.chatTemperature ?? 0.35;
      const chatThinking = msg.chatThinking || 'none';
      const chatStream = !!msg.useStream;
      const chatOpts = {
        ...baseOpts,
        provider,
        temperature: chatTemp,
        timeoutMs: 120000,
        thinking: chatThinking,
        ...(chatStream ? { onChunk: (delta) => emitStreamChunk(sender, requestId, delta) } : {})
      };
      const raw = chatStream
        ? await callAIStream(provider, model, apiKey, messages, systemPrompt, chatOpts)
        : await callAI(provider, model, apiKey, messages, systemPrompt, chatOpts);
      debugRawResponse(type, requestId, raw);
      return raw;
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

    case 'FLASHCARDS_REQUEST': {
      const { guideJson, systemPrompt } = msg;
      const maxTok = outputTokensFor(provider, model, 8192);
      const raw = await callAI(provider, model, apiKey,
        [{ role: 'user', content: JSON.stringify(guideJson) }],
        systemPrompt,
        { ...baseOpts, provider, temperature: 0.45, maxTokens: maxTok, timeoutMs: 120000, jsonMode: true }
      );
      debugRawResponse(type, requestId, raw);
      const parsed = safeParseJson(raw, { type, requestId });
      debugParsedResponse(type, requestId, parsed);
      return parsed;
    }

    case 'QUIZ_REQUEST': {
      const { guideJson, systemPrompt } = msg;
      const maxTok = outputTokensFor(provider, model, 10000);
      const raw = await callAI(provider, model, apiKey,
        [{ role: 'user', content: JSON.stringify(guideJson) }],
        systemPrompt,
        { ...baseOpts, provider, temperature: 0.45, maxTokens: maxTok, timeoutMs: 120000, jsonMode: true }
      );
      debugRawResponse(type, requestId, raw);
      const parsed = safeParseJson(raw, { type, requestId });
      debugParsedResponse(type, requestId, parsed);
      return parsed;
    }

    case 'EXAM_QUESTIONS_REQUEST': {
      const { guideJson, systemPrompt } = msg;
      const maxTok = outputTokensFor(provider, model, 12000);
      const raw = await callAI(provider, model, apiKey,
        [{ role: 'user', content: JSON.stringify(guideJson) }],
        systemPrompt,
        { ...baseOpts, provider, temperature: 0.5, maxTokens: maxTok, timeoutMs: 120000, jsonMode: true }
      );
      debugRawResponse(type, requestId, raw);
      const parsed = safeParseJson(raw, { type, requestId });
      debugParsedResponse(type, requestId, parsed);
      return parsed;
    }

    case 'CROSS_LECTURE_EXAM_REQUEST': {
      const { guidesJson, systemPrompt } = msg;
      const maxTok = outputTokensFor(provider, model, 16000);
      const raw = await callAI(provider, model, apiKey,
        [{ role: 'user', content: JSON.stringify(guidesJson) }],
        systemPrompt,
        { ...baseOpts, provider, temperature: 0.5, maxTokens: maxTok, timeoutMs: 180000, jsonMode: true }
      );
      debugRawResponse(type, requestId, raw);
      const parsed = safeParseJson(raw, { type, requestId });
      debugParsedResponse(type, requestId, parsed);
      return parsed;
    }

    default:
      throw new Error(`Unknown message type: ${type}`);
  }
}

function safeParseJson(raw, debugMeta = {}) {
  if (typeof raw === 'object' && raw !== null) return raw;
  const s = String(raw || '');
  globalThis.CopilotDebug?.log('background.safeParseJson.attempt', { ...debugMeta, phase: 'raw', raw: s });
  try { return JSON.parse(s); } catch (err) {
    globalThis.CopilotDebug?.warn('background.safeParseJson.failed', { ...debugMeta, phase: 'raw', error: err.message, raw: s });
  }
  // Strip markdown fences
  const stripped = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  globalThis.CopilotDebug?.log('background.safeParseJson.attempt', { ...debugMeta, phase: 'stripped', raw: stripped });
  try { return JSON.parse(stripped); } catch (err) {
    globalThis.CopilotDebug?.warn('background.safeParseJson.failed', { ...debugMeta, phase: 'stripped', error: err.message, raw: stripped });
  }
  // Find the first { or [ and try from there
  const start = Math.min(
    s.indexOf('{') >= 0 ? s.indexOf('{') : Infinity,
    s.indexOf('[') >= 0 ? s.indexOf('[') : Infinity
  );
  if (start < Infinity) {
    const sliced = s.slice(start);
    globalThis.CopilotDebug?.log('background.safeParseJson.attempt', { ...debugMeta, phase: 'sliced', raw: sliced });
    try { return JSON.parse(sliced); } catch (err) {
      globalThis.CopilotDebug?.warn('background.safeParseJson.failed', { ...debugMeta, phase: 'sliced', error: err.message, raw: sliced });
    }
  }
  globalThis.CopilotDebug?.error('background.safeParseJson.giveUp', { ...debugMeta, raw: s });
  throw new Error('Failed to parse JSON from AI response: ' + s.slice(0, 200));
}
