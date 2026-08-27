/**
 * Splits a concept sentence into a short lead (takeaway) and supporting body,
 * without breaking inside inline/display LaTeX or at abbreviation dots.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined') module.exports = api;
  if (root) Object.assign(root, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function splitConceptText(concept) {
    const text = String(concept || '').trim();
    if (!text) return { lead: '', body: '' };

    let inlineMath = false;
    let displayMath = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      const next = text[i + 1] || '';
      const prev = text[i - 1] || '';

      if (ch === '$' && prev !== '\\') {
        if (next === '$') {
          displayMath = !displayMath;
          i++;
          continue;
        }
        if (!displayMath) inlineMath = !inlineMath;
        continue;
      }

      if (inlineMath || displayMath) continue;
      if (!/[.!?]/.test(ch)) continue;
      if (isAbbreviationDot(text, i)) continue;

      const lead = text.slice(0, i + 1).trim();
      const body = text.slice(i + 1).trim();
      if (lead.length >= 12 && lead.length <= 180 && body.length >= 8) {
        return { lead, body };
      }
    }

    const words = text.split(/\s+/).filter(Boolean);
    if (words.length > 12) {
      const leadWordCount = Math.min(12, Math.max(4, Math.ceil(words.length * 0.28)));
      return {
        lead: words.slice(0, leadWordCount).join(' '),
        body: words.slice(leadWordCount).join(' ')
      };
    }

    return { lead: text, body: '' };
  }

  function isAbbreviationDot(text, dotIndex) {
    if (text[dotIndex] !== '.') return false;
    const before = text.slice(Math.max(0, dotIndex - 12), dotIndex + 1).toLowerCase();
    const after = text.slice(dotIndex + 1, dotIndex + 4);
    if (/\b(z|b|ca|bzw|bspw|vgl|d\.h|u\.a|u\.s|u\.ä|e\.g|i\.e|etc|vs|dr|prof)\.$/.test(before)) return true;
    if (/\b[a-z]\.$/.test(before) && /^\s*[a-zäöü]/i.test(after)) return true;
    if (/\d\.$/.test(before) && /^\s*\d/.test(after)) return true;
    return false;
  }

  /**
   * Normalize one key_concepts entry to { label, lead, body }.
   *
   * Guides contain both shapes: current ones use structured objects, while
   * guides saved before the schema changed hold plain strings. Anything that
   * reads key_concepts must go through this — assuming strings is what broke
   * Markdown export with "c.replace is not a function".
   */
  function conceptToParts(concept) {
    if (concept && typeof concept === 'object' && !Array.isArray(concept)) {
      const lead = String(concept.lead || concept.title || '').trim();
      const body = String(concept.body || concept.detail || concept.text || '').trim();
      return {
        label: String(concept.label || '').trim(),
        lead: lead || body,
        body: lead ? body : ''
      };
    }
    const text = String(concept == null ? '' : concept).trim();
    if (!text) return { label: '', lead: '', body: '' };
    const split = splitConceptText(text);
    return { label: '', lead: split.lead || text, body: split.body || '' };
  }

  /** One concept as a single plain-text line (label dropped). */
  function conceptToText(concept) {
    const { lead, body } = conceptToParts(concept);
    return [lead, body].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  }

  return { splitConceptText, isAbbreviationDot, conceptToParts, conceptToText };
});
