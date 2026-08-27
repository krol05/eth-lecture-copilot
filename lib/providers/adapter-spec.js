/**
 * lib/providers/adapter-spec.js
 * L2 custom-API layer (M3): interprets a declarative JSON "adapter spec" into
 * a full adapter object with the same interface as lib/providers/adapters.js.
 * Lets users wire up APIs whose shape none of the built-in adapters speak,
 * without waiting for an extension update. Pure and unit-tested.
 *
 * Spec format (stored in chrome.storage.local.adapterSpecs[providerId]):
 * {
 *   "endpoint": "/chat/completions",          // appended to the provider base URL
 *   "auth": {"type": "bearer"}                 // Authorization: Bearer <key>
 *         | {"type": "header", "name": "x-api-key"}
 *         | {"type": "query",  "name": "key"}  // ?key=<key> on the URL
 *         | {"type": "none"},
 *   "headers": {"some-header": "value"},       // static extra headers (optional)
 *   "body": { ...template... },                // request body template
 *   "textPath": "choices.0.message.content",   // where the answer text lives
 *   "ssePath": "choices.0.delta.content",      // where stream deltas live
 *   "errorPath": "error.message",              // where error text lives (optional)
 *   "models": {                                // live model listing (optional)
 *     "endpoint": "/models", "listPath": "data", "idPath": "id"
 *   }
 * }
 *
 * Body template placeholders (exact string values, replaced on build):
 *   "$MODEL"        the model id
 *   "$SYSTEM"       the system prompt string
 *   "$MESSAGES"     the conversation as OpenAI-style [{role, content}]
 *   "$STREAM"       boolean stream flag
 *   "$TEMPERATURE"  temperature (key is dropped when not set)
 *   "$MAX_TOKENS"   token cap (key is dropped when not set)
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined') module.exports = api;
  if (root) Object.assign(root, api);
})(typeof self !== 'undefined' ? self : this, function () {

  const AUTH_TYPES = ['bearer', 'header', 'query', 'none'];

  function getPath(obj, path) {
    if (!path) return undefined;
    let cur = obj;
    for (const seg of String(path).split('.')) {
      if (cur == null) return undefined;
      cur = cur[seg];
    }
    return cur;
  }

  /** Validate a spec object. Returns { ok, errors: [string] }. */
  function validateSpec(spec) {
    const errors = [];
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
      return { ok: false, errors: ['Spec must be a JSON object'] };
    }
    if (typeof spec.endpoint !== 'string' || !spec.endpoint.startsWith('/')) {
      errors.push('"endpoint" must be a string starting with "/" (e.g. "/chat/completions")');
    }
    if (!spec.auth || typeof spec.auth !== 'object' || !AUTH_TYPES.includes(spec.auth.type)) {
      errors.push(`"auth.type" must be one of: ${AUTH_TYPES.join(', ')}`);
    } else if ((spec.auth.type === 'header' || spec.auth.type === 'query') && !spec.auth.name) {
      errors.push(`"auth.name" is required for auth type "${spec.auth.type}"`);
    }
    if (!spec.body || typeof spec.body !== 'object' || Array.isArray(spec.body)) {
      errors.push('"body" must be a JSON object (the request body template)');
    } else {
      const flat = JSON.stringify(spec.body);
      if (!flat.includes('"$MESSAGES"')) errors.push('"body" must use "$MESSAGES" somewhere (or the model gets no input)');
      if (!flat.includes('"$MODEL"')) errors.push('"body" should use "$MODEL" so the selected model is sent');
    }
    if (typeof spec.textPath !== 'string' || !spec.textPath) {
      errors.push('"textPath" is required (e.g. "choices.0.message.content")');
    }
    if (spec.ssePath != null && typeof spec.ssePath !== 'string') {
      errors.push('"ssePath" must be a string when present');
    }
    if (spec.headers != null && (typeof spec.headers !== 'object' || Array.isArray(spec.headers))) {
      errors.push('"headers" must be an object mapping header names to values');
    }
    if (spec.models != null) {
      if (typeof spec.models !== 'object' || typeof spec.models.endpoint !== 'string') {
        errors.push('"models.endpoint" must be a string when "models" is present');
      }
    }
    return { ok: errors.length === 0, errors };
  }

  function substitute(node, values) {
    if (Array.isArray(node)) {
      return node.map(item => substitute(item, values)).filter(v => v !== undefined);
    }
    if (node && typeof node === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(node)) {
        const sub = substitute(v, values);
        if (sub !== undefined) out[k] = sub;
      }
      return out;
    }
    if (typeof node === 'string' && Object.prototype.hasOwnProperty.call(values, node)) {
      return values[node]; // may be undefined → key dropped by the caller above
    }
    return node;
  }

  /** Build a full adapter (same interface as Adapters.*) from a valid spec. */
  function adapterFromSpec(spec) {
    function authApply(url, headers, apiKey) {
      const auth = spec.auth || { type: 'none' };
      if (!apiKey || auth.type === 'none') return url;
      if (auth.type === 'bearer') { headers['Authorization'] = `Bearer ${apiKey}`; return url; }
      if (auth.type === 'header') { headers[auth.name] = apiKey; return url; }
      if (auth.type === 'query') {
        const sep = url.includes('?') ? '&' : '?';
        return `${url}${sep}${encodeURIComponent(auth.name)}=${encodeURIComponent(apiKey)}`;
      }
      return url;
    }

    return {
      buildRequest(req) {
        const messages = [
          ...(req.system ? [{ role: 'system', content: req.system }] : []),
          ...req.messages.map(m => ({ role: m.role, content: m.content }))
        ];
        const body = substitute(spec.body, {
          '$MODEL': req.model,
          '$SYSTEM': req.system,
          '$MESSAGES': messages,
          '$STREAM': !!req.stream,
          '$TEMPERATURE': typeof req.temperature === 'number' ? req.temperature : undefined,
          '$MAX_TOKENS': req.maxTokens || undefined
        });
        const headers = Object.assign(
          { 'Content-Type': 'application/json' },
          spec.headers || {},
          req.extraHeaders || {}
        );
        const url = authApply(
          `${String(req.base || '').replace(/\/+$/, '')}${spec.endpoint}`,
          headers,
          req.apiKey
        );
        return { url, headers, body };
      },

      parseResponse(d) {
        const errText = spec.errorPath ? getPath(d, spec.errorPath) : undefined;
        if (typeof errText === 'string' && errText) {
          return { text: '', error: { message: errText, code: null, raw: d } };
        }
        const text = getPath(d, spec.textPath);
        return { text: typeof text === 'string' ? text : '' };
      },

      parseSSEEvent(ev) {
        const errText = spec.errorPath ? getPath(ev, spec.errorPath) : undefined;
        if (typeof errText === 'string' && errText) {
          return { error: { message: errText, code: null, raw: ev } };
        }
        const delta = getPath(ev, spec.ssePath || spec.textPath);
        return typeof delta === 'string' && delta ? { textDelta: delta } : {};
      },

      buildModelsRequest(req) {
        if (!spec.models || !spec.models.endpoint) return null;
        const headers = {};
        const url = authApply(
          `${String(req.base || '').replace(/\/+$/, '')}${spec.models.endpoint}`,
          headers,
          req.apiKey
        );
        return { url, headers };
      },

      parseModelsResponse(d) {
        if (!spec.models) return [];
        const list = getPath(d, spec.models.listPath || 'data');
        if (!Array.isArray(list)) return [];
        const idPath = spec.models.idPath || 'id';
        return list
          .map(item => ({ id: getPath(item, idPath) }))
          .filter(m => typeof m.id === 'string' && m.id)
          .map(m => ({ id: m.id, label: m.id }));
      }
    };
  }

  return { validateSpec, adapterFromSpec, getSpecPath: getPath };
});
