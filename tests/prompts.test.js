'use strict';

const {
  buildGuidePrompt,
  buildStudyFlowGuidePrompt,
  promptExtrasBlock,
  appendPromptExtras,
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

  test('the guide prompt asks for the fields the parser expects', () => {
    // buildGuidePrompt is the prompt the extension actually sends. There used
    // to be a second, unused GUIDE_SYSTEM_PROMPT constant here, and this test
    // asserted against that one — so the real prompt was never checked at all.
    const prompt = buildGuidePrompt('very_high', 'high', '');
    for (const field of ['start_time', 'end_time', 'key_concepts', 'formulas', 'definitions', 'guide_title']) {
      expect(prompt).toContain(field);
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

describe('the guide prompt the extension actually sends', () => {
  const DETAILS = ['low', 'medium', 'high', 'very_high'];
  const COUNTS = ['low', 'medium', 'high', 'very_high'];

  test.each(DETAILS)('detail %s reaches the prompt', (detail) => {
    const { GUIDE_DETAIL_PROFILES } = require('../lib/prompts.js');
    const prompt = buildGuidePrompt(detail, 'medium', '');
    expect(prompt).toContain(`BLOCK DETAIL (${GUIDE_DETAIL_PROFILES[detail].label})`);
    expect(prompt).toContain(GUIDE_DETAIL_PROFILES[detail].concepts);
  });

  test.each(COUNTS)('block count %s reaches the prompt with its target range', (count) => {
    const { GUIDE_COUNT_PROFILES } = require('../lib/prompts.js');
    const profile = GUIDE_COUNT_PROFILES[count];
    const prompt = buildGuidePrompt('high', count, '');
    expect(prompt).toContain(`target ${profile.range} blocks`);
    expect(prompt).toContain(profile.rule);
  });

  test('an unknown detail or count falls back instead of printing undefined', () => {
    // The selects are read straight from the DOM, so a stale saved value or a
    // renamed option must not produce "BLOCK DETAIL (undefined)".
    const prompt = buildGuidePrompt('nonsense', 'custom', '');
    expect(prompt).not.toMatch(/undefined/);
    expect(prompt).toContain('BLOCK DETAIL (Very High)');
  });

  test('a named language is demanded; no language asks the model to detect one', () => {
    expect(buildGuidePrompt('high', 'high', 'Polish')).toContain('Write ALL text content');
    expect(buildGuidePrompt('high', 'high', 'Polish')).toContain('Polish');
    expect(buildGuidePrompt('high', 'high', '')).toMatch(/Detect the dominant natural language/);
  });

  test('every key_concepts example is in the object form the schema demands', () => {
    // The prompt rules say key_concepts must be {label, lead, body} objects and
    // end with "Never output key_concepts as strings" — while both worked
    // examples showed bare strings. A model shown a contradiction follows the
    // example, and the renderer then had to guess at the label.
    for (const prompt of [buildGuidePrompt('very_high', 'high', ''),
      buildStudyFlowGuidePrompt('very_high', 'high', '')]) {
      expect(prompt).toContain('"key_concepts":[{"label"');
      expect(prompt).not.toMatch(/"key_concepts":\["/);
    }
  });

  test('the worked example parses and matches the schema it teaches', () => {
    // The example is the strongest instruction in the prompt. If it does not
    // survive JSON.parse, or drifts from the declared shape, it teaches the
    // model to emit something the guide parser will reject.
    const prompt = buildGuidePrompt('very_high', 'high', '');
    const line = prompt.split('\n').find(l => l.startsWith('Output: {'));
    const parsed = JSON.parse(line.slice('Output: '.length));
    expect(parsed.guide.length).toBeGreaterThan(0);
    for (const block of parsed.guide) {
      expect(typeof block.title).toBe('string');
      expect(typeof block.start_time).toBe('number');
      for (const concept of block.key_concepts) {
        expect(Object.keys(concept).sort()).toEqual(['body', 'label', 'lead']);
        expect(concept.label.length).toBeLessThanOrEqual(24);
        expect(concept.body).not.toBe('');
      }
    }
  });

  test('study flow adds its section without dropping the base prompt', () => {
    const base = buildGuidePrompt('high', 'high', 'German');
    const flow = buildStudyFlowGuidePrompt('high', 'high', 'German');
    expect(flow).toContain('EXPERIMENTAL STUDY FLOW MODE');
    expect(flow).toContain('BLOCK DETAIL (High)');
    expect(flow).toContain('German');
    // The transcript trailer must stay last: it is what introduces the input.
    expect(flow.trimEnd().endsWith('Now process the following transcript:')).toBe(true);
    expect(flow.length).toBeGreaterThan(base.length);
  });

  test('study flow still documents key_concept_labels, which the renderer reads', () => {
    // sidebar/guide-render.js falls back to block.key_concept_labels[i], and
    // lib/schema.js sanitizes the field, so the schema line must keep it.
    expect(buildStudyFlowGuidePrompt('high', 'high', '')).toContain('"key_concept_labels":["string"]');
  });
});

describe('the student’s own instructions', () => {
  test('nothing typed changes nothing', () => {
    expect(promptExtrasBlock('')).toBe('');
    expect(promptExtrasBlock('   \n  ')).toBe('');
    expect(promptExtrasBlock(null)).toBe('');
    expect(promptExtrasBlock(undefined)).toBe('');
    expect(appendPromptExtras('base', '  ')).toBe('base');
  });

  test('the block says which side wins when it contradicts the schema', () => {
    // Without this, "answer in one line" fights "return ONLY valid JSON" and
    // the model sometimes picks the wrong one.
    const block = promptExtrasBlock('Answer in one line.');
    expect(block).toContain('Answer in one line.');
    expect(block).toMatch(/schema wins/);
  });

  test.each([
    ['guide', () => buildGuidePrompt('high', 'high', ''), 'Now process the following transcript:'],
    ['study flow', () => buildStudyFlowGuidePrompt('high', 'high', ''), 'Now process the following transcript:'],
    ['flashcards', () => buildFlashcardsPrompt(guide, {}), 'The guide JSON follows:'],
    ['quiz', () => buildQuizPrompt(guide, {}), 'The guide JSON follows:'],
    ['exam', () => buildExamQuestionsPrompt(guide, [], {}), 'The guide JSON follows:'],
    ['cross-lecture', () => buildCrossLecturePredictionPrompt([{ ...guide }], {}),
      'The lecture guides (as JSON array) follow:']
  ])('%s puts the instructions last, but still ahead of the payload trailer', (_name, build, trailer) => {
    // Position is the whole point of this helper. The instructions used to be
    // pasted at the very top, a thousand words before the rules they modify.
    const out = appendPromptExtras(build(), 'Bold every theorem name.');
    expect(out).toContain('Bold every theorem name.');
    expect(out.indexOf('Bold every theorem name.')).toBeLessThan(out.indexOf(trailer));
    expect(out.trimEnd().endsWith(trailer)).toBe(true);
  });

  test('a prompt with no known trailer still receives the instructions', () => {
    const out = appendPromptExtras('Some prompt with no payload line.', 'Be terse.');
    expect(out.startsWith('Some prompt with no payload line.')).toBe(true);
    expect(out).toContain('Be terse.');
  });

  test('only the final trailer is used when the phrase also appears earlier', () => {
    const base = 'Do not say "The guide JSON follows:" to the student.\n\nThe guide JSON follows:';
    const out = appendPromptExtras(base, 'Be terse.');
    expect(out.trimEnd().endsWith('The guide JSON follows:')).toBe(true);
    expect(out.indexOf('Be terse.')).toBeGreaterThan(out.indexOf('to the student'));
  });
});

describe('options that no longer exist', () => {
  test('the exam builders ignore a scope option instead of pretending to honour it', () => {
    // `scope` was destructured by both exam builders and referenced by neither,
    // so the UI could have offered it and changed nothing.
    const a = buildExamQuestionsPrompt(guide, [], { count: 3 });
    const b = buildExamQuestionsPrompt(guide, [], { count: 3, scope: 'cross-topic' });
    expect(a).toBe(b);
    const c = buildCrossLecturePredictionPrompt([{ ...guide }], { count: 3 });
    const d = buildCrossLecturePredictionPrompt([{ ...guide }], { count: 3, scope: 'narrow' });
    expect(c).toBe(d);
  });

  test('exam depth is a real setting and each level changes the prompt', () => {
    // Unlike scope, depth was fully written and simply never wired to the UI.
    const prompts = ['surface', 'deep', 'research'].map(depth =>
      buildExamQuestionsPrompt(guide, [], { depth, count: 3 }));
    expect(new Set(prompts).size).toBe(3);
    expect(prompts[0]).toContain('Surface depth');
    expect(prompts[1]).toContain('Deep depth');
    expect(prompts[2]).toContain('Research depth');
  });

  test('an unknown depth falls back rather than emitting an empty instruction', () => {
    expect(buildExamQuestionsPrompt(guide, [], { depth: 'nonsense' })).toMatch(/Deep depth/);
  });
});

describe('the keys the sidebar streams against match the keys the prompts ask for', () => {
  const fs = require('fs');
  const path = require('path');
  const api = fs.readFileSync(path.join(__dirname, '..', 'sidebar', 'api.js'), 'utf8');
  const shapes = api.slice(api.indexOf('const TOOL_STREAM_SHAPES'), api.indexOf('function trackToolProgress'));

  /**
   * While a study tool generates, the sidebar counts finished objects out of
   * the stream so the button can say "12 cards" instead of spinning silently.
   * It finds them by looking for one array key. If the prompt is reworded to
   * return its results under a different key, the counter simply never fires
   * and the button goes back to looking hung — with no error anywhere.
   */
  const declared = Object.fromEntries(
    [...shapes.matchAll(/(\w+_REQUEST):\s*\{\s*arrayKey:\s*'([^']+)'/g)].map(m => [m[1], m[2]])
  );

  const promptFor = {
    FLASHCARDS_REQUEST: () => buildFlashcardsPrompt(guide, {}),
    QUIZ_REQUEST: () => buildQuizPrompt(guide, {}),
    EXAM_QUESTIONS_REQUEST: () => buildExamQuestionsPrompt(guide, [], {}),
    CROSS_LECTURE_EXAM_REQUEST: () => buildCrossLecturePredictionPrompt([{ ...guide }], {})
  };

  test('every streaming tool declares a shape, and every shape has a prompt', () => {
    expect(Object.keys(declared).sort()).toEqual(Object.keys(promptFor).sort());
  });

  test.each(Object.keys(promptFor))('%s asks for the array it is scanned for', (type) => {
    const key = declared[type];
    expect(key).toBeTruthy();
    // The key has to appear as an array in the prompt's output schema.
    expect(promptFor[type]()).toMatch(new RegExp(`"${key}"\\s*:\\s*\\[`));
  });

  test('the scanner can actually count a response shaped like the prompt asks', () => {
    // End to end over the real scanner: a response following the flashcard
    // schema must produce a count, not zero.
    const { createJsonArrayScanner } = require('../lib/guide-parse.js');
    const scanner = createJsonArrayScanner(declared.FLASHCARDS_REQUEST);
    scanner.push('{"flashcards":[{"front":"a","back":"b"},{"front":"c","back":"d"}]}');
    expect(scanner.count).toBe(2);
  });
});
