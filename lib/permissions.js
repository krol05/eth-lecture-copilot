/**
 * lib/permissions.js
 * Asking for host access only when it is actually needed.
 *
 * The extension used to declare `<all_urls>`, so Chrome told every installer it
 * could "read and change all your data on the websites you visit". For an
 * extension that reads ETH lecture pages and talks to an API you chose, that
 * warning is both alarming and untrue.
 *
 * Now only the two ETH hosts are required. Everything else — around twenty
 * provider APIs, any custom endpoint you configure, local servers, and the
 * embedding model download — is requested per origin, at the moment you first
 * need it, so each prompt names one host.
 *
 * The rule that shapes this file: `chrome.permissions.request` only works from
 * an extension page (popup, options, side panel) while handling a user gesture.
 * A service worker cannot ask. So the background reports what is missing and
 * the UI does the asking — see PERMISSION_MISSING in background/background.js.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined') module.exports = api;
  if (root) Object.assign(root, api);
})(typeof self !== 'undefined' ? self : this, function () {

  /** Host access needed for the model download when semantic search is on. */
  const EMBEDDING_ORIGINS = ['https://huggingface.co/*'];

  /**
   * Attaching a video frame needs a screenshot of the tab: ETH's player taints
   * the canvas ("Tainted canvases may not be exported"), so the frame cannot
   * be copied out of the video.
   *
   * Chrome allows a tab screenshot only with <all_urls> or activeTab, and
   * explicitly refuses a specific host permission — a screenshot can capture
   * more than the page you granted. activeTab cannot be obtained from a button
   * inside the sidebar, so a button has to mean this.
   *
   * It is never requested automatically: the user presses a button that says
   * exactly what it will ask for, and the keyboard shortcut remains as the
   * alternative that needs nothing.
   */
  const SCREENSHOT_ORIGINS = ['<all_urls>'];


  /**
   * Turn any URL into a Chrome match pattern.
   *
   * Match patterns cannot carry a port, so http://localhost:11434 and
   * http://localhost:1234 both become http://localhost/* — one grant covers
   * every local server, which is what we want anyway.
   */
  function originPattern(url) {
    if (!url) return null;
    try {
      const u = new URL(String(url));
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
      if (!u.hostname) return null;
      return `${u.protocol}//${u.hostname}/*`;
    } catch {
      return null;
    }
  }

  /** The pattern a resolved provider needs, or null if it needs none. */
  function providerPattern(provider) {
    return provider ? originPattern(provider.base) : null;
  }

  function api() {
    return (typeof chrome !== 'undefined' && chrome.permissions) ? chrome.permissions : null;
  }

  /** Do we already hold this origin? Missing API (tests, old browsers) = yes. */
  function has(pattern) {
    const p = api();
    if (!pattern) return Promise.resolve(true);
    if (!p) return Promise.resolve(true);
    return new Promise(resolve => {
      try {
        p.contains({ origins: [pattern] }, granted => {
          // A bad pattern rejects rather than throwing; treat it as "not held"
          void chrome.runtime.lastError;
          resolve(Boolean(granted));
        });
      } catch {
        resolve(false);
      }
    });
  }

  /**
   * Ask for an origin. MUST be called from an extension page while handling a
   * click — Chrome silently rejects otherwise, which is why this resolves
   * {granted, reason} instead of throwing: the caller needs to tell the user
   * whether they said no or whether we asked from the wrong place.
   */
  function request(patterns) {
    const list = (Array.isArray(patterns) ? patterns : [patterns]).filter(Boolean);
    const p = api();
    if (!list.length) return Promise.resolve({ granted: true });
    if (!p) return Promise.resolve({ granted: false, reason: 'unsupported' });
    return new Promise(resolve => {
      try {
        p.request({ origins: list }, granted => {
          const err = chrome.runtime.lastError;
          if (err) resolve({ granted: false, reason: 'gesture', message: err.message });
          else resolve({ granted: Boolean(granted), reason: granted ? undefined : 'denied' });
        });
      } catch (err) {
        resolve({ granted: false, reason: 'gesture', message: err && err.message });
      }
    });
  }

  /** Give an origin back. Best-effort: nothing depends on it succeeding. */
  function drop(pattern) {
    const p = api();
    if (!p || !pattern) return Promise.resolve(false);
    return new Promise(resolve => {
      try {
        p.remove({ origins: [pattern] }, removed => {
          void chrome.runtime.lastError;
          resolve(Boolean(removed));
        });
      } catch {
        resolve(false);
      }
    });
  }

  /** Every optional origin we currently hold, for the settings screen. */
  function granted() {
    const p = api();
    if (!p) return Promise.resolve([]);
    return new Promise(resolve => {
      try {
        p.getAll(all => {
          void chrome.runtime.lastError;
          resolve((all && all.origins) || []);
        });
      } catch {
        resolve([]);
      }
    });
  }

  /** Human phrasing for a pattern: "https://api.groq.com/*" -> "api.groq.com". */
  function hostLabel(pattern) {
    return String(pattern || '').replace(/^https?:\/\//, '').replace(/\/\*$/, '');
  }

  return {
    EMBEDDING_ORIGINS,
    SCREENSHOT_ORIGINS,
    originPattern,
    providerPattern,
    hasPermission: has,
    requestPermission: request,
    dropPermission: drop,
    grantedOrigins: granted,
    hostLabel
  };
});
