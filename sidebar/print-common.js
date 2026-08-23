/**
 * Shared logic for the print/export pages (guide + summary).
 * Each page passes its localStorage handoff key and labels; the payload
 * is written by sidebar.js just before window.open().
 */
(function (root) {
  'use strict';

  function runPrintPage({ key, defaultTitle, bodyClass = '', footerText }) {
    function run() {
      const rootEl = document.getElementById('print-root');
      const raw = localStorage.getItem(key);
      localStorage.removeItem(key);

      if (!raw) {
        rootEl.innerHTML = '<p style="color:#d1242f">Nothing to export. Close this tab and try again from the sidebar.</p>';
        return;
      }

      let payload;
      try {
        payload = JSON.parse(raw);
      } catch (e) {
        rootEl.innerHTML = '<p style="color:#d1242f">Invalid export data.</p>';
        return;
      }

      document.title = (payload.title || defaultTitle).slice(0, 120);

      rootEl.innerHTML = '';

      const header = document.createElement('header');
      header.className = 'print-header';
      const h1 = document.createElement('h1');
      h1.textContent = payload.title || defaultTitle;
      header.appendChild(h1);
      if (payload.subtitle) {
        const meta = document.createElement('div');
        meta.className = 'print-meta';
        meta.textContent = payload.subtitle;
        header.appendChild(meta);
      }
      rootEl.appendChild(header);

      const body = document.createElement('div');
      body.className = ('print-body ' + bodyClass).trim();
      body.innerHTML = payload.bodyHtml || '';
      rootEl.appendChild(body);

      const footer = document.createElement('footer');
      footer.className = 'print-footer';
      footer.textContent = footerText;
      rootEl.appendChild(footer);

      requestAnimationFrame(() => {
        setTimeout(() => window.print(), 250);
      });
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', run);
    } else {
      run();
    }
  }

  root.runPrintPage = runPrintPage;
})(typeof window !== 'undefined' ? window : globalThis);
