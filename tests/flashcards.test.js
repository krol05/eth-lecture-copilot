'use strict';

const {
  buildFlashcardsPrompt,
  normalizeFlashcardTypeSelection
} = require('../lib/prompts.js');

const {
  normalizeFlashcard,
  normalizeFlashcardsResponse,
  buildFlashcardBackWithMetadata,
  buildFlashcardBackHtmlWithMetadata,
  buildFlashcardAnkiTags,
  formatCardType,
  formatTimeRange,
  markdownishToHtml,
  convertDollarMathToAnki
} = require('../lib/flashcards.js');

const guide = {
  lecture_title: 'Graph Algorithms',
  guide: [
    {
      start_time: 0,
      end_time: 120,
      title: 'Breadth-First Search',
      key_concepts: ['BFS uses a queue and explores level by level.'],
      formulas: [],
      definitions: []
    }
  ]
};

describe('buildFlashcardsPrompt', () => {
  // These assert which prompt BRANCH is taken, not the prompt's prose —
  // prompt wording is free to change without breaking tests.
  test('auto selection takes the auto branch, not the explicit-types branch', () => {
    const prompt = buildFlashcardsPrompt(guide, { cardTypes: ['auto'] });
    expect(prompt).toContain('Auto mode is active');
    expect(prompt).not.toContain('Use ONLY these selected card types');
  });

  test('explicit card types take the constrained branch and are listed', () => {
    const prompt = buildFlashcardsPrompt(guide, {
      cardTypes: ['application', 'comparison', 'misconception'],
      includeFormulas: false
    });
    expect(prompt).toContain('Use ONLY these selected card types');
    expect(prompt).toContain('application');
    expect(prompt).toContain('comparison');
    expect(prompt).toContain('misconception');
    expect(prompt).toContain('Do not create standalone formula cards');
  });

  test('legacy style option maps to selected type for compatibility', () => {
    const prompt = buildFlashcardsPrompt(guide, { style: 'definition' });
    expect(prompt).toContain('Use ONLY these selected card types');
    expect(prompt).toContain('definition');
  });

  test('response schema in the prompt does not include a deckTitle field', () => {
    const prompt = buildFlashcardsPrompt(guide, { cardTypes: ['auto'] });
    expect(prompt).not.toContain('"deckTitle"');
  });
});

describe('normalizeFlashcardTypeSelection', () => {
  test('falls back to auto when empty or auto is present', () => {
    expect(normalizeFlashcardTypeSelection([])).toEqual(['auto']);
    expect(normalizeFlashcardTypeSelection(['auto', 'recall'])).toEqual(['auto']);
  });

  test('keeps supported selected types only', () => {
    expect(normalizeFlashcardTypeSelection(['recall', 'nope', 'application'])).toEqual(['recall', 'application']);
  });
});

describe('flashcard normalization and export helpers', () => {
  test('old front/back cards still normalize', () => {
    expect(normalizeFlashcard({ front: 'Q', back: 'A' })).toEqual({ front: 'Q', back: 'A' });
  });

  test('new metadata fields are preserved and cleaned', () => {
    const card = normalizeFlashcard({
      front: 'Q',
      back: 'A',
      card_type: 'application',
      source_block_title: ' BFS ',
      source_time_range: '00:00-00:30',
      tags: ['BFS', 'complexity', 'bad tag!'],
      reference: 'Block 1',
      study_note: 'Common queue invariant.'
    });
    expect(card).toMatchObject({
      front: 'Q',
      back: 'A',
      card_type: 'application',
      source_block_title: 'BFS',
      source_time_range: '00:00-00:30',
      tags: ['bfs', 'complexity', 'bad-tag'],
      reference: 'Block 1',
      study_note: 'Common queue invariant.'
    });
  });

  test('invalid optional metadata does not break normalization', () => {
    const cards = normalizeFlashcardsResponse({
      flashcards: [
        { front: 'Q', back: 'A', card_type: 'bad', tags: 'not-array' },
        null,
        { nope: true }
      ]
    });
    expect(cards).toEqual([{ front: 'Q', back: 'A' }]);
  });

  test('metadata appends to Anki/TSV back text', () => {
    const text = buildFlashcardBackWithMetadata({
      back: 'A',
      card_type: 'definition',
      source_block_title: 'Locks',
      tags: ['deadlocks']
    });
    expect(text).toContain('A');
    expect(text).toContain('Type: Definition');
    expect(text).toContain('Block: Locks');
    expect(text).toContain('Tags: deadlocks');
  });

  test('metadata display uses nice labels and clock time ranges', () => {
    expect(formatCardType('formula_rule')).toBe('Formula Rule');
    expect(formatTimeRange('0-313')).toBe('0:00 – 5:13');
  });

  test('Anki HTML back is formatted instead of plain metadata text', () => {
    const html = buildFlashcardBackHtmlWithMetadata({
      back: 'For an $N$-way cache: $$N!$$',
      card_type: 'formula_rule',
      source_time_range: '0-313',
      study_note: 'Longer note'
    });
    expect(html).toContain('\\(N\\)');
    expect(html).toContain('\\[N!\\]');
    expect(html).toContain('Formula Rule');
    expect(html).toContain('0:00 – 5:13');
    expect(html).toContain('<div class="lc-card">');
    expect(html).toContain('<hr class="lc-meta-rule">');
    expect(html).not.toContain('<hr>');
    expect(html).toContain('<details class="lc-study-note">');
  });

  test('front markdown conversion supports bold text for Anki HTML fields', () => {
    expect(markdownishToHtml('What is **locality**?')).toBe('What is <strong>locality</strong>?');
  });

  test('Anki math conversion uses MathJax delimiters instead of raw dollar delimiters', () => {
    expect(convertDollarMathToAnki('For $N$ ways: $$N!$$')).toBe('For \\(N\\) ways: \\[N!\\]');
  });

  test('Anki tags include base tags, card type, and generated tags', () => {
    expect(buildFlashcardAnkiTags(
      { card_type: 'recall', tags: ['Lecture 1', 'key idea'] },
      ['lecture-copilot', 'systems course']
    )).toEqual(['lecture-copilot', 'systems-course', 'recall', 'lecture-1', 'key-idea']);
  });
});
