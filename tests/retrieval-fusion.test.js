'use strict';

const { fuseRankings, DEFAULT_K } = require('../lib/retrieval-fusion.js');

/** Build a ranked list of chunk indices, best first. */
const rank = (...indices) => indices.map(i => ({ index: i, text: `chunk ${i}` }));

describe('fuseRankings', () => {
  test('a chunk both methods like beats one only a single method liked', () => {
    const fuzzy    = rank(1, 2, 3);
    const semantic = rank(3, 1, 9);
    const fused = fuseRankings([fuzzy, semantic]);

    // 1 is 1st and 2nd; 3 is 3rd and 1st — agreement near the top wins.
    expect(fused.map(r => r.index)).toEqual([1, 3, 2, 9]);
  });

  test('reports where each chunk placed in each list', () => {
    const fused = fuseRankings([rank(1, 2), rank(2)]);
    const two = fused.find(r => r.index === 2);
    const one = fused.find(r => r.index === 1);
    expect(two.ranks).toEqual([2, 1]);
    expect(one.ranks).toEqual([1, null]);   // absent from the second list
  });

  test('uses the documented 1/(k+rank) formula', () => {
    const [top] = fuseRankings([rank(7)]);
    expect(top.fusionScore).toBeCloseTo(1 / (DEFAULT_K + 1), 10);
  });

  test('keeps the chunk payload, so callers still get text and page', () => {
    const withPage = [{ index: 4, text: 'Bayes rule', pageNum: 12, fileIndex: 0 }];
    const [top] = fuseRankings([withPage, rank(4)]);
    expect(top.text).toBe('Bayes rule');
    expect(top.pageNum).toBe(12);
    expect(top.fileIndex).toBe(0);
  });

  test('one list in, the same order out', () => {
    // The fallback when there are no embeddings must not reshuffle anything.
    expect(fuseRankings([rank(5, 3, 8)]).map(r => r.index)).toEqual([5, 3, 8]);
  });

  test('empty and missing lists are ignored, not counted as a ranking', () => {
    expect(fuseRankings([rank(1, 2), []]).map(r => r.index)).toEqual([1, 2]);
    expect(fuseRankings([[], []])).toEqual([]);
    expect(fuseRankings([])).toEqual([]);
    expect(fuseRankings(null)).toEqual([]);
  });

  test('topK trims after fusing, not before', () => {
    // 9 only appears in the second list but ahead of 2 in it; trimming the
    // inputs first would have dropped it before it could compete.
    const fused = fuseRankings([rank(1, 2), rank(9, 1)], { topK: 2 });
    expect(fused.map(r => r.index)).toEqual([1, 9]);
  });

  test('weights let one method count for more', () => {
    const fuzzy    = rank(1, 2);
    const semantic = rank(2, 1);
    // Perfectly mirrored, so weighting decides it.
    expect(fuseRankings([fuzzy, semantic], { weights: [3, 1] })[0].index).toBe(1);
    expect(fuseRankings([fuzzy, semantic], { weights: [1, 3] })[0].index).toBe(2);
  });

  test('ties break on document order rather than at random', () => {
    const fused = fuseRankings([rank(8, 2)], { });
    expect(fused[0].index).toBe(8);
    const mirrored = fuseRankings([rank(2), rank(8)]);
    expect(mirrored.map(r => r.index)).toEqual([2, 8]);
  });

  test('a repeated chunk in one list does not get counted twice', () => {
    const fused = fuseRankings([rank(1, 1, 1)]);
    expect(fused).toHaveLength(1);
    expect(fused[0].ranks).toEqual([1]);
  });
});
