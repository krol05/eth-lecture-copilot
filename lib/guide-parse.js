/**
 * Guide JSON parsing (shared by background service worker and Jest).
 * Service worker loads this via importScripts; Node loads via require.
 */
(function (root) {
  'use strict';

  function parseGuideResponse(raw) {
    let text = String(raw || '').trim();

    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');

    const start = text.indexOf('{');
    if (start === -1) throw new Error('No JSON object found in response');
    text = text.slice(start);

    text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

    try { return JSON.parse(text); } catch (_) {}

    const end = findMatchingBrace(text);
    if (end !== -1) {
      const complete = text.slice(0, end + 1);
      try { return JSON.parse(complete); } catch (_) {}
      const cleaned = complete.replace(/,\s*([}\]])/g, '$1');
      try { return JSON.parse(cleaned); } catch (_) {}
    }

    const fixed = fixEscapes(text);
    try { return JSON.parse(fixed); } catch (_) {}

    const salvaged = salvageTruncated(fixed);
    if (salvaged) return salvaged;

    const salvaged2 = salvageTruncated(text);
    if (salvaged2) return salvaged2;

    throw new Error('Could not parse the guide. Try a different model or paste the transcript manually.');
  }

  function fixEscapes(text) {
    /**
     * Escapes kept as-is. `b` and `f` are deliberately absent: a lecture guide
     * never wants a backspace or a form feed, but it is full of LaTeX, and
     * treating "\\frac" as an escape turned it into a form feed followed by
     * "rac". The same went for "\\beta", "\\bar" and "\\binom".
     *
     * `n`, `r` and `t` stay, because a line break or tab in a note is a real
     * thing a model writes — so "\\nabla", "\\rho" and "\\theta" are still
     * ambiguous and still lose. `u` is decided below instead, since a JSON
     * "\\u" escape must be followed by four hex digits and "\\underline" is not.
     */
    const VALID_ESC = '"\\/nrt';
    const isUnicodeEscape = (at) => /^u[0-9a-fA-F]{4}/.test(text.slice(at, at + 5));
    let out = '';
    let inStr = false;
    let i = 0;
    while (i < text.length) {
      const c = text[i];
      if (!inStr) {
        if (c === '"') inStr = true;
        out += c; i++; continue;
      }
      if (c === '\\') {
        const nx = text[i + 1];
        if (nx === undefined) { out += '\\\\'; i++; continue; }
        if (VALID_ESC.includes(nx) || isUnicodeEscape(i + 1)) { out += c + nx; i += 2; continue; }
        out += '\\\\'; i++; continue;
      }
      if (c === '"')  { inStr = false; out += c; i++; continue; }
      if (c === '\n') { out += '\\n'; i++; continue; }
      if (c === '\r') { i++; continue; }
      if (c === '\t') { out += '\\t'; i++; continue; }
      out += c; i++;
    }
    out = out.replace(/,\s*([}\]])/g, '$1');
    return out;
  }

  function salvageTruncated(text) {
    try {
      let s = text;
      let inStr = false, esc = false;
      // A stack rather than two counters: what is still open has to be closed
      // in the order it was opened. Counting braces and brackets separately
      // closed the array before the block inside it, so a guide cut off
      // mid-block — the usual way a token limit shows up — was unsalvageable.
      const open = [];
      for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (esc) { esc = false; continue; }
        if (c === '\\' && inStr) { esc = true; continue; }
        if (c === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (c === '{' || c === '[') open.push(c);
        else if (c === '}' || c === ']') open.pop();
      }
      if (inStr) s += '"';
      s = s.replace(/,\s*"[^"]*"?\s*$/, '');
      s = s.replace(/,\s*$/, '');
      s = s.replace(/:\s*$/, ': null');
      while (open.length) s += open.pop() === '{' ? '}' : ']';
      return JSON.parse(s);
    } catch (_) {
      return null;
    }
  }

  function findMatchingBrace(str) {
    let depth = 0, inStr = false, esc = false;
    for (let i = 0; i < str.length; i++) {
      const c = str[i];
      if (esc) { esc = false; continue; }
      if (c === '\\' && inStr) { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === '{') depth++;
      if (c === '}' && --depth === 0) return i;
    }
    return -1;
  }

  /**
   * Pulls finished guide blocks out of a response as it streams in.
   *
   * The sidebar used to re-scan the whole buffer on every chunk and re-parse
   * every block it had already parsed, so a long guide got slower with each
   * chunk and froze the browser near the end. This keeps its position and its
   * parser state between chunks, so each character is looked at once.
   *
   *   const scanner = createGuideBlockScanner();
   *   const fresh = scanner.push(chunkText);   // only blocks completed just now
   *   scanner.blocks                           // everything so far
   */
  function createGuideBlockScanner() {
    const blocks = [];
    let buffer = '';
    let searchFrom = 0;     // where to resume looking for the "guide" array
    let cursor = 0;         // first character not yet examined
    let started = false;    // has the "guide": [ opener been seen
    let finished = false;   // has the array been closed

    // Parser state for the object currently being read, kept across chunks.
    let inObject = false;
    let objStart = 0, depth = 0, inString = false, escaped = false;

    /** The opener can be split across two chunks, so re-read a little overlap. */
    const OPENER = /"guide"\s*:\s*\[/;
    const OVERLAP = 16;

    function push(text) {
      buffer += String(text || '');
      const before = blocks.length;

      if (!started && !finished) {
        const match = OPENER.exec(buffer.slice(searchFrom));
        if (match) {
          started = true;
          cursor = searchFrom + match.index + match[0].length;
        } else {
          searchFrom = Math.max(0, buffer.length - OVERLAP);
        }
      }

      while (started && !finished && cursor < buffer.length) {
        const ch = buffer[cursor];

        if (!inObject) {
          if (ch === ',' || ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t') { cursor++; continue; }
          if (ch === ']') { finished = true; break; }
          if (ch !== '{') { cursor++; continue; }
          inObject = true;
          objStart = cursor;
          depth = 0; inString = false; escaped = false;
        }

        if (escaped) { escaped = false; cursor++; continue; }
        if (ch === '\\' && inString) { escaped = true; cursor++; continue; }
        if (ch === '"') { inString = !inString; cursor++; continue; }
        if (inString) { cursor++; continue; }
        if (ch === '{') { depth++; cursor++; continue; }
        if (ch === '}') {
          depth--;
          cursor++;
          if (depth === 0) {
            const objectText = buffer.slice(objStart, cursor);
            inObject = false;
            try {
              blocks.push(JSON.parse(objectText));
            } catch (err) {
              // A block that will not parse is dropped rather than retried:
              // the final non-streamed response is the authority on content.
              if (typeof root !== 'undefined' && root.CopilotDebug) {
                root.CopilotDebug.warn('guide.scanner.blockParseError', {
                  error: err.message, objectText
                });
              }
            }
          }
          continue;
        }
        cursor++;
      }

      return blocks.slice(before);
    }

    return {
      push,
      blocks,
      get length() { return buffer.length; },
      get done() { return finished; }
    };
  }

  const api = {
    parseGuideResponse, findMatchingBrace, fixEscapes, salvageTruncated,
    createGuideBlockScanner
  };
  if (typeof root !== 'undefined') {
    root.parseGuideResponse = parseGuideResponse;
    root.findMatchingBrace = findMatchingBrace;
    root.fixEscapes = fixEscapes;
    root.salvageTruncated = salvageTruncated;
    root.createGuideBlockScanner = createGuideBlockScanner;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof self !== 'undefined' ? self : globalThis);
