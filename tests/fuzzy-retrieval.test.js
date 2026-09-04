'use strict';

const {
  diceCoefficient,
  retrieveChunksFuzzy,
  extractTerms
} = require('../lib/fuzzy-retrieval.js');

describe('diceCoefficient', () => {
  test('identical strings score 1', () => {
    expect(diceCoefficient('hello', 'hello')).toBe(1);
  });

  test('empty yields 0', () => {
    expect(diceCoefficient('', 'a')).toBe(0);
  });
});

describe('extractTerms', () => {
  test('drops stop words and short tokens', () => {
    const t = extractTerms('The quick brown fox jumps');
    expect(t).toContain('quick');
    expect(t).toContain('brown');
    expect(t).not.toContain('the');
  });
});

describe('retrieveChunksFuzzy', () => {
  const chunks = [
    { text: 'variance of independent random variables', pageNum: 1, fileIndex: 0 },
    { text: 'unrelated topic about sorting algorithms', pageNum: 2, fileIndex: 0 },
    { text: 'more variance and expectation rules', pageNum: 3, fileIndex: 0 },
    { text: 'the central limit theorem and its proof', pageNum: 4, fileIndex: 1 }
  ];

  /** Page numbers of the results, best first — the thing worth asserting. */
  const pagesFor = (query, topK = 4) =>
    retrieveChunksFuzzy(query, chunks, topK).map(r => r.pageNum);

  test('puts the best match first, not merely somewhere in the results', () => {
    // The old assertion only checked that the top hit contained the word the
    // query already contained, which passed even on a wrong ordering.
    expect(pagesFor('variance random variables')[0]).toBe(1);
    expect(pagesFor('sorting algorithms')[0]).toBe(2);
    expect(pagesFor('central limit theorem')[0]).toBe(4);
  });

  test('orders the whole list by relevance, not just the winner', () => {
    const ranked = pagesFor('variance');
    // Both variance chunks must beat the two that never mention it.
    expect(ranked.slice(0, 2).sort()).toEqual([1, 3]);
  });

  test('respects topK', () => {
    expect(retrieveChunksFuzzy('variance', chunks, 2)).toHaveLength(2);
    expect(retrieveChunksFuzzy('variance', chunks, 1)).toHaveLength(1);
  });

  test('carries the page and file a chunk came from', () => {
    const [top] = retrieveChunksFuzzy('central limit theorem', chunks, 1);
    expect(top).toMatchObject({ pageNum: 4, fileIndex: 1, index: 3 });
    expect(typeof top.score).toBe('number');
  });

  test('scores are ordered, so fusion can rely on the ranking', () => {
    const results = retrieveChunksFuzzy('variance expectation', chunks, 4);
    const scores = results.map(r => r.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  test('a query matching nothing still returns a spread to work with', () => {
    // Better a weak sample of the script than an empty context block.
    const results = retrieveChunksFuzzy('zzzz qqqq', chunks, 3);
    expect(results).toHaveLength(3);
    expect(new Set(results.map(r => r.index)).size).toBe(3);
  });

  test('returns empty for empty chunks', () => {
    expect(retrieveChunksFuzzy('x', [], 5)).toEqual([]);
  });
});
