/**
 * sidebar/generation-bar.js
 * Shows every generation that is currently running and lets the user stop any
 * of them. Fed from the sidebar's central request tracker, so anything that
 * talks to a provider — guide, chat, summary, flashcards, quiz, exam — is
 * stoppable, including generators that have no Stop button of their own.
 *
 * Usage:  GenerationBar.render([{ id, label }], id => abort(id))
 * Passing an empty list hides the bar.
 */
(function (root) {
  let el = null;
  let onStop = () => {};

  function build() {
    el = document.createElement('div');
    el.className = 'cop-gen-bar cop-gen-hidden';
    document.body.appendChild(el);
    el.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-stop-id]');
      if (!btn) return;
      const id = btn.getAttribute('data-stop-id');
      btn.disabled = true;
      btn.textContent = 'Stopping…';
      onStop(id);
    });
  }

  function row(item) {
    const line = document.createElement('div');
    line.className = 'cop-gen-row';

    const spinner = document.createElement('span');
    spinner.className = 'cop-gen-spinner';
    spinner.setAttribute('aria-hidden', 'true');

    const label = document.createElement('span');
    label.className = 'cop-gen-label';
    label.textContent = `${item.label}…`;

    const stop = document.createElement('button');
    stop.className = 'cop-gen-stop';
    stop.type = 'button';
    stop.textContent = 'Stop';
    stop.title = `Stop ${item.label}`;
    stop.setAttribute('data-stop-id', item.id);

    line.append(spinner, label, stop);
    return line;
  }

  function render(items, stopHandler) {
    if (!el) build();
    if (typeof stopHandler === 'function') onStop = stopHandler;

    if (!items || !items.length) {
      el.classList.add('cop-gen-hidden');
      el.replaceChildren();
      setBarHeight(0);
      return;
    }
    el.replaceChildren(...items.map(row));
    el.classList.remove('cop-gen-hidden');
    // The error panel is anchored to the same corner — publish our height so
    // it can sit above us instead of on top of us.
    setBarHeight(el.offsetHeight);
  }

  function setBarHeight(px) {
    document.body.classList.toggle('cop-generating', px > 0);
    document.body.style.setProperty('--cop-gen-height', `${px}px`);
  }

  if (root) root.GenerationBar = { render };
})(typeof self !== 'undefined' ? self : this);
