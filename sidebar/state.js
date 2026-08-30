/**
 * sidebar/state.js — Shared sidebar state and DOM references.
 *
 * Part of the sidebar, loaded as a plain script in the order listed in
 * sidebar.html. All sidebar modules share one global scope on purpose:
 * it is what lets each file be a straight move out of the old sidebar.js.
 */

// ─── State ────────────────────────────────────────────────────────────────
let transcript = null;      // { cues, text, lectureTitle, lectureUrl, videoDuration }
let guide = null;           // parsed guide JSON
let guideLanguage = '';     // language used when the active guide was generated
let settings = null;        // { provider, model, apiKey }
let currentBlockIndex = -1;
// Multi-chat state — each chat has its own message history
let qaChats = [{ id: 1, name: 'Chat 1', messages: [] }];
let activeQaChatIdx = 0;
let _nextChatId = 2;
let activeQaStreamChatIdx = 0; // which chat the current stream is going to
let qaMessages = qaChats[0].messages; // convenience ref — always points to active chat's messages
/** When set, Q&A “reply ready” toast scroll target (assistant message element). */
let qaReplyReadyTargetEl = null;
let isGenerating = false;
let attachedImages = [];         // {dataUrl, label} objects — captured frames + pasted/dropped images
let activeGuideRequestId = null;
let _activeGuideAbortFn = null;  // abort function for the active guide request
// Per-stream state — keyed by requestId. Allows simultaneous streams across chats.
const qaActiveStreams = new Map();
// qaActiveStreams value shape:
// { chatIdx, el, bubble, buffer, stableEnd, katexEnd, rafPending, rafHandle, finalized, katexThrottle, abortFn }

function isChatStreaming(chatIdx) {
  for (const s of qaActiveStreams.values()) {
    if (s.chatIdx === chatIdx) return true;
  }
  return false;
}
let customPromptExtras = { guide: '', qa: '', flashcards: '', quiz: '', exam: '' };
let flashcardIndex = 0;          // current card index in paginated flashcard view
let requestIdCounter = 0;
const pendingRequests = {};
let currentLectureUrl = null;
let lastVideoTime = 0;
/** When true, guide block follows video time. */
let autoTimeFollow = localStorage.getItem('eth-copilot-auto-time-follow') !== '0';
/** True when the user is manually browsing blocks (arrows); auto-follow stays "checked" but paused. */
let autoFollowPaused = false;

// ─── DOM Refs ─────────────────────────────────────────────────────────────
const statusBar    = document.getElementById('status-bar');
const statusText   = document.getElementById('status-text');
const statusDismiss = document.getElementById('status-dismiss');
const generateBtn  = document.getElementById('generate-btn');
const generateError = document.getElementById('generate-error');
const guideEmpty   = document.getElementById('guide-empty');
const guideContent = document.getElementById('guide-content');
const guideBlock   = document.getElementById('guide-block');
const blockCounter = document.getElementById('block-counter');
const progressFill = document.getElementById('progress-fill');
const qaMessages_el = document.getElementById('qa-messages');
const qaInput      = document.getElementById('qa-input');
const qaSend       = document.getElementById('qa-send');
const qaFrameBtn   = document.getElementById('qa-frame-btn');
const qaLectureSummaryBtn = document.getElementById('qa-lecture-summary-btn');
const qaImageStrip = document.getElementById('qa-image-strip');
const qaAttachBtn  = document.getElementById('qa-attach-btn');
const qaFileInput  = document.getElementById('qa-file-input');
const themeToggle  = document.getElementById('theme-toggle');
const uiSettingsBtn = document.getElementById('ui-settings-btn');
const focusToggle  = document.getElementById('focus-toggle');
const exportPdfBtn = document.getElementById('export-pdf-btn');
const exportMdBtn  = document.getElementById('export-md-btn');
const copyLatexMultiBtn = document.getElementById('copy-latex-multi-btn');
const regenerateBtn = document.getElementById('regenerate-btn');
const blockPrevBtn   = document.getElementById('block-prev-btn');
const blockNextBtn   = document.getElementById('block-next-btn');
const blockJumpInput = document.getElementById('block-jump-input');
const jumpCurrentBlockBtn = document.getElementById('jump-current-block-btn');
const autoTimeFollowCb = document.getElementById('auto-time-follow-cb');
const autoFollowPauseHint = document.getElementById('auto-follow-pause-hint');
const genSettings    = document.getElementById('gen-settings');
const genLangSel     = document.getElementById('gen-lang-select');
const genLangCustomRow = document.getElementById('gen-lang-custom-row');
const genLangCustom  = document.getElementById('gen-lang-custom');
const genModeSel     = document.getElementById('gen-mode-select');
const genDetailSel   = document.getElementById('gen-detail-select');
const genCountSel    = document.getElementById('gen-count-select');
const genCustomTokenRow = document.getElementById('gen-custom-token-row');
const genCustomTokenInput = document.getElementById('gen-custom-token-input');
const genTokenHint   = document.getElementById('gen-token-hint');
const genTempSlider  = document.getElementById('gen-temp-slider');
const genTempValue   = document.getElementById('gen-temp-value');
const genThinkingSel = document.getElementById('gen-thinking-select');
const genThinkingHint = document.getElementById('gen-thinking-hint');
const genFallbackCb  = document.getElementById('gen-fallback-cb');
const qaTempSlider   = document.getElementById('qa-temp-slider');
const qaTempValue    = document.getElementById('qa-temp-value');
const qaThinkingSel  = document.getElementById('qa-thinking-select');
const qaThinkingHint = document.getElementById('qa-thinking-hint');
const qaCustomization = document.getElementById('qa-customization');
const qaResponseLengthSel = document.getElementById('qa-response-length-select');
const qaResponseStyleSel = document.getElementById('qa-response-style-select');
const qaReplyReadyToast = document.getElementById('qa-reply-ready-toast');
const qaReplyReadyToastDismiss = document.getElementById('qa-reply-ready-toast-dismiss');
const qaReplyReadyToastTitle = document.getElementById('qa-reply-ready-toast-title');
const qaReplyReadyToastSub = document.getElementById('qa-reply-ready-toast-sub');

// Script panel refs
const scriptPanel       = document.getElementById('script-panel');
const scriptPanelToggle = document.getElementById('script-panel-toggle');
const scriptPanelBody   = document.getElementById('script-panel-body');
const scriptBadge       = document.getElementById('script-badge');
const scriptFileList    = document.getElementById('script-file-list');
const scriptUploadBtn   = document.getElementById('script-upload-btn');
const scriptFileInput   = document.getElementById('script-file-input');
const scriptUploadStatus = document.getElementById('script-upload-status');
const scriptStrictnessSel = document.getElementById('script-strictness-select');
const scriptSearchMethod = document.getElementById('script-search-method');
const scriptSemanticInfo = document.getElementById('script-semantic-info');
const scriptEmbedBtn     = document.getElementById('script-embed-btn');
const scriptEmbedStatus  = document.getElementById('script-embed-status');
const flashcardsBtn    = document.getElementById('flashcards-btn');
const quizBtn          = document.getElementById('quiz-btn');
const examBtn          = document.getElementById('exam-btn');
const lectureSummaryBtn = document.getElementById('lecture-summary-btn');

const latexSelectModal = document.getElementById('latex-select-modal');
const latexModalClose = document.getElementById('latex-modal-close');
const latexSelectAllBtn = document.getElementById('latex-select-all-btn');
const latexDeselectAllBtn = document.getElementById('latex-deselect-all-btn');
const latexCopySelectedBtn = document.getElementById('latex-copy-selected-btn');
const latexBlockList = document.getElementById('latex-block-list');

let scriptRecord = null;  // current course's script data
let scriptCourseId = null;

// ── Feature state (flashcards / quiz / exam) ──────────────────────────────
/** Flashcards generated by AI. Each: {front, back} */
let flashcardData = [];
let flashcardDeckTitle = null;
/** Quiz questions generated by AI. Each: {type, question, options?, correct?, answer?, explanation} */
let quizData = [];
/** Current quiz state */
let quizState = null; // { questions, currentIndex, scores: [true/false/null], done: false }
/** Exam questions for the current lecture (Tools tab) */
let examQuestionData = [];
/** Cross-lecture exam prediction output */
let crossExamQuestionData = [];
let crossExamTopics = [];
/** Ephemeral per-item ask chats — keyed e.g. flashcard:2, quiz:0 */
let toolAskSessions = {};
let toolAskActiveSessionKey = null;
const toolAskActiveStreams = new Map();
/** Shared lecture summary (one per lecture URL, synced Guide ↔ Q&A) */
let lectureSummaryText = null;
let lectureSummaryGenerating = false;
let lectureSummarySource = null; // 'guide' | 'qa'
/** Stream buffer for guide streaming */
let streamBuffer = '';

const QA_LENGTH_PROFILE_PROMPTS = {
  ultra_concise: 'Respond in 1-2 compact bullets or very short sentences. Keep only the core answer, no extra context.',
  concise: 'Keep it concise: short explanation with only essential supporting detail.',
  thorough: 'Provide a thorough explanation with clear steps and key intuition, while staying focused on the question.',
  deep_lecture: 'Provide maximum detail, but stay strictly within lecture/script/guide scope. Do not add beyond-lecture material.',
  deep_extended: 'Provide maximum detail and include relevant beyond-lecture context, extensions, and connections when useful.'
};

const QA_STYLE_PROFILE_PROMPTS = {
  eli5: 'Explain like I am 5: super simple words, tiny steps, concrete examples, no jargon unless immediately explained.',
  friendly: 'Explain for a complete beginner with very simple analogies and plain terms.',
  plain: 'Use simple everyday language, avoid jargon unless absolutely needed.',
  structured: 'Explain with clear structure: brief overview, then core points, then a short takeaway.',
  tutor: 'Teach step-by-step, showing reasoning progression and checks for understanding.',
  technical: 'Use precise technical terminology and concise formal wording.',
  formal: 'Use rigorous, formal reasoning with explicit assumptions and careful definitions.'
};
