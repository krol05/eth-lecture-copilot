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

describe('recovering a guide the model did not finish', () => {
  test('reads a guide wrapped in a code fence', () => {
    const raw = '```json\n{"lecture_title":"T","guide":[]}\n```';
    expect(parseGuideResponse(raw).lecture_title).toBe('T');
  });

  test('ignores chatter before and after the JSON', () => {
    const raw = 'Sure! Here is your guide:\n{"lecture_title":"T","guide":[]}\nHope that helps.';
    expect(parseGuideResponse(raw).lecture_title).toBe('T');
  });

  test('strips control characters that make JSON.parse refuse the whole thing', () => {
    const raw = '{"lecture_title":"AB","guide":[]}';
    expect(parseGuideResponse(raw).lecture_title).toBe('AB');
  });

  test('drops a trailing comma rather than losing the guide', () => {
    const raw = '{"lecture_title":"T","guide":[{"title":"A"},]}';
    expect(parseGuideResponse(raw).guide).toHaveLength(1);
  });

  test('rescues a guide cut off mid-string', () => {
    // What a token limit actually looks like: the response just stops.
    const raw = '{"lecture_title":"T","guide":[{"title":"Block one","notes":"still writ';
    const out = parseGuideResponse(raw);
    expect(out.lecture_title).toBe('T');
    expect(out.guide[0].title).toBe('Block one');
  });

  test('rescues a guide cut off between blocks', () => {
    const raw = '{"lecture_title":"T","guide":[{"title":"A"},{"title":"B"},';
    const out = parseGuideResponse(raw);
    expect(out.guide.map(b => b.title)).toEqual(['A', 'B']);
  });

  test('gives up with advice rather than a bare failure', () => {
    expect(() => parseGuideResponse('no json here at all')).toThrow(/No JSON object found/);
    expect(() => parseGuideResponse('')).toThrow(/No JSON object found/);
  });
});

describe('fixEscapes', () => {
  const { fixEscapes } = require('../lib/guide-parse.js');

  test('escapes a raw newline inside a string', () => {
    // Models emit real newlines inside JSON strings, which is invalid JSON.
    expect(JSON.parse(fixEscapes('{"a":"one\ntwo"}')).a).toBe('one\ntwo');
  });

  test('escapes a raw tab and drops carriage returns', () => {
    expect(JSON.parse(fixEscapes('{"a":"one\ttwo"}')).a).toBe('one\ttwo');
    expect(JSON.parse(fixEscapes('{"a":"one\r\ntwo"}')).a).toBe('one\ntwo');
  });

  test('repairs the stray backslashes LaTeX produces constantly', () => {
    // None of these is valid JSON, so without repair the whole guide is lost.
    const raw = String.raw`{"a":"\alpha","b":"\frac{1}{2}","c":"\beta","d":"\underline{x}"}`;
    const out = JSON.parse(fixEscapes(raw));
    expect(out.a).toBe(String.raw`\alpha`);
    // These three collide with JSON's own \f, \b and \u escapes. Reading them
    // as escapes turned \frac into a form feed followed by "rac".
    expect(out.b).toBe(String.raw`\frac{1}{2}`);
    expect(out.c).toBe(String.raw`\beta`);
    expect(out.d).toBe(String.raw`\underline{x}`);
  });

  test('a real unicode escape is still an escape', () => {
    // \u only counts when four hex digits follow, which is what separates it
    // from \underline.
    expect(JSON.parse(fixEscapes(String.raw`{"a":"caf\u00e9"}`)).a).toBe('café');
  });

  test('line breaks and tabs in notes still mean what they say', () => {
    // Unlike \f and \b, these are things a model genuinely writes, so they
    // stay escapes — which does leave \nabla and \theta ambiguous.
    expect(JSON.parse(fixEscapes(String.raw`{"a":"one\ntwo"}`)).a).toBe('one\ntwo');
  });

  test('leaves valid escapes alone', () => {
    expect(JSON.parse(fixEscapes('{"a":"quote \\" and slash \\\\"}')).a).toBe('quote " and slash \\');
  });

  test('handles a backslash at the very end', () => {
    expect(() => fixEscapes('{"a":"trailing\\')).not.toThrow();
  });
});

describe('salvageTruncated', () => {
  const { salvageTruncated } = require('../lib/guide-parse.js');

  test('closes whatever the model left open', () => {
    expect(salvageTruncated('{"a":[1,2')).toEqual({ a: [1, 2] });
    expect(salvageTruncated('{"a":{"b":1')).toEqual({ a: { b: 1 } });
  });

  test('closes an unterminated string', () => {
    expect(salvageTruncated('{"a":"half')).toEqual({ a: 'half' });
  });

  test('returns null when there is nothing to salvage', () => {
    expect(salvageTruncated('completely broken {{{')).toBeNull();
  });
});
