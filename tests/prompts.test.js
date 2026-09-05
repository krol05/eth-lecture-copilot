'use strict';

const {
  GUIDE_SYSTEM_PROMPT,
  buildQASystemPrompt,
  normalizeFlashcardTypeSelection,
  buildFlashcardsPrompt,
  buildQuizPrompt,
  buildExamQuestionsPrompt,
  buildCrossLecturePredictionPrompt,
  buildToolAskPrompt
} = require('../lib/prompts.js');

/**
 * These check that a builder runs and that the options the UI offers actually
 * reach the prompt. They deliberately do not assert the wording — prompt prose
 * changes constantly, and tests that pin it down only ever produce false
 * failures. What matters is that no builder throws on real input and that
 * choosing "20 cards in German" is not silently dropped.
 */

const guide = {
  lecture_title: 'Probability',
  guide_title: 'Probability',
  guide: [
    {
      title: 'Variance', start_time: 0, end_time: 60,
      key_concepts: [{ label: 'Core', lead: 'Variance measures spread.', body: '' }],
      formulas: [{ label: 'Var', latex: 'Var(X)=E[X^2]-E[X]^2' }],
      definitions: [{ term: 'Variance', definition: 'Expected squared deviation' }],
      notes: 'Comes up in the exam.'
    },
    {
      title: 'Bayes', start_time: 60, end_time: 120,
      key_concepts: ['Bayes rule relates conditionals.'],
      formulas: [], definitions: [], notes: ''
    }
  ]
};

const builders = {
  buildFlashcardsPrompt: () => buildFlashcardsPrompt(guide, {}),
  buildQuizPrompt: () => buildQuizPrompt(guide, {}),
  buildExamQuestionsPrompt: () => buildExamQuestionsPrompt(guide, ['Variance'], {}),
  buildCrossLecturePredictionPrompt: () => buildCrossLecturePredictionPrompt([{ ...guide }], {}),
  buildToolAskPrompt: () => buildToolAskPrompt({
    sourceType: 'flashcard', itemPayload: { front: 'f', back: 'b' }, lectureTitle: 'L', guide
  }),
  buildQASystemPrompt: () => buildQASystemPrompt('transcript text', guide, 'Probability')
};

describe('every prompt builder produces something usable', () => {
  test.each(Object.keys(builders))('%s returns a non-empty prompt', (name) => {
    const out = builders[name]();
    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(100);
  });

  test.each(Object.keys(builders))('%s survives an empty guide', (name) => {
    const empty = { guide: [] };
    expect(() => {
      switch (name) {
        case 'buildFlashcardsPrompt': return buildFlashcardsPrompt(empty, {});
        case 'buildQuizPrompt': return buildQuizPrompt(empty, {});
        case 'buildExamQuestionsPrompt': return buildExamQuestionsPrompt(empty, [], {});
        case 'buildCrossLecturePredictionPrompt': return buildCrossLecturePredictionPrompt([], {});
        case 'buildToolAskPrompt': return buildToolAskPrompt({});
        default: return buildQASystemPrompt('', empty, '');
      }
    }).not.toThrow();
  });

  test('the guide system prompt asks for the fields the parser expects', () => {
    for (const field of ['start_time', 'end_time', 'key_concepts', 'formulas', 'definitions']) {
      expect(GUIDE_SYSTEM_PROMPT).toContain(field);
    }
  });
});

describe('the settings the UI offers reach the prompt', () => {
  test('flashcard count and language', () => {
    const out = buildFlashcardsPrompt(guide, { count: 25, language: 'German' });
    expect(out).toContain('25');
    expect(out).toContain('German');
  });

  test('quiz count, type and language', () => {
    expect(buildQuizPrompt(guide, { count: 7 })).toContain('7');
    expect(buildQuizPrompt(guide, { type: 'mc' })).toMatch(/multiple-choice/i);
    expect(buildQuizPrompt(guide, { type: 'sa' })).toMatch(/short-answer/i);
    expect(buildQuizPrompt(guide, { language: 'French' })).toContain('French');
  });

  test('an unknown quiz type falls back rather than producing an empty instruction', () => {
    expect(buildQuizPrompt(guide, { type: 'nonsense' })).toMatch(/multiple-choice/i);
  });

  test('exam scope, count and difficulty', () => {
    const out = buildExamQuestionsPrompt(guide, ['Variance'], { count: 3, difficulty: 'hard' });
    expect(out).toContain('Variance');
    expect(out).toContain('3');
  });

  test('no language named means the guide language is kept', () => {
    expect(buildQuizPrompt(guide, {})).toMatch(/language of the guide/i);
  });
});

describe('normalizeFlashcardTypeSelection', () => {
  test('nothing chosen means auto', () => {
    expect(normalizeFlashcardTypeSelection(null)).toEqual(['auto']);
    expect(normalizeFlashcardTypeSelection([])).toEqual(['auto']);
    expect(normalizeFlashcardTypeSelection('not an array')).toEqual(['auto']);
  });

  test('auto alongside other types wins, since it means "you decide"', () => {
    expect(normalizeFlashcardTypeSelection(['auto', 'recall'])).toEqual(['auto']);
  });

  test('keeps a real selection', () => {
    expect(normalizeFlashcardTypeSelection(['recall', 'definition']))
      .toEqual(expect.arrayContaining(['recall', 'definition']));
  });

  test('drops types that do not exist', () => {
    expect(normalizeFlashcardTypeSelection(['recall', 'invented-type'])).not.toContain('invented-type');
  });
});
