/**
 * sidebar/session.js — Per-lecture persistence: storage writes, cache restore, tool-output snapshots.
 *
 * Part of the sidebar, loaded as a plain script in the order listed in
 * sidebar.html. All sidebar modules share one global scope on purpose:
 * it is what lets each file be a straight move out of the old sidebar.js.
 */

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

function buildToolOutputsSnapshot() {
  // Guard: when quizState is null, the original `length === length` check evaluated
  // to `undefined === undefined` → true, and then `quizState.scores.every(...)` blew
  // up with a TypeError. That exception bubbled out of persistToolOutputs and got
  // silently swallowed by the surrounding try/catch in generateFlashcards — so the
  // flashcards rendered on screen but were never written to ANY storage. This is
  // why no `[ETH-DBG] persistToolOutputs: saving` log ever appeared.
  const quizDone = !!quizState && (
    quizState.done === true ||
    (Array.isArray(quizState.scores)
      && Array.isArray(quizState.questions)
      && quizState.scores.length === quizState.questions.length
      && quizState.scores.every(s => s !== null))
  );
  return {
    flashcards: flashcardData.length
      ? {
          cards: flashcardData.map(c => ({ ...c })),
          index: flashcardIndex,
          deckTitle: flashcardDeckTitle || null
        }
      : null,
    quiz: quizState?.questions?.length
      ? {
          questions: quizState.questions,
          currentIndex: quizState.currentIndex,
          scores: quizState.scores,
          done: !!quizDone
        }
      : null,
    exam: examQuestionData.length ? { questions: examQuestionData } : null,
    crossExam: crossExamQuestionData.length
      ? { questions: crossExamQuestionData, topics: crossExamTopics }
      : null
  };
}

function toolOutputsHasData(snapshot) {
  if (!snapshot) return false;
  return !!(snapshot.flashcards || snapshot.quiz || snapshot.exam || snapshot.crossExam);
}

/** Tool snapshot must belong to this lecture (prevents cross-lecture bleed). */
function toolSnapshotMatchesLecture(snapshot, norm) {
  if (!snapshot || !toolOutputsHasData(snapshot) || !norm) return false;
  const snapNorm = snapshot.lectureUrl ? normalizeLectureUrl(snapshot.lectureUrl) : '';
  return snapNorm === norm;
}

function readToolOutputsLocalFallback() {
  try {
    const raw = localStorage.getItem('eth-copilot-tool-outputs');
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object') ? parsed : null;
  } catch {
    return null;
  }
}

function writeToolOutputsLocalFallback(payload) {
  try {
    localStorage.setItem('eth-copilot-tool-outputs', JSON.stringify(payload));
  } catch {
    // Best-effort fallback only.
  }
}

function clearToolOutputsLocalFallback() {
  try {
    localStorage.removeItem('eth-copilot-tool-outputs');
  } catch {
    // Best-effort fallback only.
  }
}

function clearToolOutputsState() {
  flashcardData = [];
  flashcardDeckTitle = null;
  flashcardIndex = 0;
  quizData = [];
  quizState = null;
  examQuestionData = [];
  crossExamQuestionData = [];
  crossExamTopics = [];
}

function restoreToolOutputsUI() {
  if (flashcardData.length) {
    const countLabel = document.getElementById('flashcards-count-label');
    if (countLabel) countLabel.textContent = `${flashcardData.length} card${flashcardData.length !== 1 ? 's' : ''}`;
    updateFlashcardDeckTitleUI();
    renderFlashcardList(flashcardData);
    showFlashcardsPanel('results');
  } else {
    showFlashcardsPanel('settings');
  }

  if (quizState?.questions?.length) {
    const quizDone = quizState.done
      || (quizState.scores?.length === quizState.questions.length
        && quizState.scores.every(s => s !== null));
    if (quizDone) {
      showQuizPanel('results');
      showQuizResults();
    } else {
      showQuizPanel('active');
      renderQuizQuestion();
    }
  } else {
    showQuizPanel('settings');
  }

  if (examQuestionData.length) {
    renderExamQuestionList('exam-question-list', examQuestionData);
    const countLabel = document.getElementById('exam-count-label');
    if (countLabel) countLabel.textContent = `${examQuestionData.length} question${examQuestionData.length !== 1 ? 's' : ''}`;
    showExamPanel('results');
  } else {
    showExamPanel('settings');
  }

  if (crossExamQuestionData.length) {
    renderCrossExamTopics(crossExamTopics);
    renderExamQuestionList('cross-exam-question-list', crossExamQuestionData);
    const countLabel = document.getElementById('cross-exam-count-label');
    if (countLabel) countLabel.textContent = `${crossExamQuestionData.length} question${crossExamQuestionData.length !== 1 ? 's' : ''}`;
    showCrossExamPanel('results');
  } else {
    showCrossExamPanel('settings');
  }
}

function applyToolOutputsSnapshot(snapshot) {
  window.CopilotDebug?.log('[ETH-DBG] applyToolOutputsSnapshot:', {
    hasSnapshot: !!snapshot,
    flashcards: snapshot?.flashcards?.cards?.length || 0,
    quiz: snapshot?.quiz?.questions?.length || 0,
    exam: snapshot?.exam?.questions?.length || 0
  });
  clearToolOutputsState();
  if (!snapshot) {
    restoreToolOutputsUI();
    return;
  }
  if (snapshot.flashcards?.cards?.length) {
    flashcardData = (window.normalizeFlashcardsResponse
      ? window.normalizeFlashcardsResponse({ flashcards: snapshot.flashcards.cards })
      : snapshot.flashcards.cards.map(c => ({ front: String(c.front ?? ''), back: String(c.back ?? '') })));
    flashcardDeckTitle = getGuideTitle(guide) || snapshot.flashcards.deckTitle || null;
    flashcardIndex = Math.min(
      snapshot.flashcards.index || 0,
      Math.max(0, flashcardData.length - 1)
    );
  }
  if (snapshot.quiz?.questions?.length) {
    quizState = {
      questions: snapshot.quiz.questions,
      currentIndex: Math.min(snapshot.quiz.currentIndex || 0, snapshot.quiz.questions.length - 1),
      scores: Array.isArray(snapshot.quiz.scores)
        ? snapshot.quiz.scores
        : new Array(snapshot.quiz.questions.length).fill(null),
      done: !!snapshot.quiz.done
    };
    quizData = quizState.questions;
  }
  if (snapshot.exam?.questions?.length) {
    examQuestionData = snapshot.exam.questions;
  }
  if (snapshot.crossExam?.questions?.length) {
    crossExamQuestionData = snapshot.crossExam.questions;
    crossExamTopics = Array.isArray(snapshot.crossExam.topics) ? snapshot.crossExam.topics : [];
  }
  restoreToolOutputsUI();
}

function patchHistoryToolOutputs(snapshot) {
  if (!currentLectureUrl || !toolOutputsHasData(snapshot)) return;
  const norm = normalizeLectureUrl(currentLectureUrl);
  chrome.storage?.local?.get(['guideHistory'], saved => {
    const history = Array.isArray(saved.guideHistory) ? saved.guideHistory : [];
    const entry = history.find(h => normalizeLectureUrl(h.lectureUrl) === norm);
    if (!entry) return;
    entry.toolOutputs = snapshot;
    storageSet({ guideHistory: history });
  });
}

function persistToolOutputs() {
  const snapshot = buildToolOutputsSnapshot();
  const counts = {
    flashcards: snapshot.flashcards?.cards?.length || 0,
    quiz: snapshot.quiz?.questions?.length || 0,
    exam: snapshot.exam?.questions?.length || 0,
    crossExam: snapshot.crossExam?.questions?.length || 0
  };
  const norm = currentLectureUrl ? normalizeLectureUrl(currentLectureUrl) : null;

  if (!toolOutputsHasData(snapshot)) {
    window.CopilotDebug?.log('[ETH-DBG] persistToolOutputs: empty snapshot — clearing caches', { norm });
    chrome.storage?.local?.remove(['currentToolOutputs', 'currentGuideToolOutputs']);
    clearToolOutputsLocalFallback();
    return;
  }

  window.CopilotDebug?.log('[ETH-DBG] persistToolOutputs: saving', { norm, ...counts });

  // Always write to localStorage — this works even before `currentLectureUrl` is
  // available (e.g. EXTENSION_READY hasn't propagated yet) and survives hard reloads.
  writeToolOutputsLocalFallback({ lectureUrl: norm || null, ...snapshot, savedAt: Date.now() });

  // Session fallback — always tagged with lecture URL so it cannot restore on another lecture.
  storageSet({ currentGuideToolOutputs: { lectureUrl: norm || null, ...snapshot } });

  // Lecture-keyed cache (only when we know the URL).
  if (norm) {
    storageSet({ currentToolOutputs: { lectureUrl: norm, ...snapshot } });
    patchHistoryToolOutputs(snapshot);
  } else {
    window.CopilotDebug?.warn('[ETH-DBG] persistToolOutputs: no currentLectureUrl — skipping lecture-keyed cache, but localStorage + session fallback still saved');
  }
}

function restoreToolOutputsForLecture(historyEntry, sessionFallbackSnapshot = null) {
  if (!currentLectureUrl) {
    window.CopilotDebug?.warn('[ETH-DBG] restoreToolOutputsForLecture: no currentLectureUrl — skipping');
    return;
  }
  const norm = normalizeLectureUrl(currentLectureUrl);
  const localFallback = readToolOutputsLocalFallback();
  chrome.storage?.local?.get(['currentToolOutputs', 'currentGuideToolOutputs'], saved => {
    const cached = saved.currentToolOutputs;
    let snapshot = null;
    let source = 'none';
    if (cached?.lectureUrl === norm && toolOutputsHasData(cached)) {
      snapshot = cached; source = 'lecture-cache';
    } else if (historyEntry?.toolOutputs && toolOutputsHasData(historyEntry.toolOutputs)) {
      snapshot = historyEntry.toolOutputs; source = 'history-entry';
    } else if (toolSnapshotMatchesLecture(sessionFallbackSnapshot, norm)) {
      snapshot = sessionFallbackSnapshot; source = 'session-fallback';
    } else if (sessionFallbackSnapshot && toolOutputsHasData(sessionFallbackSnapshot) && !sessionFallbackSnapshot.lectureUrl) {
      // Legacy cache shape (no lectureUrl) — only passed when sessionMatches is true.
      snapshot = sessionFallbackSnapshot; source = 'session-fallback-legacy';
    } else if (toolSnapshotMatchesLecture(saved.currentGuideToolOutputs, norm)) {
      snapshot = saved.currentGuideToolOutputs; source = 'guide-tool-cache';
    } else if (localFallback?.lectureUrl === norm && toolOutputsHasData(localFallback)) {
      snapshot = localFallback; source = 'localStorage-fallback';
    }
    window.CopilotDebug?.log('[ETH-DBG] restoreToolOutputsForLecture:', {
      source, norm,
      cachedLectureUrl: cached?.lectureUrl || null,
      cachedMatches: cached?.lectureUrl === norm,
      hasSessionFallback: !!sessionFallbackSnapshot,
      hasGuideToolCache: !!saved.currentGuideToolOutputs,
      hasLocalFallback: !!localFallback,
      localFallbackLectureUrl: localFallback?.lectureUrl || null,
      flashcardCount: snapshot?.flashcards?.cards?.length || 0
    });
    applyToolOutputsSnapshot(snapshot);
  });
}

function applyRestoredGuide(guideData, qaFromStorage, persistSession, qaChatsFromStorage) {
  guide = guideData;
  sanitizeGuide(guide);
  guideLanguage = guideData._language || '';
  _syncToolLanguageSelects();
  const restoredMsgs = Array.isArray(qaFromStorage) ? qaFromStorage : [];
  // Restore multi-chat state if available, else fall back to single chat
  if (Array.isArray(qaChatsFromStorage) && qaChatsFromStorage.length > 0) {
    qaChats = qaChatsFromStorage.map(c => ({
      id: c.id || 1, name: c.name || 'Chat 1',
      messages: Array.isArray(c.messages) ? c.messages : [],
      guideSentForLectureUrl: c.guideSentForLectureUrl || null,
      summaryInContext: typeof c.summaryInContext === 'boolean'
        ? c.summaryInContext
        : chatSummaryInContextFromMessages(c.messages)
    }));
    _nextChatId = Math.max(...qaChats.map(c => c.id), 1) + 1;
  } else {
    qaChats = [{ id: 1, name: 'Chat 1', messages: restoredMsgs, guideSentForLectureUrl: null,
      summaryInContext: chatSummaryInContextFromMessages(restoredMsgs) }];
    _nextChatId = 2;
  }
  activeQaChatIdx = 0;
  qaMessages = qaChats[0].messages;
  if (persistSession && currentLectureUrl) {
    storageSet({
      currentGuide: guide,
      currentLectureUrl: currentLectureUrl,
      currentGuideLectureUrl: normalizeLectureUrl(currentLectureUrl),
      currentQaMessages: qaMessages,
      currentQaChats: qaChats.map(c => ({
        id: c.id, name: c.name, messages: c.messages,
        guideSentForLectureUrl: c.guideSentForLectureUrl || null,
        summaryInContext: !!c.summaryInContext
      }))
    });
  }
  setStatus('ready', `Guide ready · ${guide.guide.length} blocks`);
  showGuideContent();
  hideQaReplyReadyToast();
  sanitizeQaChatsSummaryHistory();
  initQaChatCols();
  updateGenerateButton();
  ensureLectureSummaryRestored({});
  updateLectureSummaryBtn();
}

function tryRestoreFromCache(lectureUrl) {
  window.CopilotDebug?.log('[ETH-DBG] tryRestoreFromCache called with:', lectureUrl);
  if (!lectureUrl) { window.CopilotDebug?.warn('[ETH-DBG] tryRestoreFromCache: no lectureUrl'); return; }
  const normNew = normalizeLectureUrl(lectureUrl);
  const normPrev = currentLectureUrl ? normalizeLectureUrl(currentLectureUrl) : '';
  // SPA navigation can fire EXTENSION_READY with a stale href; drop in-memory state
  // immediately when the page URL changes so we never keep showing the last lecture.
  if (guide?.guide?.length && normPrev && normPrev !== normNew) {
    resetGuideUI();
  }
  currentLectureUrl = lectureUrl;
  initScriptsForCourse(lectureUrl);

  // Load custom prompt extras and per-tool thinking (non-blocking, best-effort)
  chrome.storage?.local?.get(['customPromptExtras', TOOL_THINKING_KEY, SUMMARY_OPTS_KEY], (r) => {
    if (r.customPromptExtras && typeof r.customPromptExtras === 'object') {
      customPromptExtras = { ...customPromptExtras, ...r.customPromptExtras };
    }
    if (r[TOOL_THINKING_KEY] && typeof r[TOOL_THINKING_KEY] === 'object') {
      toolThinking = { ...toolThinking, ...r[TOOL_THINKING_KEY] };
      syncToolThinkingSelects();
    }
    if (r[SUMMARY_OPTS_KEY] && typeof r[SUMMARY_OPTS_KEY] === 'object') {
      summaryOptions = { ...summaryOptions, ...r[SUMMARY_OPTS_KEY] };
      refreshInlineLectureSummaryIfOpen();
    }
  });

  chrome.storage?.local?.get(
    ['currentGuide', 'currentTranscript', 'currentLectureUrl', 'currentGuideLectureUrl', 'currentQaMessages', 'currentQaChats', 'guideHistory', 'currentGuideToolOutputs', 'currentLectureSummary', 'currentToolAskSessions'],
    saved => {
      const hist = Array.isArray(saved.guideHistory) ? saved.guideHistory : [];
      const normSaved = saved.currentLectureUrl ? normalizeLectureUrl(saved.currentLectureUrl) : '';
      const normGuideUrl = saved.currentGuideLectureUrl ? normalizeLectureUrl(saved.currentGuideLectureUrl) : '';
      // sessionMatches: storage's lecture marker matches the current page.
      // guideUrlMatches: defense-in-depth — the saved guide itself was generated
      // for this lecture. If either fails, do NOT apply the saved currentGuide.
      const sessionMatches = normSaved === normNew;
      const guideUrlMatches = !!normGuideUrl && normGuideUrl === normNew;

      if (!sessionMatches) {
        // CRITICAL: atomically swap session state. If we only update currentLectureUrl,
        // the stale currentGuide remains in storage and a later restore (e.g. from
        // TRANSCRIPT_READY) will see sessionMatches=true and load the WRONG lecture's
        // guide. We must clear every per-lecture session key here so no orphan can
        // attach to the new lecture's URL. History (guideHistory) and lecture-keyed
        // tool caches (currentToolOutputs is URL-scoped) are NOT affected.
        resetGuideUI();
        clearLectureSummaryState();
        chrome.storage?.local?.remove([
          'currentGuide',
          'currentTranscript',
          'currentQaMessages',
          'currentQaChats',
          'currentGuideToolOutputs',
          'currentGuideLectureUrl',
          'currentLectureSummary',
          'currentToolAskSessions'
        ], () => {
          storageSet({ currentLectureUrl: lectureUrl });
        });
        setStatus('loading', 'New lecture detected — waiting for transcript…');
      }

      let restoredGuide = false;
      let historyEntryForTools = null;

      if (sessionMatches && guideUrlMatches && saved.currentGuide?.guide?.length) {
        applyRestoredGuide(saved.currentGuide, saved.currentQaMessages, false, saved.currentQaChats);
        restoredGuide = true;
        restoreLectureSummaryFromStorage(saved);
      } else {
        if (sessionMatches && !guideUrlMatches && saved.currentGuide?.guide?.length) {
          window.CopilotDebug?.warn('[ETH-DBG] Refusing to restore currentGuide — its lecture URL does not match current page', { normGuideUrl, normNew });
        }
        const latest = pickLatestHistoryForUrl(hist, lectureUrl);
        if (latest?.guide?.guide?.length) {
          applyRestoredGuide(latest.guide, latest.qaMessages, true, latest.qaChatsData);
          restoredGuide = true;
          historyEntryForTools = latest;
          if (latest.lectureSummary) {
            lectureSummaryText = latest.lectureSummary;
            lectureSummarySource = latest.lectureSummarySource || null;
            persistLectureSummary();
          } else {
            restoreLectureSummaryFromStorage(saved);
          }
        }
      }
      if (sessionMatches) {
        ensureLectureSummaryRestored(saved);
        restoreToolAskSessions(saved);
      }
      if (restoredGuide || lectureSummaryReady()) updateLectureSummaryBtn();

      window.CopilotDebug?.log('[ETH-DBG] tryRestoreFromCache decided:', {
        sessionMatches, guideUrlMatches, restoredGuide,
        normSaved, normNew, normGuideUrl,
        willApplyCurrentGuide: sessionMatches && guideUrlMatches && !!saved.currentGuide?.guide?.length
      });

      window.CopilotDebug?.log('[ETH-DBG] tryRestoreFromCache outcome:', {
        sessionMatches, restoredGuide,
        normSaved, normNew,
        hasCurrentGuide: !!saved.currentGuide?.guide?.length,
        historyMatches: !!historyEntryForTools,
        hasGuideToolCache: !!saved.currentGuideToolOutputs
      });
      const sessionToolFallback = sessionMatches ? (saved.currentGuideToolOutputs || null) : null;
      if (restoredGuide) {
        restoreToolOutputsForLecture(historyEntryForTools, sessionToolFallback);
      } else {
        window.CopilotDebug?.log('[ETH-DBG] tryRestoreFromCache: no guide yet — tool restore for this lecture only');
        restoreToolOutputsForLecture(historyEntryForTools, sessionToolFallback);
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
  guideLanguage = '';
  transcript = null;
  currentBlockIndex = -1;
  clearLectureSummaryState();
  clearToolAskSessions();
  resetQaChats();
  isGenerating = false;
  clearToolOutputsState();
  restoreToolOutputsUI();
  guideContent.style.display = 'none';
  guideEmpty.style.display = '';
  generateError.style.display = 'none';
  generateBtn.disabled = true;
  generateBtn.querySelector('.btn-text').textContent = 'Generate Guide';
  generateBtn.querySelector('.btn-spinner').style.display = 'none';
  hideQaReplyReadyToast();
  const manualSection = document.getElementById('manual-paste-section');
  if (manualSection) manualSection.remove();
}

function restoreChatUI() {
  hideQaReplyReadyToast();
  initQaChatCols();
  // Scroll all columns to bottom
  for (let i = 0; i < qaChats.length; i++) {
    const col = getChatCol(i);
    if (col) col.scrollTop = col.scrollHeight;
  }
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
