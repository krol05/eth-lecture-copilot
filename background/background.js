/**
 * background.js — Service Worker
 *
 * Handles all cross-origin API calls from the content script via message passing.
 * Content scripts cannot make cross-origin requests to AI APIs directly.
 *
 * Message protocol:
 *   { type: 'GENERATE_GUIDE', transcriptText, systemPrompt, provider, model, apiKey }
 *   { type: 'CHAT', messages, systemPrompt, provider, model, apiKey, imageBase64? }
 *   { type: 'FETCH_VTT', url }
 *
 * Responds with: { success: true, data: ... } or { success: false, error: string }
 */

// Default model per provider — best current option as of 2025
// Users don't select a model; the extension always uses the best one.
const DEFAULT_MODELS = {
  gemini: 'gemini-2.5-flash',        // 1M context, fast, cheap, best for long transcripts
  claude: 'claude-sonnet-4-5',       // 200k context, excellent instruction following
  openai: 'gpt-4.1-mini'            // 1M context, fast, cost-efficient
};

// ─── API Helpers ─────────────────────────────────────────────────────────────

async function callGeminiGuide(transcriptText, systemPrompt, model, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: systemPrompt + '\n\n' + transcriptText }] }],
      generationConfig: { temperature: 0.1 }
    })
  });
  if (!resp.ok) throw new Error(`Gemini ${resp.status}: ${await resp.text()}`);
  const d = await resp.json();
  return d.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
}

async function callClaudeGuide(transcriptText, systemPrompt, model, apiKey) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model, max_tokens: 8192, temperature: 0.1,
      system: systemPrompt,
      messages: [{ role: 'user', content: transcriptText }]
    })
  });
  if (!resp.ok) throw new Error(`Claude ${resp.status}: ${await resp.text()}`);
  const d = await resp.json();
  return d.content?.[0]?.text ?? '';
}

async function callOpenAIGuide(transcriptText, systemPrompt, model, apiKey) {
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model, temperature: 0.1, max_tokens: 8192,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: transcriptText }
      ]
    })
  });
  if (!resp.ok) throw new Error(`OpenAI ${resp.status}: ${await resp.text()}`);
  const d = await resp.json();
  return d.choices?.[0]?.message?.content ?? '';
}

async function callGeminiChat(messages, systemPrompt, model, apiKey, imageBase64) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }]
  }));
  if (imageBase64 && contents.length > 0) {
    const last = contents[contents.length - 1];
    if (last.role === 'user') {
      last.parts.push({ inlineData: { mimeType: 'image/jpeg', data: imageBase64 } });
    }
  }
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents,
      generationConfig: { temperature: 0.4 }
    })
  });
  if (!resp.ok) throw new Error(`Gemini ${resp.status}: ${await resp.text()}`);
  const d = await resp.json();
  return d.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
}

async function callClaudeChat(messages, systemPrompt, model, apiKey, imageBase64) {
  const anthropicMessages = messages.map(m => ({ role: m.role, content: m.content }));
  if (imageBase64 && anthropicMessages.length > 0) {
    const last = anthropicMessages[anthropicMessages.length - 1];
    if (last.role === 'user') {
      last.content = [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
        { type: 'text', text: last.content }
      ];
    }
  }
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({ model, max_tokens: 4096, temperature: 0.4, system: systemPrompt, messages: anthropicMessages })
  });
  if (!resp.ok) throw new Error(`Claude ${resp.status}: ${await resp.text()}`);
  const d = await resp.json();
  return d.content?.[0]?.text ?? '';
}

async function callOpenAIChat(messages, systemPrompt, model, apiKey, imageBase64) {
  const oaiMessages = [{ role: 'system', content: systemPrompt }];
  for (const m of messages) {
    oaiMessages.push({ role: m.role, content: m.content });
  }
  if (imageBase64 && oaiMessages.length > 0) {
    const last = oaiMessages[oaiMessages.length - 1];
    if (last.role === 'user' && typeof last.content === 'string') {
      last.content = [
        { type: 'text', text: last.content },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}`, detail: 'low' } }
      ];
    }
  }
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model, temperature: 0.4, messages: oaiMessages })
  });
  if (!resp.ok) throw new Error(`OpenAI ${resp.status}: ${await resp.text()}`);
  const d = await resp.json();
  return d.choices?.[0]?.message?.content ?? '';
}

// ─── Guide JSON parser (duplicated from schema.js for SW context) ─────────────

function parseGuideResponse(raw) {
  let text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  const start = text.indexOf('{');
  if (start === -1) throw new Error('No JSON found');
  text = text.slice(start);
  return JSON.parse(text);
}

// ─── Message Handler ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message).then(
    result => sendResponse({ success: true, data: result }),
    err => sendResponse({ success: false, error: err.message })
  );
  return true; // keep channel open for async response
});

async function handleMessage(message) {
  const { type, provider, apiKey } = message;
  const model = message.model || DEFAULT_MODELS[provider];

  switch (type) {

    case 'GENERATE_GUIDE': {
      const { transcriptText, systemPrompt } = message;
      let rawResponse;

      // First attempt
      try {
        rawResponse = await callGuide(provider, transcriptText, systemPrompt, model, apiKey);
      } catch (e) {
        throw new Error(`Guide generation failed: ${e.message}`);
      }

      // Try to parse; if it fails, retry once with stricter instruction
      let guide;
      try {
        guide = parseGuideResponse(rawResponse);
      } catch (_) {
        const stricterPrompt = systemPrompt + '\n\nCRITICAL: Your previous response could not be parsed as JSON. Return ONLY the raw JSON object, absolutely nothing else.';
        rawResponse = await callGuide(provider, transcriptText, stricterPrompt, model, apiKey);
        guide = parseGuideResponse(rawResponse);
      }

      return guide;
    }

    case 'CHAT': {
      const { messages, systemPrompt, imageBase64 } = message;
      let text;
      switch (provider) {
        case 'gemini': text = await callGeminiChat(messages, systemPrompt, model, apiKey, imageBase64); break;
        case 'claude': text = await callClaudeChat(messages, systemPrompt, model, apiKey, imageBase64); break;
        case 'openai': text = await callOpenAIChat(messages, systemPrompt, model, apiKey, imageBase64); break;
        default: throw new Error(`Unknown provider: ${provider}`);
      }
      return text;
    }

    case 'FETCH_VTT': {
      const { url } = message;
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`VTT fetch failed: ${resp.status}`);
      return await resp.text();
    }

    case 'FETCH_JSON': {
      const { url } = message;
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`JSON fetch failed: ${resp.status}`);
      return await resp.json();
    }

    default:
      throw new Error(`Unknown message type: ${type}`);
  }
}

async function callGuide(provider, transcriptText, systemPrompt, model, apiKey) {
  switch (provider) {
    case 'gemini': return callGeminiGuide(transcriptText, systemPrompt, model, apiKey);
    case 'claude': return callClaudeGuide(transcriptText, systemPrompt, model, apiKey);
    case 'openai': return callOpenAIGuide(transcriptText, systemPrompt, model, apiKey);
    default: throw new Error(`Unknown provider: ${provider}`);
  }
}
