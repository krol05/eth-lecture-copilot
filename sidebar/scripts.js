/**
 * scripts.js — PDF Script Manager for ETH Lecture Copilot
 *
 * Handles: PDF text extraction (via pdf.js), paragraph-aware chunking,
 * BM25 retrieval, and IndexedDB persistence keyed by course ID.
 *
 * Loaded as a regular <script> before sidebar.js.
 * Exposes window.ScriptManager.
 */

(function () {
  'use strict';

  const DB_NAME = 'eth-copilot-scripts';
  const DB_VERSION = 1;
  const STORE = 'scripts';
  const CHUNK_TARGET = 600;   // target tokens per chunk (≈ 400 words)
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
    // ETH pattern: .../252-0027-00L/... or similar course codes
    const m = url.match(/(\d{3}-\d{4}-\d{2}[A-Z])/);
    if (m) return m[1];
    // Fallback: use the path segment after the semester
    const segments = new URL(url).pathname.split('/').filter(Boolean);
    const semIdx = segments.findIndex(s => /^(spring|autumn|fall|summer|winter|frühling|herbst)$/i.test(s));
    if (semIdx >= 0 && segments[semIdx + 1]) return segments[semIdx + 1];
    // Last resort: hash the full path minus year
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
    // First, split all pages into paragraphs
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
      // If no paragraph breaks, treat the whole page as one paragraph
      if (parts.length <= 1 && p.text.trim().length > 10) {
        // Split long pages by sentences if > 2x target
        const tokens = roughTokenCount(p.text);
        if (tokens > CHUNK_TARGET * 2) {
          const sentences = p.text.match(/[^.!?]+[.!?]+/g) || [p.text];
          let buf = '';
          for (const s of sentences) {
            if (roughTokenCount(buf + s) > CHUNK_TARGET && buf.length > 50) {
              paragraphs.push({ text: buf.trim(), pageNum: p.pageNum });
              // Overlap: keep last portion
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

    // Now merge small paragraphs and split large ones into chunks
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
        // If this paragraph alone is too big, it was already split above
        buffer = { text: para.text, pageNum: para.pageNum };
      }
    }
    if (buffer.text) {
      chunks.push({ text: buffer.text, pageNum: buffer.pageNum });
    }

    return chunks;
  }

  // ─── BM25 Retrieval ──────────────────────────────────────────────────────

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
    'between', 'under', 'above', 'up', 'down', 'out', 'off', 'through'
  ]);

  function tokenize(text) {
    return text.toLowerCase().split(/\W+/).filter(t => t.length > 2 && !STOP_WORDS.has(t));
  }

  function buildIDF(chunks) {
    const N = chunks.length;
    const df = {};
    for (const chunk of chunks) {
      const seen = new Set(tokenize(chunk.text));
      for (const term of seen) {
        df[term] = (df[term] || 0) + 1;
      }
    }
    const idf = {};
    for (const [term, freq] of Object.entries(df)) {
      idf[term] = Math.log((N - freq + 0.5) / (freq + 0.5) + 1);
    }
    return idf;
  }

  function scoreBM25(query, chunkText, idf, avgLen) {
    const k1 = 1.5, b = 0.75;
    const qTerms = tokenize(query);
    const docTerms = tokenize(chunkText);
    const docLen = docTerms.length;
    const tf = {};
    for (const t of docTerms) tf[t] = (tf[t] || 0) + 1;

    let score = 0;
    for (const term of qTerms) {
      const termFreq = tf[term] || 0;
      const termIDF = idf[term] || 0;
      score += termIDF * (termFreq * (k1 + 1)) / (termFreq + k1 * (1 - b + b * docLen / avgLen));
    }
    return score;
  }

  function retrieveChunks(query, chunks, idf, topK) {
    if (!chunks.length) return [];
    const avgLen = chunks.reduce((s, c) => s + tokenize(c.text).length, 0) / chunks.length;
    const scored = chunks.map((c, i) => ({
      index: i,
      score: scoreBM25(query, c.text, idf, avgLen),
      text: c.text,
      pageNum: c.pageNum,
      fileIndex: c.fileIndex
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK).filter(s => s.score > 0);
  }

  // ─── Strictness configuration ────────────────────────────────────────────

  const STRICTNESS_PROFILES = {
    low: {
      topK: 4,
      promptPrefix: 'The following are a few loosely related excerpts from the course script. Use them as supplementary reference only — prioritize the lecture transcript and your general knowledge.'
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

    /** Load stored record for a course, or null. */
    async load(courseId) {
      return dbGet(courseId);
    },

    /** Process a PDF file and add its chunks to the course record. */
    async addPdf(courseId, file, onProgress) {
      const arrayBuffer = await file.arrayBuffer();
      const { pages, totalPages } = await extractTextFromPdf(arrayBuffer, onProgress);
      const chunks = chunkPages(pages);

      // Load existing or create new record
      const existing = await dbGet(courseId) || {
        courseId,
        files: [],
        chunks: [],
        idf: {}
      };

      const fileIndex = existing.files.length;
      existing.files.push({
        name: file.name,
        uploadDate: new Date().toISOString(),
        pageCount: totalPages,
        chunkCount: chunks.length,
        size: file.size
      });

      // Tag chunks with file index
      const taggedChunks = chunks.map(c => ({ ...c, fileIndex }));
      existing.chunks = existing.chunks.concat(taggedChunks);

      // Rebuild IDF
      existing.idf = buildIDF(existing.chunks);

      await dbPut(existing);
      return existing;
    },

    /** Remove a specific file (by index) from the course record. */
    async removeFile(courseId, fileIndex) {
      const record = await dbGet(courseId);
      if (!record) return null;

      record.files.splice(fileIndex, 1);
      record.chunks = record.chunks.filter(c => c.fileIndex !== fileIndex);
      // Re-index remaining chunks
      record.chunks = record.chunks.map(c => ({
        ...c,
        fileIndex: c.fileIndex > fileIndex ? c.fileIndex - 1 : c.fileIndex
      }));
      record.idf = buildIDF(record.chunks);

      if (record.files.length === 0) {
        await dbDelete(courseId);
        return null;
      }

      await dbPut(record);
      return record;
    },

    /** Remove all scripts for a course. */
    async removeAll(courseId) {
      await dbDelete(courseId);
    },

    /** Retrieve relevant chunks for a query. Returns { promptPrefix, chunks[] }. */
    retrieve(query, record, strictness) {
      if (!record?.chunks?.length) return { promptPrefix: '', chunks: [] };
      const profile = STRICTNESS_PROFILES[strictness] || STRICTNESS_PROFILES.medium;
      const results = retrieveChunks(query, record.chunks, record.idf || {}, profile.topK);
      return {
        promptPrefix: profile.promptPrefix,
        chunks: results
      };
    },

    /** Build the script context block for injection into the Q&A system prompt. */
    buildScriptContext(query, record, strictness) {
      const { promptPrefix, chunks } = this.retrieve(query, record, strictness);
      if (!chunks.length) return '';

      let ctx = `\n\n--- COURSE SCRIPT EXCERPTS ---\n${promptPrefix}\n\n`;
      for (const c of chunks) {
        const fileName = record.files[c.fileIndex]?.name || 'unknown';
        ctx += `[${fileName}, p.${c.pageNum}] (relevance: ${c.score.toFixed(2)})\n${c.text}\n\n`;
      }
      ctx += '--- END SCRIPT EXCERPTS ---\n';
      return ctx;
    },

    /** Format a file size for display. */
    formatSize(bytes) {
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    },

    STRICTNESS_PROFILES
  };
})();
