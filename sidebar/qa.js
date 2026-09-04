/**
 * sidebar/qa.js — Q&A chat: prompts, sending, streaming replies, and the lecture summary.
 *
 * Part of the sidebar, loaded as a plain script in the order listed in
 * sidebar.html. All sidebar modules share one global scope on purpose:
 * it is what lets each file be a straight move out of the old sidebar.js.
 */

// ─── Q&A Chat ─────────────────────────────────────────────────────────────

function abortQaStream(chatIdx) {
  for (const [reqId, state] of qaActiveStreams.entries()) {
    if (state.chatIdx === chatIdx) {
      state.abortFn?.();
      return;
    }
  }
}

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

const LECTURE_SUMMARY_USER_LABEL = '[Lecture Summary Request]';
const LECTURE_SUMMARY_ADD_TO_CONTEXT_LABEL = '[Lecture summary added to context]';
const LECTURE_SUMMARY_REMOVE_FROM_CONTEXT_LABEL = '[Lecture summary removed from context]';

function lectureSummaryReady() {
  return !!(lectureSummaryText || '').trim() && !lectureSummaryGenerating;
}

function resolveStreamAssistantText(responseData, streamState) {
  const fromBuffer = (streamState?.buffer || '').trim();
  const fromResponse = (responseData || '').trim();
  return fromBuffer || fromResponse || '';
}

/** Remove summary generation and context-marker messages — summary lives in storage + system prompt only. */
function stripLectureSummaryChatMessages(messages) {
  if (!Array.isArray(messages)) return [];
  const out = [];
  let skipNextAssistant = false;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'user' && m.content === LECTURE_SUMMARY_USER_LABEL) {
      skipNextAssistant = true;
      continue;
    }
    if (skipNextAssistant && m.role === 'assistant') {
      skipNextAssistant = false;
      continue;
    }
    skipNextAssistant = false;
    if (m.role === 'user' && (
      m.content === LECTURE_SUMMARY_ADD_TO_CONTEXT_LABEL ||
      m.content === LECTURE_SUMMARY_REMOVE_FROM_CONTEXT_LABEL
    )) continue;
    out.push(m);
  }
  return out;
}

function chatSummaryInContextFromMessages(messages) {
  let inContext = false;
  for (const m of messages || []) {
    if (m.content === LECTURE_SUMMARY_ADD_TO_CONTEXT_LABEL) inContext = true;
    if (m.content === LECTURE_SUMMARY_REMOVE_FROM_CONTEXT_LABEL) inContext = false;
  }
  return inContext;
}

function sanitizeQaChatsSummaryHistory() {
  let changed = false;
  for (const chat of qaChats) {
    const stripped = stripLectureSummaryChatMessages(chat.messages);
    if (stripped.length !== (chat.messages?.length || 0)) {
      chat.messages = stripped;
      changed = true;
    }
  }
  if (changed) {
    qaMessages = qaChats[activeQaChatIdx]?.messages || [];
    persistChat();
  }
}

function inferLectureSummaryFromChats() {
  for (const chat of qaChats) {
    const msgs = chat.messages || [];
    for (let i = msgs.length - 1; i >= 1; i--) {
      if (msgs[i].role === 'assistant' && msgs[i - 1].role === 'user' &&
          msgs[i - 1].content === LECTURE_SUMMARY_USER_LABEL) {
        const t = (msgs[i].content || '').trim();
        if (t) return t;
      }
    }
  }
  return null;
}

function ensureLectureSummaryRestored(saved) {
  if (!lectureSummaryText) restoreLectureSummaryFromStorage(saved || {});
  if (!lectureSummaryText) {
    const inferred = inferLectureSummaryFromChats();
    if (inferred) {
      lectureSummaryText = inferred;
      lectureSummarySource = lectureSummarySource || 'qa';
      persistLectureSummary();
      sanitizeQaChatsSummaryHistory();
    }
  }
}

function isLectureSummaryGenerating() {
  return lectureSummaryGenerating;
}

/**
 * Forget the lecture summary everywhere it can be remembered: the text, the
 * Q&A panels, and every chat's "in context" flag. The summary describes one
 * specific guide, so anything that invalidates the guide must call this —
 * otherwise a new guide silently keeps feeding the old summary to the model.
 */
function clearLectureSummaryState({ persist = true } = {}) {
  lectureSummaryText = null;
  lectureSummarySource = null;
  lectureSummaryGenerating = false;
  _lectureSummaryQaChatIdx = null;
  _lectureSummaryGuideBody = null;

  // Reset "add to context" on every chat — the flag outlives the panel.
  let touched = false;
  for (const chat of qaChats) {
    if (chat?.summaryInContext) { chat.summaryInContext = false; touched = true; }
  }
  if (touched && persist) persistChat();

  removeAllQaSummaryPanels();
  if (persist) chrome.storage?.local?.remove(['currentLectureSummary']);
  syncSummaryUi();
}

/** Throw away the current summary and immediately build a fresh one. */
function regenerateLectureSummary(source, guideBodyEl) {
  if (isLectureSummaryGenerating()) return;
  clearLectureSummaryState();
  runLectureSummaryGeneration({ source, chatIdx: activeQaChatIdx, guideBodyEl });
}

function persistLectureSummary() {
  const text = (lectureSummaryText || '').trim();
  if (!text || !currentLectureUrl) return;
  const norm = normalizeLectureUrl(currentLectureUrl);
  storageSet({
    currentLectureSummary: {
      lectureUrl: norm,
      text: lectureSummaryText,
      source: lectureSummarySource
    }
  });
  chrome.storage?.local?.get(['guideHistory'], saved => {
    const history = Array.isArray(saved.guideHistory) ? saved.guideHistory : [];
    const entry = history.find(h => normalizeLectureUrl(h.lectureUrl) === norm);
    if (entry) {
      entry.lectureSummary = lectureSummaryText;
      storageSet({ guideHistory: history });
    }
  });
}

function restoreLectureSummaryFromStorage(saved) {
  const cached = saved?.currentLectureSummary;
  if (!cached?.text || !currentLectureUrl) return;
  if (normalizeLectureUrl(cached.lectureUrl) !== normalizeLectureUrl(currentLectureUrl)) return;
  lectureSummaryText = cached.text;
  lectureSummarySource = cached.source || null;
}

function setLectureSummaryComplete(text, source) {
  lectureSummaryText = text;
  lectureSummarySource = source;
  persistLectureSummary();
  refreshInlineLectureSummaryIfOpen();
  updateLectureSummaryBtn();
}

function syncSummaryUi() {
  updateLectureSummaryBtn();
  refreshInlineLectureSummaryIfOpen();
  renderAllQaSummaryPanels();
}

/** DOM-only summary panel in Q&A — never stored in chat.messages or sent to the API. */
function renderQaSummaryPanelForChat(chatIdx, opts = {}) {
  const col = getChatCol(chatIdx);
  if (!col) return null;
  col.querySelector('.qa-lecture-summary-panel')?.remove();

  const generatingHere = opts.streaming || (isLectureSummaryGenerating() && _lectureSummaryQaChatIdx === chatIdx);
  if (!lectureSummaryReady() && !generatingHere) return null;

  const chat = qaChats[chatIdx];
  const inContext = !!chat?.summaryInContext;
  const panel = document.createElement('div');
  panel.className = 'qa-lecture-summary-panel';
  panel.dataset.qaUiOnly = '1';

  const contextTip = inContext
    ? 'This chat includes the summary in the AI system prompt (not as chat messages).'
    : 'This chat does not include the summary in the AI system prompt — use Add to context on the button below.';
  const badgeClass = inContext ? 'qa-summary-badge-on' : 'qa-summary-badge-off';
  const badgeText = inContext ? 'In AI context' : 'Not in AI context';

  panel.innerHTML = `
      <div class="qa-lecture-summary-panel-head">
        <span class="qa-lecture-summary-panel-title">Lecture summary</span>
        <span class="qa-summary-context-badge ${badgeClass}" title="${escHtml(contextTip)}">${badgeText}</span>
      </div>
      <p class="qa-lecture-summary-panel-hint" title="This panel is for reading only. Your normal Q&amp;A messages are sent separately; the summary is injected via the system prompt only when In AI context.">
        For reading only — not sent as chat history. AI uses it via system prompt when marked “In AI context”.
      </p>
      <div class="qa-summary-actions">
        <button type="button" class="qa-summary-action" data-summary-act="expand">Expand</button>
        <button type="button" class="qa-summary-action" data-summary-act="regenerate">Regenerate</button>
        <button type="button" class="qa-summary-action" data-summary-act="settings">Settings</button>
      </div>
      <div class="qa-summary-settings" hidden>${_summaryOptionsHtml()}</div>
      <div class="qa-lecture-summary-panel-body"></div>`;

  const body = panel.querySelector('.qa-lecture-summary-panel-body');
  if (generatingHere) {
    body.innerHTML = `
        <p class="inline-tool-hint">Generating…</p>
        <div class="lecture-summary-stream">
          <div class="chat-msg assistant">
            <div class="chat-bubble qa-summary-stream-bubble">
              <div class="qa-katex-zone"></div>
              <span class="qa-stream-cursor" aria-hidden="true"></span>
            </div>
          </div>
        </div>`;
  } else {
    body.innerHTML = '<div class="lecture-summary-view"></div>';
    renderLectureSummaryMarkdown(body.querySelector('.lecture-summary-view'), lectureSummaryText);
  }

  if (generatingHere) {
    panel.querySelector('[data-summary-act="regenerate"]').disabled = true;
  }

  // Restore the reader's choices: the panel is rebuilt as the summary
  // streams, and without this it would snap shut on every chunk.
  if (_qaSummaryExpanded) {
    panel.classList.add('is-expanded');
    panel.querySelector('[data-summary-act="expand"]').textContent = 'Shrink';
  }
  if (_qaSummarySettingsOpen) {
    panel.querySelector('.qa-summary-settings').hidden = false;
    panel.querySelector('[data-summary-act="settings"]').textContent = 'Hide settings';
  }

  col.appendChild(panel);
  requestAnimationFrame(() => {
    // While generating, follow the text inside the box. Scrolling the whole
    // conversation on every chunk is what made this so intrusive.
    if (generatingHere) keepSummaryStreamPinned(panel);
    else col.scrollTo({ top: col.scrollHeight, behavior: 'smooth' });
  });
  return panel.querySelector('.qa-summary-stream-bubble');
}

/**
 * Buttons on the Q&A summary panel. Delegated once, so every chat's copy
 * works and rebuilding a panel mid-stream never loses its handlers.
 *
 * "Expand" only raises the height cap — the box stays scrollable either
 * way. Letting it grow freely is what made streaming unreadable.
 */
document.addEventListener('click', (ev) => {
  const btn = ev.target?.closest?.('[data-summary-act]');
  if (!btn) return;
  const panel = btn.closest('.qa-lecture-summary-panel');
  if (!panel) return;

  switch (btn.getAttribute('data-summary-act')) {
    case 'expand': {
      const expanded = panel.classList.toggle('is-expanded');
      btn.textContent = expanded ? 'Shrink' : 'Expand';
      _qaSummaryExpanded = expanded;
      break;
    }
    case 'settings': {
      const box = panel.querySelector('.qa-summary-settings');
      box.hidden = !box.hidden;
      btn.textContent = box.hidden ? 'Settings' : 'Hide settings';
      _qaSummarySettingsOpen = !box.hidden;
      break;
    }
    case 'regenerate':
      // Same entry point the guide-side button uses, so both routes share
      // one definition of what regenerating means (and it clears first).
      regenerateLectureSummary('qa', null);
      break;
  }
});

// Remembered across the rebuilds that streaming triggers, so the panel does
// not snap shut every time a chunk arrives.
let _qaSummaryExpanded = false;
let _qaSummarySettingsOpen = false;

/** Keep the newest text in view without dragging the whole chat down. */
function keepSummaryStreamPinned(panel) {
  const box = panel?.querySelector('.lecture-summary-stream');
  if (!box) return;
  box.scrollTop = box.scrollHeight;
}

function renderAllQaSummaryPanels() {
  for (let i = 0; i < qaChats.length; i++) renderQaSummaryPanelForChat(i);
}

function removeAllQaSummaryPanels() {
  document.querySelectorAll('.qa-lecture-summary-panel').forEach(el => el.remove());
}

function renderLectureSummaryMarkdown(container, text) {
  if (!container) return;
  setRichTextHtml(container, text);
  container.querySelectorAll('.qa-timestamp-link').forEach(btn => {
    btn.setAttribute('type', 'button');
  });
}

function onGuideInlineBodyClick(e) {
  const ts = e.target?.closest?.('.qa-timestamp-link[data-seconds]');
  if (!ts) return;
  e.preventDefault();
  const seconds = Number(ts.dataset.seconds);
  if (!Number.isFinite(seconds) || seconds < 0) return;
  postToContent({ type: 'SEEK_VIDEO', time: seconds });
}

function refreshInlineLectureSummaryIfOpen() {
  if (_inlineToolActive !== 'summary') return;
  const bodyEl = document.getElementById('guide-inline-tool-body');
  if (bodyEl) _buildInlineLectureSummary(bodyEl);
}

function updateLectureSummaryBtn() {
  if (!qaLectureSummaryBtn) return;
  const labelEl = qaLectureSummaryBtn.querySelector('.attach-text');
  const hasSettings = hasUsableSettings();
  const hasTranscript = !!transcript?.text;
  const hasGuide = !!guide?.guide?.length;
  const streaming = isChatStreaming(activeQaChatIdx);
  const chat = qaChats[activeQaChatIdx];
  const ready = lectureSummaryReady();
  const generating = isLectureSummaryGenerating();

  if (generating) {
    qaLectureSummaryBtn.disabled = true;
    qaLectureSummaryBtn.title = 'Generating lecture summary — shown below in this panel (not added to chat history)';
    if (labelEl) labelEl.textContent = 'Generating…';
    return;
  }

  if (ready) {
    if (chat?.summaryInContext) {
      qaLectureSummaryBtn.disabled = streaming;
      qaLectureSummaryBtn.title =
        'Summary is in this chat\'s AI system prompt (not as messages). Click to stop using it for new replies. The panel above stays for reading.';
      if (labelEl) labelEl.textContent = 'Remove from context';
    } else {
      qaLectureSummaryBtn.disabled = !hasSettings || streaming;
      qaLectureSummaryBtn.title =
        'Inject the saved summary into this chat\'s system prompt only — not into chat history. Other chats are unaffected.';
      if (labelEl) labelEl.textContent = 'Add to context';
    }
    return;
  }

  qaLectureSummaryBtn.disabled = !hasSettings || !hasTranscript || !hasGuide || streaming;
  if (labelEl) labelEl.textContent = 'Lecture summary';
  if (!hasSettings) {
    qaLectureSummaryBtn.title = 'Add an API key in Settings first';
  } else if (!hasTranscript) {
    qaLectureSummaryBtn.title = 'Waiting for transcript to load';
  } else if (!hasGuide) {
    qaLectureSummaryBtn.title = 'Generate a guide first';
  } else if (streaming) {
    qaLectureSummaryBtn.title = 'Wait for the current reply to finish';
  } else {
    qaLectureSummaryBtn.title =
      'Generate exam-focused summary (full guide + transcript). Shown in the panel below — not stored as chat messages. This chat will include it in the AI system prompt automatically.';
  }
}

function onQaLectureSummaryClick() {
  if (isLectureSummaryGenerating()) return;
  const chat = qaChats[activeQaChatIdx];
  if (lectureSummaryReady() && chat?.summaryInContext) {
    removeLectureSummaryFromChatContext(activeQaChatIdx);
  } else if (lectureSummaryReady()) {
    addLectureSummaryToChatContext(activeQaChatIdx);
  } else {
    runLectureSummaryGeneration({ source: 'qa', chatIdx: activeQaChatIdx });
  }
}

function removeLectureSummaryFromChatContext(chatIdx) {
  if (isLectureSummaryGenerating()) return;
  const chat = qaChats[chatIdx];
  if (!chat?.summaryInContext) return;

  chat.summaryInContext = false;
  persistChat();
  syncSummaryUi();
  setStatus('ready', 'Lecture summary removed from this chat\'s AI context');
}

function addLectureSummaryToChatContext(chatIdx) {
  if (!lectureSummaryReady() || isLectureSummaryGenerating()) return;
  const chat = qaChats[chatIdx];
  if (!chat || chat.summaryInContext) return;

  chat.summaryInContext = true;
  persistChat();
  syncSummaryUi();
  setStatus('ready', 'Lecture summary added to this chat\'s AI context (system prompt only)');
}

function buildFullTranscriptText() {
  if (transcript?.cues?.length) {
    return transcript.cues.map(c => `[${fmtSec(c.start_time)}] ${c.text}`).join('\n');
  }
  return transcript?.text || '(no transcript)';
}

// ── Lecture summary options ───────────────────────────────────────────────
// Same storage pattern as the per-tool thinking setting.
const SUMMARY_STYLES = {
  exam: {
    label: 'Exam preparation',
    hint: 'Definitions, theorems, likely exam questions',
    rules: [
      'Prioritize exam-relevant content: definitions, theorems, key arguments, formulas, algorithms, and typical proof patterns',
      'Add a dedicated section on likely exam questions and what examiners often test',
      'Add practical tips, common mistakes, and memory hooks where the lecture supports them'
    ]
  },
  overview: {
    label: 'Overview',
    hint: 'The big picture and how ideas connect',
    rules: [
      'Lead with the overall narrative: what problem the lecture addresses and how the parts fit together',
      'Emphasize connections between topics and the intuition behind them over formal detail',
      'Keep formal statements short — enough to recognise them, not to reproduce every proof'
    ]
  },
  cheatsheet: {
    label: 'Cheat sheet',
    hint: 'Dense reference — formulas, definitions, facts',
    rules: [
      'Write as a dense reference sheet: short labelled entries, no prose paragraphs',
      'Favour formulas, definitions, conditions and results over explanation',
      'Group by topic with compact headers so a specific fact can be found quickly'
    ]
  },
  feynman: {
    label: 'Explain simply',
    hint: 'Plain language, worked intuition',
    rules: [
      'Explain every major idea in plain language first, as if teaching someone seeing it for the first time',
      'Use concrete examples and analogies that the lecture itself supports',
      'Introduce notation only after the idea behind it is clear'
    ]
  }
};

const SUMMARY_LENGTHS = {
  short:    { label: 'Short',    rule: 'Keep it tight — the essentials only, roughly one screen of reading.' },
  standard: { label: 'Standard', rule: 'Balanced coverage — complete without unnecessary verbosity.' },
  thorough: { label: 'Thorough', rule: 'Full coverage — every topic in the guide gets its own treatment, with detail.' }
};

const SUMMARY_OPTS_KEY = 'lectureSummaryOptions';
let summaryOptions = { style: 'exam', length: 'standard', language: '__guide__', focus: '' };

function setSummaryOption(key, value) {
  summaryOptions = { ...summaryOptions, [key]: value };
  storageSet({ [SUMMARY_OPTS_KEY]: summaryOptions });
}

function buildLectureSummaryPrompt() {
  const title = transcript?.lectureTitle || guide?.lecture_title || 'Lecture';
  const guideBlocksStr = guide?.guide?.length
    ? JSON.stringify(guide.guide, null, 2)
    : '(guide not available)';
  const fullTranscript = buildFullTranscriptText();
  const qaExtraPrefix = customPromptExtras.qa ? customPromptExtras.qa.trim() + '\n\n' : '';

  const style = SUMMARY_STYLES[summaryOptions.style] || SUMMARY_STYLES.exam;
  const length = SUMMARY_LENGTHS[summaryOptions.length] || SUMMARY_LENGTHS.standard;
  const styleRules = style.rules.map(r => `- ${r}`).join('\n');

  const lang = summaryOptions.language === '__guide__'
    ? (guideLanguage || '')
    : summaryOptions.language;
  const languageLine = lang
    ? `\nLANGUAGE: Write the entire summary in ${lang}. Keep LaTeX and technical notation unchanged.`
    : '\nLANGUAGE: Write in the dominant language of the transcript.';

  const focus = String(summaryOptions.focus || '').trim();
  const focusLine = focus
    ? `\nEXTRA FOCUS FROM THE STUDENT (honour it, but never at the cost of coverage): ${focus}`
    : '';

  return `${qaExtraPrefix}You are an expert ETH Zürich tutor. Produce ONE lecture summary based ONLY on the materials below.

STYLE: ${style.label} — ${style.hint}
${styleRules}

LENGTH: ${length.label} — ${length.rule}
${languageLine}${focusLine}

MUST:
- Cover every major topic from the FULL GUIDE and FULL TRANSCRIPT — nothing important omitted
- Use clear markdown (## sections, bullets). Use LaTeX ($...$ inline, $$...$$ display) for math
- Reference timestamps [HH:MM:SS] when anchoring content to the video

MUST NOT:
- Invent facts, topics, or exam hints not supported by the guide or transcript
- Filler, motivational padding, or meta-commentary about being an AI
- Repeat the same point in multiple sections

--- FULL TRANSCRIPT (${title}) ---
${fullTranscript}

--- FULL GUIDE (${title}) ---
${guideBlocksStr}`;
}

let _lectureSummaryGuideBody = null;
let _lectureSummaryQaChatIdx = null;

function handleLectureSummaryStreamChunk(msg, streamState) {
  if (streamState.source === 'guide') {
    handleGuideSummaryStreamChunk(msg, streamState);
  } else if (streamState.qaSummaryBubble) {
    handleGuideSummaryStreamChunk(msg, { ...streamState, guideStreamBubble: streamState.qaSummaryBubble });
  }
}

function handleGuideSummaryStreamChunk(msg, streamState) {
  if (!streamState.guideStreamBubble || streamState.finalized) return;
  streamState.buffer += msg.text || '';
  QaStreamFlush.scheduleStreamFlush(streamState, flushGuideSummaryStream);
}

function flushGuideSummaryStream(state) {
  const bubble = state.guideStreamBubble;
  if (!bubble || state.finalized) return;
  if (!QaStreamFlush.isStreamingChatBubble(bubble)) return;
  const buf = state.buffer;
  const cursor = bubble.querySelector('.qa-stream-cursor');
  const katexZ = bubble.querySelector('.qa-katex-zone');
  let katexCutoff = state.katexEnd;
  let i = katexCutoff;
  while (i < buf.length - 1) {
    if (buf[i] === '$' && buf[i + 1] === '$') {
      const closeIdx = buf.indexOf('$$', i + 2);
      if (closeIdx !== -1) { katexCutoff = closeIdx + 2; i = closeIdx + 2; }
      else break;
    } else { i++; }
  }
  if (katexCutoff > state.katexEnd && katexZ) {
    katexZ.textContent = buf.slice(0, katexCutoff);
    applyKatex(katexZ);
    state.katexEnd = katexCutoff;
    Array.from(bubble.childNodes).forEach(node => {
      if (node !== katexZ && node !== cursor) node.remove();
    });
    state.stableEnd = katexCutoff;
  }
  const newText = buf.slice(state.stableEnd);
  if (newText) {
    newText.split('\n').forEach((line, idx) => {
      if (idx > 0) {
        const br = document.createElement('br');
        cursor ? bubble.insertBefore(br, cursor) : bubble.appendChild(br);
      }
      if (line.length > 0) {
        const span = document.createElement('span');
        span.className = 'qa-chunk';
        span.innerHTML = applyStreamingLineMarkdown(line);
        cursor ? bubble.insertBefore(span, cursor) : bubble.appendChild(span);
      }
    });
    state.stableEnd = buf.length;
  }
}

function _renderGuideSummaryStreaming(body) {
  body.innerHTML = `
      <p class="inline-tool-hint">Generating lecture summary…</p>
      <div class="lecture-summary-stream">
        <div class="chat-msg assistant">
          <div class="chat-bubble">
            <div class="qa-katex-zone"></div>
            <span class="qa-stream-cursor" aria-hidden="true"></span>
          </div>
        </div>
      </div>`;
  return body.querySelector('.chat-bubble');
}

function _finishGuideSummaryStreamBubble(bubble, text, streamState) {
  if (!bubble) return;
  if (streamState) QaStreamFlush.stopStreamFlush(streamState);
  bubble.style.transition = 'opacity 0.12s ease';
  bubble.style.opacity = '0.2';
  setTimeout(() => {
    setRichTextHtml(bubble, text);
    bubble.style.opacity = '1';
    setTimeout(() => { bubble.style.transition = ''; }, 180);
  }, 120);
}

async function runLectureSummaryGeneration({ source, chatIdx, guideBodyEl }) {
  if (!hasUsableSettings() || !transcript?.text || !guide?.guide?.length) return;
  if (isLectureSummaryGenerating() || lectureSummaryReady()) return;

  const sendChatIdx = source === 'qa' ? (chatIdx ?? activeQaChatIdx) : null;
  if (source === 'qa' && isChatStreaming(sendChatIdx)) return;

  lectureSummaryGenerating = true;
  lectureSummarySource = source;
  _lectureSummaryGuideBody = guideBodyEl || _lectureSummaryGuideBody;
  syncSummaryUi();

  if (source === 'qa') {
    hideQaReplyReadyToast();
    _lectureSummaryQaChatIdx = sendChatIdx;
  } else if (guideBodyEl) {
    _lectureSummaryGuideBody = guideBodyEl;
    openInlineToolPanel('summary', 'Lecture Summary', _buildInlineLectureSummary);
  }

  setStatus('loading', 'Generating lecture summary…');

  const systemPrompt = buildLectureSummaryPrompt();
  const useStream = !!settings.provider;
  const apiUserMessage = 'Generate the complete lecture summary now. Follow every instruction in the system prompt.';

  let typingEl = null;
  let streamEl = null;
  let streamBubble = null;
  let guideStreamBubble = null;

  let qaSummaryBubble = null;
  if (source === 'guide' && _lectureSummaryGuideBody) {
    if (useStream) {
      guideStreamBubble = _renderGuideSummaryStreaming(_lectureSummaryGuideBody);
    } else {
      _lectureSummaryGuideBody.innerHTML = '<p class="inline-tool-hint">Generating lecture summary…</p>';
    }
  } else if (source === 'qa' && useStream) {
    qaSummaryBubble = renderQaSummaryPanelForChat(sendChatIdx, { streaming: true });
  } else if (source === 'qa') {
    renderQaSummaryPanelForChat(sendChatIdx, { streaming: true });
  }

  let streamState = null;
  let req = null;

  try {
    const qaTemp = qaTempSlider ? qaTempSlider.value / 100 : 0.35;
    const qaThinking = qaThinkingSel?.value || 'none';

    req = apiRequest({
      type: 'CHAT',
      _label: 'Lecture summary',
      messages: [{ role: 'user', content: apiUserMessage }],
      systemPrompt,
      provider: settings.provider,
      model: settings.model || null,
      apiKey: settings.apiKey,
      localBase: getLocalBase(),
      chatTemperature: qaTemp,
      chatThinking: qaThinking,
      useStream
    });

    if (useStream) {
      streamState = {
        kind: 'lecture-summary',
        source,
        chatIdx: source === 'qa' ? null : sendChatIdx,
        el: streamEl,
        bubble: streamBubble,
        guideStreamBubble,
        qaSummaryBubble,
        buffer: '',
        stableEnd: 0,
        katexEnd: 0,
        rafPending: false,
        katexThrottle: null,
        abortFn: req.abort
      };
      qaActiveStreams.set(req._requestId, streamState);
      onQaInputChange();
    }

    const response = await req;
    if (!response.success) throw new Error(response.error);

    const assistantText = resolveStreamAssistantText(response.data, streamState);
    lectureSummaryGenerating = false;
    if (assistantText) {
      setLectureSummaryComplete(assistantText, source);
      saveToHistory();
    } else {
      // The provider answered with nothing usable. Say so — silently doing
      // nothing here looked exactly like the button was never pressed.
      throw new Error('The model returned an empty summary. Try again, or switch model.');
    }

    if (source === 'qa' && !qaChats[sendChatIdx]) {
      // The chat this was started from is gone (switched/deleted). The
      // summary is saved, so show it rather than dropping it on the floor.
      setStatus('ready', 'Lecture summary ready — open it from the guide panel.');
      refreshInlineLectureSummaryIfOpen();
      syncSummaryUi();
    } else if (source === 'qa' && assistantText && qaChats[sendChatIdx]) {
      if (streamState) {
        QaStreamFlush.stopStreamFlush(streamState);
        qaActiveStreams.delete(req._requestId);
      }
      qaChats[sendChatIdx].summaryInContext = true;
      persistChat();
      renderQaSummaryPanelForChat(sendChatIdx);
      setStatus('ready', 'Lecture summary ready below — included in this chat\'s AI context (system prompt, not chat history)');
      refreshInlineLectureSummaryIfOpen();
    } else if (source === 'guide') {
      if (useStream) {
        if (streamState) {
          QaStreamFlush.stopStreamFlush(streamState);
          qaActiveStreams.delete(req._requestId);
        }
        _finishGuideSummaryStreamBubble(guideStreamBubble, assistantText, streamState);
        setTimeout(() => refreshInlineLectureSummaryIfOpen(), 200);
      } else {
        refreshInlineLectureSummaryIfOpen();
      }
    }
  } catch (err) {
    lectureSummaryGenerating = false;
    if (streamState) {
      if (streamState.katexThrottle) { clearTimeout(streamState.katexThrottle); streamState.katexThrottle = null; }
      QaStreamFlush.stopStreamFlush(streamState);
      if (req?._requestId) qaActiveStreams.delete(req._requestId);
    }
    if (source === 'qa') {
      if (err.message === 'Request aborted.' && streamState?.buffer?.trim()) {
        setLectureSummaryComplete(streamState.buffer, source);
        saveToHistory();
        if (qaChats[sendChatIdx]) {
          qaChats[sendChatIdx].summaryInContext = true;
          persistChat();
          renderQaSummaryPanelForChat(sendChatIdx);
        }
        setStatus('ready', 'Partial summary saved — in AI context for this chat');
      } else if (err.message !== 'Request aborted.') {
        setStatus('error', humanizeApiError(err.message));
        renderQaSummaryPanelForChat(sendChatIdx);
      }
    } else if (source === 'guide' && _lectureSummaryGuideBody) {
      if (err.message === 'Request aborted.' && streamState?.buffer?.trim()) {
        setLectureSummaryComplete(streamState.buffer, source);
        refreshInlineLectureSummaryIfOpen();
      } else if (err.message !== 'Request aborted.') {
        _lectureSummaryGuideBody.innerHTML = `<p class="inline-tool-error">${escHtml(humanizeApiError(err.message))}</p>`;
      } else {
        refreshInlineLectureSummaryIfOpen();
      }
    }
    syncSummaryUi();
  } finally {
    _lectureSummaryQaChatIdx = null;
    if (lectureSummaryGenerating) {
      lectureSummaryGenerating = false;
      syncSummaryUi();
    }
    onQaInputChange();
    restoreMainStatus();
  }
}

function onQaInputChange() {
  const hasText = qaInput.value.trim().length > 0;
  const hasSettings = hasUsableSettings();
  const hasTranscript = transcript?.text;
  const activeChatStreaming = isChatStreaming(activeQaChatIdx);
  updateLectureSummaryBtn();
  // Toggle between send and stop mode
  if (activeChatStreaming) {
    qaSend.classList.add('qa-send-stop');
    qaSend.title = 'Stop generation';
    qaSend.disabled = false; // stop button is always clickable
  } else {
    qaSend.classList.remove('qa-send-stop');
    qaSend.disabled = !hasText || !hasSettings || !hasTranscript;
    // A greyed-out button with the reason hidden in a tooltip is the same as
    // no reason at all — say it in the box the user is already looking at.
    if (!hasSettings) {
      qaSend.title = 'Add an API key in Settings first';
      qaInput.placeholder = 'Add an API key in Settings before asking…';
    } else if (!hasTranscript) {
      qaSend.title = 'Waiting for transcript to load';
      qaInput.placeholder = 'Waiting for the transcript — reload the page if this persists…';
    } else if (!hasText) {
      qaSend.title = 'Type a question first';
      qaInput.placeholder = 'Ask a question about the lecture…';
    } else {
      qaSend.title = 'Send (Enter)';
      qaInput.placeholder = 'Ask a question about the lecture…';
    }
  }
  // Auto-resize textarea
  qaInput.style.height = 'auto';
  qaInput.style.height = Math.min(qaInput.scrollHeight, 120) + 'px';
}

async function sendQaMessage() {
  const text = qaInput.value.trim();
  const sendChatIdx = activeQaChatIdx;
  if (!text || isChatStreaming(sendChatIdx) || !hasUsableSettings() || !transcript?.text) return;

  hideQaReplyReadyToast();
  activeQaStreamChatIdx = sendChatIdx;

  // Collect all images (data URLs) and clear state
  const allImages = attachedImages.map(img => img.dataUrl);
  attachedImages = [];
  renderImageStrip();

  setStatus('loading', 'Waiting for reply…');

  // Add user message to the correct chat
  const chatMessages = qaChats[sendChatIdx].messages;
  const userMsg = { role: 'user', content: text, images: allImages };
  chatMessages.push(userMsg);
  appendChatMsg('user', text, allImages, 'default', sendChatIdx);
  qaInput.value = '';
  qaInput.style.height = 'auto';

  // Smoothly scroll the chat to the bottom after the user's message is appended.
  // requestAnimationFrame ensures layout has settled (so scrollHeight is correct).
  const sendCol = getChatCol(sendChatIdx);
  if (sendCol) {
    requestAnimationFrame(() => {
      sendCol.scrollTo({ top: sendCol.scrollHeight, behavior: 'smooth' });
    });
  }

  // All providers support SSE streaming; use it for progressive rendering
  const useStream = !!settings.provider;

  // Build system prompt fresh on every message — full guide + current transcript window.
  // The API always receives the full chat history in `messages`, so the model has
  // complete context. The system prompt being rebuilt each turn keeps the
  // response-profile tags, current video timestamp, and transcript window current.
  const systemPrompt = await buildQAPrompt(text, { chatIdx: sendChatIdx });

  // Prepare streaming message element or typing indicator
  let typingEl = null;
  let streamEl = null;
  let streamBubble = null;
  if (useStream) {
    streamEl = document.createElement('div');
    streamEl.className = 'chat-msg assistant';
    streamEl.innerHTML = '<div class="chat-bubble"><div class="qa-katex-zone"></div><span class="qa-stream-cursor" aria-hidden="true"></span></div>';
    const targetCol = getChatCol(sendChatIdx);
    if (targetCol) {
      const welcome = targetCol.querySelector('.qa-welcome');
      if (welcome) welcome.remove();
      targetCol.appendChild(streamEl);
    }
    streamBubble = streamEl.querySelector('.chat-bubble');
  } else {
    typingEl = appendTypingIndicator(sendChatIdx);
  }

  let streamState = null;
  let req = null;

  try {
    const qaTemp = qaTempSlider ? qaTempSlider.value / 100 : 0.35;
    const qaThinking = qaThinkingSel?.value || 'none';

    req = apiRequest({
      type: 'CHAT',
      messages: stripLectureSummaryChatMessages(chatMessages).map(m => ({
        role: m.role, content: m.content, ...(m.images?.length ? { images: m.images } : {})
      })),
      systemPrompt,
      provider: settings.provider,
      model: settings.model || null,
      apiKey: settings.apiKey,
      localBase: getLocalBase(),
      chatTemperature: qaTemp,
      chatThinking: qaThinking,
      useStream
    });

    if (useStream) {
      streamState = {
        chatIdx: sendChatIdx,
        el: streamEl,
        bubble: streamBubble,
        buffer: '',
        dollarCount: 0,
        stableEnd: 0,
        katexEnd: 0,
        rafPending: false,
        katexThrottle: null,
        abortFn: req.abort
      };
      qaActiveStreams.set(req._requestId, streamState);
      onQaInputChange(); // update stop/send button for this chat
    }

    const response = await req;

    if (!response.success) throw new Error(response.error);

    // The chat may have been re-indexed (because some other chat was closed
    // during the stream). Use the live chatIdx from streamState if available.
    const liveChatIdx = streamState ? streamState.chatIdx : sendChatIdx;
    const assistantText = response.data;
    if (!qaChats[liveChatIdx]) {
      // Originating chat was closed mid-stream — nothing to do.
      window.CopilotDebug?.warn('[ETH-DBG] sendQaMessage: originating chat no longer exists', { liveChatIdx });
      return;
    }
    qaChats[liveChatIdx].messages.push({ role: 'assistant', content: assistantText });
    // Keep qaMessages in sync if this was the active chat
    if (liveChatIdx === activeQaChatIdx) qaMessages = qaChats[liveChatIdx].messages;

    if (useStream) {
      // Stream complete — stop accepting new chunks and cancel stale rAF flushes
      if (streamState) {
        if (streamState.katexThrottle) { clearTimeout(streamState.katexThrottle); streamState.katexThrottle = null; }
        QaStreamFlush.stopStreamFlush(streamState);
        qaActiveStreams.delete(req._requestId);
      }

      // Final render: crossfade from plain-text spans → full markdown + KaTeX.
      // Capture bubble in a local var because streamBubble is nulled right after.
      if (streamBubble) {
        const bubble = streamBubble;

        // Step 1: fade out the raw plain-text version
        bubble.style.transition = 'opacity 0.12s ease';
        bubble.style.opacity    = '0.2';

        setTimeout(() => {
          // Step 2: swap in the formatted content while invisible
          setRichTextHtml(bubble, assistantText);
          // Step 3: fade the formatted content back in
          bubble.style.opacity = '1';
          setTimeout(() => { bubble.style.transition = ''; }, 180);
        }, 120);
      }

      persistChat();

      // Notify: on QA tab → show reply toast; away → cross-tab notify
      if (streamEl) {
        const streamDiv = streamEl;
        if (_currentTab !== 'qa') {
          showCrossTabNotify(streamDiv);
        } else {
          showQaReplyReadyToast(streamDiv, assistantText);
        }
      }
      streamEl = null;
      streamBubble = null;

    } else {
      // Non-streaming path
      typingEl?.remove();
      appendChatMsg('assistant', assistantText, false, 'default', liveChatIdx);
      persistChat();
    }

  } catch (err) {
    // Clean up streaming state on error/abort
    if (streamState) {
      if (streamState.katexThrottle) { clearTimeout(streamState.katexThrottle); streamState.katexThrottle = null; }
      QaStreamFlush.stopStreamFlush(streamState);
      if (req?._requestId) qaActiveStreams.delete(req._requestId);
    }

    if (useStream && streamEl) {
      // If aborted and we have partial content, finalize it instead of removing
      if (err.message === 'Request aborted.' && streamState?.buffer) {
        const partialText = streamState.buffer;
        const liveChatIdx = streamState ? streamState.chatIdx : sendChatIdx;
        if (qaChats[liveChatIdx]) {
          qaChats[liveChatIdx].messages.push({ role: 'assistant', content: partialText });
          if (liveChatIdx === activeQaChatIdx) qaMessages = qaChats[liveChatIdx].messages;
        }
        // Finalize the partial bubble with markdown+katex
        if (streamBubble) {
          setRichTextHtml(streamBubble, partialText);
        }
        // Add a "(stopped)" indicator
        const stoppedNote = document.createElement('span');
        stoppedNote.className = 'qa-stream-stopped';
        stoppedNote.textContent = ' (generation stopped)';
        streamBubble?.appendChild(stoppedNote);
        persistChat();
      } else {
        streamEl.remove();
      }
      streamEl = null;
      streamBubble = null;
    } else {
      typingEl?.remove();
    }

    if (err.message !== 'Request aborted.') {
      const humanError = humanizeApiError(err.message);
      const errChatIdx = streamState ? streamState.chatIdx : sendChatIdx;
      if (qaChats[errChatIdx]) appendErrorMsg(humanError, errChatIdx);
    }
  } finally {
    onQaInputChange(); // clears stop button since stream is removed
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
function buildQaResponseProfilePrompt(userQuery) {
  const lengthKey = qaResponseLengthSel?.value || 'default';
  const styleKey = qaResponseStyleSel?.value || 'default';
  const userAskedEli5 = /\beli5\b/i.test(String(userQuery || ''));
  const tags = [];
  const lines = [
    'Apply response-profile instructions only when [QA_PROFILE_*] tags are present in THIS prompt.',
    'Do not carry over response-profile behavior from earlier turns if the current prompt has no such tags.'
  ];
  if (lengthKey !== 'default' && QA_LENGTH_PROFILE_PROMPTS[lengthKey]) {
    tags.push('[QA_PROFILE_LENGTH_ACTIVE]');
    lines.push(`Response depth profile: ${QA_LENGTH_PROFILE_PROMPTS[lengthKey]}`);
  }
  if (styleKey !== 'default' && QA_STYLE_PROFILE_PROMPTS[styleKey]) {
    if (styleKey === 'eli5' && userAskedEli5) {
      // User already asked for ELI5 explicitly in this message.
    } else {
      tags.push('[QA_PROFILE_STYLE_ACTIVE]');
      lines.push(`Explanation style profile: ${QA_STYLE_PROFILE_PROMPTS[styleKey]}`);
    }
  }
  if (!tags.length) {
    return '[QA_PROFILE_DEFAULT]\nUse balanced depth and adaptive style.\n' +
      lines.join('\n') + '\n\n';
  }
  return `${tags.join(' ')}\n${lines.join('\n')}\n\n`;
}

async function buildQAPrompt(userQuery, options = {}) {
  const chatIdx = options.chatIdx ?? activeQaChatIdx;
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

  // 2. Full guide — always included when available so the model has complete
  //    lecture context on every turn. The API receives the full message history
  //    separately, so rebuilding the system prompt each turn is intentional.
  let guideBlocksStr = '(guide not yet generated)';
  if (guide?.guide?.length) {
    guideBlocksStr = JSON.stringify(guide.guide, null, 2);
  }

  // 3. Compact lecture overview so the model can orient itself quickly
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

    // No branching here any more: retrieve() picks the method and falls back
    // to fuzzy on its own when the course has no embedding index.
    scriptContext = await ScriptManager.buildScriptContext(
      searchQuery, scriptRecord, strictness, method
    );
  }

  const hasScript = !!scriptContext;
  const qaExtraPrefix = customPromptExtras.qa ? customPromptExtras.qa.trim() + '\n\n' : '';
  const qaResponseProfile = buildQaResponseProfilePrompt(userQuery);

  let summaryBlock = '';
  const chat = qaChats[chatIdx];
  if (chat?.summaryInContext && lectureSummaryReady()) {
    summaryBlock = `
--- LECTURE SUMMARY (active for this chat — system prompt only, NOT in message history) ---
The student enabled the lecture summary for this chat. The summary text below is NOT in the conversation messages; this is the only place you receive it. Answer questions about it from this section. Treat it as authoritative alongside the guide and transcript.

${lectureSummaryText}

--- END LECTURE SUMMARY ---

`;
  }

  return `${qaExtraPrefix}${qaResponseProfile}${summaryBlock}You are a helpful study assistant for the ETH Zürich lecture: "${title}".
The student is currently at [${fmtSec(currentTime)}] in the video.

Answer based on the transcript excerpt and guide below${hasScript ? ', plus course script excerpts' : ''}. Reference timestamps [HH:MM:SS] when relevant. Use LaTeX ($...$ inline, $$...$$ display) whenever math appears. Markdown formatting (e.g., #/## headings, short bullet lists) is allowed when it improves readability, but do not force markdown when plain text is clearer. If the question is about a different part of the lecture, reference the lecture structure to guide the student.

If attached images contain user annotations (circles, highlights, underlines, arrows, or any drawn markings), pay special attention to those annotated regions and address them in extra detail — but do not reduce the depth of your answer for anything else.
${lectureOverview}
--- TRANSCRIPT (${fmtSec(windowStart)} to ${fmtSec(windowEnd)}) ---
${windowText}

--- FULL GUIDE ---
${guideBlocksStr}${scriptContext}`;
}

/** Auto-hide the reply-ready toast when user scrolls within this many px of the bottom. */
const QA_SCROLL_BOTTOM_THRESHOLD_PX = 80;
/** Show the "Jump to latest" pill only when user has scrolled this far from the bottom. */
const QA_SCROLL_BTN_THRESHOLD_PX = 3000;

function qaIsFollowingLatest(chatIdx) {
  const root = getChatCol(chatIdx ?? activeQaChatIdx);
  if (!root) return true;
  return root.scrollHeight - root.scrollTop - root.clientHeight <= QA_SCROLL_BOTTOM_THRESHOLD_PX;
}

function qaScrollToBottom(chatIdx) {
  const col = getChatCol(chatIdx ?? activeQaChatIdx);
  if (col) col.scrollTo({ top: col.scrollHeight, behavior: 'smooth' });
}

/**
 * Align the top of `el` with the top of the Q&A message list viewport.
 * Do not use scrollIntoView() here: it can scroll ancestor containers or the
 * host page and push the tab bar off-screen in the extension iframe.
 */
function qaScrollMessagesToShowElementTop(el, chatIdx) {
  const root = getChatCol(chatIdx ?? activeQaChatIdx);
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
  updateQaScrollBtn();
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
  const root = getActiveChatCol();
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
  if (_currentTab !== 'qa') {
    hideQaReplyReadyToast();
    return;
  }
  // Skip toast if the top of the new message is already visible in the scroll column
  if (targetDiv && targetDiv.isConnected) {
    const root = getActiveChatCol();
    if (root) {
      const rootRect = root.getBoundingClientRect();
      const msgRect  = targetDiv.getBoundingClientRect();
      if (msgRect.top >= rootRect.top && msgRect.top < rootRect.bottom) return;
    }
  }
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
  updateQaScrollBtn();
}

/** Build a chat message DOM element without appending it anywhere. Used by both appendChatMsg and _buildChatCol. */
function _buildChatMsgEl(role, content, images) {
  const renderedContent = role === 'assistant'
    ? normalizeLatexForKatex(unescapeMathDelimiters(content))
    : String(content ?? '');

  let imgList = [];
  if (Array.isArray(images)) {
    imgList = images.map(i => (typeof i === 'string' && i.startsWith('data:')) ? i : `data:image/jpeg;base64,${i}`);
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
  return div;
}

function appendChatMsg(role, content, images, scrollMode, chatIdx) {
  chatIdx = chatIdx ?? activeQaChatIdx;
  const col = getChatCol(chatIdx);
  if (!col) return null;
  scrollMode = scrollMode || 'default';

  const div = _buildChatMsgEl(role, content, images);
  // Remove welcome placeholder if present
  const welcome = col.querySelector('.qa-welcome');
  if (welcome) welcome.remove();
  col.appendChild(div);

  if (scrollMode === 'none') return div;

  if (role === 'assistant') {
    if (_currentTab !== 'qa') {
      showCrossTabNotify(div);
    } else if (scrollMode === 'default') {
      showQaReplyReadyToast(div, content);
    }
  }
  return div;
}

function appendErrorMsg(content, chatIdx) {
  chatIdx = chatIdx ?? activeQaChatIdx;
  const col = getChatCol(chatIdx);
  if (!col) return null;
  const div = document.createElement('div');
  div.className = 'chat-msg assistant chat-msg-error';
  div.innerHTML = `
      <div class="chat-bubble error-bubble">
        <strong>Request failed</strong>
        <p>${escHtml(content)}</p>
        <small>For guide generation, try Block count -> Custom tokens and lower the cap. For Q&amp;A, reduce Thinking or switch model/provider.</small>
      </div>
    `;
  col.appendChild(div);
  if (_currentTab !== 'qa') {
    showCrossTabNotify(div);
  } else {
    showQaReplyReadyToast(div, content);
  }
  return div;
}

function appendTypingIndicator(chatIdx) {
  chatIdx = chatIdx ?? activeQaChatIdx;
  const col = getChatCol(chatIdx);
  const div = document.createElement('div');
  div.className = 'chat-msg assistant';
  div.innerHTML = `<div class="typing-indicator">
      <div class="typing-dot"></div>
      <div class="typing-dot"></div>
      <div class="typing-dot"></div>
    </div>`;
  if (col) col.appendChild(div);
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
  let codeOpen = false;
  let codeLang = '';
  let codeBuf = [];

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
  const flushCode = () => {
    const langClass = codeLang ? ` language-${escAttr(codeLang)}` : '';
    out.push(`<pre class="md-code-block"><code class="md-code${langClass}">${escHtml(codeBuf.join('\n'))}</code></pre>`);
    codeOpen = false;
    codeLang = '';
    codeBuf = [];
  };
  const splitTableRow = (row) => {
    let s = String(row || '').trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|')) s = s.slice(0, -1);
    const cells = [];
    let cur = '';
    let escaped = false;
    for (const ch of s) {
      if (escaped) {
        cur += ch;
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
        cur += ch;
      } else if (ch === '|') {
        cells.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
    cells.push(cur.trim());
    return cells;
  };
  const isTableDivider = (row) => {
    const cells = splitTableRow(row);
    return cells.length > 1 && cells.every(c => /^:?-{3,}:?$/.test(c.trim()));
  };
  const tableAlignment = (cell) => {
    const c = String(cell || '').trim();
    if (c.startsWith(':') && c.endsWith(':')) return 'center';
    if (c.endsWith(':')) return 'right';
    return '';
  };
  const renderTable = (start) => {
    const headers = splitTableRow(lines[start]);
    const divider = splitTableRow(lines[start + 1]);
    const aligns = divider.map(tableAlignment);
    let i = start + 2;
    const rows = [];
    while (i < lines.length) {
      const row = lines[i].trim();
      if (!row || !row.includes('|')) break;
      rows.push(splitTableRow(lines[i]));
      i++;
    }
    const alignAttr = (idx) => aligns[idx] ? ` style="text-align:${aligns[idx]}"` : '';
    const headHtml = headers.map((cell, idx) => `<th${alignAttr(idx)}>${renderMarkdownInline(cell)}</th>`).join('');
    const bodyHtml = rows
      .map(row => `<tr>${headers.map((_, idx) => `<td${alignAttr(idx)}>${renderMarkdownInline(row[idx] || '')}</td>`).join('')}</tr>`)
      .join('');
    out.push(`<div class="md-table-wrap"><table class="md-table"><thead><tr>${headHtml}</tr></thead><tbody>${bodyHtml}</tbody></table></div>`);
    return i;
  };

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const rawLine = lines[lineIndex];
    const line    = rawLine.trimEnd();
    const trimmed = line.trim();

    const fence = trimmed.match(/^```([A-Za-z0-9_-]+)?\s*$/);
    if (codeOpen) {
      if (fence) {
        flushCode();
      } else {
        codeBuf.push(line);
      }
      continue;
    }
    if (fence) {
      flushPara(); flushList();
      codeOpen = true;
      codeLang = fence[1] || '';
      codeBuf = [];
      continue;
    }

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

    if (trimmed.includes('|') && lines[lineIndex + 1] && isTableDivider(lines[lineIndex + 1])) {
      flushPara(); flushList();
      lineIndex = renderTable(lineIndex) - 1;
      continue;
    }

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
  if (codeOpen) flushCode();
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

// renderMarkdownInline / wrapUndelimitedInlineMath live in lib/render-inline.js
