/**
 * Inline markdown rendering shared by the sidebar UI:
 * HTML escaping, undelimited-math wrapping, and inline markdown
 * (code, math, bold/italic, clickable timestamps).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined') module.exports = api;
  if (root) Object.assign(root, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function escHtml(str) {
    return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function renderMarkdownInline(text) {
    let s = escHtml(wrapUndelimitedInlineMath(String(text || '')));

    // Stash spans that must not be touched by bold/italic substitution.
    // Uses null-byte delimiters (\x00) which never appear in normal text.
    const stash = [];
    const protect = (raw) => { const i = stash.push(raw) - 1; return `\x00S${i}\x00`; };

    // 1. Inline code  (highest priority)
    s = s.replace(/`([^`]+)`/g, (_, inner) => protect(`<code>${inner}</code>`));

    // 2. Inline math  $$...$$ then $...$
    //    After escHtml, $ is unchanged; protect math so * inside doesn't become <em>.
    s = s.replace(/\$\$([^$][\s\S]*?)\$\$/g, (m) => protect(m.replace(/&#039;/g, "'")));
    s = s.replace(/\$([^$\n]+)\$/g, (m) => protect(m.replace(/&#039;/g, "'")));

    // 3. Bold / italic — now safe, math is stashed
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');

    // 4. Timestamps
    s = s.replace(/\[(\d{2}):([0-5]\d):([0-5]\d)\]/g, (_, hh, mm, ss) => {
      const seconds = Number(hh) * 3600 + Number(mm) * 60 + Number(ss);
      return `<button type="button" class="qa-timestamp-link" data-seconds="${seconds}">[${hh}:${mm}:${ss}]</button>`;
    });

    // 5. Restore stash
    s = s.replace(/\x00S(\d+)\x00/g, (_, idx) => stash[Number(idx)] || '');
    return s;
  }

  function wrapUndelimitedInlineMath(text) {
    const src = String(text || '');
    if (!src || src.includes('$')) return src;
    const pieces = [];
    const token = String.raw`(?:\\[a-zA-Z]+(?:\s*\([^)]*\))?|[A-Za-z](?:_\{?[^}\s,.;:!?]+\}?|\^\{[^}]+\}|\^[A-Za-z0-9()]+|''|')+|e(?:\^\{[^}]+\}|\^[A-Za-z0-9()]+)|O\([^)]+\))`;
    const equation = new RegExp(String.raw`(?:^|([^A-Za-z\\]))((?:[A-Za-z](?:''|')?|${token}|\d+(?:\.\d+)?)(?:\s*[-+=]\s*(?:${token}|[A-Za-z](?:''|')?|\d+(?:\.\d+)?))+)(?=$|[^A-Za-z])`, 'g');
    const markedToken = new RegExp(String.raw`(?:^|([^A-Za-z\\]))(${token})(?=$|[^A-Za-z])`, 'g');

    let out = src.replace(equation, (match, prefix = '', expr) => {
      if (!/[=^_\\]|''|'|O\(/.test(expr)) return match;
      pieces.push(expr);
      return `${prefix}\x00M${pieces.length - 1}\x00`;
    });
    out = out.replace(markedToken, (match, prefix = '', expr) => {
      pieces.push(expr);
      return `${prefix}\x00M${pieces.length - 1}\x00`;
    });
    return out.replace(/\x00M(\d+)\x00/g, (_, idx) => `$${pieces[Number(idx)] || ''}$`);
  }

  return { escHtml, renderMarkdownInline, wrapUndelimitedInlineMath };
});
