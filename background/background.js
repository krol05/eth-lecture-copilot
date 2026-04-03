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

// ─── Provider config (must match lib/providers-config.js) ────────────────────
// Inlined here because service workers can't import arbitrary files in MV3.

const PROVIDER_MAP = {
  anthropic:       { type: 'anthropic',    base: 'https://api.anthropic.com' },
  openai:          { type: 'openai_compat',base: 'https://api.openai.com/v1' },
  google:          { type: 'google',       base: 'https://generativelanguage.googleapis.com' },
  xai:             { type: 'openai_compat',base: 'https://api.x.ai/v1' },
  deepseek:        { type: 'openai_compat',base: 'https://api.deepseek.com/v1' },
  mistral:         { type: 'openai_compat',base: 'https://api.mistral.ai/v1' },
  openrouter:      { type: 'openai_compat',base: 'https://openrouter.ai/api/v1' },
  groq:            { type: 'openai_compat',base: 'https://api.groq.com/openai/v1' },
  together:        { type: 'openai_compat',base: 'https://api.together.xyz/v1' },
  cerebras:        { type: 'openai_compat',base: 'https://api.cerebras.ai/v1' },
  // Local providers — base URL comes from message payload (user-configurable)
  local_ollama:    { type: 'local' },
  local_litellm:   { type: 'local' },
  local_lmstudio:  { type: 'local' },
  local_jan:       { type: 'local' },
  local_localai:   { type: 'local' },
  local_llamafile:  { type: 'local' },
  local_custom:    { type: 'local' }
};

// Default model per provider — first/best model in the list
const DEFAULT_MODELS = {
  anthropic:  'claude-sonnet-4-6',
  openai:     'gpt-4o',
  google:     'gemini-2.5-flash',
  xai:        'grok-4',
  deepseek:   'deepseek-chat',
  mistral:    'mistral-large-latest',
  openrouter: 'anthropic/claude-sonnet-4-6',
  groq:       'meta-llama/llama-4-maverick-17b-128e-instruct',
  together:   'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8',
  cerebras:   'llama-4-scout-17b-16e-instruct'
};

// ─── OpenAI-compatible handler (covers ~80% of providers) ────────────────────

function normalizeOAIBase(base) {
  const raw = String(base || '').trim();
  if (!raw) throw new Error('Missing OpenAI-compatible base URL');
  return raw.replace(/\/+$/, '');
}

async function callOAICompat(base, model, apiKey, messages, systemPrompt, opts = {}) {
  const normalizedBase = normalizeOAIBase(base);
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

  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      ...oaiMessages
    ],
    ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
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
    signal: AbortSignal.timeout(opts.timeoutMs ?? 120000),
    headers: {
      'Content-Type': 'application/json',
      ...authHeader,
      ...(opts.extraHeaders || {})
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) throw new Error(`${normalizedBase} → ${resp.status}: ${await resp.text()}`);
  const d = await resp.json();
  return d.choices?.[0]?.message?.content ?? '';
}

// ─── Anthropic handler ────────────────────────────────────────────────────────

async function callAnthropic(model, apiKey, messages, systemPrompt, opts = {}) {
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
    body.thinking = { type: 'enabled', budget_tokens: budgetTokens };
    body.max_tokens = Math.max(body.max_tokens, budgetTokens + 16000);
    body.temperature = 1;
  } else {
    body.temperature = opts.temperature ?? 0.4;
  }

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal: AbortSignal.timeout(opts.timeoutMs ?? 120000),
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body)
  });

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
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const contents = messages.map(m => {
    const parts = [{ text: m.content }];
    if (m.imageBase64) {
      parts.push({ inlineData: { mimeType: 'image/jpeg', data: m.imageBase64 } });
    }
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
    generationConfig.thinkingConfig = {
      thinkingBudget: thinkingBudgets[thinking]
    };
  }

  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents,
    generationConfig
  };

  const resp = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(opts.timeoutMs ?? 120000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

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

// ─── Guide JSON parser ────────────────────────────────────────────────────────
// Multi-strategy: try simplest approach first, progressively more aggressive.

function parseGuideResponse(raw) {
  let text = String(raw || '').trim();

  // Strip markdown fences
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');

  // Find the JSON object
  const start = text.indexOf('{');
  if (start === -1) throw new Error('No JSON object found in response');
  text = text.slice(start);

  // Strip non-printable chars (keep newlines/tabs — they're valid in JSON)
  text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

  // Strategy 1: direct parse (works if model output valid JSON)
  try { return JSON.parse(text); } catch (_) {}

  // Strategy 2: trim to complete JSON object, then parse
  const end = findMatchingBrace(text);
  if (end !== -1) {
    const complete = text.slice(0, end + 1);
    try { return JSON.parse(complete); } catch (_) {}
    // 2b: remove trailing commas and retry
    const cleaned = complete.replace(/,\s*([}\]])/g, '$1');
    try { return JSON.parse(cleaned); } catch (_) {}
  }

  // Strategy 3: fix escape issues (LaTeX backslashes, raw newlines in strings)
  const fixed = fixEscapes(text);
  try { return JSON.parse(fixed); } catch (_) {}

  // Strategy 4: truncated response — close open structures
  const salvaged = salvageTruncated(fixed);
  if (salvaged) return salvaged;

  // Strategy 5: last resort — salvage the unfixed text
  const salvaged2 = salvageTruncated(text);
  if (salvaged2) return salvaged2;

  throw new Error('Could not parse the guide. Try a different model or paste the transcript manually.');
}

function fixEscapes(text) {
  // Fix invalid escape sequences and raw control chars inside JSON strings.
  // Tracks string state carefully.
  const VALID_ESC = '"\\\/bfnrtu';
  let out = '';
  let inStr = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (!inStr) {
      if (c === '"') inStr = true;
      out += c; i++; continue;
    }
    // Inside string
    if (c === '\\') {
      const nx = text[i + 1];
      if (nx === undefined) { out += '\\\\'; i++; continue; }
      if (VALID_ESC.includes(nx)) { out += c + nx; i += 2; continue; }
      // Invalid escape like \frac → \\frac
      out += '\\\\'; i++; continue;
    }
    if (c === '"')  { inStr = false; out += c; i++; continue; }
    if (c === '\n') { out += '\\n'; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\t') { out += '\\t'; i++; continue; }
    out += c; i++;
  }
  out = out.replace(/,\s*([}\]])/g, '$1');
  return out;
}

function salvageTruncated(text) {
  // Close all open JSON structures so a truncated response can still parse.
  try {
    let s = text;
    // Walk to find open/close balance
    let inStr = false, esc = false, braces = 0, brackets = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (esc) { esc = false; continue; }
      if (c === '\\' && inStr) { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === '{') braces++;
      else if (c === '}') braces--;
      else if (c === '[') brackets++;
      else if (c === ']') brackets--;
    }
    // If still inside a string, close it
    if (inStr) s += '"';
    // Strip trailing partial value (comma, colon, key without value)
    s = s.replace(/,\s*"[^"]*"?\s*$/, '');
    s = s.replace(/,\s*$/, '');
    s = s.replace(/:\s*$/, ': null');
    while (brackets > 0) { s += ']'; brackets--; }
    while (braces > 0) { s += '}'; braces--; }
    return JSON.parse(s);
  } catch (_) {
    return null;
  }
}

function findMatchingBrace(str) {
  let depth = 0, inStr = false, esc = false;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (esc) { esc = false; continue; }
    if (c === '\\' && inStr) { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    if (c === '}' && --depth === 0) return i;
  }
  return -1;
}

// ─── Single message handler for ALL operations ──────────────────────────────
// sendMessage + return true keeps the service worker alive until sendResponse
// is called (up to Chrome's 5-minute hard limit — plenty for any API call).

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[BG] onMessage:', message?.type);

  if (message?.type === 'CAPTURE_VISIBLE_TAB') {
    const wid = sender?.tab?.windowId ?? null;
    chrome.tabs.captureVisibleTab(wid, { format: 'jpeg', quality: 85 })
      .then(dataUrl => sendResponse({ success: true, data: dataUrl }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  handleMessage(message).then(
    result => sendResponse({ success: true, data: result }),
    err    => sendResponse({ success: false, error: err.message })
  );
  return true;
});

async function handleMessage(msg) {
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
        timeoutMs: 180000,
        jsonMode: true,
        thinking: guideThinking
      };

      const raw = await callAI(provider, model, apiKey,
        [{ role: 'user', content: transcriptText }], systemPrompt, opts);

      return parseGuideResponse(raw);
    }

    case 'CHAT': {
      const { messages, systemPrompt } = msg;
      const chatTemp = msg.chatTemperature ?? 0.35;
      return callAI(provider, model, apiKey, messages, systemPrompt,
        { ...baseOpts, temperature: chatTemp, timeoutMs: 120000 });
    }

    case 'FETCH_VTT': {
      const resp = await fetch(msg.url);
      if (!resp.ok) throw new Error(`VTT fetch failed: ${resp.status}`);
      return resp.text();
    }

    case 'FETCH_JSON': {
      const resp = await fetch(msg.url);
      if (!resp.ok) throw new Error(`JSON fetch failed: ${resp.status}`);
      return resp.json();
    }

    default:
      throw new Error(`Unknown message type: ${type}`);
  }
}
