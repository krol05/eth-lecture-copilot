/**
 * popup.js — reads PROVIDERS_CONFIG from providers-config.js (loaded before this)
 */

const providerSelect = document.getElementById('provider-select');
const modelSelect    = document.getElementById('model-select');
const modelCustom    = document.getElementById('model-custom');
const providerNote   = document.getElementById('provider-note');
const apiKeyInput    = document.getElementById('api-key-input');
const apiKeyLink     = document.getElementById('api-key-link');
const toggleKeyBtn   = document.getElementById('toggle-key');
const eyeOpen        = document.getElementById('eye-open');
const eyeClosed      = document.getElementById('eye-closed');
const saveBtn        = document.getElementById('save-btn');
const statusMsg      = document.getElementById('status-msg');
const statusDot      = document.getElementById('status-dot');
const statusLabel    = document.getElementById('status-label');

function init() {
  // Build provider dropdown from config
  PROVIDERS_CONFIG.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.label;
    providerSelect.appendChild(opt);
  });

  // Load saved settings
  chrome.storage.local.get(['provider', 'model', 'apiKey'], saved => {
    const provider = saved.provider || PROVIDERS_CONFIG[0].id;
    providerSelect.value = provider;
    populateModels(provider, saved.model);
    if (saved.apiKey) apiKeyInput.value = saved.apiKey;
    updateProviderMeta(provider);
    updateStatus(!!saved.apiKey);
  });

  providerSelect.addEventListener('change', () => {
    const p = providerSelect.value;
    populateModels(p);
    updateProviderMeta(p);
  });

  toggleKeyBtn.addEventListener('click', () => {
    const show = apiKeyInput.type === 'password';
    apiKeyInput.type = show ? 'text' : 'password';
    eyeOpen.style.display   = show ? 'none'  : 'block';
    eyeClosed.style.display = show ? 'block' : 'none';
  });

  saveBtn.addEventListener('click', save);

  // Restore theme
  document.documentElement.dataset.theme =
    localStorage.getItem('eth-copilot-theme') || 'dark';
}

function populateModels(providerId, selectedModel) {
  const cfg = PROVIDERS_CONFIG.find(p => p.id === providerId);
  if (!cfg) return;

  if (cfg.customModel) {
    // OpenRouter-style: show text input, hide dropdown
    modelSelect.style.display  = 'none';
    modelCustom.style.display  = 'block';
    modelCustom.value = selectedModel || cfg.models[0]?.id || '';
  } else {
    modelSelect.style.display  = 'block';
    modelCustom.style.display  = 'none';
    modelSelect.innerHTML = cfg.models
      .map(m => `<option value="${m.id}"${m.id === selectedModel ? ' selected' : ''}>${m.label}</option>`)
      .join('');
    if (!selectedModel) modelSelect.value = cfg.models[0]?.id || '';
  }
}

function updateProviderMeta(providerId) {
  const cfg = PROVIDERS_CONFIG.find(p => p.id === providerId);
  if (!cfg) return;
  apiKeyLink.href = cfg.keyLink || '#';
  apiKeyInput.placeholder = cfg.keyHint ? `e.g. ${cfg.keyHint}` : 'Paste your API key…';
  if (cfg.note) {
    providerNote.textContent = cfg.note;
    providerNote.style.display = 'block';
  } else {
    providerNote.style.display = 'none';
  }
}

function save() {
  const provider = providerSelect.value;
  const cfg = PROVIDERS_CONFIG.find(p => p.id === provider);
  const model = cfg?.customModel
    ? modelCustom.value.trim()
    : modelSelect.value;
  const apiKey = apiKeyInput.value.trim();

  if (!apiKey) { flash('error', 'Please enter an API key.'); return; }
  if (!model)  { flash('error', 'Please select or enter a model.'); return; }

  chrome.storage.local.set({ provider, model, apiKey }, () => {
    flash('success', 'Saved!');
    updateStatus(true);
    chrome.tabs.query({ url: 'https://video.ethz.ch/*' }, tabs =>
      tabs.forEach(t => chrome.tabs.sendMessage(t.id, { type: 'SETTINGS_UPDATED' }).catch(() => {}))
    );
  });
}

function flash(type, text) {
  statusMsg.className = `status-msg ${type}`;
  statusMsg.textContent = text;
  statusMsg.style.display = 'block';
  setTimeout(() => { statusMsg.style.display = 'none'; }, 2500);
}

function updateStatus(hasKey) {
  statusDot.className = `status-dot ${hasKey ? 'ready' : 'missing'}`;
  statusLabel.textContent = hasKey ? 'API key configured' : 'No API key set';
}

init();
