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
