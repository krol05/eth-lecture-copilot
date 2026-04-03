/**
 * Opens from sidebar with guide HTML in localStorage (set by sidebar.js).
 * Triggers the browser print dialog (Save as PDF).
 */
(function () {
  'use strict';

  const KEY = 'eth-copilot-print-guide';

  function run() {
    const root = document.getElementById('print-root');
    const raw = localStorage.getItem(KEY);
    localStorage.removeItem(KEY);

    if (!raw) {
      root.innerHTML = '<p style="color:#d1242f">Nothing to export. Close this tab and try again from the sidebar.</p>';
      return;
    }

    let payload;
    try {
      payload = JSON.parse(raw);
    } catch (e) {
      root.innerHTML = '<p style="color:#d1242f">Invalid export data.</p>';
      return;
    }

    document.title = (payload.title || 'Lecture guide').slice(0, 120);

    root.innerHTML = '';

    const header = document.createElement('header');
    header.className = 'print-header';
    const h1 = document.createElement('h1');
    h1.textContent = payload.title || 'Lecture guide';
    header.appendChild(h1);
    if (payload.subtitle) {
      const meta = document.createElement('div');
      meta.className = 'print-meta';
      meta.textContent = payload.subtitle;
      header.appendChild(meta);
    }
    root.appendChild(header);

    const body = document.createElement('div');
    body.className = 'print-body';
    body.innerHTML = payload.bodyHtml || '';
    root.appendChild(body);

    const footer = document.createElement('footer');
    footer.className = 'print-footer';
    footer.textContent = 'ETH Lecture Copilot — guide export (KaTeX rendered)';
    root.appendChild(footer);

    requestAnimationFrame(() => {
      setTimeout(() => window.print(), 250);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }
})();
