/**
 * Guide shape repair — the single copy, used by the sidebar and by Jest.
 *
 * Models return guides with timestamps as "HH:MM:SS" strings, blocks slightly
 * out of order, and end times that are missing or before their start. Nothing
 * downstream copes with that, so everything is normalised here right after
 * parsing.
 *
 * This file used to be a stale duplicate of the sidebar's own version, loaded
 * by nothing and exercised only by the tests — so the tests could pass while
 * the code that actually ran was broken. The sidebar now loads this as a
 * script tag and the duplicate is gone.
 */
(function (root) {
  'use strict';

  /** Seconds from a number, "HH:MM:SS", "MM:SS", or a numeric string. */
  function toSeconds(v) {
    if (typeof v === 'number' && isFinite(v)) return v;

    if (typeof v === 'string') {
      const s = v.trim();
      if (!s) return 0;

      // HH:MM:SS(.ms)  (also supports comma decimals)
      const hms = s.match(/^(\d+):(\d+):(\d+(?:[.,]\d+)?)$/);
      if (hms) {
        const h = +hms[1];
        const m = +hms[2];
        const sec = parseFloat(hms[3].replace(',', '.'));
        if (isFinite(h) && isFinite(m) && isFinite(sec)) return h * 3600 + m * 60 + sec;
      }

      // MM:SS(.ms)
      const ms = s.match(/^(\d+):(\d+(?:[.,]\d+)?)$/);
      if (ms) {
        const m = +ms[1];
        const sec = parseFloat(ms[2].replace(',', '.'));
        if (isFinite(m) && isFinite(sec)) return m * 60 + sec;
      }

      // Raw numeric string (including decimals)
      const n = parseFloat(s.replace(',', '.'));
      if (isFinite(n)) return n;
    }

    return 0;
  }

  /**
   * The reading order for a block, dropping steps that point at content the
   * block does not have — a model will happily reference formula 3 of 2.
   */
  function sanitizeStudyFlow(block) {
    if (!Array.isArray(block.study_flow)) return [];
    const maxByType = {
      concept: Array.isArray(block.key_concepts) ? block.key_concepts.length : 0,
      formula: Array.isArray(block.formulas) ? block.formulas.length : 0,
      definition: Array.isArray(block.definitions) ? block.definitions.length : 0,
      note: String(block.notes || '').trim() ? 1 : 0
    };

    return block.study_flow
      .map(item => {
        if (!item || typeof item !== 'object') return null;
        const type = String(item.type || '').trim().toLowerCase();
        if (!['concept', 'formula', 'definition', 'note'].includes(type)) return null;
        if (type === 'note') return maxByType.note ? { type: 'note' } : null;
        const index = Number.isInteger(item.index) ? item.index : parseInt(item.index, 10);
        if (!Number.isInteger(index) || index < 0 || index >= maxByType[type]) return null;
        const label = typeof item.label === 'string' ? item.label.trim().slice(0, 24) : '';
        return label ? { type, index, label } : { type, index };
      })
      .filter(Boolean);
  }

  /** Concepts arrive either as plain strings or as {label, lead, body}. */
  function sanitizeKeyConcepts(concepts, labels = []) {
    if (!Array.isArray(concepts)) return [];
    return concepts.map((concept, index) => {
      if (concept && typeof concept === 'object' && !Array.isArray(concept)) {
        const label = String(concept.label || labels[index] || '').trim().slice(0, 24);
        const lead = String(concept.lead || concept.title || '').trim();
        const body = String(concept.body || concept.detail || concept.text || '').trim();
        if (lead || body) return { label, lead: lead || body, body };
        // An object with nothing in it must drop out below, not fall through
        // to String(concept) — that put the text "[object Object]" in guides.
        return '';
      }
      return String(concept || '').trim();
    }).filter(c => typeof c === 'string' ? !!c : !!(c.lead || c.body));
  }

  /**
   * Pick a display title for a guide.
   * @param {Object<string, any>} guide
   * @param {string} [fallback] used when the guide names nothing itself
   */
  function guideTitleFrom(guide, fallback) {
    const explicit = typeof guide?.guide_title === 'string' ? guide.guide_title.trim() : '';
    if (explicit) return explicit.slice(0, 120);
    const legacy = typeof guide?.guideTitle === 'string' ? guide.guideTitle.trim() : '';
    if (legacy) return legacy.slice(0, 120);
    const firstBlock = typeof guide?.guide?.[0]?.title === 'string' ? guide.guide[0].title.trim() : '';
    const lecture = typeof guide?.lecture_title === 'string' ? guide.lecture_title.trim() : '';
    return (firstBlock || lecture || fallback || 'Lecture').slice(0, 120);
  }

  /**
   * Normalise a parsed guide in place: coerce timestamps, order the blocks,
   * repair end times, fill in missing fields, and name the guide.
   *
   * @param {Object<string, any>} guide          parsed guide, modified in place
   * @param {string} [fallbackTitle] title to use when the guide names nothing
   */
  function sanitizeGuide(guide, fallbackTitle) {
    if (!Array.isArray(guide?.guide)) return guide;

    const blocks = guide.guide.map(b => {
      const block = {
        start_time: toSeconds(b.start_time),
        end_time: toSeconds(b.end_time),
        title: b.title ?? 'Untitled Section',
        key_concept_labels: Array.isArray(b.key_concept_labels)
          ? b.key_concept_labels.map(v => String(v || '').trim().slice(0, 24))
          : [],
        formulas: Array.isArray(b.formulas) ? b.formulas : [],
        definitions: Array.isArray(b.definitions) ? b.definitions : [],
        notes: typeof b.notes === 'string' ? b.notes : ''
      };
      block.key_concepts = sanitizeKeyConcepts(b.key_concepts, block.key_concept_labels);
      block.study_flow = sanitizeStudyFlow({ ...b, ...block });
      return block;
    });

    // Some models emit blocks slightly out of order.
    blocks.sort((a, b) => (a.start_time - b.start_time));

    // Every block needs a usable [start, end) range, or timestamp sync and
    // block navigation land on the wrong section.
    for (let i = 0; i < blocks.length; i++) {
      const cur = blocks[i];
      const next = blocks[i + 1];
      if (!isFinite(cur.start_time) || cur.start_time < 0) cur.start_time = 0;
      if (!isFinite(cur.end_time) || cur.end_time < 0) cur.end_time = 0;
      if (cur.end_time <= cur.start_time) {
        cur.end_time = next ? next.start_time : (cur.start_time + 1);
      }
    }

    guide.guide = blocks;
    guide.guide_title = guideTitleFrom(guide, fallbackTitle);
    return guide;
  }

  const api = { toSeconds, sanitizeGuide, sanitizeStudyFlow, sanitizeKeyConcepts, guideTitleFrom };

  if (typeof root !== 'undefined') {
    root.toSeconds = toSeconds;
    root.sanitizeGuide = sanitizeGuide;
    root.sanitizeStudyFlow = sanitizeStudyFlow;
    root.sanitizeKeyConcepts = sanitizeKeyConcepts;
    root.guideTitleFrom = guideTitleFrom;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof self !== 'undefined' ? self : globalThis);
