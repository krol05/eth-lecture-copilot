/**
 * WebVTT parsing — the single copy, used by the content script and by Jest.
 *
 * Only the pure half of transcript handling lives here. Finding the event id,
 * locating the caption track and fetching it stay in content/content.js:
 * they read the lecture page and have to resolve ETH's media redirect through
 * the background worker, so they are only meaningfully testable in a browser.
 *
 * This file used to hold a whole second implementation of all of that, loaded
 * by nothing. It drifted until the two disagreed — and the dead copy was the
 * one the tests checked.
 */
(function (root) {
  'use strict';

  /**
   * WebVTT escapes text the way HTML does, so "AT&T" arrives as "AT&amp;T".
   * The content script stripped tags but left these alone, which put the raw
   * escapes into the transcript and from there into every prompt.
   */
  function decodeVttEntities(text) {
    return text
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ')
      .replace(/&lrm;/g, '')
      .replace(/&rlm;/g, '')
      // Last, so "&amp;lt;" decodes to the literal "&lt;" rather than "<".
      .replace(/&amp;/g, '&');
  }

  /** Seconds from "HH:MM:SS.mmm" or "MM:SS.mmm"; NaN if it is neither. */
  function parseTimestamp(ts) {
    const parts = String(ts).split(':').map(Number);
    if (parts.some(n => !isFinite(n))) return NaN;
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return NaN;
  }

  /**
   * Parse a WebVTT file into cues.
   * Cue settings after the end time, cue identifiers, NOTE blocks and the
   * WEBVTT header are all skipped; a block with no "-->" line is not a cue.
   *
   * @param {string} vttText
   * @returns {Array<{start_time:number,end_time:number,text:string}>}
   */
  function parseVtt(vttText) {
    const cues = [];
    const blocks = String(vttText || '').replace(/\r\n/g, '\n').split(/\n\n+/);

    for (const block of blocks) {
      const lines = block.trim().split('\n');

      let timeLine = -1;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('-->')) { timeLine = i; break; }
      }
      if (timeLine === -1) continue;

      const [startStr, endStr] = lines[timeLine].split('-->').map(s => s.trim().split(' ')[0]);
      const start = parseTimestamp(startStr);
      const end = parseTimestamp(endStr);
      if (isNaN(start) || isNaN(end)) continue;

      const text = decodeVttEntities(
        lines.slice(timeLine + 1).join(' ').replace(/<[^>]+>/g, '')
      ).replace(/\s+/g, ' ').trim();

      if (text) cues.push({ start_time: start, end_time: end, text });
    }
    return cues;
  }

  /** HH:MM:SS for a number of seconds. */
  function formatSeconds(s) {
    const total = Math.max(0, Math.floor(s || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const sec = total % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }

  /** The timestamped plain text the model is given. */
  function formatTranscriptForAI(cues) {
    return (cues || []).map(c => `[${formatSeconds(c.start_time)}] ${c.text}`).join('\n');
  }

  const api = { parseVtt, parseTimestamp, formatTranscriptForAI, formatSeconds, decodeVttEntities };

  if (typeof root !== 'undefined') {
    root.parseVtt = parseVtt;
    root.parseTimestamp = parseTimestamp;
    root.formatTranscriptForAI = formatTranscriptForAI;
    root.formatSeconds = formatSeconds;
    root.decodeVttEntities = decodeVttEntities;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof self !== 'undefined' ? self : globalThis);
