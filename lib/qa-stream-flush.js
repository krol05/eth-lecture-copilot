/**
 * Q&A streaming DOM flush guards.
 * Prevents stale requestAnimationFrame callbacks from appending .qa-chunk
 * nodes after a stream bubble has been finalized to markdown + KaTeX.
 */
(function (root) {
  'use strict';

  const STREAM_CURSOR_SEL = '.qa-stream-cursor';

  function isStreamingChatBubble(bubble) {
    return !!bubble?.querySelector?.(STREAM_CURSOR_SEL);
  }

  /** Stop further stream flushes and cancel a pending animation frame. */
  function stopStreamFlush(state) {
    if (!state) return;
    state.finalized = true;
    state.rafPending = false;
    if (state.rafHandle != null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(state.rafHandle);
      state.rafHandle = null;
    }
  }

  /**
   * Schedule one flush per frame. Coalesces chunk bursts; no-op after finalize.
   * @param {object} state
   * @param {(state: object) => void} flushFn
   */
  function scheduleStreamFlush(state, flushFn) {
    if (!state || state.finalized) return;
    if (state.rafPending) return;
    state.rafPending = true;
    const run = () => {
      state.rafHandle = null;
      state.rafPending = false;
      if (state.finalized) return;
      flushFn(state);
    };
    if (typeof requestAnimationFrame === 'function') {
      state.rafHandle = requestAnimationFrame(run);
    } else {
      run();
    }
  }

  const api = {
    STREAM_CURSOR_SEL,
    isStreamingChatBubble,
    stopStreamFlush,
    scheduleStreamFlush
  };

  if (typeof root !== 'undefined') {
    root.QaStreamFlush = api;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof self !== 'undefined' ? self : globalThis);
