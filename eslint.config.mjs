import js from '@eslint/js';
import globals from 'globals';
import { sidebarGlobalConfigs } from './scripts/sidebar-globals.mjs';

// Globals each lib script exposes (IIFE + Object.assign(root, api) pattern),
// consumed cross-file by the script-tag architecture. no-undef is the guard
// rail that catches a broken cross-file reference during the refactor.
const libGlobals = {
  // lib/debug.js
  CopilotDebug: 'readonly',
  __ETH_COPILOT_DEBUG__: 'writable',
  // lib/ui-settings.js
  UISettings: 'readonly',
  // lib/fuzzy-retrieval.js
  FuzzyRetrieval: 'readonly',
  // lib/retrieval-fusion.js
  RetrievalFusion: 'readonly',
  fuseRankings: 'readonly',
  // lib/qa-stream-flush.js
  QaStreamFlush: 'readonly',
  // lib/guide-parse.js
  parseGuideResponse: 'readonly',
  findMatchingBrace: 'readonly',
  fixEscapes: 'readonly',
  salvageTruncated: 'readonly',
  createGuideBlockScanner: 'readonly',
  // lib/concept-split.js
  splitConceptText: 'readonly',
  isAbbreviationDot: 'readonly',
  conceptToParts: 'readonly',
  conceptToText: 'readonly',
  // lib/render-inline.js
  escHtml: 'readonly',
  renderMarkdownInline: 'readonly',
  wrapUndelimitedInlineMath: 'readonly',
  // lib/flashcards.js (Object.assign spreads the api onto the global object)
  normalizeFlashcard: 'readonly',
  normalizeFlashcardsResponse: 'readonly',
  getFlashcardMetadataRows: 'readonly',
  buildFlashcardMetadataText: 'readonly',
  buildFlashcardBackWithMetadata: 'readonly',
  buildFlashcardBackHtmlWithMetadata: 'readonly',
  markdownishToHtml: 'readonly',
  buildFlashcardAnkiTags: 'readonly',
  formatCardType: 'readonly',
  formatTimeRange: 'readonly',
  convertDollarMathToAnki: 'readonly',
  sanitizeTag: 'readonly',
  // lib/prompts.js (plain top-level script — global lexical scope)
  GUIDE_SYSTEM_PROMPT: 'readonly',
  buildQASystemPrompt: 'readonly',
  buildFlashcardsPrompt: 'readonly',
  normalizeFlashcardTypeSelection: 'readonly',
  buildQuizPrompt: 'readonly',
  buildExamQuestionsPrompt: 'readonly',
  buildCrossLecturePredictionPrompt: 'readonly',
  buildToolAskPrompt: 'readonly',
  // sidebar/scripts.js
  ScriptManager: 'readonly',
  // lib/error-format.js
  formatError: 'readonly',
  // sidebar/error-panel.js
  ErrorPanel: 'readonly',
  // sidebar/generation-bar.js
  GenerationBar: 'readonly',
  // lib/providers/catalog.js + adapters.js + overrides.js + adapter-spec.js
  Catalog: 'readonly',
  Adapters: 'readonly',
  resolveProvider: 'readonly',
  listResolvedProviders: 'readonly',
  normalizeOAIBase: 'readonly',
  validateSpec: 'readonly',
  adapterFromSpec: 'readonly',
  // sidebar/print-common.js
  runPrintPage: 'readonly',
  // vendored KaTeX / pdf.js
  katex: 'readonly',
  renderMathInElement: 'readonly',
  pdfjsLib: 'writable'
};

export default [
  {
    ignores: [
      'node_modules/**',
      'lib/katex/**',
      'lib/pdfjs/**',
      'lib/transformers/**',
      'docs/**'
    ]
  },
  js.configs.recommended,
  {
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
      // \x00 delimiters are used deliberately (render-inline stash, guide-parse sanitizing)
      'no-control-regex': 'off',
      // Real smells, but cleaning them up belongs to the sidebar-split milestone (M6)
      'no-useless-assignment': 'warn'
    }
  },
  {
    // Extension pages: popup, options, print
    files: ['popup/**/*.js', 'ui/**/*.js'],
    languageOptions: {
      globals: { ...globals.browser, chrome: 'readonly', ...libGlobals }
    }
  },
  {
    // The sidebar's modules share one global scope (see scripts/sidebar-globals.mjs),
    // so each file also sees every name the others declare.
    files: ['sidebar/**/*.js'],
    languageOptions: {
      // Plain <script> tags, not modules — this is what puts each file's
      // top-level declarations in the shared global scope.
      sourceType: 'script',
      globals: { ...globals.browser, chrome: 'readonly', ...libGlobals }
    },
    rules: {
      // Every module leaves names behind for the others to call, which reads as
      // unused inside its own file — so only locals are checked here. no-undef
      // is what guards the cross-file calls.
      'no-unused-vars': ['warn', {
        vars: 'local',
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_'
      }]
    }
  },
  // Per-file: the names each sidebar module gets from its siblings.
  ...sidebarGlobalConfigs(),
  {
    // Content script
    files: ['content/**/*.js'],
    languageOptions: {
      globals: { ...globals.browser, chrome: 'readonly', CopilotDebug: 'readonly' }
    }
  },
  {
    // MV3 service worker
    files: ['background/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.worker,
        chrome: 'readonly',
        importScripts: 'readonly',
        CopilotDebug: 'readonly',
        Catalog: 'readonly',
        Adapters: 'readonly',
        resolveProvider: 'readonly',
        validateSpec: 'readonly',
        adapterFromSpec: 'readonly',
        parseGuideResponse: 'readonly',
        findMatchingBrace: 'readonly',
        fixEscapes: 'readonly',
        salvageTruncated: 'readonly'
      }
    }
  },
  {
    // Shared lib modules: UMD-ish, must run in browser AND Node (tests)
    files: ['lib/**/*.js'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node, chrome: 'readonly' }
    }
  },
  {
    // Jest tests
    files: ['tests/**/*.js'],
    languageOptions: {
      globals: { ...globals.node, ...globals.jest }
    }
  },
  {
    // Node scripts (CI helpers)
    files: ['scripts/**/*.mjs', 'eslint.config.mjs'],
    languageOptions: {
      globals: { ...globals.node }
    }
  }
];
