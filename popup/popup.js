/**
 * popup.js — reads PROVIDERS_CONFIG from providers-config.js (loaded before this)
 */

const providerSelect  = document.getElementById('provider-select');
const onboardingNote  = document.getElementById('onboarding-note');
const onboardingDismiss = document.getElementById('onboarding-dismiss');
const modelSelect     = document.getElementById('model-select');
const modelCustom     = document.getElementById('model-custom');
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
const detectError     = document.getElementById('detect-error');
const saveBtn         = document.getElementById('save-btn');
const statusMsg       = document.getElementById('status-msg');
const statusDot       = document.getElementById('status-dot');
const statusLabel     = document.getElementById('status-label');

function init() {
  // Build provider dropdown — split into two optgroups
  const cloudGroup = document.createElement('optgroup');
  cloudGroup.label = 'Cloud';
  const localGroup = document.createElement('optgroup');
  localGroup.label = '⚡ Local';

  PROVIDERS_CONFIG.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.label;
    (p.type === 'local' ? localGroup : cloudGroup).appendChild(opt);
  });

  providerSelect.appendChild(cloudGroup);
  providerSelect.appendChild(localGroup);

  // Load saved settings
  chrome.storage.local.get(['provider', 'model', 'apiKey', 'localBases', 'onboardingSeen'], saved => {
    const provider = saved.provider || PROVIDERS_CONFIG[0].id;
    providerSelect.value = provider;
    const cfg = getConfig(provider);
    const savedBase = saved.localBases?.[provider] || cfg?.defaultBase || '';
    if (savedBase) localBaseInput.value = savedBase;
    renderProviderUI(provider);
    populateModels(provider, saved.model);
    if (saved.apiKey) apiKeyInput.value = saved.apiKey;
    const hasLocalBase = cfg?.type === 'local' && !!savedBase;
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
    // Restore saved base URL for this provider, or default
    chrome.storage.local.get(['localBases'], saved => {
      localBaseInput.value = saved.localBases?.[p] || cfg?.defaultBase || '';
      renderProviderUI(p);
      populateModels(p);
    });
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

  toggleKeyBtn.addEventListener('click', () => {
    const show = apiKeyInput.type === 'password';
    apiKeyInput.type = show ? 'text' : 'password';
    eyeOpen.style.display   = show ? 'none'  : 'block';
    eyeClosed.style.display = show ? 'block' : 'none';
  });

  saveBtn.addEventListener('click', save);

  document.documentElement.dataset.theme =
    localStorage.getItem('eth-copilot-theme') || 'dark';
}

// ─── Provider UI rendering ────────────────────────────────────────────────────

function renderProviderUI(providerId) {
  const cfg = getConfig(providerId);
  const isLocal = cfg?.type === 'local';

  // Show/hide sections
  localBaseGroup.style.display = isLocal ? 'block' : 'none';
  apiKeyGroup.style.display    = isLocal ? 'none'  : 'block';
  detectBtn.style.display      = isLocal ? 'inline-flex' : 'none';

  if (isLocal) {
    localNote.textContent = cfg.note || '';
    localNote.style.display = cfg.note ? 'block' : 'none';
  }

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

function populateModels(providerId, selectedModel) {
  const cfg = getConfig(providerId);
  if (!cfg) return;

  if (cfg.customModel) {
    // OpenRouter: free text input
    modelSelect.style.display  = 'none';
    modelCustom.style.display  = 'block';
    modelCustom.value = selectedModel || cfg.models[0]?.id || '';
    return;
  }

  modelSelect.style.display = 'block';
  modelCustom.style.display = 'none';

  if (cfg.type === 'local' && cfg.models.length === 0) {
    // No models yet — show placeholder
    modelSelect.innerHTML = '<option value="">— click Detect Models —</option>';
    modelSelect.dataset.detected = 'false';
    return;
  }

  modelSelect.innerHTML = cfg.models
    .map(m => `<option value="${m.id}"${m.id === selectedModel ? ' selected' : ''}>${m.label || m.id}</option>`)
    .join('');
  if (!selectedModel && cfg.models[0]) modelSelect.value = cfg.models[0].id;
  modelSelect.dataset.detected = 'false';
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

function showDetectError(msg) {
  detectError.textContent = msg;
  detectError.style.display = 'block';
}

// ─── Save ─────────────────────────────────────────────────────────────────────

function save() {
  const provider = providerSelect.value;
  const cfg = getConfig(provider);
  const isLocal = cfg?.type === 'local';

  const model = cfg?.customModel
    ? modelCustom.value.trim()
    : modelSelect.value;

  const apiKey  = isLocal ? null : apiKeyInput.value.trim();
  const base    = isLocal ? localBaseInput.value.trim() : null;

  if (!isLocal && !apiKey) { flash('error', 'Please enter an API key.'); return; }
  if (isLocal && !base)    { flash('error', 'Please enter a server URL.'); return; }
  if (!model)              { flash('error', 'Please select or detect a model.'); return; }

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
  const isLocal = cfg?.type === 'local';
  updateStatus(isLocal ? !!localBaseInput.value.trim() : !!apiKeyInput.value.trim());
  chrome.tabs.query({ url: 'https://video.ethz.ch/*' }, tabs =>
    tabs.forEach(t => chrome.tabs.sendMessage(t.id, { type: 'SETTINGS_UPDATED' }).catch(() => {}))
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getConfig(id) {
  return PROVIDERS_CONFIG.find(p => p.id === id);
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

init();
