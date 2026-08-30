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
  /**
   * The lecture's own <video>, never the hidden one used to copy frames.
   * That decoder lives in the DOM too, and document.querySelector('video')
   * happily returned it — which made focus mode resize a 1x1 invisible
   * element and blank the lecture.
   */
  const REAL_VIDEO = 'video:not([data-eth-copilot-decoder])';

  let sidebarIframe = null;
  /** True once the extension page inside the iframe has loaded. */
  let sidebarReady = false;
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
    window.CopilotDebug?.log('content.init', { href: location.href });
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
      window.CopilotDebug?.log('content.runtime.onMessage', {
        type: msg.type,
        requestId: msg.requestId,
        message: msg
      });
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
      // Everything cached about the OLD lecture must go, or the next frame
      // capture serves the previous lecture's video: the rendition list and
      // the decoder are both keyed to a URL that is no longer on screen.
      forgetFrameCaptureState();
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
        const v = document.querySelector(REAL_VIDEO);
        if (v) return resolve(v);
      };
      check();
      const obs = new MutationObserver(check);
      obs.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => {
        obs.disconnect();
        // Return null video rather than rejecting — sidebar still useful without video
        const v = document.querySelector(REAL_VIDEO);
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
    sidebarReady = false;
    sidebarIframe.addEventListener('load', () => { sidebarReady = true; });
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

  let lastSentTimestamp = -1;

  function startTimestampSync() {
    if (timestampInterval) clearInterval(timestampInterval);
    timestampInterval = setInterval(() => {
      if (!videoEl || !sidebarVisible || !sidebarReady) return;
      // Only send when it actually changed. A paused video used to post the
      // same number forever, waking the sidebar twice a second for nothing.
      const t = videoEl.currentTime;
      if (Math.abs(t - lastSentTimestamp) < 0.25) return;
      lastSentTimestamp = t;
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
          return fetchAndPublishVtt(fallbackVtt, fallbackEventId, gen, extractLectureDateFromPage() || null);
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

            lastPlayerData = response.data;
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
        postToSidebar({
          type: 'TRANSCRIPT_STATUS',
          status: 'error',
          error: vttResp?.error || 'VTT request failed',
          errorDetail: vttResp?.errorDetail || null
        });
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

      // If we couldn't get the lecture date yet (SPA may still be rendering),
      // retry DOM extraction a few times and send an update once found.
      if (!lectureDate) {
        let retries = 0;
        const tryLaterDate = () => {
          if (gen !== extractionGen) return;
          const d = extractLectureDateFromPage();
          if (d) {
            postToSidebar({ type: 'TRANSCRIPT_DATE_UPDATE', lectureDate: d });
            return;
          }
          if (++retries < 8) setTimeout(tryLaterDate, 1000);
        };
        setTimeout(tryLaterDate, 800);
      }
    });
  }

  /** Scrape the lecture recording date directly from the video.ethz.ch page DOM.
   *  Tobira renders <time datetime="2026-05-04T08:13:00.000Z">…</time>
   *  right below the <h1> title inside a sibling div.
   *
   *  Strategy:
   *  1. Walk UP from h1 (up to 8 levels) and use querySelector to find the first
   *     <time datetime> within that subtree — this hits the header time, which
   *     is always the current video's date.
   *  2. Fallback: extract the video ID from the URL and find its matching entry
   *     in the series list (Tobira renders each <a href="…/{id}"> with a sibling
   *     <time datetime>).
   *  3. Last resort: first time[datetime] in document. */
  function extractLectureDateFromPage() {
    try {
      // Method 1: Walk up from h1 — handles the header area
      const h1 = document.querySelector('h1');
      if (h1) {
        let ancestor = h1.parentElement;
        for (let depth = 0; depth < 8 && ancestor; depth++, ancestor = ancestor.parentElement) {
          const t = ancestor.querySelector('time[datetime]');
          if (t?.getAttribute('datetime')) return t.getAttribute('datetime');
        }
      }

      // Method 2: Match via video ID in the series list
      // URL pattern: /lectures/.../v/{videoId}
      const videoIdMatch = location.pathname.match(/\/v\/([^/]+)\/?$/);
      if (videoIdMatch) {
        const videoId = videoIdMatch[1];
        // Find the <a> tag linking to this video, then look for a sibling time element
        const link = document.querySelector(`a[href*="${videoId}"]`);
        if (link) {
          let el = link;
          for (let d = 0; d < 6 && el; d++, el = el.parentElement) {
            const t = el.querySelector('time[datetime]');
            if (t?.getAttribute('datetime')) return t.getAttribute('datetime');
          }
        }
      }

      // Method 3: First time[datetime] on page (Tobira puts current video date first)
      const t = document.querySelector('time[datetime]');
      return t?.getAttribute('datetime') || null;
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

    // ── Strategy 1: Series page link ──────────────────────────────────────────
    // The current video URL ends with a UUID; the parent path is the series/course page.
    // Find an <a> whose href exactly matches that parent path — its text is the course name.
    try {
      const pathname  = location.pathname.replace(/\/$/, '');
      const uuidRe    = /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const seriesPath = uuidRe.test(pathname) ? pathname.replace(uuidRe, '') : null;
      if (seriesPath) {
        for (const a of document.querySelectorAll('a[href]')) {
          const aPath = new URL(a.href, location.href).pathname.replace(/\/$/, '');
          if (aPath === seriesPath) {
            const t = a.textContent?.trim();
            if (t && t.length > 4 && !_BAD_BREADCRUMB.test(t)) return t;
          }
        }
      }
    } catch (_) {}

    // ── Strategy 2: Tobira breadcrumb nav ─────────────────────────────────────
    // ETH's Tobira SPA uses aria-label="breadcrumbs" (plural). We intentionally
    // DO NOT use 'nav a' here — that would also match the course-list sidebar nav
    // whose first link is alphabetically first ("Building Control and Automation"),
    // not the current course.
    const breadcrumbSelectors = [
      'nav[aria-label="breadcrumbs"] a',
      'nav[aria-label="breadcrumb"] a',
      '[aria-label="breadcrumbs"] a',
      '[aria-label="breadcrumb"] a',
      '[class*="breadcrumb"] a',
    ];
    for (const sel of breadcrumbSelectors) {
      for (const el of document.querySelectorAll(sel)) {
        const t = el.textContent?.trim();
        if (t && t.length > 4 && !_BAD_BREADCRUMB.test(t)) return t;
      }
    }

    // ── Strategy 3: H1 title with "Lecture N" suffix stripped ─────────────────
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

  /** The player's own description of this lecture, kept for frame capture. */
  let lastPlayerData = null;

  /**
   * The sharpest video the server offers.
   *
   * The player picks a rendition for smooth playback, not for stills, so
   * currentSrc is often a modest one — which is why an attached frame looked
   * soft even when copied perfectly at "native" size. The engage-player
   * description lists every rendition with its resolution, so a still can use
   * the best one regardless of what is being streamed.
   *
   * Prefers the slide feed ("presentation") over the lecturer camera, since
   * that is what people attach a frame to ask about.
   */
  function bestVideoTrackUrl(playerData) {
    if (!playerData) return null;
    const candidates = [];

    const consider = (url, w, h, flavor) => {
      if (!url || !/\.mp4(\?|$)/i.test(url)) return;
      candidates.push({ url, pixels: (Number(w) || 0) * (Number(h) || 0), flavor: String(flavor || '') });
    };

    for (const t of playerData.tracks || []) {
      consider(t.url || t.src, t.video?.resolution?.split('x')[0] ?? t.width,
        t.video?.resolution?.split('x')[1] ?? t.height, t.type || t.flavor);
    }
    for (const s of playerData.streams || []) {
      for (const key of ['mp4', 'hls', 'sources']) {
        for (const src of (s?.sources?.[key] || [])) {
          consider(src.src || src.url, src.res?.w ?? src.width, src.res?.h ?? src.height,
            s.content || s.flavor);
        }
      }
    }
    if (!candidates.length) return null;

    const slides = candidates.filter(c => /present(ation)?|slide|screen/i.test(c.flavor));
    const pool = slides.length ? slides : candidates;
    pool.sort((a, b) => b.pixels - a.pixels);
    console.info('[ETH Copilot] video renditions on offer:',
      pool.map(c => `${c.flavor || '?'} ${c.pixels || 'unknown size'}`).join(' | '));
    return pool[0].pixels ? pool[0].url : null;
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
    // Until the extension page has loaded, contentWindow is still about:blank
    // and inherits the PAGE's origin, so posting to our extension origin is
    // rejected — and the browser logs a warning with a stack trace for every
    // attempt. The timestamp sync fires twice a second, so that alone was
    // half of all main-thread work on a lecture page.
    if (!sidebarReady) return;
    try {
      // Restrict to our own extension origin — prevents other pages from spoofing reads.
      sidebarIframe.contentWindow.postMessage(msg, _extOrigin);
    } catch (_) {}
  }

  function onSidebarMessage(e) {
    // Only accept messages that literally came from our sidebar iframe's window object.
    // This prevents any page script from sending forged _copilot messages.
    if (e.source !== sidebarIframe?.contentWindow) return;
    // Hearing from the sidebar proves it has loaded, even if we somehow
    // missed the load event. Never let a missed event mute the extension.
    sidebarReady = true;
    const msg = e.data;
    if (!msg?._copilot) return;
    if (!msg?.type) return;
    window.CopilotDebug?.log('content.onSidebarMessage', {
      type: msg.type,
      requestId: msg.requestId,
      message: msg
    });

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

      case 'HIDE_PLAYER_CHROME': {
        // Hide the controls and hold them hidden long enough for the
        // background's screenshot to land, then put everything back.
        let v = videoEl;
        if (!v || !v.isConnected) v = document.querySelector(REAL_VIDEO);
        if (v) withPlayerControlsHidden(v, () => new Promise(r => setTimeout(r, 900)));
        break;
      }

      case 'FRAME_SHORTCUT_CAPTURED': {
        // Sent by the background after the keyboard shortcut, which is what
        // grants activeTab and therefore makes the screenshot legal without
        // access to every website. Crop it to the player and hand it over.
        if (msg.error) {
          postToSidebar({ type: 'FRAME_ATTACHED', error: msg.error });
          break;
        }
        cropTabShotToVideo(msg.dataUrl).then(b64 => {
          postToSidebar({
            type: 'FRAME_ATTACHED',
            imageBase64: b64,
            error: b64 ? null : 'Could not find the video on this page.'
          });
        });
        break;
      }

      case 'CAPTURE_FRAME':
        lastCaptureError = null;
        needsScreenshotPermission = false;
        captureVideoFrame().then(b64 => {
          postToSidebar({
            type: 'FRAME_CAPTURED',
            imageBase64: b64,
            // Why it failed, so the sidebar can say more than nothing at all
            error: b64 ? null : (lastCaptureError || 'No video frame available'),
            // Only true when copying the frame directly was refused and the
            // tab screenshot is the sole remaining option — the one case
            // where asking for broad access is justified.
            needsScreenshot: needsScreenshotPermission,
            requestId: msg.requestId
          });
        });
        break;

      case 'API_REQUEST':
        window.CopilotDebug?.log('content.message.API_REQUEST', {
          requestId: msg.requestId,
          payloadType: msg.payload?.type,
          payload: msg.payload
        });
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

      case 'NAVIGATE_TO_LECTURE':
        if (msg.url && typeof msg.url === 'string') {
          try {
            const target = new URL(msg.url, location.href).href;
            if (target !== location.href) location.href = target;
          } catch {
            // ignore invalid URLs
          }
        }
        break;
    }
  }

  // ─── Frame Capture ───────────────────────────────────────────────────────────

  /**
   * Copy the current video frame into a canvas.
   *
   * Returns base64 JPEG, or null when the browser refuses because the frame is
   * cross-origin (a SecurityError on toDataURL — the canvas is "tainted").
   * Refusal is expected and handled, never an error worth surfacing.
   */
  function drawVideoToCanvas(vid) {
    const w = vid.videoWidth;
    const h = vid.videoHeight;
    if (!w || !h) {
      directFrameFailure = `video reports no dimensions (readyState ${vid.readyState}, src ${String(vid.currentSrc || vid.src || '').slice(0, 40)})`;
      return null;
    }
    try {
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(vid, 0, 0, w, h);
      return canvas.toDataURL('image/jpeg', 0.85).split(',')[1] || null;
    } catch (e) {
      // SecurityError here means the frame really is protected and only a tab
      // screenshot can reach it. Anything else is a bug worth reading.
      directFrameFailure = `${e.name}: ${e.message}`;
      return null;
    }
  }

  async function captureVideoFrame() {
    // Re-query if the stored reference is stale (SPA navigation, player reinit)
    let vid = videoEl;
    if (!vid || !vid.isConnected) {
      vid = document.querySelector(REAL_VIDEO);
      if (vid) videoEl = vid;
    }
    if (!vid) {
      console.warn('[ETH Copilot] captureVideoFrame: no video element found');
      return null;
    }

    // Preferred path: draw the video straight into a canvas. This needs no
    // permission at all.
    //
    // The old code skipped this on the assumption that a cross-origin HLS
    // stream taints the canvas. That is true of a video loaded natively from
    // another origin, but ETH's player feeds the element through MediaSource
    // with a blob: URL, and MSE-sourced frames are NOT tainted — the media was
    // fetched by the page's own JS under CORS. So this usually just works, and
    // the tab screenshot below (which Chrome only allows with access to every
    // site) becomes a fallback almost nobody has to accept.
    directFrameFailure = null;
    nativeFrameFailure = null;

    // 1. Read the visible element's pixels. Free and exact, when not tainted.
    const direct = drawVideoToCanvas(vid);
    if (direct) return direct;
    console.warn('[ETH Copilot] direct frame copy failed:', directFrameFailure);

    // 2. Re-open the same media with CORS enabled. Full source resolution,
    //    no controls, no permissions — see captureAtNativeResolution.
    const native = await captureAtNativeResolution(vid);
    if (native) return native;
    console.warn('[ETH Copilot] native-resolution copy failed:', nativeFrameFailure);

    // Fallback: screenshot the tab and crop to the player.
    //
    // captureVisibleTab needs access to the tab's URL — either activeTab
    // (granted when the user invokes the extension on that tab) or a matching
    // host permission. video.ethz.ch is required in the manifest, so lecture
    // pages qualify. This used to lean on <all_urls>; if it ever fails the
    // reason is reported rather than swallowed, because a silent null here
    // looks to the user like the button simply does nothing.
    try {
      const dpr = window.devicePixelRatio || 1;
      if (!vid.getBoundingClientRect().width) {
        console.warn('[ETH Copilot] captureVideoFrame: video element has zero dimensions');
        return null;
      }

      const dataUrl = await withPlayerControlsHidden(vid, () => new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ type: 'CAPTURE_VISIBLE_TAB' }, resp => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (!resp?.success) return reject(new Error(resp?.error || 'Tab capture failed'));
          resolve(resp.data);
        });
      }));

      // Re-measure INSIDE the hidden/enlarged state: the element now fills the
      // window, so this is the rectangle the screenshot actually contains.
      const shot = vid.getBoundingClientRect();
      const cw = Math.round(shot.width * dpr);
      const ch = Math.round(shot.height * dpr);
      if (cw <= 0 || ch <= 0) return null;

      const img = await loadImage(dataUrl);
      const canvas = document.createElement('canvas');
      canvas.width  = cw;
      canvas.height = ch;
      canvas.getContext('2d').drawImage(
        img, Math.round(shot.left * dpr), Math.round(shot.top * dpr), cw, ch, 0, 0, cw, ch);
      // 0.92: the browser already compressed this once as JPEG, so a low
      // second pass compounds the artefacts on slide text.
      return canvas.toDataURL('image/jpeg', 0.92).split(',')[1] || null;
    } catch (e) {
      console.warn('[ETH Copilot] captureVideoFrame failed:', e.message);
      lastCaptureError = e.message || 'Screenshot failed';
      if (directFrameFailure) lastCaptureError += ` (copying the frame directly first failed with: ${directFrameFailure})`;
      if (/all_urls|activeTab|permission/i.test(e.message || '')) needsScreenshotPermission = true;
      return null;
    }
  }

  /** Why the last frame capture failed, so the sidebar can say so. */
  let lastCaptureError = null;
  /** Set when only a tab screenshot is left, which needs a broad grant. */
  let needsScreenshotPermission = false;
  /** Why copying the frame directly did not work — decides the whole strategy. */
  let directFrameFailure = null;
  /** Why re-opening the media with CORS did not work. */
  let nativeFrameFailure = null;

  /**
   * Ask the background where a media URL actually lands.
   *
   * Falls back to the original address if anything goes wrong: a failed lookup
   * should cost us the high-quality path, never the whole capture.
   */
  async function resolveMediaUrl(url) {
    try {
      const resp = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'RESOLVE_MEDIA_URL', url }, resolve);
      });
      if (chrome.runtime.lastError || !resp?.success || !resp.data?.url) return url;
      return resp.data.url;
    } catch {
      return url;
    }
  }

  /**
   * Capture at the video's NATIVE resolution by decoding it a second time.
   *
   * The visible <video> is tainted because the page never set crossorigin on
   * it, so its pixels cannot be read. That is a property of the element, not
   * of the file: a second element that declares crossorigin="anonymous" gets
   * clean pixels, provided the server sends CORS headers — which this one must,
   * since the player fetches its media over XHR and that requires them.
   *
   * Worth the effort because it fixes all three problems at once: full source
   * resolution instead of the on-screen crop, no player controls in the frame,
   * and no permission of any kind.
   *
   * Returns null for a blob:/MediaSource src (nothing to re-open), if the
   * server declines CORS after all, or if it takes too long.
   */
  async function captureAtNativeResolution(vid) {
    const best = bestVideoTrackUrl(lastPlayerData);
    if (!best) {
      console.warn('[ETH Copilot] no rendition list available — falling back to the streamed quality',
        lastPlayerData ? '(player data present but no usable tracks)' : '(no player data yet)');
    }
    const src = best || vid.currentSrc || vid.src || '';
    if (!src || src.startsWith('blob:') || src.startsWith('data:')) return null;

    // Resolve any redirect FIRST. ETH sends dist.tobira.ethz.ch on to a
    // numbered node, and a browser sets Origin: null across that hop, which
    // stops matching the fixed Access-Control-Allow-Origin the server returns
    // — so the copy fails. Which node you are sent to varies, which is why
    // this appeared to fail at random. Loading the final address directly
    // keeps the origin intact.
    const finalSrc = await resolveMediaUrl(src);

    // Reuse the element between captures. Building it fresh meant re-fetching
    // the address, the headers and the index of the file every single time,
    // which is where the "sometimes instant, sometimes five seconds" came
    // from. Kept, it only has to seek.
    const reused = shotVideo && shotVideo.dataset.src === src && shotVideo.readyState >= 1;
    const clone = reused ? shotVideo : document.createElement('video');
    if (!reused) {
      if (shotVideo) { shotVideo.removeAttribute('src'); shotVideo.load(); shotVideo.remove(); }
      clone.crossOrigin = 'anonymous';
      // 'metadata', never 'auto': 'auto' tells the browser to fetch the whole
      // lecture in the background, and since this element is kept between
      // captures it never stops. Seeking pulls only the bytes it needs.
      clone.preload = 'metadata';
      clone.muted = true;
      clone.playsInline = true;
      clone.dataset.src = src;
      clone.dataset.ethCopilotDecoder = '1';
      // Kept out of the layout, and out of the tab screenshot if we fall back.
      clone.style.cssText = 'position:fixed;left:-99999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none';
    }

    const settled = (event, ms) => new Promise((resolve, reject) => {
      const done = () => { cleanup(); resolve(); };
      const fail = () => { cleanup(); reject(new Error(`${event} failed`)); };
      const timer = setTimeout(() => { cleanup(); reject(new Error(`${event} timed out`)); }, ms);
      function cleanup() {
        clearTimeout(timer);
        clone.removeEventListener(event, done);
        clone.removeEventListener('error', fail);
      }
      clone.addEventListener(event, done, { once: true });
      clone.addEventListener('error', fail, { once: true });
    });

    try {
      if (!reused) {
        document.body.appendChild(clone);
        clone.src = finalSrc;
        await settled('loadedmetadata', 8000);
      }
      clone.currentTime = vid.currentTime;
      await settled('seeked', 8000);

      const canvas = document.createElement('canvas');
      canvas.width = clone.videoWidth;
      canvas.height = clone.videoHeight;
      if (!canvas.width || !canvas.height) return null;
      canvas.getContext('2d').drawImage(clone, 0, 0, canvas.width, canvas.height);
      console.info(
        `[ETH Copilot] frame copied from the video: ${canvas.width}x${canvas.height}`,
        `(source ${finalSrc.split('/').pop()})`);
      return canvas.toDataURL('image/jpeg', 0.92).split(',')[1] || null;
    } catch (e) {
      nativeFrameFailure = e.message || String(e);
      return null;
    } finally {
      // Keep it around for the next frame; dropped when the lecture changes,
      // and by the browser when the page goes away.
      shotVideo = clone.isConnected ? clone : null;
    }
  }

  /** Drop everything remembered about the current lecture's video. */
  function forgetFrameCaptureState() {
    lastPlayerData = null;
    lastSentTimestamp = -1;
    if (shotVideo) {
      shotVideo.removeAttribute('src');
      shotVideo.load();
      shotVideo.remove();
      shotVideo = null;
    }
  }

  /** The reusable off-screen decoder from captureAtNativeResolution. */
  let shotVideo = null;

  /**
   * Hide the player's own controls for the moment of a screenshot.
   *
   * A tab screenshot captures whatever is on screen, so the play button,
   * scrubber and timestamps ended up baked into the attached frame — noise in
   * the picture and noise for a vision model reading the slide. Copying from
   * the video element would avoid this for free, but ETH's stream taints the
   * canvas, so the screenshot has to be tidied instead.
   *
   * Everything is restored in a finally block: a thrown capture must never
   * leave the user with an invisible seek bar.
   */
  async function withPlayerControlsHidden(vid, fn) {
    const player = vid.closest('[class*="player" i], [class*="paella" i]') || vid.parentElement || vid;
    const style = document.createElement('style');
    // Conservative selectors: control bars and buttons only. Deliberately not
    // matching "overlay", which on this player also covers slide content.
    style.textContent = `
      [data-eth-copilot-shot] [class*="control" i],
      [data-eth-copilot-shot] [class*="controlbar" i],
      [data-eth-copilot-shot] [class*="playbackbar" i],
      [data-eth-copilot-shot] [class*="progressbar" i],
      [data-eth-copilot-shot] [class*="toolbar" i],
      [data-eth-copilot-shot] [id*="control" i] { visibility: hidden !important; }
    `;
    const hadControls = vid.controls;
    let hidden = [];
    let prevStyle = null;
    try {
      player.setAttribute('data-eth-copilot-shot', '');
      document.head.appendChild(style);
      vid.controls = false;

      // A tab screenshot can only ever be as sharp as the player is on
      // screen, and with the sidebar open that is a few hundred pixels. Blow
      // the video up to fill the window for the instant of the shot: the crop
      // then comes back at roughly viewport size instead of thumbnail size.
      // Restored immediately afterwards, in the finally below.
      prevStyle = vid.getAttribute('style');
      vid.style.cssText = (prevStyle ? prevStyle + ';' : '') +
        'position:fixed!important;left:0!important;top:0!important;' +
        'width:100vw!important;height:100vh!important;max-width:none!important;' +
        'max-height:none!important;z-index:2147483646!important;' +
        'object-fit:contain!important;background:#000!important';
      // Nudge players that hide their own chrome when the pointer leaves.
      player.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
      player.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));

      // A paused player keeps its controls up on purpose, so no amount of
      // nudging will clear them. Hide anything that actually overlaps the
      // video instead — measured, not guessed from class names.
      hidden = overlappingElements(vid, player);
      for (const el of hidden) {
        el.dataset.ethCopilotPrevVis = el.style.visibility || '';
        el.style.visibility = 'hidden';
      }
      // Two frames plus a beat: enough for a fade-out to finish painting.
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 120))));
      return await fn();
    } finally {
      if (prevStyle === null) vid.removeAttribute('style');
      else vid.setAttribute('style', prevStyle);
      vid.controls = hadControls;
      for (const el of hidden) {
        el.style.visibility = el.dataset.ethCopilotPrevVis || '';
        delete el.dataset.ethCopilotPrevVis;
      }
      style.remove();
      player.removeAttribute('data-eth-copilot-shot');
    }
  }

  /**
   * Elements painted on top of the video, by geometry rather than by name.
   *
   * Class names differ per player and change without notice; overlap does not.
   * Anything covering less than 60% of the video is chrome (a control bar, a
   * button); anything larger is treated as content and left alone, so a slide
   * layer is never blanked out.
   */
  function overlappingElements(vid, player) {
    const v = vid.getBoundingClientRect();
    const area = v.width * v.height;
    if (!area) return [];
    const out = [];
    for (const el of player.querySelectorAll('*')) {
      if (el === vid || el.contains(vid)) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const ox = Math.max(0, Math.min(v.right, r.right) - Math.max(v.left, r.left));
      const oy = Math.max(0, Math.min(v.bottom, r.bottom) - Math.max(v.top, r.top));
      const overlap = ox * oy;
      if (overlap > 0 && overlap < area * 0.6) out.push(el);
    }
    return out;
  }

  /**
   * Crop a full-tab screenshot down to just the video player.
   *
   * Shared by both routes into a screenshot: the keyboard shortcut (which
   * carries activeTab) and the old broad-permission path.
   */
  async function cropTabShotToVideo(dataUrl) {
    let vid = videoEl;
    if (!vid || !vid.isConnected) {
      vid = document.querySelector(REAL_VIDEO);
      if (vid) videoEl = vid;
    }
    if (!vid || !dataUrl) return null;
    try {
      const rect = vid.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const cw = Math.round(rect.width * dpr);
      const ch = Math.round(rect.height * dpr);
      if (cw <= 0 || ch <= 0) return null;

      const img = await loadImage(dataUrl);
      const canvas = document.createElement('canvas');
      canvas.width = cw;
      canvas.height = ch;
      canvas.getContext('2d').drawImage(
        img, Math.round(rect.left * dpr), Math.round(rect.top * dpr), cw, ch, 0, 0, cw, ch);
      return canvas.toDataURL('image/jpeg', 0.85).split(',')[1] || null;
    } catch (e) {
      console.warn('[ETH Copilot] cropTabShotToVideo failed:', e.message);
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
    window.CopilotDebug?.log('content.forwardApiRequest.send', {
      requestId,
      payloadType: payload?.type,
      payload
    });
    chrome.runtime.sendMessage({ ...payload, _copilotRequestId: requestId }, response => {
      const err = chrome.runtime.lastError?.message;
      if (err) {
        console.error('[ETH Copilot] sendMessage error:', err);
        window.CopilotDebug?.error('content.forwardApiRequest.runtimeError', { requestId, error: err });
        postToSidebar({
          type: 'API_RESPONSE',
          requestId,
          response: { success: false, error: err }
        });
        return;
      }
      window.CopilotDebug?.log('content.forwardApiRequest.response', {
        requestId,
        payloadType: payload?.type,
        response
      });
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
