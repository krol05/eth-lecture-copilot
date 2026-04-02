/**
 * transcript.js
 * Extracts and parses transcripts from ETH video.ethz.ch (Tobira/Paella platform).
 *
 * Strategy:
 * 1. Extract the Opencast event ID from the page's JSON-LD VideoObject schema
 *    (thumbnailUrl contains dist.tobira.ethz.ch/mh_default_org/engage-player/{eventId}/...)
 * 2. Fetch player data from dist.tobira.ethz.ch/mh_default_org/engage-player/{eventId}/data.json
 * 3. Find the captions/subtitles track in the tracks list
 * 4. Fetch the .vtt file and parse it into timestamped segments
 *
 * Falls back to manual paste if auto-detection fails.
 */

const TOBIRA_BASE = 'https://dist.tobira.ethz.ch/mh_default_org/engage-player';

/**
 * Extract the Opencast event UUID from the page.
 * The JSON-LD VideoObject's thumbnailUrl embeds the event ID.
 * Also checks img src attributes and the Paella player container.
 *
 * @returns {string|null} UUID like "6ca8e2d8-f47f-47d2-92ca-5dafad952828"
 */
function extractEventId() {
  // Method 1: JSON-LD schema.org VideoObject
  const ldScripts = document.querySelectorAll('script[type="application/ld+json"]');
  for (const script of ldScripts) {
    try {
      const data = JSON.parse(script.textContent);
      const url = data.thumbnailUrl || data.contentUrl || '';
      const match = url.match(/engage-player\/([0-9a-f-]{36})\//i);
      if (match) return match[1];
    } catch (_) {}
  }

  // Method 2: any img src on the page from Tobira CDN
  const imgs = document.querySelectorAll('img[src*="dist.tobira.ethz.ch"]');
  for (const img of imgs) {
    const match = img.src.match(/engage-player\/([0-9a-f-]{36})\//i);
    if (match) return match[1];
  }

  // Method 3: scan all script tags for event UUID pattern near "engage-player"
  for (const script of document.querySelectorAll('script:not([src])')) {
    const match = script.textContent.match(/engage-player\/([0-9a-f-]{36})\//i);
    if (match) return match[1];
  }

  // TODO: add more extraction methods if the above fail on other ETH video pages
  return null;
}

/**
 * Fetch Paella player data.json for the given event ID.
 * This JSON describes all media tracks including captions.
 *
 * @param {string} eventId
 * @returns {Promise<object>} parsed data.json
 */
async function fetchPlayerData(eventId) {
  const url = `${TOBIRA_BASE}/${eventId}/data.json`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to fetch player data: ${resp.status}`);
  return resp.json();
}

/**
 * Find the best captions track URL from the player data.
 * Looks for tracks of type "captions" or "subtitles", prefers English or German.
 *
 * @param {object} playerData
 * @returns {string|null} absolute URL to .vtt file
 */
function findCaptionsUrl(playerData) {
  // Paella data.json structure: { streams: [{ sources: { captions: [{src, lang}] } }] }
  // or: { captions: [{id, lang, url}] }
  // ETH Tobira may vary — handle both known shapes.

  // Shape 1: top-level captions array
  if (Array.isArray(playerData.captions)) {
    const track = playerData.captions.find(c => /en|de/i.test(c.lang)) || playerData.captions[0];
    if (track) return track.url || track.src;
  }

  // Shape 2: streams[].sources.captions
  if (Array.isArray(playerData.streams)) {
    for (const stream of playerData.streams) {
      const caps = stream?.sources?.captions;
      if (Array.isArray(caps) && caps.length > 0) {
        const track = caps.find(c => /en|de/i.test(c.lang)) || caps[0];
        return track.src || track.url;
      }
    }
  }

  // Shape 3: tracks array with mimetype
  if (Array.isArray(playerData.tracks)) {
    const captionTrack = playerData.tracks.find(t =>
      t.type?.includes('captions') || t.type?.includes('subtitle') ||
      t.flavor?.includes('captions') || (t.url || '').endsWith('.vtt')
    );
    if (captionTrack) return captionTrack.url || captionTrack.src;
  }

  // TODO: inspect actual data.json structure and update selectors above

  return null;
}

/**
 * Build the captions VTT URL from event ID and track ID.
 * Known URL pattern from video.ethz.ch:
 * https://dist.tobira.ethz.ch/mh_default_org/engage-player/{eventId}/{trackId}/captions-{trackId}.vtt
 *
 * @param {string} eventId
 * @param {string} trackId
 * @returns {string}
 */
function buildVttUrl(eventId, trackId) {
  return `${TOBIRA_BASE}/${eventId}/${trackId}/captions-${trackId}.vtt`;
}

/**
 * Parse a WebVTT string into an array of cue objects.
 *
 * @param {string} vttText
 * @returns {Array<{start_time: number, end_time: number, text: string}>}
 */
function parseVtt(vttText) {
  const cues = [];
  // Split on double newline (cue separator)
  const blocks = vttText.replace(/\r\n/g, '\n').split(/\n\n+/);

  for (const block of blocks) {
    const lines = block.trim().split('\n');
    // Find the timestamp line: 00:00:00.000 --> 00:00:05.000
    let timeLine = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('-->')) { timeLine = i; break; }
    }
    if (timeLine === -1) continue;

    const [startStr, endStr] = lines[timeLine].split('-->').map(s => s.trim().split(' ')[0]);
    const start = parseTimestamp(startStr);
    const end = parseTimestamp(endStr);
    if (isNaN(start) || isNaN(end)) continue;

    const text = lines.slice(timeLine + 1).join(' ')
      .replace(/<[^>]+>/g, '')   // strip VTT tags like <c.color>
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .trim();

    if (text) cues.push({ start_time: start, end_time: end, text });
  }
  return cues;
}

/**
 * Convert VTT timestamp string to seconds.
 * Handles both HH:MM:SS.mmm and MM:SS.mmm formats.
 */
function parseTimestamp(ts) {
  const parts = ts.split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return NaN;
}

/**
 * Format cues into a transcript string suitable for AI consumption.
 * Each line: [HH:MM:SS] text
 */
function formatTranscriptForAI(cues) {
  return cues.map(c => `[${formatSeconds(c.start_time)}] ${c.text}`).join('\n');
}

function formatSeconds(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
}

/**
 * Main entry point: attempt to auto-extract transcript from the current page.
 *
 * @returns {Promise<{cues: Array, text: string, eventId: string, vttUrl: string}|null>}
 */
async function extractTranscript() {
  const eventId = extractEventId();
  if (!eventId) return null;

  let vttUrl = null;
  let cues = null;

  try {
    const playerData = await fetchPlayerData(eventId);
    vttUrl = findCaptionsUrl(playerData);
  } catch (e) {
    console.warn('[ETH Copilot] Could not fetch player data:', e.message);
  }

  // Fallback: try to find VTT URL by scanning page sources for known URL pattern
  if (!vttUrl) {
    const allLinks = Array.from(document.querySelectorAll('a[href*=".vtt"], source[src*=".vtt"], track[src*=".vtt"]'));
    if (allLinks.length > 0) {
      vttUrl = allLinks[0].href || allLinks[0].src;
    }
  }

  if (!vttUrl) return null;

  try {
    const resp = await fetch(vttUrl);
    if (!resp.ok) throw new Error(`VTT fetch failed: ${resp.status}`);
    const vttText = await resp.text();
    cues = parseVtt(vttText);
  } catch (e) {
    console.warn('[ETH Copilot] Could not fetch VTT:', e.message);
    return null;
  }

  if (!cues || cues.length === 0) return null;

  return {
    cues,
    text: formatTranscriptForAI(cues),
    eventId,
    vttUrl
  };
}

// Expose for module usage (content script / background)
if (typeof module !== 'undefined') {
  module.exports = { extractTranscript, parseVtt, parseTimestamp, formatTranscriptForAI };
}
