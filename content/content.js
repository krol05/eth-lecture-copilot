/**
 * content.js — Main content script for video.ethz.ch
 *
 * Responsibilities:
 * 1. Detect ETH lecture video pages
 * 2. Extract transcript via background fetch
 * 3. Inject sidebar iframe
 * 4. Resize video container to make room for sidebar
 * 5. Poll video timestamp and send updates to sidebar
 * 6. Handle keyboard shortcuts (Arrow Up/Down for playback speed)
 * 7. Show speed overlay on speed change
 */

(function () {
  'use strict';

  // ─── State ──────────────────────────────────────────────────────────────────
  let sidebarIframe = null;
  let sidebarVisible = false;
  let videoEl = null;
  let timestampInterval = null;
  let lastBlockIndex = -1;
  let speedOverlayTimeout = null;

  const SIDEBAR_WIDTH = '380px';
  const SIDEBAR_WIDTH_FRAC = '380px';

  // ─── Entry Point ─────────────────────────────────────────────────────────────

  function init() {
    // Only activate on pages that have a video player
    if (!isLecturePage()) return;

    // Wait for the video element to appear (Paella loads dynamically)
    waitForVideo().then(video => {
      videoEl = video;
      injectSidebar();
      startTimestampSync();
      initKeyboardShortcuts();
      initiateTranscriptExtraction();
    });
  }

  function isLecturePage() {
    // Must be on a video page — URL contains /v/ or player is present
    return location.hostname === 'video.ethz.ch';
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

    // Create wrapper that holds video + sidebar side by side
    const wrapper = document.createElement('div');
    wrapper.id = 'eth-copilot-wrapper';
    wrapper.style.cssText = `
      display: flex;
      flex-direction: row;
      width: 100%;
      position: relative;
    `;

    // Find the player container
    const playerContainer = findPlayerContainer();
    if (!playerContainer) {
      console.warn('[ETH Copilot] Could not find player container');
      return;
    }

    const parent = playerContainer.parentElement;
    parent.insertBefore(wrapper, playerContainer);
    wrapper.appendChild(playerContainer);

    // Constrain the player
    playerContainer.style.flex = '1 1 auto';
    playerContainer.style.minWidth = '0';
    playerContainer.style.transition = 'all 0.3s ease';

    // Create sidebar iframe
    sidebarIframe = document.createElement('iframe');
    sidebarIframe.id = 'eth-copilot-sidebar';
    sidebarIframe.src = chrome.runtime.getURL('sidebar/sidebar.html');
    sidebarIframe.style.cssText = `
      width: ${SIDEBAR_WIDTH};
      min-width: ${SIDEBAR_WIDTH};
      flex: 0 0 ${SIDEBAR_WIDTH};
      height: 100%;
      border: none;
      border-left: 1px solid rgba(255,255,255,0.08);
      background: transparent;
      transition: all 0.3s ease;
    `;

    // Match iframe height to player
    updateSidebarHeight(playerContainer, sidebarIframe);
    const resizeObs = new ResizeObserver(() => updateSidebarHeight(playerContainer, sidebarIframe));
    resizeObs.observe(playerContainer);

    wrapper.appendChild(sidebarIframe);
    sidebarVisible = true;

    // Listen for messages from sidebar
    window.addEventListener('message', onSidebarMessage);

    // Send ready state once iframe loads
    sidebarIframe.addEventListener('load', () => {
      postToSidebar({ type: 'EXTENSION_READY' });
    });
  }

  function findPlayerContainer() {
    // Try known Tobira/Paella selectors
    const selectors = [
      '.player-container',
      '[class*="player-container"]',
      '[class*="PlayerContainer"]',
      '.css-usln0o',  // observed in ETH page HTML
      'section[aria-label*="player" i]',
      'section[aria-label*="video" i]'
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    // Fallback: container of the video element
    const v = document.querySelector('video');
    if (v) return v.closest('section, div[class*="player"], div[class*="video"]') || v.parentElement;
    return null;
  }

  function updateSidebarHeight(player, iframe) {
    const h = player.getBoundingClientRect().height;
    if (h > 0) {
      iframe.style.height = h + 'px';
      iframe.style.minHeight = h + 'px';
    } else {
      iframe.style.height = '600px';
    }
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
    postToSidebar({ type: 'TRANSCRIPT_STATUS', status: 'extracting' });

    const eventId = extractEventId();
    if (!eventId) {
      postToSidebar({ type: 'TRANSCRIPT_STATUS', status: 'no_event_id' });
      return;
    }

    // Fetch player data via background to get VTT URL
    chrome.runtime.sendMessage(
      { type: 'FETCH_JSON', url: `https://dist.tobira.ethz.ch/mh_default_org/engage-player/${eventId}/data.json` },
      response => {
        if (!response.success) {
          postToSidebar({ type: 'TRANSCRIPT_STATUS', status: 'error', error: response.error });
          return;
        }

        const vttUrl = findCaptionsUrl(response.data);
        if (!vttUrl) {
          postToSidebar({ type: 'TRANSCRIPT_STATUS', status: 'no_captions' });
          return;
        }

        chrome.runtime.sendMessage({ type: 'FETCH_VTT', url: vttUrl }, vttResp => {
          if (!vttResp.success) {
            postToSidebar({ type: 'TRANSCRIPT_STATUS', status: 'error', error: vttResp.error });
            return;
          }

          const cues = parseVtt(vttResp.data);
          const transcriptText = formatTranscript(cues);
          const lectureTitle = document.querySelector('h1')?.textContent?.trim() || 'Lecture';

          postToSidebar({
            type: 'TRANSCRIPT_READY',
            cues,
            transcriptText,
            lectureTitle,
            eventId,
            vttUrl,
            videoDuration: videoEl?.duration || 0
          });
        });
      }
    );
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
      sidebarIframe.contentWindow.postMessage(msg, chrome.runtime.getURL(''));
    } catch (_) {}
  }

  function onSidebarMessage(e) {
    if (e.source !== sidebarIframe?.contentWindow) return;
    const msg = e.data;
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
        // Forward AI API requests to background
        chrome.runtime.sendMessage(msg.payload, response => {
          postToSidebar({ type: 'API_RESPONSE', requestId: msg.requestId, response });
        });
        break;

      case 'GET_SETTINGS':
        chrome.storage.local.get(['provider', 'model', 'apiKey'], settings => {
          postToSidebar({ type: 'SETTINGS', settings });
        });
        break;
    }
  }

  // ─── Frame Capture ───────────────────────────────────────────────────────────

  function captureVideoFrame() {
    return new Promise(resolve => {
      if (!videoEl) return resolve(null);
      try {
        const canvas = document.createElement('canvas');
        canvas.width = videoEl.videoWidth || 1280;
        canvas.height = videoEl.videoHeight || 720;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
        const b64 = canvas.toDataURL('image/jpeg', 0.85).split(',')[1];
        resolve(b64);
      } catch (e) {
        console.warn('[ETH Copilot] Frame capture failed:', e.message);
        resolve(null);
      }
    });
  }

  // ─── Bootstrap ───────────────────────────────────────────────────────────────

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
