/**
 * sidebar/api.js — Messaging with content.js and the background worker: requests, aborts, progress.
 *
 * Part of the sidebar, loaded as a plain script in the order listed in
 * sidebar.html. All sidebar modules share one global scope on purpose:
 * it is what lets each file be a straight move out of the old sidebar.js.
 */

// ─── Message Handling ─────────────────────────────────────────────────────

function onContentMessage(e) {
  // Only accept messages from video.ethz.ch — reject any other origin.
  if (e.origin !== 'https://video.ethz.ch') return;
  const msg = e.data;
  if (!msg?.type) return;
  if (msg.type !== 'TIMESTAMP_UPDATE') {
    window.CopilotDebug?.log('sidebar.onContentMessage', {
      type: msg.type,
      requestId: msg.requestId,
      message: msg
    });
  }

  switch (msg.type) {

    case 'EXTENSION_READY':
      setStatus('loading', 'Detecting transcript…');
      if (msg.lectureUrl) {
        tryRestoreFromCache(msg.lectureUrl);
      }
      // Do NOT restore from saved currentLectureUrl here — on SPA navigation that
      // reloads the previous lecture's guide on the new video page.
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

    case 'TRANSCRIPT_READY': {
      const normIncoming = msg.lectureUrl ? normalizeLectureUrl(msg.lectureUrl) : '';
      const normBefore = currentLectureUrl ? normalizeLectureUrl(currentLectureUrl) : '';
      const guideIsForOtherLecture = guide?.guide?.length && normBefore && normIncoming && normBefore !== normIncoming;
      handleTranscriptReady(msg);
      if (msg.lectureUrl && (!guide?.guide?.length || guideIsForOtherLecture)) {
        tryRestoreFromCache(msg.lectureUrl);
      }
      break;
    }

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

    case 'FRAME_ATTACHED':
      // Arrived via the keyboard shortcut rather than the button.
      if (msg.imageBase64) {
        attachedImages.push({ dataUrl: `data:image/jpeg;base64,${msg.imageBase64}`, label: 'Frame' });
        renderImageStrip();
        setStatus('ready', 'Frame attached');
      } else {
        setStatus('error', `Frame capture failed: ${msg.error || 'unknown reason'}`);
      }
      break;

    case 'FRAME_CAPTURED':
      if (pendingRequests[msg.requestId]) {
        pendingRequests[msg.requestId]({
          b64: msg.imageBase64,
          error: msg.error || null,
          needsScreenshot: !!msg.needsScreenshot
        });
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
  window.CopilotDebug?.log('sidebar.postToContent', {
    type: msg?.type,
    requestId: msg?.requestId,
    message: msg
  });
  // Target only video.ethz.ch — prevents message leakage to other origins.
  window.parent.postMessage(msg, 'https://video.ethz.ch');
}

function goToLecture(lectureUrl) {
  if (!lectureUrl) return;
  postToContent({ type: 'NAVIGATE_TO_LECTURE', url: lectureUrl });
}

/**
 * Report a failure that happened inside the sidebar (not an API call) with
 * the same detail as a provider error. Local failures used to vanish
 * silently, leaving the user staring at a button that appeared to do nothing.
 */
function reportSidebarError(err, { operation = 'Sidebar' } = {}) {
  const detail = {
    status: null,
    provider: settings?.provider || null,
    model: settings?.model || null,
    code: 'sidebar_error',
    message: `${operation} failed: ${err?.message || String(err)}`,
    raw: err?.stack || null,
    timestamp: Date.now()
  };
  window.CopilotDebug?.error('sidebar.localError', detail);
  try { ErrorPanel.report(detail); } catch { /* panel is non-critical */ }
  setStatus('error', detail.message);
}


// ─── Live counts while a study tool generates ─────────────────────────────
//
// The background already streams these responses — it has since the tools got
// the same patience as the guide — but the sidebar dropped every chunk on the
// floor and showed a bare spinner. On a reasoning model that is several
// minutes with no sign of life, which is indistinguishable from a hang.
//
// Nothing here parses the result: the non-streamed text is still the
// authority, and the scanner is only counting finished objects so the button
// can say how far along it is.

const toolProgressStreams = new Map(); // requestId → { scanner, button, noun, baseLabel }

/** What each tool's results arrive under, and what to call one of them. */
const TOOL_STREAM_SHAPES = {
  FLASHCARDS_REQUEST: { arrayKey: 'flashcards', noun: 'card' },
  QUIZ_REQUEST: { arrayKey: 'questions', noun: 'question' },
  EXAM_QUESTIONS_REQUEST: { arrayKey: 'questions', noun: 'question' },
  CROSS_LECTURE_EXAM_REQUEST: { arrayKey: 'questions', noun: 'question' }
};

function trackToolProgress(requestId, type, button) {
  const shape = TOOL_STREAM_SHAPES[type];
  if (!shape || !button) return;
  const label = button.querySelector('.btn-text');
  toolProgressStreams.set(requestId, {
    scanner: createJsonArrayScanner(shape.arrayKey),
    label,
    noun: shape.noun,
    baseText: label?.textContent || 'Generating…'
  });
}

/** Put the button's own wording back; the count was only for the wait. */
function untrackToolProgress(requestId) {
  const state = toolProgressStreams.get(requestId);
  if (state?.label) state.label.textContent = state.baseText;
  toolProgressStreams.delete(requestId);
}

function handleToolProgressChunk(msg, state) {
  state.scanner.push(msg.text || '');
  if (!state.label) return;
  const n = state.scanner.count;
  state.label.textContent = n
    ? `Generating… ${n} ${state.noun}${n === 1 ? '' : 's'}`
    : state.baseText;
}

// ── Central registry of in-flight generations ─────────────────────────────
// Every provider request registers here, so anything the user starts can be
// stopped from the generation bar — including generators with no Stop button
// of their own.
const activeGenerations = new Map(); // requestId → { label, abort }

const GENERATION_LABELS = {
  GENERATE_GUIDE: 'Study guide',
  FLASHCARDS_REQUEST: 'Flashcards',
  QUIZ_REQUEST: 'Practice quiz',
  EXAM_QUESTIONS_REQUEST: 'Exam questions',
  CROSS_LECTURE_EXAM_REQUEST: 'Cross-lecture exam',
  CHAT: 'Answer'
};

function generationLabel(payload) {
  return payload?._label || GENERATION_LABELS[payload?.type] || 'Request';
}

function refreshGenerationBar() {
  const items = [...activeGenerations.entries()].map(([id, g]) => ({ id, label: g.label }));
  try {
    GenerationBar.render(items, stopGeneration);
  } catch { /* bar is non-critical */ }
}

function trackGeneration(id, label, abort) {
  activeGenerations.set(id, { label, abort });
  refreshGenerationBar();
}

function untrackGeneration(id) {
  if (activeGenerations.delete(id)) refreshGenerationBar();
}

function stopGeneration(id) {
  const g = activeGenerations.get(id);
  if (!g) return;
  window.CopilotDebug?.warn('sidebar.generation.stop', { requestId: id, label: g.label });
  try { g.abort(); } catch { /* already settled */ }
  untrackGeneration(id);
}

// Generations that produce a whole study artifact rather than a chat reply.
const LONG_RUNNING_REQUEST_TYPES = new Set([
  'FLASHCARDS_REQUEST',
  'QUIZ_REQUEST',
  'EXAM_QUESTIONS_REQUEST',
  'CROSS_LECTURE_EXAM_REQUEST'
]);

/**
 * A guide has no deadline, only a limit on how long it may go silent. A model
 * that streams for twenty minutes is fine; one that says nothing for three is
 * stuck. Any chunk or progress update resets both clocks.
 */
const GUIDE_SILENCE_WARN_MS = 180000;      // offer retry / keep going
const GUIDE_SILENCE_GIVE_UP_MS = 900000;   // settle the promise, never hang
const GUIDE_SILENCE_CHECK_MS = 5000;

/** Set while a guide request is in flight, so stream handlers can say "still alive". */
let guideActivityWatcher = null;

/** Called whenever anything arrives for the guide request that is running. */
function noteGuideActivity(requestId) {
  if (guideActivityWatcher && guideActivityWatcher.id === requestId) {
    guideActivityWatcher.bump();
  }
}

function makeRequestId() {
  return 'req_' + (++requestIdCounter);
}

// Bug A fix: tell the background to abort the actual fetch — until now
// "Stop" only rejected the local promise while the request ran to completion.
function sendAbortToBackground(targetRequestId) {
  postToContent({
    type: 'API_REQUEST',
    requestId: makeRequestId(),
    payload: { type: 'ABORT_REQUEST', requestId: targetRequestId }
  });
}

/**
 * Recover from "we were never granted this site".
 *
 * The extension asks for one host at a time instead of every site up front,
 * so the first request to any new provider, local server or media host will
 * be refused once. That must never be where things stop: ask, then repeat
 * the request so the user's click does what they expected.
 *
 * If the prompt cannot be shown (Chrome's activation window has passed), the
 * error panel takes over with an Allow button that retries the same way.
 * Either path ends with the user answering once and the work continuing.
 *
 * @returns the retried response, or null if access was not obtained
 */
async function recoverFromMissingHost(detail, payload) {
  const origin = detail?.raw?.origin;
  if (!origin || typeof self === 'undefined' || !self.requestPermission) return null;

  const { granted } = await self.requestPermission(origin);
  if (granted) return apiRequest({ ...payload, __permissionRetry: true });

  // Could not ask, or was refused — hand it to the panel, which can prompt
  // from its own button and will re-run this request if that succeeds.
  try {
    ErrorPanel.report(detail, {
      onGranted: () => apiRequest({ ...payload, __permissionRetry: true })
    });
  } catch { /* panel is non-critical */ }
  return null;
}

function apiRequest(payload) {
  const id = makeRequestId();
  window.CopilotDebug?.log('sidebar.apiRequest.create', {
    requestId: id,
    payloadType: payload?.type,
    provider: payload?.provider,
    model: payload?.model,
    systemPrompt: payload?.systemPrompt,
    payload
  });
  let _rejectFn = null;
  const promise = new Promise((resolve, reject) => {
    _rejectFn = reject;
    const isGuideRequest = payload?.type === 'GENERATE_GUIDE';
    // Study-tool generations are as heavy as a guide on reasoning models —
    // they need the same patience, not the 2-minute chat deadline.
    const isLongRequest = LONG_RUNNING_REQUEST_TYPES.has(payload?.type);
    let settled = false;
    let timeoutTimer = null;
    let guideWatchTimer = null;
    let closeTimeoutDialog = null;

    const cleanup = () => {
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (guideWatchTimer) clearInterval(guideWatchTimer);
      if (closeTimeoutDialog) { closeTimeoutDialog(); closeTimeoutDialog = null; }
      if (guideActivityWatcher?.id === id) guideActivityWatcher = null;
      untrackGeneration(id);
    };

    if (isGuideRequest) {
      activeGuideRequestId = id;
      // Inform the user this is now server/provider-side work and can take a while.
      setStatus('loading', 'Generating guide… Request sent from extension backend.');

      // The clock measures silence, not total time: a guide that is still
      // streaming is working, however long it takes. Only a gap with nothing
      // arriving means something is actually stuck.
      let lastHeardFrom = Date.now();
      guideActivityWatcher = { id, bump: () => { lastHeardFrom = Date.now(); } };

      guideWatchTimer = setInterval(() => {
        if (settled) return;
        const silentFor = Date.now() - lastHeardFrom;

        if (silentFor >= GUIDE_SILENCE_GIVE_UP_MS) {
          // Nothing has arrived for long enough that no reply is coming. The
          // old code had no deadline here at all, so the promise never settled
          // and the Generate button stayed disabled until a reload.
          delete pendingRequests[id];
          if (activeGuideRequestId === id) activeGuideRequestId = null;
          cleanup();
          sendAbortToBackground(id);
          reject(new Error(
            `No response for ${Math.round(silentFor / 60000)} minutes from ` +
            `${payload.provider || 'the provider'}` +
            `${payload.model ? ` (${payload.model})` : ''}. ` +
            `${guideScanner?.blocks.length || 0} blocks and ` +
            `${Math.round((guideScanner?.length || 0) / 1024)} KB arrived before it went quiet. ` +
            `The request has been cancelled — try again, or switch model or provider.`
          ));
          return;
        }

        if (silentFor >= GUIDE_SILENCE_WARN_MS && !closeTimeoutDialog) {
          closeTimeoutDialog = showGuideTimeoutDialog({
            silentSeconds: Math.round(silentFor / 1000),
            onRetry: () => {
              if (settled) return;
              delete pendingRequests[id];
              if (activeGuideRequestId === id) activeGuideRequestId = null;
              cleanup();
              sendAbortToBackground(id); // don't leave the old fetch running
              reject(new Error('Retry requested by user.'));
            },
            onKeepGoing: () => {
              if (settled) return;
              // Restart the clock. If it goes quiet for another stretch the
              // dialog comes back, so "keep going" can no longer mean
              // "wait forever with no way out".
              closeTimeoutDialog = null;
              lastHeardFrom = Date.now();
              setStatus('loading', 'Guide generation still running on provider…');
            }
          });
        }
      }, GUIDE_SILENCE_CHECK_MS);
    } else {
      timeoutTimer = setTimeout(() => {
        if (settled) return;
        delete pendingRequests[id];
        if (activeGuideRequestId === id) activeGuideRequestId = null;
        cleanup();
        sendAbortToBackground(id);
        reject(new Error('Request timed out. Please try again or switch model/provider.'));
      }, isLongRequest ? 330000 : 120000);
    }

    pendingRequests[id] = resolve;
    const originalResolve = pendingRequests[id];
    pendingRequests[id] = (data) => {
      window.CopilotDebug?.log('sidebar.apiRequest.resolve', {
        requestId: id,
        payloadType: payload?.type,
        response: data
      });
      cleanup();
      if (isGuideRequest && activeGuideRequestId === id) activeGuideRequestId = null;

      // Missing host access is never a dead end: ask for the one site, then
      // run the same request again. The permission check costs no network
      // call, so we are still inside the click's activation window and the
      // prompt appears without the user having to start over.
      if (data?.success === false
          && data.errorDetail?.code === 'permission_missing'
          && !payload.__permissionRetry) {
        recoverFromMissingHost(data.errorDetail, payload)
          .then(retried => originalResolve(retried || data))
          .catch(() => originalResolve(data));
        return;
      }

      // Central error-panel wiring: every failed AI request pops the full
      // structured error (user-initiated aborts excluded — not errors).
      if (data && data.success === false && data.errorDetail && data.errorDetail.code !== 'aborted') {
        try { ErrorPanel.report(data.errorDetail); } catch { /* panel is non-critical */ }
      }
      originalResolve(data);
    };
    postToContent({ type: 'API_REQUEST', requestId: id, payload });
  });
  // Expose the requestId on the promise so callers that need streaming context can read it
  promise._requestId = id;
  promise.abort = () => {
    window.CopilotDebug?.warn('sidebar.apiRequest.abort', { requestId: id, payloadType: payload?.type });
    sendAbortToBackground(id);
    untrackGeneration(id);
    if (_rejectFn) {
      delete pendingRequests[id];
      if (activeGuideRequestId === id) activeGuideRequestId = null;
      const fn = _rejectFn;
      _rejectFn = null;
      fn(new Error('Request aborted.'));
    }
  };
  // Registered last so the bar's Stop button has a working abort to call.
  trackGeneration(id, generationLabel(payload), promise.abort);
  return promise;
}

function handleApiProgress(msg) {
  if (!isGenerating) return;
  if (!msg?.requestId || msg.requestId !== activeGuideRequestId) return;
  noteGuideActivity(msg.requestId);
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

function handleStreamChunk(msg) {
  const reqId = msg?.requestId;
  if (!reqId) return;
  window.CopilotDebug?.log('sidebar.stream.chunk.received', {
    requestId: reqId,
    text: msg.text,
    length: typeof msg.text === 'string' ? msg.text.length : null
  });

  // Study-tool generations: count finished items so the button can show them.
  const toolProgress = toolProgressStreams.get(reqId);
  if (toolProgress) {
    handleToolProgressChunk(msg, toolProgress);
    return;
  }

  // Route tool-ask streams (isolated from main Q&A)
  if (toolAskActiveStreams.has(reqId)) {
    handleToolAskStreamChunk(msg);
    return;
  }

  // Route to QA or lecture-summary streams (multiple can be active simultaneously)
  if (qaActiveStreams.has(reqId)) {
    const streamState = qaActiveStreams.get(reqId);
    if (streamState?.kind === 'lecture-summary') {
      handleLectureSummaryStreamChunk(msg, streamState);
    } else {
      handleQaStreamChunk(msg);
    }
    return;
  }

  if (!isGenerating) return;
  if (reqId !== activeGuideRequestId) return;
  noteGuideActivity(reqId);
  if (!guideScanner) guideScanner = createGuideBlockScanner();

  const prevCount = guideScanner.blocks.length;
  guideScanner.push(msg.text || '');
  const blocks = guideScanner.blocks;
  const blockCount = blocks.length;

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
  const kbReceived = Math.round(guideScanner.length / 1024);
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
  guideScanner = null;
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
