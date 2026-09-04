/**
 * tests/helpers/script-manager.js
 * Boots sidebar/scripts.js in a fake sidebar page so the retrieval and PDF
 * bookkeeping can be tested in Node — no IndexedDB, no pdf.js, no 25 MB model.
 *
 * The PDF text and the embedding model are both stubbed: what is under test is
 * which chunks come back and what happens to the stored embeddings, not the
 * extraction or the model itself.
 *
 *   const sm = loadScriptManager({ records: { CS101: existingRecord } });
 *   await sm.ScriptManager.addPdf('CS101', sm.fakeFile('notes.pdf'), null, 'fuzzy');
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');

/**
 * @param {object}   [opts]
 * @param {object}   [opts.records]   courseId → stored record, mutated in place
 * @param {Function} [opts.embed]     text → vector; defaults to a word-count vector
 * @param {string[]} [opts.pages]     page texts the fake PDF extractor returns
 */
function loadScriptManager({ records = {}, embed, pages } = {}) {
  const store = { ...records };
  const embedCalls = [];

  // A tiny deterministic stand-in for the real model: three axes chosen so
  // that texts sharing vocabulary end up pointing the same way.
  const AXES = ['variance', 'sorting', 'bayes'];
  const defaultEmbed = (text) => {
    const lower = String(text).toLowerCase();
    const raw = AXES.map(axis => (lower.split(axis).length - 1) + 0.01);
    const norm = Math.hypot(...raw) || 1;
    return raw.map(v => v / norm);
  };
  const embedOne = (text) => {
    embedCalls.push(text);
    return (embed || defaultEmbed)(text);
  };

  const context = {
    console,
    setTimeout,
    clearTimeout,
    Promise, Math, JSON, Object, Array, String, Number, Boolean, Error,
    Map, Set, RegExp, Date, isNaN, parseInt, parseFloat, Intl,
    indexedDB: undefined,
    document: { getElementById: () => null }
  };
  context.window = context;
  context.self = context;
  context.globalThis = context;
  vm.createContext(context);

  // Real fuzzy retrieval and real fusion — those are the parts under test.
  for (const lib of ['lib/fuzzy-retrieval.js', 'lib/retrieval-fusion.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, lib), 'utf8'), context, { filename: lib });
  }

  const source = fs.readFileSync(path.join(ROOT, 'sidebar/scripts.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'scripts.js' });

  const SM = context.window.ScriptManager;

  // Swap the browser-only pieces for the fakes. Done after load because they
  // are closure-scoped inside scripts.js and only reachable through the API.
  SM.__setTestHooks({
    dbGet: async (id) => (store[id] ? JSON.parse(JSON.stringify(store[id])) : null),
    dbPut: async (record) => { store[record.courseId] = JSON.parse(JSON.stringify(record)); },
    dbDelete: async (id) => { delete store[id]; },
    extractText: async () => ({
      pages: (pages || ['variance of independent random variables']).map((text, i) => ({ pageNum: i + 1, text })),
      totalPages: (pages || ['x']).length
    }),
    ensureEmbedModel: async () => {},
    embedText: async (text) => embedOne(text)
  });

  return {
    ScriptManager: SM,
    store,
    embedCalls,
    fakeFile: (name = 'notes.pdf') => ({
      name,
      size: 1024,
      arrayBuffer: async () => new ArrayBuffer(8)
    })
  };
}

module.exports = { loadScriptManager };
