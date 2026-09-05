/**
 * Saving your lecture history to a file and reading it back.
 *
 * Everything here is pure: it takes history arrays and returns new ones, so
 * the merge rules can be tested without a browser. The sidebar supplies the
 * URL normaliser it already uses, rather than this file growing a second copy
 * of it.
 */
(function (root) {
  'use strict';

  /** Anything claiming to be one of our exports must carry this. */
  const FORMAT = 'eth-lecture-copilot/history';
  /** Bump when the shape changes in a way older readers cannot handle. */
  const VERSION = 1;
  /** Matches the cap saveToHistory applies. */
  const DEFAULT_LIMIT = 50;

  /** When was this entry's guide made? Falls back through the older fields. */
  function entryTime(entry) {
    const raw = entry?.guideDate || entry?.date || entry?.lectureDate;
    const t = raw ? Date.parse(raw) : NaN;
    return Number.isFinite(t) ? t : 0;
  }

  /**
   * Wrap a history for writing to a file.
   *
   * @param {Array}  history
   * @param {Object<string, any>} [lectureIdMap] the course → lecture-number assignments
   * @param {object} [opts]
   * @param {string} [opts.extensionVersion]
   * @param {boolean}[opts.includeImages=true] keep attached frames in chats
   */
  function buildExportEnvelope(history, lectureIdMap, opts = {}) {
    const { extensionVersion = null, includeImages = true } = opts;
    const entries = Array.isArray(history) ? history : [];
    return {
      format: FORMAT,
      version: VERSION,
      exportedAt: new Date().toISOString(),
      extensionVersion,
      lectureCount: entries.length,
      includesImages: !!includeImages,
      lectureIdMap: lectureIdMap && typeof lectureIdMap === 'object' ? lectureIdMap : {},
      history: includeImages ? entries : entries.map(stripImages)
    };
  }

  /**
   * Drop attached frames from an entry's chats.
   *
   * A term's worth of lectures with pasted screenshots runs to hundreds of
   * megabytes of base64, which is more than a JSON string wants to be.
   */
  function stripImages(entry) {
    const clean = messages => (Array.isArray(messages) ? messages : []).map(m => {
      if (!m || !m.images?.length) return m;
      const { images, ...rest } = m;
      return { ...rest, imagesRemoved: images.length };
    });
    return {
      ...entry,
      qaMessages: clean(entry.qaMessages),
      qaChatsData: (Array.isArray(entry.qaChatsData) ? entry.qaChatsData : [])
        .map(c => ({ ...c, messages: clean(c.messages) }))
    };
  }

  /**
   * Check a parsed file before anything is written.
   *
   * Returns `{ ok: false, error }` with a specific reason rather than a bare
   * failure, so the panel can tell the user what is actually wrong with it.
   */
  function validateImport(parsed) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'That file does not contain a history export (expected a JSON object at the top level).' };
    }
    if (parsed.format !== FORMAT) {
      return {
        ok: false,
        error: `That file is not a Lecture Copilot history export. Expected "format": "${FORMAT}"` +
          (parsed.format ? `, found "${parsed.format}".` : ', but the file has no format field.')
      };
    }
    if (!Number.isInteger(parsed.version) || parsed.version < 1) {
      return { ok: false, error: `Unreadable version field: ${JSON.stringify(parsed.version)}. Expected a whole number of 1 or more.` };
    }
    if (parsed.version > VERSION) {
      return {
        ok: false,
        error: `That export was written by a newer version of the extension (format version ${parsed.version}, this one reads up to ${VERSION}). Update the extension and try again.`
      };
    }
    if (!Array.isArray(parsed.history)) {
      return { ok: false, error: 'The export has no history list.' };
    }

    const entries = [];
    const rejected = [];
    parsed.history.forEach((entry, i) => {
      if (!entry || typeof entry !== 'object') {
        rejected.push(`entry ${i + 1}: not an object`);
      } else if (typeof entry.lectureUrl !== 'string' || !entry.lectureUrl) {
        rejected.push(`entry ${i + 1}: no lecture address`);
      } else if (!Array.isArray(entry.guide?.guide)) {
        rejected.push(`entry ${i + 1} (${entry.lectureTitle || entry.lectureUrl}): no guide blocks`);
      } else {
        entries.push(entry);
      }
    });

    if (!entries.length) {
      return {
        ok: false,
        error: parsed.history.length
          ? `None of the ${parsed.history.length} entries could be read. ${rejected.slice(0, 3).join('; ')}${rejected.length > 3 ? `; and ${rejected.length - 3} more` : ''}.`
          : 'The export contains no lectures.'
      };
    }

    return {
      ok: true,
      entries,
      rejected,
      lectureIdMap: parsed.lectureIdMap && typeof parsed.lectureIdMap === 'object' ? parsed.lectureIdMap : {},
      exportedAt: parsed.exportedAt || null,
      includesImages: parsed.includesImages !== false
    };
  }

  /**
   * Merge imported lectures into the ones already saved.
   *
   * The same lecture is the same entry, so importing a file twice changes
   * nothing. Where both sides have a lecture, the newer guide wins — importing
   * an old backup never overwrites work done since.
   *
   * @param {Array}    existing
   * @param {Array}    incoming
   * @param {object}   [opts]
   * @param {Function} [opts.normalizeUrl] the sidebar's own URL normaliser; it
   *        throws without one, since guessing at URL identity is how copies drift
   * @param {number}   [opts.limit=50]
   * @returns {{history:Array, added:number, updated:number, keptExisting:number}}
   */
  function mergeHistory(existing, incoming, { normalizeUrl, limit = DEFAULT_LIMIT } = {}) {
    if (typeof normalizeUrl !== 'function') {
      throw new Error('mergeHistory needs a normalizeUrl function');
    }
    const byUrl = new Map();
    for (const entry of Array.isArray(existing) ? existing : []) {
      if (entry?.lectureUrl) byUrl.set(normalizeUrl(entry.lectureUrl), entry);
    }

    let added = 0, updated = 0, keptExisting = 0;
    for (const entry of Array.isArray(incoming) ? incoming : []) {
      if (!entry?.lectureUrl) continue;
      const key = normalizeUrl(entry.lectureUrl);
      const current = byUrl.get(key);
      if (!current) {
        byUrl.set(key, entry);
        added++;
      } else if (entryTime(entry) > entryTime(current)) {
        byUrl.set(key, entry);
        updated++;
      } else {
        keptExisting++;
      }
    }

    const history = [...byUrl.values()].sort((a, b) => entryTime(b) - entryTime(a));
    if (history.length > limit) history.length = limit;
    return { history, added, updated, keptExisting };
  }

  /** Merge two lecture-number maps, keeping what is already assigned. */
  function mergeLectureIdMap(existing, incoming) {
    return { ...(incoming || {}), ...(existing || {}) };
  }

  /** A filename that sorts by date and says what it is. */
  function exportFilename(date = new Date()) {
    return `lecture-copilot-history-${date.toISOString().split('T')[0]}.json`;
  }

  const api = {
    FORMAT, VERSION, DEFAULT_LIMIT,
    buildExportEnvelope, validateImport, mergeHistory, mergeLectureIdMap,
    exportFilename, stripImages, entryTime
  };

  if (typeof root !== 'undefined') root.HistoryIO = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
