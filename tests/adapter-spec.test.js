/**
 * lib/providers/adapter-spec.js — declarative custom adapters (M3 L2).
 * The reference check: a spec describing the OpenAI wire format must produce
 * the same request body as the real oai adapter from M2.
 */
const { validateSpec, adapterFromSpec } = require('../lib/providers/adapter-spec.js');
const { Adapters } = require('../lib/providers/adapters.js');

const OAI_SPEC = {
  endpoint: '/chat/completions',
  auth: { type: 'bearer' },
  body: {
    model: '$MODEL',
    messages: '$MESSAGES',
    stream: '$STREAM',
    temperature: '$TEMPERATURE',
    max_tokens: '$MAX_TOKENS'
  },
  textPath: 'choices.0.message.content',
  ssePath: 'choices.0.delta.content',
  errorPath: 'error.message',
  models: { endpoint: '/models', listPath: 'data', idPath: 'id' }
};

const REQ = {
  base: 'https://api.example.com/v1',
  model: 'some-model',
  apiKey: 'sk-x',
  system: 'You are a tutor.',
  messages: [{ role: 'user', content: 'Hi' }],
  temperature: 0.4,
  maxTokens: 4000,
  stream: false
};

describe('validateSpec', () => {
  test('accepts the reference OAI spec', () => {
    expect(validateSpec(OAI_SPEC)).toEqual({ ok: true, errors: [] });
  });

  test('reports every problem, not just the first', () => {
    const { ok, errors } = validateSpec({ endpoint: 'chat', auth: { type: 'magic' }, body: { model: '$MODEL' } });
    expect(ok).toBe(false);
    expect(errors.join('\n')).toContain('"endpoint"');
    expect(errors.join('\n')).toContain('"auth.type"');
    expect(errors.join('\n')).toContain('$MESSAGES');
    expect(errors.join('\n')).toContain('"textPath"');
  });

  test('header/query auth require a name; non-objects rejected', () => {
    expect(validateSpec({ ...OAI_SPEC, auth: { type: 'header' } }).errors.join()).toContain('auth.name');
    expect(validateSpec(null).ok).toBe(false);
    expect(validateSpec([]).ok).toBe(false);
  });
});

describe('adapterFromSpec vs the real oai adapter (golden check)', () => {
  test('produces an equivalent request', () => {
    const specAdapter = adapterFromSpec(OAI_SPEC);
    const real = Adapters.oai.buildRequest(REQ);
    const fromSpec = specAdapter.buildRequest(REQ);
    expect(fromSpec.url).toBe(real.url);
    expect(fromSpec.headers['Authorization']).toBe('Bearer sk-x');
    // Same body modulo key order; the real adapter omits stream:false, the
    // spec sends it explicitly — normalize that before comparing.
    expect({ ...fromSpec.body, stream: undefined }).toEqual({ ...real.body, stream: undefined });
    expect(fromSpec.body.messages[0]).toEqual({ role: 'system', content: 'You are a tutor.' });
  });

  test('unset optional values drop their keys instead of sending null', () => {
    const { body } = adapterFromSpec(OAI_SPEC).buildRequest({ ...REQ, temperature: undefined, maxTokens: undefined });
    expect('temperature' in body).toBe(false);
    expect('max_tokens' in body).toBe(false);
  });
});

describe('spec adapter behavior', () => {
  const A = adapterFromSpec(OAI_SPEC);

  test('parseResponse via textPath; errorPath wins when present', () => {
    expect(A.parseResponse({ choices: [{ message: { content: 'Hello' } }] })).toEqual({ text: 'Hello' });
    const err = A.parseResponse({ error: { message: 'kaputt' } });
    expect(err.error.message).toBe('kaputt');
  });

  test('parseSSEEvent via ssePath', () => {
    expect(A.parseSSEEvent({ choices: [{ delta: { content: 'He' } }] })).toEqual({ textDelta: 'He' });
    expect(A.parseSSEEvent({ choices: [{ delta: {} }] })).toEqual({});
    expect(A.parseSSEEvent({ error: { message: 'mid-stream boom' } }).error.message).toBe('mid-stream boom');
  });

  test('models endpoint honored; absent models section → null request', () => {
    expect(A.buildModelsRequest({ base: 'https://api.example.com/v1', apiKey: 'k' }).url)
      .toBe('https://api.example.com/v1/models');
    expect(A.parseModelsResponse({ data: [{ id: 'm1' }, { id: 'm2' }] }).map(m => m.id)).toEqual(['m1', 'm2']);
    const noModels = adapterFromSpec({ ...OAI_SPEC, models: undefined });
    expect(noModels.buildModelsRequest({ base: 'x', apiKey: 'k' })).toBeNull();
  });

  test('header auth and query auth', () => {
    const hdr = adapterFromSpec({ ...OAI_SPEC, auth: { type: 'header', name: 'x-api-key' } })
      .buildRequest(REQ);
    expect(hdr.headers['x-api-key']).toBe('sk-x');
    expect(hdr.headers['Authorization']).toBeUndefined();

    const q = adapterFromSpec({ ...OAI_SPEC, auth: { type: 'query', name: 'key' } }).buildRequest(REQ);
    expect(q.url).toBe('https://api.example.com/v1/chat/completions?key=sk-x');
    expect(q.headers['Authorization']).toBeUndefined();
  });

  test('a non-OAI shape: Google-like spec builds nested bodies via placeholders', () => {
    const spec = {
      endpoint: '/v1beta/models/gemini:generateContent',
      auth: { type: 'query', name: 'key' },
      body: {
        systemInstruction: { parts: [{ text: '$SYSTEM' }] },
        contents: '$MESSAGES',
        generationConfig: { temperature: '$TEMPERATURE', model_hint: '$MODEL' }
      },
      textPath: 'candidates.0.content.parts.0.text'
    };
    // note: "$MODEL" satisfies the validator inside generationConfig too
    expect(validateSpec(spec).ok).toBe(true);
    const { url, body } = adapterFromSpec(spec).buildRequest(REQ);
    expect(url).toContain('?key=sk-x');
    expect(body.systemInstruction.parts[0].text).toBe('You are a tutor.');
    expect(body.generationConfig.temperature).toBe(0.4);
    expect(Array.isArray(body.contents)).toBe(true);
  });
});
