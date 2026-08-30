/**
 * popup.js — reads the provider catalog from lib/providers/catalog.js
 * (loaded before this). Every provider offers its static model list plus a
 * "Custom model…" free-text option — lists are conveniences, never gates.
 */

const providerSelect  = document.getElementById('provider-select');
const onboardingNote  = document.getElementById('onboarding-note');
const onboardingDismiss = document.getElementById('onboarding-dismiss');
const modelSelect       = document.getElementById('model-select');
const modelCustom       = document.getElementById('model-custom');
const modelCustomInline = document.getElementById('model-custom-inline');
const providerNote    = document.getElementById('provider-note');
const apiKeyGroup     = document.getElementById('apikey-group');
const apiKeyInput     = document.getElementById('api-key-input');
const apiKeyLink      = document.getElementById('api-key-link');
const toggleKeyBtn    = document.getElementById('toggle-key');
const eyeOpen         = document.getElementById('eye-open');
const eyeClosed       = document.getElementById('eye-closed');
const localBaseGroup  = document.getElementById('local-base-group');
const localBaseInput  = document.getElementById('local-base-input');
const localNote       = document.getElementById('local-note');
const detectBtn       = document.getElementById('detect-btn');
const refreshBtn      = document.getElementById('refresh-models-btn');
const detectError     = document.getElementById('detect-error');
const saveBtn         = document.getElementById('save-btn');
const statusMsg       = document.getElementById('status-msg');
const statusDot       = document.getElementById('status-dot');
const statusLabel     = document.getElementById('status-label');
const uiSettingsBtn   = document.getElementById('ui-settings-btn');

// User customizations (M3): overrides + custom providers, loaded once at init.
let providerStore = {};
// Live model lists (M4): modelCache[providerId] = { models, fetchedAt }
let modelCache = {};

function init() {
  // Set version in footer
  try {
    const v = chrome.runtime.getManifest().version;
    const vEl = document.getElementById('footer-version');
    if (vEl && v) vEl.textContent = `Lecture Copilot v${v}`;
  } catch (_) {}

  // Load saved settings + provider customizations, then build the UI
  chrome.storage.local.get(
    ['provider', 'model', 'apiKey', 'localBases', 'onboardingSeen', 'providerOverrides', 'customProviders', 'modelCache'],
    saved => {
    providerStore = { providerOverrides: saved.providerOverrides, customProviders: saved.customProviders };
    modelCache = saved.modelCache || {};

    // Provider dropdown — cloud / custom / local optgroups
    const cloudGroup = document.createElement('optgroup');
    cloudGroup.label = 'Cloud';
    const customGroup = document.createElement('optgroup');
    customGroup.label = '✳ Custom';
    const localGroup = document.createElement('optgroup');
    localGroup.label = '⚡ Local';

    listResolvedProviders(providerStore).forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.label;
      const group = p.kind === 'local' ? localGroup : p.kind === 'custom' ? customGroup : cloudGroup;
      group.appendChild(opt);
    });

    providerSelect.appendChild(cloudGroup);
    if (customGroup.children.length) providerSelect.appendChild(customGroup);
    providerSelect.appendChild(localGroup);

    const provider = saved.provider || Catalog.list()[0].id;
    providerSelect.value = provider;
    const cfg = getConfig(provider);
    const savedBase = saved.localBases?.[provider] || (cfg?.kind === 'local' ? cfg.base : '') || '';
    if (savedBase) localBaseInput.value = savedBase;
    renderProviderUI(provider);
    populateModels(provider, saved.model);
    if (saved.apiKey) apiKeyInput.value = saved.apiKey;
    // Silent freshness check on open — background serves from cache under 24h
    if (saved.apiKey) refreshModels(false);
    const hasLocalBase = cfg?.kind === 'local' && !!savedBase;
    updateStatus(!!saved.apiKey || hasLocalBase);
    onboardingNote.style.display = saved.onboardingSeen ? 'none' : 'flex';
  });

  onboardingDismiss.addEventListener('click', () => {
    onboardingNote.style.display = 'none';
    chrome.storage.local.set({ onboardingSeen: true });
  });

  providerSelect.addEventListener('change', () => {
    const p = providerSelect.value;
    const cfg = getConfig(p);
    // Choosing a provider is a click, which is the only moment Chrome lets us
    // ask for its host. Doing it here means the sidebar rarely has to.
    askForProviderHost(p, cfg);
    // Restore saved base URL for this provider, or default
    chrome.storage.local.get(['localBases'], saved => {
      localBaseInput.value = saved.localBases?.[p] || (cfg?.kind === 'local' ? cfg.base : '') || '';
      renderProviderUI(p);
      populateModels(p);
    });
  });

  modelSelect.addEventListener('change', () => {
    const isCustom = modelSelect.value === '__custom__';
    modelCustomInline.style.display = isCustom ? 'block' : 'none';
    if (isCustom) modelCustomInline.focus();
  });

  localBaseInput.addEventListener('input', () => {
    // Clear detected models when URL changes
    if (modelSelect.dataset.detected === 'true') {
      modelSelect.innerHTML = '<option value="">— click Detect Models —</option>';
      modelSelect.dataset.detected = 'false';
    }
    detectError.style.display = 'none';
  });

  detectBtn.addEventListener('click', detectModels);
  refreshBtn.addEventListener('click', () => refreshModels(true));

  toggleKeyBtn.addEventListener('click', () => {
    const show = apiKeyInput.type === 'password';
    apiKeyInput.type = show ? 'text' : 'password';
    eyeOpen.style.display   = show ? 'none'  : 'block';
    eyeClosed.style.display = show ? 'block' : 'none';
  });

  saveBtn.addEventListener('click', save);

  uiSettingsBtn?.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  document.documentElement.dataset.theme =
    localStorage.getItem('eth-copilot-theme') || 'dark';
  applyUISettings();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[UISettings.STORAGE_KEY]) {
      applyUISettings();
    }
  });
}

// ─── Provider UI rendering ────────────────────────────────────────────────────

function renderProviderUI(providerId) {
  const cfg = getConfig(providerId);
  const isLocal = cfg?.kind === 'local';

  // Show/hide sections
  localBaseGroup.style.display = isLocal ? 'block' : 'none';
  apiKeyGroup.style.display    = isLocal ? 'none'  : 'block';
  detectBtn.style.display      = isLocal ? 'inline-flex' : 'none';
  providerNote.textContent = '';
  providerNote.style.display = 'none';
  localNote.textContent = '';
  localNote.style.display = 'none';
  detectError.textContent = '';
  detectError.style.display = 'none';

  if (isLocal) {
    localNote.textContent = cfg.note || '';
    localNote.style.display = cfg.note ? 'block' : 'none';
  }

  // Live model refresh — cloud providers with a /models endpoint
  refreshBtn.style.display = (!isLocal && !cfg?.quirks?.noModelsEndpoint) ? 'inline-flex' : 'none';

  // Cloud provider meta
  if (!isLocal) {
    apiKeyLink.href = cfg?.keyLink || '#';
    apiKeyInput.placeholder = cfg?.keyHint ? `e.g. ${cfg.keyHint}` : 'Paste your API key…';
    if (cfg?.note) {
      providerNote.textContent = cfg.note;
      providerNote.style.display = 'block';
    } else {
      providerNote.style.display = 'none';
    }
  }
}

// ─── Model population ─────────────────────────────────────────────────────────

/** Overrides > live cache > built-in list, merged additively (never subtract). */
function mergedModels(providerId, cfg) {
  const merged = [...cfg.models];
  const seen = new Set(merged.map(m => m.id));
  for (const m of (modelCache[providerId]?.models || [])) {
    if (!seen.has(m.id)) { seen.add(m.id); merged.push(m); }
  }
  return merged;
}

function populateModels(providerId, selectedModel) {
  const cfg = getConfig(providerId);
  if (!cfg) return;

  modelSelect.style.display = 'block';
  modelCustom.style.display = 'none';

  if (cfg.kind === 'local' && cfg.models.length === 0) {
    // No models yet — show placeholder
    modelSelect.innerHTML = '<option value="">— click Detect Models —</option>';
    modelSelect.dataset.detected = 'false';
    modelCustomInline.style.display = 'none';
    return;
  }

  const models = mergedModels(providerId, cfg);

  // If saved model isn't in the list, select the custom option
  const modelInList = models.some(m => m.id === selectedModel);
  const isCustom = !!(selectedModel && !modelInList);

  modelSelect.innerHTML = models
    .map(m => `<option value="${m.id}"${m.id === selectedModel ? ' selected' : ''}>${m.label || m.id}</option>`)
    .join('') + '<option value="__custom__"' + (isCustom ? ' selected' : '') + '>Custom model…</option>';

  if (!selectedModel && models[0]) modelSelect.value = models[0].id;
  modelSelect.dataset.detected = 'false';

  modelCustomInline.style.display = isCustom ? 'block' : 'none';
  if (isCustom) modelCustomInline.value = selectedModel;
}

// ─── Local model detection ────────────────────────────────────────────────────

async function detectModels() {
  const base = localBaseInput.value.trim();
  if (!base) { showDetectError('Enter a server URL first.'); return; }

  detectBtn.disabled = true;
  detectBtn.textContent = 'Detecting…';
  detectError.style.display = 'none';

  try {
    const response = await new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: 'DISCOVER_LOCAL_MODELS', localBase: base },
        resolve
      );
    });

    if (!response?.success) throw new Error(response?.error || 'Discovery failed');

    const modelIds = response.data;
    if (!modelIds.length) throw new Error('Server returned no models');

    // Populate dropdown with discovered models
    modelSelect.innerHTML = modelIds
      .map(id => `<option value="${id}">${id}</option>`)
      .join('');
    modelSelect.style.display = 'block';
    modelCustom.style.display = 'none';
    modelSelect.dataset.detected = 'true';
    flash('success', `Found ${modelIds.length} model${modelIds.length !== 1 ? 's' : ''}`);

  } catch (err) {
    showDetectError(`Could not reach server: ${err.message}`);
  } finally {
    detectBtn.disabled = false;
    detectBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
    </svg> Detect`;
  }
}

// ─── Live model refresh for cloud providers (M4) ─────────────────────────────

async function refreshModels(force) {
  const provider = providerSelect.value;
  const cfg = getConfig(provider);
  if (!cfg || cfg.kind === 'local' || cfg.quirks?.noModelsEndpoint) return;
  const apiKey = apiKeyInput.value.trim();
  if (!apiKey && !cfg.noAuth) {
    if (force) showDetectError('Enter your API key first — the model list comes from the provider.');
    return;
  }

  if (force) { refreshBtn.disabled = true; }
  try {
    const response = await new Promise(resolve => {
      chrome.runtime.sendMessage({ type: 'LIST_MODELS', provider, apiKey, force: !!force }, resolve);
    });
    if (!response?.success) throw new Error(response?.error || 'Model list failed');
    modelCache[provider] = { models: response.data, fetchedAt: Date.now() };
    const selected = modelSelect.value === '__custom__' ? modelCustomInline.value.trim() : modelSelect.value;
    populateModels(provider, selected);
    if (force) flash('success', `${response.data.length} models loaded`);
  } catch (err) {
    // Silent on auto-refresh; explicit on button click
    if (force) showDetectError(err.message);
  } finally {
    if (force) refreshBtn.disabled = false;
  }
}

function showDetectError(msg) {
  detectError.textContent = msg;
  detectError.style.display = 'block';
}

// ─── Save ─────────────────────────────────────────────────────────────────────

function save() {
  const provider = providerSelect.value;
  const cfg = getConfig(provider);
  const isLocal = cfg?.kind === 'local';

  const model = modelSelect.value === '__custom__'
    ? modelCustomInline.value.trim()
    : modelSelect.value;

  const apiKey  = isLocal ? null : apiKeyInput.value.trim();
  const base    = isLocal ? localBaseInput.value.trim() : null;

  // Custom providers marked noAuth may save without a key
  if (!isLocal && !apiKey && !cfg?.noAuth) { flash('error', 'Please enter an API key.'); return; }
  if (isLocal && !base)    { flash('error', 'Please enter a server URL.'); return; }
  if (!model)              { flash('error', 'Please select or detect a model.'); return; }

  // Saving is the other reliable click: the provider may never have fired a
  // change event (already selected on open), and a local or custom server's
  // address is only known now, from the field the user just filled in.
  askForHostOf(isLocal ? base : cfg?.base);

  // Save localBase per provider so switching back restores it
  const update = { provider, model };
  if (!isLocal) update.apiKey = apiKey;

  if (isLocal) {
    chrome.storage.local.get(['localBases'], saved => {
      const localBases = saved.localBases || {};
      localBases[provider] = base;
      chrome.storage.local.set({ ...update, localBases }, onSaved);
    });
  } else {
    chrome.storage.local.set(update, onSaved);
  }
}

function onSaved() {
  flash('success', 'Saved!');
  const provider = providerSelect.value;
  const cfg = getConfig(provider);
  const isLocal = cfg?.kind === 'local';
  updateStatus(isLocal ? !!localBaseInput.value.trim() : !!apiKeyInput.value.trim());
  chrome.tabs.query({ url: 'https://video.ethz.ch/*' }, tabs =>
    tabs.forEach(t => chrome.tabs.sendMessage(t.id, { type: 'SETTINGS_UPDATED' }).catch(() => {}))
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getConfig(id) {
  return resolveProvider(id, providerStore);
}

/**
 * Ask for the host a provider needs, if we don't already hold it.
 *
 * Called straight from the change handler on purpose: Chrome only allows a
 * permission prompt while handling a user gesture, and it stops counting as
 * one after an await. Declining is not an error here — the user may just be
 * browsing the list, and the sidebar will offer again when a request needs it.
 */
function askForProviderHost(providerId, cfg) {
  askForHostOf(cfg && cfg.base);
}

/** Ask for whatever origin a URL belongs to. Must run inside a click. */
function askForHostOf(url) {
  if (!window.originPattern) return;
  const pattern = window.originPattern(url);
  if (!pattern) return;
  // Deliberately NOT checking hasPermission first: it is async, and a gesture
  // stops counting once you await. permissions.request resolves immediately
  // and silently when the origin is already held, so asking unconditionally
  // is both simpler and the only version that actually works.
  window.requestPermission(pattern).then(({ granted, reason }) => {
    if (granted) flash('ok', `Allowed ${window.hostLabel(pattern)}`);
    else if (reason === 'denied') {
      flash('warn', `Without access to ${window.hostLabel(pattern)} this provider can't be reached.`);
    }
  });
}

function flash(type, text) {
  statusMsg.className = `status-msg ${type}`;
  statusMsg.textContent = text;
  statusMsg.style.display = 'block';
  setTimeout(() => { statusMsg.style.display = 'none'; }, 2500);
}

function updateStatus(ready) {
  statusDot.className = `status-dot ${ready ? 'ready' : 'missing'}`;
  statusLabel.textContent = ready ? 'Ready' : 'Not configured';
}

async function applyUISettings() {
  if (!window.UISettings) return;
  const ui = await UISettings.load();
  UISettings.applyColorsToDocument(document, ui);
}

init();
