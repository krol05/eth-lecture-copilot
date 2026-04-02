/**
 * providers.js
 * Multi-provider AI API abstraction layer.
 * Supports: Google Gemini, Anthropic Claude, OpenAI GPT.
 *
 * All providers expose the same two functions:
 *   generateGuide(transcriptText, systemPrompt, model, apiKey) → string (raw JSON)
 *   chat(messages, systemPrompt, model, apiKey, imageBase64?) → string (assistant reply)
 */

// ─── Model Lists ────────────────────────────────────────────────────────────

const MODELS = {
  gemini: [
    { id: 'gemini-2.5-pro-preview-05-06', label: 'Gemini 2.5 Pro' },
    { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
    { id: 'gemini-1.5-pro-latest', label: 'Gemini 1.5 Pro' },
    { id: 'gemini-1.5-flash-latest', label: 'Gemini 1.5 Flash' }
  ],
  claude: [
    { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
    { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
    { id: 'claude-opus-4-6', label: 'Claude Opus 4.6' }
  ],
  openai: [
    { id: 'gpt-4o', label: 'GPT-4o' },
    { id: 'gpt-4o-mini', label: 'GPT-4o mini' },
    { id: 'o4-mini', label: 'o4-mini' }
  ]
};

// ─── Gemini ──────────────────────────────────────────────────────────────────

async function geminiGenerateGuide(transcriptText, systemPrompt, model, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const body = {
    contents: [
      {
        role: 'user',
        parts: [{ text: systemPrompt + '\n\n' + transcriptText }]
      }
    ],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: 'application/json'
    }
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Gemini API error ${resp.status}: ${err}`);
  }

  const data = await resp.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
}

async function geminiChat(messages, systemPrompt, model, apiKey, imageBase64) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: m.imageBase64
      ? [{ text: m.content }, { inlineData: { mimeType: 'image/jpeg', data: m.imageBase64 } }]
      : [{ text: m.content }]
  }));

  // Add image to the last user message if provided
  if (imageBase64 && contents.length > 0) {
    const last = contents[contents.length - 1];
    if (last.role === 'user') {
      last.parts.push({ inlineData: { mimeType: 'image/jpeg', data: imageBase64 } });
    }
  }

  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents,
    generationConfig: { temperature: 0.4 }
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Gemini API error ${resp.status}: ${err}`);
  }

  const data = await resp.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
}

// ─── Anthropic Claude ────────────────────────────────────────────────────────

async function claudeGenerateGuide(transcriptText, systemPrompt, model, apiKey) {
  const body = {
    model,
    max_tokens: 16000,
    temperature: 0.1,
    system: systemPrompt,
    messages: [
      { role: 'user', content: transcriptText }
    ]
  };

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Claude API error ${resp.status}: ${err}`);
  }

  const data = await resp.json();
  return data.content?.[0]?.text ?? '';
}

async function claudeChat(messages, systemPrompt, model, apiKey, imageBase64) {
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

  // Attach image to last user message if provided separately
  if (imageBase64 && anthropicMessages.length > 0) {
    const last = anthropicMessages[anthropicMessages.length - 1];
    if (last.role === 'user' && typeof last.content === 'string') {
      last.content = [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
        { type: 'text', text: last.content }
      ];
    }
  }

  const body = {
    model,
    max_tokens: 4096,
    temperature: 0.4,
    system: systemPrompt,
    messages: anthropicMessages
  };

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Claude API error ${resp.status}: ${err}`);
  }

  const data = await resp.json();
  return data.content?.[0]?.text ?? '';
}

// ─── OpenAI ──────────────────────────────────────────────────────────────────

async function openaiGenerateGuide(transcriptText, systemPrompt, model, apiKey) {
  const body = {
    model,
    temperature: 0.1,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: transcriptText }
    ]
  };

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`OpenAI API error ${resp.status}: ${err}`);
  }

  const data = await resp.json();
  return data.choices?.[0]?.message?.content ?? '';
}

async function openaiChat(messages, systemPrompt, model, apiKey, imageBase64) {
  const oaiMessages = [{ role: 'system', content: systemPrompt }];

  for (const m of messages) {
    if (m.role === 'user' && m.imageBase64) {
      oaiMessages.push({
        role: 'user',
        content: [
          { type: 'text', text: m.content },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${m.imageBase64}`, detail: 'low' } }
        ]
      });
    } else {
      oaiMessages.push({ role: m.role, content: m.content });
    }
  }

  // Attach image to last user message if provided separately
  if (imageBase64 && oaiMessages.length > 0) {
    const last = oaiMessages[oaiMessages.length - 1];
    if (last.role === 'user' && typeof last.content === 'string') {
      last.content = [
        { type: 'text', text: last.content },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}`, detail: 'low' } }
      ];
    }
  }

  const body = {
    model,
    temperature: 0.4,
    messages: oaiMessages
  };

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`OpenAI API error ${resp.status}: ${err}`);
  }

  const data = await resp.json();
  return data.choices?.[0]?.message?.content ?? '';
}

// ─── Unified Interface ───────────────────────────────────────────────────────

/**
 * Generate a lecture guide from a transcript.
 * Returns the raw response string (JSON).
 *
 * @param {string} transcriptText
 * @param {string} systemPrompt
 * @param {string} provider  — 'gemini' | 'claude' | 'openai'
 * @param {string} model
 * @param {string} apiKey
 * @returns {Promise<string>}
 */
async function generateGuide(transcriptText, systemPrompt, provider, model, apiKey) {
  switch (provider) {
    case 'gemini': return geminiGenerateGuide(transcriptText, systemPrompt, model, apiKey);
    case 'claude': return claudeGenerateGuide(transcriptText, systemPrompt, model, apiKey);
    case 'openai': return openaiGenerateGuide(transcriptText, systemPrompt, model, apiKey);
    default: throw new Error(`Unknown provider: ${provider}`);
  }
}

/**
 * Send a chat message and get a response.
 *
 * @param {Array<{role: string, content: string, imageBase64?: string}>} messages
 * @param {string} systemPrompt
 * @param {string} provider
 * @param {string} model
 * @param {string} apiKey
 * @param {string|null} imageBase64 — optional frame capture for current message
 * @returns {Promise<string>}
 */
async function chat(messages, systemPrompt, provider, model, apiKey, imageBase64 = null) {
  switch (provider) {
    case 'gemini': return geminiChat(messages, systemPrompt, model, apiKey, imageBase64);
    case 'claude': return claudeChat(messages, systemPrompt, model, apiKey, imageBase64);
    case 'openai': return openaiChat(messages, systemPrompt, model, apiKey, imageBase64);
    default: throw new Error(`Unknown provider: ${provider}`);
  }
}

if (typeof module !== 'undefined') {
  module.exports = { generateGuide, chat, MODELS };
}
