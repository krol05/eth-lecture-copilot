/**
 * Adapter contract tests — golden request bodies and SSE parsing for the three
 * wire formats, built from docs/providers/*.md (official docs, 2026-08-23).
 * The core regression guarded here: stream and non-stream requests must be
 * IDENTICAL except for the stream flag (the old background.js drifted — the
 * streaming paths silently dropped thinking and JSON mode).
 */
const { Adapters } = require('../lib/providers/adapters.js');
const { Catalog } = require('../lib/providers/catalog.js');

const MSG = [{ role: 'user', content: 'Explain the Fourier transform' }];

function req(overrides = {}) {
  return {
    base: 'https://api.example.com',
    model: 'test-model',
    apiKey: 'sk-test',
    system: 'You are a tutor.',
    messages: MSG,
    ...overrides
  };
}

// ─── Cross-adapter invariant: stream flag never changes anything else ─────────

describe('stream/non-stream parity (drift killer)', () => {
  const cases = [
    ['anthropic', req({ base: 'https://api.anthropic.com', model: 'claude-sonnet-5', thinking: 'high', jsonSchema: { type: 'object' } })],
    ['google', req({ base: 'https://generativelanguage.googleapis.com', model: 'gemini-2.5-flash', jsonMode: true, thinking: 'medium' })],
    ['oai', req({ base: 'https://api.openai.com/v1', model: 'gpt-5.6-terra', jsonMode: true, thinking: 'low', quirks: Catalog.get('openai').quirks })]
  ];

  test.each(cases)('%s: bodies identical except stream:true', (name, r) => {
    const plain = Adapters[name].buildRequest({ ...r, stream: false });
    const stream = Adapters[name].buildRequest({ ...r, stream: true });
    expect(stream.headers).toEqual(plain.headers);
    if (name === 'google') {
      // Google switches the RPC method in the URL instead of a body flag
      expect(stream.url).toContain(':streamGenerateContent?alt=sse');
      expect(plain.url).toContain(':generateContent');
      expect(stream.body).toEqual(plain.body);
    } else {
      expect(stream.url).toBe(plain.url);
      expect(stream.body).toEqual({ ...plain.body, stream: true });
    }
  });
});

// ─── Anthropic ────────────────────────────────────────────────────────────────

describe('anthropic adapter', () => {
  const A = Adapters.anthropic;
  const base = { base: 'https://api.anthropic.com', apiKey: 'sk-ant-x' };

  test('golden request: url, auth and CORS headers, required max_tokens', () => {
    const r = A.buildRequest(req({ ...base, model: 'claude-sonnet-5' }));
    expect(r.url).toBe('https://api.anthropic.com/v1/messages');
    expect(r.headers['x-api-key']).toBe('sk-ant-x');
    expect(r.headers['anthropic-version']).toBe('2023-06-01');
    expect(r.headers['anthropic-dangerous-direct-browser-access']).toBe('true');
    expect(r.body).toEqual({
      model: 'claude-sonnet-5',
      max_tokens: 32000,
      system: 'You are a tutor.',
      messages: [{ role: 'user', content: 'Explain the Fourier transform' }],
      // stated explicitly: Opus 5 and friends think by default when omitted
      thinking: { type: 'disabled' }
    });
  });

  test('modern models: thinking → adaptive + output_config.effort, never budget_tokens', () => {
    for (const model of ['claude-opus-5', 'claude-fable-5', 'claude-opus-4-8', 'claude-sonnet-4-6']) {
      const { body } = A.buildRequest(req({ ...base, model, thinking: 'high' }));
      expect(body.thinking).toEqual({ type: 'adaptive' });
      expect(body.output_config.effort).toBe('high');
      expect(body.thinking.budget_tokens).toBeUndefined();
    }
  });

  test('legacy models: thinking → enabled + budget_tokens, max_tokens bumped, temp 1', () => {
    const { body } = A.buildRequest(req({ ...base, model: 'claude-sonnet-4-5', thinking: 'medium' }));
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 10000 });
    expect(body.max_tokens).toBeGreaterThanOrEqual(26000);
    expect(body.temperature).toBe(1);
  });

  test('temperature: sent to legacy models, omitted on adaptive-generation models (they 400)', () => {
    const legacy = A.buildRequest(req({ ...base, model: 'claude-haiku-4-5', temperature: 0.4 }));
    expect(legacy.body.temperature).toBe(0.4);
    const modern = A.buildRequest(req({ ...base, model: 'claude-opus-5', temperature: 0.4 }));
    expect(modern.body.temperature).toBeUndefined();
  });

  test('jsonSchema → output_config.format json_schema', () => {
    const schema = { type: 'object', properties: { title: { type: 'string' } } };
    const { body } = A.buildRequest(req({ ...base, model: 'claude-sonnet-5', jsonSchema: schema }));
    expect(body.output_config.format).toEqual({ type: 'json_schema', schema });
  });

  test('jsonSchema and thinking share output_config without clobbering', () => {
    const { body } = A.buildRequest(req({ ...base, model: 'claude-sonnet-5', jsonSchema: { type: 'object' }, thinking: 'low' }));
    expect(body.output_config.effort).toBe('low');
    expect(body.output_config.format.type).toBe('json_schema');
  });

  test('images become base64 blocks before the text block', () => {
    const messages = [{ role: 'user', content: 'what is this?', images: ['data:image/png;base64,AAAA'] }];
    const { body } = A.buildRequest(req({ ...base, model: 'claude-sonnet-5', messages }));
    expect(body.messages[0].content[0]).toEqual({
      type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' }
    });
    expect(body.messages[0].content[1]).toEqual({ type: 'text', text: 'what is this?' });
  });

  test('parseResponse: text block, stop_reason, usage; error envelope', () => {
    const ok = A.parseResponse({
      content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'Answer.' }],
      stop_reason: 'end_turn', usage: { output_tokens: 5 }
    });
    expect(ok).toEqual({ text: 'Answer.', stopReason: 'end_turn', usage: { output_tokens: 5 } });

    const err = A.parseResponse({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } });
    expect(err.error.code).toBe('overloaded_error');
    expect(err.error.message).toBe('Overloaded');
  });

  test('parseSSEEvent: deltas, message_delta, stop, error event, ping ignored', () => {
    expect(A.parseSSEEvent({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } })).toEqual({ textDelta: 'Hi' });
    expect(A.parseSSEEvent({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'x' } })).toEqual({});
    expect(A.parseSSEEvent({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } }))
      .toEqual({ stopReason: 'end_turn', usage: { output_tokens: 9 } });
    expect(A.parseSSEEvent({ type: 'message_stop' })).toEqual({ done: true });
    expect(A.parseSSEEvent({ type: 'ping' })).toEqual({});
    const e = A.parseSSEEvent({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } });
    expect(e.error.code).toBe('overloaded_error');
  });

  test('models: request carries auth headers, response maps display names', () => {
    const r = A.buildModelsRequest({ base: 'https://api.anthropic.com', apiKey: 'k' });
    expect(r.url).toBe('https://api.anthropic.com/v1/models?limit=1000');
    expect(r.headers['x-api-key']).toBe('k');
    expect(A.parseModelsResponse({ data: [{ id: 'claude-opus-5', display_name: 'Claude Opus 5' }] }))
      .toEqual([{ id: 'claude-opus-5', label: 'Claude Opus 5' }]);
  });
});

// ─── Google ───────────────────────────────────────────────────────────────────

describe('google adapter', () => {
  const G = Adapters.google;
  const base = { base: 'https://generativelanguage.googleapis.com', apiKey: 'AIza-x' };

  test('golden request: v1beta URL, key in header not URL', () => {
    const r = G.buildRequest(req({ ...base, model: 'gemini-2.5-flash' }));
    expect(r.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
    expect(r.url).not.toContain('key=');
    expect(r.headers['x-goog-api-key']).toBe('AIza-x');
    expect(r.body.systemInstruction).toEqual({ parts: [{ text: 'You are a tutor.' }] });
    expect(r.body.contents).toEqual([{ role: 'user', parts: [{ text: 'Explain the Fourier transform' }] }]);
  });

  test('JSON mode survives streaming (the old code dropped it)', () => {
    const r = G.buildRequest(req({ ...base, model: 'gemini-2.5-flash', jsonMode: true, stream: true }));
    expect(r.body.generationConfig.responseMimeType).toBe('application/json');
  });

  test('jsonSchema adds responseSchema', () => {
    const schema = { type: 'object' };
    const r = G.buildRequest(req({ ...base, model: 'gemini-2.5-flash', jsonSchema: schema }));
    expect(r.body.generationConfig.responseMimeType).toBe('application/json');
    expect(r.body.generationConfig.responseSchema).toEqual(schema);
  });

  test('thinking config: thinkingLevel on Gemini 3.x, thinkingBudget on 2.5', () => {
    const g3 = G.buildRequest(req({ ...base, model: 'gemini-3.7-flash', thinking: 'high' }));
    expect(g3.body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'high' });
    const g3off = G.buildRequest(req({ ...base, model: 'gemini-3.1-pro-preview', thinking: 'none' }));
    expect(g3off.body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'low' }); // Pro can't disable
    const g25 = G.buildRequest(req({ ...base, model: 'gemini-2.5-flash', thinking: 'medium' }));
    expect(g25.body.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 8192 });
    const g25pro = G.buildRequest(req({ ...base, model: 'gemini-2.5-pro', thinking: 'none' }));
    expect(g25pro.body.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 128 });
  });

  test('assistant role maps to model; images precede text', () => {
    const messages = [
      { role: 'assistant', content: 'Previously...' },
      { role: 'user', content: 'and this?', images: ['data:image/jpeg;base64,BBBB'] }
    ];
    const { body } = G.buildRequest(req({ ...base, model: 'gemini-2.5-flash', messages }));
    expect(body.contents[0].role).toBe('model');
    expect(body.contents[1].parts[0]).toEqual({ inlineData: { mimeType: 'image/jpeg', data: 'BBBB' } });
    expect(body.contents[1].parts[1]).toEqual({ text: 'and this?' });
  });

  test('parseResponse: skips thought parts, surfaces safety blocks and errors', () => {
    const ok = G.parseResponse({
      candidates: [{ content: { parts: [{ thought: true, text: 'thinking...' }, { text: 'Answer.' }] }, finishReason: 'STOP' }],
      usageMetadata: { totalTokenCount: 10 }
    });
    expect(ok.text).toBe('Answer.');
    expect(ok.stopReason).toBe('STOP');

    const blocked = G.parseResponse({ promptFeedback: { blockReason: 'SAFETY' } });
    expect(blocked.error.code).toBe('SAFETY');

    const err = G.parseResponse({ error: { code: 400, message: 'API key not valid', status: 'INVALID_ARGUMENT' } });
    expect(err.error.code).toBe('INVALID_ARGUMENT');
  });

  test('parseSSEEvent: text deltas, finish carries done, thought parts skipped', () => {
    expect(G.parseSSEEvent({ candidates: [{ content: { parts: [{ text: 'Art' }] } }] })).toEqual({ textDelta: 'Art' });
    const last = G.parseSSEEvent({
      candidates: [{ content: { parts: [{ text: '' }] }, finishReason: 'STOP' }],
      usageMetadata: { totalTokenCount: 20 }
    });
    expect(last.done).toBe(true);
    expect(last.stopReason).toBe('STOP');
    expect(last.usage).toEqual({ totalTokenCount: 20 });
    expect(G.parseSSEEvent({ candidates: [{ content: { parts: [{ thought: true, text: 'mull' }] } }] }).textDelta).toBeUndefined();
  });

  test('models: strips models/ prefix, filters non-generateContent entries', () => {
    const r = G.buildModelsRequest({ base: base.base, apiKey: 'k' });
    expect(r.url).toContain('/v1beta/models');
    expect(r.headers['x-goog-api-key']).toBe('k');
    const parsed = G.parseModelsResponse({ models: [
      { name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/embedding-001', supportedGenerationMethods: ['embedContent'] }
    ]});
    expect(parsed).toEqual([{ id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' }]);
  });
});

// ─── OAI-compatible ───────────────────────────────────────────────────────────

describe('oai adapter', () => {
  const O = Adapters.oai;

  test('golden request: bearer auth, system message first', () => {
    const r = O.buildRequest(req({ base: 'https://api.openai.com/v1', model: 'gpt-4o', temperature: 0.4 }));
    expect(r.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(r.headers['Authorization']).toBe('Bearer sk-test');
    expect(r.body.messages[0]).toEqual({ role: 'system', content: 'You are a tutor.' });
    expect(r.body.temperature).toBe(0.4);
  });

  test('no auth header for keyless (local) providers', () => {
    const r = O.buildRequest(req({ base: 'http://localhost:11434/v1', apiKey: null, model: 'llama3' }));
    expect(r.headers['Authorization']).toBeUndefined();
  });

  test('reasoning models (catalog prefixes + o-series): max_completion_tokens, no temperature, reasoning_effort', () => {
    const quirks = Catalog.get('openai').quirks;
    for (const model of ['gpt-5.6-terra', 'o4-mini']) {
      const { body } = O.buildRequest(req({ model, quirks, maxTokens: 4000, temperature: 0.4, thinking: 'medium' }));
      expect(body.max_completion_tokens).toBe(4000);
      expect(body.max_tokens).toBeUndefined();
      expect(body.temperature).toBeUndefined();
      expect(body.reasoning_effort).toBe('medium');
    }
    // non-reasoning model with the same quirks keeps classic params
    const { body } = O.buildRequest(req({ model: 'gpt-4o', quirks, maxTokens: 4000, temperature: 0.4 }));
    expect(body.max_tokens).toBe(4000);
    expect(body.temperature).toBe(0.4);
  });

  test('deepseek quirk: thinking param + mapped reasoning_effort', () => {
    const quirks = Catalog.get('deepseek').quirks;
    const { body } = O.buildRequest(req({ model: 'deepseek-v4-flash', quirks, thinking: 'high' }));
    expect(body.thinking).toEqual({ type: 'enabled' });
    expect(body.reasoning_effort).toBe('max');
    // "none" is sent explicitly: omitting the param lets V4 decide to think,
    // which on a non-streaming request is indistinguishable from a hang
    const off = O.buildRequest(req({ model: 'deepseek-v4-flash', quirks, thinking: 'none' }));
    expect(off.body.thinking).toEqual({ type: 'disabled' });
    expect(off.body.reasoning_effort).toBeUndefined();
  });

  test('jsonSchema → strict json_schema; groq quirk downgrades it only when streaming', () => {
    const schema = { type: 'object' };
    const plain = O.buildRequest(req({ model: 'gpt-4o', jsonSchema: schema }));
    expect(plain.body.response_format).toEqual({
      type: 'json_schema', json_schema: { name: 'response', strict: true, schema }
    });
    const groq = Catalog.get('groq').quirks;
    const streamed = O.buildRequest(req({ model: 'openai/gpt-oss-120b', quirks: groq, jsonSchema: schema, stream: true }));
    expect(streamed.body.response_format).toEqual({ type: 'json_object' });
    const unstreamed = O.buildRequest(req({ model: 'openai/gpt-oss-120b', quirks: groq, jsonSchema: schema }));
    expect(unstreamed.body.response_format.type).toBe('json_schema');
  });

  test('parseResponse: text, top-level error envelope, OpenRouter error-inside-200', () => {
    const ok = O.parseResponse({ choices: [{ message: { content: 'Hi' }, finish_reason: 'stop' }], usage: { total_tokens: 4 } });
    expect(ok).toEqual({ text: 'Hi', stopReason: 'stop', usage: { total_tokens: 4 } });

    const err = O.parseResponse({ error: { message: 'Invalid API key', type: 'invalid_request_error', code: 'invalid_api_key' } });
    expect(err.error.code).toBe('invalid_api_key');

    const orErr = O.parseResponse({ choices: [{ message: { content: 'partial' }, error: { message: 'Provider overloaded', code: 502 }, finish_reason: 'error' }] });
    expect(orErr.error.message).toBe('Provider overloaded');
    expect(orErr.text).toBe('partial'); // partial content preserved for salvage
  });

  test('parseSSEEvent: deltas, finish, usage chunk, mid-stream errors', () => {
    expect(O.parseSSEEvent({ choices: [{ delta: { content: 'He' } }] })).toEqual({ textDelta: 'He' });
    const fin = O.parseSSEEvent({ choices: [{ delta: {}, finish_reason: 'stop' }] });
    expect(fin.done).toBe(true);
    expect(O.parseSSEEvent({ choices: [], usage: { total_tokens: 7 } })).toEqual({ usage: { total_tokens: 7 } });
    const e = O.parseSSEEvent({ error: { message: 'Rate limited', code: 429 } });
    expect(e.error.message).toBe('Rate limited');
    const midOr = O.parseSSEEvent({ choices: [{ delta: {}, error: { message: 'upstream died' } }] });
    expect(midOr.error.message).toBe('upstream died');
  });

  test('models: bearer request, tolerates data[] and models[] shapes, perplexity opts out', () => {
    const r = O.buildModelsRequest({ base: 'https://api.groq.com/openai/v1', apiKey: 'k' });
    expect(r.url).toBe('https://api.groq.com/openai/v1/models');
    expect(r.headers['Authorization']).toBe('Bearer k');
    expect(O.parseModelsResponse({ data: [{ id: 'a' }, { id: 'b' }] }).map(m => m.id)).toEqual(['a', 'b']);
    expect(O.parseModelsResponse({ models: [{ name: 'ollama-model' }] })).toEqual([{ id: 'ollama-model', label: 'ollama-model' }]);
    expect(O.buildModelsRequest({ base: 'https://api.perplexity.ai', apiKey: 'k', quirks: Catalog.get('perplexity').quirks })).toBeNull();
  });
});

// ─── Thinking is never left to the model's default ───────────────────────────
// Several current models reason by default when the parameter is absent, which
// on a long generation is indistinguishable from a hang. "none" must be stated.

describe('thinking off is always explicit', () => {
  const A = Adapters.anthropic;
  const O = Adapters.oai;
  const G = Adapters.google;

  test('Claude models are told to disable thinking', () => {
    for (const model of ['claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-haiku-4-5']) {
      const { body } = A.buildRequest(req({ base: 'https://api.anthropic.com', model, thinking: 'none' }));
      expect(body.thinking).toEqual({ type: 'disabled' });
    }
  });

  test('Fable/Mythos omit it instead — they reject disabled with a 400', () => {
    for (const model of ['claude-fable-5', 'claude-mythos-5']) {
      const { body } = A.buildRequest(req({ base: 'https://api.anthropic.com', model, thinking: 'none' }));
      expect(body.thinking).toBeUndefined();
    }
  });

  test('OpenAI reasoning models get an explicit effort', () => {
    const quirks = Catalog.get('openai').quirks;
    const gpt5 = O.buildRequest(req({ model: 'gpt-5.6-terra', quirks, thinking: 'none' }));
    expect(gpt5.body.reasoning_effort).toBe('none');
    // o-series predates none/minimal — "low" is the safe floor
    const o = O.buildRequest(req({ model: 'o4-mini', quirks, thinking: 'none' }));
    expect(o.body.reasoning_effort).toBe('low');
  });

  test('non-reasoning models are left alone', () => {
    const quirks = Catalog.get('openai').quirks;
    const { body } = O.buildRequest(req({ model: 'gpt-4o', quirks, thinking: 'none' }));
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.thinking).toBeUndefined();
  });

  test('DeepSeek disables thinking explicitly', () => {
    const quirks = Catalog.get('deepseek').quirks;
    const { body } = O.buildRequest(req({ model: 'deepseek-v4-pro', quirks, thinking: 'none' }));
    expect(body.thinking).toEqual({ type: 'disabled' });
  });

  test('Google always states a thinking config', () => {
    for (const model of ['gemini-3.7-flash', 'gemini-3.1-pro-preview', 'gemini-2.5-pro', 'gemini-2.5-flash']) {
      const { body } = G.buildRequest(req({ base: 'https://generativelanguage.googleapis.com', model, thinking: 'none' }));
      expect(body.generationConfig.thinkingConfig).toBeDefined();
    }
  });

  test('a provider can declare its own verified off-switch', () => {
    const quirks = { thinkingOffBody: { enable_thinking: false } };
    const { body } = O.buildRequest(req({ model: 'qwen3.5-plus', quirks, thinking: 'none' }));
    expect(body.enable_thinking).toBe(false);
  });
});
