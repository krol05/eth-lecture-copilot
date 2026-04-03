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
  let isGenerating = false;
  let isChatting = false;
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
  const attachCb     = document.getElementById('attach-frame-cb');
  const framePreview = document.getElementById('frame-preview-label');
  const themeToggle  = document.getElementById('theme-toggle');
  const uiSettingsBtn = document.getElementById('ui-settings-btn');
  const focusToggle  = document.getElementById('focus-toggle');
  const exportPdfBtn = document.getElementById('export-pdf-btn');
  const copyLatexMultiBtn = document.getElementById('copy-latex-multi-btn');
  const regenerateBtn = document.getElementById('regenerate-btn');
  const blockPrevBtn = document.getElementById('block-prev-btn');
  const blockNextBtn = document.getElementById('block-next-btn');
  const jumpCurrentBlockBtn = document.getElementById('jump-current-block-btn');
  const autoTimeFollowCb = document.getElementById('auto-time-follow-cb');
  const autoFollowPauseHint = document.getElementById('auto-follow-pause-hint');
  const genSettings    = document.getElementById('gen-settings');
  const genLangSel     = document.getElementById('gen-lang-select');
  const genLangCustomRow = document.getElementById('gen-lang-custom-row');
  const genLangCustom  = document.getElementById('gen-lang-custom');
  const genDetailSel   = document.getElementById('gen-detail-select');
  const genCountSel    = document.getElementById('gen-count-select');
  const genTokenHint   = document.getElementById('gen-token-hint');
  const genTempSlider  = document.getElementById('gen-temp-slider');
  const genTempValue   = document.getElementById('gen-temp-value');
  const genThinkingSel = document.getElementById('gen-thinking-select');
  const genFallbackCb  = document.getElementById('gen-fallback-cb');
  const qaTempSlider   = document.getElementById('qa-temp-slider');
  const qaTempValue    = document.getElementById('qa-temp-value');

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
  const latexSelectModal = document.getElementById('latex-select-modal');
  const latexModalClose = document.getElementById('latex-modal-close');
  const latexSelectAllBtn = document.getElementById('latex-select-all-btn');
  const latexDeselectAllBtn = document.getElementById('latex-deselect-all-btn');
  const latexCopySelectedBtn = document.getElementById('latex-copy-selected-btn');
  const latexBlockList = document.getElementById('latex-block-list');

  let scriptRecord = null;  // current course's script data
  let scriptCourseId = null;

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

    genLangSel?.addEventListener('change', () => {
      if (genLangCustomRow) {
        genLangCustomRow.style.display = genLangSel.value === 'other' ? '' : 'none';
      }
    });

    genDetailSel?.addEventListener('change', updateTokenHint);
    genCountSel?.addEventListener('change', updateTokenHint);
    updateTokenHint();

    genTempSlider?.addEventListener('input', () => {
      genTempValue.textContent = (genTempSlider.value / 100).toFixed(2);
    });
    qaTempSlider?.addEventListener('input', () => {
      qaTempValue.textContent = (qaTempSlider.value / 100).toFixed(2);
    });
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

    attachCb.addEventListener('change', () => {
      framePreview.style.display = attachCb.checked ? 'inline' : 'none';
    });

    // Script panel
    scriptPanelToggle?.addEventListener('click', () => {
      const isOpen = scriptPanel.classList.toggle('open');
      scriptPanelBody.style.display = isOpen ? '' : 'none';
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

    window.addEventListener('message', onContentMessage);

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
      chrome.storage?.local?.set({
        currentGuide: guide,
        currentLectureUrl: currentLectureUrl,
        currentQaMessages: qaMessages
      });
    }
    setStatus('ready', `Guide ready · ${guide.guide.length} blocks`);
    showGuideContent();
    qaMessages_el.innerHTML = '';
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
    const manualSection = document.getElementById('manual-paste-section');
    if (manualSection) manualSection.remove();
  }

  function restoreChatUI() {
    const welcome = qaMessages_el.querySelector('.qa-welcome');
    if (welcome) welcome.remove();
    for (const m of qaMessages) {
      appendChatMsg(m.role, m.content, !!m.imageBase64);
    }
  }

  // ─── Message Handling ─────────────────────────────────────────────────────

  function onContentMessage(e) {
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
        break;

      case 'TRANSCRIPT_STATUS':
        handleTranscriptStatus(msg);
        break;

      case 'TRANSCRIPT_READY':
        handleTranscriptReady(msg);
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

      case 'API_RESPONSE':
        if (pendingRequests[msg.requestId]) {
          pendingRequests[msg.requestId](msg.response);
          delete pendingRequests[msg.requestId];
        }
        break;
    }
  }

  function postToContent(msg) {
    msg._copilot = true;
    window.parent.postMessage(msg, '*');
  }

  function makeRequestId() {
    return 'req_' + (++requestIdCounter);
  }

  function apiRequest(payload) {
    return new Promise((resolve, reject) => {
      const id = makeRequestId();
      const timeoutMs = payload?.type === 'GENERATE_GUIDE' ? 180000 : 120000;
      const timer = setTimeout(() => {
        delete pendingRequests[id];
        reject(new Error('Request timed out. Please try again or switch model/provider.'));
      }, timeoutMs);
      pendingRequests[id] = resolve;
      const originalResolve = pendingRequests[id];
      pendingRequests[id] = (data) => {
        clearTimeout(timer);
        originalResolve(data);
      };
      postToContent({ type: 'API_REQUEST', requestId: id, payload });
    });
  }

  function captureFrame() {
    return new Promise((resolve) => {
      const id = makeRequestId();
      const timer = setTimeout(() => {
        delete pendingRequests[id];
        resolve(null);
      }, 8000);
      pendingRequests[id] = (result) => {
        clearTimeout(timer);
        resolve(result);
      };
      postToContent({ type: 'CAPTURE_FRAME', requestId: id });
    });
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
      cues: msg.cues,
      text: msg.transcriptText,
      lectureTitle: msg.lectureTitle,
      lectureUrl: msg.lectureUrl || currentLectureUrl,
      videoDuration: msg.videoDuration
    };
    chrome.storage?.local?.set({
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
    const isGoogle = settings.provider === 'google';
    const maxTokens = guideMaxTokens(guideDetail, guideCount, isGoogle);

    const guideLang = getSelectedLanguage();
    const systemPrompt = buildGuidePrompt(guideDetail, guideCount, guideLang);
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
      guideMaxTokens: maxTokens
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

      guide = response.data;
      guide = sanitizeGuide(guide);

      chrome.storage?.local?.set({ currentGuide: guide, currentLectureUrl: currentLectureUrl });
      saveToHistory();

      setStatus('ready', `Guide ready · ${guide.guide.length} blocks`);
      showGuideContent();
      const mp = document.getElementById('manual-paste-section');
      if (mp) mp.remove();

    } catch (err) {
      console.error('[Copilot] GENERATE_GUIDE error:', err.message);
      generateError.textContent = err.message;
      generateError.style.display = 'block';
      setStatus('error', 'Guide generation failed');
      showManualPasteOption();
    } finally {
      isGenerating = false;
      generateBtn.querySelector('.btn-text').textContent = 'Generate Guide';
      generateBtn.querySelector('.btn-spinner').style.display = 'none';
      updateGenerateButton();
    }
  }

  function onRegenerateClick() {
    guide = null;
    currentBlockIndex = -1;
    qaMessages = [];
    guideContent.style.display = 'none';
    guideEmpty.style.display = '';
    generateError.style.display = 'none';
    chrome.storage?.local?.remove(['currentGuide', 'currentQaMessages']);
    qaMessages_el.innerHTML = '<div class="qa-welcome"><p>Ask anything about this lecture. I have the full transcript and guide as context.</p></div>';
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

  const LEVEL_SCORES = { low: 1, medium: 2, high: 3, very_high: 4 };

  function guideMaxTokens(detail, count, isGoogle) {
    const score = (LEVEL_SCORES[detail] || 4) + (LEVEL_SCORES[count] || 4);
    const cap = isGoogle ? 64000 : 32768;
    if (score <= 3) return Math.round(cap * 0.25);
    if (score <= 5) return Math.round(cap * 0.5);
    if (score <= 7) return Math.round(cap * 0.75);
    return cap;
  }

  function updateTokenHint() {
    if (!genTokenHint) return;
    const detail = genDetailSel?.value || 'very_high';
    const count = genCountSel?.value || 'very_high';
    const tokens = guideMaxTokens(detail, count, false);
    const fmt = n => (n / 1000).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    genTokenHint.textContent = `~${fmt(tokens)} 000 max output tokens`;
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
    const langInstruction = lang
      ? `\n\nLANGUAGE: Write ALL text content (titles, key_concepts, definitions, notes) in ${lang}. Keep JSON keys, LaTeX, and technical notation unchanged.`
      : '';

    return `You are an expert academic assistant that converts lecture transcripts into structured study guides.

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
- Blocks follow the logical flow of the lecture. One coherent topic = one block.
- Do NOT hallucinate. Only extract content actually in the transcript.
- Do NOT produce shallow one-liners unless the detail level is set to Low.
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
    if (autoFollowPauseHint) {
      autoFollowPauseHint.style.display = (autoTimeFollow && autoFollowPaused) ? '' : 'none';
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
    idx = Math.max(0, Math.min(n - 1, idx + delta));
    if (autoTimeFollow) {
      const liveIdx = findBlockIndex(lastVideoTime);
      autoFollowPaused = idx !== liveIdx;
      syncAutoFollowCheckbox();
    }
    renderBlock(idx);
  }

  function jumpToCurrentTimeBlock() {
    if (!guide?.guide?.length) return;
    autoFollowPaused = false;
    syncAutoFollowCheckbox();
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

    // Update counter + progress
    blockCounter.textContent = `${idx + 1} / ${blocks.length}`;
    progressFill.style.width = `${((idx + 1) / blocks.length) * 100}%`;

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
          ${block.key_concepts.map(c => `<li>${escHtml(c)}</li>`).join('')}
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
            <div class="definition-term">${escHtml(d.term)}</div>
            <div class="definition-text">${escHtml(d.definition)}</div>
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
          <div class="notes-text">${escHtml(block.notes)}</div>
        </div>
      `;
    }

    guideBlock.innerHTML = html;
    guideBlock.style.animation = 'none';
    void guideBlock.offsetWidth;
    guideBlock.style.animation = '';

    // Render KaTeX formulas
    guideBlock.querySelectorAll('.formula-render[data-latex]').forEach(el => {
      const latex = el.dataset.latex;
      try {
        katex.render(latex, el, { displayMode: true, throwOnError: false, trust: false });
      } catch (e) {
        el.textContent = latex;
      }
    });

    guideBlock.querySelectorAll('.latex-copy-btn[data-block-index]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const i = parseInt(btn.dataset.blockIndex, 10);
        await copyLatexFromSingleBlock(i);
      });
    });
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
    // Auto-resize textarea
    qaInput.style.height = 'auto';
    qaInput.style.height = Math.min(qaInput.scrollHeight, 120) + 'px';
  }

  async function sendQaMessage() {
    const text = qaInput.value.trim();
    if (!text || isChatting || !hasUsableSettings() || !transcript?.text) return;

    isChatting = true;
    qaSend.disabled = true;

    // Capture frame if checkbox checked
    let imageBase64 = null;
    if (attachCb.checked) {
      setStatus('loading', 'Capturing video frame…');
      imageBase64 = await captureFrame();
      attachCb.checked = false;
      framePreview.style.display = 'none';
      if (!imageBase64) {
        setStatus('warning', 'Frame capture failed — sending without image');
      }
    }

    setStatus('loading', 'Waiting for reply…');

    // Add user message to UI
    const userMsg = { role: 'user', content: text, imageBase64 };
    qaMessages.push(userMsg);
    appendChatMsg('user', text, !!imageBase64);
    qaInput.value = '';
    qaInput.style.height = 'auto';

    // Show typing indicator
    const typingEl = appendTypingIndicator();

    // Build system prompt with context (including script chunks if available)
    const systemPrompt = await buildQAPrompt(text);

    try {
      const qaTemp = qaTempSlider ? qaTempSlider.value / 100 : 0.35;

      const response = await apiRequest({
        type: 'CHAT',
        messages: qaMessages.map(m => ({ role: m.role, content: m.content, ...(m.imageBase64 ? { imageBase64: m.imageBase64 } : {}) })),
        systemPrompt,
        provider: settings.provider,
        model: settings.model || null,
        apiKey: settings.apiKey,
        localBase: getLocalBase(),
        chatTemperature: qaTemp
      });

      typingEl.remove();

      if (!response.success) throw new Error(response.error);

      const assistantText = response.data;
      qaMessages.push({ role: 'assistant', content: assistantText });
      appendChatMsg('assistant', assistantText, false);
      persistChat();

    } catch (err) {
      typingEl.remove();
      appendChatMsg('assistant', `⚠ Error: ${err.message}`, false);
    } finally {
      isChatting = false;
      onQaInputChange();
      restoreMainStatus();
    }
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

    return `You are a helpful study assistant for the ETH Zürich lecture: "${title}".
The student is currently at [${fmtSec(currentTime)}] in the video.

Answer based on the transcript excerpt and guide blocks below${hasScript ? ', plus course script excerpts' : ''}. Reference timestamps [HH:MM:SS] when relevant. Use LaTeX ($...$ inline, $$...$$ display). If the question is about a different part of the lecture, reference the lecture structure to guide the student.
${lectureOverview}
--- TRANSCRIPT (${fmtSec(windowStart)} to ${fmtSec(windowEnd)}) ---
${windowText}

--- GUIDE BLOCKS (current section) ---
${guideBlocksStr}${scriptContext}`;
  }

  function appendChatMsg(role, content, hasFrame) {
    const div = document.createElement('div');
    div.className = `chat-msg ${role}`;

    let bubbleHtml = '';
    if (role === 'user' && hasFrame) {
      bubbleHtml += `<span class="chat-frame-badge">📸</span>`;
    }
    bubbleHtml += `<div class="chat-bubble">${renderMarkdown(content)}</div>`;
    div.innerHTML = bubbleHtml;

    qaMessages_el.appendChild(div);

    // Render KaTeX in the new message
    if (role === 'assistant' && typeof renderMathInElement === 'function') {
      renderMathInElement(div, {
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '$', right: '$', display: false }
        ],
        throwOnError: false,
        trust: false
      });
    }

    qaMessages_el.scrollTop = qaMessages_el.scrollHeight;
    return div;
  }

  function appendTypingIndicator() {
    const div = document.createElement('div');
    div.className = 'chat-msg assistant';
    div.innerHTML = `<div class="typing-indicator">
      <div class="typing-dot"></div>
      <div class="typing-dot"></div>
      <div class="typing-dot"></div>
    </div>`;
    qaMessages_el.appendChild(div);
    qaMessages_el.scrollTop = qaMessages_el.scrollHeight;
    return div;
  }

  // Very basic markdown renderer (bold, italic, code, paragraphs)
  function renderMarkdown(text) {
    return text
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\n\n+/g, '</p><p>')
      .replace(/^/, '<p>').replace(/$/, '</p>')
      .replace(/<p><\/p>/g, '');
  }

  // ─── History Persistence ──────────────────────────────────────────────────

  function persistChat() {
    chrome.storage?.local?.set({ currentQaMessages: qaMessages });
    saveToHistory();
  }

  function saveToHistory() {
    if (!guide?.guide?.length || !currentLectureUrl) return;
    chrome.storage?.local?.get(['guideHistory'], saved => {
      let history = Array.isArray(saved.guideHistory) ? [...saved.guideHistory] : [];
      const norm = normalizeLectureUrl(currentLectureUrl);
      const prevSame = history.find(h => normalizeLectureUrl(h.lectureUrl) === norm);
      history = history.filter(h => normalizeLectureUrl(h.lectureUrl) !== norm);
      const entry = {
        lectureUrl: currentLectureUrl,
        lectureTitle: transcript?.lectureTitle || guide?.lecture_title || 'Lecture',
        date: new Date().toISOString(),
        guide,
        qaMessages: qaMessages.length ? qaMessages : (prevSame?.qaMessages || [])
      };
      history.unshift(entry);
      if (history.length > 50) history.length = 50;
      chrome.storage?.local?.set({ guideHistory: history });
    });
  }

  function loadHistory() {
    const container = document.getElementById('history-list');
    if (!container) return;
    container.innerHTML = '<p style="color:var(--text-muted);font-size:12px;padding:14px;">Loading…</p>';
    chrome.storage?.local?.get(['guideHistory'], saved => {
      const history = Array.isArray(saved.guideHistory) ? saved.guideHistory : [];
      if (!history.length) {
        container.innerHTML = '<p style="color:var(--text-muted);font-size:12px;padding:14px;">No previous guides yet.</p>';
        return;
      }
      container.innerHTML = '';
      for (const entry of history) {
        const isActive = entry.lectureUrl === currentLectureUrl;
        const div = document.createElement('div');
        div.className = 'history-item' + (isActive ? ' history-active' : '');
        const dateStr = new Date(entry.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        const blockCount = entry.guide?.guide?.length || 0;
        const chatCount = entry.qaMessages?.length || 0;
        div.innerHTML = `
          <div class="history-title">${escHtml(entry.lectureTitle)}</div>
          <div class="history-meta">
            <span>${dateStr}</span>
            <span>${blockCount} blocks</span>
            ${chatCount ? `<span>${Math.floor(chatCount / 2)} Q&amp;As</span>` : ''}
          </div>
          <div class="history-actions">
            <a class="history-link" href="${escAttr(entry.lectureUrl)}" target="_blank" title="Open lecture">Open lecture</a>
            <button class="history-load-btn" title="Load this guide">Load guide</button>
            <button class="history-pdf-btn" type="button" title="Export guide as PDF">PDF</button>
            ${!isActive ? '<button class="history-delete-btn" title="Delete">Delete</button>' : ''}
          </div>
        `;
        div.querySelector('.history-load-btn').addEventListener('click', () => loadHistoryEntry(entry));
        div.querySelector('.history-pdf-btn').addEventListener('click', () => {
          if (entry.guide?.guide?.length) {
            openGuidePrintWindow(entry.guide, entry.lectureTitle);
          }
        });
        const delBtn = div.querySelector('.history-delete-btn');
        if (delBtn) delBtn.addEventListener('click', () => deleteHistoryEntry(entry.lectureUrl));
        container.appendChild(div);
      }
    });
  }

  function loadHistoryEntry(entry) {
    guide = entry.guide;
    qaMessages = Array.isArray(entry.qaMessages) ? entry.qaMessages : [];
    transcript = transcript || { cues: [], text: '', lectureTitle: entry.lectureTitle, videoDuration: 0 };

    showGuideContent();
    setStatus('ready', `Guide loaded · ${guide.guide.length} blocks`);

    // Restore chat UI
    qaMessages_el.innerHTML = '';
    if (qaMessages.length) {
      restoreChatUI();
    } else {
      qaMessages_el.innerHTML = '<div class="qa-welcome"><p>Ask anything about this lecture.</p></div>';
    }
    switchTab('guide');
  }

  function deleteHistoryEntry(url) {
    chrome.storage?.local?.get(['guideHistory'], saved => {
      const history = (saved.guideHistory || []).filter(h => h.lectureUrl !== url);
      chrome.storage?.local?.set({ guideHistory: history }, () => loadHistory());
    });
  }

  // ─── Tab Switching ────────────────────────────────────────────────────────

  function switchTab(tabName) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tabName));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('active', c.id === `tab-${tabName}`));
    if (tabName === 'history') loadHistory();
  }

  // ─── Theme ────────────────────────────────────────────────────────────────

  function toggleTheme() {
    const html = document.documentElement;
    const current = html.dataset.theme;
    const next = current === 'dark' ? 'light' : 'dark';
    html.dataset.theme = next;
    localStorage.setItem('eth-copilot-theme', next);
    applyUISettings();
  }

  function applyStoredTheme() {
    const saved = localStorage.getItem('eth-copilot-theme');
    if (saved) document.documentElement.dataset.theme = saved;
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

  function fmtSec(s) {
    s = Math.floor(s || 0);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
  }

  function renderFormulaLatexForExport(latex) {
    try {
      return katex.renderToString(String(latex || ''), { displayMode: true, throwOnError: false, trust: false });
    } catch (e) {
      return `<span class="formula-fallback">${escHtml(latex)}</span>`;
    }
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
          ${block.key_concepts.map(c => `<li>${escHtml(c)}</li>`).join('')}
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
            <div class="definition-term">${escHtml(d.term)}</div>
            <div class="definition-text">${escHtml(d.definition)}</div>
          </div>
        `).join('')}
      </div>`;
    }

    if (block.notes?.trim()) {
      html += `
        <div class="notes-box">
          <div class="notes-icon-label">Note</div>
          <div class="notes-text">${escHtml(block.notes)}</div>
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
  })();

  // ─── Bootstrap ───────────────────────────────────────────────────────────
  init();

})();
