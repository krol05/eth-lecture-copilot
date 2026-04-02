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
  const regenerateBtn = document.getElementById('regenerate-btn');

  // ─── Init ─────────────────────────────────────────────────────────────────

  function init() {
    postToContent({ type: 'GET_SETTINGS' });

    // Tab switching
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    themeToggle.addEventListener('click', toggleTheme);
    applyStoredTheme();

    generateBtn.addEventListener('click', onGenerateClick);
    regenerateBtn.addEventListener('click', onRegenerateClick);

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

    window.addEventListener('message', onContentMessage);

    setStatus('loading', 'Waiting for video page…');
  }

  function tryRestoreFromCache(lectureUrl) {
    if (!lectureUrl) return;
    currentLectureUrl = lectureUrl;
    chrome.storage?.local?.get(['currentGuide', 'currentTranscript', 'currentLectureUrl', 'currentQaMessages'], saved => {
      if (saved.currentLectureUrl !== lectureUrl) {
        chrome.storage?.local?.remove(['currentGuide', 'currentTranscript', 'currentLectureUrl', 'currentQaMessages']);
        resetGuideUI();
        setStatus('loading', 'New lecture detected — waiting for transcript…');
        return;
      }
      if (saved.currentGuide?.guide?.length) {
        guide = saved.currentGuide;
        setStatus('ready', `Guide ready · ${guide.guide.length} blocks`);
        showGuideContent();
      }
      if (saved.currentTranscript) {
        transcript = saved.currentTranscript;
        updateGenerateButton();
      }
      if (Array.isArray(saved.currentQaMessages) && saved.currentQaMessages.length) {
        qaMessages = saved.currentQaMessages;
        restoreChatUI();
      }
    });
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
    setStatus('ready', `Transcript loaded · ${msg.cues.length} cues`);
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

    const systemPrompt = buildGuidePrompt();
    const payload = {
      type: 'GENERATE_GUIDE',
      transcriptText: transcript.text,
      systemPrompt,
      provider: settings.provider,
      model: settings.model || null,
      apiKey: settings.apiKey,
      localBase: getLocalBase()
    };

    console.log('[Copilot] Sending GENERATE_GUIDE', {
      provider: payload.provider,
      model: payload.model,
      transcriptLen: payload.transcriptText?.length,
      hasApiKey: !!payload.apiKey,
      localBase: payload.localBase || '(none)'
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

  function buildGuidePrompt() {
    return `You are an expert academic assistant that converts lecture transcripts into structured study guides.

Your task: Read the provided lecture transcript and produce a JSON lecture guide. The guide divides the lecture into logical topic blocks (not fixed time intervals). Each block covers one coherent topic or subtopic.

OUTPUT FORMAT — return ONLY valid JSON, no markdown fences, no explanation, no preamble:

{"lecture_title":"string","total_duration_seconds":number,"guide":[{"start_time":number,"end_time":number,"title":"string","key_concepts":["string"],"formulas":[{"label":"string","latex":"string"}],"definitions":[{"term":"string","definition":"string"}],"notes":"string"}]}

RULES:
- Blocks follow the logical flow of the lecture. One coherent topic = one block.
- formulas: include EVERY formula/theorem/equation. LaTeX must be valid KaTeX. Omit delimiters in the latex field.
- key_concepts: 2-6 complete sentences/phrases per block.
- definitions: only formally defined terms.
- notes: professor warnings, exam hints, cross-references to other blocks, common mistakes.
- Do NOT hallucinate. Only extract content actually in the transcript.
- total_duration_seconds: use the last timestamp in the transcript.

EXAMPLE:
Input: "[00:00:00] BFS visits nodes level by level using a queue. [00:01:00] Time complexity is O(V+E). [00:02:00] DFS uses a stack. [00:03:00] Also O(V+E)."
Output: {"lecture_title":"Graph Traversal","total_duration_seconds":180,"guide":[{"start_time":0,"end_time":90,"title":"Breadth-First Search","key_concepts":["BFS explores level by level","Uses a queue data structure"],"formulas":[{"label":"BFS Complexity","latex":"O(V+E)"}],"definitions":[{"term":"BFS","definition":"Graph traversal visiting all neighbours before going deeper"}],"notes":""},{"start_time":90,"end_time":180,"title":"Depth-First Search","key_concepts":["DFS explores deep before backtracking","Implemented with stack or recursion"],"formulas":[{"label":"DFS Complexity","latex":"O(V+E)"}],"definitions":[{"term":"DFS","definition":"Graph traversal going deep along each path first"}],"notes":"Both BFS and DFS share the same O(V+E) complexity."}]}

Now process the following transcript:`;
  }

  function toSeconds(v) {
    if (typeof v === 'number' && isFinite(v)) return v;
    if (typeof v === 'string') {
      const hms = v.match(/^(\d+):(\d+):(\d+)$/);
      if (hms) return +hms[1] * 3600 + +hms[2] * 60 + +hms[3];
      const ms = v.match(/^(\d+):(\d+)$/);
      if (ms) return +ms[1] * 60 + +ms[2];
      const n = parseFloat(v);
      if (isFinite(n)) return n;
    }
    return 0;
  }

  function sanitizeGuide(g) {
    if (!Array.isArray(g.guide)) return g;
    g.guide = g.guide.map(b => ({
      start_time: toSeconds(b.start_time),
      end_time: toSeconds(b.end_time),
      title: b.title ?? 'Untitled Section',
      key_concepts: Array.isArray(b.key_concepts) ? b.key_concepts : [],
      formulas: Array.isArray(b.formulas) ? b.formulas : [],
      definitions: Array.isArray(b.definitions) ? b.definitions : [],
      notes: typeof b.notes === 'string' ? b.notes : ''
    }));
    return g;
  }

  // ─── Guide Display ────────────────────────────────────────────────────────

  function showGuideContent() {
    guideEmpty.style.display = 'none';
    guideContent.style.display = 'flex';
    renderBlock(0);
  }

  function handleTimestamp(currentTime) {
    if (!guide?.guide) return;
    const idx = findBlockIndex(currentTime);
    if (idx !== currentBlockIndex) {
      currentBlockIndex = idx;
      renderBlock(idx);
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

    // Update counter + progress
    blockCounter.textContent = `${idx + 1} / ${blocks.length}`;
    progressFill.style.width = `${((idx + 1) / blocks.length) * 100}%`;

    // Build block HTML
    let html = `
      <div>
        <div class="block-title">${escHtml(block.title)}</div>
        <div class="block-timestamp">${fmtSec(block.start_time)} – ${fmtSec(block.end_time)}</div>
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
  }

  // ─── Q&A Chat ─────────────────────────────────────────────────────────────

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

    // Add user message to UI
    const userMsg = { role: 'user', content: text, imageBase64 };
    qaMessages.push(userMsg);
    appendChatMsg('user', text, !!imageBase64);
    qaInput.value = '';
    qaInput.style.height = 'auto';

    // Show typing indicator
    const typingEl = appendTypingIndicator();

    // Build system prompt with context
    const systemPrompt = buildQAPrompt();

    try {
      const response = await apiRequest({
        type: 'CHAT',
        messages: qaMessages.map(m => ({ role: m.role, content: m.content, ...(m.imageBase64 ? { imageBase64: m.imageBase64 } : {}) })),
        systemPrompt,
        provider: settings.provider,
        model: settings.model || null,
        apiKey: settings.apiKey,
        localBase: getLocalBase()
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
    }
  }

  function buildQAPrompt() {
    const title = transcript?.lectureTitle || 'Lecture';
    const guideStr = guide ? JSON.stringify(guide, null, 2) : '(guide not yet generated)';
    return `You are a helpful study assistant for the ETH Zürich lecture: "${title}".

Answer questions based ONLY on the lecture content below. Reference specific timestamps [HH:MM:SS] when relevant. Keep answers concise and student-friendly. Use LaTeX for math (wrap in $...$ inline or $$...$$ for display). If something is not covered in the lecture, say so clearly.

--- TRANSCRIPT ---
${transcript?.text || '(no transcript)'}

--- GUIDE ---
${guideStr}`;
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
      const history = Array.isArray(saved.guideHistory) ? saved.guideHistory : [];
      const idx = history.findIndex(h => h.lectureUrl === currentLectureUrl);
      const entry = {
        lectureUrl: currentLectureUrl,
        lectureTitle: transcript?.lectureTitle || guide?.lecture_title || 'Lecture',
        date: new Date().toISOString(),
        guide,
        qaMessages: qaMessages.length ? qaMessages : (idx >= 0 ? history[idx].qaMessages : [])
      };
      if (idx >= 0) {
        history[idx] = entry;
      } else {
        history.unshift(entry);
      }
      // Keep last 50 entries
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
            ${!isActive ? '<button class="history-delete-btn" title="Delete">Delete</button>' : ''}
          </div>
        `;
        div.querySelector('.history-load-btn').addEventListener('click', () => loadHistoryEntry(entry));
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
  }

  function applyStoredTheme() {
    const saved = localStorage.getItem('eth-copilot-theme');
    if (saved) document.documentElement.dataset.theme = saved;
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

  // ─── Bootstrap ───────────────────────────────────────────────────────────
  init();

})();
