/**
 * lib/providers/adapters.js
 * The three wire-format adapters: 'anthropic', 'google', 'oai'.
 * Pure functions — no fetch, no chrome.*, fully unit-testable. The background
 * service worker owns networking, timeouts and aborts; adapters own shapes.
 *
 * Ground truth: docs/providers/*.md (official docs, retrieved 2026-08-23).
 *
 * Adapter interface:
 *   buildRequest(req)         → { url, headers, body }   (body = plain object)
 *   parseResponse(json)       → { text, stopReason?, usage?, error? }
 *   parseSSEEvent(json)       → { textDelta?, stopReason?, usage?, error?, done? }
 *   buildModelsRequest(req)   → { url, headers } | null  (null = unsupported)
 *   parseModelsResponse(json) → [{ id, label }]
 *
 * req = {
 *   base          provider base URL (no trailing slash)
 *   model         model ID
 *   apiKey        may be null/undefined for local providers
 *   system        system prompt string
 *   messages      [{role: 'user'|'assistant', content, images?: [dataUrl], imageBase64?}]
 *   stream        boolean — ONE builder per adapter handles both (kills drift)
 *   jsonMode      boolean — best-effort JSON output
 *   jsonSchema    optional JSON schema — native structured output where supported
 *   thinking      'none' | 'low' | 'medium' | 'high'
 *   temperature   optional number
 *   maxTokens     optional number; only sent where the API requires/uses it
 *   quirks        the provider's catalog quirks object (may be undefined)
 *   extraHeaders  optional {name: value}
 * }
 *
 * Errors mid-body (OpenRouter's HTTP-200 errors, Google safety blocks, SSE
 * error events) surface via the `error` field: {message, code?, raw}.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined') module.exports = api;
  if (root) Object.assign(root, api);
})(typeof self !== 'undefined' ? self : this, function () {

  function splitDataUrl(url) {
    const [meta, data] = String(url).split(',');
    return { mimeType: meta.replace('data:', '').replace(';base64', ''), data };
  }

  function messageImages(m) {
    if (m.images && m.images.length) return m.images;
    if (m.imageBase64) return [`data:image/jpeg;base64,${m.imageBase64}`];
    return [];
  }

  function stripTrailingSlash(base) {
    return String(base || '').replace(/\/+$/, '');
  }

  // ── Anthropic Messages API ──────────────────────────────────────────────────

  // Models on adaptive thinking, where temperature/top_p/top_k are deprecated
  // (400 on non-default) and thinking.budget_tokens is rejected.
  const ANTHROPIC_ADAPTIVE = /claude-(fable|mythos)|claude-opus-5|claude-sonnet-5|claude-opus-4-[678]|claude-sonnet-4-6/;
  const ANTHROPIC_BUDGETS = { low: 2048, medium: 10000, high: 32768 };
  // max_tokens is required by the API; 32000 is within every listed model's
  // output cap. Providers enforce their real limits (no client-side tables).
  const ANTHROPIC_DEFAULT_MAX = 32000;

  const anthropic = {
    buildRequest(req) {
      const messages = req.messages.map(m => {
        const imgs = messageImages(m);
        if (m.role === 'user' && imgs.length) {
          return {
            role: 'user',
            content: [
              ...imgs.map(url => {
                const { mimeType, data } = splitDataUrl(url);
                return { type: 'image', source: { type: 'base64', media_type: mimeType, data } };
              }),
              { type: 'text', text: m.content }
            ]
          };
        }
        return { role: m.role, content: m.content };
      });

      const modern = ANTHROPIC_ADAPTIVE.test(req.model);
      const thinking = req.thinking || 'none';
      const body = {
        model: req.model,
        max_tokens: req.maxTokens || ANTHROPIC_DEFAULT_MAX,
        system: req.system,
        messages
      };

      if (thinking !== 'none') {
        if (modern) {
          // Adaptive is the only "on" mode for current models; depth is
          // controlled by output_config.effort (anthropic.md §4)
          body.thinking = { type: 'adaptive' };
          body.output_config = Object.assign({}, body.output_config, { effort: thinking });
        } else {
          const budget = ANTHROPIC_BUDGETS[thinking] || ANTHROPIC_BUDGETS.medium;
          body.thinking = { type: 'enabled', budget_tokens: budget };
          body.max_tokens = Math.max(body.max_tokens, budget + 16000);
          body.temperature = 1; // required with legacy fixed-budget thinking
        }
      } else if (!modern && typeof req.temperature === 'number') {
        // temperature is deprecated (400) on adaptive-generation models
        body.temperature = req.temperature;
      }

      if (req.jsonSchema) {
        // Native structured outputs: result arrives as a text block whose
        // string is guaranteed-valid JSON for this schema (anthropic.md §3)
        body.output_config = Object.assign({}, body.output_config, {
          format: { type: 'json_schema', schema: req.jsonSchema }
        });
      }
      // Plain jsonMode has no native switch on Anthropic — the system prompt
      // carries the "respond with only JSON" instruction (existing behavior).

      if (req.stream) body.stream = true;

      return {
        url: `${stripTrailingSlash(req.base)}/v1/messages`,
        headers: Object.assign({
          'Content-Type': 'application/json',
          'x-api-key': req.apiKey || '',
          'anthropic-version': '2023-06-01',
          // Required for direct browser/extension fetches (CORS opt-in);
          // harmless if the requirement was dropped (anthropic.md §1)
          'anthropic-dangerous-direct-browser-access': 'true'
        }, req.extraHeaders || {}),
        body
      };
    },

    parseResponse(d) {
      if (d && d.type === 'error') {
        return { text: '', error: { message: d.error?.message || 'Anthropic error', code: d.error?.type, raw: d } };
      }
      const textBlock = (d.content || []).find(b => b.type === 'text');
      return {
        text: textBlock?.text ?? '',
        stopReason: d.stop_reason,
        usage: d.usage
      };
    },

    parseSSEEvent(ev) {
      switch (ev && ev.type) {
        case 'content_block_delta':
          if (ev.delta?.type === 'text_delta') return { textDelta: ev.delta.text || '' };
          return {}; // thinking_delta / input_json_delta — not rendered
        case 'message_delta':
          return { stopReason: ev.delta?.stop_reason, usage: ev.usage };
        case 'message_stop':
          return { done: true };
        case 'error':
          return { error: { message: ev.error?.message || 'Anthropic stream error', code: ev.error?.type, raw: ev } };
        default:
          return {}; // message_start, content_block_start/stop, ping
      }
    },

    buildModelsRequest(req) {
      return {
        url: `${stripTrailingSlash(req.base)}/v1/models?limit=1000`,
        headers: {
          'x-api-key': req.apiKey || '',
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true'
        }
      };
    },

    parseModelsResponse(d) {
      return (d.data || []).map(m => ({ id: m.id, label: m.display_name || m.id }));
    }
  };

  // ── Google Gemini (Generative Language API, v1beta) ─────────────────────────

  function googleThinkingConfig(model, thinking) {
    const m = String(model || '').toLowerCase();
    const level = thinking || 'none';
    if (/(^|\/)gemini-3/.test(m)) {
      if (level === 'none') {
        // Gemini 3 Pro cannot fully disable thinking; Flash/Lite support minimal
        return { thinkingLevel: /pro/.test(m) ? 'low' : 'minimal' };
      }
      return { thinkingLevel: level };
    }
    const budgets = { low: 1024, medium: 8192, high: 24576 };
    if (level === 'none') {
      // Gemini 2.5 Pro cannot disable thinking; use the smallest allowed budget
      return { thinkingBudget: /pro/.test(m) ? 128 : 0 };
    }
    return { thinkingBudget: budgets[level] || 0 };
  }

  const google = {
    buildRequest(req) {
      const contents = req.messages.map(m => {
        // image parts before text parts, per Google guidance
        const parts = [
          ...messageImages(m).map(url => {
            const { mimeType, data } = splitDataUrl(url);
            return { inlineData: { mimeType, data } };
          }),
          { text: m.content }
        ];
        return { role: m.role === 'assistant' ? 'model' : 'user', parts };
      });

      const generationConfig = {
        ...(typeof req.temperature === 'number' ? { temperature: req.temperature } : {}),
        ...(req.maxTokens ? { maxOutputTokens: req.maxTokens } : {}),
        // JSON mode works with streaming too (google.md §3) — same config both ways
        ...(req.jsonMode || req.jsonSchema ? { responseMimeType: 'application/json' } : {}),
        ...(req.jsonSchema ? { responseSchema: req.jsonSchema } : {}),
        thinkingConfig: googleThinkingConfig(req.model, req.thinking)
      };

      const method = req.stream ? 'streamGenerateContent' : 'generateContent';
      const query = req.stream ? '?alt=sse' : '';
      return {
        // v1beta required: systemInstruction/thinkingConfig/responseMimeType
        // are not on the v1 schema. Key goes in the header, not the URL.
        url: `${stripTrailingSlash(req.base)}/v1beta/models/${req.model}:${method}${query}`,
        headers: Object.assign({
          'Content-Type': 'application/json',
          'x-goog-api-key': req.apiKey || ''
        }, req.extraHeaders || {}),
        body: {
          systemInstruction: { parts: [{ text: req.system }] },
          contents,
          generationConfig
        }
      };
    },

    parseResponse(d) {
      if (d && d.error) {
        return { text: '', error: { message: d.error.message || 'Google error', code: d.error.status || d.error.code, raw: d } };
      }
      const block = d.promptFeedback?.blockReason;
      if (block) {
        return { text: '', error: { message: `Request blocked: ${block}`, code: block, raw: d } };
      }
      const cand = d.candidates?.[0];
      const text = cand?.content?.parts?.find(p => !p.thought && p.text)?.text ?? '';
      return { text, stopReason: cand?.finishReason, usage: d.usageMetadata };
    },

    parseSSEEvent(ev) {
      if (ev && ev.error) {
        return { error: { message: ev.error.message || 'Google stream error', code: ev.error.status || ev.error.code, raw: ev } };
      }
      const block = ev?.promptFeedback?.blockReason;
      if (block) {
        return { error: { message: `Request blocked: ${block}`, code: block, raw: ev } };
      }
      const cand = ev?.candidates?.[0];
      const textDelta = cand?.content?.parts?.find(p => !p.thought && p.text)?.text || '';
      return {
        ...(textDelta ? { textDelta } : {}),
        ...(cand?.finishReason ? { stopReason: cand.finishReason, done: true } : {}),
        ...(ev?.usageMetadata ? { usage: ev.usageMetadata } : {})
      };
    },

    buildModelsRequest(req) {
      return {
        url: `${stripTrailingSlash(req.base)}/v1beta/models?pageSize=1000`,
        headers: { 'x-goog-api-key': req.apiKey || '' }
      };
    },

    parseModelsResponse(d) {
      return (d.models || [])
        .filter(m => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent'))
        .map(m => ({
          id: String(m.name || '').replace(/^models\//, ''),
          label: m.displayName || String(m.name || '').replace(/^models\//, '')
        }));
    }
  };

  // ── Generic OpenAI-compatible Chat Completions ──────────────────────────────

  const OAI_DEEPSEEK_EFFORT = { low: 'low', medium: 'high', high: 'max' };

  function oaiIsReasoningModel(model, quirks) {
    const m = String(model || '');
    const prefixes = quirks?.reasoningModelPrefixes;
    if (prefixes && prefixes.some(p => m.startsWith(p))) return true;
    return /^o[0-9]/.test(m);
  }

  const oai = {
    buildRequest(req) {
      const messages = req.messages.map(m => {
        const imgs = messageImages(m);
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

      const reasoning = oaiIsReasoningModel(req.model, req.quirks);
      const body = {
        model: req.model,
        messages: [{ role: 'system', content: req.system }, ...messages]
      };

      if (req.maxTokens) {
        // Reasoning models reject max_tokens; everything else still takes it
        body[reasoning ? 'max_completion_tokens' : 'max_tokens'] = req.maxTokens;
      }

      if (req.jsonSchema && !(req.stream && req.quirks?.noJsonSchemaStream)) {
        body.response_format = {
          type: 'json_schema',
          json_schema: { name: 'response', strict: true, schema: req.jsonSchema }
        };
      } else if (req.jsonMode || req.jsonSchema) {
        // json_object works with streaming everywhere json mode exists at all
        body.response_format = { type: 'json_object' };
      }

      const thinking = req.thinking || 'none';
      if (req.quirks?.deepseekThinking) {
        // DeepSeek V4: thinking is a param, not a model (deepseek.md)
        if (thinking !== 'none') {
          body.thinking = { type: 'enabled' };
          body.reasoning_effort = OAI_DEEPSEEK_EFFORT[thinking] || 'high';
        }
      } else if (reasoning && thinking !== 'none') {
        body.reasoning_effort = thinking;
      }

      // Reasoning models reject sampling params (openai.md §3)
      if (!reasoning && typeof req.temperature === 'number') {
        body.temperature = req.temperature;
      }

      if (req.stream) body.stream = true;

      return {
        url: `${stripTrailingSlash(req.base)}/chat/completions`,
        headers: Object.assign(
          { 'Content-Type': 'application/json' },
          req.apiKey ? { 'Authorization': `Bearer ${req.apiKey}` } : {},
          req.extraHeaders || {}
        ),
        body
      };
    },

    parseResponse(d) {
      if (d && d.error) {
        return { text: '', error: { message: d.error.message || 'Provider error', code: d.error.code ?? d.error.type, raw: d } };
      }
      const choice = d.choices?.[0];
      // OpenRouter can return HTTP 200 with the error inside the choice
      // (openrouter.md §8) — surfaced here so it is never mistaken for output
      if (choice?.error || choice?.finish_reason === 'error') {
        const e = choice.error || {};
        return { text: choice?.message?.content ?? '', error: { message: e.message || 'Provider mid-generation error', code: e.code, raw: d } };
      }
      return {
        text: choice?.message?.content ?? '',
        stopReason: choice?.finish_reason,
        usage: d.usage
      };
    },

    parseSSEEvent(ev) {
      if (ev && ev.error) {
        return { error: { message: ev.error.message || 'Provider stream error', code: ev.error.code ?? ev.error.type, raw: ev } };
      }
      const choice = ev?.choices?.[0];
      if (choice?.error || choice?.finish_reason === 'error') {
        const e = choice.error || {};
        return { error: { message: e.message || 'Provider mid-stream error', code: e.code, raw: ev } };
      }
      return {
        ...(choice?.delta?.content ? { textDelta: choice.delta.content } : {}),
        ...(choice?.finish_reason ? { stopReason: choice.finish_reason, done: true } : {}),
        ...(ev?.usage ? { usage: ev.usage } : {})
      };
    },

    buildModelsRequest(req) {
      if (req.quirks?.noModelsEndpoint) return null;
      return {
        url: `${stripTrailingSlash(req.base)}/models`,
        headers: req.apiKey ? { 'Authorization': `Bearer ${req.apiKey}` } : {}
      };
    },

    parseModelsResponse(d) {
      const rows = Array.isArray(d.data) ? d.data
                 : Array.isArray(d.models) ? d.models
                 : [];
      return rows
        .map(m => ({ id: m.id || m.name, label: m.name && m.id ? m.name : (m.id || m.name) }))
        .filter(m => m.id);
    }
  };

  return { Adapters: { anthropic, google, oai } };
});
