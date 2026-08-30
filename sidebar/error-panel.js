/**
 * sidebar/error-panel.js
 * Error notification panel: pops up on any API/generation failure, shows the
 * FULL structured error readably (via lib/error-format.js), can be minimized
 * to a badge, and keeps a persisted history the user can clear or keep.
 *
 * Usage from sidebar code:  ErrorPanel.report(errorDetail)
 * errorDetail = { status, provider, model, code, message, raw, timestamp }
 * (the background's errorDetail; a bare string is tolerated and wrapped).
 *
 * History lives in chrome.storage.local.errorHistory (newest first, capped).
 */
(function (root) {
  const HISTORY_KEY = 'errorHistory';
  const HISTORY_CAP = 50;

  let els = null;        // lazily-built DOM refs
  let sessionCount = 0;  // errors this session, shown on the badge

  function storageGet(key) {
    return new Promise(resolve => {
      try {
        chrome.storage.local.get([key], r => resolve(r?.[key]));
      } catch { resolve(undefined); }
    });
  }

  function storageSet(obj) {
    return new Promise(resolve => {
      try { chrome.storage.local.set(obj, () => resolve()); } catch { resolve(); }
    });
  }

  function normalizeDetail(detail) {
    if (detail && typeof detail === 'object') return detail;
    return { status: null, provider: null, model: null, code: null, message: String(detail || 'Unknown error'), raw: null, timestamp: Date.now() };
  }

  async function appendHistory(detail) {
    const history = (await storageGet(HISTORY_KEY)) || [];
    history.unshift(detail);
    await storageSet({ [HISTORY_KEY]: history.slice(0, HISTORY_CAP) });
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function fmtTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function buildDom() {
    const panel = el('div', 'cop-err-panel cop-err-hidden');
    const header = el('div', 'cop-err-header');
    const title = el('div', 'cop-err-title');
    const btnMin = el('button', 'cop-err-btn', '–');
    btnMin.title = 'Minimize';
    const btnClose = el('button', 'cop-err-btn', '×');
    btnClose.title = 'Dismiss';
    header.append(title, btnMin, btnClose);

    const bodyEl = el('div', 'cop-err-body');
    const summary = el('div', 'cop-err-summary');
    const hint = el('div', 'cop-err-hint');
    // Some failures are fixable right here. The only one so far is a missing
    // host grant, which Chrome will only prompt for from a click like this.
    const fix = el('button', 'cop-err-fix cop-err-hidden');
    const details = el('div', 'cop-err-details');
    bodyEl.append(summary, hint, fix, details);

    const footer = el('div', 'cop-err-footer');
    const btnHistory = el('button', 'cop-err-link', 'History');
    const btnClear = el('button', 'cop-err-link', 'Clear all');
    footer.append(btnHistory, btnClear);

    const historyList = el('div', 'cop-err-history cop-err-hidden');

    panel.append(header, bodyEl, historyList, footer);

    const badge = el('button', 'cop-err-badge cop-err-hidden');
    badge.title = 'Show last error';

    document.body.append(panel, badge);

    btnMin.addEventListener('click', () => { panel.classList.add('cop-err-hidden'); showBadge(); });
    badge.addEventListener('click', () => { badge.classList.add('cop-err-hidden'); panel.classList.remove('cop-err-hidden'); });
    btnClose.addEventListener('click', () => { panel.classList.add('cop-err-hidden'); badge.classList.add('cop-err-hidden'); });
    btnClear.addEventListener('click', async () => {
      await storageSet({ [HISTORY_KEY]: [] });
      historyList.replaceChildren(el('div', 'cop-err-empty', 'History cleared.'));
      updateHistoryLabel(0);
    });
    btnHistory.addEventListener('click', async () => {
      const showing = !historyList.classList.contains('cop-err-hidden');
      if (showing) { historyList.classList.add('cop-err-hidden'); return; }
      await renderHistory();
      historyList.classList.remove('cop-err-hidden');
    });

    els = { panel, title, summary, hint, fix, details, badge, historyList, btnHistory };
  }

  function updateHistoryLabel(n) {
    els.btnHistory.textContent = n > 0 ? `History (${n})` : 'History';
  }

  function showBadge() {
    els.badge.textContent = sessionCount > 1 ? `⚠ ${sessionCount}` : '⚠';
    els.badge.classList.remove('cop-err-hidden');
  }

  function renderSections(container, formatted) {
    container.replaceChildren();
    for (const section of formatted.sections) {
      const d = el('details', 'cop-err-section');
      d.append(el('summary', null, section.label));
      const pre = el('pre', 'cop-err-pre', section.content);
      d.append(pre);
      container.append(d);
    }
  }

  async function renderHistory() {
    const history = (await storageGet(HISTORY_KEY)) || [];
    updateHistoryLabel(history.length);
    els.historyList.replaceChildren();
    if (!history.length) {
      els.historyList.append(el('div', 'cop-err-empty', 'No errors recorded.'));
      return;
    }
    for (const detail of history) {
      const formatted = formatError(detail);
      const d = el('details', 'cop-err-section');
      const s = el('summary');
      s.append(
        el('span', 'cop-err-hist-time', fmtTime(formatted.timestamp)),
        el('span', null, ` ${formatted.title}`)
      );
      d.append(s);
      const inner = el('div');
      inner.append(el('div', 'cop-err-summary', formatted.summary));
      renderSectionsInto(inner, formatted);
      d.append(inner);
      els.historyList.append(d);
    }
  }

  function renderSectionsInto(container, formatted) {
    for (const section of formatted.sections) {
      const d = el('details', 'cop-err-section cop-err-nested');
      d.append(el('summary', null, section.label));
      d.append(el('pre', 'cop-err-pre', section.content));
      container.append(d);
    }
  }

  /** Show an error in the panel and record it in history. */
  function report(detail) {
    const normalized = normalizeDetail(detail);
    if (!normalized.timestamp) normalized.timestamp = Date.now();
    if (!els) buildDom();
    sessionCount += 1;

    const formatted = formatError(normalized);
    els.title.textContent = formatted.title;
    els.summary.textContent = formatted.summary;
    els.hint.textContent = formatted.hint;
    els.hint.classList.toggle('cop-err-hidden', !formatted.hint);
    renderFixAction(normalized);
    renderSections(els.details, formatted);

    els.historyList.classList.add('cop-err-hidden');
    els.badge.classList.add('cop-err-hidden');
    els.panel.classList.remove('cop-err-hidden');

    appendHistory(normalized).then(async () => {
      const history = (await storageGet(HISTORY_KEY)) || [];
      updateHistoryLabel(history.length);
    });
  }

  /**
   * Offer a one-click fix where one exists.
   *
   * Only case today: the extension has never been granted the provider's host.
   * The prompt must come from this click — a service worker cannot ask, which
   * is why the failure reached the user as an error in the first place.
   */
  function renderFixAction(detail) {
    const origin = detail.code === 'permission_missing' && detail.raw && detail.raw.origin;
    els.fix.classList.toggle('cop-err-hidden', !origin);
    if (!origin) return;

    const host = detail.raw.host || origin;
    els.fix.textContent = `Allow ${host}`;
    els.fix.disabled = false;
    els.fix.onclick = () => {
      els.fix.disabled = true;
      els.fix.textContent = 'Waiting for Chrome…';
      // No await before the call: the gesture stops counting once we yield.
      self.requestPermission(origin).then(({ granted, reason }) => {
        if (granted) {
          els.fix.textContent = `${host} allowed — try again`;
          els.title.textContent = 'Access granted';
          els.summary.textContent = `The extension may now contact ${host}. Run that request again.`;
          els.hint.classList.add('cop-err-hidden');
          return;
        }
        els.fix.disabled = false;
        els.fix.textContent = `Allow ${host}`;
        els.hint.classList.remove('cop-err-hidden');
        els.hint.textContent = reason === 'denied'
          ? `Access to ${host} was declined, so this provider cannot be reached. Click again to reconsider, or pick a different provider.`
          : `Chrome would not show the prompt from here. Open the extension popup and select this provider again to grant ${host}.`;
      });
    };
  }

  if (root) root.ErrorPanel = { report };
})(typeof self !== 'undefined' ? self : this);
