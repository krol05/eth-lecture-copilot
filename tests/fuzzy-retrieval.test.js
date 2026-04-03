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
    { text: 'more variance and expectation rules', pageNum: 3, fileIndex: 0 }
  ];

  test('ranks chunks matching query higher', () => {
    const q = 'variance random variables';
    const top = retrieveChunksFuzzy(q, chunks, 2);
    expect(top.length).toBeLessThanOrEqual(2);
    expect(top[0].text).toContain('variance');
  });

  test('returns empty for empty chunks', () => {
    expect(retrieveChunksFuzzy('x', [], 5)).toEqual([]);
  });
});
