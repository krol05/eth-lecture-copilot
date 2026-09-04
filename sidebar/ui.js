/**
 * sidebar/ui.js — Tabs, theme, status bar, and small shared UI utilities.
 *
 * Part of the sidebar, loaded as a plain script in the order listed in
 * sidebar.html. All sidebar modules share one global scope on purpose:
 * it is what lets each file be a straight move out of the old sidebar.js.
 */

// ─── Tab Switching ────────────────────────────────────────────────────────

let _currentTab = 'guide';

function switchTab(tabName) {
  if (tabName !== _currentTab) {
    closeToolAskPanel();
  }
  _currentTab = tabName;
  if (tabName === 'qa') {
    hideCrossTabNotify();
  } else {
    hideQaReplyReadyToast();
    const btn = document.getElementById('qa-scroll-bottom-btn');
    if (btn) btn.hidden = true;
  }
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tabName));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('active', c.id === `tab-${tabName}`));
  const toolsHintBar = document.getElementById('tools-hint-bar');
  if (toolsHintBar) toolsHintBar.hidden = tabName !== 'tools';
  if (tabName === 'history') loadHistory();
}

// ─── Cross-tab QA notification ────────────────────────────────────────────
// Shows when user is on Guide/History and a QA reply arrives.

let _crossTabNotifyTarget = null;
const _crossTabNotify      = () => document.getElementById('cross-tab-notify');
const _crossTabNotifyClose = () => document.getElementById('cross-tab-notify-close');
const _crossTabNotifyBtn   = () => document.getElementById('cross-tab-notify-action');

function showCrossTabNotify(targetDiv) {
  _crossTabNotifyTarget = targetDiv;
  const el = _crossTabNotify();
  if (!el) return;
  el.hidden = false;
}

function hideCrossTabNotify() {
  _crossTabNotifyTarget = null;
  const el = _crossTabNotify();
  if (el) el.hidden = true;
}

// ─── QA Scroll-to-bottom button ───────────────────────────────────────────

function initQaScrollButton() {
  const btn = document.getElementById('qa-scroll-bottom-btn');
  if (!btn) return;
  // Per-column scroll listeners are attached in initQaChatCols; they call updateQaScrollBtn().
  // Just wire the click handler here.
  btn.addEventListener('click', () => {
    qaScrollToBottom();
    btn.hidden = true;
  });
  updateQaScrollBtn();
}

// ─── Theme ────────────────────────────────────────────────────────────────

const THEMES = ['dark', 'light', 'dark-blue', 'light-white'];
const THEME_LABELS = { dark: 'Warm Dark', light: 'Cream Light', 'dark-blue': 'Navy Blue', 'light-white': 'Clean White' };

function toggleTheme() {
  const html = document.documentElement;
  const current = html.dataset.theme || 'dark';
  const idx = THEMES.indexOf(current);
  const next = THEMES[(idx + 1) % THEMES.length];
  html.dataset.theme = next;
  localStorage.setItem('eth-copilot-theme', next);
  updateThemeToggleTooltip(next);
  applyUISettings();
}

function updateThemeToggleTooltip(theme) {
  if (!themeToggle) return;
  const next = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
  themeToggle.title = `Theme: ${THEME_LABELS[theme] || theme} → click for ${THEME_LABELS[next] || next}`;
}

function applyStoredTheme() {
  const saved = localStorage.getItem('eth-copilot-theme');
  if (saved) {
    document.documentElement.dataset.theme = saved;
    updateThemeToggleTooltip(saved);
  }
}

async function applyUISettings() {
  if (!window.UISettings) return;
  const ui = await UISettings.load();
  UISettings.applyColorsToDocument(document, ui);
  UISettings.applySidebarTextSizes(document, ui);
}

// ─── Status Bar ───────────────────────────────────────────────────────────

function setStatus(type, text) {
  statusBar.classList.remove('status-dismissed');
  statusBar.className = `status-bar status-${type}`;
  statusText.textContent = text;
  const spinner = statusBar.querySelector('.status-spinner');
  if (spinner) spinner.style.display = type === 'loading' ? 'block' : 'none';
  if (statusDismiss) {
    statusDismiss.hidden = type !== 'error' && type !== 'warning';
  }
}

function dismissStatus() {
  statusBar.classList.add('status-dismissed');
  if (statusDismiss) statusDismiss.hidden = true;
}

// ─── Utilities ────────────────────────────────────────────────────────────

// escHtml lives in lib/render-inline.js

function escAttr(str) {
  return String(str || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function unescapeMathDelimiters(str) {
  return String(str || '').replace(/\\\$/g, '$');
}

function normalizeLatexForKatex(str) {
  // ── Step 0: Convert \[..\] and \(..\) to the dollar forms ────────────────
  // Configuring KaTeX to accept these delimiters is not enough on its own:
  // it only matches a pair inside ONE text node, and markdown puts the
  // opening \[, the formula and the closing \] in separate nodes — which is
  // why they reached the reader as raw source. Rewriting them here, before
  // markdown runs, funnels them through the same collapsing that already
  // makes multi-line $$ work.
  str = String(str || '')
    .replace(/\\\[[ \t]*\n?([\s\S]*?)\n?[ \t]*\\\]/g, (_m, inner) => '$$' + inner.trim() + '$$')
    .replace(/\\\(([\s\S]*?)\\\)/g, (_m, inner) => '$' + inner.trim() + '$');

  // ── Step 1: Collapse multi-line display math ──────────────────────────────
  // AI often outputs:   $$\n<math>\n$$   (opening/closing $$ on their own line)
  // Our renderMarkdown splits on newlines → the opening $$ and content end up
  // in separate <p> elements → KaTeX never finds the delimiters.
  // Fix: if $$ appears alone on a line, merge the whole block to one span.
  str = str.replace(/\$\$[ \t]*\n([\s\S]*?)\n[ \t]*\$\$/g, (_m, inner) =>
    '$$' + inner + '$$'
  );
  // ── Step 2: \sideset transformation ──────────────────────────────────────
  return str.replace(
    /\\sideset\s*\{([^{}]*)\}\s*\{([^{}]*)\}\s*([\\a-zA-Z]+|\{[^{}]+\})/g,
    (_m, left, right, op) => {
      const l = parseScriptSpec(left);
      const r = parseScriptSpec(right);
      const leftPart = `${l.sub || ''}${l.sup || ''}` ? `{}` + (l.sub || '') + (l.sup || '') + '\\!' : '';
      const rightPart = (r.sub || '') + (r.sup || '');
      return `${leftPart}${op}${rightPart}`;
    }
  );
}

function parseScriptSpec(spec) {
  const out = { sub: '', sup: '' };
  const s = String(spec || '').trim();
  const re = /([_^])(\{[^{}]*\}|[^_^{}\s]+)/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const kind = m[1];
    const raw = m[2];
    const wrapped = raw.startsWith('{') ? raw : `{${raw}}`;
    if (kind === '_') out.sub = `_${wrapped}`;
    if (kind === '^') out.sup = `^${wrapped}`;
  }
  return out;
}

function fmtSec(s) {
  s = Math.floor(s || 0);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
}
// ─── Feature button loading state helper ──────────────────────────────────

function setFeatureBtnLoading(btn, loading) {
  if (!btn) return;
  const text = btn.querySelector('.btn-text');
  const spinner = btn.querySelector('.btn-spinner');
  btn.disabled = loading;
  if (spinner) spinner.style.display = loading ? 'inline-block' : 'none';
  if (text) text.style.opacity = loading ? '0.5' : '1';
}
