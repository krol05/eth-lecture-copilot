/**
 * tests/helpers/service-worker.js
 * Boots background/background.js inside a fake MV3 service-worker environment
 * so the message routing can be tested in Node — no browser, no API keys.
 *
 * Provides fakes for chrome.{runtime,storage,tabs,alarms}, fetch, and
 * importScripts (which loads the real lib/ modules into the same context, the
 * same way Chrome does).
 *
 * Usage:
 *   const sw = loadServiceWorker({ storage: { provider: 'openai' } });
 *   const res = await sw.send({ type: 'CHAT', ... });
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');

function loadServiceWorker({ storage = {}, fetchImpl, grantedOrigins = null } = {}) {
  const sentMessages = [];   // chrome.tabs.sendMessage calls (progress/stream)
  const alarms = [];
  const store = { ...storage };
  const fetchCalls = [];
  // null means "every origin granted", which is the state after a user has
  // approved a provider and the case most tests care about. Pass an array to
  // exercise the permission-missing path.
  const permissionAsks = [];

  const chrome = {
    runtime: {
      _listener: null,
      onMessage: { addListener(fn) { chrome.runtime._listener = fn; } },
      getURL: p => path.join(ROOT, p),
      openOptionsPage() {}
    },
    storage: {
      local: {
        get(keys, cb) {
          const list = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const k of list) if (k in store) out[k] = store[k];
          cb(out);
        },
        set(obj, cb) { Object.assign(store, obj); if (cb) cb(); }
      }
    },
    tabs: {
      sendMessage(tabId, msg) { sentMessages.push({ tabId, msg }); return Promise.resolve(); }
    },
    alarms: {
      create(name, opts) { alarms.push({ name, opts }); },
      onAlarm: { addListener(fn) { chrome.alarms._onAlarm = fn; } }
    },
    permissions: {
      contains({ origins }, cb) {
        permissionAsks.push(origins);
        cb(grantedOrigins === null ? true : origins.every(o => grantedOrigins.includes(o)));
      }
    }
  };

  const context = {
    chrome,
    console,
    fetch: (...args) => {
      fetchCalls.push(args);
      return (fetchImpl || (() => Promise.reject(new Error('no fetch stub'))))(...args);
    },
    AbortController,
    AbortSignal,
    DOMException,
    TextDecoder,
    setTimeout,
    clearTimeout,
    URL,
    Response,
    JSON,
    Math,
    Date,
    Promise,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Error,
    Map,
    Set,
    RegExp,
    encodeURIComponent,
    decodeURIComponent,
    isNaN,
    parseInt,
    parseFloat
  };
  context.globalThis = context;
  context.self = context;
  context.importScripts = (...urls) => {
    for (const url of urls) {
      vm.runInContext(fs.readFileSync(url, 'utf8'), context, { filename: url });
    }
  };

  vm.createContext(context);
  const source = fs.readFileSync(path.join(ROOT, 'background/background.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'background.js' });

  /** Send a message the way the content script does; resolves with the reply. */
  function send(message, sender = { tab: { id: 1 } }) {
    return new Promise(resolve => {
      const kept = chrome.runtime._listener(message, sender, resolve);
      // A listener returning nothing responded synchronously already.
      if (kept !== true) { /* resolve was called inline */ }
    });
  }

  return {
    send,
    context,
    store,
    sentMessages,
    alarms,
    fetchCalls,
    permissionAsks,
    fireAlarm: name => chrome.alarms._onAlarm({ name })
  };
}

/** Minimal Response-alike for fetch stubs. */
function jsonResponse(body, { status = 200, ok } = {}) {
  return {
    ok: ok !== undefined ? ok : status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body))
  };
}

/** Response whose body streams the given SSE lines. */
function sseResponse(chunks, { status = 200 } = {}) {
  const encoder = new TextEncoder();
  let i = 0;
  return {
    ok: status >= 200 && status < 300,
    status,
    body: {
      getReader() {
        return {
          read() {
            if (i >= chunks.length) return Promise.resolve({ done: true });
            return Promise.resolve({ done: false, value: encoder.encode(chunks[i++]) });
          },
          releaseLock() {}
        };
      }
    },
    json: () => Promise.resolve({}),
    text: () => Promise.resolve('')
  };
}

module.exports = { loadServiceWorker, jsonResponse, sseResponse };
