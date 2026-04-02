/**
 * popup.js — Settings popup for ETH Lecture Copilot
 * Provider + API key only. Best model is auto-selected per provider.
 */

const API_KEY_LINKS = {
  gemini: 'https://aistudio.google.com/app/apikey',
  claude: 'https://console.anthropic.com/settings/keys',
  openai: 'https://platform.openai.com/api-keys'
};

const PROVIDER_LABELS = {
  gemini: 'Gemini 2.5 Flash',
  claude: 'Claude Sonnet 4.5',
  openai: 'GPT-4.1 mini'
};

const providerSelect = document.getElementById('provider-select');
const apiKeyInput    = document.getElementById('api-key-input');
const toggleKeyBtn   = document.getElementById('toggle-key');
const eyeOpen        = document.getElementById('eye-open');
const eyeClosed      = document.getElementById('eye-closed');
const saveBtn        = document.getElementById('save-btn');
const statusMsg      = document.getElementById('status-msg');
const statusDot      = document.getElementById('status-dot');
const statusLabel    = document.getElementById('status-label');
const apiKeyLink     = document.getElementById('api-key-link');
const modelBadge     = document.getElementById('model-badge');

function init() {
  chrome.storage.local.get(['provider', 'apiKey'], settings => {
    const provider = settings.provider || 'gemini';
    providerSelect.value = provider;
    if (settings.apiKey) apiKeyInput.value = settings.apiKey;
    updateApiKeyLink(provider);
    updateModelBadge(provider);
    updateStatusIndicator(!!settings.apiKey);
  });

  providerSelect.addEventListener('change', () => {
    updateApiKeyLink(providerSelect.value);
    updateModelBadge(providerSelect.value);
  });

  toggleKeyBtn.addEventListener('click', () => {
    const show = apiKeyInput.type === 'password';
    apiKeyInput.type = show ? 'text' : 'password';
    eyeOpen.style.display   = show ? 'none'  : 'block';
    eyeClosed.style.display = show ? 'block' : 'none';
  });

  saveBtn.addEventListener('click', saveSettings);

  const theme = localStorage.getItem('eth-copilot-theme') || 'dark';
  document.documentElement.dataset.theme = theme;
}

function updateApiKeyLink(provider) {
  apiKeyLink.href = API_KEY_LINKS[provider] || '#';
}

function updateModelBadge(provider) {
  if (modelBadge) modelBadge.textContent = PROVIDER_LABELS[provider] || '';
}

function saveSettings() {
  const provider = providerSelect.value;
  const apiKey   = apiKeyInput.value.trim();

  if (!apiKey) {
    showStatus('error', 'Please enter an API key.');
    return;
  }

  chrome.storage.local.set({ provider, apiKey }, () => {
    showStatus('success', 'Settings saved!');
    updateStatusIndicator(true);
    chrome.tabs.query({ url: 'https://video.ethz.ch/*' }, tabs => {
      tabs.forEach(tab => chrome.tabs.sendMessage(tab.id, { type: 'SETTINGS_UPDATED' }).catch(() => {}));
    });
  });
}

function showStatus(type, text) {
  statusMsg.className = `status-msg ${type}`;
  statusMsg.textContent = text;
  statusMsg.style.display = 'block';
  setTimeout(() => { statusMsg.style.display = 'none'; }, 3000);
}

function updateStatusIndicator(hasKey) {
  statusDot.className = `status-dot ${hasKey ? 'ready' : 'missing'}`;
  statusLabel.textContent = hasKey ? 'API key configured' : 'No API key set';
}

init();
