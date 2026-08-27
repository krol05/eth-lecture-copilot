/**
 * background/background.js — message routing, aborts, timeouts, structured
 * errors and the model cache, exercised in a fake service worker (no browser,
 * no API keys). These cover the M2–M4 paths that can't be checked by hand
 * without a provider account.
 */
const { loadServiceWorker, jsonResponse, sseResponse } = require('./helpers/service-worker.js');

const CHAT = {
  type: 'CHAT',
  provider: 'openai',
  model: 'gpt-4o',
  apiKey: 'sk-test',
  systemPrompt: 'You are a tutor.',
  messages: [{ role: 'user', content: 'Hi' }],
  _copilotRequestId: 'req_1'
};

function okChat(text) {
  return () => Promise.resolve(jsonResponse({ choices: [{ message: { content: text }, finish_reason: 'stop' }] }));
}

describe('message routing', () => {
  test('PING answers pong; unknown types fail with a structured error', async () => {
    const sw = loadServiceWorker();
    expect(await sw.send({ type: 'PING' })).toEqual({ success: true, data: 'pong' });

    const res = await sw.send({ type: 'NOT_A_REAL_TYPE' });
    expect(res.success).toBe(false);
    expect(res.errorDetail.code).toBe('unknown_message');
    expect(res.errorDetail.message).toContain('NOT_A_REAL_TYPE');
  });

  test('CHAT sends the adapter request and returns the text', async () => {
    const sw = loadServiceWorker({ fetchImpl: okChat('Hello there') });
    const res = await sw.send(CHAT);
    expect(res).toEqual({ success: true, data: 'Hello there' });

    const [url, init] = sw.fetchCalls[0];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(init.headers['Authorization']).toBe('Bearer sk-test');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('gpt-4o');
    expect(body.messages[0]).toEqual({ role: 'system', content: 'You are a tutor.' });
    expect(body.stream).toBeUndefined();
  });

  test('unknown provider is rejected before any network call', async () => {
    const sw = loadServiceWorker();
    const res = await sw.send({ ...CHAT, provider: 'does_not_exist' });
    expect(res.success).toBe(false);
    expect(res.errorDetail.code).toBe('unknown_provider');
    expect(sw.fetchCalls).toHaveLength(0);
  });
});

describe('structured errors (never generic)', () => {
  test('HTTP error keeps status, provider, model and the raw provider body', async () => {
    const raw = { error: { message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key' } };
    const sw = loadServiceWorker({ fetchImpl: () => Promise.resolve(jsonResponse(raw, { status: 401 })) });

    const res = await sw.send(CHAT);
    expect(res.success).toBe(false);
    const d = res.errorDetail;
    expect(d.status).toBe(401);
    expect(d.provider).toBe('openai');
    expect(d.model).toBe('gpt-4o');
    expect(d.code).toBe('invalid_api_key');
    expect(d.message).toBe('Incorrect API key provided');
    expect(d.raw).toEqual(raw);       // nothing discarded
    expect(typeof d.timestamp).toBe('number');
  });

  test('non-JSON error body is preserved verbatim', async () => {
    const sw = loadServiceWorker({ fetchImpl: () => Promise.resolve(jsonResponse('<html>Bad Gateway</html>', { status: 502 })) });
    const res = await sw.send(CHAT);
    expect(res.errorDetail.status).toBe(502);
    expect(res.errorDetail.raw).toBe('<html>Bad Gateway</html>');
  });

  test('network failure surfaces as a structured error with no status', async () => {
    const sw = loadServiceWorker({ fetchImpl: () => Promise.reject(new TypeError('Failed to fetch')) });
    const res = await sw.send(CHAT);
    expect(res.success).toBe(false);
    expect(res.errorDetail.status).toBeNull();
    expect(res.errorDetail.message).toContain('Failed to fetch');
  });

  test('OpenRouter error hidden inside HTTP 200 still fails the request', async () => {
    const sw = loadServiceWorker({
      fetchImpl: () => Promise.resolve(jsonResponse({
        choices: [{ message: { content: '' }, error: { message: 'Upstream provider is down', code: 502 }, finish_reason: 'error' }]
      }))
    });
    const res = await sw.send({ ...CHAT, provider: 'openrouter', model: 'anthropic/claude-sonnet-5' });
    expect(res.success).toBe(false);
    expect(res.errorDetail.message).toBe('Upstream provider is down');
  });
});

describe('streaming', () => {
  const streamChunks = [
    'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n'
  ];

  test('SSE deltas reach the sidebar and concatenate into the result', async () => {
    const sw = loadServiceWorker({ fetchImpl: () => Promise.resolve(sseResponse(streamChunks)) });
    const res = await sw.send({ ...CHAT, useStream: true });
    expect(res).toEqual({ success: true, data: 'Hello' });

    const chunks = sw.sentMessages.filter(m => m.msg.type === 'API_STREAM_CHUNK');
    expect(chunks.map(c => c.msg.text)).toEqual(['Hel', 'lo']);
    expect(chunks.every(c => c.msg.requestId === 'req_1')).toBe(true);
  });

  test('keep-alive comments and split frames do not break parsing', async () => {
    const sw = loadServiceWorker({
      fetchImpl: () => Promise.resolve(sseResponse([
        ': OPENROUTER PROCESSING\n\n',
        'data: {"choices":[{"delta":{"content":"par',      // frame split mid-JSON
        'tial"}}]}\n\n',
        'data: [DONE]\n\n'
      ]))
    });
    const res = await sw.send({ ...CHAT, useStream: true });
    expect(res.data).toBe('partial');
  });

  test('a mid-stream error event fails the request instead of being ignored', async () => {
    const sw = loadServiceWorker({
      fetchImpl: () => Promise.resolve(sseResponse([
        'data: {"choices":[{"delta":{"content":"start"}}]}\n\n',
        'data: {"error":{"message":"Rate limit reached","code":429}}\n\n'
      ]))
    });
    const res = await sw.send({ ...CHAT, useStream: true });
    expect(res.success).toBe(false);
    expect(res.errorDetail.message).toBe('Rate limit reached');
  });

  test('stream requests carry the same body plus the stream flag', async () => {
    const sw = loadServiceWorker({ fetchImpl: () => Promise.resolve(sseResponse(streamChunks)) });
    await sw.send({ ...CHAT, useStream: true });
    expect(JSON.parse(sw.fetchCalls[0][1].body).stream).toBe(true);
  });
});

describe('aborting (bug A) and timeouts (bug C)', () => {
  test('ABORT_REQUEST cancels the in-flight fetch and settles the request', async () => {
    let abortSignal = null;
    const sw = loadServiceWorker({
      fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
        abortSignal = init.signal;
        init.signal.addEventListener('abort', () => reject(init.signal.reason || new Error('aborted')));
      })
    });

    const pending = sw.send({ ...CHAT, _copilotRequestId: 'req_abort' });
    await new Promise(r => setTimeout(r, 10));
    expect(abortSignal.aborted).toBe(false);

    const abortRes = await sw.send({ type: 'ABORT_REQUEST', requestId: 'req_abort' });
    expect(abortRes).toEqual({ success: true, data: { aborted: true } });
    expect(abortSignal.aborted).toBe(true);

    const res = await pending;           // the request settles — never hangs
    expect(res.success).toBe(false);
  });

  test('aborting an unknown request id reports that nothing was cancelled', async () => {
    const sw = loadServiceWorker();
    expect(await sw.send({ type: 'ABORT_REQUEST', requestId: 'nope' }))
      .toEqual({ success: true, data: { aborted: false } });
  });

  test('a provider that never answers times out instead of hanging forever', async () => {
    jest.useFakeTimers();
    try {
      // built after the fake timers are installed, so the worker's deadline
      // timer is the fake one
      const sw = loadServiceWorker({
        fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(init.signal.reason));
        })
      });

      const pending = sw.send(CHAT);
      // async form: lets the worker reach its fetch (and arm the deadline)
      // before the clock jumps
      await jest.advanceTimersByTimeAsync(120000); // CHAT's deadline
      const res = await pending;

      expect(res.success).toBe(false);
      expect(res.errorDetail.code).toBe('timeout');
      expect(res.errorDetail.message).toContain('120s');
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('provider customizations reach the request (M3)', () => {
  test('an override replaces the base URL and adds headers', async () => {
    const sw = loadServiceWorker({
      storage: { providerOverrides: { openai: { baseUrl: 'https://proxy.example.com/v1', headers: { 'X-Team': 'eth' } } } },
      fetchImpl: okChat('ok')
    });
    await sw.send(CHAT);
    const [url, init] = sw.fetchCalls[0];
    expect(url).toBe('https://proxy.example.com/v1/chat/completions');
    expect(init.headers['X-Team']).toBe('eth');
    expect(init.headers['Authorization']).toBe('Bearer sk-test');
  });

  test('a custom provider works and may be authenticated', async () => {
    const sw = loadServiceWorker({
      storage: { customProviders: { custom_uni: { label: 'Uni', baseUrl: 'https://llm.uni.example/v1' } } },
      fetchImpl: okChat('from cluster')
    });
    const res = await sw.send({ ...CHAT, provider: 'custom_uni', model: 'cluster-70b' });
    expect(res.data).toBe('from cluster');
    expect(sw.fetchCalls[0][0]).toBe('https://llm.uni.example/v1/chat/completions');
    expect(sw.fetchCalls[0][1].headers['Authorization']).toBe('Bearer sk-test');
  });

  test('a saved adapter spec replaces the built-in wire format', async () => {
    const sw = loadServiceWorker({
      storage: {
        customProviders: { custom_odd: { label: 'Odd', baseUrl: 'https://odd.example' } },
        adapterSpecs: {
          custom_odd: {
            endpoint: '/generate',
            auth: { type: 'header', name: 'x-token' },
            body: { model_name: '$MODEL', turns: '$MESSAGES' },
            textPath: 'result.answer'
          }
        }
      },
      fetchImpl: () => Promise.resolve(jsonResponse({ result: { answer: 'spec answer' } }))
    });
    const res = await sw.send({ ...CHAT, provider: 'custom_odd', model: 'odd-1' });
    expect(res.data).toBe('spec answer');
    const [url, init] = sw.fetchCalls[0];
    expect(url).toBe('https://odd.example/generate');
    expect(init.headers['x-token']).toBe('sk-test');
    expect(JSON.parse(init.body).model_name).toBe('odd-1');
  });

  test('an invalid spec falls back to the built-in adapter instead of breaking', async () => {
    const sw = loadServiceWorker({
      storage: { adapterSpecs: { openai: { endpoint: 'broken', auth: { type: 'nope' } } } },
      fetchImpl: okChat('fallback worked')
    });
    const res = await sw.send(CHAT);
    expect(res.data).toBe('fallback worked');
    expect(sw.fetchCalls[0][0]).toBe('https://api.openai.com/v1/chat/completions');
  });

  test('a local provider never receives the stored cloud API key', async () => {
    const sw = loadServiceWorker({ fetchImpl: okChat('local reply') });
    await sw.send({ ...CHAT, provider: 'local_ollama', localBase: 'http://localhost:11434/v1', model: 'llama3' });
    expect(sw.fetchCalls[0][1].headers['Authorization']).toBeUndefined();
  });
});

describe('model catalog cache (M4)', () => {
  const modelsBody = { data: [{ id: 'gpt-4o' }, { id: 'gpt-5.6-terra' }, { id: 'legacy-model-still-served' }] };

  test('LIST_MODELS fetches, returns everything unfiltered, and caches it', async () => {
    const sw = loadServiceWorker({ fetchImpl: () => Promise.resolve(jsonResponse(modelsBody)) });
    const res = await sw.send({ type: 'LIST_MODELS', provider: 'openai', apiKey: 'sk-test' });
    expect(res.success).toBe(true);
    expect(res.data.map(m => m.id)).toEqual(['gpt-4o', 'gpt-5.6-terra', 'legacy-model-still-served']);
    expect(sw.store.modelCache.openai.models).toHaveLength(3);
    expect(typeof sw.store.modelCache.openai.fetchedAt).toBe('number');
  });

  test('a fresh cache is served without hitting the network; force refetches', async () => {
    const sw = loadServiceWorker({
      storage: { modelCache: { openai: { models: [{ id: 'cached-model', label: 'cached' }], fetchedAt: Date.now() } } },
      fetchImpl: () => Promise.resolve(jsonResponse(modelsBody))
    });
    const cached = await sw.send({ type: 'LIST_MODELS', provider: 'openai', apiKey: 'sk-test' });
    expect(cached.data.map(m => m.id)).toEqual(['cached-model']);
    expect(sw.fetchCalls).toHaveLength(0);

    const forced = await sw.send({ type: 'LIST_MODELS', provider: 'openai', apiKey: 'sk-test', force: true });
    expect(forced.data).toHaveLength(3);
    expect(sw.fetchCalls).toHaveLength(1);
  });

  test('a stale cache is refreshed automatically', async () => {
    const twoDaysAgo = Date.now() - 48 * 60 * 60 * 1000;
    const sw = loadServiceWorker({
      storage: { modelCache: { openai: { models: [{ id: 'old' }], fetchedAt: twoDaysAgo } } },
      fetchImpl: () => Promise.resolve(jsonResponse(modelsBody))
    });
    const res = await sw.send({ type: 'LIST_MODELS', provider: 'openai', apiKey: 'sk-test' });
    expect(res.data).toHaveLength(3);
    expect(sw.fetchCalls).toHaveLength(1);
  });

  test('providers without a model endpoint say so clearly', async () => {
    const sw = loadServiceWorker();
    const res = await sw.send({ type: 'LIST_MODELS', provider: 'perplexity', apiKey: 'pplx-x' });
    expect(res.success).toBe(false);
    expect(res.errorDetail.code).toBe('no_models_endpoint');
    expect(res.errorDetail.message).toContain('Perplexity');
    expect(sw.fetchCalls).toHaveLength(0);
  });

  test('a failing model list reports the provider status, cache untouched', async () => {
    const sw = loadServiceWorker({ fetchImpl: () => Promise.resolve(jsonResponse({ error: { message: 'bad key' } }, { status: 401 })) });
    const res = await sw.send({ type: 'LIST_MODELS', provider: 'openai', apiKey: 'wrong' });
    expect(res.success).toBe(false);
    expect(res.errorDetail.status).toBe(401);
    expect(sw.store.modelCache).toBeUndefined();
  });

  test('the daily refresh alarm is registered', () => {
    const sw = loadServiceWorker();
    expect(sw.alarms.map(a => a.name)).toContain('refresh-model-cache');
  });
});

describe('guide generation', () => {
  test('GENERATE_GUIDE parses the model output into guide JSON', async () => {
    const guide = { title: 'Fourier', guide: [{ heading: 'Intro', content: 'text' }] };
    const sw = loadServiceWorker({ fetchImpl: () => Promise.resolve(jsonResponse({ choices: [{ message: { content: JSON.stringify(guide) } }] })) });
    const res = await sw.send({
      type: 'GENERATE_GUIDE', provider: 'openai', model: 'gpt-4o', apiKey: 'sk-test',
      transcriptText: 'lecture text', systemPrompt: 'make a guide', _copilotRequestId: 'req_g'
    });
    expect(res.success).toBe(true);
    expect(res.data.title).toBe('Fourier');
  });

  test('guide requests ask for JSON output and report progress', async () => {
    const sw = loadServiceWorker({ fetchImpl: () => Promise.resolve(jsonResponse({ choices: [{ message: { content: '{"guide":[]}' } }] })) });
    await sw.send({
      type: 'GENERATE_GUIDE', provider: 'openai', model: 'gpt-4o', apiKey: 'sk-test',
      transcriptText: 'x', systemPrompt: 'y', _copilotRequestId: 'req_g2'
    });
    expect(JSON.parse(sw.fetchCalls[0][1].body).response_format).toEqual({ type: 'json_object' });
    const stages = sw.sentMessages.filter(m => m.msg.type === 'API_PROGRESS').map(m => m.msg.stage);
    expect(stages).toContain('queued');
    expect(stages).toContain('provider_responding');
  });

  test('no client-side token cap is sent unless the user set one', async () => {
    const sw = loadServiceWorker({ fetchImpl: () => Promise.resolve(jsonResponse({ choices: [{ message: { content: '{"guide":[]}' } }] })) });
    const base = {
      type: 'GENERATE_GUIDE', provider: 'openai', model: 'gpt-4o', apiKey: 'sk-test',
      transcriptText: 'x', systemPrompt: 'y', _copilotRequestId: 'req_g3'
    };
    await sw.send(base);
    expect(JSON.parse(sw.fetchCalls[0][1].body).max_tokens).toBeUndefined();

    await sw.send({ ...base, guideMaxTokens: 12345 });
    expect(JSON.parse(sw.fetchCalls[1][1].body).max_tokens).toBe(12345);
  });
});

describe('study-tool generations (flashcards, quiz, exam)', () => {
  const TOOL = {
    type: 'FLASHCARDS_REQUEST', provider: 'deepseek', model: 'deepseek-v4-pro', apiKey: 'sk-x',
    guideJson: { guide: [{ title: 'Block' }] }, systemPrompt: 'make cards', _copilotRequestId: 'req_t'
  };

  test('tool requests stream, so a slow reasoning model shows progress', async () => {
    const sw = loadServiceWorker({
      fetchImpl: () => Promise.resolve(sseResponse([
        'data: {"choices":[{"delta":{"content":"{\\"cards\\":"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"[]}"}}]}\n\n',
        'data: [DONE]\n\n'
      ]))
    });
    const res = await sw.send(TOOL);
    expect(res.success).toBe(true);
    expect(res.data).toEqual({ cards: [] });
    expect(JSON.parse(sw.fetchCalls[0][1].body).stream).toBe(true);
  });

  test('DeepSeek thinking is switched off explicitly, not left to the model', async () => {
    const sw = loadServiceWorker({ fetchImpl: () => Promise.resolve(sseResponse(['data: {"choices":[{"delta":{"content":"{}"}}]}\n\n', 'data: [DONE]\n\n'])) });
    await sw.send(TOOL);
    expect(JSON.parse(sw.fetchCalls[0][1].body).thinking).toEqual({ type: 'disabled' });
  });

  test('a caller can still ask for a non-streamed tool response', async () => {
    const sw = loadServiceWorker({ fetchImpl: () => Promise.resolve(jsonResponse({ choices: [{ message: { content: '{"cards":[]}' } }] })) });
    const res = await sw.send({ ...TOOL, useStream: false });
    expect(res.success).toBe(true);
    expect(JSON.parse(sw.fetchCalls[0][1].body).stream).toBeUndefined();
  });

  test('unparseable tool output reports what came back', async () => {
    const sw = loadServiceWorker({ fetchImpl: () => Promise.resolve(sseResponse(['data: {"choices":[{"delta":{"content":"sorry, no JSON here"}}]}\n\n', 'data: [DONE]\n\n'])) });
    const res = await sw.send(TOOL);
    expect(res.success).toBe(false);
    expect(res.errorDetail.message).toContain('sorry, no JSON here');
  });
});
