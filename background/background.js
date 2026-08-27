/**
 * background.js — Service Worker
 * Handles all cross-origin AI API calls via message passing from content/sidebar
 * scripts. Provider data lives in lib/providers/catalog.js; wire formats live in
 * lib/providers/adapters.js — this file only does networking, aborts and routing.
 *
 * Message protocol (unchanged from the pre-refactor version, plus ABORT_REQUEST):
 *   request:  { type, provider, model?, apiKey?, localBase?, _copilotRequestId?, ... }
 *   response: { success: true, data }
 *           | { success: false, error: <string>, errorDetail: <structured error> }
 *
 * Structured error shape (errorDetail — consumed by the error panel):
 *   { status, provider, model, code, message, raw, timestamp }
 *   status: HTTP status (null for network/abort/timeout), raw: parsed JSON error
 *   body when the provider sent one (never discarded).
 */

importScripts(
  chrome.runtime.getURL('lib/debug.js'),
  chrome.runtime.getURL('lib/guide-parse.js'),
  chrome.runtime.getURL('lib/providers/catalog.js'),
  chrome.runtime.getURL('lib/providers/adapters.js'),
  chrome.runtime.getURL('lib/providers/overrides.js'),
  chrome.runtime.getURL('lib/providers/adapter-spec.js')
);

// ─── Structured errors ───────────────────────────────────────────────────────

function apiError({ status = null, provider = null, model = null, code = null, message, raw = null }) {
  const err = new Error(message);
  err.details = { status, provider, model, code, message, raw, timestamp: Date.now() };
  return err;
}

/** Wrap any thrown value so the response always carries a full errorDetail. */
function ensureDetails(err, provider, model) {
  if (err?.details) return err;
  const message = err?.message || String(err);
  const code = err?.name === 'TimeoutError' ? 'timeout'
             : err?.name === 'AbortError'   ? 'aborted'
             : null;
  return apiError({ provider, model, code, message });
}

// ─── Abort registry (Bug A: Stop now really cancels the fetch) ───────────────

const activeRequests = new Map(); // requestId → AbortController

function abortRequest(requestId) {
  const controller = activeRequests.get(requestId);
  if (!controller) return false;
  controller.abort();
  activeRequests.delete(requestId);
  return true;
}

// ─── Progress / stream messaging back to the sidebar ─────────────────────────

function emitApiProgress(sender, requestId, stage, detail = '') {
  globalThis.CopilotDebug?.log('background.progress', { requestId, stage, detail });
  const tabId = sender?.tab?.id;
  if (!tabId || !requestId) return;
  chrome.tabs.sendMessage(tabId, { type: 'API_PROGRESS', requestId, stage, detail }).catch(() => {});
}

function emitStreamChunk(sender, requestId, text) {
  const tabId = sender?.tab?.id;
  if (!tabId || !requestId) return;
  chrome.tabs.sendMessage(tabId, { type: 'API_STREAM_CHUNK', requestId, text }).catch(() => {});
}

// ─── SSE reader ──────────────────────────────────────────────────────────────
// Handler exceptions propagate (that's how mid-stream provider errors abort the
// request). Comment/keep-alive lines and [DONE] are filtered here.

async function readSSEStream(resp, onEvent) {
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const handleLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('data: ') || trimmed === 'data: [DONE]') return;
    let json;
    try {
      json = JSON.parse(trimmed.slice(6));
    } catch (err) {
      globalThis.CopilotDebug?.warn('background.sse.parseError', { line: trimmed, error: err.message });
      return;
    }
    onEvent(json);
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop(); // keep incomplete last line
      for (const line of lines) handleLine(line);
    }
    if (buf.trim()) handleLine(buf);
  } finally {
    reader.releaseLock();
  }
}

// ─── The one request pipeline (stream and non-stream, all providers) ─────────

/** Load the user's provider customizations (M3). */
function loadProviderStore() {
  return new Promise(resolve => {
    try {
      chrome.storage.local.get(['providerOverrides', 'customProviders', 'adapterSpecs'], r => resolve(r || {}));
    } catch { resolve({}); }
  });
}

function resolveProviderConfig(providerId, store) {
  const p = resolveProvider(providerId, store); // catalog ⊕ override ⊕ custom
  if (p) return p;
  // Forward-compatible: any unknown local_* id is a keyless OAI-compat server
  if (String(providerId || '').startsWith('local_')) {
    return { id: providerId, adapter: 'oai', kind: 'local', noAuth: true, base: '' };
  }
  return null;
}

function adapterFor(providerId, p, store) {
  const spec = store.adapterSpecs?.[providerId];
  if (spec) {
    const { ok } = validateSpec(spec);
    if (ok) return adapterFromSpec(spec);
    globalThis.CopilotDebug?.warn('background.adapterSpec.invalid', { providerId });
  }
  return Adapters[p.adapter];
}

async function runModelRequest(cfg) {
  const {
    provider, model, apiKey, localBase, system, messages,
    stream = false, jsonMode = false, thinking = 'none',
    temperature, maxTokens, timeoutMs,
    requestId = null, sender = null, onProgress = () => {}
  } = cfg;

  const store = await loadProviderStore();
  const p = resolveProviderConfig(provider, store);
  if (!p) throw apiError({ provider, model, code: 'unknown_provider', message: `Unknown provider: ${provider}` });

  const base = p.kind === 'local' ? String(localBase || p.base).replace(/\/+$/, '') : p.base;
  if (!base) throw apiError({ provider, model, code: 'missing_base', message: 'Missing base URL for local provider' });

  const adapter = adapterFor(provider, p, store);
  // Custom endpoints may be authenticated anywhere (incl. localhost). Catalog
  // locals stay keyless: the stored apiKey belongs to whatever cloud provider
  // was configured before and must not leak to a local server.
  const request = adapter.buildRequest({
    base, model, apiKey: p.kind === 'local' ? null : apiKey,
    system, messages, stream, jsonMode, thinking, temperature, maxTokens,
    quirks: p.quirks,
    extraHeaders: p.headers
  });
  globalThis.CopilotDebug?.log('background.request', { requestId, provider, model, url: request.url, stream, body: request.body });

  const controller = new AbortController();
  if (requestId) activeRequests.set(requestId, controller);
  // Bug C (background half): a real deadline on the same controller means the
  // promise always settles — no more forever-pending generations.
  const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? setTimeout(() => controller.abort(new DOMException(`No response within ${Math.round(timeoutMs / 1000)}s`, 'TimeoutError')), timeoutMs)
    : null;

  try {
    onProgress('request_sent', request.url);
    let resp;
    try {
      resp = await fetch(request.url, {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify(request.body),
        signal: controller.signal
      });
    } catch (err) {
      // fetch rejects with the abort reason when controller.abort(reason) fired
      const reason = controller.signal.aborted ? (controller.signal.reason || err) : err;
      throw ensureDetails(reason, provider, model);
    }
    onProgress('provider_responding', String(resp.status));

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      let raw = null;
      try { raw = JSON.parse(text); } catch { /* non-JSON error body */ }
      const parsed = raw ? adapter.parseResponse(raw) : null;
      throw apiError({
        status: resp.status, provider, model,
        code: parsed?.error?.code ?? null,
        message: parsed?.error?.message || `HTTP ${resp.status} from ${request.url}`,
        raw: raw ?? (text || null)
      });
    }

    if (!stream) {
      const d = await resp.json();
      const parsed = adapter.parseResponse(d);
      if (parsed.error) {
        throw apiError({ status: resp.status, provider, model, code: parsed.error.code ?? null, message: parsed.error.message, raw: parsed.error.raw });
      }
      globalThis.CopilotDebug?.log('background.response', { requestId, provider, model, text: parsed.text, stopReason: parsed.stopReason });
      return parsed.text;
    }

    let fullText = '';
    await readSSEStream(resp, (ev) => {
      const r = adapter.parseSSEEvent(ev);
      if (r.error) {
        throw apiError({ status: resp.status, provider, model, code: r.error.code ?? null, message: r.error.message, raw: r.error.raw });
      }
      if (r.textDelta) {
        fullText += r.textDelta;
        emitStreamChunk(sender, requestId, r.textDelta);
      }
    });
    globalThis.CopilotDebug?.log('background.stream.complete', { requestId, provider, model, length: fullText.length });
    return fullText;
  } catch (err) {
    throw ensureDetails(err, provider, model);
  } finally {
    if (timer) clearTimeout(timer);
    if (requestId) activeRequests.delete(requestId);
  }
}

// ─── JSON salvage for tool responses (guide uses parseGuideResponse) ─────────

function safeParseJson(raw, debugMeta = {}) {
  if (typeof raw === 'object' && raw !== null) return raw;
  const s = String(raw || '');
  try { return JSON.parse(s); } catch { /* try stripped */ }
  const stripped = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  try { return JSON.parse(stripped); } catch { /* try sliced */ }
  const start = Math.min(
    s.indexOf('{') >= 0 ? s.indexOf('{') : Infinity,
    s.indexOf('[') >= 0 ? s.indexOf('[') : Infinity
  );
  if (start < Infinity) {
    try { return JSON.parse(s.slice(start)); } catch { /* give up below */ }
  }
  globalThis.CopilotDebug?.error('background.safeParseJson.giveUp', { ...debugMeta, raw: s });
  throw new Error('Failed to parse JSON from AI response: ' + s.slice(0, 200));
}

// ─── Message dispatch ────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  globalThis.CopilotDebug?.log('background.onMessage', { type: message?.type, requestId: message?._copilotRequestId });

  if (message?.type === 'OPEN_OPTIONS') {
    chrome.runtime.openOptionsPage();
    sendResponse({ success: true });
    return;
  }

  if (message?.type === 'ABORT_REQUEST') {
    sendResponse({ success: true, data: { aborted: abortRequest(message.requestId) } });
    return;
  }

  if (message?.type === 'CAPTURE_VISIBLE_TAB') {
    const wid = sender?.tab?.windowId ?? null;
    chrome.tabs.captureVisibleTab(wid, { format: 'jpeg', quality: 85 })
      .then(dataUrl => sendResponse({ success: true, data: dataUrl }))
      .catch(err => sendResponse({ success: false, error: err.message, errorDetail: ensureDetails(err).details }));
    return true;
  }

  const requestId = message?._copilotRequestId || null;
  const progress = (stage, detail = '') => emitApiProgress(sender, requestId, stage, detail);
  handleMessage(message, progress, sender, requestId).then(
    result => sendResponse({ success: true, data: result }),
    err => {
      const details = ensureDetails(err, message?.provider, message?.model).details;
      globalThis.CopilotDebug?.error('background.onMessage.error', { requestId, type: message?.type, details });
      sendResponse({ success: false, error: details.message, errorDetail: details });
    }
  );
  return true; // keep the SW alive until sendResponse
});

async function handleMessage(msg, progress = () => {}, sender = null, requestId = null) {
  if (msg.type === 'PING') return 'pong';

  const { type, provider, apiKey, localBase } = msg;
  const model = msg.model || Catalog.defaultModel(provider);

  // Shared plumbing for every AI call
  const run = (extra) => runModelRequest({
    provider, model, apiKey, localBase, requestId, sender, onProgress: progress, ...extra
  });

  switch (type) {

    case 'DISCOVER_LOCAL_MODELS': {
      // All OAI-compat runtimes expose GET {base}/models
      const base = String(msg.localBase || '').trim().replace(/\/+$/, '');
      if (!base) throw apiError({ provider, code: 'missing_base', message: 'localBase required for model discovery' });
      const req = Adapters.oai.buildModelsRequest({ base, apiKey: null });
      const resp = await fetch(req.url, { headers: req.headers, signal: AbortSignal.timeout(4000) });
      if (!resp.ok) throw apiError({ status: resp.status, provider, message: `Server at ${base} returned ${resp.status}` });
      const ids = Adapters.oai.parseModelsResponse(await resp.json()).map(m => m.id);
      if (!ids.length) throw apiError({ provider, code: 'no_models', message: `No models reported by ${base}` });
      return ids;
    }

    case 'GENERATE_GUIDE': {
      progress('queued', 'Guide request received');
      const useFallback = !!msg.guideFallback;
      const raw = await run({
        system: msg.systemPrompt,
        messages: [{ role: 'user', content: msg.transcriptText }],
        stream: !!msg.useStream,
        jsonMode: true,
        temperature: useFallback ? (provider === 'google' ? 0.22 : 0.1)
                                 : (msg.guideTemperature ?? (provider === 'google' ? 0.22 : 0.1)),
        thinking: useFallback ? 'none' : (msg.guideThinking || 'none'),
        // No client-side token tables: only an explicit user setting is sent
        maxTokens: Number.isFinite(msg.guideMaxTokens) && msg.guideMaxTokens > 0 ? msg.guideMaxTokens : undefined,
        timeoutMs: 600000
      });
      progress('provider_finished', 'Response body received');
      return parseGuideResponse(raw);
    }

    case 'CHAT': {
      return run({
        system: msg.systemPrompt,
        messages: msg.messages,
        stream: !!msg.useStream,
        temperature: msg.chatTemperature ?? 0.35,
        thinking: msg.chatThinking || 'none',
        timeoutMs: 120000
      });
    }

    case 'FLASHCARDS_REQUEST':
    case 'QUIZ_REQUEST':
    case 'EXAM_QUESTIONS_REQUEST':
    case 'CROSS_LECTURE_EXAM_REQUEST': {
      const temperature = type === 'FLASHCARDS_REQUEST' || type === 'QUIZ_REQUEST' ? 0.45 : 0.5;
      const raw = await run({
        system: msg.systemPrompt,
        messages: [{ role: 'user', content: JSON.stringify(msg.guideJson ?? msg.guidesJson) }],
        jsonMode: true,
        temperature,
        timeoutMs: type === 'CROSS_LECTURE_EXAM_REQUEST' ? 180000 : 120000
      });
      return safeParseJson(raw, { type, requestId });
    }

    case 'FETCH_VTT': {
      const resp = await fetch(msg.url, { signal: AbortSignal.timeout(45000) });
      if (!resp.ok) throw apiError({ status: resp.status, message: `VTT fetch failed: ${resp.status}` });
      return resp.text();
    }

    case 'FETCH_JSON': {
      const resp = await fetch(msg.url, { signal: AbortSignal.timeout(45000) });
      if (!resp.ok) throw apiError({ status: resp.status, message: `JSON fetch failed: ${resp.status}` });
      return resp.json();
    }

    default:
      throw apiError({ code: 'unknown_message', message: `Unknown message type: ${type}` });
  }
}
