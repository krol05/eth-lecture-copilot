/**
 * Reciprocal Rank Fusion — combines the fuzzy and semantic rankings.
 *
 * The two methods are good at different things. Fuzzy matches the literal
 * words, so it finds a theorem name or a symbol exactly as written but misses
 * a paraphrase. Semantic matches meaning, so it finds the paraphrase but can
 * drift away from the exact term that was typed.
 *
 * Their scores are not comparable — a Dice coefficient and a cosine similarity
 * live on different scales — so this fuses positions rather than scores:
 *
 *     score(chunk) = Σ  1 / (K + rank in that list)
 *
 * A chunk near the top of both lists beats one that only one method liked,
 * and no calibration between the two is needed. K = 60 is the constant from
 * the original RRF paper; it keeps the top few ranks from dominating.
 *
 * Shared by the sidebar (script tag) and Jest (require).
 */
(function (root) {
  'use strict';

  const DEFAULT_K = 60;

  /**
   * Fuse any number of ranked lists into one.
   *
   * @param {Array<Array<{index:number}>>} rankings  lists, each best-first
   * @param {object}  [options]
   * @param {number}  [options.k=60]      rank-smoothing constant
   * @param {number}  [options.topK]      how many results to return
   * @param {number[]} [options.weights]  per-list multiplier, defaults to all 1
   * @returns {Array<object>} fused results, best first, each carrying a
   *   `fusionScore` and the `ranks` it held in each input list (null = absent)
   */
  function fuseRankings(rankings, { k = DEFAULT_K, topK, weights } = {}) {
    const lists = (rankings || []).filter(list => Array.isArray(list) && list.length);
    if (!lists.length) return [];

    const byIndex = new Map();

    lists.forEach((list, listNo) => {
      const weight = weights?.[listNo] ?? 1;
      list.forEach((item, position) => {
        if (!item || typeof item.index !== 'number') return;
        let entry = byIndex.get(item.index);
        if (!entry) {
          // Keep the first list's copy of the chunk: same text either way,
          // and it means the caller still gets text/pageNum/fileIndex.
          entry = { ...item, fusionScore: 0, ranks: new Array(rankings.length).fill(null) };
          byIndex.set(item.index, entry);
        }
        // Ranks are 1-based: the top result contributes 1/(k+1).
        const rank = position + 1;
        entry.fusionScore += weight / (k + rank);
        if (entry.ranks[listNo] == null) entry.ranks[listNo] = rank;
      });
    });

    const fused = [...byIndex.values()].sort((a, b) => {
      if (b.fusionScore !== a.fusionScore) return b.fusionScore - a.fusionScore;
      // Stable, explainable tie-break: earlier chunk in the document wins.
      return a.index - b.index;
    });

    return typeof topK === 'number' ? fused.slice(0, topK) : fused;
  }

  const api = { fuseRankings, DEFAULT_K };

  if (typeof root !== 'undefined') {
    root.RetrievalFusion = api;
    root.fuseRankings = fuseRankings;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof self !== 'undefined' ? self : globalThis);
