/**
 * lib/error-format.js — formatting of structured API errors.
 * Fixtures are real provider error envelopes from docs/providers/*.md.
 */
const { formatError } = require('../lib/error-format.js');

const T = 1756000000000;

describe('formatError with real provider fixtures', () => {
  test('Anthropic overloaded (529)', () => {
    const f = formatError({
      status: 529, provider: 'anthropic', model: 'claude-sonnet-5',
      code: 'overloaded_error', message: 'Overloaded',
      raw: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
      timestamp: T
    });
    expect(f.title).toBe('anthropic: Provider overloaded (HTTP 529)');
    expect(f.summary).toBe('Overloaded');
    expect(f.hint).toContain('retry');
    const rawSection = f.sections.find(s => s.label === 'Provider response');
    expect(rawSection.content).toContain('"overloaded_error"');
    expect(f.timestamp).toBe(T);
  });

  test('OpenAI invalid API key (401)', () => {
    const f = formatError({
      status: 401, provider: 'openai', model: 'gpt-5.6-terra',
      code: 'invalid_api_key', message: 'Incorrect API key provided: sk-...',
      raw: { error: { message: 'Incorrect API key provided: sk-...', type: 'invalid_request_error', param: null, code: 'invalid_api_key' } },
      timestamp: T
    });
    expect(f.title).toBe('openai: Authentication failed (HTTP 401)');
    expect(f.hint).toContain('API key');
    expect(f.hint).toContain('openai');
  });

  test('Google invalid key (400 INVALID_ARGUMENT)', () => {
    const f = formatError({
      status: 400, provider: 'google', model: 'gemini-2.5-flash',
      code: 'INVALID_ARGUMENT', message: 'API key not valid. Please pass a valid API key.',
      raw: { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } },
      timestamp: T
    });
    // 400 isn't an auth status, but the request metadata and raw body are all there
    expect(f.summary).toContain('API key not valid');
    const meta = f.sections.find(s => s.label === 'Request');
    expect(meta.content).toContain('model: gemini-2.5-flash');
    expect(meta.content).toContain('HTTP status: 400');
    expect(meta.content).toContain('code: INVALID_ARGUMENT');
  });

  test('DeepSeek insufficient balance (402)', () => {
    const f = formatError({
      status: 402, provider: 'deepseek', model: 'deepseek-v4-flash',
      code: null, message: 'Insufficient Balance', raw: { error: { message: 'Insufficient Balance' } }, timestamp: T
    });
    expect(f.title).toContain('Out of credits');
    expect(f.hint).toContain('deepseek');
  });

  test('retired model 404 suggests picking a current ID', () => {
    const f = formatError({
      status: 404, provider: 'deepseek', model: 'deepseek-chat',
      code: 'model_not_found', message: 'Model Not Exist', raw: null, timestamp: T
    });
    expect(f.title).toContain('Model not available');
    expect(f.hint).toContain('deepseek-chat');
    expect(f.hint).toContain('model ID');
  });

  test('rate limit (429)', () => {
    const f = formatError({ status: 429, provider: 'groq', model: 'openai/gpt-oss-120b', code: 'rate_limit_exceeded', message: 'Rate limit reached', raw: null, timestamp: T });
    expect(f.title).toContain('Rate limited');
  });

  test('timeout and user abort get distinct classes', () => {
    const timeout = formatError({ status: null, provider: 'openai', model: 'gpt-5', code: 'timeout', message: 'No response within 600s', raw: null, timestamp: T });
    expect(timeout.title).toBe('openai: Timeout');
    expect(timeout.hint).toContain('did not answer');

    const aborted = formatError({ status: null, provider: 'openai', model: 'gpt-5', code: 'aborted', message: 'The user aborted a request.', raw: null, timestamp: T });
    expect(aborted.title).toBe('openai: Stopped');
    expect(aborted.hint).toBe('');
  });

  test('Ollama unreachable includes the OLLAMA_ORIGINS hint', () => {
    const f = formatError({ status: null, provider: 'local_ollama', model: 'llama3', code: null, message: 'Failed to fetch', raw: null, timestamp: T });
    expect(f.title).toContain('Local server unreachable');
    expect(f.hint).toContain('OLLAMA_ORIGINS');
    // other local servers get the generic local hint without Ollama specifics
    const lm = formatError({ status: null, provider: 'local_lmstudio', model: 'x', code: null, message: 'Failed to fetch', raw: null, timestamp: T });
    expect(lm.hint).not.toContain('OLLAMA_ORIGINS');
  });

  test('Google safety block', () => {
    const f = formatError({ status: 200, provider: 'google', model: 'gemini-2.5-flash', code: 'SAFETY', message: 'Request blocked: SAFETY', raw: { promptFeedback: { blockReason: 'SAFETY' } }, timestamp: T });
    expect(f.title).toContain('Content blocked');
  });

  test('unparseable model output', () => {
    const f = formatError({ status: null, provider: 'openrouter', model: 'meta-llama/llama-4-maverick', code: null, message: 'Failed to parse JSON from AI response: not json at all', raw: null, timestamp: T });
    expect(f.title).toContain('Unusable response');
    expect(f.hint).toContain('JSON');
  });
});

describe('formatError robustness', () => {
  test('string raw that is JSON gets pretty-printed; non-JSON passes through', () => {
    const pretty = formatError({ status: 500, provider: 'x', model: 'y', code: null, message: 'boom', raw: '{"error":{"message":"boom"}}', timestamp: T });
    expect(pretty.sections.find(s => s.label === 'Provider response').content).toContain('\n');
    const plain = formatError({ status: 500, provider: 'x', model: 'y', code: null, message: 'boom', raw: '<html>Bad gateway</html>', timestamp: T });
    expect(plain.sections.find(s => s.label === 'Provider response').content).toBe('<html>Bad gateway</html>');
  });

  test('null/empty details never throw and still produce a title', () => {
    expect(formatError(null).title).toBe('API: Request failed');
    expect(formatError({}).summary).toBe('Unknown error');
    expect(formatError({}).timestamp).toBe(0);
  });

  test('nothing is discarded: raw always appears when present', () => {
    const f = formatError({ status: 418, provider: 'p', model: 'm', code: 'teapot', message: 'I am a teapot', raw: { any: { deeply: ['nested', 'thing'] } }, timestamp: T });
    expect(f.sections.find(s => s.label === 'Provider response').content).toContain('nested');
  });
});

describe('vision errors point at a model that can actually read images', () => {
  const T2 = 1756000000000;

  test('DeepSeek names its one vision model', () => {
    const f = formatError({
      status: 400, provider: 'deepseek', model: 'deepseek-v4-pro', code: null,
      message: 'This model does not support image', raw: { error: { message: 'This model does not support image' } }, timestamp: T2
    });
    expect(f.title).toContain("Model can't read images");
    expect(f.hint).toContain('deepseek-v4-flash-vision-exp');
    expect(f.summary).toBe('This model does not support image');
  });

  test('unknown providers still get usable advice', () => {
    const f = formatError({
      status: 400, provider: 'someprovider', model: 'text-only-1', code: null,
      message: 'model does not support vision', raw: null, timestamp: T2
    });
    expect(f.hint).toContain('vision-capable model');
  });
});

describe('a missing host grant is not an auth failure', () => {
  // The auth branch matches code.includes('permission'), so without an earlier
  // case "permission_missing" told users their API key was rejected and sent
  // them to re-check a key that was never the problem.
  const detail = {
    status: null, provider: 'groq', model: 'llama-4',
    code: 'permission_missing',
    message: 'This extension does not have permission to contact api.groq.com yet.',
    raw: { origin: 'https://api.groq.com/*', host: 'api.groq.com' },
    timestamp: 0
  };

  test('is classified as an access problem', () => {
    const out = formatError(detail);
    expect(out.title).toMatch(/access/i);
    expect(out.title).not.toMatch(/authentication/i);
  });

  test('names the host and does not blame the API key', () => {
    const { hint } = formatError(detail);
    expect(hint).toContain('api.groq.com');
    expect(hint).not.toMatch(/api key/i);
  });
});

describe('lecture data blocked after a redirect', () => {
  // dist.tobira.ethz.ch 302s to dist02.tobira.ethz.ch. The permission check
  // runs against the URL we request, so a redirect to an ungranted host slips
  // past it and arrives as a bare CORS "Failed to fetch" with no clue.
  test('points at the redirect rather than blaming the connection', () => {
    const out = formatError({
      status: null, provider: 'transcript', model: null,
      code: 'transcript_fetch_failed',
      message: 'Failed to fetch',
      raw: { url: 'https://dist.tobira.ethz.ch/mh_default_org/engage-player/x/data.json' },
      timestamp: 0
    });
    expect(out.hint).toMatch(/redirect/i);
    expect(out.hint).not.toMatch(/check your connection/i);
  });
});
