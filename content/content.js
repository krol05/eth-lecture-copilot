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

  const SIDEBAR_MIN_WIDTH = 280;
  const SIDEBAR_MAX_WIDTH = 560;
  const SIDEBAR_DEFAULT_WIDTH = 380;
  /** Minimum horizontal space left for the page (video) when the sidebar is open. */
  const SIDEBAR_MIN_VIDEO_RESERVE_PX = 160;

  // ─── State ──────────────────────────────────────────────────────────────────
  let sidebarIframe = null;
  let sidebarToggle = null;
  let sidebarResizeHandle = null;
  let sidebarVisible = false;
  let sidebarCollapsed = false;
  let sidebarWidthPx = SIDEBAR_DEFAULT_WIDTH;
  let videoEl = null;
  let fsVideoTarget = null;
  let timestampInterval = null;
  let lastBlockIndex = -1;
  let speedOverlayTimeout = null;
  /** Bumped on SPA navigation so in-flight FETCH_JSON/VTT callbacks cannot complete with a stale generation. */
  let extractionGen = 0;
  let lastSuccessfulEventId = null;
  let blockedEventIdAfterNav = null;
  let lectureNavPerfStart = 0;
  let lastKnownHref = '';
  let lectureNavDebounce = null;
  let focusMode = false;
  let focusVideoContainer = null;

  // ─── Entry Point ─────────────────────────────────────────────────────────────

  function init() {
    // Only activate on pages that have a video player
    if (!isLecturePage()) return;

    // Wait for the video element to appear (Paella loads dynamically)
    lastKnownHref = location.href;
    lectureNavPerfStart = getPerfNow();
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
    const onViewportChanged = () => {
      clampSidebarWidthToViewport();
      updateSidebarWidths();
    };
    window.addEventListener('resize', onViewportChanged);
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', onViewportChanged);
    }

    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg?.type) return;
      if (msg.type === 'SETTINGS_UPDATED') {
        chrome.storage.local.get(['provider', 'model', 'apiKey', 'localBases'], settings => {
          postToSidebar({ type: 'SETTINGS', settings });
        });
        return;
      }
      if (msg.type === 'API_PROGRESS' && msg.requestId) {
        postToSidebar({
          type: 'API_PROGRESS',
          requestId: msg.requestId,
          stage: msg.stage || '',
          detail: msg.detail || ''
        });
      }
      if (msg.type === 'API_STREAM_CHUNK' && msg.requestId) {
        postToSidebar({
          type: 'API_STREAM_CHUNK',
          requestId: msg.requestId,
          text: msg.text || ''
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
      blockedEventIdAfterNav = lastSuccessfulEventId;
      lectureNavPerfStart = getPerfNow();
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
        // During SPA transitions, only treat very recent page signals as "ready" to avoid stale carry-over.
        if (findCaptionsUrlFromPage({ recentOnly: true })) return resolve();
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

  function getEffectiveSidebarMaxWidth() {
    const vw =
      (typeof window.visualViewport !== 'undefined' && window.visualViewport?.width) ||
      window.innerWidth;
    return Math.min(
      SIDEBAR_MAX_WIDTH,
      Math.max(SIDEBAR_MIN_WIDTH, vw - SIDEBAR_MIN_VIDEO_RESERVE_PX)
    );
  }

  function clampSidebarWidthToViewport() {
    const cap = getEffectiveSidebarMaxWidth();
    sidebarWidthPx = Math.max(SIDEBAR_MIN_WIDTH, Math.min(sidebarWidthPx, cap));
  }

  function injectSidebar() {
    if (sidebarIframe) return;

    // Create sidebar iframe
    sidebarIframe = document.createElement('iframe');
    sidebarIframe.id = 'eth-copilot-sidebar';
    sidebarIframe.src = chrome.runtime.getURL('sidebar/sidebar.html');
    sidebarIframe.style.width = `${sidebarWidthPx}px`;
    sidebarIframe.style.minWidth = `${sidebarWidthPx}px`;
    sidebarIframe.setAttribute('aria-label', 'ETH Lecture Copilot sidebar');
    sidebarIframe.setAttribute('title', 'ETH Lecture Copilot');
    sidebarIframe.setAttribute('role', 'complementary');
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

    // Send the handshake once the extension page has loaded. Before load,
    // contentWindow.origin is the parent page's origin, causing a DOMException.
    sidebarIframe.addEventListener('load', () => {
      postToSidebar({ type: 'EXTENSION_READY', lectureUrl: location.href });
    });
  }

  function updateSidebarWidths() {
    if (!sidebarIframe) return;
    clampSidebarWidthToViewport();
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
      const cap = getEffectiveSidebarMaxWidth();
      sidebarWidthPx = Math.max(SIDEBAR_MIN_WIDTH, Math.min(cap, window.innerWidth - ev.clientX));
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
    const blockedAttempts = 4;

    const attemptExtraction = (attempt) => {
      if (gen !== extractionGen) return;
      const urlEventId = extractEventIdFromLocation();
      const recentOnly = attempt < blockedAttempts;
      const fallbackVtt = findCaptionsUrlFromPage({ recentOnly });
      // Without a URL UUID, a .vtt from resource timing can still be the previous lecture's track.
      if (!urlEventId && fallbackVtt) {
        const fallbackEventId = extractEventIdFromVttUrl(fallbackVtt);
        const isBlockedOldEvent =
          blockedEventIdAfterNav &&
          attempt < blockedAttempts &&
          fallbackEventId &&
          fallbackEventId === blockedEventIdAfterNav;
        if (!isBlockedOldEvent) {
          return fetchAndPublishVtt(fallbackVtt, fallbackEventId, gen);
        }
      }

      const rawCandidates = extractCandidateEventIds();
      const eventCandidates =
        (blockedEventIdAfterNav && attempt < blockedAttempts)
          ? rawCandidates.filter(id => id !== blockedEventIdAfterNav)
          : rawCandidates;
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
            // DOM is the most accurate source (Tobira's <time datetime> attribute);
            // fall back to data.json fields if the DOM element isn't yet rendered.
            const lectureDate = extractLectureDateFromPage()
                             || extractLectureDateFromPlayerData(response.data);
            fetchAndPublishVtt(vttUrl, eventId, gen, lectureDate);
          }
        );
      };

      tryCandidate(0);
    };

    attemptExtraction(0);
  }

  function fetchAndPublishVtt(vttUrl, eventId, gen, lectureDate) {
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

      const transcriptText = formatTranscript(cues);
      const lectureTitle = document.querySelector('h1')?.textContent?.trim() || 'Lecture';
      const courseKey   = extractCourseKeyFromUrl(location.href);
      const courseName  = extractCourseName(lectureTitle);

      postToSidebar({
        type: 'TRANSCRIPT_READY',
        cues,
        transcriptText,
        lectureTitle,
        lectureUrl: location.href,
        eventId,
        vttUrl,
        videoDuration: videoEl?.duration || 0,
        lectureDate: lectureDate || null,
        courseKey:   courseKey  || null,
        courseName:  courseName || null,
      });
      lastSuccessfulEventId = eventId || extractEventIdFromVttUrl(vttUrl) || null;
      blockedEventIdAfterNav = null;
    });
  }

  /** Scrape the lecture recording date directly from the video.ethz.ch page DOM.
   *  Tobira renders <time datetime="2026-05-04T08:13:00.000Z">Yesterday at…</time>
   *  right below the <h1> title. We walk up from the h1 to find its sibling time
   *  element, which is always the current video's date (series-list <time> elements
   *  appear later in the DOM and are never the first match). */
  function extractLectureDateFromPage() {
    try {
      // Walk up from h1 up to 5 levels; look for a time[datetime] sibling
      const h1 = document.querySelector('h1');
      if (h1) {
        let ancestor = h1.parentElement;
        for (let depth = 0; depth < 6 && ancestor; depth++, ancestor = ancestor.parentElement) {
          const t = ancestor.querySelector('time[datetime]');
          if (t) {
            const dt = t.getAttribute('datetime');
            return dt || null;
          }
        }
      }
      // Fallback: first time[datetime] anywhere on page is the current video's date
      const t = document.querySelector('time[datetime]');
      return t ? (t.getAttribute('datetime') || null) : null;
    } catch { return null; }
  }

  /** Extract the lecture recording date from Tobira/Opencast data.json */
  function extractLectureDateFromPlayerData(data) {
    if (!data) return null;
    // Opencast mediapackage format
    const mp = data.mediapackage || data.mediaPackage;
    if (mp?.start) return mp.start;
    if (mp?.date) return mp.date;
    // Tobira flat format
    if (data.start)   return data.start;
    if (data.created) return data.created;
    if (data.date)    return data.date;
    return null;
  }

  /** Derive a stable course key from a video.ethz.ch URL.
   *  e.g. /lectures/d-infk/2024/spring/252-0002-00L/uuid → "d-infk::252-0002-00L" */
  function extractCourseKeyFromUrl(href) {
    if (!href) return null;
    try {
      const parts = new URL(href).pathname.split('/').filter(Boolean);
      // Expect: lectures / dept / year / season / courseId / eventId
      if (parts[0] === 'lectures' && parts.length >= 5) {
        return `${parts[1]}::${parts[4]}`;
      }
      // Fallback: first 3 meaningful path segments
      return parts.slice(0, 3).join('::') || null;
    } catch { return null; }
  }

  /** Extract a human course name from the H1 lecture title.
   *  "Algorithms and Data Structures — Lecture 5" → "Algorithms and Data Structures"
   *
   *  Tobira breadcrumbs render the full URL path as nav links:
   *    Lectures → D-INFK → 2026 → Spring → Parallele Programmierung
   *  We must skip URL path segments (seasons, years, dept codes) to get the real name. */
  const _BAD_BREADCRUMB = /^(home|start|lectures?|spring|fall|autumn|winter|summer|herbst|früh?ling|sommer|d-\w{1,8}|\d{4})$/i;
  function extractCourseName(lectureTitle) {
    if (!lectureTitle) return null;
    // Try breadcrumb nav on page first — skip URL path segments
    const breadcrumbs = document.querySelectorAll('nav a, .breadcrumb a, [aria-label="breadcrumb"] a, [class*="breadcrumb"] a');
    for (const el of breadcrumbs) {
      const t = el.textContent?.trim();
      if (t && t.length > 4 && !_BAD_BREADCRUMB.test(t)) return t;
    }
    // Fall back to stripping "Lecture N" / "— Lecture" suffix from H1
    return lectureTitle
      .replace(/[\s—–-]+lecture\s*\d+.*/i, '')
      .replace(/[\s—–-]+\d{4}.*/i, '')
      .trim() || lectureTitle;
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

  function extractEventIdFromVttUrl(vttUrl) {
    if (!vttUrl) return null;
    const m = String(vttUrl).match(/engage-player\/([0-9a-f-]{36})\//i);
    return m ? m[1] : null;
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

  function getPerfNow() {
    try { return performance.now(); } catch (_) { return 0; }
  }

  function findCaptionsUrlFromPage({ recentOnly = false } = {}) {
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
      const minStart = lectureNavPerfStart > 0 ? Math.max(0, lectureNavPerfStart - 250) : 0;
      // Iterate from newest to oldest; the oldest entry is often from the previous lecture.
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        const name = entry?.name || '';
        const startTime = Number(entry?.startTime || 0);
        if (recentOnly && startTime < minStart) continue;
        if (/\.vtt(\?|$)/i.test(name)) return name;
      }
    } catch (_) {}

    if (recentOnly) return null;

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
        const newRate = Math.min(5.0, Math.round((videoEl.playbackRate + 0.25) * 100) / 100);
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

  /** Origin of this extension's pages (chrome-extension://{id}) */
  const _extOrigin = new URL(chrome.runtime.getURL('')).origin;

  function postToSidebar(msg) {
    if (!sidebarIframe?.contentWindow) return;
    try {
      // Restrict to our own extension origin — prevents other pages from spoofing reads.
      sidebarIframe.contentWindow.postMessage(msg, _extOrigin);
    } catch (_) {}
  }

  function onSidebarMessage(e) {
    // Only accept messages that literally came from our sidebar iframe's window object.
    // This prevents any page script from sending forged _copilot messages.
    if (e.source !== sidebarIframe?.contentWindow) return;
    const msg = e.data;
    if (!msg?._copilot) return;
    if (!msg?.type) return;

    switch (msg.type) {
      case 'SEEK_VIDEO':
        if (videoEl) videoEl.currentTime = msg.time;
        break;

      case 'SPEED_CHANGE':
        if (videoEl) {
          const newRate = msg.direction > 0
            ? Math.min(5.0,  Math.round((videoEl.playbackRate + 0.25) * 100) / 100)
            : Math.max(0.25, Math.round((videoEl.playbackRate - 0.25) * 100) / 100);
          videoEl.playbackRate = newRate;
          // Sidebar initiated — show overlay inside the sidebar (via SPEED_UPDATED),
          // not on the video page side.
          postToSidebar({ type: 'SPEED_UPDATED', rate: newRate });
        }
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
    // Re-query if the stored reference is stale (SPA navigation, player reinit)
    let vid = videoEl;
    if (!vid || !vid.isConnected) {
      vid = document.querySelector('video');
      if (vid) videoEl = vid;
    }
    if (!vid) {
      console.warn('[ETH Copilot] captureVideoFrame: no video element found');
      return null;
    }

    // ETH video streams are cross-origin HLS (dist.tobira.ethz.ch), so canvas
    // drawImage and captureStream() are both blocked by CORS. We use tab screenshot
    // (captureVisibleTab) which requires <all_urls> in manifest host_permissions.
    try {
      const rect = vid.getBoundingClientRect();
      const dpr  = window.devicePixelRatio || 1;
      const cw   = Math.round(rect.width  * dpr);
      const ch   = Math.round(rect.height * dpr);

      if (cw <= 0 || ch <= 0) {
        console.warn('[ETH Copilot] captureVideoFrame: video element has zero dimensions');
        return null;
      }

      const dataUrl = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ type: 'CAPTURE_VISIBLE_TAB' }, resp => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (!resp?.success) return reject(new Error(resp?.error || 'Tab capture failed'));
          resolve(resp.data);
        });
      });

      const img    = await loadImage(dataUrl);
      const cx     = Math.round(rect.left * dpr);
      const cy     = Math.round(rect.top  * dpr);
      const canvas = document.createElement('canvas');
      canvas.width  = cw;
      canvas.height = ch;
      canvas.getContext('2d').drawImage(img, cx, cy, cw, ch, 0, 0, cw, ch);
      return canvas.toDataURL('image/jpeg', 0.85).split(',')[1] || null;
    } catch (e) {
      console.warn('[ETH Copilot] captureVideoFrame failed:', e.message);
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
    chrome.runtime.sendMessage({ ...payload, _copilotRequestId: requestId }, response => {
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
