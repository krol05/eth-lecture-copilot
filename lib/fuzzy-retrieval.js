/**
 * Fuzzy script chunk retrieval (Dice + term overlap). Loaded by sidebar before scripts.js.
 * Single source for tests and runtime.
 */
(function (root) {
  'use strict';

  const STOP_WORDS = new Set([
    'the','a','an','and','or','but','in','on','at','to','for','of','with','by',
    'is','are','was','were','be','been','being','have','has','had','do','does',
    'did','will','would','could','should','may','might','shall','can','this',
    'that','these','those','it','its','i','we','you','he','she','they','them',
    'my','your','his','her','our','their','not','no','from','as','if','so',
    'than','also','very','just','about','which','what','when','where','how',
    'who','all','each','more','some','such','into','then','there','here','only',
    'over','after','before','between','under','above','up','down','out','off',
    'through',
    'der','die','das','den','dem','des','ein','eine','einer','und','oder','aber',
    'ist','sind','war','hat','haben','wird','mit','von','auf','fur','fuer','bei',
    'nach','aus','zum','zur','nicht','auch','noch','nur','wie','dass','wenn',
    'weil','es'
  ]);

  function extractTerms(text) {
    return text.toLowerCase().split(/\W+/).filter(t => t.length > 2 && !STOP_WORDS.has(t));
  }

  function bigrams(str) {
    const s = str.toLowerCase().replace(/\s+/g, ' ').trim();
    const bg = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const pair = s.slice(i, i + 2);
      bg.set(pair, (bg.get(pair) || 0) + 1);
    }
    return bg;
  }

  function diceCoefficient(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    const bgA = bigrams(a), bgB = bigrams(b);
    let intersection = 0, totalA = 0, totalB = 0;
    for (const [pair, count] of bgA) {
      totalA += count;
      if (bgB.has(pair)) intersection += Math.min(count, bgB.get(pair));
    }
    for (const count of bgB.values()) totalB += count;
    return (totalA + totalB === 0) ? 0 : (2 * intersection) / (totalA + totalB);
  }

  function scoreChunkFuzzy(queryTerms, queryRaw, chunkText) {
    const chunkLower = chunkText.toLowerCase();
    const dice = diceCoefficient(queryRaw.toLowerCase(), chunkLower);
    let termHits = 0;
    const hitPositions = [];
    for (const term of queryTerms) {
      const idx = chunkLower.indexOf(term);
      if (idx >= 0) { termHits++; hitPositions.push(idx); }
    }
    const termRatio = queryTerms.length > 0 ? termHits / queryTerms.length : 0;
    let proximityBonus = 0;
    if (hitPositions.length >= 2) {
      hitPositions.sort((a, b) => a - b);
      let closeCount = 0;
      for (let i = 1; i < hitPositions.length; i++) {
        if (hitPositions[i] - hitPositions[i - 1] < 300) closeCount++;
      }
      proximityBonus = closeCount / (hitPositions.length - 1);
    }
    return dice * 0.4 + termRatio * 0.45 + proximityBonus * 0.15;
  }

  function retrieveChunksFuzzy(query, chunks, topK) {
    if (!chunks.length) return [];
    const queryTerms = extractTerms(query);
    const scored = chunks.map((c, i) => ({
      index: i,
      score: scoreChunkFuzzy(queryTerms, query, c.text),
      text: c.text, pageNum: c.pageNum, fileIndex: c.fileIndex
    }));
    scored.sort((a, b) => b.score - a.score);
    const results = scored.slice(0, topK);
    if ((results[0]?.score || 0) < 0.05 && chunks.length > topK) {
      const step = Math.max(1, Math.floor(chunks.length / topK));
      const seen = new Set(results.map(r => r.index));
      for (let i = 0; i < chunks.length && results.length < topK; i += step) {
        if (!seen.has(i)) {
          results.push({ index: i, score: 0.001, text: chunks[i].text,
            pageNum: chunks[i].pageNum, fileIndex: chunks[i].fileIndex });
          seen.add(i);
        }
      }
      results.length = Math.min(results.length, topK);
    }
    return results;
  }

  const api = {
    extractTerms,
    bigrams,
    diceCoefficient,
    scoreChunkFuzzy,
    retrieveChunksFuzzy
  };

  if (typeof root !== 'undefined') {
    root.FuzzyRetrieval = api;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof self !== 'undefined' ? self : globalThis);
