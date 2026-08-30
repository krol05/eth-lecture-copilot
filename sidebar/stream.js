/**
 * sidebar/stream.js — Streamed text into the DOM, plus KaTeX and rich-text rendering helpers.
 *
 * Part of the sidebar, loaded as a plain script in the order listed in
 * sidebar.html. All sidebar modules share one global scope on purpose:
 * it is what lets each file be a straight move out of the old sidebar.js.
 */

// ─── Q&A stream chunk handler ─────────────────────────────────────────────
// One DOM write per animation frame (≤60 fps) for smooth text appearance.
// KaTeX is intentionally NOT applied during streaming — re-rendering LaTeX on
// every chunk causes a visible flicker (rendered → raw → rendered → raw…).
// KaTeX runs exactly once when the stream completes (see sendQaMessage).

function handleQaStreamChunk(msg) {
  const state = qaActiveStreams.get(msg.requestId);
  if (!state || !state.bubble || state.finalized) return;
  state.buffer += msg.text || '';
  QaStreamFlush.scheduleStreamFlush(state, flushQaStream);
}

/**
 * Two-layer streaming renderer.
 *
 *  Layer A — .qa-katex-zone (a single <div> at the top of the bubble)
 *    Contains text up to the end of the last COMPLETE $$...$$ block.
 *    Set via element.textContent so the raw $$ delimiters survive inside one
 *    text node (critical — renderMathInElement only scans within a text node;
 *    splitting on \n into separate nodes would break multi-line equations).
 *    KaTeX is applied once per newly-closed block and never re-runs.
 *
 *  Layer B — appended .qa-chunk <span> nodes
 *    Contains text AFTER the last complete math block (the live tail).
 *    Each rAF frame we APPEND only the new characters as fresh spans that
 *    fade in via CSS.  Nothing is ever replaced, so old text stays stable.
 *
 *  On stream completion both layers are replaced by a full markdown+KaTeX
 *  render with a smooth opacity crossfade.
 */
function flushQaStream(state) {
  if (!state?.bubble || state.finalized) return;
  if (!QaStreamFlush.isStreamingChatBubble(state.bubble)) return;

  const buf    = state.buffer;
  const cursor = state.bubble.querySelector('.qa-stream-cursor');
  const katexZ = state.bubble.querySelector('.qa-katex-zone');

  // ── Layer A: detect newly-closed $$...$$ blocks ──────────────────────────
  let katexCutoff = state.katexEnd;
  let i = katexCutoff;
  while (i < buf.length - 1) {
    if (buf[i] === '$' && buf[i + 1] === '$') {
      const closeIdx = buf.indexOf('$$', i + 2);
      if (closeIdx !== -1) {
        katexCutoff = closeIdx + 2;
        i = closeIdx + 2;
      } else {
        break; // block still open — leave for later
      }
    } else {
      i++;
    }
  }

  if (katexCutoff > state.katexEnd && katexZ) {
    // New complete math block(s) found.
    // Set the zone's textContent so the $$ delimiters live in a SINGLE text
    // node — renderMathInElement can then find multi-line equations.
    // Typeset ONLY the newly completed span and append it. This used to
    // reset the whole zone to buf.slice(0, cutoff) and re-render it, so
    // every finished equation re-typeset all the equations before it —
    // quadratic work that made a long answer crawl as it streamed.
    const part = document.createElement('span');
    part.className = 'qa-katex-part';
    part.textContent = buf.slice(state.katexEnd, katexCutoff);
    katexZ.appendChild(part);
    applyKatex(part);
    state.katexEnd = katexCutoff;

    // Remove all existing plain spans/brs (now covered by the katex zone).
    Array.from(state.bubble.childNodes).forEach(node => {
      if (node !== katexZ && node !== cursor) node.remove();
    });
    // Plain-span pointer resets to the katex cutoff.
    state.stableEnd = katexCutoff;
  }

  // ── Layer B: append the live tail as fading plain-text spans ─────────────
  const newText = buf.slice(state.stableEnd);
  if (newText) {
    newText.split('\n').forEach((line, idx) => {
      if (idx > 0) {
        const br = document.createElement('br');
        cursor ? state.bubble.insertBefore(br, cursor) : state.bubble.appendChild(br);
      }
      if (line.length > 0) {
        const span = document.createElement('span');
        span.className = 'qa-chunk';
        span.innerHTML = applyStreamingLineMarkdown(line);
        cursor ? state.bubble.insertBefore(span, cursor) : state.bubble.appendChild(span);
      }
    });
    state.stableEnd = buf.length;
    coalesceStreamChunks(state.bubble, cursor);
  }
}

/**
 * Fold older fade-in spans into one plain text node.
 *
 * Layer B adds a span per line on every flush, so a long answer ends up with
 * thousands of animated elements live at once — the single biggest cost
 * while streaming. Only the newest handful need to be individually animated;
 * everything above is settled text and can be one node.
 */
function coalesceStreamChunks(bubble, cursor) {
  const KEEP_ANIMATED = 24;
  const chunks = bubble.querySelectorAll('.qa-chunk');
  if (chunks.length <= KEEP_ANIMATED * 3) return;   // amortise the work

  const first = chunks[0];
  const stopAt = chunks[chunks.length - KEEP_ANIMATED];

  // Walk the real sibling range so the <br>s between spans travel with them
  // and nothing is reordered. Inserting at the top would push settled text
  // above the maths zone, which sits first in the bubble.
  const merged = document.createElement('span');
  merged.className = 'qa-chunk-settled';
  bubble.insertBefore(merged, first);

  let node = merged.nextSibling;
  while (node && node !== stopAt && node !== cursor) {
    const next = node.nextSibling;
    if (node.classList && node.classList.contains('qa-chunk')) {
      // UNWRAP, don't just move: a relocated span keeps its class and so
      // keeps its animation, which would leave the cost exactly where it
      // was. Lifting the contents out drops the element entirely.
      while (node.firstChild) merged.appendChild(node.firstChild);
      node.remove();
    } else {
      merged.appendChild(node);       // the <br>s between lines
    }
    node = next;
  }
}

/** Apply KaTeX to an element — shared helper used by streaming, flashcards, etc. */
/**
 * Delimiters we accept for maths.
 *
 * \[..\] and \(..\) matter as much as the dollar forms: they are what
 * DeepSeek and most current models emit, and with only $-forms configured
 * those blocks were shown to the user as raw LaTeX source.
 *
 * Order matters — the longer opener must be tried before the shorter one, or
 * "$$" is matched as two empty "$" spans.
 */
const KATEX_DELIMITERS = [
  { left: '$$',  right: '$$',  display: true },
  { left: '\\[', right: '\\]', display: true },
  { left: '\\(', right: '\\)', display: false },
  { left: '$',   right: '$',   display: false }
];

/**
 * Shorthands models write as if a preamble defined them. KaTeX ships no
 * preamble, so \E and friends came out as red error text mid-formula.
 * Defining them costs nothing and removes a whole class of "broken maths".
 */
const KATEX_MACROS = {
  '\\E': '\\mathbb{E}',
  '\\P': '\\mathbb{P}',
  '\\R': '\\mathbb{R}',
  '\\N': '\\mathbb{N}',
  '\\Z': '\\mathbb{Z}',
  '\\Q': '\\mathbb{Q}',
  '\\Var': '\\operatorname{Var}',
  '\\Cov': '\\operatorname{Cov}',
  '\\Pr': '\\operatorname{Pr}',
  '\\argmin': '\\operatorname{arg\\,min}',
  '\\argmax': '\\operatorname{arg\\,max}'
};

function applyKatex(el) {
  if (!el || typeof renderMathInElement !== 'function') return;
  renderMathInElement(el, {
    delimiters: KATEX_DELIMITERS,
    macros: KATEX_MACROS,
    throwOnError: false,
    trust: false
  });
}

function richTextHtml(text) {
  return renderMarkdown(normalizeRichTextSource(text));
}

function richInlineHtml(text) {
  return renderMarkdownInline(normalizeRichTextSource(text));
}

function setRichTextHtml(el, text) {
  if (!el) return;
  el.innerHTML = richTextHtml(text);
  applyKatex(el);
}

function setRichInlineHtml(el, text) {
  if (!el) return;
  el.innerHTML = richInlineHtml(text);
  applyKatex(el);
}

function normalizeRichTextSource(text) {
  return normalizeLatexForKatex(unescapeMathDelimiters(text || ''));
}

function showGuideTimeoutDialog({ onRetry, onKeepGoing, silentSeconds = 180 }) {
  const existing = document.getElementById('guide-timeout-dialog');
  if (existing) existing.remove();

  const blocks = guideScanner?.blocks.length || 0;
  const soFar = blocks
    ? `${blocks} block${blocks === 1 ? '' : 's'} arrived before it went quiet.`
    : 'Nothing has arrived yet.';

  const dialog = document.createElement('div');
  dialog.id = 'guide-timeout-dialog';
  dialog.className = 'guide-timeout-dialog';
  dialog.innerHTML = `
      <div class="guide-timeout-title">Nothing received for ${Math.round(silentSeconds)}s</div>
      <div class="guide-timeout-text">
        ${soFar} The provider may still be thinking — reasoning models can go
        quiet for a long time before they start writing. Keep going and this
        check comes back if it stays silent, or retry to start over.
      </div>
      <div class="guide-timeout-actions">
        <button id="guide-timeout-retry" class="primary-btn">Retry</button>
        <button id="guide-timeout-keep" class="primary-btn">Keep going</button>
      </div>
    `;
  document.body.appendChild(dialog);

  const close = () => {
    if (dialog.parentNode) dialog.parentNode.removeChild(dialog);
  };

  dialog.querySelector('#guide-timeout-retry')?.addEventListener('click', () => {
    close();
    onRetry?.();
  });
  dialog.querySelector('#guide-timeout-keep')?.addEventListener('click', () => {
    close();
    onKeepGoing?.();
  });

  return close;
}

/** Shown to the user; matches the suggested_key in manifest.json. */
const FRAME_SHORTCUT = navigator.platform?.startsWith('Mac') ? '⌥⇧F' : 'Alt+Shift+F';
