/**
 * sidebar/generation-bar.js
 * Shows what is currently generating and lets the user stop any of it. Fed
 * from the sidebar's central request tracker, so everything that talks to a
 * provider is stoppable — including generators with no Stop button of their own.
 *
 * Two states:
 *   expanded  one row per generation, each with its own Stop
 *   collapsed a single compact chip showing the count
 * The state is remembered, and a single click switches between them.
 *
 * Usage:  GenerationBar.render([{ id, label }], id => abort(id))
 * An empty list hides it entirely.
 */
(function (root) {
  const COLLAPSED_KEY = 'eth-copilot-genbar-collapsed';

  let el = null;
  let listEl = null;
  let chipEl = null;
  let onStop = () => {};
  let collapsed = false;
  let items = [];

  function readCollapsed() {
    try { return localStorage.getItem(COLLAPSED_KEY) === '1'; } catch { return false; }
  }

  function writeCollapsed(v) {
    try { localStorage.setItem(COLLAPSED_KEY, v ? '1' : '0'); } catch { /* private mode */ }
  }

  function spinner() {
    const s = document.createElement('span');
    s.className = 'cop-gen-spinner';
    s.setAttribute('aria-hidden', 'true');
    return s;
  }

  function build() {
    collapsed = readCollapsed();

    el = document.createElement('div');
    el.className = 'cop-gen cop-gen-hidden';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');

    // Collapsed form: one small chip, click to expand
    chipEl = document.createElement('button');
    chipEl.className = 'cop-gen-chip';
    chipEl.type = 'button';
    chipEl.addEventListener('click', () => setCollapsed(false));

    listEl = document.createElement('div');
    listEl.className = 'cop-gen-panel';

    el.append(chipEl, listEl);
    document.body.appendChild(el);

    el.addEventListener('click', (ev) => {
      if (ev.target.closest('.cop-gen-collapse')) { setCollapsed(true); return; }
      const btn = ev.target.closest('[data-stop-id]');
      if (!btn) return;
      btn.disabled = true;
      btn.textContent = 'Stopping';
      onStop(btn.getAttribute('data-stop-id'));
    });
  }

  function setCollapsed(v) {
    collapsed = v;
    writeCollapsed(v);
    paint();
  }

  function row(item) {
    const line = document.createElement('div');
    line.className = 'cop-gen-row';

    const label = document.createElement('span');
    label.className = 'cop-gen-label';
    label.textContent = item.label;

    const stop = document.createElement('button');
    stop.className = 'cop-gen-stop';
    stop.type = 'button';
    stop.textContent = 'Stop';
    stop.title = `Stop ${item.label}`;
    stop.setAttribute('data-stop-id', item.id);

    line.append(spinner(), label, stop);
    return line;
  }

  function paint() {
    if (!items.length) {
      el.classList.add('cop-gen-hidden');
      listEl.replaceChildren();
      chipEl.replaceChildren();
      publishHeight(0);
      return;
    }

    const n = items.length;
    el.classList.toggle('cop-gen-is-collapsed', collapsed);

    if (collapsed) {
      chipEl.replaceChildren(spinner(), Object.assign(document.createElement('span'), {
        textContent: n === 1 ? items[0].label : `${n} generating`
      }));
      chipEl.title = 'Show what is running';
      listEl.replaceChildren();
    } else {
      chipEl.replaceChildren();
      const header = document.createElement('div');
      header.className = 'cop-gen-head';
      const title = document.createElement('span');
      title.className = 'cop-gen-title';
      title.textContent = n === 1 ? 'Generating' : `Generating (${n})`;
      const collapse = document.createElement('button');
      collapse.className = 'cop-gen-collapse';
      collapse.type = 'button';
      collapse.textContent = '–';
      collapse.title = 'Collapse';
      header.append(title, collapse);
      listEl.replaceChildren(header, ...items.map(row));
    }

    el.classList.remove('cop-gen-hidden');
    publishHeight(el.offsetHeight);
  }

  /** The error panel shares this corner — tell it how much room we take. */
  function publishHeight(px) {
    document.body.classList.toggle('cop-generating', px > 0);
    document.body.style.setProperty('--cop-gen-height', `${px}px`);
  }

  function render(list, stopHandler) {
    if (!el) build();
    if (typeof stopHandler === 'function') onStop = stopHandler;
    items = Array.isArray(list) ? list : [];
    paint();
  }

  if (root) root.GenerationBar = { render };
})(typeof self !== 'undefined' ? self : this);
