'use strict';

const { parseGuideResponse, findMatchingBrace } = require('../lib/guide-parse.js');

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
