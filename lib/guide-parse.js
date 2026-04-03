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
    const VALID_ESC = '"\\\/bfnrtu';
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
        if (VALID_ESC.includes(nx)) { out += c + nx; i += 2; continue; }
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
      let inStr = false, esc = false, braces = 0, brackets = 0;
      for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (esc) { esc = false; continue; }
        if (c === '\\' && inStr) { esc = true; continue; }
        if (c === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (c === '{') braces++;
        else if (c === '}') braces--;
        else if (c === '[') brackets++;
        else if (c === ']') brackets--;
      }
      if (inStr) s += '"';
      s = s.replace(/,\s*"[^"]*"?\s*$/, '');
      s = s.replace(/,\s*$/, '');
      s = s.replace(/:\s*$/, ': null');
      while (brackets > 0) { s += ']'; brackets--; }
      while (braces > 0) { s += '}'; braces--; }
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

  const api = { parseGuideResponse, findMatchingBrace, fixEscapes, salvageTruncated };
  if (typeof root !== 'undefined') {
    root.parseGuideResponse = parseGuideResponse;
    root.findMatchingBrace = findMatchingBrace;
    root.fixEscapes = fixEscapes;
    root.salvageTruncated = salvageTruncated;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof self !== 'undefined' ? self : globalThis);
