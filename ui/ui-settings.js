(async function () {
  'use strict';

  const textBaseInput = document.getElementById('text-base');
  const textBaseValue = document.getElementById('text-base-value');
  const textTitleInput = document.getElementById('text-title');
  const textTitleValue = document.getElementById('text-title-value');
  const textSectionInput = document.getElementById('text-section');
  const textSectionValue = document.getElementById('text-section-value');
  const textContentInput = document.getElementById('text-content');
  const textContentValue = document.getElementById('text-content-value');
  const textMetaInput = document.getElementById('text-meta');
  const textMetaValue = document.getElementById('text-meta-value');
  const darkGrid       = document.getElementById('dark-color-grid');
  const lightGrid      = document.getElementById('light-color-grid');
  const darkBlueGrid   = document.getElementById('dark-blue-color-grid');
  const lightWhiteGrid = document.getElementById('light-white-color-grid');
  const statusEl = document.getElementById('status');
  const previewSidebar = document.getElementById('preview-sidebar');
  const previewDarkBtn       = document.getElementById('preview-dark');
  const previewLightBtn      = document.getElementById('preview-light');
  const previewDarkBlueBtn   = document.getElementById('preview-dark-blue');
  const previewLightWhiteBtn = document.getElementById('preview-light-white');
  const restoreTextBtn       = document.getElementById('restore-text');
  const restoreDarkBtn       = document.getElementById('restore-dark');
  const restoreLightBtn      = document.getElementById('restore-light');
  const restoreDarkBlueBtn   = document.getElementById('restore-dark-blue');
  const restoreLightWhiteBtn = document.getElementById('restore-light-white');
  const restoreAllBtn = document.getElementById('restore-all');
  const saveBtn       = document.getElementById('save');

  // Custom prompts
  const promptGuideTA      = document.getElementById('prompt-guide');
  const promptQaTA         = document.getElementById('prompt-qa');
  const promptFlashcardsTA = document.getElementById('prompt-flashcards');
  const promptQuizTA       = document.getElementById('prompt-quiz');
  const promptExamTA       = document.getElementById('prompt-exam');
  const restorePromptsBtn  = document.getElementById('restore-prompts');

  const PROMPT_EXTRAS_KEY = 'customPromptExtras';
  const PROMPT_KEYS = ['guide', 'qa', 'flashcards', 'quiz', 'exam'];
  const promptTAs   = { guide: promptGuideTA, qa: promptQaTA, flashcards: promptFlashcardsTA, quiz: promptQuizTA, exam: promptExamTA };

  let workingPrompts = { guide: '', qa: '', flashcards: '', quiz: '', exam: '' };

  // Load saved custom prompts
  chrome.storage.local.get([PROMPT_EXTRAS_KEY], (r) => {
    if (r[PROMPT_EXTRAS_KEY] && typeof r[PROMPT_EXTRAS_KEY] === 'object') {
      workingPrompts = { ...workingPrompts, ...r[PROMPT_EXTRAS_KEY] };
    }
    for (const k of PROMPT_KEYS) {
      if (promptTAs[k]) promptTAs[k].value = workingPrompts[k] || '';
    }
  });

  function collectPrompts() {
    for (const k of PROMPT_KEYS) {
      workingPrompts[k] = (promptTAs[k]?.value || '').trim();
    }
  }

  restorePromptsBtn?.addEventListener('click', () => {
    workingPrompts = { guide: '', qa: '', flashcards: '', quiz: '', exam: '' };
    for (const k of PROMPT_KEYS) { if (promptTAs[k]) promptTAs[k].value = ''; }
    setStatus('Custom prompt instructions cleared');
  });

  const FIELD_CONFIG = [
    ['bg0',          'Background 0',       'color'],
    ['bg1',          'Background 1',       'color'],
    ['bg2',          'Background 2',       'color'],
    ['bg3',          'Background 3',       'color'],
    ['textPrimary',  'Text primary',       'color'],
    ['textSecondary','Text secondary',     'color'],
    ['textMuted',    'Text muted',         'color'],
    ['accent',       'Accent',             'color'],
    ['accentHover',  'Accent hover',       'color'],
    ['border',       'Border (CSS)',        'text'],
    ['accentDim',    'Accent dim (CSS)',    'text']
  ];

  let working = await UISettings.load();
  let previewTheme = 'dark'; // maps to settings key (dark / light / darkBlue / lightWhite)

  function setStatus(msg) {
    statusEl.textContent = msg || '';
  }

  function colorValueOrFallback(v) {
    if (typeof v !== 'string') return '#000000';
    if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)) return v;
    return '#000000';
  }

  function renderModeGrid(mode, target) {
    if (!target) return;
    target.innerHTML = '';
    for (const [key, label, type] of FIELD_CONFIG) {
      const row = document.createElement('div');
      row.className = 'field';
      const id = `${mode}-${key}`;
      row.innerHTML = `<label for="${id}">${label}</label>`;

      const input = document.createElement('input');
      input.id = id;
      input.dataset.mode = mode;
      input.dataset.key = key;
      input.type = type;
      input.value = type === 'color'
        ? colorValueOrFallback(working.colors[mode][key])
        : (working.colors[mode][key] || '');
      input.addEventListener('input', () => {
        working.colors[mode][key] = input.value.trim();
        applyPreview();
      });
      row.appendChild(input);
      target.appendChild(row);
    }
  }

  function renderAll() {
    textBaseInput.value = String(working.textSizes.base);
    textBaseValue.textContent = `${working.textSizes.base}px`;
    textTitleInput.value = String(working.textSizes.title);
    textTitleValue.textContent = `${working.textSizes.title}px`;
    textSectionInput.value = String(working.textSizes.sectionLabel);
    textSectionValue.textContent = `${working.textSizes.sectionLabel}px`;
    textContentInput.value = String(working.textSizes.content);
    textContentValue.textContent = `${working.textSizes.content}px`;
    textMetaInput.value = String(working.textSizes.meta);
    textMetaValue.textContent = `${working.textSizes.meta}px`;
    renderModeGrid('dark',       darkGrid);
    renderModeGrid('light',      lightGrid);
    renderModeGrid('darkBlue',   darkBlueGrid);
    renderModeGrid('lightWhite', lightWhiteGrid);
    applyPreview();
  }

  function applyPreview() {
    if (!previewSidebar) return;
    const c = working.colors[previewTheme];
    if (!c) return;
    const style = previewSidebar.style;
    style.setProperty('--bg', c.bg0);
    style.setProperty('--card', c.bg1);
    style.setProperty('--border', c.border);
    style.setProperty('--text', c.textPrimary);
    style.setProperty('--muted', c.textMuted);
    style.setProperty('--accent', c.accent);
    const s = working.textSizes || {};
    style.setProperty('--preview-base-size', `${s.base || 13}px`);
    style.setProperty('--preview-title-size', `${s.title || 16}px`);
    style.setProperty('--preview-section-size', `${s.sectionLabel || 11}px`);
    style.setProperty('--preview-content-size', `${s.content || 13.5}px`);
    style.setProperty('--preview-meta-size', `${s.meta || 11}px`);
  }

  function bindTextSize(input, output, key) {
    input.addEventListener('input', () => {
      working.textSizes[key] = parseFloat(input.value) || UISettings.DEFAULT_UI_SETTINGS.textSizes[key];
      output.textContent = `${working.textSizes[key]}px`;
      applyPreview();
    });
  }
  bindTextSize(textBaseInput,    textBaseValue,    'base');
  bindTextSize(textTitleInput,   textTitleValue,   'title');
  bindTextSize(textSectionInput, textSectionValue, 'sectionLabel');
  bindTextSize(textContentInput, textContentValue, 'content');
  bindTextSize(textMetaInput,    textMetaValue,    'meta');

  // Preview buttons
  previewDarkBtn?.addEventListener('click', () => {
    previewTheme = 'dark'; applyPreview(); setStatus('Previewing Warm Dark theme');
  });
  previewLightBtn?.addEventListener('click', () => {
    previewTheme = 'light'; applyPreview(); setStatus('Previewing Cream Light theme');
  });
  previewDarkBlueBtn?.addEventListener('click', () => {
    previewTheme = 'darkBlue'; applyPreview(); setStatus('Previewing Navy Blue theme');
  });
  previewLightWhiteBtn?.addEventListener('click', () => {
    previewTheme = 'lightWhite'; applyPreview(); setStatus('Previewing Clean White theme');
  });

  // Restore buttons
  restoreTextBtn.addEventListener('click', () => {
    working.textSizes = UISettings.deepClone(UISettings.DEFAULT_UI_SETTINGS.textSizes);
    renderAll();
    setStatus('Text sizes restored to defaults');
  });
  restoreDarkBtn.addEventListener('click', () => {
    working.colors.dark = UISettings.deepClone(UISettings.DEFAULT_UI_SETTINGS.colors.dark);
    renderAll();
    setStatus('Warm Dark colors restored');
  });
  restoreLightBtn.addEventListener('click', () => {
    working.colors.light = UISettings.deepClone(UISettings.DEFAULT_UI_SETTINGS.colors.light);
    renderAll();
    setStatus('Cream Light colors restored');
  });
  restoreDarkBlueBtn?.addEventListener('click', () => {
    working.colors.darkBlue = UISettings.deepClone(UISettings.DEFAULT_UI_SETTINGS.colors.darkBlue);
    renderAll();
    setStatus('Navy Blue colors restored');
  });
  restoreLightWhiteBtn?.addEventListener('click', () => {
    working.colors.lightWhite = UISettings.deepClone(UISettings.DEFAULT_UI_SETTINGS.colors.lightWhite);
    renderAll();
    setStatus('Clean White colors restored');
  });

  restoreAllBtn.addEventListener('click', () => {
    working = UISettings.deepClone(UISettings.DEFAULT_UI_SETTINGS);
    renderAll();
    setStatus('All UI settings restored to defaults');
  });

  // Obsidian — where an exported guide should land. Plain strings, so they
  // are read and written directly rather than going through UISettings.
  const obsidianVaultInput = document.getElementById('obsidian-vault');
  const obsidianFolderInput = document.getElementById('obsidian-folder');

  chrome.storage.local.get(['obsidianVault', 'obsidianFolder'], (saved) => {
    if (obsidianVaultInput) obsidianVaultInput.value = saved.obsidianVault || '';
    if (obsidianFolderInput) obsidianFolderInput.value = saved.obsidianFolder || '';
  });

  saveBtn.addEventListener('click', async () => {
    collectPrompts();
    working = await UISettings.save(working);
    await new Promise((resolve) => chrome.storage.local.set({
      [PROMPT_EXTRAS_KEY]: workingPrompts,
      obsidianVault: obsidianVaultInput?.value.trim() || '',
      obsidianFolder: obsidianFolderInput?.value.trim() || ''
    }, resolve));
    setStatus('Saved. Reopen sidebar to confirm changes.');
  });

  renderAll();
})();
