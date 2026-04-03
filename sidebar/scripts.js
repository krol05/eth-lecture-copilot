/**
 * scripts.js -- PDF Script Manager for ETH Lecture Copilot
 *
 * Handles: PDF text extraction (via pdf.js), paragraph-aware chunking,
 * fuzzy retrieval (Dice bigram similarity + substring matching),
 * and IndexedDB persistence keyed by course ID.
 *
 * Loaded as a regular <script> before sidebar.js.
 * Exposes window.ScriptManager.
 */

(function () {
  'use strict';

  const DB_NAME = 'eth-copilot-scripts';
  const DB_VERSION = 1;
  const STORE = 'scripts';
  const CHUNK_TARGET = 600;   // target tokens per chunk
  const CHUNK_OVERLAP = 80;   // overlap tokens between chunks

  // ─── IndexedDB helpers ───────────────────────────────────────────────────

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'courseId' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function dbGet(courseId) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(courseId);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async function dbPut(record) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function dbDelete(courseId) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(courseId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // ─── Course ID extraction ────────────────────────────────────────────────

  function extractCourseId(url) {
    if (!url) return null;
    const m = url.match(/(\d{3}-\d{4}-\d{2}[A-Z])/);
    if (m) return m[1];
    const segments = new URL(url).pathname.split('/').filter(Boolean);
    const semIdx = segments.findIndex(s => /^(spring|autumn|fall|summer|winter|fr(ü|ue)hling|herbst)$/i.test(s));
    if (semIdx >= 0 && segments[semIdx + 1]) return segments[semIdx + 1];
    const noYear = new URL(url).pathname.replace(/\/20\d{2}\//, '/');
    return 'course_' + simpleHash(noYear);
  }

  function simpleHash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    }
    return Math.abs(h).toString(36);
  }

  // ─── PDF text extraction ─────────────────────────────────────────────────

  let pdfjsLoaded = false;

  async function ensurePdfJs() {
    if (pdfjsLoaded && window.pdfjsLib) return;
    const mod = await import('../lib/pdfjs/pdf.min.mjs');
    window.pdfjsLib = mod;
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = '../lib/pdfjs/pdf.worker.min.mjs';
    pdfjsLoaded = true;
  }

  async function extractTextFromPdf(arrayBuffer, onProgress) {
    await ensurePdfJs();
    const pdf = await window.pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const totalPages = pdf.numPages;
    const pages = [];

    for (let i = 1; i <= totalPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const text = content.items.map(it => it.str).join(' ');
      pages.push({ pageNum: i, text: text.trim() });
      if (onProgress) onProgress(i, totalPages);
    }

    return { pages, totalPages };
  }

  // ─── Chunking ────────────────────────────────────────────────────────────

  function roughTokenCount(text) {
    return Math.ceil(text.split(/\s+/).length * 1.3);
  }

  function chunkPages(pages) {
    const paragraphs = [];
    for (const p of pages) {
      if (!p.text) continue;
      const parts = p.text.split(/\n{2,}|\r\n{2,}/);
      for (const part of parts) {
        const trimmed = part.trim();
        if (trimmed.length > 10) {
          paragraphs.push({ text: trimmed, pageNum: p.pageNum });
        }
      }
      if (parts.length <= 1 && p.text.trim().length > 10) {
        const tokens = roughTokenCount(p.text);
        if (tokens > CHUNK_TARGET * 2) {
          const sentences = p.text.match(/[^.!?]+[.!?]+/g) || [p.text];
          let buf = '';
          for (const s of sentences) {
            if (roughTokenCount(buf + s) > CHUNK_TARGET && buf.length > 50) {
              paragraphs.push({ text: buf.trim(), pageNum: p.pageNum });
              const words = buf.split(/\s+/);
              buf = words.slice(-Math.min(CHUNK_OVERLAP, words.length)).join(' ') + ' ' + s;
            } else {
              buf += (buf ? ' ' : '') + s;
            }
          }
          if (buf.trim().length > 10) paragraphs.push({ text: buf.trim(), pageNum: p.pageNum });
        }
      }
    }

    const chunks = [];
    let buffer = { text: '', pageNum: 0 };

    for (const para of paragraphs) {
      const combined = buffer.text ? buffer.text + '\n\n' + para.text : para.text;
      if (roughTokenCount(combined) <= CHUNK_TARGET) {
        buffer = { text: combined, pageNum: buffer.pageNum || para.pageNum };
      } else {
        if (buffer.text) {
          chunks.push({ text: buffer.text, pageNum: buffer.pageNum });
        }
        buffer = { text: para.text, pageNum: para.pageNum };
      }
    }
    if (buffer.text) {
      chunks.push({ text: buffer.text, pageNum: buffer.pageNum });
    }

    return chunks;
  }

  // ─── Fuzzy Retrieval (Dice bigram similarity) ─────────────────────────────

  const STOP_WORDS = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'shall', 'can', 'this', 'that', 'these',
    'those', 'it', 'its', 'i', 'we', 'you', 'he', 'she', 'they', 'them',
    'my', 'your', 'his', 'her', 'our', 'their', 'not', 'no', 'from', 'as',
    'if', 'so', 'than', 'also', 'very', 'just', 'about', 'which', 'what',
    'when', 'where', 'how', 'who', 'all', 'each', 'more', 'some', 'such',
    'into', 'then', 'there', 'here', 'only', 'over', 'after', 'before',
    'between', 'under', 'above', 'up', 'down', 'out', 'off', 'through',
    'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einer',
    'und', 'oder', 'aber', 'ist', 'sind', 'war', 'hat', 'haben', 'wird',
    'mit', 'von', 'auf', 'fur', 'fuer', 'bei', 'nach', 'aus', 'zum', 'zur',
    'nicht', 'auch', 'noch', 'nur', 'wie', 'dass', 'wenn', 'weil', 'es'
  ]);

  function extractTerms(text) {
    return text.toLowerCase().split(/\W+/).filter(t => t.length > 2 && !STOP_WORDS.has(t));
  }

  /** Character-level bigrams for a string. */
  function bigrams(str) {
    const s = str.toLowerCase().replace(/\s+/g, ' ').trim();
    const bg = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const pair = s.slice(i, i + 2);
      bg.set(pair, (bg.get(pair) || 0) + 1);
    }
    return bg;
  }

  /** Sorensen-Dice coefficient between two strings (0..1). */
  function diceCoefficient(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    const bgA = bigrams(a);
    const bgB = bigrams(b);
    let intersection = 0;
    let totalA = 0;
    let totalB = 0;
    for (const [pair, count] of bgA) {
      totalA += count;
      if (bgB.has(pair)) intersection += Math.min(count, bgB.get(pair));
    }
    for (const count of bgB.values()) totalB += count;
    if (totalA + totalB === 0) return 0;
    return (2 * intersection) / (totalA + totalB);
  }

  /**
   * Score a chunk against a query using combined approach:
   * 1. Dice similarity on the full text (semantic shape)
   * 2. Term-level substring containment (exact-ish hits)
   * 3. Multi-term proximity bonus
   */
  function scoreChunk(queryTerms, queryRaw, chunkText) {
    const chunkLower = chunkText.toLowerCase();

    // Dice similarity between query and chunk (weighted at 40%)
    const dice = diceCoefficient(queryRaw.toLowerCase(), chunkLower);

    // Term containment: how many query terms appear as substrings in the chunk
    let termHits = 0;
    const hitPositions = [];
    for (const term of queryTerms) {
      const idx = chunkLower.indexOf(term);
      if (idx >= 0) {
        termHits++;
        hitPositions.push(idx);
      }
    }
    const termRatio = queryTerms.length > 0 ? termHits / queryTerms.length : 0;

    // Proximity bonus: if multiple terms appear close together
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

  /**
   * Retrieve top-K chunks with guaranteed minimum results.
   * Falls back to evenly-spaced document chunks if scores are too low.
   */
  function retrieveChunks(query, chunks, topK) {
    if (!chunks.length) return [];
    const queryTerms = extractTerms(query);
    const scored = chunks.map((c, i) => ({
      index: i,
      score: scoreChunk(queryTerms, query, c.text),
      text: c.text,
      pageNum: c.pageNum,
      fileIndex: c.fileIndex
    }));
    scored.sort((a, b) => b.score - a.score);

    const results = scored.slice(0, topK);

    // If best score is very low, supplement with evenly-spaced chunks for coverage
    const bestScore = results[0]?.score || 0;
    if (bestScore < 0.05 && chunks.length > topK) {
      const step = Math.max(1, Math.floor(chunks.length / topK));
      const seen = new Set(results.map(r => r.index));
      for (let i = 0; i < chunks.length && results.length < topK; i += step) {
        if (!seen.has(i)) {
          results.push({
            index: i,
            score: 0.001,
            text: chunks[i].text,
            pageNum: chunks[i].pageNum,
            fileIndex: chunks[i].fileIndex
          });
          seen.add(i);
        }
      }
      results.length = Math.min(results.length, topK);
    }

    return results;
  }

  // ─── Strictness configuration ────────────────────────────────────────────

  const STRICTNESS_PROFILES = {
    low: {
      topK: 4,
      promptPrefix: 'The following are a few loosely related excerpts from the course script. Use them as supplementary reference only -- prioritize the lecture transcript and your general knowledge.'
    },
    medium: {
      topK: 8,
      promptPrefix: 'The following are relevant excerpts from the course script. Integrate this material with the lecture content to provide well-rounded answers. Cite page numbers when referencing specific script content.'
    },
    high: {
      topK: 14,
      promptPrefix: 'The following are highly relevant excerpts from the course script. Treat the script as a primary authoritative source. Ground your answers in the script content wherever possible and cite page numbers.'
    },
    strict: {
      topK: 20,
      promptPrefix: 'The following are extensive excerpts from the course script. You MUST base your answer primarily on the script content below. Only add information from the lecture transcript if the script does not cover the topic. Always cite page numbers.'
    }
  };

  // ─── Public API ──────────────────────────────────────────────────────────

  window.ScriptManager = {

    extractCourseId,

    async load(courseId) {
      return dbGet(courseId);
    },

    async addPdf(courseId, file, onProgress) {
      const arrayBuffer = await file.arrayBuffer();
      const { pages, totalPages } = await extractTextFromPdf(arrayBuffer, onProgress);
      const chunks = chunkPages(pages);

      const existing = await dbGet(courseId) || {
        courseId,
        files: [],
        chunks: []
      };

      const fileIndex = existing.files.length;
      existing.files.push({
        name: file.name,
        uploadDate: new Date().toISOString(),
        pageCount: totalPages,
        chunkCount: chunks.length,
        size: file.size
      });

      const taggedChunks = chunks.map(c => ({ ...c, fileIndex }));
      existing.chunks = existing.chunks.concat(taggedChunks);

      await dbPut(existing);
      return existing;
    },

    async removeFile(courseId, fileIndex) {
      const record = await dbGet(courseId);
      if (!record) return null;

      record.files.splice(fileIndex, 1);
      record.chunks = record.chunks.filter(c => c.fileIndex !== fileIndex);
      record.chunks = record.chunks.map(c => ({
        ...c,
        fileIndex: c.fileIndex > fileIndex ? c.fileIndex - 1 : c.fileIndex
      }));

      if (record.files.length === 0) {
        await dbDelete(courseId);
        return null;
      }

      await dbPut(record);
      return record;
    },

    async removeAll(courseId) {
      await dbDelete(courseId);
    },

    retrieve(query, record, strictness) {
      if (!record?.chunks?.length) return { promptPrefix: '', chunks: [] };
      const profile = STRICTNESS_PROFILES[strictness] || STRICTNESS_PROFILES.medium;
      const results = retrieveChunks(query, record.chunks, profile.topK);
      return {
        promptPrefix: profile.promptPrefix,
        chunks: results
      };
    },

    buildScriptContext(query, record, strictness) {
      const { promptPrefix, chunks } = this.retrieve(query, record, strictness);
      if (!chunks.length) return '';

      let ctx = `\n\n--- COURSE SCRIPT EXCERPTS ---\n${promptPrefix}\n\n`;
      for (const c of chunks) {
        const fileName = record.files[c.fileIndex]?.name || 'unknown';
        ctx += `[${fileName}, p.${c.pageNum}] (relevance: ${c.score.toFixed(3)})\n${c.text}\n\n`;
      }
      ctx += '--- END SCRIPT EXCERPTS ---\n';
      return ctx;
    },

    formatSize(bytes) {
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    },

    STRICTNESS_PROFILES
  };
})();
