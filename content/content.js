/**
 * content.js — Main content script for video.ethz.ch
 *
 * Responsibilities:
 * 1. Detect ETH lecture video pages
 * 2. Extract transcript via background fetch
 * 3. Inject sidebar iframe
 * 4. Resize video container to make room for sidebar
 * 5. Poll video timestamp and send updates to sidebar
 * 6. Keyboard: Arrow Up/Down on the video page change playback speed by 0.25× (0.25–4.0)
 * 7. Show speed overlay on speed change
 *
 * Note: Never set video.crossOrigin — that permanently breaks Paella/HLS streams.
 * Frame capture uses direct canvas (if same-origin) or tab screenshot+crop as fallback.
 */

(function () {
  'use strict';

  // ─── State ──────────────────────────────────────────────────────────────────
  let sidebarIframe = null;
  let sidebarToggle = null;
  let sidebarResizeHandle = null;
  let sidebarVisible = false;
  let sidebarCollapsed = false;
  let sidebarWidthPx = 380;
  let videoEl = null;
  let fsVideoTarget = null;
  let timestampInterval = null;
  let lastBlockIndex = -1;
  let speedOverlayTimeout = null;
  /** Bumped on SPA navigation so in-flight FETCH_JSON/VTT callbacks cannot complete with a stale generation. */
  let extractionGen = 0;
  let lastKnownHref = '';
  let lectureNavDebounce = null;
  let focusMode = false;
  let focusVideoContainer = null;

  const SIDEBAR_WIDTH = '380px';
  const SIDEBAR_MIN_WIDTH = 280;
  const SIDEBAR_MAX_WIDTH = 560;

  // ─── Entry Point ─────────────────────────────────────────────────────────────

  function init() {
    // Only activate on pages that have a video player
    if (!isLecturePage()) return;

    // Wait for the video element to appear (Paella loads dynamically)
    lastKnownHref = location.href;
    waitForVideo().then(video => {
      videoEl = video;
      injectSidebar();
      startTimestampSync();
      initKeyboardShortcuts();
      return waitForTranscriptDomReady();
    }).then(() => {
      initiateTranscriptExtraction();
    });

    installLectureNavigationWatch();

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
    window.addEventListener('resize', () => updateSidebarWidths());

    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg?.type) return;
      if (msg.type === 'SETTINGS_UPDATED') {
        chrome.storage.local.get(['provider', 'model', 'apiKey', 'localBases'], settings => {
          postToSidebar({ type: 'SETTINGS', settings });
        });
      }
    });
  }

  function isLecturePage() {
    return location.hostname === 'video.ethz.ch';
  }

  function installLectureNavigationWatch() {
    lastKnownHref = location.href;

    const onHrefMaybeChanged = () => {
      if (location.href === lastKnownHref) return;
      lastKnownHref = location.href;
      scheduleLectureSoftReload();
    };

    window.addEventListener('popstate', onHrefMaybeChanged);
    const _pushState = history.pushState;
    const _replaceState = history.replaceState;
    history.pushState = function () {
      const r = _pushState.apply(this, arguments);
      queueMicrotask(onHrefMaybeChanged);
      return r;
    };
    history.replaceState = function () {
      const r = _replaceState.apply(this, arguments);
      queueMicrotask(onHrefMaybeChanged);
      return r;
    };

    // Some SPAs update the URL without hooking history; poll as fallback.
    setInterval(() => {
      if (location.href !== lastKnownHref) onHrefMaybeChanged();
    }, 1500);
  }

  function scheduleLectureSoftReload() {
    clearTimeout(lectureNavDebounce);
    lectureNavDebounce = setTimeout(() => {
      if (!isLecturePage()) return;
      // Invalidate any extraction still running for the previous lecture (callbacks may otherwise
      // never post a terminal status after the next initiateTranscriptExtraction bumps the gen).
      extractionGen++;
      postToSidebar({ type: 'EXTENSION_READY', lectureUrl: location.href });
      waitForVideo(15000).then(video => {
        videoEl = video;
        startTimestampSync();
        return waitForTranscriptDomReady();
      }).then(() => {
        initiateTranscriptExtraction();
      });
    }, 400);
  }

  /**
   * After SPA navigation, Tobira/Paella may still expose the previous lecture's video node or HTML
   * for a short time. Poll until we see caption signals for the new page or time out.
   */
  function waitForTranscriptDomReady(timeoutMs = 20000, stepMs = 150) {
    return new Promise(resolve => {
      const t0 = Date.now();
      const tick = () => {
        if (findCaptionsUrlFromPage()) return resolve();
        if (extractCandidateEventIds().length) return resolve();
        if (Date.now() - t0 >= timeoutMs) return resolve();
        setTimeout(tick, stepMs);
      };
      tick();
    });
  }

  function waitForVideo(timeout = 15000) {
    return new Promise((resolve, reject) => {
      const check = () => {
        const v = document.querySelector('video');
        if (v) return resolve(v);
      };
      check();
      const obs = new MutationObserver(check);
      obs.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => {
        obs.disconnect();
        // Return null video rather than rejecting — sidebar still useful without video
        const v = document.querySelector('video');
        resolve(v);
      }, timeout);
    });
  }

  // ─── Sidebar Injection ───────────────────────────────────────────────────────

  function injectSidebar() {
    if (sidebarIframe) return;

    // Create sidebar iframe
    sidebarIframe = document.createElement('iframe');
    sidebarIframe.id = 'eth-copilot-sidebar';
    sidebarIframe.src = chrome.runtime.getURL('sidebar/sidebar.html');
    sidebarIframe.style.width = `${sidebarWidthPx}px`;
    sidebarIframe.style.minWidth = `${sidebarWidthPx}px`;
    document.body.appendChild(sidebarIframe);

    sidebarResizeHandle = document.createElement('div');
    sidebarResizeHandle.id = 'eth-copilot-resize-handle';
    document.body.appendChild(sidebarResizeHandle);
    initResizeHandle();

    sidebarToggle = document.createElement('button');
    sidebarToggle.id = 'eth-copilot-toggle';
    sidebarToggle.type = 'button';
    sidebarToggle.textContent = '⟨';
    sidebarToggle.title = 'Collapse sidebar';
    sidebarToggle.addEventListener('click', toggleSidebarCollapse);
    document.body.appendChild(sidebarToggle);

    sidebarVisible = true;
    updateSidebarWidths();

    // Listen for messages from sidebar
    window.addEventListener('message', onSidebarMessage);

    // Send ready state once iframe loads
    sidebarIframe.addEventListener('load', () => {
      postToSidebar({ type: 'EXTENSION_READY', lectureUrl: location.href });
    });
  }

  function updateSidebarWidths() {
    if (!sidebarIframe) return;
    const w = sidebarCollapsed ? 0 : sidebarWidthPx;
    sidebarIframe.style.width = `${w}px`;
    sidebarIframe.style.minWidth = `${w}px`;
    if (sidebarResizeHandle) {
      sidebarResizeHandle.style.display = sidebarCollapsed ? 'none' : 'block';
      sidebarResizeHandle.style.right = `${w}px`;
    }
    if (sidebarToggle) {
      sidebarToggle.textContent = sidebarCollapsed ? '⟩' : '⟨';
      sidebarToggle.title = sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar';
      sidebarToggle.style.right = `${Math.max(w - 1, 0)}px`;
    }
    if (!document.fullscreenElement && !focusMode) {
      document.body.style.paddingRight = sidebarCollapsed ? '0px' : `${sidebarWidthPx}px`;
    }
    if (focusMode) {
      document.body.style.paddingRight = '0px';
      updateFocusLayout();
    }
  }

  // Redirect sub-element fullscreen to document.documentElement so our
  // fixed-position sidebar stays visible. Runs in the same user gesture.
  function patchFullscreen(method) {
    const orig = Element.prototype[method];
    if (!orig) return;
    Element.prototype[method] = function (opts) {
      if (sidebarIframe && this !== document.documentElement && this !== document.body) {
        fsVideoTarget = this;
        return orig.call(document.documentElement, opts);
      }
      return orig.call(this, opts);
    };
  }
  patchFullscreen('requestFullscreen');
  patchFullscreen('webkitRequestFullscreen');

  function handleFullscreenChange() {
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;

    if (fsEl === document.documentElement) {
      document.body.classList.add('eth-copilot-fs');
      if (fsVideoTarget) fsVideoTarget.classList.add('eth-copilot-fs-video');
      updateSidebarWidths();
      return;
    }

    // Exited fullscreen — restore everything
    document.body.classList.remove('eth-copilot-fs');
    if (fsVideoTarget) {
      fsVideoTarget.classList.remove('eth-copilot-fs-video');
      fsVideoTarget = null;
    }
    updateSidebarWidths();
  }

  function toggleSidebarCollapse() {
    sidebarCollapsed = !sidebarCollapsed;
    updateSidebarWidths();
  }

  function initResizeHandle() {
    if (!sidebarResizeHandle) return;
    let dragging = false;

    sidebarResizeHandle.addEventListener('mousedown', (e) => {
      if (sidebarCollapsed) return;
      e.preventDefault();
      e.stopPropagation();
      dragging = true;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      sidebarIframe.style.pointerEvents = 'none';
    });

    document.addEventListener('mousemove', (ev) => {
      if (!dragging) return;
      ev.preventDefault();
      sidebarWidthPx = Math.max(
        SIDEBAR_MIN_WIDTH,
        Math.min(SIDEBAR_MAX_WIDTH, window.innerWidth - ev.clientX)
      );
      updateSidebarWidths();
    });

    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      sidebarIframe.style.pointerEvents = '';
    });
  }

  // ─── Focus Mode ─────────────────────────────────────────────────────────────

  function findVideoContainer() {
    if (!videoEl) return null;
    let el = videoEl.parentElement;
    while (el && el !== document.body) {
      const tag = el.tagName.toLowerCase();
      const cls = (el.className || '').toString().toLowerCase();
      const id = (el.id || '').toLowerCase();
      if (cls.includes('player') || id.includes('player') ||
          tag === 'section' || tag === 'main' || tag === 'article') {
        return el;
      }
      el = el.parentElement;
    }
    return videoEl.parentElement;
  }

  function toggleFocusMode() {
    focusMode = !focusMode;
    if (focusMode) {
      focusVideoContainer = findVideoContainer();
      if (focusVideoContainer) {
        focusVideoContainer.classList.add('eth-copilot-focus-video');
      }
      document.body.classList.add('eth-copilot-focus');
    } else {
      if (focusVideoContainer) {
        focusVideoContainer.classList.remove('eth-copilot-focus-video');
        focusVideoContainer.style.width = '';
        focusVideoContainer = null;
      }
      document.body.classList.remove('eth-copilot-focus');
      document.body.style.paddingRight = sidebarCollapsed ? '0px' : `${sidebarWidthPx}px`;
    }
    updateFocusLayout();
    postToSidebar({ type: 'FOCUS_MODE_CHANGED', active: focusMode });
  }

  function updateFocusLayout() {
    if (!focusMode || !focusVideoContainer) return;
    const w = sidebarCollapsed ? 0 : sidebarWidthPx;
    focusVideoContainer.style.width = `calc(100vw - ${w}px)`;
  }

  // ─── Timestamp Sync ──────────────────────────────────────────────────────────

  function startTimestampSync() {
    if (timestampInterval) clearInterval(timestampInterval);
    timestampInterval = setInterval(() => {
      if (!videoEl || !sidebarVisible) return;
      const t = videoEl.currentTime;
      postToSidebar({ type: 'TIMESTAMP_UPDATE', currentTime: t });
    }, 500);
  }

  // ─── Transcript Extraction ───────────────────────────────────────────────────

  function initiateTranscriptExtraction() {
    // New run id. scheduleLectureSoftReload also increments extractionGen so in-flight callbacks
    // from the previous lecture are invalidated before this run starts.
    const gen = ++extractionGen;
    postToSidebar({ type: 'TRANSCRIPT_STATUS', status: 'extracting' });

    const maxAttempts = 8;
    const retryDelayMs = 1500;

    const attemptExtraction = (attempt) => {
      if (gen !== extractionGen) return;
      const urlEventId = extractEventIdFromLocation();
      const fallbackVtt = findCaptionsUrlFromPage();
      // Without a URL UUID, a .vtt from resource timing can still be the previous lecture's track.
      if (!urlEventId && fallbackVtt) return fetchAndPublishVtt(fallbackVtt, null, gen);

      const eventCandidates = extractCandidateEventIds();
      if (!eventCandidates.length) {
        if (attempt < maxAttempts - 1) {
          setTimeout(() => attemptExtraction(attempt + 1), retryDelayMs);
          return;
        }
        if (gen !== extractionGen) return;
        postToSidebar({ type: 'TRANSCRIPT_STATUS', status: 'no_event_id' });
        return;
      }

      const tryCandidate = (idx) => {
        if (gen !== extractionGen) return;
        if (idx >= eventCandidates.length) {
          if (attempt < maxAttempts - 1) {
            setTimeout(() => attemptExtraction(attempt + 1), retryDelayMs);
            return;
          }
          if (gen !== extractionGen) return;
          postToSidebar({ type: 'TRANSCRIPT_STATUS', status: 'no_event_id' });
          return;
        }

        const eventId = eventCandidates[idx];
        chrome.runtime.sendMessage(
          { type: 'FETCH_JSON', url: `https://dist.tobira.ethz.ch/mh_default_org/engage-player/${eventId}/data.json` },
          response => {
            if (gen !== extractionGen) return;
            if (chrome.runtime.lastError) {
              tryCandidate(idx + 1);
              return;
            }
            if (!response || !response.success) {
              tryCandidate(idx + 1);
              return;
            }

            const vttUrl = findCaptionsUrl(response.data);
            if (!vttUrl) {
              tryCandidate(idx + 1);
              return;
            }
            fetchAndPublishVtt(vttUrl, eventId, gen);
          }
        );
      };

      tryCandidate(0);
    };

    attemptExtraction(0);
  }

  function fetchAndPublishVtt(vttUrl, eventId, gen) {
    chrome.runtime.sendMessage({ type: 'FETCH_VTT', url: vttUrl }, vttResp => {
      if (gen !== extractionGen) return;
      if (chrome.runtime.lastError) {
        postToSidebar({
          type: 'TRANSCRIPT_STATUS',
          status: 'error',
          error: chrome.runtime.lastError.message || 'VTT request failed'
        });
        return;
      }
      if (!vttResp || !vttResp.success) {
        postToSidebar({ type: 'TRANSCRIPT_STATUS', status: 'error', error: vttResp?.error || 'VTT request failed' });
        return;
      }

      const rawVtt = vttResp.data;
      const cues = parseVtt(rawVtt);
      if (!cues.length) {
        postToSidebar({ type: 'TRANSCRIPT_STATUS', status: 'no_captions' });
        return;
      }

      // Send clean [HH:MM:SS] text lines — same clean format as manual paste
      const transcriptText = formatTranscript(cues);
      const lectureTitle = document.querySelector('h1')?.textContent?.trim() || 'Lecture';

      postToSidebar({
        type: 'TRANSCRIPT_READY',
        cues,
        transcriptText,
        lectureTitle,
        lectureUrl: location.href,
        eventId,
        vttUrl,
        videoDuration: videoEl?.duration || 0
      });
    });
  }

  function stripVttHeader(vtt) {
    return vtt
      .replace(/\r\n/g, '\n')
      .replace(/^WEBVTT[\s\S]*?\n\n/, '')
      .trim();
  }

  function extractEventId() {
    // From JSON-LD VideoObject thumbnailUrl
    const ldScripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const s of ldScripts) {
      try {
        const d = JSON.parse(s.textContent);
        const url = d.thumbnailUrl || d.contentUrl || '';
        const m = url.match(/engage-player\/([0-9a-f-]{36})\//i);
        if (m) return m[1];
      } catch (_) {}
    }
    // From img sources
    for (const img of document.querySelectorAll('img[src*="dist.tobira.ethz.ch"]')) {
      const m = img.src.match(/engage-player\/([0-9a-f-]{36})\//i);
      if (m) return m[1];
    }
    return null;
  }

  function extractEventIdFromLocation() {
    const m = location.href.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    return m ? m[0] : null;
  }

  function extractCandidateEventIds() {
    const ids = [];
    const pushIfValid = (id) => {
      if (!id) return;
      if (!/^[0-9a-f-]{36}$/i.test(id)) return;
      if (!ids.includes(id)) ids.push(id);
    };

    // Prefer UUID from the visible URL so SPA navigations don't pick a stale ID from leftover HTML.
    pushIfValid(extractEventIdFromLocation());
    pushIfValid(extractEventId());

    const html = document.documentElement?.innerHTML || '';
    const patterns = [
      /engage-player\/([0-9a-f-]{36})\//ig,
      /engage-player\\\/([0-9a-f-]{36})\\\//ig
    ];

    for (const re of patterns) {
      let m;
      while ((m = re.exec(html)) !== null) {
        pushIfValid(m[1]);
      }
    }

    // Also scan inline script contents (often where player config is injected)
    for (const script of document.querySelectorAll('script:not([src])')) {
      const txt = script.textContent || '';
      for (const re of patterns) {
        let m;
        re.lastIndex = 0;
        while ((m = re.exec(txt)) !== null) {
          pushIfValid(m[1]);
        }
      }
    }
    return ids;
  }

  function findCaptionsUrlFromPage() {
    const selectors = [
      'track[src*=".vtt"]',
      'source[src*=".vtt"]',
      'a[href*=".vtt"]'
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const candidate = el.getAttribute('src') || el.getAttribute('href');
      if (candidate && /\.vtt(\?|$)/i.test(candidate)) return candidate;
    }

    // Resource timing often contains the exact VTT URL once player initialized
    try {
      const entries = performance.getEntriesByType('resource') || [];
      for (const entry of entries) {
        const name = entry?.name || '';
        if (/\.vtt(\?|$)/i.test(name)) return name;
      }
    } catch (_) {}

    const html = document.documentElement?.innerHTML || '';
    const direct = html.match(/https:\/\/dist\.tobira\.ethz\.ch\/[^"'\\\s]+\.vtt(?:\?[^"'\\\s]*)?/i);
    if (direct) return direct[0];

    // Escaped URL inside JSON/script blobs: https:\/\/...\.vtt
    const escaped = html.match(/https:\\\/\\\/dist\.tobira\.ethz\.ch\\\/[^"'\\\s]+\.vtt(?:\\\?[^"'\\\s]*)?/i);
    if (escaped) {
      return escaped[0]
        .replace(/\\\//g, '/')
        .replace(/\\\?/g, '?');
    }

    // Final fallback: scan script text for any .vtt URL and unescape
    for (const script of document.querySelectorAll('script:not([src])')) {
      const txt = script.textContent || '';
      const m = txt.match(/https?:\\\/\\\/[^"'\\\s]+\.vtt(?:\\\?[^"'\\\s]*)?/i)
             || txt.match(/https?:\/\/[^"'\\\s]+\.vtt(?:\?[^"'\\\s]*)?/i);
      if (m) {
        return m[0]
          .replace(/\\\//g, '/')
          .replace(/\\\?/g, '?');
      }
    }
    return null;
  }

  function findCaptionsUrl(playerData) {
    if (Array.isArray(playerData.captions)) {
      const t = playerData.captions.find(c => /en|de/i.test(c.lang)) || playerData.captions[0];
      if (t) return t.url || t.src;
    }
    if (Array.isArray(playerData.streams)) {
      for (const s of playerData.streams) {
        const caps = s?.sources?.captions;
        if (Array.isArray(caps) && caps.length) {
          const t = caps.find(c => /en|de/i.test(c.lang)) || caps[0];
          return t.src || t.url;
        }
      }
    }
    if (Array.isArray(playerData.tracks)) {
      const t = playerData.tracks.find(t =>
        t.type?.includes('captions') || t.flavor?.includes('captions') || (t.url || '').endsWith('.vtt')
      );
      if (t) return t.url || t.src;
    }
    return null;
  }

  function parseVtt(vttText) {
    const cues = [];
    const blocks = vttText.replace(/\r\n/g, '\n').split(/\n\n+/);
    for (const block of blocks) {
      const lines = block.trim().split('\n');
      let timeLine = -1;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('-->')) { timeLine = i; break; }
      }
      if (timeLine === -1) continue;
      const [startStr, endStr] = lines[timeLine].split('-->').map(s => s.trim().split(' ')[0]);
      const start = parseTs(startStr), end = parseTs(endStr);
      if (isNaN(start) || isNaN(end)) continue;
      const text = lines.slice(timeLine + 1).join(' ').replace(/<[^>]+>/g, '').trim();
      if (text) cues.push({ start_time: start, end_time: end, text });
    }
    return cues;
  }

  function parseTs(ts) {
    const p = ts.split(':').map(Number);
    if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
    if (p.length === 2) return p[0] * 60 + p[1];
    return NaN;
  }

  function formatTranscript(cues) {
    return cues.map(c => `[${fmtSec(c.start_time)}] ${c.text}`).join('\n');
  }

  function fmtSec(s) {
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
  }

  // ─── Keyboard Shortcuts ──────────────────────────────────────────────────────

  function initKeyboardShortcuts() {
    document.addEventListener('keydown', e => {
      // Don't intercept if user is typing in an input/textarea or in the sidebar
      if (document.activeElement?.tagName === 'INPUT' ||
          document.activeElement?.tagName === 'TEXTAREA' ||
          document.activeElement?.closest('#eth-copilot-sidebar')) return;

      if (!videoEl) return;

      if (e.key === 'ArrowUp') {
        e.preventDefault();
        const newRate = Math.min(4.0, Math.round((videoEl.playbackRate + 0.25) * 100) / 100);
        videoEl.playbackRate = newRate;
        showSpeedOverlay(newRate);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        const newRate = Math.max(0.25, Math.round((videoEl.playbackRate - 0.25) * 100) / 100);
        videoEl.playbackRate = newRate;
        showSpeedOverlay(newRate);
      }
    });
  }

  function showSpeedOverlay(rate) {
    let overlay = document.getElementById('eth-copilot-speed-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'eth-copilot-speed-overlay';
      document.body.appendChild(overlay);
    }
    overlay.textContent = `${rate}×`;
    overlay.classList.add('visible');

    clearTimeout(speedOverlayTimeout);
    speedOverlayTimeout = setTimeout(() => overlay.classList.remove('visible'), 1200);
  }

  // ─── Sidebar Messaging ───────────────────────────────────────────────────────

  function postToSidebar(msg) {
    if (!sidebarIframe?.contentWindow) return;
    try {
      sidebarIframe.contentWindow.postMessage(msg, '*');
    } catch (_) {}
  }

  function onSidebarMessage(e) {
    const msg = e.data;
    if (!msg?._copilot) return;
    if (!msg?.type) return;

    switch (msg.type) {
      case 'SEEK_VIDEO':
        if (videoEl) videoEl.currentTime = msg.time;
        break;

      case 'CAPTURE_FRAME':
        captureVideoFrame().then(b64 => {
          postToSidebar({ type: 'FRAME_CAPTURED', imageBase64: b64, requestId: msg.requestId });
        });
        break;

      case 'API_REQUEST':
        forwardApiRequest(msg.payload, msg.requestId);
        break;

      case 'GET_SETTINGS':
        chrome.storage.local.get(['provider', 'model', 'apiKey', 'localBases'], settings => {
          postToSidebar({ type: 'SETTINGS', settings });
        });
        break;

      case 'TOGGLE_FOCUS':
        toggleFocusMode();
        break;
    }
  }

  // ─── Frame Capture ───────────────────────────────────────────────────────────

  async function captureVideoFrame() {
    if (!videoEl) return null;

    // Strategy 1: direct canvas capture (fast, frame-accurate)
    const canvasCapture = () => {
      const canvas = document.createElement('canvas');
      canvas.width = videoEl.videoWidth || 1280;
      canvas.height = videoEl.videoHeight || 720;
      canvas.getContext('2d').drawImage(videoEl, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/jpeg', 0.85).split(',')[1] || null;
    };

    try {
      const b64 = canvasCapture();
      if (b64) return b64;
    } catch (_) {
      console.warn('[ETH Copilot] Canvas capture tainted, falling back to tab screenshot…');
    }

    // Strategy 2: screenshot the visible tab via background, then crop to video
    try {
      const rect = videoEl.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;

      const dataUrl = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ type: 'CAPTURE_VISIBLE_TAB' }, resp => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (!resp?.success) return reject(new Error(resp?.error || 'Tab capture failed'));
          resolve(resp.data);
        });
      });

      const img = await loadImage(dataUrl);
      const cx = Math.round(rect.left * dpr);
      const cy = Math.round(rect.top * dpr);
      const cw = Math.round(rect.width * dpr);
      const ch = Math.round(rect.height * dpr);
      const canvas = document.createElement('canvas');
      canvas.width = cw;
      canvas.height = ch;
      canvas.getContext('2d').drawImage(img, cx, cy, cw, ch, 0, 0, cw, ch);
      return canvas.toDataURL('image/jpeg', 0.85).split(',')[1];
    } catch (e) {
      console.warn('[ETH Copilot] Tab capture fallback failed:', e.message);
      return null;
    }
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Image decode failed'));
      img.src = src;
    });
  }

  function forwardApiRequest(payload, requestId) {
    console.log('[ETH Copilot] forwardApiRequest →', payload.type, requestId);
    chrome.runtime.sendMessage(payload, response => {
      const err = chrome.runtime.lastError?.message;
      if (err) {
        console.error('[ETH Copilot] sendMessage error:', err);
        postToSidebar({
          type: 'API_RESPONSE',
          requestId,
          response: { success: false, error: err }
        });
        return;
      }
      console.log('[ETH Copilot] Response:', response?.success);
      postToSidebar({
        type: 'API_RESPONSE',
        requestId,
        response: response || { success: false, error: 'Empty response from background' }
      });
    });
  }

  // ─── Bootstrap ───────────────────────────────────────────────────────────────

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
