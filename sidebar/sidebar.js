/**
 * sidebar.js — ETH Lecture Copilot Sidebar
 *
 * Runs inside the extension iframe. Communicates with content.js via postMessage.
 * Handles:
 * - Receiving transcript from content script
 * - Guide generation trigger → API via content.js → background
 * - Rendering guide blocks with KaTeX
 * - Timestamp sync → shows correct block
 * - Q&A chat with full context
 * - Frame attachment
 * - Theme toggle
 */

(function () {
  'use strict';

  // ─── State ────────────────────────────────────────────────────────────────
  let transcript = null;      // { cues, text, lectureTitle, lectureUrl, videoDuration }
  let guide = null;           // parsed guide JSON
  let settings = null;        // { provider, model, apiKey }
  let currentBlockIndex = -1;
  let qaMessages = [];        // conversation history
  /** When set, Q&A “reply ready” toast scroll target (assistant message element). */
  let qaReplyReadyTargetEl = null;
  let isGenerating = false;
  let isChatting = false;
  let attachedImages = [];         // {dataUrl, label} objects — captured frames + pasted/dropped images
  let activeGuideRequestId = null;
  let activeQaRequestId = null;   // requestId of the active streaming QA request
  let isQaStreaming = false;       // true while QA stream is in flight
  let qaStreamBuffer = '';         // accumulated text for the active QA stream
  let qaStreamEl = null;           // the streaming assistant message div
  let qaStreamBubble = null;       // .chat-bubble inside qaStreamEl
  let qaKatexThrottle = null;      // setTimeout for throttled KaTeX re-render
  let qaRafPending = false;        // rAF gate for Q&A stream rendering
  let qaStreamDollarCount = 0;     // tracks how many $$ seen so far (even = complete blocks)
  let qaStreamStableEnd = 0;       // buffer index up to which chars have been appended to DOM as plain spans
  let qaStreamKatexEnd  = 0;       // buffer index up to which chars have been rendered in the KaTeX zone
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
  const qaReplyReadyToast = document.getElementById('qa-reply-ready-toast');
  const qaReplyReadyToastAction = document.getElementById('qa-reply-ready-toast-action');
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
  /** Quiz questions generated by AI. Each: {type, question, options?, correct?, answer?, explanation} */
  let quizData = [];
  /** Current quiz state */
  let quizState = null; // { questions, currentIndex, scores: [true/false/null], done: false }
  /** Stream buffer for guide streaming */
  let streamBuffer = '';

  // ─── Init ─────────────────────────────────────────────────────────────────

  function init() {
    postToContent({ type: 'GET_SETTINGS' });

    // Tab switching
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    themeToggle.addEventListener('click', toggleTheme);
    uiSettingsBtn?.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' });
    });
    focusToggle?.addEventListener('click', () => {
      postToContent({ type: 'TOGGLE_FOCUS' });
    });
    applyStoredTheme();
    applyUISettings();
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[window.UISettings?.STORAGE_KEY || 'uiSettings']) {
        applyUISettings();
      }
    });

    generateBtn.addEventListener('click', onGenerateClick);
    exportPdfBtn?.addEventListener('click', () => {
      if (guide?.guide?.length) {
        openGuidePrintWindow(guide, transcript?.lectureTitle || guide?.lecture_title);
      }
    });
    copyLatexMultiBtn?.addEventListener('click', openLatexSelectModal);
    regenerateBtn.addEventListener('click', onRegenerateClick);

    if (autoTimeFollowCb) {
      autoTimeFollowCb.checked = autoTimeFollow;
      autoTimeFollowCb.addEventListener('change', onAutoTimeFollowChange);
    }
    blockPrevBtn?.addEventListener('click', () => navigateBlock(-1));
    blockNextBtn?.addEventListener('click', () => navigateBlock(1));
    jumpCurrentBlockBtn?.addEventListener('click', jumpToCurrentTimeBlock);

    blockJumpInput?.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); commitBlockJump(); blockJumpInput.blur(); }
      if (e.key === 'Escape') { restoreBlockJumpInput(); blockJumpInput.blur(); }
    });
    blockJumpInput?.addEventListener('blur', restoreBlockJumpInput);

    genLangSel?.addEventListener('change', () => {
      if (genLangCustomRow) {
        genLangCustomRow.style.display = genLangSel.value === 'other' ? '' : 'none';
      }
    });

    genDetailSel?.addEventListener('change', updateTokenHint);
    genCountSel?.addEventListener('change', () => {
      updateCustomTokenVisibility();
      updateTokenHint();
    });
    genCustomTokenInput?.addEventListener('input', updateTokenHint);
    updateCustomTokenVisibility();
    updateTokenHint();

    function updateSliderFill(slider) {
      const pct = ((slider.value - slider.min) / (slider.max - slider.min)) * 100;
      slider.style.setProperty('--pct', `${pct}%`);
    }
    genTempSlider?.addEventListener('input', () => {
      genTempValue.textContent = (genTempSlider.value / 100).toFixed(2);
      updateSliderFill(genTempSlider);
    });
    if (genTempSlider) updateSliderFill(genTempSlider);

    qaTempSlider?.addEventListener('input', () => {
      qaTempValue.textContent = (qaTempSlider.value / 100).toFixed(2);
      updateSliderFill(qaTempSlider);
    });
    if (qaTempSlider) updateSliderFill(qaTempSlider);
    qaThinkingSel?.addEventListener('change', () => {
      localStorage.setItem('eth-copilot-qa-thinking', qaThinkingSel.value || 'none');
    });
    if (qaThinkingSel) qaThinkingSel.value = localStorage.getItem('eth-copilot-qa-thinking') || 'none';
    genFallbackCb?.addEventListener('change', () => {
      genSettings?.classList.toggle('disabled-controls', genFallbackCb.checked);
    });

    document.getElementById('manual-paste-link').addEventListener('click', e => {
      e.preventDefault();
      showManualPasteOption();
    });

    qaInput.addEventListener('input', onQaInputChange);
    qaInput.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendQaMessage(); }
    });
    qaSend.addEventListener('click', sendQaMessage);
    qaMessages_el?.addEventListener('click', onQaMessagesClick);
    qaMessages_el?.addEventListener('scroll', onQaMessagesScroll);

    qaReplyReadyToastAction?.addEventListener('click', () => {
      qaScrollToBottom();
      hideQaReplyReadyToast();
    });
    qaReplyReadyToastDismiss?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      hideQaReplyReadyToast();
    });

    // Cross-tab notification: click → switch to QA and jump to reply
    _crossTabNotifyBtn()?.addEventListener('click', () => {
      switchTab('qa');
      if (_crossTabNotifyTarget && _crossTabNotifyTarget.isConnected) {
        qaScrollMessagesToShowElementTop(_crossTabNotifyTarget);
      }
      hideCrossTabNotify();
    });
    _crossTabNotifyClose()?.addEventListener('click', () => hideCrossTabNotify());

    // QA scroll-to-bottom button
    initQaScrollButton();

    // Arrow ↑/↓ speed control — works from anywhere in the sidebar
    document.addEventListener('keydown', e => {
      if (e.target?.tagName === 'INPUT' || e.target?.tagName === 'TEXTAREA') return;
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        postToContent({ type: 'SPEED_CHANGE', direction: e.key === 'ArrowUp' ? 1 : -1 });
      }
    });

    qaFrameBtn?.addEventListener('click', async () => {
      qaFrameBtn.disabled = true;
      const b64 = await captureFrame();
      qaFrameBtn.disabled = false;
      if (b64) {
        attachedImages.push({ dataUrl: `data:image/jpeg;base64,${b64}`, label: 'Frame' });
        renderImageStrip();
      } else {
        setStatus('warning', 'Frame capture failed');
      }
    });

    // Paste images anywhere in the Q&A input area
    qaInput.addEventListener('paste', e => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          processImageFile(item.getAsFile());
        }
      }
    });

    // Drag-and-drop onto the textarea
    qaInput.addEventListener('dragover', e => {
      if ([...e.dataTransfer.items].some(i => i.kind === 'file' && i.type.startsWith('image/'))) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        qaInput.classList.add('drag-over');
      }
    });
    qaInput.addEventListener('dragleave', () => qaInput.classList.remove('drag-over'));
    qaInput.addEventListener('drop', e => {
      qaInput.classList.remove('drag-over');
      const files = [...e.dataTransfer.files].filter(f => f.type.startsWith('image/'));
      if (!files.length) return;
      e.preventDefault();
      files.forEach(processImageFile);
    });

    // Paperclip button → file picker
    qaAttachBtn?.addEventListener('click', () => qaFileInput?.click());
    qaFileInput?.addEventListener('change', () => {
      [...qaFileInput.files].forEach(processImageFile);
      qaFileInput.value = '';
    });

    // Script panel
    scriptPanelToggle?.addEventListener('click', () => {
      const isOpen = scriptPanel.classList.toggle('open');
      scriptPanelBody.classList.toggle('open', isOpen);
      scriptPanelToggle.setAttribute('aria-expanded', String(isOpen));
    });
    scriptUploadBtn?.addEventListener('click', () => scriptFileInput?.click());
    scriptFileInput?.addEventListener('change', handleScriptUpload);
    scriptSearchMethod?.addEventListener('change', onSearchMethodChange);
    scriptEmbedBtn?.addEventListener('click', onEmbedExistingClick);

    latexModalClose?.addEventListener('click', closeLatexSelectModal);
    latexSelectAllBtn?.addEventListener('click', () => setAllLatexSelections(true));
    latexDeselectAllBtn?.addEventListener('click', () => setAllLatexSelections(false));
    latexCopySelectedBtn?.addEventListener('click', copyLatexFromSelectedBlocks);
    latexSelectModal?.addEventListener('click', (e) => {
      if (e.target === latexSelectModal) closeLatexSelectModal();
    });

    // Export MD button
    document.getElementById('export-md-btn')?.addEventListener('click', exportGuideAsMarkdown);

    // Feature buttons — open inline split panel within Guide tab (no tab switch)
    flashcardsBtn?.addEventListener('click', () =>
      openInlineToolPanel('flashcards', 'Flashcards', _buildInlineFlashcards));
    quizBtn?.addEventListener('click', () =>
      openInlineToolPanel('quiz', 'Practice Quiz', _buildInlineQuiz));
    examBtn?.addEventListener('click', () =>
      openInlineToolPanel('exam', 'Exam Questions', _buildInlineExam));

    document.getElementById('guide-inline-tool-close')?.addEventListener('click', closeInlineToolPanel);

    // Flashcards tool
    document.getElementById('flashcards-generate-btn')?.addEventListener('click', generateFlashcards);
    document.getElementById('flashcards-back-btn')?.addEventListener('click', () => showFlashcardsPanel('settings'));
    document.getElementById('flashcards-export-tsv')?.addEventListener('click', exportFlashcardsAsTSV);
    document.getElementById('flashcards-export-anki')?.addEventListener('click', sendFlashcardsToAnki);
    initPillGroup('flashcards-count-pills');
    initPillGroup('flashcards-style-pills');

    // Quiz tool
    document.getElementById('quiz-generate-btn')?.addEventListener('click', generateQuiz);
    document.getElementById('quiz-reveal-btn')?.addEventListener('click', quizRevealAnswer);
    document.getElementById('quiz-submit-mc-btn')?.addEventListener('click', quizSubmitMC);
    document.getElementById('quiz-grade-correct')?.addEventListener('click', () => quizGrade(true));
    document.getElementById('quiz-grade-wrong')?.addEventListener('click', () => quizGrade(false));
    document.getElementById('quiz-quit-btn')?.addEventListener('click', () => showQuizPanel('settings'));
    document.getElementById('quiz-restart-btn')?.addEventListener('click', () => showQuizPanel('settings'));
    document.getElementById('quiz-results-close-btn')?.addEventListener('click', () => { quizState = null; showQuizPanel('settings'); });
    initPillGroup('quiz-count-pills');
    initPillGroup('quiz-type-pills');

    // Exam tool
    document.getElementById('exam-generate-btn')?.addEventListener('click', generateExamQuestions);
    document.getElementById('exam-back-btn')?.addEventListener('click', () => showExamPanel('settings'));
    initPillGroup('exam-scope-pills', onExamScopeChange);
    initPillGroup('exam-difficulty-pills');
    initPillGroup('exam-format-pills');
    initPillGroup('exam-answer-pills');
    initPillGroup('exam-count-pills');

    // Cross-exam tool
    document.getElementById('cross-exam-generate-btn')?.addEventListener('click', generateCrossLecturePrediction);
    document.getElementById('cross-exam-back-btn')?.addEventListener('click', () => showCrossExamPanel('settings'));
    initPillGroup('cross-exam-difficulty-pills');
    initPillGroup('cross-exam-format-pills');
    initPillGroup('cross-exam-count-pills');

    // Populate cross-exam lecture list whenever Tools tab opens
    document.querySelector('[data-tab="tools"]')?.addEventListener('click', () => {
      populateCrossExamLectureList();
    });

    // Escape key: dismiss modals
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      if (latexSelectModal && !latexSelectModal.hidden) { closeLatexSelectModal(); return; }
      const timeoutDialog = document.getElementById('guide-timeout-dialog');
      if (timeoutDialog && !timeoutDialog.hidden) { timeoutDialog.hidden = true; return; }
    });

    // History search + clear button
    document.getElementById('history-search')?.addEventListener('input', onHistorySearch);
    document.getElementById('history-search-clear')?.addEventListener('click', () => {
      const input = document.getElementById('history-search');
      if (input) { input.value = ''; onHistorySearch(); }
    });

    window.addEventListener('message', onContentMessage);

    // Keep --qa-footer-h CSS var in sync so the reply-ready toast always
    // floats precisely above the footer regardless of footer height changes.
    const _footerStack = document.querySelector('.qa-footer-stack');
    if (_footerStack) {
      const _updateFooterH = () => {
        const h = _footerStack.getBoundingClientRect().height;
        if (h > 0) document.documentElement.style.setProperty('--qa-footer-h', `${h}px`);
      };
      _updateFooterH();
      if (window.ResizeObserver) {
        new ResizeObserver(_updateFooterH).observe(_footerStack);
      }
    }

    updateThinkingHint();

    setStatus('loading', 'Waiting for video page…');
  }

  function normalizeLectureUrl(href) {
    if (!href) return '';
    try {
      const u = new URL(href);
      u.hash = '';
      const path = u.pathname.replace(/\/+$/, '') || '/';
      return `${u.origin}${path}${u.search}`;
    } catch {
      return String(href).trim().split('#')[0]?.replace(/\/+$/, '') || '';
    }
  }

  // ─── Safe storage write with quota / lastError handling ──────────────────
  function storageSet(data, callback) {
    if (!chrome?.storage?.local) { callback?.(); return; }
    chrome.storage.local.set(data, () => {
      if (chrome.runtime.lastError) {
        const msg = chrome.runtime.lastError.message || '';
        if (msg.includes('QUOTA_BYTES') || msg.includes('quota')) {
          console.warn('[Copilot] Storage quota exceeded — oldest Q&A pruned.', msg);
          // Prune the oldest 5 history entries and retry once
          chrome.storage.local.get(['guideHistory'], res => {
            const h = Array.isArray(res.guideHistory) ? res.guideHistory : [];
            if (h.length > 5) {
              const pruned = h.slice(0, h.length - 5);
              chrome.storage.local.set({ guideHistory: pruned }, () => {
                chrome.storage.local.set(data, () => {
                  if (chrome.runtime.lastError) {
                    console.error('[Copilot] Storage write failed after pruning:', chrome.runtime.lastError.message);
                  }
                  callback?.();
                });
              });
            } else {
              console.error('[Copilot] Storage quota exceeded and history too small to prune:', msg);
              callback?.();
            }
          });
        } else {
          console.error('[Copilot] Storage write error:', msg);
          callback?.();
        }
      } else {
        callback?.();
      }
    });
  }

  function pickLatestHistoryForUrl(history, lectureUrl) {
    const want = normalizeLectureUrl(lectureUrl);
    const matches = (history || []).filter(
      h => h?.guide?.guide?.length && normalizeLectureUrl(h.lectureUrl) === want
    );
    if (!matches.length) return null;
    matches.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    return matches[0];
  }

  function applyRestoredGuide(guideData, qaFromStorage, persistSession) {
    guide = guideData;
    sanitizeGuide(guide);
    qaMessages = Array.isArray(qaFromStorage) ? qaFromStorage : [];
    if (persistSession && currentLectureUrl) {
      storageSet({
        currentGuide: guide,
        currentLectureUrl: currentLectureUrl,
        currentQaMessages: qaMessages
      });
    }
    setStatus('ready', `Guide ready · ${guide.guide.length} blocks`);
    showGuideContent();
    qaMessages_el.innerHTML = '';
    hideQaReplyReadyToast();
    if (qaMessages.length) {
      restoreChatUI();
    } else {
      qaMessages_el.innerHTML = '<div class="qa-welcome"><p>Ask anything about this lecture. I have the full transcript and guide as context.</p></div>';
    }
    updateGenerateButton();
  }

  function tryRestoreFromCache(lectureUrl) {
    if (!lectureUrl) return;
    currentLectureUrl = lectureUrl;
    initScriptsForCourse(lectureUrl);
    const normNew = normalizeLectureUrl(lectureUrl);

    // Load custom prompt extras (non-blocking, best-effort)
    chrome.storage?.local?.get(['customPromptExtras'], (r) => {
      if (r.customPromptExtras && typeof r.customPromptExtras === 'object') {
        customPromptExtras = { ...customPromptExtras, ...r.customPromptExtras };
      }
    });

    chrome.storage?.local?.get(
      ['currentGuide', 'currentTranscript', 'currentLectureUrl', 'currentQaMessages', 'guideHistory'],
      saved => {
        const hist = Array.isArray(saved.guideHistory) ? saved.guideHistory : [];
        const normSaved = saved.currentLectureUrl ? normalizeLectureUrl(saved.currentLectureUrl) : '';
        const sessionMatches = normSaved === normNew;

        if (!sessionMatches) {
          chrome.storage?.local?.remove(['currentGuide', 'currentTranscript', 'currentLectureUrl', 'currentQaMessages']);
          resetGuideUI();
          setStatus('loading', 'New lecture detected — waiting for transcript…');
        }

        let restoredGuide = false;

        if (sessionMatches && saved.currentGuide?.guide?.length) {
          applyRestoredGuide(saved.currentGuide, saved.currentQaMessages, false);
          restoredGuide = true;
        } else {
          const latest = pickLatestHistoryForUrl(hist, lectureUrl);
          if (latest?.guide?.guide?.length) {
            applyRestoredGuide(latest.guide, latest.qaMessages, true);
            restoredGuide = true;
          }
        }

        if (sessionMatches && saved.currentTranscript) {
          const tUrl = saved.currentTranscript.lectureUrl;
          if (!tUrl || normalizeLectureUrl(tUrl) === normNew) {
            transcript = saved.currentTranscript;
            updateGenerateButton();
            if (restoredGuide) {
              const n = saved.currentTranscript.cues?.length;
              const cueStr = n != null ? ` · ${n} cues` : '';
              setStatus('ready', `Guide ready · ${guide.guide.length} blocks${cueStr}`);
            }
          }
        }
      }
    );
  }

  function resetGuideUI() {
    guide = null;
    transcript = null;
    currentBlockIndex = -1;
    qaMessages = [];
    isGenerating = false;
    guideContent.style.display = 'none';
    guideEmpty.style.display = '';
    generateError.style.display = 'none';
    generateBtn.disabled = true;
    generateBtn.querySelector('.btn-text').textContent = 'Generate Guide';
    generateBtn.querySelector('.btn-spinner').style.display = 'none';
    qaMessages_el.innerHTML = '<div class="qa-welcome"><p>Ask anything about this lecture. I have the full transcript and guide as context.</p></div>';
    hideQaReplyReadyToast();
    const manualSection = document.getElementById('manual-paste-section');
    if (manualSection) manualSection.remove();
  }

  function restoreChatUI() {
    hideQaReplyReadyToast();
    const welcome = qaMessages_el.querySelector('.qa-welcome');
    if (welcome) welcome.remove();
    for (const m of qaMessages) {
      appendChatMsg(m.role, m.content, m.imageBase64 || false, 'none');
    }
    qaMessages_el.scrollTop = qaMessages_el.scrollHeight;
  }

  /**
   * Thinking option behavior matches background.js: Anthropic extended thinking,
   * Gemini thinking budget, OpenAI-compat only o-series gets reasoning_effort.
   */
  function buildThinkingTooltipText() {
    const levels =
      'None = fastest, cheapest (no extra reasoning).\n' +
      'Low / Medium / High = extra reasoning step when your provider and model support it (slower, more tokens).\n\n';

    if (!settings?.provider) {
      return (
        levels +
        'Pick a provider and model in Options (cog). This tooltip updates to show whether thinking applies to your setup.'
      );
    }

    const model = String(settings.model || '').trim() || '(no model selected)';
    const prov = String(settings.provider);
    const isLocal = prov.startsWith('local_');
    const isOSeries = /^o[0-9]/.test(model);

    if (prov === 'anthropic') {
      return (
        levels +
        'Your setup: Anthropic.\n' +
        'Low/Medium/High sends extended thinking (token budget) to the API. It works on Claude models that support extended thinking (e.g. Sonnet 4, Opus). If you get an error, set Thinking to None or choose another model in Options.'
      );
    }

    if (prov === 'google') {
      return (
        levels +
        'Your setup: Google Gemini.\n' +
        'None now explicitly requests off/minimal thinking where Google allows it. Gemini 2.5 Flash can disable thinking with budget 0; Gemini 2.5 Pro and Gemini 3.1 Pro cannot fully disable thinking, so None uses the smallest/lowest setting. Low/Medium/High sends the provider thinking controls.'
      );
    }

    if (isLocal && /(^|\/)gemini-/.test(model.toLowerCase())) {
      return (
        levels +
        'Your setup: local/proxy Gemini model.\n' +
        'For LiteLLM, None sends a low/off reasoning hint so Gemini does not fall back to its native dynamic-thinking default. Gemini 3 models still cannot fully disable thinking.'
      );
    }

    if (isOSeries) {
      return (
        levels +
        'Your setup: OpenAI-compatible API with an o-series model (' +
        model +
        ').\n' +
        'Low/Medium/High is sent as reasoning effort — this should work. If the server rejects it, try None or a different model.'
      );
    }

    const apiLabel = isLocal ? 'your local endpoint' : 'this API';
    return (
      levels +
      'Your setup: OpenAI-compatible (' +
      prov +
      '), model: “' +
      model +
      '”.\n' +
      'The extension only sends thinking for models whose id starts with “o” + a digit (e.g. o1, o3-mini). Your current model does not match — Low/Medium/High are not sent; only temperature is used. Generation still works; you just do not get extra reasoning from this control.\n' +
      'To use reasoning: pick an o-series model in Options (if ' +
      apiLabel +
      ' offers one), or leave Thinking on None.'
    );
  }

  function updateThinkingHint() {
    const text = buildThinkingTooltipText();
    genThinkingHint?.setAttribute('data-tip', text);
    qaThinkingHint?.setAttribute('data-tip', text);
  }

  // ─── Message Handling ─────────────────────────────────────────────────────

  function onContentMessage(e) {
    // Only accept messages from video.ethz.ch — reject any other origin.
    if (e.origin !== 'https://video.ethz.ch') return;
    const msg = e.data;
    if (!msg?.type) return;

    switch (msg.type) {

      case 'EXTENSION_READY':
        setStatus('loading', 'Detecting transcript…');
        tryRestoreFromCache(msg.lectureUrl);
        break;

      case 'SETTINGS':
        settings = msg.settings;
        updateGenerateButton();
        updateThinkingHint();
        updateTokenHint();
        break;

      case 'TRANSCRIPT_STATUS':
        handleTranscriptStatus(msg);
        break;

      case 'TRANSCRIPT_READY':
        handleTranscriptReady(msg);
        break;

      case 'TRANSCRIPT_DATE_UPDATE':
        if (transcript && msg.lectureDate && !transcript.lectureDate) {
          transcript.lectureDate = msg.lectureDate;
          storageSet({ currentTranscript: transcript });
          // Patch the stored history entry for this lecture if it has no date yet
          if (currentLectureUrl) {
            const norm = normalizeLectureUrl(currentLectureUrl);
            chrome.storage?.local?.get(['guideHistory'], saved => {
              const history = Array.isArray(saved.guideHistory) ? saved.guideHistory : [];
              let patched = false;
              for (const e of history) {
                if (normalizeLectureUrl(e.lectureUrl) === norm && !e.lectureDate) {
                  e.lectureDate = msg.lectureDate;
                  patched = true;
                }
              }
              if (patched) storageSet({ guideHistory: history });
            });
          }
        }
        break;

      case 'TIMESTAMP_UPDATE':
        handleTimestamp(msg.currentTime);
        break;

      case 'FOCUS_MODE_CHANGED':
        if (focusToggle) {
          focusToggle.classList.toggle('active-toggle', !!msg.active);
          focusToggle.title = msg.active
            ? 'Exit focus mode'
            : 'Focus mode — video + sidebar only';
        }
        break;

      case 'FRAME_CAPTURED':
        if (pendingRequests[msg.requestId]) {
          pendingRequests[msg.requestId](msg.imageBase64);
          delete pendingRequests[msg.requestId];
        }
        break;

      case 'SPEED_UPDATED':
        showSidebarSpeedOverlay(msg.rate);
        break;

      case 'API_RESPONSE':
        if (pendingRequests[msg.requestId]) {
          pendingRequests[msg.requestId](msg.response);
          delete pendingRequests[msg.requestId];
        }
        break;

      case 'API_PROGRESS':
        handleApiProgress(msg);
        break;

      case 'API_STREAM_CHUNK':
        handleStreamChunk(msg);
        break;
    }
  }

  function postToContent(msg) {
    msg._copilot = true;
    // Target only video.ethz.ch — prevents message leakage to other origins.
    window.parent.postMessage(msg, 'https://video.ethz.ch');
  }

  function makeRequestId() {
    return 'req_' + (++requestIdCounter);
  }

  function apiRequest(payload) {
    const id = makeRequestId();
    const promise = new Promise((resolve, reject) => {
      const isGuideRequest = payload?.type === 'GENERATE_GUIDE';
      let settled = false;
      let timeoutTimer = null;
      let guideWarnTimer = null;
      let closeTimeoutDialog = null;

      const cleanup = () => {
        settled = true;
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (guideWarnTimer) clearTimeout(guideWarnTimer);
        if (closeTimeoutDialog) closeTimeoutDialog();
      };

      if (isGuideRequest) {
        activeGuideRequestId = id;
        // Inform the user this is now server/provider-side work and can take a while.
        setStatus('loading', 'Generating guide… Request sent from extension backend.');
        guideWarnTimer = setTimeout(() => {
          if (settled) return;
          closeTimeoutDialog = showGuideTimeoutDialog({
            onRetry: () => {
              if (settled) return;
              delete pendingRequests[id];
              if (activeGuideRequestId === id) activeGuideRequestId = null;
              cleanup();
              reject(new Error('Retry requested by user.'));
            },
            onKeepGoing: () => {
              if (settled) return;
              setStatus('loading', 'Guide generation still running on provider…');
            }
          });
        }, 180000);
      } else {
        timeoutTimer = setTimeout(() => {
          if (settled) return;
          delete pendingRequests[id];
          if (activeGuideRequestId === id) activeGuideRequestId = null;
          cleanup();
          reject(new Error('Request timed out. Please try again or switch model/provider.'));
        }, 120000);
      }

      pendingRequests[id] = resolve;
      const originalResolve = pendingRequests[id];
      pendingRequests[id] = (data) => {
        cleanup();
        if (isGuideRequest && activeGuideRequestId === id) activeGuideRequestId = null;
        originalResolve(data);
      };
      postToContent({ type: 'API_REQUEST', requestId: id, payload });
    });
    // Expose the requestId on the promise so callers that need streaming context can read it
    promise._requestId = id;
    return promise;
  }

  function handleApiProgress(msg) {
    if (!isGenerating) return;
    if (!msg?.requestId || msg.requestId !== activeGuideRequestId) return;
    switch (msg.stage) {
      case 'queued':
        setStatus('loading', 'Guide request queued in extension backend…');
        break;
      case 'request_sent':
        setStatus('loading', 'Request sent to API provider. Waiting for provider response…');
        break;
      case 'provider_responding':
        setStatus('loading', 'Provider started responding… receiving guide data.');
        break;
      case 'provider_finished':
        setStatus('loading', 'Provider response received. Parsing guide…');
        break;
    }
  }

  /**
   * Parse complete block objects from a partial guide JSON string.
   * Looks for "guide":[ and extracts fully balanced {...} objects one by one.
   */
  function extractStreamedBlocks(jsonStr) {
    const guideMatch = /"guide"\s*:\s*\[/.exec(jsonStr);
    if (!guideMatch) return [];

    const blocks = [];
    let i = guideMatch.index + guideMatch[0].length;

    while (i < jsonStr.length) {
      // Skip whitespace and commas between objects
      while (i < jsonStr.length && /[\s,]/.test(jsonStr[i])) i++;
      if (i >= jsonStr.length || jsonStr[i] !== '{') break;

      let depth = 0;
      let inStr = false;
      let esc = false;
      const objStart = i;

      while (i < jsonStr.length) {
        const ch = jsonStr[i];
        if (esc) { esc = false; i++; continue; }
        if (ch === '\\' && inStr) { esc = true; i++; continue; }
        if (ch === '"') { inStr = !inStr; i++; continue; }
        if (inStr) { i++; continue; }
        if (ch === '{') { depth++; i++; continue; }
        if (ch === '}') {
          depth--;
          i++;
          if (depth === 0) {
            try { blocks.push(JSON.parse(jsonStr.slice(objStart, i))); } catch (_) {}
            break;
          }
          continue;
        }
        i++;
      }

      if (depth > 0) break; // Incomplete block — stop here
    }

    return blocks;
  }

  function handleStreamChunk(msg) {
    const reqId = msg?.requestId;
    if (!reqId) return;

    // Route to QA stream handler first (isChatting is still true during stream)
    if (isQaStreaming && reqId === activeQaRequestId) {
      handleQaStreamChunk(msg);
      return;
    }

    if (!isGenerating) return;
    if (reqId !== activeGuideRequestId) return;
    streamBuffer += msg.text || '';

    const blocks = extractStreamedBlocks(streamBuffer);
    const blockCount = blocks.length;
    const prevCount  = guide?.guide?.length ?? 0;

    // Progressive rendering: update guide as new complete blocks arrive
    if (blockCount > prevCount) {
      if (!guide) guide = { guide: [], lecture_title: '', total_duration_seconds: 0 };
      guide.guide = blocks;

      if (prevCount === 0) {
        // First block: transition from empty to guide view + do the initial full render
        guideEmpty.style.display = 'none';
        guideContent.style.display = 'flex';
        currentBlockIndex = 0;
        renderBlock(0);
      } else {
        // More blocks arrived — current block content hasn't changed, so only update
        // the counter and progress bar.  Calling renderBlock() here causes the block
        // to flash/animate on every incoming chunk, which looks terrible.
        updateGuideStreamCounter(blockCount);
      }
    }

    // Show / update streaming status bar
    const kbReceived = Math.round(streamBuffer.length / 1024);
    if (blockCount > 0) {
      setStatus('loading', `Streaming guide… ${blockCount} block${blockCount !== 1 ? 's' : ''} received`);
    } else {
      setStatus('loading', kbReceived > 0
        ? `Streaming guide… ${kbReceived} KB received`
        : 'Streaming guide…'
      );
    }

    // Show streaming indicator bar (inserted right before guide-block so toolbar stays usable)
    if (!document.getElementById('guide-streaming-bar')) {
      const bar = document.createElement('div');
      bar.id = 'guide-streaming-bar';
      bar.className = 'guide-streaming-bar';
      bar.innerHTML = '<div class="guide-streaming-pulse"></div><span id="guide-streaming-text"></span>';
      const guideBlockEl = document.getElementById('guide-block');
      if (guideBlockEl) guideBlockEl.before(bar);
      else guideContent.appendChild(bar);
    }

    const streamText = document.getElementById('guide-streaming-text');
    if (streamText) {
      streamText.textContent = blockCount > 0
        ? `Streaming… ${blockCount} block${blockCount !== 1 ? 's' : ''} received — more incoming`
        : `Receiving guide from AI…${kbReceived > 0 ? ` (${kbReceived} KB)` : ''}`;
    }
  }

  function clearStreamingBar() {
    const bar = document.getElementById('guide-streaming-bar');
    if (bar) bar.remove();
    streamBuffer = '';
  }

  /** Update only the block counter and progress bar during streaming.
   *  Does NOT touch guideBlock.innerHTML — avoids the per-chunk flash/animation. */
  function updateGuideStreamCounter(totalBlocks) {
    const idx = currentBlockIndex;
    if (blockJumpInput) blockJumpInput.max = String(totalBlocks);
    if (blockCounter) blockCounter.textContent = totalBlocks;
    const pct = Math.round(((idx + 1) / totalBlocks) * 100);
    if (progressFill) {
      progressFill.style.width = `${pct}%`;
      progressFill.parentElement?.setAttribute('aria-valuenow', String(pct));
    }
  }

  // ─── Q&A stream chunk handler ─────────────────────────────────────────────
  // One DOM write per animation frame (≤60 fps) for smooth text appearance.
  // KaTeX is intentionally NOT applied during streaming — re-rendering LaTeX on
  // every chunk causes a visible flicker (rendered → raw → rendered → raw…).
  // KaTeX runs exactly once when the stream completes (see sendQaMessage).

  function handleQaStreamChunk(msg) {
    qaStreamBuffer += msg.text || '';
    if (!qaStreamBubble) return;
    // Gate DOM writes to one per animation frame — prevents layout thrashing
    if (!qaRafPending) {
      qaRafPending = true;
      requestAnimationFrame(flushQaStream);
    }
  }

  /**
   * Two-layer streaming renderer.
   *
   *  Layer A — .qa-katex-zone (a single <div> at the top of the bubble)
   *    Contains text up to the end of the last COMPLETE $$...$$ block.
   *    Set via element.textContent so the raw $$ delimiters survive inside one
   *    text node (critical — renderMathInElement only scans within a text node;
   *    splitting on \n into separate nodes would break multi-line equations).
   *    KaTeX is applied once per newly-closed block and never re-runs.
   *
   *  Layer B — appended .qa-chunk <span> nodes
   *    Contains text AFTER the last complete math block (the live tail).
   *    Each rAF frame we APPEND only the new characters as fresh spans that
   *    fade in via CSS.  Nothing is ever replaced, so old text stays stable.
   *
   *  On stream completion both layers are replaced by a full markdown+KaTeX
   *  render with a smooth opacity crossfade.
   */
  function flushQaStream() {
    qaRafPending = false;
    if (!qaStreamBubble) return;

    const buf    = qaStreamBuffer;
    const cursor = qaStreamBubble.querySelector('.qa-stream-cursor');
    const katexZ = qaStreamBubble.querySelector('.qa-katex-zone');

    // ── Layer A: detect newly-closed $$...$$ blocks ──────────────────────────
    let katexCutoff = qaStreamKatexEnd;
    let i = katexCutoff;
    while (i < buf.length - 1) {
      if (buf[i] === '$' && buf[i + 1] === '$') {
        const closeIdx = buf.indexOf('$$', i + 2);
        if (closeIdx !== -1) {
          katexCutoff = closeIdx + 2;
          i = closeIdx + 2;
        } else {
          break; // block still open — leave for later
        }
      } else {
        i++;
      }
    }

    if (katexCutoff > qaStreamKatexEnd && katexZ) {
      // New complete math block(s) found.
      // Set the zone's textContent so the $$ delimiters live in a SINGLE text
      // node — renderMathInElement can then find multi-line equations.
      katexZ.textContent = buf.slice(0, katexCutoff);
      if (typeof renderMathInElement === 'function') {
        renderMathInElement(katexZ, {
          delimiters: [
            { left: '$$', right: '$$', display: true },
            { left: '$',  right: '$',  display: false }
          ],
          throwOnError: false,
          trust: false
        });
      }
      qaStreamKatexEnd = katexCutoff;

      // Remove all existing plain spans/brs (now covered by the katex zone).
      Array.from(qaStreamBubble.childNodes).forEach(node => {
        if (node !== katexZ && node !== cursor) node.remove();
      });
      // Plain-span pointer resets to the katex cutoff.
      qaStreamStableEnd = katexCutoff;
    }

    // ── Layer B: append the live tail as fading plain-text spans ─────────────
    const newText = buf.slice(qaStreamStableEnd);
    if (newText) {
      newText.split('\n').forEach((line, idx) => {
        if (idx > 0) {
          const br = document.createElement('br');
          cursor ? qaStreamBubble.insertBefore(br, cursor) : qaStreamBubble.appendChild(br);
        }
        if (line.length > 0) {
          const span = document.createElement('span');
          span.className = 'qa-chunk';
          span.innerHTML = applyStreamingLineMarkdown(line);
          cursor ? qaStreamBubble.insertBefore(span, cursor) : qaStreamBubble.appendChild(span);
        }
      });
      qaStreamStableEnd = buf.length;
    }
  }

  // runQaStreamKatex kept as no-op shim so any stale references don't crash
  function runQaStreamKatex() {}

  /** Apply KaTeX to an element — shared helper used by streaming, flashcards, etc. */
  function applyKatex(el) {
    if (!el || typeof renderMathInElement !== 'function') return;
    renderMathInElement(el, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '$',  right: '$',  display: false }
      ],
      throwOnError: false,
      trust: false
    });
  }

  function showGuideTimeoutDialog({ onRetry, onKeepGoing }) {
    const existing = document.getElementById('guide-timeout-dialog');
    if (existing) existing.remove();

    const dialog = document.createElement('div');
    dialog.id = 'guide-timeout-dialog';
    dialog.className = 'guide-timeout-dialog';
    dialog.innerHTML = `
      <div class="guide-timeout-title">Possible timeout detected</div>
      <div class="guide-timeout-text">
        Guide generation ongoing for 180s. Do you want to retry or keep going?
        Depending on block detail, block count, and API provider, it might take longer.
      </div>
      <div class="guide-timeout-actions">
        <button id="guide-timeout-retry" class="primary-btn">Retry</button>
        <button id="guide-timeout-keep" class="primary-btn">Keep going</button>
      </div>
    `;
    document.body.appendChild(dialog);

    const close = () => {
      if (dialog.parentNode) dialog.parentNode.removeChild(dialog);
    };

    dialog.querySelector('#guide-timeout-retry')?.addEventListener('click', () => {
      close();
      onRetry?.();
    });
    dialog.querySelector('#guide-timeout-keep')?.addEventListener('click', () => {
      close();
      onKeepGoing?.();
    });

    return close;
  }

  function captureFrame() {
    return new Promise((resolve) => {
      const id = makeRequestId();
      console.log('[Copilot] captureFrame: sending CAPTURE_FRAME', id);
      const timer = setTimeout(() => {
        console.warn('[Copilot] captureFrame: timed out waiting for FRAME_CAPTURED', id);
        delete pendingRequests[id];
        resolve(null);
      }, 8000);
      pendingRequests[id] = (result) => {
        clearTimeout(timer);
        console.log('[Copilot] captureFrame: got result', id, result ? 'b64 length=' + result.length : 'null');
        resolve(result);
      };
      postToContent({ type: 'CAPTURE_FRAME', requestId: id });
    });
  }

  // ─── Image strip helpers ──────────────────────────────────────────────────

  function renderImageStrip() {
    if (!qaImageStrip) return;
    if (!attachedImages.length) {
      qaImageStrip.style.display = 'none';
      qaImageStrip.innerHTML = '';
      return;
    }
    qaImageStrip.style.display = 'flex';
    qaImageStrip.innerHTML = attachedImages.map((img, i) => `
      <div class="qa-image-thumb" data-strip-index="${i}" title="Click to preview">
        <img src="${img.dataUrl}" alt="${img.label}">
        <button class="qa-image-remove" data-strip-index="${i}" type="button" title="Remove" aria-label="Remove image">×</button>
        <span class="qa-image-label">${img.label}</span>
      </div>
    `).join('');

    // Remove buttons
    qaImageStrip.querySelectorAll('.qa-image-remove').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.stripIndex, 10);
        attachedImages.splice(idx, 1);
        renderImageStrip();
      });
    });

    // Click thumbnail to fullscreen preview
    qaImageStrip.querySelectorAll('.qa-image-thumb').forEach(thumb => {
      thumb.addEventListener('click', e => {
        if (e.target.classList.contains('qa-image-remove')) return;
        const idx = parseInt(thumb.dataset.stripIndex, 10);
        openFrameLightbox(attachedImages[idx].dataUrl);
      });
    });
  }

  function processImageFile(file) {
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = e => {
      const original = e.target.result;
      // Compress: cap longest side at 1280px, re-encode as JPEG
      const img = new Image();
      img.onload = () => {
        const MAX = 1280;
        let { width: w, height: h } = img;
        if (w > MAX || h > MAX) {
          if (w > h) { h = Math.round(h * MAX / w); w = MAX; }
          else       { w = Math.round(w * MAX / h); h = MAX; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        attachedImages.push({ dataUrl: canvas.toDataURL('image/jpeg', 0.82), label: 'Image' });
        renderImageStrip();
      };
      img.src = original;
    };
    reader.readAsDataURL(file);
  }

  // ─── Transcript Handling ──────────────────────────────────────────────────

  function handleTranscriptStatus(msg) {
    switch (msg.status) {
      case 'extracting':
        setStatus('loading', 'Extracting transcript…');
        break;
      case 'no_event_id':
        setStatus('warning', 'No event ID found — paste transcript manually');
        showManualPasteOption();
        break;
      case 'no_captions':
        setStatus('warning', 'No captions found for this lecture');
        showManualPasteOption();
        break;
      case 'error':
        setStatus('error', 'Transcript error: ' + (msg.error || 'unknown'));
        showManualPasteOption();
        break;
    }
  }

  function handleTranscriptReady(msg) {
    if (msg.lectureUrl) currentLectureUrl = msg.lectureUrl;
    transcript = {
      cues:          msg.cues,
      text:          msg.transcriptText,
      lectureTitle:  msg.lectureTitle,
      lectureUrl:    msg.lectureUrl || currentLectureUrl,
      videoDuration: msg.videoDuration,
      lectureDate:   msg.lectureDate  || null,
      courseKey:     msg.courseKey    || null,
      courseName:    msg.courseName   || null,
    };
    storageSet({
      currentTranscript: transcript,
      currentLectureUrl: currentLectureUrl
    });
    if (currentLectureUrl && !scriptCourseId) {
      initScriptsForCourse(currentLectureUrl);
    }
    if (guide?.guide?.length) {
      setStatus('ready', `Guide ready · ${guide.guide.length} blocks · ${msg.cues.length} cues`);
    } else {
      setStatus('ready', `Transcript loaded · ${msg.cues.length} cues`);
    }
    updateGenerateButton();
  }

  function showManualPasteOption() {
    const existing = document.getElementById('manual-paste-section');
    if (existing) return;

    const section = document.createElement('div');
    section.id = 'manual-paste-section';
    section.style.cssText = 'padding: 12px 14px; border-top: 1px solid var(--border); position: relative;';
    section.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
        <p class="section-label" style="margin:0;">Manual Transcript</p>
        <button id="close-manual-btn" style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:16px;line-height:1;padding:2px 4px;" title="Close">&times;</button>
      </div>
      <textarea id="manual-transcript" placeholder="Paste transcript here (plain text with optional [HH:MM:SS] timestamps)…"
        style="width:100%;height:120px;resize:vertical;background:var(--bg-2);border:1px solid var(--border);
               border-radius:8px;color:var(--text-primary);font-size:12px;padding:8px;outline:none;font-family:inherit;"></textarea>
      <button id="use-manual-btn" class="primary-btn" style="margin-top: 8px; font-size:12px; padding:7px 14px;">
        Use this transcript
      </button>
    `;
    document.getElementById('tab-guide').insertBefore(section, guideEmpty);

    document.getElementById('close-manual-btn').addEventListener('click', () => {
      section.remove();
    });

    document.getElementById('use-manual-btn').addEventListener('click', () => {
      const text = document.getElementById('manual-transcript').value.trim();
      if (!text) return;
      transcript = {
        cues: [],
        text,
        lectureTitle: document.title || 'Lecture',
        lectureUrl: currentLectureUrl,
        videoDuration: 0
      };
      section.remove();
      setStatus('ready', 'Manual transcript loaded');
      updateGenerateButton();
    });
  }

  // ─── Guide Generation ─────────────────────────────────────────────────────

  function updateGenerateButton() {
    const hasTranscript = transcript && transcript.text;
    const hasSettings = hasUsableSettings();
    generateBtn.disabled = !hasTranscript || !hasSettings || isGenerating;

    if (!hasSettings) {
      generateBtn.title = 'Set your API key in the extension popup first';
    }
  }

  async function onGenerateClick() {
    if (isGenerating || !transcript || !hasUsableSettings()) return;
    isGenerating = true;

    // Reset streaming state so incremental rendering starts fresh
    streamBuffer = '';
    clearStreamingBar();
    // If a previous partial/streamed guide exists, clear it so the new stream starts from block 0
    if (guide && guide.guide) guide.guide = [];

    generateBtn.disabled = true;
    generateBtn.querySelector('.btn-text').textContent = 'Generating…';
    generateBtn.querySelector('.btn-spinner').style.display = 'inline-block';
    generateError.style.display = 'none';
    setStatus('loading', 'Generating guide…');

    const useFallback = !!genFallbackCb?.checked;
    const guideTemperature = useFallback ? null : (genTempSlider ? genTempSlider.value / 100 : null);
    const guideThinking = useFallback ? 'none' : (genThinkingSel?.value || 'none');
    const guideDetail = genDetailSel?.value || 'very_high';
    const guideCount = genCountSel?.value || 'very_high';
    const maxTokens = selectedGuideMaxTokens(guideDetail, guideCount, settings.provider, settings.model);

    const guideLang = getSelectedLanguage();
    const systemPrompt = buildGuidePrompt(guideDetail, guideCount, guideLang);
    // All providers support SSE streaming:
    //   - OAI-compat / local (LiteLLM, Ollama, etc.) → callOAICompatStream
    //   - Anthropic → callAnthropicStream
    //   - Google → callGoogleStream
    const supportsStream = !!settings.provider;

    streamBuffer = '';
    const payload = {
      type: 'GENERATE_GUIDE',
      transcriptText: transcript.text,
      systemPrompt,
      provider: settings.provider,
      model: settings.model || null,
      apiKey: settings.apiKey,
      localBase: getLocalBase(),
      guideFallback: useFallback,
      guideTemperature,
      guideThinking,
      guideMaxTokens: maxTokens,
      useStream: supportsStream && !useFallback
    };

    console.log('[Copilot] Sending GENERATE_GUIDE', {
      provider: payload.provider,
      model: payload.model,
      transcriptLen: payload.transcriptText?.length,
      hasApiKey: !!payload.apiKey,
      localBase: payload.localBase || '(none)',
      fallback: useFallback,
      temperature: guideTemperature,
      thinking: guideThinking
    });

    try {
      const response = await apiRequest(payload);
      console.log('[Copilot] GENERATE_GUIDE response received', { success: response.success });

      if (!response.success) throw new Error(response.error);

      clearStreamingBar();
      guide = response.data;
      guide = sanitizeGuide(guide);

      storageSet({ currentGuide: guide, currentLectureUrl: currentLectureUrl });
      saveToHistory();

      setStatus('ready', `Guide ready · ${guide.guide.length} blocks`);
      showGuideContent();
      const mp = document.getElementById('manual-paste-section');
      if (mp) mp.remove();

    } catch (err) {
      console.error('[Copilot] GENERATE_GUIDE error:', err.message);
      clearStreamingBar();
      showGuideError(err.message);
      setStatus('error', 'Guide generation failed');
      showManualPasteOption();
    } finally {
      isGenerating = false;
      generateBtn.querySelector('.btn-text').textContent = 'Generate Guide';
      generateBtn.querySelector('.btn-spinner').style.display = 'none';
      updateGenerateButton();
    }
  }

  let _regenConfirmTimer = null;

  function onRegenerateClick() {
    showRegenerateConfirmToast();
  }

  function hideRegenerateConfirmToast() {
    clearTimeout(_regenConfirmTimer);
    document.getElementById('regen-confirm-toast')?.remove();
    regenerateBtn.title = 'Generate a new guide';
  }

  function showRegenerateConfirmToast() {
    hideRegenerateConfirmToast();
    regenerateBtn.title = 'Confirm regenerate guide';

    const toast = document.createElement('div');
    toast.id = 'regen-confirm-toast';
    toast.className = 'regen-confirm-toast';
    toast.setAttribute('role', 'alertdialog');
    toast.setAttribute('aria-live', 'polite');
    toast.innerHTML = `
      <div class="regen-confirm-text">
        <strong>Regenerate guide?</strong>
        This clears the current guide and Q&amp;A for this lecture.
      </div>
      <div class="regen-confirm-actions">
        <button type="button" class="regen-confirm-cancel">Cancel</button>
        <button type="button" class="regen-confirm-action">Regenerate</button>
      </div>
    `;
    document.body.appendChild(toast);

    toast.querySelector('.regen-confirm-cancel')?.addEventListener('click', hideRegenerateConfirmToast);
    toast.querySelector('.regen-confirm-action')?.addEventListener('click', confirmRegenerateGuide);

    _regenConfirmTimer = setTimeout(hideRegenerateConfirmToast, 8000);
  }

  function confirmRegenerateGuide() {
    hideRegenerateConfirmToast();
    guide = null;
    currentBlockIndex = -1;
    qaMessages = [];
    guideContent.style.display = 'none';
    guideEmpty.style.display = '';
    generateError.style.display = 'none';
    chrome.storage?.local?.remove(['currentGuide', 'currentQaMessages']);
    qaMessages_el.innerHTML = '<div class="qa-welcome"><p>Ask anything about this lecture. I have the full transcript and guide as context.</p></div>';
    hideQaReplyReadyToast();
    const manualSection = document.getElementById('manual-paste-section');
    if (manualSection) manualSection.remove();

    updateGenerateButton();
    if (transcript?.text) {
      setStatus('ready', `Transcript loaded · ready to generate`);
    } else {
      setStatus('loading', 'Waiting for transcript…');
    }
  }

  // ─── Guide Profile Definitions ──────────────────────────────────────────

  const GUIDE_DETAIL_PROFILES = {
    low: {
      label: 'Low',
      concepts: '1–2 brief sentences per bullet — just the core fact, no elaboration.',
      formulas: 'Only include the most important formulas (skip minor or intermediate steps). LaTeX must be valid KaTeX, no dollar-sign delimiters.',
      definitions: '1 sentence per definition — term and its meaning, nothing more.',
      notes: 'Only include explicit exam hints or professor warnings. Leave empty otherwise.'
    },
    medium: {
      label: 'Medium',
      concepts: '2–3 solid sentences per bullet. State the idea, give brief intuition or a short example.',
      formulas: 'Include main formulas and key theorems. Skip intermediate derivation steps unless they are a main teaching point. LaTeX must be valid KaTeX, no dollar-sign delimiters.',
      definitions: '1–2 sentences — term, meaning, and one condition/caveat if relevant.',
      notes: 'Professor warnings, exam hints, and notable connections. Keep concise.'
    },
    high: {
      label: 'High',
      concepts: '3–5 sentences per bullet. Explain the idea, the intuition, why it matters, and give at least one concrete example or comparison from the lecture.',
      formulas: 'Capture all formulas, theorems, and key equations. Include derivation steps when the professor works through them. LaTeX must be valid KaTeX, no dollar-sign delimiters.',
      definitions: '2–3 sentences — term, formal definition, conditions/domain, and one caveat or remark.',
      notes: 'Professor warnings, exam hints, common mistakes, connections to other topics. Be thorough.'
    },
    very_high: {
      label: 'Very High',
      concepts: '4–8 detailed sentences per bullet. Explain the idea, the intuition behind it, why it matters, and how it connects to the rest of the lecture. Write them so a student who missed class can follow along. Include concrete examples the professor gave, comparisons, and step-by-step reasoning.',
      formulas: 'Capture EVERY formula, theorem, equation, inequality, and key expression. Include intermediate derivation steps when the professor works through them. LaTeX must be valid KaTeX, no dollar-sign delimiters.',
      definitions: 'Formally defined terms WITH full context — include the conditions, domain, and any caveats the professor mentions. Write 2–4 sentences per definition.',
      notes: 'Professor warnings, exam hints, common mistakes students make, connections to other topics, "this will come back later" remarks, practical tips. Be generous — if the professor said something useful beyond the core material, capture it here.'
    }
  };

  const GUIDE_COUNT_PROFILES = {
    low:       { label: 'Low',       range: '5–10',  rule: 'Merge related subtopics into broad chunks. One block per major lecture section.' },
    medium:    { label: 'Medium',    range: '10–20', rule: 'One block per clear topic shift. Group small asides with the surrounding topic.' },
    high:      { label: 'High',      range: '20–35', rule: 'Split on subtopics, worked examples, and proof steps. Keep blocks focused.' },
    very_high: { label: 'Very High', range: '30–50+', rule: 'Every subtopic, worked example, proof step, or clear topic shift gets its own block. Do NOT merge distant parts of the transcript.' }
  };

  const LEVEL_SCORES = { low: 1, medium: 2, high: 3, very_high: 4, custom: 4 };

  function providerMaxOutputTokens(provider, model) {
    const p = String(provider || '').toLowerCase();
    const m = String(model || '').toLowerCase();

    if (p === 'google' || /(^|\/)gemini-/.test(m)) {
      if (/gemini-3/.test(m)) return 65536;
      return 65536;
    }
    if (p === 'anthropic' || /(^|\/)claude-/.test(m)) return 64000;
    if (/^o[0-9]/.test(m)) return 100000;
    if (/gpt-5|gpt-4\.1/.test(m)) return 32768;
    if (/gpt-4o|gpt-oss/.test(m)) return 16384;
    if (p === 'openai') return 16384;
    if (p === 'xai') return 32768;
    if (p === 'mistral') return 32768;
    if (p === 'fireworks') return 16384;
    if (p === 'cohere') return 4096;
    if (p.startsWith('local_')) return 81920;
    return 8192;
  }

  function clampTokens(n, provider, model) {
    const cap = providerMaxOutputTokens(provider, model);
    return Math.max(1, Math.min(n, cap));
  }

  function guideMaxTokens(detail, count, provider, model) {
    const score = (LEVEL_SCORES[detail] || 4) + (LEVEL_SCORES[count] || 4);
    const cap = providerMaxOutputTokens(provider, model);
    if (score <= 3) return Math.round(cap * 0.25);
    if (score <= 5) return Math.round(cap * 0.5);
    if (score <= 7) return Math.round(cap * 0.75);
    return cap;
  }

  function selectedGuideMaxTokens(detail, count, provider, model) {
    if (count === 'custom') {
      const n = parseInt(genCustomTokenInput?.value, 10);
      if (Number.isFinite(n) && n > 0) return clampTokens(n, provider, model);
    }
    return guideMaxTokens(detail, count, provider, model);
  }

  function updateCustomTokenVisibility() {
    if (!genCustomTokenRow) return;
    genCustomTokenRow.style.display = genCountSel?.value === 'custom' ? '' : 'none';
  }

  function updateTokenHint() {
    if (!genTokenHint) return;
    const detail = genDetailSel?.value || 'very_high';
    const count = genCountSel?.value || 'very_high';
    const providerCap = providerMaxOutputTokens(settings?.provider, settings?.model);
    const tokens = selectedGuideMaxTokens(detail, count, settings?.provider, settings?.model);
    const fmt = n => (n / 1000).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    if (count === 'custom') {
      genTokenHint.textContent = `Manual cap: ${tokens.toLocaleString()} tokens · provider max ${providerCap.toLocaleString()}`;
    } else {
      genTokenHint.textContent = `Up to ~${fmt(tokens)} 000 output tokens (upper limit, not a target)`;
    }
  }

  function getSelectedLanguage() {
    const val = genLangSel?.value || '';
    if (!val) return '';
    if (val === 'other') return genLangCustom?.value?.trim() || '';
    return val;
  }

  function buildGuidePrompt(detail, count, lang) {
    const d = GUIDE_DETAIL_PROFILES[detail] || GUIDE_DETAIL_PROFILES.very_high;
    const c = GUIDE_COUNT_PROFILES[count] || GUIDE_COUNT_PROFILES.very_high;
    const extraPrefix = customPromptExtras.guide ? customPromptExtras.guide.trim() + '\n\n' : '';
    const langInstruction = lang
      ? `\n\nLANGUAGE: Write ALL text content (titles, key_concepts, definitions, notes) in ${lang}. Keep JSON keys, LaTeX, and technical notation unchanged.`
      : `\n\nLANGUAGE: Detect the dominant natural language of the transcript and write ALL text content (lecture_title, titles, key_concepts, definitions, notes) in that same language. Do not default to English unless the transcript itself is mainly English. Keep JSON keys, LaTeX, and technical notation unchanged.`;

    return `${extraPrefix}You are an expert academic assistant that converts lecture transcripts into structured study guides.

Your task: Read the provided lecture transcript and produce a JSON lecture guide. The guide divides the lecture into logical topic blocks (not fixed time intervals). Each block covers one coherent topic or subtopic.${langInstruction}

OUTPUT FORMAT — return ONLY valid JSON, no markdown fences, no explanation, no preamble:

{"lecture_title":"string","total_duration_seconds":number,"guide":[{"start_time":number,"end_time":number,"title":"string","key_concepts":["string"],"formulas":[{"label":"string","latex":"string"}],"definitions":[{"term":"string","definition":"string"}],"notes":"string"}]}

BLOCK COUNT (${c.label} — target ${c.range} blocks):
- ${c.rule}

BLOCK DETAIL (${d.label}):
- key_concepts: ${d.concepts}
- formulas: ${d.formulas}
- definitions: ${d.definitions}
- notes: ${d.notes}

GENERAL RULES:
- The language instruction is mandatory. Examples below are only schema examples; do not copy their English language unless the transcript language is English.
- Blocks follow the logical flow of the lecture. One coherent topic = one block.
- Do NOT hallucinate. Only extract content actually in the transcript.
- Do NOT produce shallow one-liners unless the detail level is set to Low.
- The output token limit is only a ceiling for long lectures. Be complete, but do not pad, repeat, or spend extra tokens when the transcript does not need them.
- In textual fields (title, key_concepts, definitions.definition, notes), prefer LaTeX ($...$ inline, $$...$$ display) whenever mathematical notation appears.
- Markdown is allowed in textual fields when it improves readability (e.g., #/## headings, short lists), but keep it lightweight and do NOT force markdown when plain text is clearer.
- total_duration_seconds: use the last timestamp in the transcript.

EXAMPLE:
Input: "[00:00:00] BFS visits nodes level by level using a queue. [00:01:00] Time complexity is O(V+E). [00:02:00] DFS uses a stack. [00:03:00] Also O(V+E)."
Output: {"lecture_title":"Graph Traversal","total_duration_seconds":180,"guide":[{"start_time":0,"end_time":90,"title":"Breadth-First Search","key_concepts":["BFS explores a graph level by level, starting from a source node and visiting all its direct neighbours before moving to nodes two edges away","The algorithm uses a FIFO queue: enqueue the start node, then repeatedly dequeue the front, enqueue all unvisited neighbours, and mark them visited","BFS naturally finds shortest paths in unweighted graphs because it visits nodes in order of increasing distance from the source","Time complexity is O(V+E) because every vertex is enqueued/dequeued once and every edge is inspected once"],"formulas":[{"label":"BFS Time Complexity","latex":"O(V + E)"}],"definitions":[{"term":"BFS","definition":"Breadth-First Search: a graph traversal that visits all neighbours of a node before going deeper, guaranteeing shortest-path discovery in unweighted graphs"}],"notes":""},{"start_time":90,"end_time":180,"title":"Depth-First Search","key_concepts":["DFS explores as deep as possible along each branch before backtracking, making it suitable for detecting cycles and topological sorting","Can be implemented with an explicit stack or via recursion (the call stack acts as the implicit stack)","Like BFS, DFS runs in O(V+E) time, but it does NOT guarantee shortest paths","DFS is the foundation for many advanced algorithms: topological sort, strongly connected components, and cycle detection"],"formulas":[{"label":"DFS Time Complexity","latex":"O(V + E)"}],"definitions":[{"term":"DFS","definition":"Depth-First Search: a graph traversal that goes deep along each path first, backtracking only when a dead end is reached"}],"notes":"Both BFS and DFS share O(V+E) complexity but have very different properties — BFS gives shortest paths, DFS is better for structural analysis like cycle detection."}]}

Now process the following transcript:`;
  }

  function toSeconds(v) {
    if (typeof v === 'number' && isFinite(v)) return v;

    if (typeof v === 'string') {
      const s = v.trim();
      if (!s) return 0;

      // HH:MM:SS(.ms)  (also supports comma decimals)
      const hms = s.match(/^(\d+):(\d+):(\d+(?:[.,]\d+)?)$/);
      if (hms) {
        const h = +hms[1];
        const m = +hms[2];
        const sec = parseFloat(hms[3].replace(',', '.'));
        if (isFinite(h) && isFinite(m) && isFinite(sec)) return h * 3600 + m * 60 + sec;
      }

      // MM:SS(.ms)
      const ms = s.match(/^(\d+):(\d+(?:[.,]\d+)?)$/);
      if (ms) {
        const m = +ms[1];
        const sec = parseFloat(ms[2].replace(',', '.'));
        if (isFinite(m) && isFinite(sec)) return m * 60 + sec;
      }

      // Raw numeric string (including decimals)
      const normalized = s.replace(',', '.');
      const n = parseFloat(normalized);
      if (isFinite(n)) return n;
    }

    return 0;
  }

  function sanitizeGuide(g) {
    if (!Array.isArray(g.guide)) return g;

    // Coerce timestamps first
    const blocks = g.guide.map(b => ({
      start_time: toSeconds(b.start_time),
      end_time: toSeconds(b.end_time),
      title: b.title ?? 'Untitled Section',
      key_concepts: Array.isArray(b.key_concepts) ? b.key_concepts : [],
      formulas: Array.isArray(b.formulas) ? b.formulas : [],
      definitions: Array.isArray(b.definitions) ? b.definitions : [],
      notes: typeof b.notes === 'string' ? b.notes : ''
    }));

    // Sort by time (some models may output blocks slightly out of order)
    blocks.sort((a, b) => (a.start_time - b.start_time));

    // Ensure each block has a valid [start, end) range.
    for (let i = 0; i < blocks.length; i++) {
      const cur = blocks[i];
      const next = blocks[i + 1];

      // Clamp negatives
      if (!isFinite(cur.start_time) || cur.start_time < 0) cur.start_time = 0;
      if (!isFinite(cur.end_time) || cur.end_time < 0) cur.end_time = 0;

      // Fix missing/invalid end_time by using next start_time (or +1s)
      if (!isFinite(cur.end_time) || cur.end_time <= cur.start_time) {
        cur.end_time = next ? next.start_time : (cur.start_time + 1);
      }
    }

    g.guide = blocks;
    return g;
  }

  // ─── Guide Display ────────────────────────────────────────────────────────

  function showGuideContent() {
    guideEmpty.style.display = 'none';
    guideContent.style.display = 'flex';
    syncAutoFollowCheckbox();
    let startIdx = 0;
    if (autoTimeFollow && !autoFollowPaused && guide?.guide?.length) {
      startIdx = findBlockIndex(lastVideoTime);
    }
    if (guide?.guide?.length) {
      startIdx = Math.max(0, Math.min(startIdx, guide.guide.length - 1));
    }
    renderBlock(startIdx);
  }

  function syncAutoFollowCheckbox() {
    if (autoTimeFollowCb) autoTimeFollowCb.checked = autoTimeFollow;
    const isPaused = autoTimeFollow && autoFollowPaused;
    if (autoFollowPauseHint) {
      autoFollowPauseHint.style.display = isPaused ? '' : 'none';
    }
    const guideNavFollow = document.querySelector('.guide-nav-follow');
    if (guideNavFollow) {
      if (isPaused) {
        guideNavFollow.dataset.paused = '';
      } else {
        delete guideNavFollow.dataset.paused;
      }
    }
  }

  function persistAutoTimeFollow() {
    localStorage.setItem('eth-copilot-auto-time-follow', autoTimeFollow ? '1' : '0');
  }

  function onAutoTimeFollowChange() {
    autoTimeFollow = !!autoTimeFollowCb?.checked;
    autoFollowPaused = false;
    persistAutoTimeFollow();
    syncAutoFollowCheckbox();
  }

  function navigateBlock(delta) {
    if (!guide?.guide?.length) return;
    const n = guide.guide.length;
    let idx = currentBlockIndex >= 0 ? currentBlockIndex : 0;
    // Cycle: wrap around at both ends
    idx = ((idx + delta) % n + n) % n;
    if (autoTimeFollow) {
      const liveIdx = findBlockIndex(lastVideoTime);
      autoFollowPaused = idx !== liveIdx;
      syncAutoFollowCheckbox();
    }
    if (guideBlock) guideBlock.dataset.direction = delta > 0 ? 'next' : 'prev';
    renderBlock(idx);
  }

  function commitBlockJump() {
    if (!guide?.guide?.length) { restoreBlockJumpInput(); return; }
    const n = guide.guide.length;
    const raw = parseInt(blockJumpInput?.value, 10);
    if (!Number.isFinite(raw) || raw < 1 || raw > n) {
      restoreBlockJumpInput(); // out of bounds — silently stay
      return;
    }
    const idx = raw - 1;
    if (autoTimeFollow) {
      const liveIdx = findBlockIndex(lastVideoTime);
      autoFollowPaused = idx !== liveIdx;
      syncAutoFollowCheckbox();
    }
    if (guideBlock) guideBlock.removeAttribute('data-direction');
    renderBlock(idx);
  }

  function showSidebarSpeedOverlay(rate) {
    const el = document.getElementById('sidebar-speed-toast');
    if (!el) return;
    el.textContent = `${rate}×`;
    // Restart animation on each call: strip class, force reflow, re-add.
    el.classList.remove('animating');
    void el.offsetWidth;
    el.classList.add('animating');
  }

  function restoreBlockJumpInput() {
    if (blockJumpInput && currentBlockIndex >= 0) {
      blockJumpInput.value = currentBlockIndex + 1;
    }
  }

  function jumpToCurrentTimeBlock() {
    if (!guide?.guide?.length) return;
    autoFollowPaused = false;
    syncAutoFollowCheckbox();
    if (guideBlock) guideBlock.removeAttribute('data-direction'); // use fadeIn, not slide
    const idx = findBlockIndex(lastVideoTime);
    renderBlock(idx);
  }

  function handleTimestamp(currentTime) {
    lastVideoTime = currentTime;
    if (!guide?.guide?.length) return;
    if (!autoTimeFollow) return;

    const liveIdx = findBlockIndex(currentTime);

    if (autoFollowPaused) {
      if (liveIdx === currentBlockIndex) {
        autoFollowPaused = false;
        syncAutoFollowCheckbox();
      }
      return;
    }

    if (liveIdx !== currentBlockIndex) {
      renderBlock(liveIdx);
    }
  }

  function findBlockIndex(t) {
    if (!guide?.guide?.length) return 0;
    const blocks = guide.guide;
    for (let i = 0; i < blocks.length; i++) {
      if (t >= blocks[i].start_time && t < blocks[i].end_time) return i;
    }
    if (t >= blocks[blocks.length - 1].start_time) return blocks.length - 1;
    return 0;
  }

  function renderBlock(idx) {
    if (!guide?.guide) return;
    const blocks = guide.guide;
    const block = blocks[idx];
    if (!block) return;

    currentBlockIndex = idx;

    // Keep exam-tool "current block" label fresh whenever the user navigates
    const _examScopeVal = getActivePillValue('exam-scope-pills');
    if (_examScopeVal === 'current') {
      const _infoLabel = document.getElementById('exam-current-block-label');
      if (_infoLabel) {
        _infoLabel.textContent = block?.title
          ? `Block ${idx + 1}: ${block.title}`
          : 'No block selected yet';
      }
    }

    // Update counter + progress
    if (blockJumpInput) blockJumpInput.value = idx + 1;
    if (blockJumpInput) blockJumpInput.max = String(blocks.length);
    blockCounter.textContent = blocks.length;
    const progressPct = Math.round(((idx + 1) / blocks.length) * 100);
    progressFill.style.width = `${progressPct}%`;
    progressFill.parentElement?.setAttribute('aria-valuenow', String(progressPct));

    // Build block HTML
    let html = `
      <div class="block-head-row">
        <div>
          <div class="block-title">${escHtml(block.title)}</div>
          <div class="block-timestamp">${fmtSec(block.start_time)} – ${fmtSec(block.end_time)}</div>
        </div>
        <button type="button" class="latex-copy-btn" data-block-index="${idx}" title="Copy this full block (including LaTeX)">Copy block</button>
      </div>
    `;

    // Key concepts
    if (block.key_concepts?.length) {
      html += `<div>
        <div class="section-label">Key Concepts</div>
        <ul class="concepts-list">
          ${block.key_concepts.map(c => `<li><span class="concept-text">${escHtml(normalizeLatexForKatex(unescapeMathDelimiters(c)))}</span></li>`).join('')}
        </ul>
      </div>`;
    }

    // Formulas
    if (block.formulas?.length) {
      html += `<div>
        <div class="section-label">Formulas</div>
        ${block.formulas.map(f => `
          <div class="formula-card">
            <div class="formula-label">${escHtml(f.label)}</div>
            <div class="formula-render" data-latex="${escAttr(f.latex)}"></div>
          </div>
        `).join('')}
      </div>`;
    }

    // Definitions
    if (block.definitions?.length) {
      html += `<div>
        <div class="section-label">Definitions</div>
        ${block.definitions.map(d => `
          <div class="definition-item">
            <div class="definition-term"><span class="definition-term-text">${escHtml(normalizeLatexForKatex(unescapeMathDelimiters(d.term)))}</span></div>
            <div class="definition-text"><span class="definition-body-text">${escHtml(normalizeLatexForKatex(unescapeMathDelimiters(d.definition)))}</span></div>
          </div>
        `).join('')}
      </div>`;
    }

    // Notes
    if (block.notes?.trim()) {
      html += `
        <div class="notes-box">
          <div class="notes-icon-row">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/>
              <line x1="12" y1="8" x2="12" y2="12"/>
              <line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            <span class="notes-icon-label">Note</span>
          </div>
          <div class="notes-text"><span class="notes-body-text">${escHtml(normalizeLatexForKatex(unescapeMathDelimiters(block.notes)))}</span></div>
        </div>
      `;
    }

    // ── Freeze visually during render to eliminate KaTeX-induced flicker ──
    const _animDir = guideBlock.dataset.direction || null;
    guideBlock.removeAttribute('data-direction'); // suppress animation during render
    guideBlock.style.opacity = '0';               // hide until fully rendered

    guideBlock.innerHTML = html;

    if (typeof renderMathInElement === 'function') {
      guideBlock.querySelectorAll('.concepts-list .concept-text').forEach(el => {
        renderMathInElement(el, {
          delimiters: [
            { left: '$$', right: '$$', display: true },
            { left: '$', right: '$', display: false }
          ],
          throwOnError: false,
          trust: false
        });
      });

      guideBlock.querySelectorAll('.definition-term-text, .definition-body-text').forEach(el => {
        renderMathInElement(el, {
          delimiters: [
            { left: '$$', right: '$$', display: true },
            { left: '$', right: '$', display: false }
          ],
          throwOnError: false,
          trust: false
        });
      });

      guideBlock.querySelectorAll('.notes-body-text').forEach(el => {
        renderMathInElement(el, {
          delimiters: [
            { left: '$$', right: '$$', display: true },
            { left: '$', right: '$', display: false }
          ],
          throwOnError: false,
          trust: false
        });
      });
    }

    // Render KaTeX formulas
    guideBlock.querySelectorAll('.formula-render[data-latex]').forEach(el => {
      const latex = el.dataset.latex;
      try {
        katex.render(normalizeLatexForKatex(latex), el, { displayMode: true, throwOnError: false, trust: false });
      } catch (e) {
        el.textContent = latex;
      }
    });

    // ── Normalize formula sizes BEFORE revealing ──
    normalizeBlockFormulas(guideBlock);

    // ── All rendering done — trigger animation cleanly ──
    void guideBlock.offsetWidth;   // flush layout
    guideBlock.style.opacity = ''; // hand off to CSS animation

    if (_animDir) {
      guideBlock.dataset.direction = _animDir;
      // Use animationend so removing data-direction doesn't trigger a second fadeIn replay
      const _onAnimEnd = () => {
        guideBlock.style.animation = 'none';
        void guideBlock.offsetWidth;
        guideBlock.removeAttribute('data-direction');
        // Leave animation:none — next renderBlock resets cleanly via opacity:0
      };
      guideBlock.addEventListener('animationend', _onAnimEnd, { once: true });
    } else {
      // Replay soft fadeIn for auto-follow / jump transitions
      guideBlock.style.animation = 'none';
      void guideBlock.offsetWidth;
      guideBlock.style.animation = '';
    }

    guideBlock.querySelectorAll('.latex-copy-btn[data-block-index]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const i = parseInt(btn.dataset.blockIndex, 10);
        await copyLatexFromSingleBlock(i);
      });
    });
  }

  /**
   * After KaTeX renders, measure each formula's natural width and apply a uniform
   * CSS zoom to all formulas in the block so none require horizontal scrolling.
   * The same zoom value is applied to all (smallest needed wins) so they look
   * consistent side-by-side. Zoom is clamped at 0.46 minimum.
   */
  function normalizeBlockFormulas(blockEl) {
    const renders = blockEl.querySelectorAll('.formula-render');
    if (!renders.length) return;

    // Reset any previous zoom so measurements reflect natural size
    renders.forEach(r => { r.style.zoom = ''; });
    void blockEl.offsetHeight; // force layout

    const containerW = blockEl.clientWidth - 28; // 16+12 padding buffer
    if (containerW <= 0) return;

    let minScale = 1.0;
    renders.forEach(render => {
      const sw = render.scrollWidth;
      if (sw > containerW && sw > 0) {
        const ratio = containerW / sw;
        if (ratio < minScale) minScale = ratio;
      }
    });

    const scale = Math.max(0.46, minScale);
    if (scale < 0.995) {
      renders.forEach(r => { r.style.zoom = scale.toFixed(3); });
    }
  }

  function formatBlockForCopy(block, idx) {
    if (!block) return '';
    const out = [];
    out.push(`## Block ${idx + 1}: ${block.title || 'Untitled block'}`);
    out.push(`Time: ${fmtSec(block.start_time)} - ${fmtSec(block.end_time)}`);
    out.push('');

    if (Array.isArray(block.key_concepts) && block.key_concepts.length) {
      out.push('Key Concepts:');
      for (const c of block.key_concepts) out.push(`- ${String(c || '').trim()}`);
      out.push('');
    }

    if (Array.isArray(block.formulas) && block.formulas.length) {
      out.push('Formulas (LaTeX):');
      for (const f of block.formulas) {
        const label = String(f?.label || 'Formula').trim();
        const latex = String(f?.latex || '').trim();
        if (!latex) continue;
        out.push(`- ${label}: ${latex}`);
      }
      out.push('');
    }

    if (Array.isArray(block.definitions) && block.definitions.length) {
      out.push('Definitions:');
      for (const d of block.definitions) {
        out.push(`- ${String(d?.term || 'Term').trim()}: ${String(d?.definition || '').trim()}`);
      }
      out.push('');
    }

    if (String(block.notes || '').trim()) {
      out.push('Notes:');
      out.push(String(block.notes).trim());
      out.push('');
    }

    return out.join('\n').trim();
  }

  async function copyTextToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return !!ok;
    }
  }

  async function copyLatexFromSingleBlock(idx) {
    if (!guide?.guide?.[idx]) return;
    const block = guide.guide[idx];
    const text = formatBlockForCopy(block, idx);
    if (!text) {
      setStatus('warning', 'Block is empty');
      return;
    }
    const ok = await copyTextToClipboard(text);
    setStatus(ok ? 'ready' : 'error', ok
      ? 'Copied full block content'
      : 'Could not copy block content');
  }

  function openLatexSelectModal() {
    if (!guide?.guide?.length) {
      setStatus('warning', 'No guide blocks available');
      return;
    }
    const blocks = guide.guide;
    latexBlockList.innerHTML = blocks.map((b, i) => `
      <label class="latex-block-item">
        <input type="checkbox" data-latex-block="${i}">
        <span class="latex-block-title">${i + 1}. ${escHtml(b.title || 'Untitled block')}</span>
      </label>
    `).join('');
    setAllLatexSelections(false);
    latexSelectModal.style.display = '';
  }

  function closeLatexSelectModal() {
    if (latexSelectModal) latexSelectModal.style.display = 'none';
  }

  function setAllLatexSelections(selected) {
    latexBlockList?.querySelectorAll('input[type="checkbox"][data-latex-block]').forEach(cb => {
      cb.checked = selected;
    });
  }

  async function copyLatexFromSelectedBlocks() {
    const selectedIdx = Array.from(
      latexBlockList?.querySelectorAll('input[type="checkbox"][data-latex-block]:checked') || []
    ).map(cb => parseInt(cb.dataset.latexBlock, 10));

    if (!selectedIdx.length) {
      setStatus('warning', 'Select at least one block first');
      return;
    }

    const collected = [];
    for (const i of selectedIdx) {
      const block = guide?.guide?.[i];
      if (!block) continue;
      const blockText = formatBlockForCopy(block, i);
      if (!blockText) continue;
      collected.push(blockText);
      collected.push('');
      collected.push('---');
      collected.push('');
    }

    if (!collected.length) {
      setStatus('warning', 'No content found in selected blocks');
      return;
    }

    const ok = await copyTextToClipboard(collected.join('\n'));
    if (ok) {
      closeLatexSelectModal();
      setStatus('ready', `Copied ${selectedIdx.length} selected full block${selectedIdx.length === 1 ? '' : 's'}`);
    } else {
      setStatus('error', 'Could not copy selected blocks');
    }
  }

  // ─── Script Management ───────────────────────────────────────────────────

  async function initScriptsForCourse(lectureUrl) {
    if (!window.ScriptManager) return;
    const courseId = ScriptManager.extractCourseId(lectureUrl);
    if (!courseId) return;
    scriptCourseId = courseId;
    try {
      scriptRecord = await ScriptManager.load(courseId);
    } catch (e) {
      console.warn('[Copilot] Failed to load scripts:', e);
      scriptRecord = null;
    }
    renderScriptFileList();
  }

  function getScriptSearchMethod() {
    return scriptSearchMethod?.value || 'fuzzy';
  }

  function onSearchMethodChange() {
    const method = getScriptSearchMethod();
    if (scriptSemanticInfo) scriptSemanticInfo.style.display = method === 'semantic' ? '' : 'none';
    updateEmbedBtnVisibility();
  }

  function updateEmbedBtnVisibility() {
    if (!scriptEmbedBtn) return;
    const method = getScriptSearchMethod();
    const hasChunks = scriptRecord?.chunks?.length > 0;
    const hasEmbeds = window.ScriptManager?.hasEmbeddings(scriptRecord);
    scriptEmbedBtn.style.display = (method === 'semantic' && hasChunks && !hasEmbeds) ? '' : 'none';
    if (scriptEmbedStatus && hasEmbeds && method === 'semantic') {
      scriptEmbedStatus.textContent = 'Semantic index ready';
    }
  }

  async function onEmbedExistingClick() {
    if (!scriptCourseId || !scriptRecord?.chunks?.length) return;
    scriptEmbedBtn.disabled = true;
    scriptEmbedBtn.textContent = 'Building index...';
    try {
      scriptRecord = await ScriptManager.computeEmbeddings(scriptCourseId, (status) => {
        if (scriptEmbedStatus) scriptEmbedStatus.textContent = status;
      });
      if (scriptEmbedStatus) scriptEmbedStatus.textContent = 'Semantic index ready';
    } catch (e) {
      console.error('[Copilot] Embedding failed:', e);
      if (scriptEmbedStatus) scriptEmbedStatus.textContent = 'Indexing failed: ' + e.message;
    } finally {
      scriptEmbedBtn.disabled = false;
      scriptEmbedBtn.textContent = 'Build semantic index for existing scripts';
      updateEmbedBtnVisibility();
    }
  }

  function renderScriptFileList() {
    if (!scriptFileList) return;
    const files = scriptRecord?.files || [];
    const totalChunks = scriptRecord?.chunks?.length || 0;

    if (scriptBadge) {
      scriptBadge.textContent = files.length;
      scriptBadge.style.display = files.length > 0 ? '' : 'none';
    }

    if (!files.length) {
      scriptFileList.innerHTML = '<p class="script-empty-msg">No scripts uploaded for this course.</p>';
      updateEmbedBtnVisibility();
      return;
    }

    const hasEmbeds = window.ScriptManager?.hasEmbeddings(scriptRecord);
    const embedLabel = hasEmbeds ? ' · semantic indexed' : '';

    scriptFileList.innerHTML = files.map((f, i) => `
      <div class="script-file-item" data-file-index="${i}">
        <div class="script-file-info">
          <span class="script-file-name" title="${f.name}">${f.name}</span>
          <span class="script-file-meta">${f.pageCount} pages · ${f.chunkCount} chunks · ${ScriptManager.formatSize(f.size)}</span>
        </div>
        <button class="script-file-remove" title="Remove this file" data-remove-index="${i}">×</button>
      </div>
    `).join('');

    scriptFileList.querySelectorAll('.script-file-remove').forEach(btn => {
      btn.addEventListener('click', async () => {
        const idx = parseInt(btn.dataset.removeIndex);
        scriptUploadStatus.textContent = 'Removing…';
        try {
          scriptRecord = await ScriptManager.removeFile(scriptCourseId, idx);
          renderScriptFileList();
          scriptUploadStatus.textContent = '';
        } catch (e) {
          scriptUploadStatus.textContent = 'Error: ' + e.message;
        }
      });
    });

    const totalTokensEst = totalChunks * CHUNK_TARGET_DISPLAY;
    scriptFileList.insertAdjacentHTML('beforeend',
      `<p class="script-file-meta" style="padding:2px 0 0;font-style:italic">Total: ${totalChunks} chunks (~${Math.round(totalTokensEst / 1000)}K tokens)${embedLabel}</p>`
    );
    updateEmbedBtnVisibility();
  }

  const CHUNK_TARGET_DISPLAY = 500;

  async function handleScriptUpload() {
    if (!scriptFileInput?.files?.length || !scriptCourseId) return;
    const files = Array.from(scriptFileInput.files);
    scriptFileInput.value = '';
    const method = getScriptSearchMethod();

    for (const file of files) {
      if (!file.name.toLowerCase().endsWith('.pdf')) {
        scriptUploadStatus.textContent = `Skipped ${file.name} — only PDFs are supported`;
        continue;
      }

      scriptUploadStatus.innerHTML = `<span class="script-upload-progress">Processing ${file.name}…</span>`;

      try {
        scriptRecord = await ScriptManager.addPdf(scriptCourseId, file, (status) => {
          scriptUploadStatus.innerHTML = `<span class="script-upload-progress">${status}</span>`;
        }, method);
        renderScriptFileList();
        scriptUploadStatus.textContent = `${file.name} added` + (method === 'semantic' ? ' (with embeddings)' : '');
      } catch (e) {
        console.error('[Copilot] PDF processing failed:', e);
        scriptUploadStatus.textContent = `Failed: ${e.message}`;
      }
    }

    setTimeout(() => { if (scriptUploadStatus) scriptUploadStatus.textContent = ''; }, 5000);
  }

  // ─── Q&A Chat ─────────────────────────────────────────────────────────────

  function restoreMainStatus() {
    if (guide?.guide?.length) {
      setStatus('ready', `Guide ready · ${guide.guide.length} blocks`);
    } else if (transcript?.text) {
      const n = Array.isArray(transcript.cues) ? transcript.cues.length : null;
      const cueStr = n != null ? ` · ${n} cues` : '';
      setStatus('ready', `Transcript loaded${cueStr}`);
    } else {
      setStatus('loading', 'Waiting for transcript…');
    }
  }

  function onQaInputChange() {
    const hasText = qaInput.value.trim().length > 0;
    const hasSettings = hasUsableSettings();
    const hasTranscript = transcript?.text;
    qaSend.disabled = !hasText || !hasSettings || !hasTranscript || isChatting;
    // Dynamic tooltip explaining why button is disabled
    if (!hasSettings) {
      qaSend.title = 'Add an API key in Settings first';
    } else if (!hasTranscript) {
      qaSend.title = 'Waiting for transcript to load';
    } else if (!hasText) {
      qaSend.title = 'Type a question first';
    } else if (isChatting) {
      qaSend.title = 'Waiting for reply…';
    } else {
      qaSend.title = 'Send (Enter)';
    }
    // Auto-resize textarea
    qaInput.style.height = 'auto';
    qaInput.style.height = Math.min(qaInput.scrollHeight, 120) + 'px';
  }

  async function sendQaMessage() {
    const text = qaInput.value.trim();
    if (!text || isChatting || !hasUsableSettings() || !transcript?.text) return;

    hideQaReplyReadyToast();
    isChatting = true;
    qaSend.disabled = true;

    // Collect all images (data URLs) and clear state
    const allImages = attachedImages.map(img => img.dataUrl);
    attachedImages = [];
    renderImageStrip();

    setStatus('loading', 'Waiting for reply…');

    // Add user message to UI
    const userMsg = { role: 'user', content: text, images: allImages };
    qaMessages.push(userMsg);
    appendChatMsg('user', text, allImages);
    qaInput.value = '';
    qaInput.style.height = 'auto';

    // All providers support SSE streaming; use it for progressive rendering
    const useStream = !!settings.provider;

    // Build system prompt with context (including script chunks if available)
    const systemPrompt = await buildQAPrompt(text);

    // Prepare streaming message element or typing indicator
    let typingEl = null;
    if (useStream) {
      // Create a live-updating assistant bubble; no auto-scroll during generation
      qaStreamBuffer = '';
      qaStreamDollarCount = 0;
      qaStreamStableEnd = 0;
      qaStreamKatexEnd  = 0;
      qaRafPending = false;
      qaStreamEl = document.createElement('div');
      qaStreamEl.className = 'chat-msg assistant';
      // .qa-katex-zone receives KaTeX-rendered text for complete $$...$$ blocks.
      // Plain-text .qa-chunk spans are appended after it.
      qaStreamEl.innerHTML = '<div class="chat-bubble"><div class="qa-katex-zone"></div><span class="qa-stream-cursor" aria-hidden="true"></span></div>';
      qaMessages_el.appendChild(qaStreamEl);
      qaStreamBubble = qaStreamEl.querySelector('.chat-bubble');
      // Always scroll to bottom when the stream bubble first appears —
      // the user just sent a message so they want to see the AI reply.
      qaScrollToBottom();
    } else {
      typingEl = appendTypingIndicator();
    }

    try {
      const qaTemp = qaTempSlider ? qaTempSlider.value / 100 : 0.35;
      const qaThinking = qaThinkingSel?.value || 'none';

      const req = apiRequest({
        type: 'CHAT',
        messages: qaMessages.map(m => ({ role: m.role, content: m.content, ...(m.images?.length ? { images: m.images } : {}) })),
        systemPrompt,
        provider: settings.provider,
        model: settings.model || null,
        apiKey: settings.apiKey,
        localBase: getLocalBase(),
        chatTemperature: qaTemp,
        chatThinking: qaThinking,
        useStream
      });

      // Register as active QA stream so handleQaStreamChunk can find it
      if (useStream) {
        activeQaRequestId = req._requestId;
        isQaStreaming = true;
      }

      const response = await req;

      if (!response.success) throw new Error(response.error);

      const assistantText = response.data;
      qaMessages.push({ role: 'assistant', content: assistantText });

      if (useStream) {
        // Stream complete — stop accepting new chunks
        isQaStreaming = false;
        activeQaRequestId = null;
        if (qaKatexThrottle) { clearTimeout(qaKatexThrottle); qaKatexThrottle = null; }

        // Final render: crossfade from plain-text spans → full markdown + KaTeX.
        // Capture bubble in a local var because qaStreamBubble is nulled right after.
        if (qaStreamBubble) {
          const bubble    = qaStreamBubble;
          const finalNorm = normalizeLatexForKatex(unescapeMathDelimiters(assistantText));

          // Step 1: fade out the raw plain-text version
          bubble.style.transition = 'opacity 0.12s ease';
          bubble.style.opacity    = '0.2';

          setTimeout(() => {
            // Step 2: swap in the formatted content while invisible
            bubble.innerHTML = renderMarkdown(finalNorm);
            if (typeof renderMathInElement === 'function') {
              renderMathInElement(bubble, {
                delimiters: [
                  { left: '$$', right: '$$', display: true },
                  { left: '$',  right: '$',  display: false }
                ],
                throwOnError: false,
                trust: false
              });
            }
            // Step 3: fade the formatted content back in
            bubble.style.opacity = '1';
            setTimeout(() => { bubble.style.transition = ''; }, 180);
          }, 120);
        }

        persistChat();

        // Scroll / notify: on QA tab → scroll to bottom; away → cross-tab notify
        if (qaStreamEl) {
          if (_currentTab !== 'qa') {
            showCrossTabNotify(qaStreamEl);
          } else {
            // Always scroll to bottom when generation completes (per user request)
            qaScrollToBottom();
          }
        }
        qaStreamEl = null;
        qaStreamBubble = null;

      } else {
        // Non-streaming path
        typingEl?.remove();
        appendChatMsg('assistant', assistantText, false);
        persistChat();
      }

    } catch (err) {
      // Clean up streaming state on error
      isQaStreaming = false;
      activeQaRequestId = null;
      if (qaKatexThrottle) { clearTimeout(qaKatexThrottle); qaKatexThrottle = null; }

      if (useStream && qaStreamEl) {
        qaStreamEl.remove();
        qaStreamEl = null;
        qaStreamBubble = null;
        qaStreamStableEnd = 0;
        qaStreamKatexEnd  = 0;
      } else {
        typingEl?.remove();
      }

      const humanError = humanizeApiError(err.message);
      appendErrorMsg(humanError);
    } finally {
      isChatting = false;
      onQaInputChange();
      restoreMainStatus();
    }
  }

  function humanizeApiError(msg) {
    if (!msg) return 'Something went wrong. Try again.';
    const m = extractApiErrorMessage(String(msg));
    switch (classifyApiError(m)) {
      case 'auth':
        return 'Invalid API key — check your key in Settings (popup icon).';
      case 'permission':
        return 'Access denied — your API key may not have permission for this model.';
      case 'rate_limit':
        return 'Rate limit hit — wait a moment and try again.';
      case 'timeout':
        return 'Request timed out — the server took too long. Try again.';
      case 'parse':
        return 'The AI returned an unexpected response. Try a different model or settings.';
      case 'context_length':
        return 'The request is too long for this model. Use fewer blocks, lower detail, or a model with a larger context window.';
      case 'token_settings':
        return 'The provider rejected the token settings. Try Block count -> Custom tokens and lower the manual value, or reduce Thinking.';
    }
    return m.length > 140 ? m.slice(0, 140) + '…' : m;
  }

  function classifyApiError(msg) {
    const m = String(msg || '');
    if (/401|unauthorized|invalid.{0,20}key|api.{0,10}key/i.test(m)) return 'auth';
    if (/403|forbidden/i.test(m)) return 'permission';
    if (/429|rate.?limit|too many/i.test(m)) return 'rate_limit';
    if (/timeout|timed.{0,5}out|network/i.test(m)) return 'timeout';
    if (/json|parse|syntax/i.test(m)) return 'parse';
    if (/context.{0,20}length|too.{0,10}long|input.{0,20}tokens|maximum context/i.test(m)) return 'context_length';
    if (/(max[_ ]?(output[_ ]?)?tokens|max[_ ]?completion[_ ]?tokens|maxOutputTokens|supported range|token cap|token budget|budget_tokens|output token)/i.test(m)) {
      return 'token_settings';
    }
    return 'unknown';
  }

  function extractApiErrorMessage(raw) {
    const text = String(raw || '');
    const jsonStart = text.indexOf('{');
    if (jsonStart >= 0) {
      try {
        const parsed = JSON.parse(text.slice(jsonStart));
        const nested = parsed?.error?.message || parsed?.message || parsed?.error;
        if (typeof nested === 'string') return extractApiErrorMessage(nested);
      } catch (_) {}
    }
    const escaped = text.match(/\\"message\\":\\"([^"]+)/);
    if (escaped?.[1]) {
      return escaped[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
    }
    return text;
  }

  function showGuideError(raw) {
    if (!generateError) return;
    const human = humanizeApiError(raw);
    const tip = guideErrorTip(raw);
    generateError.innerHTML = `
      <strong>Guide generation failed</strong>
      <span>${escHtml(human)}</span>
      ${tip ? `<small>${escHtml(tip)}</small>` : ''}
    `;
    generateError.style.display = 'block';
  }

  function guideErrorTip(raw) {
    const kind = classifyApiError(extractApiErrorMessage(String(raw || '')));
    if (kind === 'token_settings') {
      return 'Tip: choose Block count → Custom tokens and lower the token cap, or reduce Thinking.';
    }
    if (kind === 'context_length') {
      return 'Tip: reduce Block detail or Block count, or switch to a model with a larger context window.';
    }
    return '';
  }

  /**
   * Build a token-efficient Q&A system prompt:
   * - Only sends a ±3 min transcript window around the current video time
   * - Only sends relevant guide blocks for that window
   * - Uses the transcript window content + user query for script retrieval
   * - Includes a compact lecture overview (block titles) for structural awareness
   */
  async function buildQAPrompt(userQuery) {
    const title = transcript?.lectureTitle || 'Lecture';
    const currentTime = lastVideoTime || 0;
    const WINDOW_SEC = 180; // ±3 minutes

    // 1. Extract ±3 min transcript window from cues
    const windowStart = Math.max(0, currentTime - WINDOW_SEC);
    const windowEnd = currentTime + WINDOW_SEC;
    let windowCues = [];
    if (transcript?.cues?.length) {
      windowCues = transcript.cues.filter(c =>
        c.start_time >= windowStart && c.start_time <= windowEnd
      );
    }
    const windowText = windowCues.length > 0
      ? windowCues.map(c => `[${fmtSec(c.start_time)}] ${c.text}`).join('\n')
      : (transcript?.text?.slice(0, 4000) || '(no transcript)');

    // 2. Extract relevant guide blocks for the time window
    let guideBlocksStr = '(guide not yet generated)';
    if (guide?.guide?.length) {
      const relevant = guide.guide.filter(b =>
        b.end_time >= windowStart && b.start_time <= windowEnd
      );
      if (relevant.length) {
        guideBlocksStr = JSON.stringify(relevant, null, 2);
      } else {
        const idx = findBlockIndex(currentTime);
        guideBlocksStr = JSON.stringify([guide.guide[idx]], null, 2);
      }
    }

    // 3. Compact lecture overview (title + time range per block, ~few tokens)
    let lectureOverview = '';
    if (guide?.guide?.length) {
      lectureOverview = '\n--- LECTURE STRUCTURE ---\n' +
        guide.guide.map((b, i) =>
          `${i + 1}. [${fmtSec(b.start_time)}-${fmtSec(b.end_time)}] ${b.title}`
        ).join('\n') + '\n';
    }

    // 4. Script retrieval using transcript context + user query
    let scriptContext = '';
    if (scriptRecord?.chunks?.length && window.ScriptManager) {
      const strictness = scriptStrictnessSel?.value || 'medium';
      const method = getScriptSearchMethod();
      const transcriptSnippet = windowCues.length > 0
        ? windowCues.map(c => c.text).join(' ').slice(0, 600)
        : '';
      const searchQuery = (transcriptSnippet + ' ' + userQuery).trim();

      if (method === 'semantic' && ScriptManager.hasEmbeddings(scriptRecord)) {
        scriptContext = await ScriptManager.buildScriptContextSemantic(searchQuery, scriptRecord, strictness);
      } else {
        scriptContext = ScriptManager.buildScriptContext(searchQuery, scriptRecord, strictness);
      }
    }

    const hasScript = !!scriptContext;
    const qaExtraPrefix = customPromptExtras.qa ? customPromptExtras.qa.trim() + '\n\n' : '';

    return `${qaExtraPrefix}You are a helpful study assistant for the ETH Zürich lecture: "${title}".
The student is currently at [${fmtSec(currentTime)}] in the video.

Answer based on the transcript excerpt and guide blocks below${hasScript ? ', plus course script excerpts' : ''}. Reference timestamps [HH:MM:SS] when relevant. Use LaTeX ($...$ inline, $$...$$ display) whenever math appears. Markdown formatting (e.g., #/## headings, short bullet lists) is allowed when it improves readability, but do not force markdown when plain text is clearer. If the question is about a different part of the lecture, reference the lecture structure to guide the student.
${lectureOverview}
--- TRANSCRIPT (${fmtSec(windowStart)} to ${fmtSec(windowEnd)}) ---
${windowText}

--- GUIDE BLOCKS (current section) ---
${guideBlocksStr}${scriptContext}`;
  }

  /** If the user is within this many px of the bottom, new assistant replies align to the start of the bubble instead of jumping to the end. */
  const QA_SCROLL_BOTTOM_THRESHOLD_PX = 80;

  function qaIsFollowingLatest() {
    const root = qaMessages_el;
    if (!root) return true;
    return root.scrollHeight - root.scrollTop - root.clientHeight <= QA_SCROLL_BOTTOM_THRESHOLD_PX;
  }

  function qaScrollToBottom() {
    if (qaMessages_el) qaMessages_el.scrollTo({ top: qaMessages_el.scrollHeight, behavior: 'smooth' });
  }

  /**
   * Align the top of `el` with the top of the Q&A message list viewport.
   * Do not use scrollIntoView() here: it can scroll ancestor containers or the
   * host page and push the tab bar off-screen in the extension iframe.
   */
  function qaScrollMessagesToShowElementTop(el) {
    const root = qaMessages_el;
    if (!root || !el) return;
    const rootRect = root.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const delta = elRect.top - rootRect.top;
    const target = Math.max(0, root.scrollTop + delta);
    root.scrollTo({ top: target, behavior: 'smooth' });
  }

  function hideQaReplyReadyToast() {
    qaReplyReadyTargetEl = null;
    if (qaReplyReadyToast) qaReplyReadyToast.hidden = true;
  }

  // ─── Frame image lightbox ────────────────────────────────────────────────
  let _frameLightbox = null;

  function openFrameLightbox(src) {
    if (!_frameLightbox) {
      _frameLightbox = document.createElement('div');
      _frameLightbox.id = 'frame-lightbox';
      _frameLightbox.className = 'frame-lightbox';
      _frameLightbox.hidden = true;
      _frameLightbox.setAttribute('role', 'dialog');
      _frameLightbox.setAttribute('aria-label', 'Video frame preview');
      _frameLightbox.innerHTML = `
        <div class="frame-lightbox-backdrop"></div>
        <div class="frame-lightbox-inner">
          <button class="frame-lightbox-close" title="Close preview" aria-label="Close">×</button>
          <img class="frame-lightbox-img" alt="Video frame preview">
        </div>
      `;
      document.body.appendChild(_frameLightbox);
      _frameLightbox.querySelector('.frame-lightbox-backdrop')
        .addEventListener('click', closeFrameLightbox);
      _frameLightbox.querySelector('.frame-lightbox-close')
        .addEventListener('click', closeFrameLightbox);
      document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && _frameLightbox && !_frameLightbox.hidden) {
          closeFrameLightbox();
        }
      });
    }
    _frameLightbox.querySelector('.frame-lightbox-img').src = src;
    _frameLightbox.hidden = false;
  }

  function closeFrameLightbox() {
    if (_frameLightbox) _frameLightbox.hidden = true;
  }

  function onQaMessagesClick(e) {
    // Frame thumbnail click → open lightbox
    const thumb = e.target?.closest?.('.chat-frame-thumb');
    if (thumb) {
      e.preventDefault();
      openFrameLightbox(thumb.src);
      return;
    }
    // Timestamp link click → seek video
    const ts = e.target?.closest?.('.qa-timestamp-link[data-seconds]');
    if (!ts) return;
    e.preventDefault();
    const seconds = Number(ts.dataset.seconds);
    if (!Number.isFinite(seconds) || seconds < 0) return;
    postToContent({ type: 'SEEK_VIDEO', time: seconds });
  }

  function onQaMessagesScroll() {
    if (!qaReplyReadyToast || qaReplyReadyToast.hidden) return;
    const root = qaMessages_el;
    if (!root) return;

    if (qaReplyReadyTargetEl && qaReplyReadyTargetEl.isConnected) {
      const rootRect = root.getBoundingClientRect();
      const targetRect = qaReplyReadyTargetEl.getBoundingClientRect();
      if (targetRect.top <= rootRect.top + root.clientHeight * 0.6) {
        hideQaReplyReadyToast();
        return;
      }
    }
    if (qaIsFollowingLatest()) hideQaReplyReadyToast();
  }

  /**
   * Shown when an assistant message arrives while the user is scrolled up
   * (not “following” the bottom). Uses theme / UI font variables via CSS.
   */
  function showQaReplyReadyToast(targetDiv, content) {
    qaReplyReadyTargetEl = targetDiv;
    if (!qaReplyReadyToast) return;
    const isErr = typeof content === 'string' && content.trim().startsWith('⚠');
    if (qaReplyReadyToastTitle) {
      qaReplyReadyToastTitle.textContent = isErr
        ? 'Reply finished with an error'
        : 'Assistant reply ready';
    }
    if (qaReplyReadyToastSub) {
      qaReplyReadyToastSub.textContent = isErr
        ? 'Click to view the message'
        : 'Click to jump to the start of the reply';
    }
    qaReplyReadyToast.hidden = false;
  }

  function appendChatMsg(role, content, images, scrollMode) {
    const wasFollowing = qaIsFollowingLatest();
    scrollMode = scrollMode || 'default';
    const renderedContent = role === 'assistant'
      ? normalizeLatexForKatex(unescapeMathDelimiters(content))
      : String(content ?? '');

    // images may be an array of data-URLs, a single base64 string (legacy), or falsy
    let imgList = [];
    if (Array.isArray(images)) {
      imgList = images.map(i => i.startsWith('data:') ? i : `data:image/jpeg;base64,${i}`);
    } else if (typeof images === 'string' && images) {
      imgList = [`data:image/jpeg;base64,${images}`];
    }

    const div = document.createElement('div');
    div.className = `chat-msg ${role}`;

    let bubbleHtml = '';
    if (role === 'user' && imgList.length) {
      bubbleHtml += imgList.map(src =>
        `<img class="chat-frame-thumb" src="${src}" alt="Attached image" title="Click to preview full image">`
      ).join('');
    }
    bubbleHtml += `<div class="chat-bubble">${renderMarkdown(renderedContent)}</div>`;
    div.innerHTML = bubbleHtml;

    qaMessages_el.appendChild(div);

    // Render KaTeX in the new message
    if (role === 'assistant' && typeof renderMathInElement === 'function') {
      const bubble = div.querySelector('.chat-bubble');
      if (bubble) {
        renderMathInElement(bubble, {
          delimiters: [
            { left: '$$', right: '$$', display: true },
            { left: '$', right: '$', display: false }
          ],
          throwOnError: false,
          trust: false
        });
      }
    }

    if (scrollMode === 'none') return div;

    if (role === 'user') {
      qaScrollToBottom();
    } else if (_currentTab !== 'qa') {
      // User navigated away from QA while waiting — show cross-tab notification
      showCrossTabNotify(div);
    } else if (wasFollowing) {
      hideQaReplyReadyToast();
      qaScrollToBottom();
    } else if (scrollMode === 'default') {
      showQaReplyReadyToast(div, content);
    }
    return div;
  }

  function appendErrorMsg(content) {
    const wasFollowing = qaIsFollowingLatest();
    const div = document.createElement('div');
    div.className = 'chat-msg assistant chat-msg-error';
    div.innerHTML = `
      <div class="chat-bubble error-bubble">
        <strong>Request failed</strong>
        <p>${escHtml(content)}</p>
        <small>For guide generation, try Block count -> Custom tokens and lower the cap. For Q&amp;A, reduce Thinking or switch model/provider.</small>
      </div>
    `;
    qaMessages_el.appendChild(div);
    if (_currentTab !== 'qa') {
      showCrossTabNotify(div);
    } else if (wasFollowing) {
      qaScrollToBottom();
    } else {
      showQaReplyReadyToast(div, content);
    }
    return div;
  }

  function appendTypingIndicator() {
    const wasFollowing = qaIsFollowingLatest();
    const div = document.createElement('div');
    div.className = 'chat-msg assistant';
    div.innerHTML = `<div class="typing-indicator">
      <div class="typing-dot"></div>
      <div class="typing-dot"></div>
      <div class="typing-dot"></div>
    </div>`;
    qaMessages_el.appendChild(div);
    if (wasFollowing) qaScrollToBottom();
    return div;
  }

  // Lightweight markdown renderer for chat (headings, lists, hr, inline styles, paragraphs, math protection)
  function renderMarkdown(text) {
    const src = String(text || '').replace(/\r\n/g, '\n');
    const lines = src.split('\n');
    const out = [];
    let para = [];
    let listType = null;   // 'ul' | 'ol' | null
    let mathOpen = false;  // true while collecting a cross-line $...$ block
    let mathBuf  = [];
    let mathDollarParity = 0;

    // Count $ delimiters treating $$ as one unit
    const countDollars = (str) => {
      let n = 0, i = 0;
      while (i < str.length) {
        if (str[i] === '$') { n++; i += (str[i + 1] === '$' ? 2 : 1); } else { i++; }
      }
      return n;
    };

    const flushPara = () => {
      if (!para.length) return;
      out.push(`<p>${para.map(l => renderMarkdownInline(l)).join('<br>')}</p>`);
      para = [];
    };
    const flushList = () => {
      if (!listType) return;
      out.push(`</${listType}>`);
      listType = null;
    };

    for (const rawLine of lines) {
      const line    = rawLine.trimEnd();
      const trimmed = line.trim();

      // ── Collecting a cross-line math block ───────────────────────────────
      if (mathOpen) {
        mathBuf.push(line);
        mathDollarParity = (mathDollarParity + countDollars(line)) % 2;
        if (mathDollarParity === 0) {
          // block closed — emit as one element so KaTeX finds complete delimiters
          out.push(`<p class="math-block">${escHtml(mathBuf.join('\n'))}</p>`);
          mathBuf = []; mathOpen = false;
        }
        continue;
      }

      // ── Horizontal rule ───────────────────────────────────────────────────
      if (/^[-*_]{3,}\s*$/.test(trimmed)) {
        flushPara(); flushList();
        out.push('<hr class="md-hr">');
        continue;
      }

      // ── Empty line ────────────────────────────────────────────────────────
      if (!trimmed) { flushPara(); flushList(); continue; }

      // ── Heading ───────────────────────────────────────────────────────────
      const heading = trimmed.match(/^(#{1,4})\s+(.+)$/);
      if (heading) {
        flushPara(); flushList();
        const level = Math.min(4, heading[1].length);
        out.push(`<h${level}>${renderMarkdownInline(heading[2])}</h${level}>`);
        continue;
      }

      // ── Unordered list item ───────────────────────────────────────────────
      const ulM = trimmed.match(/^[-*+]\s+(.+)$/);
      if (ulM) {
        flushPara();
        if (listType === 'ol') flushList();
        if (!listType) { out.push('<ul>'); listType = 'ul'; }
        out.push(`<li>${renderMarkdownInline(ulM[1])}</li>`);
        continue;
      }

      // ── Ordered list item ─────────────────────────────────────────────────
      const olM = trimmed.match(/^\d+[.)]\s+(.+)$/);
      if (olM) {
        flushPara();
        if (listType === 'ul') flushList();
        if (!listType) { out.push('<ol>'); listType = 'ol'; }
        out.push(`<li>${renderMarkdownInline(olM[1])}</li>`);
        continue;
      }

      // ── Detect opening of a cross-line math block ─────────────────────────
      if (countDollars(line) % 2 === 1) {
        flushPara(); flushList();
        mathBuf = [line]; mathDollarParity = 1; mathOpen = true;
        continue;
      }

      // ── Regular paragraph line ────────────────────────────────────────────
      if (listType) flushList();
      para.push(line);
    }

    // Flush any remaining state
    if (mathOpen) out.push(`<p class="math-block">${escHtml(mathBuf.join('\n'))}</p>`);
    flushPara();
    flushList();
    return out.join('');
  }

  /**
   * Apply inline markdown to a single streaming text chunk.
   * Used by Layer B of flushQaStream so users see formatted text
   * while the response is still being generated.
   */
  function applyStreamingLineMarkdown(line) {
    const t = line.trim();
    if (!t) return '';
    // Horizontal rule
    if (/^[-*_]{3,}\s*$/.test(t)) return '<hr class="md-hr">';
    // Unordered list item — render as bullet
    const ulM = t.match(/^[-*+]\s+(.+)$/);
    if (ulM) return '• ' + renderMarkdownInline(ulM[1]);
    // Ordered list item
    const olM = t.match(/^(\d+)[.)]\s+(.+)$/);
    if (olM) return olM[1] + '. ' + renderMarkdownInline(olM[2]);
    // Default: inline markdown (bold, italic, timestamps, code spans)
    return renderMarkdownInline(line);
  }

  function renderMarkdownInline(text) {
    let s = escHtml(String(text || ''));

    // Stash spans that must not be touched by bold/italic substitution.
    // Uses null-byte delimiters (\x00) which never appear in normal text.
    const stash = [];
    const protect = (raw) => { const i = stash.push(raw) - 1; return `\x00S${i}\x00`; };

    // 1. Inline code  (highest priority)
    s = s.replace(/`([^`]+)`/g, (_, inner) => protect(`<code>${inner}</code>`));

    // 2. Inline math  $$...$$ then $...$
    //    After escHtml, $ is unchanged; protect math so * inside doesn't become <em>.
    s = s.replace(/\$\$([^$][\s\S]*?)\$\$/g, (m) => protect(m));
    s = s.replace(/\$([^$\n]+)\$/g, (m) => protect(m));

    // 3. Bold / italic — now safe, math is stashed
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');

    // 4. Timestamps
    s = s.replace(/\[(\d{2}):([0-5]\d):([0-5]\d)\]/g, (_, hh, mm, ss) => {
      const seconds = Number(hh) * 3600 + Number(mm) * 60 + Number(ss);
      return `<button type="button" class="qa-timestamp-link" data-seconds="${seconds}">[${hh}:${mm}:${ss}]</button>`;
    });

    // 5. Restore stash
    s = s.replace(/\x00S(\d+)\x00/g, (_, idx) => stash[Number(idx)] || '');
    return s;
  }

  // ─── History Persistence ──────────────────────────────────────────────────

  function persistChat() {
    storageSet({ currentQaMessages: qaMessages });
    saveToHistory();
  }

  // ─── History: lecture ID assignment ──────────────────────────────────────
  // lectureIdMap: { [normalizedUrl]: { number, courseKey } }
  // Numbers are permanent per URL — deletion does not free a slot.

  function assignLectureNumber(norm, courseKey, idMap) {
    if (idMap[norm]) return idMap[norm].number;          // already assigned
    const sameCoursePeers = Object.values(idMap).filter(v => v.courseKey === courseKey);
    const nextNum = sameCoursePeers.length
      ? Math.max(...sameCoursePeers.map(v => v.number)) + 1
      : 1;
    idMap[norm] = { number: nextNum, courseKey };
    return nextNum;
  }

  function saveToHistory() {
    if (!guide?.guide?.length || !currentLectureUrl) return;
    const norm      = normalizeLectureUrl(currentLectureUrl);
    const courseKey = transcript?.courseKey || deriveCourseKeyFromUrl(currentLectureUrl);
    const courseName= transcript?.courseName || transcript?.lectureTitle || 'Unknown Course';

    chrome.storage?.local?.get(['guideHistory', 'lectureIdMap'], saved => {
      let history = Array.isArray(saved.guideHistory) ? [...saved.guideHistory] : [];
      const idMap  = (typeof saved.lectureIdMap === 'object' && saved.lectureIdMap) ? { ...saved.lectureIdMap } : {};

      const lectureNumber = assignLectureNumber(norm, courseKey, idMap);
      const prevSame = history.find(h => normalizeLectureUrl(h.lectureUrl) === norm);
      history = history.filter(h => normalizeLectureUrl(h.lectureUrl) !== norm);

      const entry = {
        lectureUrl:    currentLectureUrl,
        lectureTitle:  transcript?.lectureTitle || guide?.lecture_title || 'Lecture',
        lectureDate:   transcript?.lectureDate  || null,
        guideDate:     new Date().toISOString(),
        date:          new Date().toISOString(),   // kept for back-compat
        courseKey,
        courseName,
        lectureNumber,
        guide,
        // unlimitedStorage permission allows keeping images; they persist across sessions.
        qaMessages: qaMessages.length ? qaMessages : (prevSame?.qaMessages || [])
      };
      history.unshift(entry);
      if (history.length > 50) history.length = 50;
      storageSet({ guideHistory: history, lectureIdMap: idMap });
    });
  }

  /** Fallback course-key derivation for URLs already in storage without a courseKey. */
  function deriveCourseKeyFromUrl(href) {
    if (!href) return 'other';
    try {
      const parts = new URL(href).pathname.split('/').filter(Boolean);
      if (parts[0] === 'lectures' && parts.length >= 5) return `${parts[1]}::${parts[4]}`;
      return parts.slice(0, 3).join('::') || 'other';
    } catch { return 'other'; }
  }

  /** Extract { year, season } from a lecture URL for the year/season tree grouping. */
  function extractYearSeason(href) {
    try {
      const parts = new URL(href).pathname.split('/').filter(Boolean);
      // ['lectures', 'd-infk', '2026', 'spring', '01337', ...]
      if (parts[0] === 'lectures' && parts.length >= 4) {
        const yr = /^\d{4}$/.test(parts[2]) ? parts[2] : null;
        const raw = parts[3] || '';
        const sn = /^(spring|fall|autumn|winter|summer|herbst|frühling|sommer)$/i.test(raw)
          ? raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase()
          : null;
        if (yr && sn) return { year: yr, season: sn };
      }
    } catch {}
    return { year: 'Other', season: '' };
  }

  const SEASON_ORDER = { Spring: 0, Summer: 1, Autumn: 2, Fall: 2, Herbst: 2, Winter: 3 };

  function loadHistory() {
    const container = document.getElementById('history-list');
    if (!container) return;
    // Reset saved search state whenever history reloads
    _historySearchPreState = null;
    container.innerHTML = '<p style="color:var(--text-muted);font-size:12px;padding:14px 16px;">Loading…</p>';

    chrome.storage?.local?.get(['guideHistory', 'hiddenCourses'], saved => {
      const history   = Array.isArray(saved.guideHistory) ? saved.guideHistory : [];
      const hiddenSet = new Set(Array.isArray(saved.hiddenCourses) ? saved.hiddenCourses : []);

      if (!history.length) {
        container.innerHTML = `
          <div class="history-empty">
            <span class="history-empty-mark">§</span>
            <p class="history-empty-text">No guides generated yet.</p>
          </div>`;
        return;
      }

      // ── Repair pass: fix courseNames that don't match the lecture ──────────
      // Bug: extractCourseName() used 'nav a' which grabbed the alphabetically
      // first entry in the ETH course-list sidebar nav (e.g. "Building Control
      // and Automation") for every lecture, regardless of the actual course.
      // Heuristic: if the stored courseName does not appear anywhere in the
      // lectureTitle, re-derive it by stripping the "– Lecture N" suffix.
      const _BAD_NAME_RE  = /^(spring|fall|autumn|winter|summer|herbst|früh?ling|sommer|lectures?|d-\w{1,8}|\d{4}|lecture)$/i;
      const _isBadName    = n => !n || _BAD_NAME_RE.test(n.trim());
      const _deriveName   = e => {
        const t = (e.lectureTitle || '').trim();
        return t.replace(/[\s—–-]+lecture\s*\d+.*/i, '').replace(/[\s—–-]+\d{4}.*/i, '').trim() || t || 'Lecture';
      };
      const _nameConflict = e => {
        if (_isBadName(e.courseName)) return true;
        if (!e.courseName || !e.lectureTitle) return false;
        // If the stored course name (first 12 chars) does not appear in the
        // lecture title, it's stale data from the wrong nav element.
        const cn = e.courseName.toLowerCase();
        const lt = e.lectureTitle.toLowerCase();
        return !lt.includes(cn.slice(0, Math.min(cn.length, 12)));
      };
      const patchedHistory = history.map(e => ({
        ...e,
        courseKey:  e.courseKey  || deriveCourseKeyFromUrl(e.lectureUrl),
        courseName: _nameConflict(e) ? _deriveName(e) : e.courseName,
      }));
      if (history.some(e => _nameConflict(e))) {
        storageSet({ guideHistory: patchedHistory });
      }

      const normCurrent    = normalizeLectureUrl(currentLectureUrl);
      const activeCourseKey = patchedHistory.find(e => normalizeLectureUrl(e.lectureUrl) === normCurrent)?.courseKey;

      // ── Group by courseKey ────────────────────────────────────────────────
      const groups = {};
      for (const entry of patchedHistory) {
        const k = entry.courseKey || 'other';
        if (!groups[k]) groups[k] = { courseName: entry.courseName, entries: [], yearSeason: extractYearSeason(entry.lectureUrl) };
        groups[k].entries.push(entry);
      }

      for (const g of Object.values(groups)) {
        g.entries.sort((a, b) => {
          const da = a.lectureDate || a.guideDate || a.date || '';
          const db = b.lectureDate || b.guideDate || b.date || '';
          return da < db ? -1 : da > db ? 1 : 0;
        });
        const allHaveNumbers = g.entries.every(e => typeof e.lectureNumber === 'number');
        g.entries.forEach((e, i) => { e._displayNum = allHaveNumbers ? e.lectureNumber : (i + 1); });
      }

      container.innerHTML = '';

      // ── Section A: Recent ─────────────────────────────────────────────────
      const allEntriesByDate = [...patchedHistory].sort((a, b) => {
        const da = a.guideDate || a.date || '';
        const db = b.guideDate || b.date || '';
        return da > db ? -1 : da < db ? 1 : 0;
      });
      // Attach _displayNum from their group for display
      allEntriesByDate.forEach(e => {
        const g = groups[e.courseKey || 'other'];
        e._displayNum = g ? e._displayNum : null;
      });
      container.appendChild(buildRecentSection(allEntriesByDate, normCurrent, hiddenSet));

      // ── Section B: Year/Season tree ───────────────────────────────────────
      const visibleKeys = Object.keys(groups).filter(k => !hiddenSet.has(k));
      const hiddenKeys  = Object.keys(groups).filter(k =>  hiddenSet.has(k));

      // Build Year → Season → [courseKeys] index
      const yearTree = {}; // { year: { season: [courseKey] } }
      for (const k of visibleKeys) {
        const { year, season } = groups[k].yearSeason;
        const yr = year || 'Other';
        const sn = season || 'Other';
        if (!yearTree[yr]) yearTree[yr] = {};
        if (!yearTree[yr][sn]) yearTree[yr][sn] = [];
        yearTree[yr][sn].push(k);
      }

      // Sort years descending, seasons by calendar order
      const sortedYears = Object.keys(yearTree).sort((a, b) => {
        if (a === 'Other') return 1;
        if (b === 'Other') return -1;
        return b.localeCompare(a);
      });

      // Determine active path for auto-open
      const activeEntry = patchedHistory.find(e => normalizeLectureUrl(e.lectureUrl) === normCurrent);
      const activeYS = activeEntry ? extractYearSeason(activeEntry.lectureUrl) : null;

      for (const year of sortedYears) {
        const yearEl = buildYearGroup(year, yearTree[year], groups, hiddenSet, activeCourseKey, activeYS);
        container.appendChild(yearEl);
      }

      // Hidden courses at the bottom (same as before)
      if (hiddenKeys.length) {
        const hiddenSection = document.createElement('details');
        hiddenSection.className = 'history-hidden-section';
        hiddenSection.innerHTML = `<summary class="history-hidden-summary">Hidden courses (${hiddenKeys.length})</summary>`;
        for (const k of hiddenKeys) {
          hiddenSection.appendChild(buildCourseGroup(k, groups[k], hiddenSet, true, activeCourseKey));
        }
        container.appendChild(hiddenSection);
      }
    });
  }

  const RECENT_PAGE_SIZE = 6;

  function buildRecentSection(entriesByDate, normCurrent, hiddenSet) {
    const wrapper = document.createElement('details');
    wrapper.className = 'history-recent-group';
    wrapper.innerHTML = `<summary class="history-recent-summary">
      <span class="history-recent-chevron">›</span>
      <span class="history-recent-label">Recent</span>
      <span class="history-recent-count">${entriesByDate.length} guide${entriesByDate.length !== 1 ? 's' : ''}</span>
    </summary>`;

    let shownCount = 0;
    const itemsContainer = document.createElement('div');
    itemsContainer.className = 'history-recent-items';

    function renderPage() {
      const slice = entriesByDate.slice(shownCount, shownCount + RECENT_PAGE_SIZE);
      slice.forEach(entry => {
        itemsContainer.appendChild(buildRecentItem(entry, normCurrent));
      });
      shownCount += slice.length;
      if (shownCount < entriesByDate.length) {
        const remaining = entriesByDate.length - shownCount;
        const next = Math.min(RECENT_PAGE_SIZE, remaining);
        const moreBtn = document.createElement('button');
        moreBtn.className = 'history-show-more-btn';
        moreBtn.textContent = `Show ${next} more`;
        moreBtn.addEventListener('click', () => {
          moreBtn.remove();
          renderPage();
        });
        itemsContainer.appendChild(moreBtn);
      }
    }
    renderPage();

    wrapper.appendChild(itemsContainer);
    return wrapper;
  }

  function buildRecentItem(entry, normCurrent) {
    const isActive = normalizeLectureUrl(entry.lectureUrl) === normCurrent;

    // Lecture upload date (when the lecture was recorded/published)
    const lectureDate = entry.lectureDate;
    const lectureDateLabel = lectureDate
      ? new Date(lectureDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
      : null;

    // Guide creation date
    const guideDate = entry.guideDate || entry.date;
    const guideDateLabel = guideDate
      ? new Date(guideDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
      : '—';

    const div = document.createElement('div');
    div.className = 'history-recent-item' + (isActive ? ' history-active' : '');
    div.innerHTML = `
      <div class="history-recent-item-meta">
        <span class="history-recent-course">${escHtml(entry.courseName || '—')}</span>
        <span class="history-recent-date">${lectureDateLabel ? lectureDateLabel : guideDateLabel}</span>
      </div>
      <div class="history-recent-item-title">${escHtml(entry.lectureTitle)}</div>
      ${lectureDateLabel ? `<div class="history-guide-date">Guide created: ${guideDateLabel}</div>` : ''}
      <div class="history-actions history-recent-actions">
        <button class="history-load-btn" title="Load guide">Load</button>
        <button class="history-pdf-btn" type="button" title="Export as PDF">PDF</button>
      </div>
    `;
    div.querySelector('.history-load-btn').addEventListener('click', () => loadHistoryEntry(entry));
    div.querySelector('.history-pdf-btn').addEventListener('click', () => {
      if (entry.guide?.guide?.length) openGuidePrintWindow(entry.guide, entry.lectureTitle);
    });
    return div;
  }

  function buildYearGroup(year, seasonMap, groups, hiddenSet, activeCourseKey, activeYS) {
    const isActiveYear = activeYS?.year === year;
    const totalGuides  = Object.values(seasonMap).flat().reduce((n, k) => n + (groups[k]?.entries.length || 0), 0);

    const details = document.createElement('details');
    details.className = 'history-year-group';
    if (isActiveYear) details.open = true;
    details.innerHTML = `<summary class="history-year-summary">
      <span class="history-year-chevron">›</span>
      <span class="history-year-label">${escHtml(year)}</span>
      <span class="history-year-count">${totalGuides} guide${totalGuides !== 1 ? 's' : ''}</span>
    </summary>`;

    const sortedSeasons = Object.keys(seasonMap).sort((a, b) => {
      const oa = SEASON_ORDER[a] ?? 99;
      const ob = SEASON_ORDER[b] ?? 99;
      return oa !== ob ? oa - ob : a.localeCompare(b);
    });

    for (const season of sortedSeasons) {
      const courseKeys = seasonMap[season];
      const isActiveSeason = isActiveYear && activeYS?.season === season;
      const seasonDetails = buildSeasonGroup(season, courseKeys, groups, hiddenSet, activeCourseKey, isActiveSeason);
      details.appendChild(seasonDetails);
    }

    return details;
  }

  function buildSeasonGroup(season, courseKeys, groups, hiddenSet, activeCourseKey, isActiveSeason) {
    const totalGuides = courseKeys.reduce((n, k) => n + (groups[k]?.entries.length || 0), 0);

    const details = document.createElement('details');
    details.className = 'history-season-group';
    if (isActiveSeason) details.open = true;
    details.innerHTML = `<summary class="history-season-summary">
      <span class="history-season-chevron">›</span>
      <span class="history-season-label">${escHtml(season)}</span>
      <span class="history-season-count">${totalGuides} guide${totalGuides !== 1 ? 's' : ''}</span>
    </summary>`;

    // Sort courses: active first, then alphabetically
    const sortedCourseKeys = [...courseKeys].sort((a, b) => {
      if (a === activeCourseKey) return -1;
      if (b === activeCourseKey) return  1;
      return groups[a].courseName.localeCompare(groups[b].courseName);
    });

    for (const k of sortedCourseKeys) {
      details.appendChild(buildCourseGroup(k, groups[k], hiddenSet, false, activeCourseKey));
    }

    return details;
  }

  function buildCourseGroup(courseKey, group, hiddenSet, isHidden, activeCourseKey) {
    const normCurrent = normalizeLectureUrl(currentLectureUrl);
    const hasActive   = group.entries.some(e => normalizeLectureUrl(e.lectureUrl) === normCurrent);
    const count       = group.entries.length;

    const details = document.createElement('details');
    details.className = 'history-course-group';
    if (hasActive || count <= 3) details.open = true;

    const guideWord = count === 1 ? 'guide' : 'guides';
    details.innerHTML = `
      <summary class="history-course-summary">
        <span class="history-course-chevron">›</span>
        <span class="history-course-name">${escHtml(group.courseName)}</span>
        <span class="history-course-count">${count} ${guideWord}</span>
        <button class="history-course-predict-btn" title="Predict exam questions across lectures in this course" data-key="${escAttr(courseKey)}">
          Predict exam
        </button>
        <button class="history-course-hide-btn" title="${isHidden ? 'Unhide course' : 'Hide course'}" data-key="${escAttr(courseKey)}">
          ${isHidden ? 'Unhide' : 'Hide'}
        </button>
      </summary>
    `;

    details.querySelector('.history-course-predict-btn').addEventListener('click', e => {
      e.stopPropagation();
      e.preventDefault();
      openCrossExamModalForCourse(group.entries);
    });

    details.querySelector('.history-course-hide-btn').addEventListener('click', e => {
      e.stopPropagation();
      e.preventDefault();
      if (isHidden) unhideHistoryCourse(courseKey);
      else          hideHistoryCourse(courseKey);
    });

    for (const entry of group.entries) {
      const isActive    = normalizeLectureUrl(entry.lectureUrl) === normCurrent;
      const num         = entry._displayNum;
      const blockCount  = entry.guide?.guide?.length || 0;
      const chatCount   = Math.floor((entry.qaMessages?.length || 0) / 2);

      // Prefer lecture upload date for display; fall back to guide creation date
      const displayDate = entry.lectureDate || entry.guideDate || entry.date;
      const guideDate   = entry.guideDate || entry.date;
      const dateLabel   = displayDate
        ? new Date(displayDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
        : '—';
      const guideDateLabel = guideDate
        ? new Date(guideDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
        : '';

      const item = document.createElement('div');
      item.className = 'history-item' + (isActive ? ' history-active' : '');

      item.innerHTML = `
        <div class="history-item-header">
          <span class="history-lecture-num">${num}</span>
          <span class="history-title">${escHtml(entry.lectureTitle)}</span>
        </div>
        <div class="history-meta">
          <span title="Lecture date">${dateLabel}</span>
          <span>${blockCount} block${blockCount !== 1 ? 's' : ''}</span>
          ${chatCount ? `<span>${chatCount} Q&amp;A${chatCount !== 1 ? 's' : ''}</span>` : ''}
        </div>
        ${guideDateLabel ? `<div class="history-guide-date">Guide created: ${guideDateLabel}</div>` : ''}
        <div class="history-actions">
          <a class="history-link" href="${escAttr(entry.lectureUrl)}" target="_blank" title="Open lecture page">Open lecture</a>
          <button class="history-load-btn" title="Load guide">Load</button>
          <button class="history-pdf-btn" type="button" title="Export as PDF">PDF</button>
          ${!isActive ? `<button class="history-delete-btn" title="Delete guide">Delete</button>` : ''}
        </div>
      `;

      item.querySelector('.history-load-btn').addEventListener('click', () => loadHistoryEntry(entry));
      item.querySelector('.history-pdf-btn').addEventListener('click', () => {
        if (entry.guide?.guide?.length) openGuidePrintWindow(entry.guide, entry.lectureTitle);
      });
      const delBtn = item.querySelector('.history-delete-btn');
      if (delBtn) delBtn.addEventListener('click', () => deleteHistoryEntry(entry.lectureUrl));

      details.appendChild(item);
    }

    return details;
  }

  function hideHistoryCourse(courseKey) {
    chrome.storage?.local?.get(['hiddenCourses'], saved => {
      const hidden = new Set(Array.isArray(saved.hiddenCourses) ? saved.hiddenCourses : []);
      hidden.add(courseKey);
      storageSet({ hiddenCourses: [...hidden] }, () => loadHistory());
    });
  }

  function unhideHistoryCourse(courseKey) {
    chrome.storage?.local?.get(['hiddenCourses'], saved => {
      const hidden = new Set(Array.isArray(saved.hiddenCourses) ? saved.hiddenCourses : []);
      hidden.delete(courseKey);
      storageSet({ hiddenCourses: [...hidden] }, () => loadHistory());
    });
  }

  function loadHistoryEntry(entry) {
    // Guard: if there's an active guide for a DIFFERENT URL with unsaved Q&A, prompt
    const differentLecture = currentLectureUrl &&
      normalizeLectureUrl(entry.lectureUrl) !== normalizeLectureUrl(currentLectureUrl);
    if (differentLecture && guide?.guide?.length && qaMessages.length > 0) {
      const proceed = window.confirm(
        'Loading this history entry will replace your current guide and Q&A conversation. Continue?'
      );
      if (!proceed) return;
    }

    guide = entry.guide;
    qaMessages = Array.isArray(entry.qaMessages) ? entry.qaMessages : [];
    transcript = transcript || { cues: [], text: '', lectureTitle: entry.lectureTitle, videoDuration: 0 };

    showGuideContent();
    setStatus('ready', `Guide loaded · ${guide.guide.length} blocks`);

    qaMessages_el.innerHTML = '';
    if (qaMessages.length) {
      restoreChatUI();
    } else {
      qaMessages_el.innerHTML = '<div class="qa-welcome"><p>Ask anything about this lecture.</p></div>';
    }
    switchTab('guide');
  }

  let _deleteUndoTimer = null;
  let _deletedEntry = null;
  let _deletedOriginalHistory = null;

  function deleteHistoryEntry(url) {
    // Removes the guide entry but preserves the lectureIdMap slot (number stays reserved)
    chrome.storage?.local?.get(['guideHistory'], saved => {
      const history = saved.guideHistory || [];
      const deleted = history.find(h => h.lectureUrl === url);
      if (!deleted) return;
      _deletedEntry = deleted;
      _deletedOriginalHistory = history;
      const filtered = history.filter(h => h.lectureUrl !== url);
      storageSet({ guideHistory: filtered }, () => loadHistory());

      // Show undo toast
      const toast = document.getElementById('history-undo-toast');
      const msg = document.getElementById('history-undo-msg');
      const undoBtn = document.getElementById('history-undo-btn');
      if (toast && msg && undoBtn) {
        msg.textContent = `"${deleted.lectureTitle || 'Entry'}" deleted`;
        toast.hidden = false;
        clearTimeout(_deleteUndoTimer);
        _deleteUndoTimer = setTimeout(() => {
          toast.hidden = true;
          _deletedEntry = null;
          _deletedOriginalHistory = null;
        }, 5000);
        undoBtn.onclick = () => {
          clearTimeout(_deleteUndoTimer);
          toast.hidden = true;
          if (_deletedOriginalHistory) {
            storageSet({ guideHistory: _deletedOriginalHistory }, () => loadHistory());
          }
          _deletedEntry = null;
          _deletedOriginalHistory = null;
        };
      }
    });
  }

  /** Saved accordion open/close state before search started */
  let _historySearchPreState = null;

  function onHistorySearch() {
    const q = (document.getElementById('history-search')?.value || '').trim().toLowerCase();
    const list = document.getElementById('history-list');
    const clearBtn = document.getElementById('history-search-clear');
    if (!list) return;

    if (clearBtn) clearBtn.hidden = !q;

    if (!q) {
      // Restore all visibility
      list.querySelectorAll('[data-hidden]').forEach(el => delete el.dataset.hidden);
      // Restore accordion open/closed states from before search
      if (_historySearchPreState) {
        _historySearchPreState.forEach(({ el, open }) => {
          if (el.isConnected) el.open = open;
        });
        _historySearchPreState = null;
      }
      return;
    }

    // Save accordion state before first search modifies it
    if (!_historySearchPreState) {
      _historySearchPreState = Array.from(list.querySelectorAll('details'))
        .map(el => ({ el, open: el.open }));
    }

    // Course groups — match on course name or lecture titles within
    list.querySelectorAll('.history-course-group').forEach(group => {
      const courseName = group.querySelector('.history-course-name')?.textContent?.toLowerCase() || '';
      const titles = Array.from(group.querySelectorAll('.history-title, .history-recent-item-title'))
        .map(el => el.textContent.toLowerCase());
      const match = courseName.includes(q) || titles.some(t => t.includes(q));
      if (match) { delete group.dataset.hidden; group.open = true; }
      else group.dataset.hidden = '';
    });

    // Recent items — show individually based on title or course name
    list.querySelectorAll('.history-recent-item').forEach(item => {
      const text = item.textContent.toLowerCase();
      if (text.includes(q)) delete item.dataset.hidden; else item.dataset.hidden = '';
    });

    // Recent group — open if any item is visible
    const recentGroup = list.querySelector('.history-recent-group');
    if (recentGroup) {
      const hasVisible = Array.from(recentGroup.querySelectorAll('.history-recent-item'))
        .some(i => i.dataset.hidden === undefined);
      if (hasVisible) recentGroup.open = true;
    }

    // Season groups — hide if all courses hidden, else open
    list.querySelectorAll('.history-season-group').forEach(season => {
      const allHidden = Array.from(season.querySelectorAll('.history-course-group'))
        .every(g => g.dataset.hidden !== undefined);
      if (allHidden) season.dataset.hidden = '';
      else { delete season.dataset.hidden; season.open = true; }
    });

    // Year groups — hide if all seasons hidden, else open
    list.querySelectorAll('.history-year-group').forEach(year => {
      const allHidden = Array.from(year.querySelectorAll('.history-season-group'))
        .every(s => s.dataset.hidden !== undefined);
      if (allHidden) year.dataset.hidden = '';
      else { delete year.dataset.hidden; year.open = true; }
    });
  }

  // ─── Tab Switching ────────────────────────────────────────────────────────

  let _currentTab = 'guide';

  function switchTab(tabName) {
    _currentTab = tabName;
    if (tabName === 'qa') {
      hideCrossTabNotify();
    } else {
      hideQaReplyReadyToast();
    }
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tabName));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('active', c.id === `tab-${tabName}`));
    const toolsHintBar = document.getElementById('tools-hint-bar');
    if (toolsHintBar) toolsHintBar.hidden = tabName !== 'tools';
    if (tabName === 'history') loadHistory();
  }

  // ─── Cross-tab QA notification ────────────────────────────────────────────
  // Shows when user is on Guide/History and a QA reply arrives.

  let _crossTabNotifyTarget = null;
  const _crossTabNotify      = () => document.getElementById('cross-tab-notify');
  const _crossTabNotifyClose = () => document.getElementById('cross-tab-notify-close');
  const _crossTabNotifyBtn   = () => document.getElementById('cross-tab-notify-action');

  function showCrossTabNotify(targetDiv) {
    _crossTabNotifyTarget = targetDiv;
    const el = _crossTabNotify();
    if (!el) return;
    el.hidden = false;
  }

  function hideCrossTabNotify() {
    _crossTabNotifyTarget = null;
    const el = _crossTabNotify();
    if (el) el.hidden = true;
  }

  // ─── QA Scroll-to-bottom button ───────────────────────────────────────────

  function initQaScrollButton() {
    const btn = document.getElementById('qa-scroll-bottom-btn');
    if (!btn || !qaMessages_el) return;

    const update = () => {
      btn.hidden = qaIsFollowingLatest();
    };
    qaMessages_el.addEventListener('scroll', update, { passive: true });
    btn.addEventListener('click', () => {
      qaScrollToBottom();
      btn.hidden = true;
    });
    update();
  }

  // ─── Theme ────────────────────────────────────────────────────────────────

  const THEMES = ['dark', 'light', 'dark-blue', 'light-white'];
  const THEME_LABELS = { dark: 'Warm Dark', light: 'Cream Light', 'dark-blue': 'Navy Blue', 'light-white': 'Clean White' };

  function toggleTheme() {
    const html = document.documentElement;
    const current = html.dataset.theme || 'dark';
    const idx = THEMES.indexOf(current);
    const next = THEMES[(idx + 1) % THEMES.length];
    html.dataset.theme = next;
    localStorage.setItem('eth-copilot-theme', next);
    updateThemeToggleTooltip(next);
    applyUISettings();
  }

  function updateThemeToggleTooltip(theme) {
    if (!themeToggle) return;
    const next = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
    themeToggle.title = `Theme: ${THEME_LABELS[theme] || theme} → click for ${THEME_LABELS[next] || next}`;
  }

  function applyStoredTheme() {
    const saved = localStorage.getItem('eth-copilot-theme');
    if (saved) {
      document.documentElement.dataset.theme = saved;
      updateThemeToggleTooltip(saved);
    }
  }

  async function applyUISettings() {
    if (!window.UISettings) return;
    const ui = await UISettings.load();
    UISettings.applyColorsToDocument(document, ui);
    UISettings.applySidebarTextSizes(document, ui);
  }

  // ─── Status Bar ───────────────────────────────────────────────────────────

  function setStatus(type, text) {
    statusBar.className = `status-bar status-${type}`;
    statusText.textContent = text;
    const spinner = statusBar.querySelector('.status-spinner');
    if (spinner) spinner.style.display = type === 'loading' ? 'block' : 'none';
  }

  // ─── Utilities ────────────────────────────────────────────────────────────

  function escHtml(str) {
    return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function escAttr(str) {
    return String(str || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function unescapeMathDelimiters(str) {
    return String(str || '').replace(/\\\$/g, '$');
  }

  function normalizeLatexForKatex(str) {
    // ── Step 1: Collapse multi-line display math ──────────────────────────────
    // AI often outputs:   $$\n<math>\n$$   (opening/closing $$ on their own line)
    // Our renderMarkdown splits on newlines → the opening $$ and content end up
    // in separate <p> elements → KaTeX never finds the delimiters.
    // Fix: if $$ appears alone on a line, merge the whole block to one span.
    str = String(str || '').replace(/\$\$[ \t]*\n([\s\S]*?)\n[ \t]*\$\$/g, (_m, inner) =>
      '$$' + inner + '$$'
    );
    // ── Step 2: \sideset transformation ──────────────────────────────────────
    return str.replace(
      /\\sideset\s*\{([^{}]*)\}\s*\{([^{}]*)\}\s*([\\a-zA-Z]+|\{[^{}]+\})/g,
      (_m, left, right, op) => {
        const l = parseScriptSpec(left);
        const r = parseScriptSpec(right);
        const leftPart = `${l.sub || ''}${l.sup || ''}` ? `{}` + (l.sub || '') + (l.sup || '') + '\\!' : '';
        const rightPart = (r.sub || '') + (r.sup || '');
        return `${leftPart}${op}${rightPart}`;
      }
    );
  }

  function parseScriptSpec(spec) {
    const out = { sub: '', sup: '' };
    const s = String(spec || '').trim();
    const re = /([_^])(\{[^{}]*\}|[^_^{}\s]+)/g;
    let m;
    while ((m = re.exec(s)) !== null) {
      const kind = m[1];
      const raw = m[2];
      const wrapped = raw.startsWith('{') ? raw : `{${raw}}`;
      if (kind === '_') out.sub = `_${wrapped}`;
      if (kind === '^') out.sup = `^${wrapped}`;
    }
    return out;
  }

  function fmtSec(s) {
    s = Math.floor(s || 0);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
  }

  function renderFormulaLatexForExport(latex) {
    try {
      return katex.renderToString(normalizeLatexForKatex(String(latex || '')), { displayMode: true, throwOnError: false, trust: false });
    } catch (e) {
      return `<span class="formula-fallback">${escHtml(latex)}</span>`;
    }
  }

  function renderInlineLatexForExport(text) {
    return normalizeLatexForKatex(unescapeMathDelimiters(text))
      .split(/(\$[^$\n]+\$)/g)
      .map(part => {
        if (part.startsWith('$') && part.endsWith('$') && part.length > 2) {
          try {
            return katex.renderToString(part.slice(1, -1), { displayMode: false, throwOnError: false, trust: false });
          } catch (e) {
            return escHtml(part);
          }
        }
        return escHtml(part);
      })
      .join('');
  }

  function buildExportBlockHtml(block) {
    let html = `
      <div class="export-block">
        <div>
          <div class="block-title">${escHtml(block.title)}</div>
          <div class="block-timestamp">${fmtSec(block.start_time)} – ${fmtSec(block.end_time)}</div>
        </div>
    `;

    if (block.key_concepts?.length) {
      html += `<div>
        <div class="section-label">Key Concepts</div>
        <ul class="concepts-list">
          ${block.key_concepts.map(c => `<li><span class="concept-text">${renderInlineLatexForExport(c)}</span></li>`).join('')}
        </ul>
      </div>`;
    }

    if (block.formulas?.length) {
      html += `<div>
        <div class="section-label">Formulas</div>
        ${block.formulas.map(f => `
          <div class="formula-card">
            <div class="formula-label">${escHtml(f.label)}</div>
            <div class="formula-render-wrap">${renderFormulaLatexForExport(f.latex)}</div>
          </div>
        `).join('')}
      </div>`;
    }

    if (block.definitions?.length) {
      html += `<div>
        <div class="section-label">Definitions</div>
        ${block.definitions.map(d => `
          <div class="definition-item">
            <div class="definition-term">${renderInlineLatexForExport(d.term)}</div>
            <div class="definition-text">${renderInlineLatexForExport(d.definition)}</div>
          </div>
        `).join('')}
      </div>`;
    }

    if (block.notes?.trim()) {
      html += `
        <div class="notes-box">
          <div class="notes-icon-label">Note</div>
          <div class="notes-text">${renderInlineLatexForExport(block.notes)}</div>
        </div>
      `;
    }

    html += '</div>';
    return html;
  }

  function buildGuideExportBodyHtml(guideObj) {
    if (!guideObj?.guide?.length) return '';
    return guideObj.guide.map(b => buildExportBlockHtml(b)).join('');
  }

  function openGuidePrintWindow(guideObj, lectureTitle) {
    if (!guideObj?.guide?.length) {
      setStatus('warning', 'No guide to export');
      return;
    }
    if (typeof chrome === 'undefined' || !chrome.runtime?.getURL) {
      setStatus('error', 'Export unavailable in this context');
      return;
    }
    const bodyHtml = buildGuideExportBodyHtml(guideObj);
    const title = lectureTitle || guideObj.lecture_title || 'Lecture guide';
    const n = guideObj.guide.length;
    const dur = guideObj.total_duration_seconds;
    const subtitle = `${n} section${n === 1 ? '' : 's'} · ${fmtSec(dur || 0)} total`;
    const payload = { title, subtitle, bodyHtml };
    try {
      localStorage.setItem('eth-copilot-print-guide', JSON.stringify(payload));
      window.open(chrome.runtime.getURL('sidebar/print-guide.html'), '_blank');
      setStatus('ready', 'Print view opened — use “Save as PDF” in the print dialog');
    } catch (e) {
      console.error('[Copilot] export PDF', e);
      setStatus('error', 'Export failed: ' + (e.message || String(e)));
    }
  }

  /**
   * Collect all terms defined in the guide (definitions.term fields).
   * Returns a Set of lowercased terms for WikiLink matching.
   */
  function collectGuideTerms(guideObj) {
    const terms = new Set();
    for (const block of (guideObj?.guide || [])) {
      for (const d of (block.definitions || [])) {
        if (d.term) terms.add(d.term.trim());
      }
    }
    return terms;
  }

  /**
   * Wrap recurring defined terms with [[WikiLinks]] in a text string.
   * Only wraps the first occurrence per term per block to avoid noise.
   */
  function applyWikiLinks(text, terms) {
    if (!terms.size) return text;
    let result = text;
    for (const term of terms) {
      // Escape special regex characters in the term
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`(?<![\\[#*_])\\b(${escaped})\\b(?![\\]])`, 'gi');
      let applied = false;
      result = result.replace(re, (match) => {
        if (applied) return match; // only first occurrence
        applied = true;
        return `[[${match}]]`;
      });
    }
    return result;
  }

  function exportGuideAsMarkdown() {
    if (!guide?.guide?.length) {
      setStatus('warning', 'No guide to export');
      return;
    }
    const title = transcript?.lectureTitle || guide.lecture_title || 'Lecture Guide';
    const now = new Date();
    const isoDate = now.toISOString().split('T')[0];
    const courseName = transcript?.courseName || '';
    const lectureUrl = transcript?.lectureUrl || currentLectureUrl || '';
    const platform   = transcript?.platform || 'video.ethz.ch';

    // ── YAML frontmatter ──────────────────────────────────────────────────
    const tags = ['lecture-guide'];
    if (courseName) tags.push(courseName.replace(/\s+/g, '-').toLowerCase());
    const frontmatter = [
      '---',
      `title: "${title.replace(/"/g, '\\"')}"`,
      `date: ${isoDate}`,
      courseName ? `course: "${courseName.replace(/"/g, '\\"')}"` : '',
      `source: "${lectureUrl}"`,
      `platform: ${platform}`,
      `tags: [${tags.map(t => `"${t}"`).join(', ')}]`,
      '---',
      ''
    ].filter(l => l !== null && l !== undefined && !(l === '' && false));
    // Remove empty lines but keep structure
    const fmLines = frontmatter.filter((l, i) => l !== '' || (i === frontmatter.length - 1));

    // ── Collect terms for WikiLinks ───────────────────────────────────────
    const wikiTerms = collectGuideTerms(guide);

    const lines = [...fmLines, `# ${title}`, ''];
    for (const block of guide.guide) {
      lines.push(`## ${block.title}`);
      lines.push(`*${fmtSec(block.start_time)} – ${fmtSec(block.end_time)}*`);
      lines.push('');
      if (block.key_concepts?.length) {
        lines.push('### Key Concepts');
        for (const c of block.key_concepts) {
          lines.push(`- ${applyWikiLinks(c.replace(/\n/g, ' '), wikiTerms)}`);
        }
        lines.push('');
      }
      if (block.formulas?.length) {
        lines.push('### Formulas');
        for (const f of block.formulas) {
          if (f.label) lines.push(`**${f.label}**`);
          if (f.latex) lines.push(`$$${f.latex}$$`);
        }
        lines.push('');
      }
      if (block.definitions?.length) {
        lines.push('### Definitions');
        for (const d of block.definitions) {
          lines.push(`**[[${d.term}]]** — ${d.definition}`);
        }
        lines.push('');
      }
      if (block.notes?.trim()) {
        lines.push('### Notes');
        lines.push(`> ${applyWikiLinks(block.notes, wikiTerms).replace(/\n/g, '\n> ')}`);
        lines.push('');
      }
    }
    const md = lines.join('\n');
    const safeName = title.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    const filename = `${safeName}-guide.md`;

    // ── Download file ─────────────────────────────────────────────────────
    const blob = new Blob([md], { type: 'text/markdown; charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);

    setStatus('ready', 'Markdown exported');
  }

  /**
   * Try to open the exported markdown in Obsidian via the obsidian:// URI scheme.
   * Shows a brief toast with an "Open in Obsidian" link.
   */
  function openObsidianIfPossible(filename, content) {
    // obsidian://new?name=...&content=... (URL-encoded)
    // Works if Obsidian is installed and the user has it as default handler for obsidian://
    const obsidianUri = `obsidian://new?name=${encodeURIComponent(filename.replace(/\.md$/, ''))}&content=${encodeURIComponent(content)}`;

    // Show a small toast below the status bar
    const existing = document.getElementById('obsidian-toast');
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.id = 'obsidian-toast';
    toast.style.cssText = `
      position:fixed;bottom:56px;left:50%;transform:translateX(-50%);
      background:var(--surface-1);border:1px solid var(--border);border-radius:8px;
      padding:8px 14px;font-size:12px;color:var(--text-primary);
      box-shadow:0 4px 16px rgba(0,0,0,0.2);z-index:9500;
      display:flex;align-items:center;gap:10px;white-space:nowrap;
    `;
    toast.innerHTML = `
      <span>Markdown downloaded.</span>
      <a href="${obsidianUri}" style="color:var(--accent);text-decoration:none;font-weight:600">Open in Obsidian</a>
      <button id="obsidian-toast-dismiss" style="background:none;border:none;cursor:pointer;color:var(--text-muted);font-size:14px;padding:0;margin-left:2px">×</button>
    `;
    document.body.appendChild(toast);
    toast.querySelector('#obsidian-toast-dismiss')?.addEventListener('click', () => toast.remove());
    setTimeout(() => { if (toast.isConnected) toast.remove(); }, 8000);
  }

  // ─── Shared pill-group helper ─────────────────────────────────────────────

  /**
   * Initialize a pill group — clicking a pill makes it active, deactivates others.
   * @param {string} groupId  — the container element's id
   * @param {function} [onChange]  — optional callback called with the new active value
   */
  function initPillGroup(groupId, onChange) {
    const group = document.getElementById(groupId);
    if (!group) return;
    group.querySelectorAll('.pill').forEach(btn => {
      btn.addEventListener('click', () => {
        group.querySelectorAll('.pill').forEach(b => b.classList.remove('pill-active'));
        btn.classList.add('pill-active');
        if (onChange) onChange(btn.dataset.value);
      });
    });
  }

  function getActivePillValue(groupId) {
    const group = document.getElementById(groupId);
    if (!group) return null;
    const active = group.querySelector('.pill.pill-active');
    return active ? active.dataset.value : null;
  }

  function buildApiPayloadBase() {
    return {
      provider: settings.provider,
      model: settings.model || null,
      apiKey: settings.apiKey,
      localBase: getLocalBase()
    };
  }

  // ─── Tool section helpers ─────────────────────────────────────────────────

  /** Switch to the Tools tab and open a specific tool section (details element). */
  function openToolSection(sectionId) {
    switchTab('tools');
    const section = document.getElementById(sectionId);
    if (section) {
      section.open = true;
      setTimeout(() => section.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
    }
  }

  // ─── Inline guide tool panel ──────────────────────────────────────────────
  // Opens a split-panel within the Guide tab instead of switching to Tools tab.

  let _inlineToolActive = null;   // 'flashcards' | 'quiz' | 'exam' | null

  /**
   * Open (or toggle) the inline tool panel at the bottom of the Guide tab.
   * @param {'flashcards'|'quiz'|'exam'} toolKey
   * @param {string} titleText   Panel header label
   * @param {Function} buildFn   Called with the body element to populate it
   */
  function openInlineToolPanel(toolKey, titleText, buildFn) {
    if (!guide?.guide?.length) { setStatus('warning', 'Generate a guide first'); return; }

    const guideContent = document.getElementById('guide-content');
    const panel        = document.getElementById('guide-inline-tool');
    const nameEl       = document.getElementById('guide-inline-tool-name');
    const bodyEl       = document.getElementById('guide-inline-tool-body');
    if (!panel || !bodyEl) return;

    // Toggle off if same tool clicked again
    if (_inlineToolActive === toolKey) {
      closeInlineToolPanel();
      return;
    }

    _inlineToolActive = toolKey;
    nameEl.textContent = titleText;
    bodyEl.innerHTML   = '';
    buildFn(bodyEl);

    // Clear any height left from a previous resize — let content drive the size.
    // The panel will be exactly as tall as its content (the settings form / results).
    // CSS max-height caps it if content is very long.
    panel.style.height = '';

    panel.hidden = false;
    guideContent?.classList.add('inline-tool-open');

    // Highlight the active toolbar button
    document.querySelectorAll('.guide-toolbar-actions .icon-btn').forEach(btn => {
      btn.classList.toggle('inline-tool-active', btn.dataset.inlineTool === toolKey);
    });

    // Wire resize handle
    _wireInlineResize();
  }

  function closeInlineToolPanel() {
    const guideContent = document.getElementById('guide-content');
    const panel        = document.getElementById('guide-inline-tool');
    if (panel) {
      panel.hidden = true;
      panel.style.height = '';   // clear JS-set height so CSS rules take over next open
    }
    guideContent?.classList.remove('inline-tool-open');
    _inlineToolActive = null;
    document.querySelectorAll('.guide-toolbar-actions .icon-btn').forEach(btn => {
      btn.classList.remove('inline-tool-active');
    });
  }

  function _wireInlineResize() {
    const handle = document.getElementById('guide-inline-resize');
    const panel  = document.getElementById('guide-inline-tool');
    if (!handle || !panel || handle.dataset.wired) return;
    handle.dataset.wired = '1';

    let startY = 0, startH = 0;
    handle.addEventListener('mousedown', e => {
      startY = e.clientY;
      startH = panel.offsetHeight;
      const onMove = ev => {
        // Handle is at the TOP of the panel (bottom-anchored panel).
        // Drag UP (ev.clientY decreases) → delta positive → panel grows.
        // Drag DOWN (ev.clientY increases) → delta negative → panel shrinks.
        const delta = startY - ev.clientY;
        const container = panel.parentElement;
        const maxH = (container ? container.offsetHeight : window.innerHeight) - 80;
        const newH = Math.min(Math.max(startH + delta, 120), maxH);
        panel.style.height = `${newH}px`;
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      e.preventDefault();
    });
  }

  /** Build the Flashcards inline panel body */
  function _buildInlineFlashcards(body) {
    if (flashcardData.length) {
      // Already have cards — show them directly
      _renderInlineFlashcardResults(body);
    } else {
      // Settings form (minimal — count + style)
      const countVal = getActivePillValue('flashcards-count-pills') || 'auto';
      const styleVal = getActivePillValue('flashcards-style-pills') || 'mixed';
      body.innerHTML = `
        <p class="inline-tool-hint">Generates flashcards from this lecture guide.</p>
        <div class="inline-tool-row">
          <span class="inline-tool-label">Count</span>
          <div class="pill-group" id="it-fc-count-pills">
            ${['auto','10','20','30'].map(v => `<button class="pill${v===countVal?' pill-active':''}" data-value="${v}" type="button">${v}</button>`).join('')}
          </div>
        </div>
        <div class="inline-tool-row">
          <span class="inline-tool-label">Style</span>
          <div class="pill-group" id="it-fc-style-pills">
            ${['mixed','definition','formula','concept'].map(v => `<button class="pill${v===styleVal?' pill-active':''}" data-value="${v}" type="button">${v}</button>`).join('')}
          </div>
        </div>
        <button id="it-fc-generate-btn" class="primary-btn" type="button">
          <span class="btn-text">Generate Flashcards</span>
          <span class="btn-spinner" style="display:none"></span>
        </button>
        <p class="error-msg" id="it-fc-error" style="display:none"></p>
      `;
      initPillGroup('it-fc-count-pills');
      initPillGroup('it-fc-style-pills');
      body.querySelector('#it-fc-generate-btn').addEventListener('click', async () => {
        const btn  = body.querySelector('#it-fc-generate-btn');
        const errEl = body.querySelector('#it-fc-error');
        setFeatureBtnLoading(btn, true);
        errEl.style.display = 'none';
        try {
          const count  = getActivePillValue('it-fc-count-pills') || 'auto';
          const style  = getActivePillValue('it-fc-style-pills') || 'mixed';
          const systemPrompt = buildFlashcardsPrompt(guide, { count, style, includeFormulas: true });
          const payload = { ...buildApiPayloadBase(), type: 'FLASHCARDS_REQUEST', guideJson: guide, systemPrompt };
          const resp = await apiRequest(payload);
          if (!resp.success) throw new Error(resp.error);
          flashcardData = resp.data?.flashcards || [];
          if (!flashcardData.length) throw new Error('No flashcards returned.');
          flashcardIndex = 0;
          body.innerHTML = '';
          _renderInlineFlashcardResults(body);
        } catch (err) {
          errEl.textContent = err.message;
          errEl.style.display = '';
        } finally {
          setFeatureBtnLoading(btn, false);
        }
      });
    }
  }

  function _renderInlineFlashcardResults(body) {
    body.innerHTML = `
      <div class="inline-fc-header">
        <span id="it-fc-count-label" class="inline-fc-count">${flashcardData.length} card${flashcardData.length !== 1 ? 's' : ''}</span>
        <div style="display:flex;gap:6px">
          <button id="it-fc-tsv-btn" class="history-load-btn" type="button">Export TSV</button>
          <button id="it-fc-anki-btn" class="history-load-btn" type="button">Send to Anki</button>
          <button id="it-fc-regen-btn" class="history-load-btn" type="button">Regenerate</button>
        </div>
      </div>
      <div class="flashcard-nav">
        <button id="it-fc-prev-btn" class="block-nav-btn" type="button" disabled aria-label="Previous card">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <span id="it-fc-counter" class="flashcard-nav-counter">1 / ${flashcardData.length}</span>
        <button id="it-fc-next-btn" class="block-nav-btn" type="button" aria-label="Next card">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
        </button>
      </div>
      <div id="it-fc-card" class="flashcard-item"></div>
    `;
    const renderCard = idx => {
      flashcardIndex = Math.max(0, Math.min(idx, flashcardData.length - 1));
      const card = flashcardData[flashcardIndex];
      const counter = body.querySelector('#it-fc-counter');
      if (counter) counter.textContent = `${flashcardIndex + 1} / ${flashcardData.length}`;
      body.querySelector('#it-fc-prev-btn').disabled = flashcardIndex === 0;
      body.querySelector('#it-fc-next-btn').disabled = flashcardIndex === flashcardData.length - 1;
      const el = body.querySelector('#it-fc-card');
      el.innerHTML = `
        <div class="flashcard-side flashcard-front">
          <div class="flashcard-side-label">Front</div>
          <div class="flashcard-text" contenteditable="true" spellcheck="false">${escHtml(normalizeLatexForKatex(unescapeMathDelimiters(card.front)))}</div>
        </div>
        <div class="flashcard-side flashcard-back">
          <div class="flashcard-side-label">Back</div>
          <div class="flashcard-text" contenteditable="true" spellcheck="false">${escHtml(normalizeLatexForKatex(unescapeMathDelimiters(card.back)))}</div>
        </div>
      `;
      el.querySelectorAll('.flashcard-text').forEach(t => applyKatex(t));
    };
    renderCard(flashcardIndex);
    body.querySelector('#it-fc-prev-btn').addEventListener('click', () => renderCard(flashcardIndex - 1));
    body.querySelector('#it-fc-next-btn').addEventListener('click', () => renderCard(flashcardIndex + 1));
    body.querySelector('#it-fc-tsv-btn').addEventListener('click', exportFlashcardsAsTSV);
    body.querySelector('#it-fc-anki-btn').addEventListener('click', sendFlashcardsToAnki);
    body.querySelector('#it-fc-regen-btn').addEventListener('click', () => {
      flashcardData = [];
      body.innerHTML = '';
      _buildInlineFlashcards(body);
    });
  }

  /** Build the Quiz inline panel body */
  function _buildInlineQuiz(body) {
    if (quizState) {
      // Quiz in progress — render the active state
      body.innerHTML = `<p style="color:var(--text-muted);font-size:12px">Quiz is in progress in the Tools tab.</p>
        <button class="primary-btn" type="button" id="it-quiz-goto">Open Quiz →</button>`;
      body.querySelector('#it-quiz-goto')?.addEventListener('click', () => { openToolSection('tool-quiz'); closeInlineToolPanel(); });
      return;
    }
    const scopeVal = getActivePillValue('quiz-type-pills') || 'mixed';
    const countVal = getActivePillValue('quiz-count-pills') || '10';
    body.innerHTML = `
      <p class="inline-tool-hint">Quick quiz from this guide. Full settings in the <button class="link-btn" id="it-quiz-fullsettings">Tools tab</button>.</p>
      <div class="inline-tool-row">
        <span class="inline-tool-label">Type</span>
        <div class="pill-group" id="it-quiz-type-pills">
          ${['mixed','mc','open'].map(v => `<button class="pill${v===scopeVal?' pill-active':''}" data-value="${v}" type="button">${v}</button>`).join('')}
        </div>
      </div>
      <div class="inline-tool-row">
        <span class="inline-tool-label">Questions</span>
        <div class="pill-group" id="it-quiz-count-pills">
          ${['5','10','15'].map(v => `<button class="pill${v===countVal?' pill-active':''}" data-value="${v}" type="button">${v}</button>`).join('')}
        </div>
      </div>
      <button id="it-quiz-start-btn" class="primary-btn" type="button">
        <span class="btn-text">Start Quiz</span><span class="btn-spinner" style="display:none"></span>
      </button>
      <p class="error-msg" id="it-quiz-error" style="display:none"></p>
    `;
    initPillGroup('it-quiz-type-pills');
    initPillGroup('it-quiz-count-pills');
    body.querySelector('#it-quiz-fullsettings')?.addEventListener('click', () => { openToolSection('tool-quiz'); closeInlineToolPanel(); });
    body.querySelector('#it-quiz-start-btn').addEventListener('click', async () => {
      const btn   = body.querySelector('#it-quiz-start-btn');
      const errEl = body.querySelector('#it-quiz-error');
      setFeatureBtnLoading(btn, true);
      errEl.style.display = 'none';
      try {
        const type  = getActivePillValue('it-quiz-type-pills') || 'mixed';
        const count = parseInt(getActivePillValue('it-quiz-count-pills') || '10', 10);
        const scope = 'whole';
        const systemPrompt = buildQuizPrompt(guide, { count, type, scope });
        const payload = { ...buildApiPayloadBase(), type: 'QUIZ_REQUEST', guideJson: guide, systemPrompt };
        const resp  = await apiRequest(payload);
        if (!resp.success) throw new Error(resp.error);
        const questions = resp.data?.questions || [];
        if (!questions.length) throw new Error('No questions returned.');
        // Open full quiz in Tools tab for the interactive quiz experience
        quizData = questions;
        quizState = { questions, currentIndex: 0, scores: questions.map(() => null), done: false };
        openToolSection('tool-quiz');
        showQuizPanel('active');
        renderQuizQuestion();
        closeInlineToolPanel();
      } catch (err) {
        errEl.textContent = err.message;
        errEl.style.display = '';
      } finally {
        setFeatureBtnLoading(btn, false);
      }
    });
  }

  /** Build the Exam Questions inline panel body */
  function _buildInlineExam(body) {
    body.innerHTML = `
      <p class="inline-tool-hint">Generate exam-style questions from this guide. Full settings in the <button class="link-btn" id="it-exam-fullsettings">Tools tab</button>.</p>
      <div class="inline-tool-row">
        <span class="inline-tool-label">Scope</span>
        <div class="pill-group" id="it-exam-scope-pills">
          ${['whole','current'].map(v => `<button class="pill${v==='whole'?' pill-active':''}" data-value="${v}" type="button">${v==='whole'?'Whole guide':'Current block'}</button>`).join('')}
        </div>
      </div>
      <div class="inline-tool-row">
        <span class="inline-tool-label">Format</span>
        <div class="pill-group" id="it-exam-format-pills">
          ${['open','mc','mixed'].map(v => `<button class="pill${v==='open'?' pill-active':''}" data-value="${v}" type="button">${v.charAt(0).toUpperCase()+v.slice(1)}</button>`).join('')}
        </div>
      </div>
      <div class="inline-tool-row">
        <span class="inline-tool-label">Count</span>
        <div class="pill-group" id="it-exam-count-pills">
          ${['3','5','10'].map(v => `<button class="pill${v==='5'?' pill-active':''}" data-value="${v}" type="button">${v}</button>`).join('')}
        </div>
      </div>
      <button id="it-exam-gen-btn" class="primary-btn" type="button">
        <span class="btn-text">Generate Questions</span><span class="btn-spinner" style="display:none"></span>
      </button>
      <p class="error-msg" id="it-exam-error" style="display:none"></p>
      <div id="it-exam-results"></div>
    `;
    initPillGroup('it-exam-scope-pills');
    initPillGroup('it-exam-format-pills');
    initPillGroup('it-exam-count-pills');
    body.querySelector('#it-exam-fullsettings')?.addEventListener('click', () => { openToolSection('tool-exam'); closeInlineToolPanel(); });
    body.querySelector('#it-exam-gen-btn').addEventListener('click', async () => {
      const btn    = body.querySelector('#it-exam-gen-btn');
      const errEl  = body.querySelector('#it-exam-error');
      const resDiv = body.querySelector('#it-exam-results');
      setFeatureBtnLoading(btn, true);
      errEl.style.display = 'none';
      resDiv.innerHTML = '';
      try {
        const scope      = getActivePillValue('it-exam-scope-pills') || 'whole';
        const format     = getActivePillValue('it-exam-format-pills') || 'open';
        const count      = getActivePillValue('it-exam-count-pills') || '5';
        const blocks     = scope === 'current'
          ? (guide.guide[Math.max(0, currentBlockIndex)] ? [guide.guide[Math.max(0, currentBlockIndex)].title] : guide.guide.map(b => b.title))
          : guide.guide.map(b => b.title);
        const systemPrompt = buildExamPrompt(guide, { count, format, difficulty: 'mixed', answerLength: 'medium', selectedBlockTitles: blocks });
        const payload = { ...buildApiPayloadBase(), type: 'EXAM_REQUEST', guideJson: guide, systemPrompt };
        const resp = await apiRequest(payload);
        if (!resp.success) throw new Error(resp.error);
        const questions = resp.data?.questions || [];
        if (!questions.length) throw new Error('No questions returned.');
        renderExamQuestionList('it-exam-results', questions);
      } catch (err) {
        errEl.textContent = err.message;
        errEl.style.display = '';
      } finally {
        setFeatureBtnLoading(btn, false);
      }
    });
  }

  // ─── Flashcards feature ───────────────────────────────────────────────────

  function openFlashcardsModal() {
    if (!guide?.guide?.length) { setStatus('warning', 'Generate a guide first'); return; }
    showFlashcardsPanel('settings');
    openToolSection('tool-flashcards');
  }

  function closeFlashcardsModal() {
    // Results persist — no-op; user can collapse the section manually
  }

  function showFlashcardsPanel(panel) {
    const s = document.getElementById('flashcards-settings');
    const r = document.getElementById('flashcards-results');
    if (s) s.style.display = panel === 'settings' ? 'flex' : 'none';
    if (r) r.style.display = panel === 'results'  ? 'flex' : 'none';
  }

  async function generateFlashcards() {
    if (!guide?.guide?.length || !hasUsableSettings()) return;

    const customCountEl = document.getElementById('flashcards-custom-count');
    const customCountRaw = parseInt(customCountEl?.value?.trim() || '', 10);
    const count = (!isNaN(customCountRaw) && customCountRaw > 0)
      ? String(customCountRaw)
      : getActivePillValue('flashcards-count-pills') || 'auto';
    const style  = getActivePillValue('flashcards-style-pills') || 'mixed';
    const formulas = !!document.getElementById('flashcards-formulas-cb')?.checked;

    const btn = document.getElementById('flashcards-generate-btn');
    const errEl = document.getElementById('flashcards-error');
    setFeatureBtnLoading(btn, true);
    errEl.style.display = 'none';

    try {
      const systemPrompt = buildFlashcardsPrompt(guide, { count, style, includeFormulas: formulas });
      const payload = {
        ...buildApiPayloadBase(),
        type: 'FLASHCARDS_REQUEST',
        guideJson: guide,
        systemPrompt
      };
      const resp = await apiRequest(payload);
      if (!resp.success) throw new Error(resp.error);
      flashcardData = resp.data?.flashcards || [];
      if (!flashcardData.length) throw new Error('No flashcards returned. Try different settings.');
      flashcardIndex = 0;
      renderFlashcardList(flashcardData);
      const countLabel = document.getElementById('flashcards-count-label');
      if (countLabel) countLabel.textContent = `${flashcardData.length} card${flashcardData.length !== 1 ? 's' : ''}`;
      showFlashcardsPanel('results');
    } catch (err) {
      errEl.textContent = err.message;
      errEl.style.display = '';
    } finally {
      setFeatureBtnLoading(btn, false);
    }
  }

  /** Show all cards in paginated single-card view.  Wires up prev/next nav. */
  function renderFlashcardList(cards) {
    flashcardIndex = Math.min(flashcardIndex, Math.max(0, cards.length - 1));
    _wireFlashcardNav();
    renderFlashcard(flashcardIndex);
  }

  /** Render the card at `idx` into the card-list container. */
  function renderFlashcard(idx) {
    const list = document.getElementById('flashcards-card-list');
    if (!list || !flashcardData.length) return;
    idx = Math.max(0, Math.min(idx, flashcardData.length - 1));
    flashcardIndex = idx;

    // Update nav counter
    const counter = document.getElementById('flashcard-nav-counter');
    if (counter) counter.textContent = `${idx + 1} / ${flashcardData.length}`;
    const prevBtn = document.getElementById('flashcard-prev-btn');
    const nextBtn = document.getElementById('flashcard-next-btn');
    if (prevBtn) prevBtn.disabled = idx === 0;
    if (nextBtn) nextBtn.disabled = idx === flashcardData.length - 1;

    // Build card HTML
    const card = flashcardData[idx];
    list.innerHTML = '';
    const item = document.createElement('div');
    item.className = 'flashcard-item';
    item.innerHTML = `
      <div class="flashcard-side flashcard-front">
        <div class="flashcard-side-label">Front</div>
        <div class="flashcard-text" contenteditable="true" spellcheck="false">${escHtml(normalizeLatexForKatex(unescapeMathDelimiters(card.front)))}</div>
      </div>
      <div class="flashcard-side flashcard-back">
        <div class="flashcard-side-label">Back</div>
        <div class="flashcard-text" contenteditable="true" spellcheck="false">${escHtml(normalizeLatexForKatex(unescapeMathDelimiters(card.back)))}</div>
      </div>
      <div class="flashcard-actions">
        <button class="flashcard-delete-btn" type="button" title="Delete this card">Delete card</button>
      </div>
    `;
    item.querySelector('.flashcard-delete-btn').addEventListener('click', () => {
      // Save deleted card for undo
      const deletedCard = { ...flashcardData[idx] };
      const deletedIdx  = idx;
      flashcardData.splice(idx, 1);
      const countLabel = document.getElementById('flashcards-count-label');
      if (countLabel) countLabel.textContent = `${flashcardData.length} card${flashcardData.length !== 1 ? 's' : ''}`;

      // Show undo toast
      _showFlashcardUndoToast(deletedCard, deletedIdx);

      if (!flashcardData.length) {
        list.innerHTML = '<p style="color:var(--text-muted);font-size:12px;padding:8px 0">All cards deleted.</p>';
        const c = document.getElementById('flashcard-nav-counter');
        if (c) c.textContent = '0 / 0';
        return;
      }
      renderFlashcard(Math.min(idx, flashcardData.length - 1));
    });
    list.appendChild(item);

    // Apply KaTeX to the rendered card
    item.querySelectorAll('.flashcard-text').forEach(el => applyKatex(el));
  }

  let _flashcardNavWired = false;
  function _wireFlashcardNav() {
    if (_flashcardNavWired) return;
    _flashcardNavWired = true;
    document.getElementById('flashcard-prev-btn')?.addEventListener('click', () => {
      if (flashcardIndex > 0) renderFlashcard(flashcardIndex - 1);
    });
    document.getElementById('flashcard-next-btn')?.addEventListener('click', () => {
      if (flashcardIndex < flashcardData.length - 1) renderFlashcard(flashcardIndex + 1);
    });
  }

  function getEditedFlashcards() {
    // Paginated view: only the current card is in the DOM.
    // Flush any contenteditable edits from the visible card back into flashcardData,
    // then return the full array (all cards, not just the visible one).
    const list = document.getElementById('flashcards-card-list');
    if (list && flashcardData.length) {
      const item = list.querySelector('.flashcard-item');
      if (item) {
        const frontEl = item.querySelector('.flashcard-front .flashcard-text');
        const backEl  = item.querySelector('.flashcard-back  .flashcard-text');
        if (frontEl) flashcardData[flashcardIndex] = {
          ...flashcardData[flashcardIndex],
          front: frontEl.textContent?.trim() || flashcardData[flashcardIndex].front
        };
        if (backEl) flashcardData[flashcardIndex] = {
          ...flashcardData[flashcardIndex],
          back: backEl.textContent?.trim()  || flashcardData[flashcardIndex].back
        };
      }
    }
    return flashcardData;
  }

  let _flashcardUndoTimeout = null;
  function _showFlashcardUndoToast(card, atIndex) {
    // Remove any existing undo toast
    document.getElementById('flashcard-undo-toast')?.remove();
    if (_flashcardUndoTimeout) clearTimeout(_flashcardUndoTimeout);

    const toast = document.createElement('div');
    toast.id = 'flashcard-undo-toast';
    toast.className = 'flashcard-undo-toast';
    toast.innerHTML = `
      <span>Card deleted</span>
      <button class="flashcard-undo-btn" type="button">Undo</button>
    `;
    toast.querySelector('.flashcard-undo-btn').addEventListener('click', () => {
      // Restore card at original position (or end if out of range)
      const insertAt = Math.min(atIndex, flashcardData.length);
      flashcardData.splice(insertAt, 0, card);
      const countLabel = document.getElementById('flashcards-count-label');
      if (countLabel) countLabel.textContent = `${flashcardData.length} card${flashcardData.length !== 1 ? 's' : ''}`;
      renderFlashcard(insertAt);
      toast.remove();
      if (_flashcardUndoTimeout) clearTimeout(_flashcardUndoTimeout);
    });

    // Append inside the flashcards results panel
    const panel = document.getElementById('flashcards-results');
    if (panel) panel.appendChild(toast);

    // Auto-dismiss after 5 seconds
    _flashcardUndoTimeout = setTimeout(() => toast.remove(), 5000);
  }

  function exportFlashcardsAsTSV() {
    const cards = getEditedFlashcards();
    if (!cards.length) return;
    const tsv = cards.map(c => `${c.front.replace(/\t/g, ' ')}\t${c.back.replace(/\t/g, ' ')}`).join('\n');
    const blob = new Blob([tsv], { type: 'text/tab-separated-values; charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const title = (transcript?.lectureTitle || guide?.lecture_title || 'lecture').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    a.download = `${title}-flashcards.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    setStatus('ready', 'Flashcards exported as TSV');
  }

  async function sendFlashcardsToAnki() {
    const cards = getEditedFlashcards();
    if (!cards.length) return;
    const deckName = transcript?.courseName || transcript?.lectureTitle || 'Lecture Copilot';
    const notes = cards.map(c => ({
      deckName,
      modelName: 'Basic',
      fields: { Front: c.front, Back: c.back },
      options: { allowDuplicate: false },
      tags: ['lecture-copilot']
    }));
    try {
      const resp = await fetch('http://127.0.0.1:8765', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'addNotes', version: 6, params: { notes } })
      });
      const data = await resp.json();
      if (data.error) throw new Error(data.error);
      const added = data.result?.filter(Boolean).length ?? 0;
      setStatus('ready', `${added} card${added !== 1 ? 's' : ''} added to Anki deck "${deckName}"`);
    } catch (err) {
      setStatus('error', 'AnkiConnect error: ' + err.message + '. Is Anki open with AnkiConnect installed?');
    }
  }

  // ─── Quiz feature ─────────────────────────────────────────────────────────

  function openQuizModal() {
    if (!guide?.guide?.length) { setStatus('warning', 'Generate a guide first'); return; }
    showQuizPanel('settings');
    openToolSection('tool-quiz');
  }

  function closeQuizModal() {
    quizState = null;
    showQuizPanel('settings');
  }

  function showQuizPanel(panel) {
    const qs = document.getElementById('quiz-settings');
    const qa = document.getElementById('quiz-active');
    const qr = document.getElementById('quiz-results');
    if (qs) qs.style.display = panel === 'settings' ? 'flex' : 'none';
    if (qa) qa.style.display = panel === 'active'   ? 'flex' : 'none';
    if (qr) qr.style.display = panel === 'results'  ? 'flex' : 'none';
    if (panel === 'settings') {
      const errEl = document.getElementById('quiz-error');
      if (errEl) errEl.style.display = 'none';
    }
  }

  async function generateQuiz() {
    if (!guide?.guide?.length || !hasUsableSettings()) return;

    const customCountEl = document.getElementById('quiz-custom-count');
    const customCountRaw = parseInt(customCountEl?.value?.trim() || '', 10);
    const count = (!isNaN(customCountRaw) && customCountRaw > 0)
      ? customCountRaw
      : parseInt(getActivePillValue('quiz-count-pills') || '10', 10);
    const type  = getActivePillValue('quiz-type-pills') || 'mixed';

    const btn = document.getElementById('quiz-generate-btn');
    const errEl = document.getElementById('quiz-error');
    setFeatureBtnLoading(btn, true);
    errEl.style.display = 'none';

    try {
      const systemPrompt = buildQuizPrompt(guide, { count, type });
      const payload = {
        ...buildApiPayloadBase(),
        type: 'QUIZ_REQUEST',
        guideJson: guide,
        systemPrompt
      };
      const resp = await apiRequest(payload);
      if (!resp.success) throw new Error(resp.error);
      quizData = resp.data?.questions || [];
      if (!quizData.length) throw new Error('No quiz questions returned. Try different settings.');
      startQuiz(quizData);
    } catch (err) {
      errEl.textContent = err.message;
      errEl.style.display = '';
    } finally {
      setFeatureBtnLoading(btn, false);
    }
  }

  function startQuiz(questions) {
    quizState = {
      questions,
      currentIndex: 0,
      scores: new Array(questions.length).fill(null)
    };
    showQuizPanel('active');
    renderQuizQuestion();
  }

  function renderQuizQuestion() {
    if (!quizState) return;
    const { questions, currentIndex } = quizState;
    const q = questions[currentIndex];
    if (!q) return;

    const total = questions.length;
    const pct = Math.round((currentIndex / total) * 100);
    const counter = document.getElementById('quiz-q-counter');
    const fill = document.getElementById('quiz-progress-fill');
    if (counter) counter.textContent = `${currentIndex + 1} / ${total}`;
    if (fill) fill.style.width = `${pct}%`;

    const qText = document.getElementById('quiz-question-text');
    if (qText) {
      qText.textContent = normalizeLatexForKatex(unescapeMathDelimiters(q.question));
      applyKatex(qText);
    }

    const mcArea = document.getElementById('quiz-mc-options');
    const saArea = document.getElementById('quiz-sa-area');
    const revealBtn = document.getElementById('quiz-reveal-btn');
    const submitMcBtn = document.getElementById('quiz-submit-mc-btn');
    const answerReveal = document.getElementById('quiz-answer-reveal');

    if (answerReveal) answerReveal.style.display = 'none';
    const nextBtn = document.getElementById('quiz-next-btn');
    if (nextBtn) nextBtn.style.display = 'none';

    if (q.type === 'mc') {
      saArea.style.display = 'none';
      revealBtn.style.display = 'none';
      submitMcBtn.style.display = '';
      mcArea.style.display = 'flex';
      mcArea.innerHTML = '';
      const _LETTERS = ['A','B','C','D','E','F'];
      (q.options || []).forEach((opt, i) => {
        const btn = document.createElement('button');
        btn.className = 'quiz-mc-option';
        btn.dataset.optionIndex = i;
        btn.type = 'button';
        btn.innerHTML = `<span class="quiz-mc-letter">${_LETTERS[i] || i+1}</span><span class="quiz-mc-text"></span>`;
        btn.querySelector('.quiz-mc-text').textContent = normalizeLatexForKatex(unescapeMathDelimiters(opt));
        btn.addEventListener('click', () => {
          mcArea.querySelectorAll('.quiz-mc-option').forEach(b => b.classList.remove('selected'));
          btn.classList.add('selected');
        });
        mcArea.appendChild(btn);
        applyKatex(btn.querySelector('.quiz-mc-text'));
      });
    } else {
      mcArea.style.display = 'none';
      submitMcBtn.style.display = 'none';
      revealBtn.style.display = '';
      saArea.style.display = '';
      const sa = document.getElementById('quiz-sa-input');
      if (sa) sa.value = '';
    }
  }

  function quizRevealAnswer() {
    if (!quizState) return;
    const q = quizState.questions[quizState.currentIndex];
    showQuizAnswerReveal(q);
  }

  function quizSubmitMC() {
    if (!quizState) return;
    const q = quizState.questions[quizState.currentIndex];
    const mcArea = document.getElementById('quiz-mc-options');
    const selected = mcArea?.querySelector('.quiz-mc-option.selected');
    if (!selected) {
      selected || (mcArea && (mcArea.style.border = '1px solid var(--error, red)'));
      return;
    }
    const selectedIdx = parseInt(selected.dataset.optionIndex, 10);
    const isCorrect = selectedIdx === q.correct;

    // Highlight correct/wrong
    mcArea.querySelectorAll('.quiz-mc-option').forEach((btn, i) => {
      btn.disabled = true;
      if (i === q.correct) btn.classList.add('correct');
      else if (i === selectedIdx && !isCorrect) btn.classList.add('wrong');
    });

    // Record score
    quizState.scores[quizState.currentIndex] = isCorrect;
    showQuizAnswerReveal(q, isCorrect);
  }

  function showQuizAnswerReveal(q, isCorrect) {
    const answerReveal = document.getElementById('quiz-answer-reveal');
    const answerText = document.getElementById('quiz-answer-text');
    const explanationText = document.getElementById('quiz-explanation-text');
    const gradeRow = document.querySelector('.quiz-grade-row');

    const answer = q.answer || (q.options?.[q.correct] ? q.options[q.correct].replace(/^[A-D]\) /, '') : '');
    if (answerText) {
      answerText.textContent = normalizeLatexForKatex(unescapeMathDelimiters(answer));
      applyKatex(answerText);
    }
    if (explanationText) {
      explanationText.textContent = normalizeLatexForKatex(unescapeMathDelimiters(q.explanation || ''));
      explanationText.style.display = q.explanation ? '' : 'none';
      if (q.explanation) applyKatex(explanationText);
    }

    // For MC, grade is already determined; hide grade buttons
    if (q.type === 'mc') {
      if (gradeRow) gradeRow.style.display = 'none';
    } else {
      if (gradeRow) gradeRow.style.display = 'flex';
    }

    if (answerReveal) answerReveal.style.display = 'flex';

    // Show Next button instead of auto-advancing — let user read the answer
    const nextBtn = document.getElementById('quiz-next-btn');
    if (nextBtn) {
      nextBtn.style.display = '';
      nextBtn.onclick = () => quizGrade(isCorrect ?? true);
    }
  }

  function quizGrade(correct) {
    if (!quizState) return;
    const { questions, currentIndex } = quizState;
    quizState.scores[currentIndex] = correct;

    const nextIndex = currentIndex + 1;
    if (nextIndex >= questions.length) {
      showQuizResults();
      return;
    }
    quizState.currentIndex = nextIndex;
    renderQuizQuestion();
  }

  function showQuizResults() {
    showQuizPanel('results');
    const { questions, scores } = quizState;
    const correct = scores.filter(Boolean).length;
    const total   = questions.length;
    const pct     = Math.round((correct / total) * 100);

    const circle = document.getElementById('quiz-score-circle');
    const pctEl  = document.getElementById('quiz-score-pct');
    const textEl = document.getElementById('quiz-score-text');
    const encourageEl = document.getElementById('quiz-score-encouragement');

    if (pctEl) pctEl.textContent = `${pct}%`;
    if (textEl) textEl.textContent = `${correct} / ${total} correct`;

    const encouragement = pct >= 90 ? '🎉 Excellent! Exam-ready.' :
                          pct >= 70 ? '👍 Good work. Review missed questions.' :
                          pct >= 50 ? '📚 Keep studying — review the missed topics.' :
                                      '💪 Let\'s review — go back over the guide.';
    if (encourageEl) encourageEl.textContent = encouragement;

    // Color the circle by score
    if (circle) {
      circle.style.borderColor = pct >= 70 ? '#38a169' : pct >= 50 ? '#d69e2e' : '#e53e3e';
      if (pctEl) pctEl.style.color = pct >= 70 ? '#38a169' : pct >= 50 ? '#d69e2e' : '#e53e3e';
    }

    // Fill in missed questions
    const missedSection = document.getElementById('quiz-missed-section');
    const missedList    = document.getElementById('quiz-missed-list');
    const missed = questions.filter((_, i) => !scores[i]);
    if (missed.length && missedList) {
      missedSection.style.display = '';
      missedList.innerHTML = '';
      missed.forEach(q => {
        const item = document.createElement('div');
        item.className = 'quiz-missed-item';
        const answer = q.answer || (q.options?.[q.correct] ? q.options[q.correct].replace(/^[A-D]\) /, '') : '');
        item.innerHTML = `
          <div class="quiz-missed-q">${escHtml(normalizeLatexForKatex(unescapeMathDelimiters(q.question)))}</div>
          <div class="quiz-missed-a">Answer: ${escHtml(normalizeLatexForKatex(unescapeMathDelimiters(answer)))}</div>
        `;
        applyKatex(item);
        missedList.appendChild(item);
      });
    } else if (missedSection) {
      missedSection.style.display = 'none';
    }
  }

  // ─── Exam questions feature (Part 3A) ─────────────────────────────────────

  function openExamModal() {
    if (!guide?.guide?.length) { setStatus('warning', 'Generate a guide first'); return; }
    showExamPanel('settings');
    populateExamBlockCheckboxes();
    openToolSection('tool-exam');
  }

  function closeExamModal() {
    // No-op — results persist in Tools tab
  }

  function showExamPanel(panel) {
    const es = document.getElementById('exam-settings');
    const er = document.getElementById('exam-results');
    if (es) es.style.display = panel === 'settings' ? 'flex' : 'none';
    if (er) er.style.display = panel === 'results'  ? 'flex' : 'none';
    if (panel === 'settings') {
      const errEl = document.getElementById('exam-error');
      if (errEl) errEl.style.display = 'none';
    }
  }

  function onExamScopeChange(value) {
    const selectArea = document.getElementById('exam-block-select-area');
    if (selectArea) selectArea.style.display = value === 'select' ? '' : 'none';

    const infoRow   = document.getElementById('exam-current-block-info');
    const infoLabel = document.getElementById('exam-current-block-label');
    if (infoRow && infoLabel) {
      if (value === 'current') {
        const b = guide?.guide?.[Math.max(0, currentBlockIndex)];
        infoLabel.textContent = b?.title
          ? `Block ${currentBlockIndex + 1}: ${b.title}`
          : 'No block selected yet';
        infoRow.style.display = '';
      } else {
        infoRow.style.display = 'none';
      }
    }
  }

  function populateExamBlockCheckboxes() {
    const container = document.getElementById('exam-block-checkboxes');
    if (!container || !guide?.guide?.length) return;
    container.innerHTML = '';
    guide.guide.forEach((block, i) => {
      const row = document.createElement('label');
      row.className = 'exam-block-checkbox-row';
      row.innerHTML = `
        <input type="checkbox" value="${i}" checked>
        <span class="exam-block-cb-label">${escHtml(`${i + 1}. ${block.title}`)}</span>
      `;
      container.appendChild(row);
    });
  }

  function getSelectedExamBlocks() {
    const scope = getActivePillValue('exam-scope-pills') || 'whole';
    if (scope === 'whole') return guide.guide.map(b => b.title);
    if (scope === 'current') {
      const b = guide.guide[Math.max(0, currentBlockIndex)];
      return b ? [b.title] : guide.guide.map(b => b.title);
    }
    // scope === 'select'
    const checks = document.querySelectorAll('#exam-block-checkboxes input[type=checkbox]:checked');
    const indices = [...checks].map(c => parseInt(c.value, 10));
    return indices.map(i => guide.guide[i]?.title).filter(Boolean);
  }

  async function generateExamQuestions() {
    if (!guide?.guide?.length || !hasUsableSettings()) return;

    const difficulty  = getActivePillValue('exam-difficulty-pills') || 'mixed';
    const format      = getActivePillValue('exam-format-pills') || 'open';
    const answerLen   = getActivePillValue('exam-answer-pills') || 'medium';
    const countPill   = getActivePillValue('exam-count-pills') || '5';
    const perBlock    = countPill === 'per-block';
    const customCountEl = document.getElementById('exam-custom-count');
    const customCountRaw = parseInt(customCountEl?.value?.trim() || '', 10);
    const count = perBlock ? 2
      : (!isNaN(customCountRaw) && customCountRaw > 0) ? customCountRaw
      : parseInt(countPill, 10) || 5;
    const selectedBlocks = getSelectedExamBlocks();

    const btn = document.getElementById('exam-generate-btn');
    const errEl = document.getElementById('exam-error');
    setFeatureBtnLoading(btn, true);
    errEl.style.display = 'none';

    try {
      const systemPrompt = buildExamQuestionsPrompt(guide, selectedBlocks, {
        difficulty, format, answerLength: answerLen, questionsPerBlock: perBlock, count
      });
      const payload = {
        ...buildApiPayloadBase(),
        type: 'EXAM_QUESTIONS_REQUEST',
        guideJson: guide,
        systemPrompt
      };
      const resp = await apiRequest(payload);
      if (!resp.success) throw new Error(resp.error);
      const questions = resp.data?.questions || [];
      if (!questions.length) throw new Error('No questions returned. Try different settings.');
      renderExamQuestionList('exam-question-list', questions);
      const countLabel = document.getElementById('exam-count-label');
      if (countLabel) countLabel.textContent = `${questions.length} question${questions.length !== 1 ? 's' : ''}`;
      showExamPanel('results');
    } catch (err) {
      errEl.textContent = err.message;
      errEl.style.display = '';
    } finally {
      setFeatureBtnLoading(btn, false);
    }
  }

  function renderExamQuestionList(containerId, questions) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '';

    const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];
    const cap = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : '';

    questions.forEach((q, i) => {
      const item = document.createElement('div');
      item.className = 'exam-question-item';

      // Badges — capitalized, with softer colors via CSS classes
      const badges = [
        q.difficulty ? `<span class="exam-badge exam-badge-${q.difficulty}">${cap(q.difficulty)}</span>` : '',
        q.type       ? `<span class="exam-badge exam-badge-type">${q.type.toUpperCase()}</span>` : '',
        q.relevant_block ? `<span class="exam-badge exam-badge-block" title="Source block">${escHtml(q.relevant_block)}</span>` : ''
      ].filter(Boolean).join('');

      // MC options — lettered (A, B, C…) with NO correct-answer class yet (prevents spoiler)
      // Correct index stored in data attr; applied only when answer is revealed.
      let mcOptionsHtml = '';
      if (q.type === 'mc' && q.options?.length) {
        const opts = q.options.map((o, oi) =>
          `<div class="exam-mc-option" data-idx="${oi}">
             <span class="exam-mc-letter">${LETTERS[oi] || (oi + 1)}</span>
             <span class="exam-mc-text">${escHtml(normalizeLatexForKatex(unescapeMathDelimiters(o)))}</span>
           </div>`
        ).join('');
        mcOptionsHtml = `<div class="exam-mc-options" data-correct="${q.correct ?? -1}">${opts}</div>`;
      }

      // Answer text rendered as markdown (supports bold, bullet lists, etc.) + LaTeX
      const answerHtml = renderMarkdown(normalizeLatexForKatex(unescapeMathDelimiters(q.sample_answer || '')));

      item.innerHTML = `
        <div class="exam-question-head">
          <div class="exam-question-num">${i + 1}</div>
          <div class="exam-question-main">
            ${badges ? `<div class="exam-question-badges">${badges}</div>` : ''}
            <div class="exam-question-text"></div>
          </div>
        </div>
        ${mcOptionsHtml}
        <div class="exam-answer-section">
          <button class="exam-answer-toggle" type="button" aria-expanded="false">
            <svg class="exam-toggle-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
            Show model answer
          </button>
          <div class="exam-answer-content" hidden>
            <div class="exam-answer-body">${answerHtml}</div>
          </div>
        </div>
      `;

      // Set question text via textContent first to escape, then apply KaTeX
      const qTextEl = item.querySelector('.exam-question-text');
      qTextEl.textContent = normalizeLatexForKatex(unescapeMathDelimiters(q.question));
      applyKatex(qTextEl);

      // Apply KaTeX to each MC option text span
      item.querySelectorAll('.exam-mc-text').forEach(el => applyKatex(el));

      const toggle      = item.querySelector('.exam-answer-toggle');
      const answerContent = item.querySelector('.exam-answer-content');
      const mcOptions   = item.querySelector('.exam-mc-options');
      const chevron     = toggle?.querySelector('.exam-toggle-chevron');

      toggle?.addEventListener('click', () => {
        const isShown = !answerContent.hidden;
        answerContent.hidden = isShown;
        toggle.setAttribute('aria-expanded', String(!isShown));
        toggle.querySelector('.exam-toggle-chevron').style.transform = isShown ? '' : 'rotate(180deg)';
        toggle.childNodes[toggle.childNodes.length - 1].textContent =
          isShown ? ' Show model answer' : ' Hide model answer';

        // Reveal / hide the correct MC option highlight
        if (mcOptions) {
          const correctIdx = parseInt(mcOptions.dataset.correct ?? '-1', 10);
          mcOptions.querySelectorAll('.exam-mc-option').forEach((opt, idx) => {
            opt.classList.toggle('exam-correct-option', !isShown && idx === correctIdx);
          });
        }

        // Apply KaTeX to answer body on first reveal
        const answerBody = answerContent.querySelector('.exam-answer-body');
        if (!isShown && answerBody && !answerBody.dataset.katexDone) {
          answerBody.dataset.katexDone = '1';
          applyKatex(answerBody);
        }
      });

      container.appendChild(item);
    });
  }

  // ─── Cross-lecture exam prediction (Part 3B) ──────────────────────────────

  /** Open cross-exam section pre-filtered to a course group (called from history "Predict" button). */
  function openCrossExamModalForCourse(courseEntries) {
    showCrossExamPanel('settings');
    openToolSection('tool-cross-exam');
    // Load full history, render grouped, then auto-check only entries in courseEntries
    const targetUrls = new Set((courseEntries || []).map(e => normalizeLectureUrl(e.lectureUrl)));
    _populateCrossExamGrouped({ preselectUrls: targetUrls });
  }

  /** Open the cross-lecture section and populate lecture list from history */
  function openCrossExamModal() {
    showCrossExamPanel('settings');
    _populateCrossExamGrouped({});
    openToolSection('tool-cross-exam');
  }

  function closeCrossExamModal() {
    // No-op — results persist in Tools tab
  }

  function showCrossExamPanel(panel) {
    const cs = document.getElementById('cross-exam-settings');
    const cr = document.getElementById('cross-exam-results');
    if (cs) cs.style.display = panel === 'settings' ? 'flex' : 'none';
    if (cr) cr.style.display = panel === 'results'  ? 'flex' : 'none';
    if (panel === 'settings') {
      const errEl = document.getElementById('cross-exam-error');
      if (errEl) errEl.style.display = 'none';
    }
  }

  /**
   * Render the cross-exam lecture picker as a grouped (by course) list,
   * mirroring the History panel layout.
   * @param {{ preselectUrls?: Set<string> }} opts
   *   preselectUrls — if provided, only those lecture URLs will be pre-checked.
   *                   If omitted, nothing is pre-checked.
   */
  function _populateCrossExamGrouped({ preselectUrls } = {}) {
    const listEl = document.getElementById('cross-exam-lecture-list');
    if (!listEl) return;
    listEl.innerHTML = '<p style="color:var(--text-muted);font-size:11.5px">Loading…</p>';

    chrome.storage.local.get(['guideHistory'], res => {
      const history      = Array.isArray(res.guideHistory) ? res.guideHistory : [];
      const validEntries = history.filter(e => e?.guide?.guide?.length && e?.lectureTitle);

      if (!validEntries.length) {
        listEl.innerHTML = '<p style="color:var(--text-muted);font-size:11.5px">No guides in history yet. Generate guides for at least 2 lectures first.</p>';
        return;
      }

      // Store flat array for lookup during generation
      listEl._allHistory = validEntries;

      // ── Group by courseKey ──────────────────────────────────────────────
      const groups = {};
      validEntries.forEach((entry, globalIdx) => {
        const k = entry.courseKey || deriveCourseKeyFromUrl(entry.lectureUrl) || 'other';
        if (!groups[k]) groups[k] = { courseName: entry.courseName || k, entries: [] };
        groups[k].entries.push({ entry, globalIdx });
      });

      // Sort courses: current-lecture's course first, then alpha
      const activeCourseKey = transcript?.courseKey || deriveCourseKeyFromUrl(currentLectureUrl);
      const sortedKeys = Object.keys(groups).sort((a, b) => {
        if (a === activeCourseKey) return -1;
        if (b === activeCourseKey) return  1;
        return groups[a].courseName.localeCompare(groups[b].courseName);
      });

      listEl.innerHTML = '';

      for (const k of sortedKeys) {
        const g = groups[k];
        // Sort entries newest-first within course
        g.entries.sort((a, b) => {
          const da = a.entry.lectureDate || a.entry.date || '';
          const db = b.entry.lectureDate || b.entry.date || '';
          return db.localeCompare(da);
        });

        const groupDiv = document.createElement('div');
        groupDiv.className = 'cross-exam-course-group';

        // Course header with "Select all" checkbox
        const header = document.createElement('div');
        header.className = 'cross-exam-course-header';
        const selectAllId = `cross-exam-selall-${k}`;
        header.innerHTML = `
          <label class="cross-exam-course-selall" title="Select / deselect all in this course">
            <input type="checkbox" id="${escHtml(selectAllId)}" class="cross-exam-selall-cb cross-exam-cb">
          </label>
          <span class="cross-exam-course-name">${escHtml(g.courseName)}</span>
          <span class="cross-exam-course-count">${g.entries.length} lecture${g.entries.length !== 1 ? 's' : ''}</span>
        `;
        groupDiv.appendChild(header);

        const rowsDiv = document.createElement('div');
        rowsDiv.className = 'cross-exam-course-rows';

        const rowCheckboxes = [];

        g.entries.forEach(({ entry, globalIdx }) => {
          const isPreselected = preselectUrls
            ? preselectUrls.has(normalizeLectureUrl(entry.lectureUrl))
            : false;
          const dateStr = entry.lectureDate
            ? new Date(entry.lectureDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
            : (entry.guideDate ? new Date(entry.guideDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '');
          const numLabel = entry.lectureNumber ? `#${entry.lectureNumber} · ` : '';
          const cbId = `cross-exam-cb-${globalIdx}`;

          const row = document.createElement('label');
          row.className = 'cross-exam-lecture-row';
          row.setAttribute('for', cbId);
          row.innerHTML = `
            <input type="checkbox" id="${cbId}" class="cross-exam-cb" data-idx="${globalIdx}"${isPreselected ? ' checked' : ''}>
            <div class="cross-exam-lecture-info">
              <div class="cross-exam-lecture-title">${escHtml(entry.lectureTitle)}</div>
              ${dateStr ? `<div class="cross-exam-lecture-meta">${numLabel}${escHtml(dateStr)}</div>` : ''}
            </div>
          `;
          const cb = row.querySelector('input');
          cb.addEventListener('change', () => {
            _syncCrossExamGroupHeader(header, rowCheckboxes);
            updateCrossExamGenerateBtn();
          });
          rowCheckboxes.push(cb);
          rowsDiv.appendChild(row);
        });

        // Wire select-all checkbox and set initial header state
        const selectAllCb = header.querySelector('.cross-exam-selall-cb');
        selectAllCb.addEventListener('change', () => {
          rowCheckboxes.forEach(cb => { cb.checked = selectAllCb.checked; });
          updateCrossExamGenerateBtn();
        });

        groupDiv.appendChild(rowsDiv);
        listEl.appendChild(groupDiv);

        // Sync indeterminate/checked state based on current row selections
        _syncCrossExamGroupHeader(header, rowCheckboxes);
      }

      updateCrossExamGenerateBtn();
    });
  }

  /** Sync the "select all" checkbox state (checked/indeterminate) based on row states */
  function _syncCrossExamGroupHeader(header, rowCheckboxes) {
    const selAllCb = header.querySelector('.cross-exam-selall-cb');
    if (!selAllCb) return;
    const total   = rowCheckboxes.length;
    const checked = rowCheckboxes.filter(c => c.checked).length;
    selAllCb.checked       = checked === total;
    selAllCb.indeterminate = checked > 0 && checked < total;
  }

  /** Kept for backward compatibility (called from Tools tab click) */
  function populateCrossExamLectureList() {
    _populateCrossExamGrouped({});
  }

  function updateCrossExamGenerateBtn() {
    const generateBtn = document.getElementById('cross-exam-generate-btn');
    if (!generateBtn) return;
    const checked = document.querySelectorAll('#cross-exam-lecture-list input[data-idx]:checked').length;
    generateBtn.disabled = checked < 2;
    const btnText = generateBtn.querySelector('.btn-text');
    if (btnText) btnText.textContent = checked < 2
      ? `Predict Exam Questions (select ≥2 lectures)`
      : `Predict Exam Questions (${checked} lectures)`;
  }

  async function generateCrossLecturePrediction() {
    if (!hasUsableSettings()) return;

    const listEl = document.getElementById('cross-exam-lecture-list');
    const history = listEl?._allHistory;
    if (!history) return;

    // Only count checkboxes that have data-idx (lecture rows, not "select all" checkboxes)
    const checkedInputs = [...document.querySelectorAll('#cross-exam-lecture-list input[data-idx]:checked')];
    const selectedIndices = checkedInputs.map(inp => parseInt(inp.dataset.idx, 10));
    if (selectedIndices.length < 2) return;

    const selectedEntries = selectedIndices.map(i => history[i]).filter(Boolean);
    const lectures = selectedEntries.map(e => ({ lectureTitle: e.lectureTitle, guide: e.guide }));

    const difficulty = getActivePillValue('cross-exam-difficulty-pills') || 'mixed';
    const format     = getActivePillValue('cross-exam-format-pills') || 'open';
    const customCountEl = document.getElementById('cross-exam-custom-count');
    const customCountRaw = parseInt(customCountEl?.value?.trim() || '', 10);
    const count = (!isNaN(customCountRaw) && customCountRaw > 0)
      ? customCountRaw
      : parseInt(getActivePillValue('cross-exam-count-pills') || '5', 10);

    const btn = document.getElementById('cross-exam-generate-btn');
    const errEl = document.getElementById('cross-exam-error');
    setFeatureBtnLoading(btn, true);
    errEl.style.display = 'none';

    try {
      const systemPrompt = buildCrossLecturePredictionPrompt(lectures, { difficulty, format, count });
      const payload = {
        ...buildApiPayloadBase(),
        type: 'CROSS_LECTURE_EXAM_REQUEST',
        guidesJson: lectures,
        systemPrompt
      };
      const resp = await apiRequest(payload);
      if (!resp.success) throw new Error(resp.error);
      const data = resp.data || {};

      // Render topics
      const topicsSection = document.getElementById('cross-exam-topics-section');
      const topicsList    = document.getElementById('cross-exam-topics-list');
      const topics = data.exam_topics || [];
      if (topics.length && topicsList) {
        topicsSection.style.display = '';
        topicsList.innerHTML = '';
        topics.forEach(t => {
          const item = document.createElement('div');
          item.className = 'cross-exam-topic-item';
          const confClass = `cross-exam-confidence-${t.confidence || 'medium'}`;
          item.innerHTML = `
            <div class="cross-exam-topic-header">
              <span class="cross-exam-topic-name">${escHtml(t.topic)}</span>
              <span class="cross-exam-confidence ${confClass}">${t.confidence || 'medium'}</span>
            </div>
            <div class="cross-exam-topic-rationale">${escHtml(t.rationale || '')}</div>
          `;
          topicsList.appendChild(item);
        });
      } else if (topicsSection) {
        topicsSection.style.display = 'none';
      }

      // Render questions
      const questions = data.questions || [];
      if (!questions.length) throw new Error('No predictions returned. Try different settings.');
      renderExamQuestionList('cross-exam-question-list', questions);
      const countLabel = document.getElementById('cross-exam-count-label');
      if (countLabel) countLabel.textContent = `${questions.length} question${questions.length !== 1 ? 's' : ''}`;
      showCrossExamPanel('results');
    } catch (err) {
      errEl.textContent = err.message;
      errEl.style.display = '';
    } finally {
      setFeatureBtnLoading(btn, false);
    }
  }

  // ─── Feature button loading state helper ──────────────────────────────────

  function setFeatureBtnLoading(btn, loading) {
    if (!btn) return;
    const text = btn.querySelector('.btn-text');
    const spinner = btn.querySelector('.btn-spinner');
    btn.disabled = loading;
    if (spinner) spinner.style.display = loading ? 'inline-block' : 'none';
    if (text) text.style.opacity = loading ? '0.5' : '1';
  }

  // ─── Prompt builders (loaded from lib/prompts.js) ─────────────────────────
  // These functions are loaded via <script src="../lib/prompts.js"> but prompts.js
  // uses module.exports when typeof module !== 'undefined' (Node/Jest context).
  // In the browser the globals are available directly. Provide thin wrappers so
  // sidebar.js code can call them without worrying about global vs module scope.

  function buildFlashcardsPrompt(guide, opts) {
    if (typeof window.buildFlashcardsPrompt === 'function') {
      const base = window.buildFlashcardsPrompt(guide, opts);
      const extra = customPromptExtras.flashcards?.trim();
      return extra ? extra + '\n\n' + base : base;
    }
    throw new Error('buildFlashcardsPrompt not loaded');
  }
  function buildQuizPrompt(guide, opts) {
    if (typeof window.buildQuizPrompt === 'function') {
      const base = window.buildQuizPrompt(guide, opts);
      const extra = customPromptExtras.quiz?.trim();
      return extra ? extra + '\n\n' + base : base;
    }
    throw new Error('buildQuizPrompt not loaded');
  }
  function buildExamQuestionsPrompt(guide, blocks, opts) {
    if (typeof window.buildExamQuestionsPrompt === 'function') {
      const base = window.buildExamQuestionsPrompt(guide, blocks, opts);
      const extra = customPromptExtras.exam?.trim();
      return extra ? extra + '\n\n' + base : base;
    }
    throw new Error('buildExamQuestionsPrompt not loaded');
  }
  function buildCrossLecturePredictionPrompt(lectures, opts) {
    if (typeof window.buildCrossLecturePredictionPrompt === 'function') return window.buildCrossLecturePredictionPrompt(lectures, opts);
    throw new Error('buildCrossLecturePredictionPrompt not loaded');
  }

  function getLocalBase() {
    if (!settings?.provider) return null;
    if (!String(settings.provider).startsWith('local_')) return null;
    return settings?.localBases?.[settings.provider] || null;
  }

  function hasUsableSettings() {
    if (!settings?.provider) return false;
    if (String(settings.provider).startsWith('local_')) {
      return !!getLocalBase();
    }
    return !!settings?.apiKey;
  }

  // ─── Tooltip system (body-level, immune to overflow clipping) ────────────
  (function initTooltips() {
    const tip = document.getElementById('global-tip');
    if (!tip) return;
    let activeHint = null;

    function show(hint) {
      const text = hint.getAttribute('data-tip');
      if (!text) return;
      activeHint = hint;
      tip.textContent = text;
      tip.classList.add('visible');
      position(hint);
    }

    function hide() {
      activeHint = null;
      tip.classList.remove('visible');
    }

    function position(hint) {
      const r = hint.getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      const vh = document.documentElement.clientHeight;

      tip.style.left = '0';
      tip.style.top = '0';
      tip.style.maxWidth = (vw - 16) + 'px';

      const tw = tip.offsetWidth;
      const th = tip.offsetHeight;

      let left = r.right - tw;
      if (left < 8) left = 8;
      if (left + tw > vw - 8) left = vw - 8 - tw;

      let top = r.top - th - 6;
      if (top < 4) top = r.bottom + 6;

      tip.style.left = left + 'px';
      tip.style.top = top + 'px';
    }

    document.addEventListener('mouseover', function (e) {
      const hint = e.target.closest('.setting-hint[data-tip]');
      if (hint) show(hint); else if (activeHint) hide();
    });
    document.addEventListener('mouseout', function (e) {
      const hint = e.target.closest('.setting-hint[data-tip]');
      if (hint && hint === activeHint) hide();
    });
    // Keyboard accessibility for hints with tabindex="0"
    document.addEventListener('focusin', function (e) {
      const hint = e.target.closest('.setting-hint[data-tip]');
      if (hint) show(hint);
    });
    document.addEventListener('focusout', function (e) {
      const hint = e.target.closest('.setting-hint[data-tip]');
      if (hint && hint === activeHint) hide();
    });
  })();

  // ─── Bootstrap ───────────────────────────────────────────────────────────
  init();

})();
