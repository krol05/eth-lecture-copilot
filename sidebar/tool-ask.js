/**
 * sidebar/tool-ask.js — Ask-about-this chat attached to a single guide item.
 *
 * Part of the sidebar, loaded as a plain script in the order listed in
 * sidebar.html. All sidebar modules share one global scope on purpose:
 * it is what lets each file be a straight move out of the old sidebar.js.
 */

// ─── Flashcards feature ───────────────────────────────────────────────────

// ─── Tool Ask Chat (ephemeral per-item Q&A) ────────────────────────────────

const toolAskPanel = document.getElementById('tool-ask-panel');
const toolAskMessagesEl = document.getElementById('tool-ask-messages');
const toolAskInput = document.getElementById('tool-ask-input');
const toolAskSendBtn = document.getElementById('tool-ask-send');
const toolAskTempSlider = document.getElementById('tool-ask-temp-slider');
const toolAskTempValue = document.getElementById('tool-ask-temp-value');
const toolAskThinkingSel = document.getElementById('tool-ask-thinking-select');
const toolAskLengthSel = document.getElementById('tool-ask-length-select');
const toolAskStyleSel = document.getElementById('tool-ask-style-select');

function toolAskSessionKey(sourceType, itemIndex) {
  return `${sourceType}:${itemIndex}`;
}

function clearToolAskSessions() {
  toolAskSessions = {};
  toolAskActiveSessionKey = null;
  toolAskActiveStreams.clear();
  closeToolAskPanel();
  chrome.storage?.local?.remove(['currentToolAskSessions']);
}

function restoreToolAskSessions(saved) {
  const cached = saved?.currentToolAskSessions;
  if (!cached?.sessions || !currentLectureUrl) {
    toolAskSessions = {};
    return;
  }
  if (normalizeLectureUrl(cached.lectureUrl) !== normalizeLectureUrl(currentLectureUrl)) {
    toolAskSessions = {};
    return;
  }
  toolAskSessions = cached.sessions;
}

function persistToolAskSessions() {
  if (!currentLectureUrl) return;
  storageSet({
    currentToolAskSessions: {
      lectureUrl: normalizeLectureUrl(currentLectureUrl),
      sessions: toolAskSessions
    }
  });
}

function getToolAskItemPayload(sourceType, itemIndex) {
  switch (sourceType) {
    case 'flashcard': {
      const c = flashcardData[itemIndex];
      return c ? { index: itemIndex, front: c.front, back: c.back } : null;
    }
    case 'quiz': {
      const q = quizState?.questions?.[itemIndex];
      return q ? { index: itemIndex, ...q } : null;
    }
    case 'exam': {
      const q = examQuestionData[itemIndex];
      return q ? { index: itemIndex, ...q } : null;
    }
    case 'cross_exam': {
      const q = crossExamQuestionData[itemIndex];
      return q ? { index: itemIndex, ...q } : null;
    }
    case 'cross_exam_topic': {
      const t = crossExamTopics[itemIndex];
      return t ? { index: itemIndex, ...t } : null;
    }
    default: return null;
  }
}

function getToolAskItemLabel(sourceType, itemIndex, payload) {
  switch (sourceType) {
    case 'flashcard': return `Flashcard ${itemIndex + 1}`;
    case 'quiz': return `Quiz question ${itemIndex + 1}`;
    case 'exam': return `Exam question ${itemIndex + 1}`;
    case 'cross_exam': return `Predicted question ${itemIndex + 1}`;
    case 'cross_exam_topic': return payload?.topic ? `Topic: ${payload.topic}` : `Exam topic ${itemIndex + 1}`;
    default: return 'Study item';
  }
}

function buildToolAskResponseProfilePrompt(userQuery) {
  const lengthKey = toolAskLengthSel?.value || 'default';
  const styleKey = toolAskStyleSel?.value || 'default';
  const lines = [];
  const tags = [];
  if (lengthKey !== 'default' && QA_LENGTH_PROFILE_PROMPTS[lengthKey]) {
    tags.push('[QA_PROFILE_LENGTH_ACTIVE]');
    lines.push(`Response depth profile: ${QA_LENGTH_PROFILE_PROMPTS[lengthKey]}`);
  }
  if (styleKey !== 'default' && QA_STYLE_PROFILE_PROMPTS[styleKey]) {
    tags.push('[QA_PROFILE_STYLE_ACTIVE]');
    lines.push(`Explanation style profile: ${QA_STYLE_PROFILE_PROMPTS[styleKey]}`);
  }
  if (!tags.length) {
    return '[QA_PROFILE_DEFAULT]\nUse balanced depth and adaptive style.\n' + lines.join('\n') + '\n\n';
  }
  return `${tags.join(' ')}\n${lines.join('\n')}\n\n`;
}

function buildToolAskSystemPrompt(userQuery, session) {
  const profile = buildToolAskResponseProfilePrompt(userQuery);
  const base = buildToolAskPrompt({
    sourceType: session.sourceType,
    itemPayload: session.itemPayload,
    lectureTitle: transcript?.lectureTitle || guide?.lecture_title || 'Lecture',
    guide
  });
  return profile + base;
}

function syncToolAskControlsFromMainQa() {
  if (toolAskTempSlider && qaTempSlider) {
    toolAskTempSlider.value = qaTempSlider.value;
    if (toolAskTempValue) toolAskTempValue.textContent = qaTempValue?.textContent || '0.35';
  }
  if (toolAskThinkingSel && qaThinkingSel) toolAskThinkingSel.value = qaThinkingSel.value;
  const qaLen = document.getElementById('qa-response-length-select');
  const qaStyle = document.getElementById('qa-response-style-select');
  if (toolAskLengthSel && qaLen) toolAskLengthSel.value = qaLen.value;
  if (toolAskStyleSel && qaStyle) toolAskStyleSel.value = qaStyle.value;
}

function openToolAskPanel(sourceType, itemIndex) {
  if (!hasUsableSettings()) {
    setStatus('warning', 'Add an API key in Settings first');
    return;
  }
  const payload = getToolAskItemPayload(sourceType, itemIndex);
  if (!payload) {
    setStatus('warning', 'Item not available');
    return;
  }
  const key = toolAskSessionKey(sourceType, itemIndex);
  if (!toolAskSessions[key]) {
    toolAskSessions[key] = {
      sourceType,
      itemIndex,
      itemPayload: payload,
      label: getToolAskItemLabel(sourceType, itemIndex, payload),
      messages: []
    };
  } else {
    toolAskSessions[key].itemPayload = payload;
    toolAskSessions[key].label = getToolAskItemLabel(sourceType, itemIndex, payload);
  }
  toolAskActiveSessionKey = key;
  syncToolAskControlsFromMainQa();
  renderToolAskPanel();
  toolAskPanel.hidden = false;
  document.body.classList.add('tool-ask-open');
  persistToolAskSessions();
  requestAnimationFrame(updateToolAskPanelHeight);
  toolAskInput?.focus();
}

function closeToolAskPanel() {
  for (const [reqId, state] of toolAskActiveStreams.entries()) {
    state.abortFn?.();
    toolAskActiveStreams.delete(reqId);
  }
  if (toolAskPanel) toolAskPanel.hidden = true;
  document.body.classList.remove('tool-ask-open');
  document.documentElement.style.removeProperty('--tool-ask-panel-h');
  toolAskActiveSessionKey = null;
}

function isToolAskStreaming() {
  for (const s of toolAskActiveStreams.values()) {
    if (s.sessionKey === toolAskActiveSessionKey) return true;
  }
  return false;
}

function renderToolAskPanel() {
  const session = toolAskActiveSessionKey ? toolAskSessions[toolAskActiveSessionKey] : null;
  const titleEl = document.getElementById('tool-ask-title');
  if (titleEl) titleEl.textContent = session ? `Ask about: ${session.label}` : 'Ask about this item';
  if (!toolAskMessagesEl) return;
  toolAskMessagesEl.innerHTML = '';
  if (!session?.messages?.length) {
    toolAskMessagesEl.innerHTML = '<p class="tool-ask-welcome">Ask anything about this item — clarifications, deeper explanation, or study tips.</p>';
  } else {
    for (const m of session.messages) {
      const div = _buildChatMsgEl(m.role, m.content, m.images);
      toolAskMessagesEl.appendChild(div);
    }
  }
  toolAskMessagesEl.scrollTop = toolAskMessagesEl.scrollHeight;
  updateToolAskSendBtn();
  requestAnimationFrame(updateToolAskPanelHeight);
}

function updateToolAskSendBtn() {
  if (!toolAskSendBtn || !toolAskInput) return;
  const hasText = toolAskInput.value.trim().length > 0;
  const streaming = isToolAskStreaming();
  if (streaming) {
    toolAskSendBtn.classList.add('qa-send-stop');
    toolAskSendBtn.title = 'Stop generation';
    toolAskSendBtn.disabled = false;
  } else {
    toolAskSendBtn.classList.remove('qa-send-stop');
    toolAskSendBtn.disabled = !hasText || !hasUsableSettings();
    toolAskSendBtn.title = hasText ? 'Send (Enter)' : 'Type a question first';
  }
}

function appendToolAskButton(parentEl, sourceType, itemIndex) {
  if (!parentEl) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'tool-ask-btn history-load-btn';
  btn.textContent = 'Ask about this';
  btn.title = 'Open a temporary chat about this item';
  btn.addEventListener('click', e => {
    e.stopPropagation();
    openToolAskPanel(sourceType, itemIndex);
  });
  parentEl.appendChild(btn);
}

function handleToolAskStreamChunk(msg) {
  const state = toolAskActiveStreams.get(msg.requestId);
  if (!state?.bubble || state.finalized) return;
  state.buffer += msg.text || '';
  QaStreamFlush.scheduleStreamFlush(state, flushQaStream);
}

async function sendToolAskMessage() {
  if (!toolAskActiveSessionKey || !toolAskInput) return;
  const session = toolAskSessions[toolAskActiveSessionKey];
  if (!session || isToolAskStreaming()) return;
  const text = toolAskInput.value.trim();
  if (!text || !hasUsableSettings()) return;

  session.messages.push({ role: 'user', content: text });
  toolAskInput.value = '';
  toolAskInput.style.height = 'auto';
  renderToolAskPanel();

  const useStream = !!settings.provider;
  let streamEl = null;
  let streamBubble = null;
  if (useStream) {
    streamEl = document.createElement('div');
    streamEl.className = 'chat-msg assistant';
    streamEl.innerHTML = '<div class="chat-bubble"><div class="qa-katex-zone"></div><span class="qa-stream-cursor" aria-hidden="true"></span></div>';
    toolAskMessagesEl?.appendChild(streamEl);
    streamBubble = streamEl.querySelector('.chat-bubble');
    toolAskMessagesEl.scrollTop = toolAskMessagesEl.scrollHeight;
  }

  const systemPrompt = buildToolAskSystemPrompt(text, session);
  let streamState = null;
  let req = null;
  const sessionKey = toolAskActiveSessionKey;

  try {
    const temp = toolAskTempSlider ? toolAskTempSlider.value / 100 : 0.35;
    const thinking = toolAskThinkingSel?.value || 'none';
    req = apiRequest({
      type: 'CHAT',
      messages: session.messages.map(m => ({ role: m.role, content: m.content })),
      systemPrompt,
      provider: settings.provider,
      model: settings.model || null,
      apiKey: settings.apiKey,
      localBase: getLocalBase(),
      chatTemperature: temp,
      chatThinking: thinking,
      useStream
    });
    if (useStream) {
      streamState = {
        sessionKey,
        bubble: streamBubble,
        buffer: '',
        stableEnd: 0,
        katexEnd: 0,
        rafPending: false,
        abortFn: req.abort
      };
      toolAskActiveStreams.set(req._requestId, streamState);
      updateToolAskSendBtn();
    }
    const response = await req;
    if (!response.success) throw new Error(response.error);
    const assistantText = useStream && streamState?.buffer?.trim()
      ? streamState.buffer
      : (response.data || '');
    if (toolAskSessions[sessionKey]) {
      toolAskSessions[sessionKey].messages.push({ role: 'assistant', content: assistantText });
    }
    if (useStream) {
      if (streamState) {
        QaStreamFlush.stopStreamFlush(streamState);
        toolAskActiveStreams.delete(req._requestId);
      }
      if (streamBubble) {
        setRichTextHtml(streamBubble, assistantText);
      }
    }
    persistToolAskSessions();
    renderToolAskPanel();
  } catch (err) {
    if (streamState) {
      QaStreamFlush.stopStreamFlush(streamState);
      toolAskActiveStreams.delete(req?._requestId);
    }
    if (err.message === 'Request aborted.' && streamState?.buffer?.trim()) {
      if (toolAskSessions[sessionKey]) {
        toolAskSessions[sessionKey].messages.push({ role: 'assistant', content: streamState.buffer });
      }
      persistToolAskSessions();
      renderToolAskPanel();
    } else if (err.message !== 'Request aborted.') {
      const errDiv = document.createElement('div');
      errDiv.className = 'chat-msg assistant chat-msg-error';
      errDiv.innerHTML = `<div class="chat-bubble error-bubble">${escHtml(humanizeApiError(err.message))}</div>`;
      toolAskMessagesEl?.appendChild(errDiv);
    }
  } finally {
    updateToolAskSendBtn();
  }
}

function stopToolAskStream() {
  for (const [reqId, state] of toolAskActiveStreams.entries()) {
    if (state.sessionKey === toolAskActiveSessionKey) {
      state.abortFn?.();
      toolAskActiveStreams.delete(reqId);
    }
  }
  updateToolAskSendBtn();
}

function updateToolAskPanelHeight() {
  if (!toolAskPanel || toolAskPanel.hidden) {
    document.documentElement.style.removeProperty('--tool-ask-panel-h');
    return;
  }
  const h = toolAskPanel.getBoundingClientRect().height;
  if (h > 0) {
    document.documentElement.style.setProperty('--tool-ask-panel-h', `${Math.ceil(h)}px`);
  }
}

function initToolAskPanel() {
  document.getElementById('tool-ask-close')?.addEventListener('click', closeToolAskPanel);
  toolAskSendBtn?.addEventListener('click', () => {
    if (isToolAskStreaming()) stopToolAskStream();
    else sendToolAskMessage();
  });
  toolAskInput?.addEventListener('input', () => {
    updateToolAskSendBtn();
    toolAskInput.style.height = 'auto';
    toolAskInput.style.height = Math.min(toolAskInput.scrollHeight, 120) + 'px';
  });
  toolAskInput?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (isToolAskStreaming()) stopToolAskStream();
      else sendToolAskMessage();
    }
  });
  toolAskTempSlider?.addEventListener('input', () => {
    if (toolAskTempValue) toolAskTempValue.textContent = (toolAskTempSlider.value / 100).toFixed(2);
  });
  document.getElementById('tool-ask-customization')?.addEventListener('toggle', updateToolAskPanelHeight);
  if (window.ResizeObserver && toolAskPanel) {
    const ro = new ResizeObserver(updateToolAskPanelHeight);
    ro.observe(toolAskPanel);
  }
}
