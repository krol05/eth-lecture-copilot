/**
 * Shared flashcard normalization and export helpers.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined') module.exports = api;
  if (root) Object.assign(root, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VALID_CARD_TYPES = new Set([
    'recall',
    'definition',
    'concept',
    'application',
    'comparison',
    'process',
    'cause_effect',
    'example',
    'misconception',
    'formula_rule',
    'other'
  ]);

  function cleanString(value, max = 500) {
    return String(value ?? '').trim().slice(0, max);
  }

  function sanitizeTag(value) {
    return cleanString(value, 60)
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
  }

  function normalizeTags(tags) {
    if (!Array.isArray(tags)) return [];
    return [...new Set(tags.map(sanitizeTag).filter(Boolean))].slice(0, 12);
  }

  function normalizeCardType(value) {
    const type = cleanString(value, 80);
    return VALID_CARD_TYPES.has(type) ? type : '';
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatCardType(value) {
    const raw = cleanString(value, 80);
    if (!raw) return '';
    return raw
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\b\w/g, ch => ch.toUpperCase());
  }

  function secondsToClock(totalSeconds) {
    const total = Math.max(0, Math.floor(Number(totalSeconds) || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h > 0
      ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
      : `${m}:${String(s).padStart(2, '0')}`;
  }

  function formatTimeToken(token) {
    const raw = String(token || '').trim();
    if (!raw) return '';
    if (/^\d+(?:\.\d+)?$/.test(raw)) return secondsToClock(Number(raw));
    const hms = raw.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (hms) {
      const nums = hms.slice(1).filter(v => v != null).map(Number);
      const seconds = nums.length === 3
        ? nums[0] * 3600 + nums[1] * 60 + nums[2]
        : nums[0] * 60 + nums[1];
      return secondsToClock(seconds);
    }
    return raw;
  }

  function formatTimeRange(value) {
    const raw = cleanString(value, 120);
    if (!raw) return '';
    const parts = raw.split(/\s*(?:-|–|—|to)\s*/i).filter(Boolean);
    if (parts.length === 2) return `${formatTimeToken(parts[0])} – ${formatTimeToken(parts[1])}`;
    return formatTimeToken(raw);
  }

  function normalizeFlashcard(card) {
    if (!card || (card.front == null && card.back == null)) return null;
    const out = {
      front: String(card.front ?? ''),
      back: String(card.back ?? '')
    };
    const cardType = normalizeCardType(card.card_type);
    const sourceBlockTitle = cleanString(card.source_block_title, 180);
    const sourceTimeRange = cleanString(card.source_time_range, 80);
    const reference = cleanString(card.reference, 240);
    const studyNote = cleanString(card.study_note, 300);
    const tags = normalizeTags(card.tags);
    if (cardType) out.card_type = cardType;
    if (sourceBlockTitle) out.source_block_title = sourceBlockTitle;
    if (sourceTimeRange) out.source_time_range = sourceTimeRange;
    if (tags.length) out.tags = tags;
    if (reference) out.reference = reference;
    if (studyNote) out.study_note = studyNote;
    return out;
  }

  function normalizeFlashcardsResponse(data) {
    const cards = Array.isArray(data?.flashcards) ? data.flashcards : [];
    return cards.map(normalizeFlashcard).filter(Boolean);
  }

  function getFlashcardMetadataRows(card) {
    const rows = [];
    if (card?.card_type) rows.push(['Type', formatCardType(card.card_type)]);
    if (card?.source_block_title) rows.push(['Block', card.source_block_title]);
    if (card?.source_time_range) rows.push(['Time', formatTimeRange(card.source_time_range)]);
    if (card?.reference) rows.push(['Reference', card.reference]);
    if (Array.isArray(card?.tags) && card.tags.length) rows.push(['Tags', card.tags.join(', ')]);
    if (card?.study_note) rows.push(['Study note', card.study_note]);
    return rows;
  }

  function buildFlashcardMetadataText(card) {
    const rows = getFlashcardMetadataRows(card);
    if (!rows.length) return '';
    return rows.map(([label, value]) => `${label}: ${value}`).join('\n');
  }

  function buildFlashcardBackWithMetadata(card) {
    const back = String(card?.back ?? '').trim();
    const metadata = buildFlashcardMetadataText(card);
    return metadata ? `${back}\n\n---\n${metadata}` : back;
  }

  function convertDollarMathToAnki(text) {
    return String(text ?? '')
      .replace(/\$\$([\s\S]+?)\$\$/g, (_, math) => `\\[${math.trim()}\\]`)
      .replace(/(^|[^\\$])\$([^$\n]+?)\$/g, (_, prefix, math) => `${prefix}\\(${math.trim()}\\)`);
  }

  function markdownishToHtml(text) {
    return escapeHtml(convertDollarMathToAnki(text))
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\n{2,}/g, '<br><br>')
      .replace(/\n/g, '<br>');
  }

  function buildFlashcardBackHtmlWithMetadata(card) {
    const backHtml = markdownishToHtml(String(card?.back ?? '').trim());
    const rows = getFlashcardMetadataRows(card);
    if (!rows.length) return backHtml;
    const style = `<style>
.lc-card{box-sizing:border-box;max-width:760px;margin:0 auto;padding:.35rem 1rem 0;text-align:center}
.lc-answer{font-size:1.02em;line-height:1.55}
.lc-meta-rule{border:0;border-top:1px solid rgba(128,128,128,.35);margin:1.1rem auto .75rem;max-width:680px}
.lc-meta{box-sizing:border-box;max-width:680px;margin:.15rem auto 0;text-align:center;font-size:.76em;line-height:1.55;color:rgba(180,190,205,.9)}
.lc-meta-pill{display:inline-block;border:1px solid rgba(130,150,175,.45);border-radius:999px;padding:.18rem .52rem;margin:.14rem;background:rgba(70,95,125,.18);white-space:normal}
.lc-meta-pill strong{color:inherit;font-weight:700}
.lc-study-note{display:block;box-sizing:border-box;text-align:left;border:1px solid rgba(130,150,175,.35);border-radius:.55rem;padding:.42rem .62rem;margin:.6rem auto 0;max-width:680px;background:rgba(70,95,125,.12)}
.lc-study-note summary{cursor:pointer;font-weight:700}
.lc-study-note div{margin-top:.38rem;white-space:pre-wrap}
</style>`;
    const visibleRows = rows.filter(([label]) => label !== 'Study note');
    const studyNote = rows.find(([label]) => label === 'Study note')?.[1] || '';
    const metaHtml = visibleRows.map(([label, value]) =>
      `<span class="lc-meta-pill"><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</span>`
    ).join(' ');
    const noteHtml = studyNote
      ? `<details class="lc-study-note"><summary>Study note</summary><div>${markdownishToHtml(studyNote)}</div></details>`
      : '';
    return `${style}<div class="lc-card"><div class="lc-answer">${backHtml}</div><hr class="lc-meta-rule"><div class="lc-meta">${metaHtml}${noteHtml}</div></div>`;
  }

  function buildFlashcardAnkiTags(card, baseTags = []) {
    const tags = [...baseTags];
    if (card?.card_type) tags.push(card.card_type);
    if (Array.isArray(card?.tags)) tags.push(...card.tags);
    return [...new Set(tags.map(sanitizeTag).filter(Boolean))];
  }

  return {
    normalizeFlashcard,
    normalizeFlashcardsResponse,
    getFlashcardMetadataRows,
    buildFlashcardMetadataText,
    buildFlashcardBackWithMetadata,
    buildFlashcardBackHtmlWithMetadata,
    markdownishToHtml,
    buildFlashcardAnkiTags,
    formatCardType,
    formatTimeRange,
    convertDollarMathToAnki,
    sanitizeTag
  };
});
