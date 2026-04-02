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
  anthropic:   { type: 'anthropic',    base: 'https://api.anthropic.com' },
  openai:      { type: 'openai_compat',base: 'https://api.openai.com/v1' },
  google:      { type: 'google',       base: 'https://generativelanguage.googleapis.com' },
  xai:         { type: 'openai_compat',base: 'https://api.x.ai/v1' },
  deepseek:    { type: 'openai_compat',base: 'https://api.deepseek.com/v1' },
  mistral:     { type: 'openai_compat',base: 'https://api.mistral.ai/v1' },
  openrouter:  { type: 'openai_compat',base: 'https://openrouter.ai/api/v1' },
  groq:        { type: 'openai_compat',base: 'https://api.groq.com/openai/v1' },
  together:    { type: 'openai_compat',base: 'https://api.together.xyz/v1' },
  cerebras:    { type: 'openai_compat',base: 'https://api.cerebras.ai/v1' }
};

// Default model per provider — first/best model in the list
const DEFAULT_MODELS = {
  anthropic:  'claude-sonnet-4-6',
  openai:     'gpt-5.4-mini',
  google:     'gemini-3-flash',
  xai:        'grok-4',
  deepseek:   'deepseek-v4',
  mistral:    'mistral-large-latest',
  openrouter: 'anthropic/claude-sonnet-4-6',
  groq:       'llama-4-maverick-17b-128e-instruct',
  together:   'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8',
  cerebras:   'llama-4-scout-17b-16e-instruct'
};

// ─── OpenAI-compatible handler (covers ~80% of providers) ────────────────────

async function callOAICompat(base, model, apiKey, messages, systemPrompt, opts = {}) {
  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      ...messages
    ],
    temperature: opts.temperature ?? 0.4,
    ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
    ...(opts.jsonMode ? { response_format: { type: 'json_object' } } : {})
  };

  const resp = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      ...(opts.extraHeaders || {})
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) throw new Error(`${base} → ${resp.status}: ${await resp.text()}`);
  const d = await resp.json();
  return d.choices?.[0]?.message?.content ?? '';
}

// ─── Anthropic handler ────────────────────────────────────────────────────────

async function callAnthropic(model, apiKey, messages, systemPrompt, opts = {}) {
  // Convert messages: image attachments handled inline
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

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model,
      max_tokens: opts.maxTokens ?? 8192,
      temperature: opts.temperature ?? 0.4,
      system: systemPrompt,
      messages: anthropicMessages
    })
  });

  if (!resp.ok) throw new Error(`Anthropic → ${resp.status}: ${await resp.text()}`);
  const d = await resp.json();
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

  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents,
    generationConfig: {
      temperature: opts.temperature ?? 0.4,
      ...(opts.maxTokens ? { maxOutputTokens: opts.maxTokens } : {})
    }
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!resp.ok) throw new Error(`Google → ${resp.status}: ${await resp.text()}`);
  const d = await resp.json();
  return d.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
}

// ─── Unified call dispatcher ──────────────────────────────────────────────────

async function callAI(provider, model, apiKey, messages, systemPrompt, opts = {}) {
  const cfg = PROVIDER_MAP[provider];
  if (!cfg) throw new Error(`Unknown provider: ${provider}`);

  switch (cfg.type) {
    case 'anthropic':    return callAnthropic(model, apiKey, messages, systemPrompt, opts);
    case 'google':       return callGoogle(model, apiKey, messages, systemPrompt, opts);
    case 'openai_compat':return callOAICompat(cfg.base, model, apiKey, messages, systemPrompt, opts);
    default: throw new Error(`Unknown provider type: ${cfg.type}`);
  }
}

// ─── Guide JSON parser ────────────────────────────────────────────────────────

function parseGuideResponse(raw) {
  let text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  const start = text.indexOf('{');
  if (start === -1) throw new Error('No JSON object found in response');
  text = text.slice(start);
  return JSON.parse(text);
}

// ─── Message handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message).then(
    result => sendResponse({ success: true, data: result }),
    err    => sendResponse({ success: false, error: err.message })
  );
  return true; // keep channel open for async response
});

async function handleMessage(msg) {
  const { type, provider, apiKey, imageBase64 } = msg;
  const model = msg.model || DEFAULT_MODELS[provider];

  switch (type) {

    case 'GENERATE_GUIDE': {
      const { transcriptText, systemPrompt } = msg;

      let raw;
      try {
        raw = await callAI(provider, model, apiKey,
          [{ role: 'user', content: transcriptText }],
          systemPrompt,
          { temperature: 0.1, maxTokens: 8192 }
        );
      } catch (e) {
        throw new Error(`Guide generation failed: ${e.message}`);
      }

      // Parse — retry once with stricter prompt if it fails
      let guide;
      try {
        guide = parseGuideResponse(raw);
      } catch (_) {
        raw = await callAI(provider, model, apiKey,
          [{ role: 'user', content: transcriptText }],
          systemPrompt + '\n\nCRITICAL: Return ONLY the raw JSON object. No markdown, no explanation.',
          { temperature: 0.1, maxTokens: 8192 }
        );
        guide = parseGuideResponse(raw);
      }

      return guide;
    }

    case 'CHAT': {
      const { messages, systemPrompt } = msg;
      return callAI(provider, model, apiKey, messages, systemPrompt,
        { temperature: 0.4, imageBase64 }
      );
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
