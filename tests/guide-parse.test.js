'use strict';

const { parseGuideResponse, findMatchingBrace } = require('../lib/guide-parse.js');
const { sanitizeGuide } = require('../lib/schema.js');

describe('parseGuideResponse', () => {
  test('parses clean JSON object', () => {
    const raw = '{"lecture_title":"Test","guide":[{"title":"A","start_time":0,"end_time":10,"key_concepts":[],"formulas":[],"definitions":[],"notes":""}]}';
    const out = parseGuideResponse(raw);
    expect(out.lecture_title).toBe('Test');
    expect(out.guide).toHaveLength(1);
  });

  test('strips markdown fences', () => {
    const inner = '{"x":1}';
    const raw = '```json\n' + inner + '\n```';
    expect(parseGuideResponse(raw)).toEqual({ x: 1 });
  });

  test('extracts first JSON object when extra text wraps it', () => {
    const raw = 'Here you go:\n{"ok":true,"n":2}\ntrailing';
    expect(parseGuideResponse(raw)).toEqual({ ok: true, n: 2 });
  });

  test('throws when no JSON object', () => {
    expect(() => parseGuideResponse('no braces')).toThrow(/No JSON object/);
  });
});

describe('findMatchingBrace', () => {
  test('returns index of matching top-level brace', () => {
    const s = '{"a":1}';
    expect(findMatchingBrace(s)).toBe(s.length - 1);
  });
});

describe('sanitizeGuide', () => {
  test('preserves generated guide_title', () => {
    const guide = sanitizeGuide({
      lecture_title: 'Digital Design and Computer Architecture',
      guide_title: 'Introduction to Caches',
      guide: [{ title: 'Locality', start_time: 0, end_time: 10, key_concepts: [], formulas: [], definitions: [] }]
    });
    expect(guide.guide_title).toBe('Introduction to Caches');
  });

  test('backfills guide_title for old saved guides', () => {
    const guide = sanitizeGuide({
      lecture_title: 'Old Lecture',
      guide: [{ title: 'First Topic', start_time: 0, end_time: 10, key_concepts: [], formulas: [], definitions: [] }]
    });
    expect(guide.guide_title).toBe('First Topic');
  });

  test('preserves compact study_flow references and drops invalid entries', () => {
    const guide = sanitizeGuide({
      lecture_title: 'Lecture',
      guide: [{
        title: 'Prefetching',
        start_time: 0,
        end_time: 10,
        key_concepts: ['Accuracy measures useful prefetches.', 'Coverage measures eliminated misses.'],
        formulas: [{ label: 'Accuracy', latex: '\\frac{Used}{Sent}' }],
        definitions: [{ term: 'Coverage', definition: 'Fraction of misses avoided.' }],
        notes: 'Do not optimize one metric blindly.',
        study_flow: [
          { type: 'concept', index: 1, label: 'Tradeoff' },
          { type: 'definition', index: 0 },
          { type: 'formula', index: 0 },
          { type: 'note' },
          { type: 'concept', index: 9, label: 'Invalid' },
          { type: 'example', index: 0 }
        ]
      }]
    });

    expect(guide.guide[0].study_flow).toEqual([
      { type: 'concept', index: 1, label: 'Tradeoff' },
      { type: 'definition', index: 0 },
      { type: 'formula', index: 0 },
      { type: 'note' }
    ]);
  });

  test('preserves optional key concept labels for legacy guide display', () => {
    const guide = sanitizeGuide({
      lecture_title: 'Lecture',
      guide: [{
        title: 'Callbacks',
        start_time: 0,
        end_time: 10,
        key_concepts: ['Callbacks return values. They pass results back to the caller.'],
        key_concept_labels: ['Interface choice'],
        formulas: [],
        definitions: []
      }]
    });

    expect(guide.guide[0].key_concept_labels).toEqual(['Interface choice']);
  });

  test('preserves structured key concepts', () => {
    const guide = sanitizeGuide({
      lecture_title: 'Lecture',
      guide: [{
        title: 'Traversal',
        start_time: 0,
        end_time: 10,
        key_concepts: [{
          label: 'Queue',
          lead: 'BFS uses a queue.',
          body: 'The queue preserves level order.'
        }],
        formulas: [],
        definitions: []
      }]
    });

    expect(guide.guide[0].key_concepts).toEqual([{
      label: 'Queue',
      lead: 'BFS uses a queue.',
      body: 'The queue preserves level order.'
    }]);
  });
});

describe('createGuideBlockScanner', () => {
  const { createGuideBlockScanner } = require('../lib/guide-parse.js');

  const block = (n) => `{"title":"Block ${n}","start_time":${n * 10},"end_time":${n * 10 + 10},` +
    `"key_concepts":["point ${n}"],"formulas":[],"definitions":[],"notes":""}`;

  const guideJson = (n) =>
    `{"lecture_title":"Test","total_duration_seconds":${n * 10},"guide":[` +
    Array.from({ length: n }, (_, i) => block(i)).join(',') + `]}`;

  /** Feed a string through the scanner in fixed-size pieces. */
  function feed(text, chunkSize) {
    const scanner = createGuideBlockScanner();
    for (let i = 0; i < text.length; i += chunkSize) {
      scanner.push(text.slice(i, i + chunkSize));
    }
    return scanner;
  }

  test('finds every block however the stream is chopped up', () => {
    const json = guideJson(12);
    for (const size of [1, 3, 7, 64, 5000]) {
      const scanner = feed(json, size);
      expect(scanner.blocks).toHaveLength(12);
      expect(scanner.blocks[0].title).toBe('Block 0');
      expect(scanner.blocks[11].title).toBe('Block 11');
      expect(scanner.done).toBe(true);
    }
  });

  test('a chunk size of one still finds the "guide": [ opener', () => {
    // The opener spans several chunks here, which is why the scanner keeps a
    // little overlap when it has not found it yet.
    expect(feed(guideJson(2), 1).blocks).toHaveLength(2);
  });

  test('push returns only the blocks that just finished', () => {
    const scanner = createGuideBlockScanner();
    const half = block(0).slice(0, -1);
    expect(scanner.push('{"guide":[' + half)).toEqual([]);   // block 0 still open
    expect(scanner.push('},')).toHaveLength(1);              // block 0 closes here
    expect(scanner.push(block(1) + ',' + block(2) + ',')).toHaveLength(2);
    expect(scanner.blocks).toHaveLength(3);
  });

  test('braces and quotes inside strings do not end a block early', () => {
    const tricky = '{"title":"a } b { c","notes":"he said \\"hi\\" and \\\\ left"}';
    const scanner = createGuideBlockScanner();
    scanner.push(`{"guide":[${tricky}]}`);
    expect(scanner.blocks).toEqual([{ title: 'a } b { c', notes: 'he said "hi" and \\ left' }]);
  });

  test('an unfinished block is never handed out', () => {
    const scanner = createGuideBlockScanner();
    scanner.push('{"guide":[{"title":"half wri');
    expect(scanner.blocks).toEqual([]);
    scanner.push('tten"}]}');
    expect(scanner.blocks).toEqual([{ title: 'half written' }]);
  });

  test('nothing before the guide array is mistaken for a block', () => {
    const scanner = createGuideBlockScanner();
    scanner.push('{"meta":{"model":"x"},"lecture_title":"T","guide":[' + block(0) + ']}');
    expect(scanner.blocks).toHaveLength(1);
    expect(scanner.blocks[0].title).toBe('Block 0');
  });

  test('each block is parsed once, no matter how many chunks arrive', () => {
    // This is the regression guard. The old code re-parsed every block already
    // seen on every chunk, so a long guide slowed down as it streamed.
    const json = guideJson(30);
    const spy = jest.spyOn(JSON, 'parse');
    try {
      spy.mockClear();
      feed(json, 4);                       // ~hundreds of chunks
      expect(spy).toHaveBeenCalledTimes(30);
    } finally {
      spy.mockRestore();
    }
  });
});
