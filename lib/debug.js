/**
 * Copilot debug logging helpers.
 * Loaded in sidebar/content/background contexts.
 */
(function (root) {
  'use strict';

  const PREFIX = '[ETH Copilot Debug]';
  const MAX_STRING = 200000;

  function enabled() {
    try {
      const ls = root.localStorage;
      if (ls && ls.getItem('eth-copilot-debug') === '0') return false;
    } catch {}
    return true;
  }

  function clipString(value) {
    if (typeof value !== 'string') return value;
    if (value.length <= MAX_STRING) return value;
    return value.slice(0, MAX_STRING) + `\n...[truncated ${value.length - MAX_STRING} chars]`;
  }

  function sanitize(value, seen = new WeakSet()) {
    if (value == null) return value;
    if (typeof value === 'string') return clipString(value);
    if (typeof value !== 'object') return value;
    if (seen.has(value)) return '[Circular]';
    seen.add(value);

    if (Array.isArray(value)) return value.map(v => sanitize(v, seen));

    const out = {};
    for (const [key, val] of Object.entries(value)) {
      if (/api[-_]?key|authorization|x-api-key|bearer/i.test(key)) {
        out[key] = val ? '[REDACTED]' : val;
      } else if (key === 'imageBase64') {
        out[key] = typeof val === 'string' ? `[base64 ${val.length} chars]` : sanitize(val, seen);
      } else if (key === 'images' && Array.isArray(val)) {
        out[key] = val.map(img => typeof img === 'string' ? `[image ${img.length} chars]` : sanitize(img, seen));
      } else {
        out[key] = sanitize(val, seen);
      }
    }
    return out;
  }

  function log(event, data) {
    if (!enabled()) return;
    try {
      console.log(`${PREFIX} ${event}`, sanitize(data));
    } catch (err) {
      console.log(`${PREFIX} ${event}`, data);
    }
  }

  function warn(event, data) {
    if (!enabled()) return;
    try {
      console.warn(`${PREFIX} ${event}`, sanitize(data));
    } catch {
      console.warn(`${PREFIX} ${event}`, data);
    }
  }

  function error(event, data) {
    if (!enabled()) return;
    try {
      console.error(`${PREFIX} ${event}`, sanitize(data));
    } catch {
      console.error(`${PREFIX} ${event}`, data);
    }
  }

  root.CopilotDebug = { enabled, log, warn, error, sanitize };
})(typeof globalThis !== 'undefined' ? globalThis : this);
