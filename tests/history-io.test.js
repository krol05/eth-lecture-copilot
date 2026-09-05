'use strict';

const {
  FORMAT, VERSION,
  buildExportEnvelope, validateImport, mergeHistory, mergeLectureIdMap,
  exportFilename, stripImages
} = require('../lib/history-io.js');

/** The sidebar's normaliser, simplified to what the merge actually relies on. */
const normalizeUrl = (u) => String(u).trim().split('#')[0].split('?')[0].replace(/\/+$/, '');

const lecture = (url, date, extra = {}) => ({
  lectureUrl: url,
  lectureTitle: `Lecture ${url}`,
  guideDate: date,
  guide: { guide: [{ title: 'Block', start_time: 0, end_time: 10 }] },
  ...extra
});

describe('buildExportEnvelope', () => {
  test('stamps the format so an import can recognise it', () => {
    const env = buildExportEnvelope([lecture('/a', '2026-01-01')], { CS: 1 });
    expect(env.format).toBe(FORMAT);
    expect(env.version).toBe(VERSION);
    expect(env.lectureCount).toBe(1);
    expect(env.lectureIdMap).toEqual({ CS: 1 });
    expect(Date.parse(env.exportedAt)).not.toBeNaN();
  });

  test('survives being handed nothing', () => {
    const env = buildExportEnvelope(null, null);
    expect(env.history).toEqual([]);
    expect(env.lectureCount).toBe(0);
    expect(env.lectureIdMap).toEqual({});
  });

  test('can leave attached frames out, and says that it did', () => {
    const withImage = lecture('/a', '2026-01-01', {
      qaMessages: [{ role: 'user', content: 'what is this', images: [{ dataUrl: 'data:image/png;base64,AAAA' }] }]
    });
    const env = buildExportEnvelope([withImage], {}, { includeImages: false });
    expect(env.includesImages).toBe(false);
    expect(env.history[0].qaMessages[0].images).toBeUndefined();
    expect(env.history[0].qaMessages[0].imagesRemoved).toBe(1);
    expect(env.history[0].qaMessages[0].content).toBe('what is this');
  });

  test('leaving frames out does not touch the original', () => {
    const withImage = lecture('/a', '2026-01-01', {
      qaMessages: [{ role: 'user', content: 'x', images: [{ dataUrl: 'd' }] }]
    });
    buildExportEnvelope([withImage], {}, { includeImages: false });
    expect(withImage.qaMessages[0].images).toHaveLength(1);
  });

  test('strips frames from every chat, not just the first', () => {
    const entry = lecture('/a', '2026-01-01', {
      qaChatsData: [
        { id: 1, messages: [{ role: 'user', content: 'a', images: [{ dataUrl: 'd' }] }] },
        { id: 2, messages: [{ role: 'user', content: 'b', images: [{ dataUrl: 'd' }, { dataUrl: 'e' }] }] }
      ]
    });
    const [out] = stripImages(entry).qaChatsData ? [stripImages(entry)] : [];
    expect(out.qaChatsData[1].messages[0].imagesRemoved).toBe(2);
  });
});

describe('validateImport', () => {
  const good = buildExportEnvelope([lecture('/a', '2026-01-01')], {});

  test('accepts what buildExportEnvelope wrote', () => {
    const res = validateImport(good);
    expect(res.ok).toBe(true);
    expect(res.entries).toHaveLength(1);
  });

  test('rejects a file that is not one of our exports, and says so', () => {
    const res = validateImport({ some: 'other json' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not a Lecture Copilot history export/);
  });

  test('rejects things that are not objects at all', () => {
    for (const junk of [null, undefined, 42, 'text', []]) {
      expect(validateImport(junk).ok).toBe(false);
    }
  });

  test('refuses a newer format rather than reading it wrong', () => {
    const res = validateImport({ ...good, version: VERSION + 1 });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/newer version/);
  });

  test('names what was wrong with unreadable entries', () => {
    const res = validateImport({ ...good, history: [{ lectureUrl: '/a' }, null] });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/no guide blocks/);
  });

  test('keeps the good entries when only some are broken', () => {
    const res = validateImport({ ...good, history: [lecture('/a', '2026-01-01'), { junk: true }] });
    expect(res.ok).toBe(true);
    expect(res.entries).toHaveLength(1);
    expect(res.rejected).toHaveLength(1);
  });

  test('an export with no lectures is not an error worth merging', () => {
    expect(validateImport({ ...good, history: [] }).ok).toBe(false);
  });
});

describe('mergeHistory', () => {
  test('adds lectures that are not there yet', () => {
    const res = mergeHistory([lecture('/a', '2026-01-01')], [lecture('/b', '2026-02-01')], { normalizeUrl });
    expect(res.added).toBe(1);
    expect(res.history.map(h => h.lectureUrl)).toEqual(['/b', '/a']);
  });

  test('importing the same file twice changes nothing', () => {
    const mine = [lecture('/a', '2026-01-01')];
    const once = mergeHistory(mine, mine, { normalizeUrl });
    const twice = mergeHistory(once.history, mine, { normalizeUrl });
    expect(once.history).toHaveLength(1);
    expect(twice.history).toHaveLength(1);
    expect(twice.added).toBe(0);
  });

  test('an old backup never overwrites newer work', () => {
    const res = mergeHistory(
      [lecture('/a', '2026-06-01', { lectureTitle: 'current' })],
      [lecture('/a', '2026-01-01', { lectureTitle: 'from backup' })],
      { normalizeUrl }
    );
    expect(res.history[0].lectureTitle).toBe('current');
    expect(res.keptExisting).toBe(1);
    expect(res.updated).toBe(0);
  });

  test('a newer import does replace an older local copy', () => {
    const res = mergeHistory(
      [lecture('/a', '2026-01-01', { lectureTitle: 'old' })],
      [lecture('/a', '2026-06-01', { lectureTitle: 'newer' })],
      { normalizeUrl }
    );
    expect(res.history[0].lectureTitle).toBe('newer');
    expect(res.updated).toBe(1);
  });

  test('the same lecture with a trailing slash or query is the same lecture', () => {
    const res = mergeHistory(
      [lecture('https://video.ethz.ch/lec/1', '2026-01-01')],
      [lecture('https://video.ethz.ch/lec/1/?x=2', '2026-02-01')],
      { normalizeUrl }
    );
    expect(res.history).toHaveLength(1);
    expect(res.updated).toBe(1);
  });

  test('results come back newest first', () => {
    const res = mergeHistory(
      [lecture('/a', '2026-01-01'), lecture('/c', '2026-05-01')],
      [lecture('/b', '2026-03-01')],
      { normalizeUrl }
    );
    expect(res.history.map(h => h.lectureUrl)).toEqual(['/c', '/b', '/a']);
  });

  test('entries with no date still merge, they just sort last', () => {
    const undated = { lectureUrl: '/x', guide: { guide: [] } };
    const res = mergeHistory([lecture('/a', '2026-01-01')], [undated], { normalizeUrl });
    expect(res.history.map(h => h.lectureUrl)).toEqual(['/a', '/x']);
  });

  test('respects the same cap the extension saves under', () => {
    const many = Array.from({ length: 60 }, (_, i) => lecture(`/l${i}`, `2026-01-${String((i % 28) + 1).padStart(2, '0')}`));
    expect(mergeHistory([], many, { normalizeUrl }).history).toHaveLength(50);
    expect(mergeHistory([], many, { normalizeUrl, limit: 5 }).history).toHaveLength(5);
  });

  test('refuses to guess at URL identity on its own', () => {
    // Reimplementing the normaliser here is how the copies drift apart.
    expect(() => mergeHistory([], [], {})).toThrow(/normalizeUrl/);
  });

  test('missing lists are treated as empty', () => {
    expect(mergeHistory(null, null, { normalizeUrl }).history).toEqual([]);
  });
});

describe('mergeLectureIdMap', () => {
  test('numbers already assigned locally win', () => {
    expect(mergeLectureIdMap({ 'CS:/a': 1 }, { 'CS:/a': 9, 'CS:/b': 2 }))
      .toEqual({ 'CS:/a': 1, 'CS:/b': 2 });
  });
});

describe('exportFilename', () => {
  test('carries the date so backups sort', () => {
    expect(exportFilename(new Date('2026-09-04T10:00:00Z'))).toBe('lecture-copilot-history-2026-09-04.json');
  });
});
