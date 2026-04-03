/**
 * scripts.js -- PDF Script Manager for ETH Lecture Copilot
 *
 * Two retrieval methods:
 *   1. "fuzzy"    -- Dice bigram similarity + substring matching (instant, no downloads)
 *   2. "semantic" -- Transformers.js all-MiniLM-L6-v2 embeddings + cosine similarity
 *                    (requires one-time ~25 MB model download; much more accurate)
 *
 * Loaded as a regular <script> before sidebar.js.
 * Exposes window.ScriptManager.
 */

(function () {
  'use strict';

  const Fr = typeof window !== 'undefined' && window.FuzzyRetrieval
    ? window.FuzzyRetrieval
    : null;

  const DB_NAME = 'eth-copilot-scripts';
  const DB_VERSION = 1;
  const STORE = 'scripts';
  const CHUNK_TARGET = 600;
  const CHUNK_OVERLAP = 80;
  const EMBED_MODEL = 'Xenova/all-MiniLM-L6-v2';
  /** CDN fallback only if chrome.runtime is unavailable (non-extension context). */
  const WASM_CDN = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/';

  function getOnnxWasmBaseUrl() {
    if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
      return chrome.runtime.getURL('lib/transformers/');
    }
    return WASM_CDN;
  }

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
        if (trimmed.length > 10) paragraphs.push({ text: trimmed, pageNum: p.pageNum });
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
        if (buffer.text) chunks.push({ text: buffer.text, pageNum: buffer.pageNum });
        buffer = { text: para.text, pageNum: para.pageNum };
      }
    }
    if (buffer.text) chunks.push({ text: buffer.text, pageNum: buffer.pageNum });
    return chunks;
  }

  // METHOD 1: Fuzzy retrieval lives in lib/fuzzy-retrieval.js (shared with Jest).

  function retrieveChunksFuzzy(query, chunks, topK) {
    if (!Fr) throw new Error('FuzzyRetrieval not loaded (include lib/fuzzy-retrieval.js before scripts.js)');
    return Fr.retrieveChunksFuzzy(query, chunks, topK);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // METHOD 2: Semantic Retrieval (Transformers.js embeddings)
  // ═══════════════════════════════════════════════════════════════════════════

  let embedPipeline = null;
  let modelLoadPromise = null;

  async function ensureEmbedModel(onStatus) {
    if (embedPipeline) return;
    if (modelLoadPromise) { await modelLoadPromise; return; }

    modelLoadPromise = (async () => {
      if (onStatus) onStatus('Loading AI model library...');
      const mod = await import('../lib/transformers/transformers.min.js');
      const { pipeline, env } = mod;

      env.allowLocalModels = false;
      // Extension CSP blocks dynamic import() from CDNs; ship ort-wasm-simd-threaded.jsep.{mjs,wasm} locally.
      env.backends.onnx.wasm.wasmPaths = getOnnxWasmBaseUrl();
      env.backends.onnx.wasm.proxy = false;

      if (onStatus) onStatus('Downloading embedding model (~25 MB, one-time)...');
      embedPipeline = await pipeline('feature-extraction', EMBED_MODEL, {
        quantized: true,
        progress_callback: (info) => {
          if (onStatus && info.status === 'progress' && info.progress != null) {
            onStatus(`Downloading model: ${Math.round(info.progress)}%`);
          }
        }
      });
      if (onStatus) onStatus('Model ready');
    })();

    try { await modelLoadPromise; }
    finally { modelLoadPromise = null; }
  }

  async function embedSingleText(text) {
    const result = await embedPipeline(text, { pooling: 'mean', normalize: true });
    return Array.from(result.data);
  }

  async function embedManyTexts(texts, onStatus) {
    const vecs = [];
    for (let i = 0; i < texts.length; i++) {
      vecs.push(await embedSingleText(texts[i]));
      if (onStatus) onStatus(`Embedding chunks: ${i + 1} / ${texts.length}`);
      if (i % 3 === 0) await new Promise(r => setTimeout(r, 0));
    }
    return vecs;
  }

  function cosineSim(a, b) {
    let dot = 0;
    for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
    return dot;
  }

  function retrieveChunksSemantic(queryVec, chunks, embeddings, topK) {
    if (!chunks.length || !embeddings?.length) return [];
    const scored = chunks.map((c, i) => ({
      index: i,
      score: cosineSim(queryVec, embeddings[i]),
      text: c.text, pageNum: c.pageNum, fileIndex: c.fileIndex
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  // ─── Strictness configuration ────────────────────────────────────────────

  const STRICTNESS_PROFILES = {
    low:    { topK: 4,  promptPrefix: 'The following are a few loosely related excerpts from the course script. Use them as supplementary reference only -- prioritize the lecture transcript and your general knowledge.' },
    medium: { topK: 8,  promptPrefix: 'The following are relevant excerpts from the course script. Integrate this material with the lecture content to provide well-rounded answers. Cite page numbers when referencing specific script content.' },
    high:   { topK: 14, promptPrefix: 'The following are highly relevant excerpts from the course script. Treat the script as a primary authoritative source. Ground your answers in the script content wherever possible and cite page numbers.' },
    strict: { topK: 20, promptPrefix: 'The following are extensive excerpts from the course script. You MUST base your answer primarily on the script content below. Only add information from the lecture transcript if the script does not cover the topic. Always cite page numbers.' }
  };

  // ─── Public API ──────────────────────────────────────────────────────────

  window.ScriptManager = {

    extractCourseId,
    STRICTNESS_PROFILES,

    async load(courseId) { return dbGet(courseId); },

    /** Upload a PDF. If method === 'semantic', also computes embeddings. */
    async addPdf(courseId, file, onProgress, method) {
      const arrayBuffer = await file.arrayBuffer();
      const { pages, totalPages } = await extractTextFromPdf(arrayBuffer, (page, total) => {
        if (onProgress) onProgress(`${file.name}: extracting page ${page}/${total}`);
      });
      const chunks = chunkPages(pages);

      const existing = await dbGet(courseId) || { courseId, files: [], chunks: [], embeddings: null };
      const fileIndex = existing.files.length;
      existing.files.push({
        name: file.name, uploadDate: new Date().toISOString(),
        pageCount: totalPages, chunkCount: chunks.length, size: file.size
      });

      const taggedChunks = chunks.map(c => ({ ...c, fileIndex }));
      existing.chunks = existing.chunks.concat(taggedChunks);

      if (method === 'semantic') {
        await ensureEmbedModel(onProgress);
        const newVecs = await embedManyTexts(
          taggedChunks.map(c => c.text),
          onProgress
        );
        existing.embeddings = (existing.embeddings || []).concat(newVecs);
        existing.embeddingModel = EMBED_MODEL;
      } else {
        existing.embeddings = null;
      }

      await dbPut(existing);
      return existing;
    },

    /** Compute embeddings for an existing record that doesn't have them yet. */
    async computeEmbeddings(courseId, onStatus) {
      const record = await dbGet(courseId);
      if (!record?.chunks?.length) return record;

      await ensureEmbedModel(onStatus);
      record.embeddings = await embedManyTexts(
        record.chunks.map(c => c.text),
        onStatus
      );
      record.embeddingModel = EMBED_MODEL;
      await dbPut(record);
      return record;
    },

    hasEmbeddings(record) {
      return !!(record?.embeddings?.length && record.embeddings.length === record.chunks?.length);
    },

    isModelLoaded() { return !!embedPipeline; },

    async removeFile(courseId, fileIndex) {
      const record = await dbGet(courseId);
      if (!record) return null;
      record.files.splice(fileIndex, 1);
      const removedIndices = new Set();
      record.chunks.forEach((c, i) => { if (c.fileIndex === fileIndex) removedIndices.add(i); });
      if (record.embeddings?.length) {
        record.embeddings = record.embeddings.filter((_, i) => !removedIndices.has(i));
      }
      record.chunks = record.chunks.filter(c => c.fileIndex !== fileIndex);
      record.chunks = record.chunks.map(c => ({
        ...c, fileIndex: c.fileIndex > fileIndex ? c.fileIndex - 1 : c.fileIndex
      }));
      if (record.files.length === 0) { await dbDelete(courseId); return null; }
      if (record.embeddings?.length && record.embeddings.length !== record.chunks.length) {
        record.embeddings = null;
        record.embeddingModel = null;
      }
      await dbPut(record);
      return record;
    },

    async removeAll(courseId) { await dbDelete(courseId); },

    /** Unified retrieval: picks fuzzy or semantic based on method + data availability. */
    retrieve(query, record, strictness, method) {
      if (!record?.chunks?.length) return { promptPrefix: '', chunks: [] };
      const profile = STRICTNESS_PROFILES[strictness] || STRICTNESS_PROFILES.medium;
      const results = retrieveChunksFuzzy(query, record.chunks, profile.topK);
      return { promptPrefix: profile.promptPrefix, chunks: results };
    },

    /** Async semantic retrieve (needs to embed the query). */
    async retrieveSemantic(query, record, strictness) {
      if (!record?.chunks?.length || !this.hasEmbeddings(record)) {
        return { promptPrefix: '', chunks: [] };
      }
      await ensureEmbedModel();
      const profile = STRICTNESS_PROFILES[strictness] || STRICTNESS_PROFILES.medium;
      const queryVec = await embedSingleText(query);
      const results = retrieveChunksSemantic(queryVec, record.chunks, record.embeddings, profile.topK);
      return { promptPrefix: profile.promptPrefix, chunks: results };
    },

    /** Build context string. method = 'fuzzy' | 'semantic'. Semantic path is async. */
    buildScriptContext(query, record, strictness, method) {
      const { promptPrefix, chunks } = this.retrieve(query, record, strictness, method);
      return formatContext(promptPrefix, chunks, record);
    },

    async buildScriptContextSemantic(query, record, strictness) {
      const { promptPrefix, chunks } = await this.retrieveSemantic(query, record, strictness);
      return formatContext(promptPrefix, chunks, record);
    },

    formatSize(bytes) {
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }
  };

  function formatContext(promptPrefix, chunks, record) {
    if (!chunks.length) return '';
    let ctx = `\n\n--- COURSE SCRIPT EXCERPTS ---\n${promptPrefix}\n\n`;
    for (const c of chunks) {
      const fileName = record.files[c.fileIndex]?.name || 'unknown';
      ctx += `[${fileName}, p.${c.pageNum}] (relevance: ${c.score.toFixed(3)})\n${c.text}\n\n`;
    }
    ctx += '--- END SCRIPT EXCERPTS ---\n';
    return ctx;
  }
})();
