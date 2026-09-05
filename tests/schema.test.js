'use strict';

const {
  toSeconds, sanitizeGuide, sanitizeStudyFlow, sanitizeKeyConcepts, guideTitleFrom
} = require('../lib/schema.js');

describe('toSeconds', () => {
  test('a number is already seconds', () => {
    expect(toSeconds(90)).toBe(90);
    expect(toSeconds(0)).toBe(0);
    expect(toSeconds(12.5)).toBe(12.5);
  });

  test('reads the clock formats models actually emit', () => {
    expect(toSeconds('00:01:30')).toBe(90);
    expect(toSeconds('01:00:00')).toBe(3600);
    expect(toSeconds('1:30')).toBe(90);
    expect(toSeconds('00:01:30.500')).toBe(90.5);
  });

  test('accepts a comma decimal, which some locales produce', () => {
    expect(toSeconds('00:01:30,500')).toBe(90.5);
    expect(toSeconds('90,5')).toBe(90.5);
  });

  test('reads a bare numeric string', () => {
    expect(toSeconds('90')).toBe(90);
    expect(toSeconds(' 90.5 ')).toBe(90.5);
  });

  test('anything unreadable is 0 rather than NaN', () => {
    // NaN here would put a block at an unsortable position and break navigation.
    for (const junk of ['abc', '', null, undefined, {}, [], NaN, Infinity]) {
      expect(toSeconds(junk)).toBe(0);
    }
  });
});

describe('sanitizeGuide', () => {
  const block = (extra = {}) => ({ title: 'B', key_concepts: [], formulas: [], definitions: [], notes: '', ...extra });

  test('turns clock strings into seconds', () => {
    const g = sanitizeGuide({ guide: [block({ start_time: '00:01:30', end_time: '00:02:00' })] });
    expect(g.guide[0]).toMatchObject({ start_time: 90, end_time: 120 });
  });

  test('puts blocks in time order', () => {
    const g = sanitizeGuide({
      guide: [block({ title: 'B', start_time: 100, end_time: 200 }), block({ title: 'A', start_time: 0, end_time: 100 })]
    });
    expect(g.guide.map(b => b.title)).toEqual(['A', 'B']);
  });

  test('repairs an end time that is missing or before its start', () => {
    // Timestamp sync uses [start, end), so an inverted range means a block
    // that can never be the current one.
    const g = sanitizeGuide({
      guide: [
        block({ title: 'A', start_time: 0, end_time: 0 }),
        block({ title: 'B', start_time: 60, end_time: 30 })
      ]
    });
    expect(g.guide[0].end_time).toBe(60);   // runs up to the next block
    expect(g.guide[1].end_time).toBe(61);   // last block gets a second
  });

  test('clamps negative times', () => {
    const g = sanitizeGuide({ guide: [block({ start_time: -5, end_time: -1 })] });
    expect(g.guide[0].start_time).toBe(0);
    expect(g.guide[0].end_time).toBeGreaterThan(0);
  });

  test('fills in fields the model left out', () => {
    const g = sanitizeGuide({ guide: [{}] });
    expect(g.guide[0]).toMatchObject({
      title: 'Untitled Section', formulas: [], definitions: [], notes: '', key_concepts: []
    });
  });

  test('names the guide, falling back as far as it must', () => {
    expect(sanitizeGuide({ guide_title: 'Explicit', guide: [] }).guide_title).toBe('Explicit');
    expect(sanitizeGuide({ guide: [block({ title: 'First block' })] }).guide_title).toBe('First block');
    expect(sanitizeGuide({ lecture_title: 'Lecture 3', guide: [{}] }).guide_title).toBe('Untitled Section');
    expect(sanitizeGuide({ guide: [] }, 'From the page').guide_title).toBe('From the page');
    expect(sanitizeGuide({ guide: [] }).guide_title).toBe('Lecture');
  });

  test('a title is trimmed to something a filename can hold', () => {
    expect(sanitizeGuide({ guide_title: 'x'.repeat(300), guide: [] }).guide_title).toHaveLength(120);
  });

  test('anything that is not a guide comes back untouched', () => {
    expect(sanitizeGuide({ guide: 'nonsense' })).toEqual({ guide: 'nonsense' });
    expect(sanitizeGuide(null)).toBeNull();
  });
});

describe('sanitizeKeyConcepts', () => {
  test('keeps plain strings, which older saved guides use', () => {
    expect(sanitizeKeyConcepts(['one', 'two'])).toEqual(['one', 'two']);
  });

  test('keeps the label/lead/body shape current guides use', () => {
    expect(sanitizeKeyConcepts([{ label: 'Core', lead: 'The idea', body: 'More' }]))
      .toEqual([{ label: 'Core', lead: 'The idea', body: 'More' }]);
  });

  test('takes a label from the block when the concept has none', () => {
    expect(sanitizeKeyConcepts([{ lead: 'x' }], ['Overview'])[0].label).toBe('Overview');
  });

  test('drops empties rather than rendering blank bullets', () => {
    expect(sanitizeKeyConcepts(['', null, {}, { lead: '' }])).toEqual([]);
    expect(sanitizeKeyConcepts('not an array')).toEqual([]);
  });
});

describe('sanitizeStudyFlow', () => {
  const block = {
    key_concepts: ['a', 'b'], formulas: [{ latex: 'x' }], definitions: [], notes: 'note here'
  };

  test('keeps steps that point at content the block has', () => {
    expect(sanitizeStudyFlow({ ...block, study_flow: [{ type: 'concept', index: 1 }, { type: 'note' }] }))
      .toEqual([{ type: 'concept', index: 1 }, { type: 'note' }]);
  });

  test('drops a step pointing past the end', () => {
    // Models reference formula 3 of 2 often enough to matter.
    expect(sanitizeStudyFlow({ ...block, study_flow: [{ type: 'formula', index: 5 }] })).toEqual([]);
    expect(sanitizeStudyFlow({ ...block, study_flow: [{ type: 'definition', index: 0 }] })).toEqual([]);
  });

  test('drops a note step when the block has no note', () => {
    expect(sanitizeStudyFlow({ ...block, notes: '  ', study_flow: [{ type: 'note' }] })).toEqual([]);
  });

  test('drops unknown types and malformed steps', () => {
    expect(sanitizeStudyFlow({
      ...block,
      study_flow: [{ type: 'video', index: 0 }, null, 'nope', { index: 0 }]
    })).toEqual([]);
  });

  test('keeps a label but trims it to what fits', () => {
    const out = sanitizeStudyFlow({ ...block, study_flow: [{ type: 'concept', index: 0, label: 'x'.repeat(40) }] });
    expect(out[0].label).toHaveLength(24);
  });

  test('no study flow is an empty one', () => {
    expect(sanitizeStudyFlow({ ...block })).toEqual([]);
  });
});

describe('guideTitleFrom', () => {
  test('prefers what the guide names itself', () => {
    expect(guideTitleFrom({ guide_title: 'A', lecture_title: 'B' })).toBe('A');
    expect(guideTitleFrom({ guideTitle: 'Legacy' })).toBe('Legacy');
  });

  test('falls through to the block, the lecture, then what it was given', () => {
    expect(guideTitleFrom({ guide: [{ title: 'Block' }], lecture_title: 'L' })).toBe('Block');
    expect(guideTitleFrom({ lecture_title: 'L' })).toBe('L');
    expect(guideTitleFrom({}, 'Page title')).toBe('Page title');
    expect(guideTitleFrom(null)).toBe('Lecture');
  });
});
