/**
 * sidebar/guide.js — Transcript intake and guide generation — prompts, generate, regenerate.
 *
 * Part of the sidebar, loaded as a plain script in the order listed in
 * sidebar.html. All sidebar modules share one global scope on purpose:
 * it is what lets each file be a straight move out of the old sidebar.js.
 */

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
      // The full detail goes to the error panel, which can offer a fix when
      // the cause is a media host we have not been granted yet.
      if (msg.errorDetail) {
        try { ErrorPanel.report(msg.errorDetail); } catch { /* panel optional */ }
      }
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
  updateGuideAbortBtn();
  updateLectureSummaryBtn();
}

function updateGuideAbortBtn() {
  const btn = document.getElementById('guide-abort-btn');
  if (btn) btn.hidden = !isGenerating;
  const contentAbortBtn = document.getElementById('guide-content-abort-btn');
  if (contentAbortBtn) contentAbortBtn.hidden = !isGenerating;
}

function abortGuideGeneration() {
  if (!_activeGuideAbortFn) return;
  _activeGuideAbortFn();
  _activeGuideAbortFn = null;
}

async function onGenerateClick() {
  if (isGenerating || !transcript || !hasUsableSettings()) return;
  isGenerating = true;

  // Reset streaming state so incremental rendering starts fresh
  guideScanner = createGuideBlockScanner();
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
  const maxTokens = selectedGuideMaxTokens(guideCount);

  const guideLang = getSelectedLanguage();
  const guideMode = !useFallback && genModeSel?.value === 'study_flow' ? 'study_flow' : 'reliable';
  const systemPrompt = withPromptExtras('guide', guideMode === 'study_flow'
    ? buildStudyFlowGuidePrompt(guideDetail, guideCount, guideLang)
    : buildGuidePrompt(guideDetail, guideCount, guideLang));
  // All providers support SSE streaming via the shared adapter layer.
  const supportsStream = !!settings.provider;

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

  window.CopilotDebug?.log('[Copilot] Sending GENERATE_GUIDE', {
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
    const guideReq = apiRequest(payload);
    _activeGuideAbortFn = guideReq.abort;
    updateGuideAbortBtn();
    const response = await guideReq;
    window.CopilotDebug?.log('[Copilot] GENERATE_GUIDE response received', { success: response.success });

    if (!response.success) throw new Error(response.error);

    clearStreamingBar();
    guide = response.data;
    guide = sanitizeGuide(guide, transcript?.lectureTitle);
    guideLanguage = guideLang;
    guide._language = guideLang;
    guide._guide_mode = guideMode;

    storageSet({
      currentGuide: guide,
      currentLectureUrl: currentLectureUrl,
      currentGuideLectureUrl: normalizeLectureUrl(currentLectureUrl)
    });
    saveToHistory();
    _syncToolLanguageSelects();
    // The replacement is on disk, so the old guide is no longer needed.
    discardedByRegenerate = null;

    setStatus('ready', `Guide ready · ${guide.guide.length} blocks`);
    showGuideContent();
    const mp = document.getElementById('manual-paste-section');
    if (mp) mp.remove();

  } catch (err) {
    console.error('[Copilot] GENERATE_GUIDE error:', err.message);
    clearStreamingBar();
    const aborted = err.message === 'Request aborted.';
    // A regenerate that never produced a guide gives the old one back rather
    // than leaving the lecture empty.
    const restored = restoreDiscardedGuide();

    if (!aborted) {
      showGuideError(err.message);
      setStatus('error', restored
        ? 'Guide generation failed · previous guide restored'
        : 'Guide generation failed');
      if (!restored) showManualPasteOption();
    } else if (restored) {
      setStatus('ready', `Generation stopped · previous guide restored`);
    } else {
      restoreMainStatus();
    }
  } finally {
    isGenerating = false;
    _activeGuideAbortFn = null;
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
        This clears the current guide, Q&amp;A and lecture summary for this lecture.
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

/**
 * Everything Regenerate is about to clear, in a form that can be put back.
 * Deep-copied because the live arrays are cleared in place a moment later.
 */
function snapshotBeforeRegenerate() {
  if (!guide) return null;
  const copy = (value) => {
    try { return structuredClone(value); } catch { return JSON.parse(JSON.stringify(value)); }
  };
  return {
    lectureUrl: normalizeLectureUrl(currentLectureUrl),
    guide: copy(guide),
    guideLanguage,
    blockIndex: currentBlockIndex,
    qaChats: copy(qaChats.map(c => ({
      id: c.id, name: c.name, messages: c.messages,
      guideSentForLectureUrl: c.guideSentForLectureUrl || null,
      summaryInContext: !!c.summaryInContext
    }))),
    lectureSummaryText,
    lectureSummarySource,
    toolOutputs: copy(buildToolOutputsSnapshot())
  };
}

/**
 * Puts back what Regenerate cleared, after the replacement failed to arrive.
 * Returns false when there is nothing to restore or it belongs to another
 * lecture, so the caller can leave the failure message alone.
 */
function restoreDiscardedGuide() {
  const saved = discardedByRegenerate;
  if (!saved) return false;
  if (saved.lectureUrl !== normalizeLectureUrl(currentLectureUrl)) return false;
  discardedByRegenerate = null;

  applyRestoredGuide(saved.guide, null, true, saved.qaChats);
  currentBlockIndex = saved.blockIndex >= 0 ? saved.blockIndex : 0;
  renderBlock(currentBlockIndex);

  if (saved.lectureSummaryText) {
    setLectureSummaryComplete(saved.lectureSummaryText, saved.lectureSummarySource || 'guide');
  }
  if (toolOutputsHasData(saved.toolOutputs)) {
    applyToolOutputsSnapshot(saved.toolOutputs);
    persistToolOutputs();
  }
  return true;
}

function confirmRegenerateGuide() {
  hideRegenerateConfirmToast();
  // Held until the new guide is safely in place — see restoreDiscardedGuide.
  discardedByRegenerate = snapshotBeforeRegenerate();
  guide = null;
  currentBlockIndex = -1;
  resetQaChats();
  // The summary belongs to the old guide — drop it from storage, from the
  // Q&A panels, and from every chat's context flag.
  clearLectureSummaryState();
  guideContent.style.display = 'none';
  guideEmpty.style.display = '';
  generateError.style.display = 'none';
  chrome.storage?.local?.remove(['currentGuide', 'currentGuideLectureUrl', 'currentQaMessages', 'currentQaChats', 'currentToolOutputs', 'currentGuideToolOutputs']);
  clearToolOutputsLocalFallback();
  clearToolOutputsState();
  restoreToolOutputsUI();
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

// No client-side max-token tables: providers enforce their own limits.
// Only an explicit "Custom" value from the user is ever sent.
function selectedGuideMaxTokens(count) {
  if (count !== 'custom') return undefined;
  const n = parseInt(genCustomTokenInput?.value, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function updateCustomTokenVisibility() {
  if (!genCustomTokenRow) return;
  genCustomTokenRow.style.display = genCountSel?.value === 'custom' ? '' : 'none';
}

function updateTokenHint() {
  if (!genTokenHint) return;
  genTokenHint.textContent = genCountSel?.value === 'custom'
    ? 'Manual output-token cap — sent to the provider as-is'
    : 'Output length is left to the provider (no client-side cap)';
}

function getSelectedLanguage() {
  const val = genLangSel?.value || '';
  if (!val) return '';
  if (val === 'other') return genLangCustom?.value?.trim() || '';
  return val;
}

// Returns the effective language for a tool's language select.
// '__guide__' resolves to guideLanguage (the language the current guide was generated in).
function getToolLanguage(selectId) {
  const sel = document.getElementById(selectId);
  const val = sel?.value || '__guide__';
  return val === '__guide__' ? guideLanguage : val;
}

// Sync all tool language selects to the current guide language.
// Called after a guide is loaded or restored.
function _syncToolLanguageSelects() {
  const ids = ['flashcards-lang-select', 'quiz-lang-select', 'exam-lang-select', 'cross-exam-lang-select'];
  for (const id of ids) {
    const sel = document.getElementById(id);
    if (!sel) continue;
    if (guideLanguage) {
      const match = [...sel.options].find(o => o.value === guideLanguage);
      sel.value = match ? guideLanguage : '__guide__';
    } else {
      sel.value = '__guide__';
    }
  }
}

/** Guide title, falling back to the lecture we are currently watching. */
function getGuideTitle(guideObj = guide) {
  return guideTitleFrom(guideObj, transcript?.lectureTitle);
}

function getHistoryDisplayTitle(entry) {
  const fromEntry = typeof entry?.guideTitle === 'string' ? entry.guideTitle.trim() : '';
  if (fromEntry) return fromEntry;
  return getGuideTitle(entry?.guide) || entry?.lectureTitle || 'Lecture';
}
