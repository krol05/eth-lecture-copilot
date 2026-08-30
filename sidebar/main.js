/**
 * sidebar/main.js — Bootstrap: wires every listener, then starts the sidebar.
 *
 * Part of the sidebar, loaded as a plain script in the order listed in
 * sidebar.html. All sidebar modules share one global scope on purpose:
 * it is what lets each file be a straight move out of the old sidebar.js.
 */

// ─── Init ─────────────────────────────────────────────────────────────────

function init() {
  installDebugActionLogging();
  postToContent({ type: 'GET_SETTINGS' });

  // Tab switching
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  themeToggle.addEventListener('click', toggleTheme);
  statusDismiss?.addEventListener('click', dismissStatus);
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
  document.getElementById('guide-abort-btn')?.addEventListener('click', abortGuideGeneration);
  document.getElementById('guide-content-abort-btn')?.addEventListener('click', abortGuideGeneration);
  exportPdfBtn?.addEventListener('click', () => {
    if (guide?.guide?.length) {
      openGuidePrintWindow(guide, getGuideTitle(guide));
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
  if (qaCustomization) {
    qaCustomization.open = localStorage.getItem('eth-copilot-qa-customization-open') === '1';
    qaCustomization.addEventListener('toggle', () => {
      localStorage.setItem('eth-copilot-qa-customization-open', qaCustomization.open ? '1' : '0');
    });
  }
  qaResponseLengthSel?.addEventListener('change', () => {
    localStorage.setItem('eth-copilot-qa-response-length', qaResponseLengthSel.value || 'default');
  });
  if (qaResponseLengthSel) {
    qaResponseLengthSel.value = localStorage.getItem('eth-copilot-qa-response-length') || 'default';
  }
  qaResponseStyleSel?.addEventListener('change', () => {
    localStorage.setItem('eth-copilot-qa-response-style', qaResponseStyleSel.value || 'default');
  });
  if (qaResponseStyleSel) {
    qaResponseStyleSel.value = localStorage.getItem('eth-copilot-qa-response-style') || 'default';
  }
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
  qaSend.addEventListener('click', () => {
    if (isChatStreaming(activeQaChatIdx)) {
      abortQaStream(activeQaChatIdx);
    } else {
      sendQaMessage();
    }
  });
  // Delegate clicks on the messages container (works across all chat columns)
  qaMessages_el?.addEventListener('click', onQaMessagesClick);
  // Note: per-column scroll listeners are attached in initQaChatCols / addQaChat

  // Initialize chat columns and bar
  initQaChatCols();
  // Wire up image editor event listeners (once)
  _imgEdInitEvents();

  qaReplyReadyToast?.addEventListener('click', () => {
    hideQaReplyReadyToast(); // reflow from updateQaScrollBtn must finish before scroll starts
    qaScrollToBottom();
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

  qaLectureSummaryBtn?.addEventListener('click', onQaLectureSummaryClick);

  qaFrameBtn?.addEventListener('click', async () => {
    qaFrameBtn.disabled = true;

    // Nothing broad is ever requested here. ETH's player taints the canvas,
    // so the frame cannot be copied out of the video, and the only remaining
    // route is a screenshot — which Chrome allows solely with access to
    // every website, or with activeTab. activeTab is granted by running a
    // keyboard shortcut, so we point at that instead of asking for the web.
    const { b64, error, needsScreenshot } = await captureFrame();
    qaFrameBtn.disabled = false;
    if (b64) {
      attachedImages.push({ dataUrl: `data:image/jpeg;base64,${b64}`, label: 'Frame' });
      renderImageStrip();
      return;
    }
    if (needsScreenshot) {
      // The video is copy-protected, so this has to be a screenshot, and
      // Chrome grants that only for all sites or via a shortcut (activeTab).
      // Offer the choice on a button instead of firing a prompt unasked.
      offerScreenshotPermission();
      return;
    }

    // Never fail silently: say what the browser actually reported.
    setStatus('error', `Frame capture failed: ${error || 'unknown reason'}`);
    reportSidebarError(new Error(error || 'Frame capture failed'), { operation: 'Attaching a video frame' });
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
  document.getElementById('export-md-btn')?.addEventListener('click', () => {
    try {
      exportGuideAsMarkdown();
    } catch (err) {
      reportSidebarError(err, { operation: 'Export guide as Markdown' });
    }
  });

  // Feature buttons — open inline split panel within Guide tab (no tab switch)
  flashcardsBtn?.addEventListener('click', () =>
    openInlineToolPanel('flashcards', 'Flashcards', _buildInlineFlashcards));
  quizBtn?.addEventListener('click', () =>
    openInlineToolPanel('quiz', 'Practice Quiz', _buildInlineQuiz));
  examBtn?.addEventListener('click', () =>
    openInlineToolPanel('exam', 'Exam Questions', _buildInlineExam));
  lectureSummaryBtn?.addEventListener('click', () =>
    openInlineToolPanel('summary', 'Lecture Summary', _buildInlineLectureSummary));
  document.getElementById('guide-inline-tool-body')?.addEventListener('click', onGuideInlineBodyClick);

  document.getElementById('guide-inline-tool-close')?.addEventListener('click', closeInlineToolPanel);

  // Flashcards tool
  document.getElementById('flashcards-generate-btn')?.addEventListener('click', generateFlashcards);
  document.getElementById('flashcards-back-btn')?.addEventListener('click', () => showFlashcardsPanel('settings'));
  document.getElementById('flashcards-export-tsv')?.addEventListener('click', exportFlashcardsAsTSV);
  document.getElementById('flashcards-export-anki')?.addEventListener('click', sendFlashcardsToAnki);
  initPillGroup('flashcards-count-pills');
  initFlashcardTypePills('flashcards-card-type-pills');

  // Quiz tool
  document.getElementById('quiz-generate-btn')?.addEventListener('click', generateQuiz);
  document.getElementById('quiz-reveal-btn')?.addEventListener('click', quizRevealAnswer);
  document.getElementById('quiz-submit-mc-btn')?.addEventListener('click', quizSubmitMC);
  document.getElementById('quiz-grade-correct')?.addEventListener('click', () => quizGrade(true));
  document.getElementById('quiz-grade-wrong')?.addEventListener('click', () => quizGrade(false));
  document.getElementById('quiz-quit-btn')?.addEventListener('click', () => showQuizPanel('settings'));
  document.getElementById('quiz-restart-btn')?.addEventListener('click', () => showQuizPanel('settings'));
  document.getElementById('quiz-results-close-btn')?.addEventListener('click', () => {
    quizState = null;
    quizData = [];
    showQuizPanel('settings');
    persistToolOutputs();
  });
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
  // floats precisely above the entire bottom area (script panel + footer stack).
  const _footerStack  = document.querySelector('.qa-footer-stack');
  const _scriptPanel  = document.getElementById('script-panel');
  const _updateFooterH = () => {
    const h1 = _footerStack  ? _footerStack.getBoundingClientRect().height  : 0;
    const h2 = _scriptPanel  ? _scriptPanel.getBoundingClientRect().height  : 0;
    const total = h1 + h2;
    if (total > 0) document.documentElement.style.setProperty('--qa-footer-h', `${total}px`);
  };
  _updateFooterH();
  if (window.ResizeObserver) {
    const _ro = new ResizeObserver(_updateFooterH);
    if (_footerStack) _ro.observe(_footerStack);
    if (_scriptPanel) _ro.observe(_scriptPanel);
  }

  updateThinkingHint();
  initToolAskPanel();

  setStatus('loading', 'Waiting for video page…');
}

function installDebugActionLogging() {
  document.addEventListener('click', e => {
    const el = e.target?.closest?.('button,a,summary,[role="button"]');
    if (!el) return;
    window.CopilotDebug?.log('sidebar.ui.click', {
      tag: el.tagName,
      id: el.id || '',
      className: el.className || '',
      text: (el.textContent || '').trim().slice(0, 120),
      dataset: { ...el.dataset }
    });
  }, true);
  document.addEventListener('change', e => {
    const el = e.target;
    if (!el || !('value' in el)) return;
    window.CopilotDebug?.log('sidebar.ui.change', {
      tag: el.tagName,
      id: el.id || '',
      type: el.type || '',
      value: el.type === 'password' ? '[REDACTED]' : el.value,
      checked: !!el.checked
    });
  }, true);
  document.addEventListener('submit', e => {
    window.CopilotDebug?.log('sidebar.ui.submit', {
      id: e.target?.id || '',
      className: e.target?.className || ''
    });
  }, true);
}

function normalizeLectureUrl(href) {
  if (!href) return '';
  try {
    const u = new URL(href);
    u.hash = '';
    const path = u.pathname.replace(/\/+$/, '') || '/';
    // Ignore query params so transient player state does not break cache identity.
    return `${u.origin}${path}`;
  } catch {
    return String(href).trim().split('#')[0]?.split('?')[0]?.replace(/\/+$/, '') || '';
  }
}


// ─── Prompt builders (loaded from lib/prompts.js) ─────────────────────────
// These functions are loaded via <script src="../lib/prompts.js"> but prompts.js
// uses module.exports when typeof module !== 'undefined' (Node/Jest context).
// In the browser the globals are available directly. Provide thin wrappers so
// sidebar.js code can call them without worrying about global vs module scope.

function promptForFlashcards(guide, opts) {
  if (typeof window.buildFlashcardsPrompt === 'function') {
    const base = window.buildFlashcardsPrompt(guide, opts);
    const extra = customPromptExtras.flashcards?.trim();
    return extra ? extra + '\n\n' + base : base;
  }
  throw new Error('buildFlashcardsPrompt not loaded');
}
function promptForQuiz(guide, opts) {
  if (typeof window.buildQuizPrompt === 'function') {
    const base = window.buildQuizPrompt(guide, opts);
    const extra = customPromptExtras.quiz?.trim();
    return extra ? extra + '\n\n' + base : base;
  }
  throw new Error('buildQuizPrompt not loaded');
}
function promptForExam(guide, blocks, opts) {
  if (typeof window.buildExamQuestionsPrompt === 'function') {
    const base = window.buildExamQuestionsPrompt(guide, blocks, opts);
    const extra = customPromptExtras.exam?.trim();
    return extra ? extra + '\n\n' + base : base;
  }
  throw new Error('buildExamQuestionsPrompt not loaded');
}
function promptForCrossLecture(lectures, opts) {
  if (typeof window.buildCrossLecturePredictionPrompt === 'function') return window.buildCrossLecturePredictionPrompt(lectures, opts);
  throw new Error('buildCrossLecturePredictionPrompt not loaded');
}
function promptForToolAsk(opts) {
  if (typeof window.buildToolAskPrompt === 'function') return window.buildToolAskPrompt(opts);
  throw new Error('buildToolAskPrompt not loaded');
}

function getLocalBase() {
  if (!settings?.provider) return null;
  if (!String(settings.provider).startsWith('local_')) return null;
  return settings?.localBases?.[settings.provider] || null;
}

function hasUsableSettings() {
  if (!settings?.provider) return false;
  const p = String(settings.provider);
  if (p.startsWith('local_')) return !!getLocalBase();
  // Custom providers carry their base URL (and possibly no auth) in their
  // own config — a missing key surfaces as a detailed 401 in the error panel.
  if (p.startsWith('custom_')) return true;
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
