/**
 * popup.js — Settings popup for ETH Lecture Copilot
 */

const MODELS = {
  gemini: [
    { id: 'gemini-2.5-pro-preview-05-06', label: 'Gemini 2.5 Pro' },
    { id: 'gemini-2.0-flash',             label: 'Gemini 2.0 Flash' },
    { id: 'gemini-1.5-pro-latest',        label: 'Gemini 1.5 Pro' },
    { id: 'gemini-1.5-flash-latest',      label: 'Gemini 1.5 Flash' }
  ],
  claude: [
    { id: 'claude-sonnet-4-5',            label: 'Claude Sonnet 4.5' },
    { id: 'claude-haiku-4-5-20251001',    label: 'Claude Haiku 4.5' },
    { id: 'claude-opus-4-6',              label: 'Claude Opus 4.6' }
  ],
  openai: [
    { id: 'gpt-4o',                       label: 'GPT-4o' },
    { id: 'gpt-4o-mini',                  label: 'GPT-4o mini' },
    { id: 'o4-mini',                      label: 'o4-mini' }
  ]
};

const API_KEY_LINKS = {
  gemini: 'https://aistudio.google.com/app/apikey',
  claude: 'https://console.anthropic.com/settings/keys',
  openai: 'https://platform.openai.com/api-keys'
};

// DOM refs
const providerSelect = document.getElementById('provider-select');
const modelSelect    = document.getElementById('model-select');
const apiKeyInput    = document.getElementById('api-key-input');
const toggleKeyBtn   = document.getElementById('toggle-key');
const eyeOpen        = document.getElementById('eye-open');
const eyeClosed      = document.getElementById('eye-closed');
const saveBtn        = document.getElementById('save-btn');
const statusMsg      = document.getElementById('status-msg');
const statusDot      = document.getElementById('status-dot');
const statusLabel    = document.getElementById('status-label');
const apiKeyLink     = document.getElementById('api-key-link');

// ─── Init ─────────────────────────────────────────────────────────────────

function init() {
  chrome.storage.local.get(['provider', 'model', 'apiKey'], settings => {
    const provider = settings.provider || 'gemini';
    providerSelect.value = provider;
    populateModels(provider, settings.model);
    if (settings.apiKey) apiKeyInput.value = settings.apiKey;
    updateApiKeyLink(provider);
    updateStatusIndicator(!!settings.apiKey);
  });

  providerSelect.addEventListener('change', () => {
    const p = providerSelect.value;
    populateModels(p);
    updateApiKeyLink(p);
  });

  toggleKeyBtn.addEventListener('click', () => {
    const isPassword = apiKeyInput.type === 'password';
    apiKeyInput.type = isPassword ? 'text' : 'password';
    eyeOpen.style.display   = isPassword ? 'none'  : 'block';
    eyeClosed.style.display = isPassword ? 'block' : 'none';
  });

  saveBtn.addEventListener('click', saveSettings);

  // Apply theme from localStorage
  const theme = localStorage.getItem('eth-copilot-theme') || 'dark';
  document.documentElement.dataset.theme = theme;
}

// ─── Model Dropdown ────────────────────────────────────────────────────────

function populateModels(provider, selectedModel) {
  const models = MODELS[provider] || [];
  modelSelect.innerHTML = models
    .map(m => `<option value="${m.id}"${m.id === selectedModel ? ' selected' : ''}>${m.label}</option>`)
    .join('');
  if (!selectedModel && models.length) modelSelect.value = models[0].id;
}

// ─── API Key Link ──────────────────────────────────────────────────────────

function updateApiKeyLink(provider) {
  const url = API_KEY_LINKS[provider] || '#';
  apiKeyLink.href = url;
}

// ─── Save ──────────────────────────────────────────────────────────────────

function saveSettings() {
  const provider = providerSelect.value;
  const model    = modelSelect.value;
  const apiKey   = apiKeyInput.value.trim();

  if (!apiKey) {
    showStatus('error', 'Please enter an API key.');
    return;
  }

  chrome.storage.local.set({ provider, model, apiKey }, () => {
    showStatus('success', 'Settings saved!');
    updateStatusIndicator(true);
    // Notify any open content scripts that settings changed
    chrome.tabs.query({ url: 'https://video.ethz.ch/*' }, tabs => {
      tabs.forEach(tab => {
        chrome.tabs.sendMessage(tab.id, { type: 'SETTINGS_UPDATED', provider, model })
          .catch(() => {}); // ignore if no content script loaded yet
      });
    });
  });
}

// ─── Status ────────────────────────────────────────────────────────────────

function showStatus(type, text) {
  statusMsg.className = `status-msg ${type}`;
  statusMsg.textContent = text;
  statusMsg.style.display = 'block';
  setTimeout(() => { statusMsg.style.display = 'none'; }, 3000);
}

function updateStatusIndicator(hasKey) {
  if (hasKey) {
    statusDot.className = 'status-dot ready';
    statusLabel.textContent = 'API key configured';
  } else {
    statusDot.className = 'status-dot missing';
    statusLabel.textContent = 'No API key set';
  }
}

init();
