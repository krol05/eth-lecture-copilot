'use strict';

const { loadScriptManager } = require('./helpers/script-manager.js');

describe('addPdf keeps the embedding index (Bug D)', () => {
  const existing = {
    courseId: 'CS101',
    files: [{ name: 'week1.pdf', chunkCount: 2 }],
    chunks: [
      { text: 'variance of independent random variables', pageNum: 1, fileIndex: 0 },
      { text: 'bayes rule and conditional probability', pageNum: 2, fileIndex: 0 }
    ],
    embeddings: [[1, 0, 0], [0, 0, 1]],
    embeddingModel: 'Xenova/all-MiniLM-L6-v2'
  };

  test('adding a PDF in fuzzy mode no longer wipes the whole course', () => {
    // The old code set embeddings = null here, throwing away the index for
    // every PDF already uploaded — a model download and a full re-index to
    // get back.
    const sm = loadScriptManager({ records: { CS101: existing }, pages: ['sorting algorithms'] });
    return sm.ScriptManager.addPdf('CS101', sm.fakeFile('week2.pdf'), null, 'fuzzy')
      .then(record => {
        expect(record.embeddings).not.toBeNull();
        expect(record.embeddings.length).toBe(record.chunks.length);
        expect(record.embeddings.slice(0, 2)).toEqual([[1, 0, 0], [0, 0, 1]]);
        expect(sm.ScriptManager.hasEmbeddings(record)).toBe(true);
      });
  });

  test('only the new chunks get embedded, not the whole course again', async () => {
    const sm = loadScriptManager({ records: { CS101: existing }, pages: ['sorting algorithms'] });
    await sm.ScriptManager.addPdf('CS101', sm.fakeFile('week2.pdf'), null, 'fuzzy');
    expect(sm.embedCalls).toEqual(['sorting algorithms']);
  });

  test('an un-indexed course stays un-indexed — no surprise model download', async () => {
    const plain = { courseId: 'CS101', files: [], chunks: [], embeddings: null };
    const sm = loadScriptManager({ records: { CS101: plain }, pages: ['sorting algorithms'] });
    const record = await sm.ScriptManager.addPdf('CS101', sm.fakeFile('a.pdf'), null, 'hybrid');
    expect(sm.embedCalls).toEqual([]);
    expect(sm.ScriptManager.hasEmbeddings(record)).toBe(false);
  });

  test('choosing semantic explicitly does index the upload', async () => {
    const plain = { courseId: 'CS101', files: [], chunks: [], embeddings: null };
    const sm = loadScriptManager({ records: { CS101: plain }, pages: ['sorting algorithms'] });
    const record = await sm.ScriptManager.addPdf('CS101', sm.fakeFile('a.pdf'), null, 'semantic');
    expect(sm.embedCalls).toEqual(['sorting algorithms']);
    expect(sm.ScriptManager.hasEmbeddings(record)).toBe(true);
  });
});

describe('retrieve honours the method it is given (Bug E)', () => {
  const texts = [
    'variance of independent random variables',
    'sorting algorithms and their complexity',
    'bayes rule and conditional probability'
  ];

  /** Course whose embeddings match the helper's three-axis fake model. */
  function course(sm) {
    return {
      courseId: 'CS101',
      files: [{ name: 'w.pdf' }],
      chunks: texts.map((text, i) => ({ text, pageNum: i + 1, fileIndex: 0 })),
      embeddings: texts.map(t => sm.__embed(t)),
      embeddingModel: 'Xenova/all-MiniLM-L6-v2'
    };
  }

  test('semantic returns semantic ranking, not fuzzy ranking', async () => {
    const sm = loadScriptManager();
    sm.__embed = (t) => {
      const l = t.toLowerCase();
      const raw = ['variance', 'sorting', 'bayes'].map(a => (l.split(a).length - 1) + 0.01);
      const n = Math.hypot(...raw) || 1;
      return raw.map(v => v / n);
    };
    const rec = course(sm);

    // "bayes" appears in only one chunk, and the fake model puts it on its own
    // axis — so semantic must put that chunk first.
    const out = await sm.ScriptManager.retrieve('bayes', rec, 'low', 'semantic');
    expect(out.method).toBe('semantic');
    expect(out.chunks[0].text).toContain('bayes');
  });

  test('fuzzy is reported as fuzzy', async () => {
    const sm = loadScriptManager();
    sm.__embed = () => [1, 0, 0];
    const out = await sm.ScriptManager.retrieve('variance', course(sm), 'low', 'fuzzy');
    expect(out.method).toBe('fuzzy');
  });

  test('an unknown method falls back to the default rather than breaking', async () => {
    const sm = loadScriptManager();
    sm.__embed = () => [1, 0, 0];
    const out = await sm.ScriptManager.retrieve('variance', course(sm), 'low', 'nonsense');
    expect(['hybrid', 'fuzzy']).toContain(out.method);
    expect(out.chunks.length).toBeGreaterThan(0);
  });

  test('hybrid falls back to fuzzy when the course has no index', async () => {
    const sm = loadScriptManager();
    const noIndex = {
      courseId: 'CS101', files: [{ name: 'w.pdf' }],
      chunks: texts.map((text, i) => ({ text, pageNum: i + 1, fileIndex: 0 })),
      embeddings: null
    };
    const out = await sm.ScriptManager.retrieve('variance', noIndex, 'low', 'hybrid');
    expect(out.method).toBe('fuzzy');
    expect(out.chunks.length).toBeGreaterThan(0);
    expect(sm.embedCalls).toEqual([]);   // no model touched
  });

  test('hybrid uses both rankings when the index is there', async () => {
    const sm = loadScriptManager();
    sm.__embed = (t) => {
      const l = t.toLowerCase();
      const raw = ['variance', 'sorting', 'bayes'].map(a => (l.split(a).length - 1) + 0.01);
      const n = Math.hypot(...raw) || 1;
      return raw.map(v => v / n);
    };
    const out = await sm.ScriptManager.retrieve('variance', course(sm), 'low', 'hybrid');
    expect(out.method).toBe('hybrid');
    expect(out.chunks[0].text).toContain('variance');
    // Fusion metadata proves both lists were consulted.
    expect(out.chunks[0].ranks).toHaveLength(2);
  });

  test('an empty course returns nothing rather than throwing', async () => {
    const sm = loadScriptManager();
    const out = await sm.ScriptManager.retrieve('x', { chunks: [] }, 'low', 'hybrid');
    expect(out).toEqual({ promptPrefix: '', chunks: [], method: 'none' });
  });
});
