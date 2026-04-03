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
  const darkGrid = document.getElementById('dark-color-grid');
  const lightGrid = document.getElementById('light-color-grid');
  const statusEl = document.getElementById('status');
  const previewSidebar = document.getElementById('preview-sidebar');
  const previewDarkBtn = document.getElementById('preview-dark');
  const previewLightBtn = document.getElementById('preview-light');
  const restoreTextBtn = document.getElementById('restore-text');
  const restoreDarkBtn = document.getElementById('restore-dark');
  const restoreLightBtn = document.getElementById('restore-light');
  const restoreAllBtn = document.getElementById('restore-all');
  const saveBtn = document.getElementById('save');

  const FIELD_CONFIG = [
    ['bg0', 'Background 0', 'color'],
    ['bg1', 'Background 1', 'color'],
    ['bg2', 'Background 2', 'color'],
    ['bg3', 'Background 3', 'color'],
    ['textPrimary', 'Text primary', 'color'],
    ['textSecondary', 'Text secondary', 'color'],
    ['textMuted', 'Text muted', 'color'],
    ['accent', 'Accent', 'color'],
    ['accentHover', 'Accent hover', 'color'],
    ['border', 'Border (CSS)', 'text'],
    ['accentDim', 'Accent dim (CSS)', 'text']
  ];

  let working = await UISettings.load();
  let previewTheme = 'dark';

  function setStatus(msg) {
    statusEl.textContent = msg || '';
  }

  function colorValueOrFallback(v) {
    if (typeof v !== 'string') return '#000000';
    if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)) return v;
    return '#000000';
  }

  function renderModeGrid(mode, target) {
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
    renderModeGrid('dark', darkGrid);
    renderModeGrid('light', lightGrid);
    applyPreview();
  }

  function applyPreview() {
    if (!previewSidebar) return;
    const c = working.colors[previewTheme];
    const style = previewSidebar.style;
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
  bindTextSize(textBaseInput, textBaseValue, 'base');
  bindTextSize(textTitleInput, textTitleValue, 'title');
  bindTextSize(textSectionInput, textSectionValue, 'sectionLabel');
  bindTextSize(textContentInput, textContentValue, 'content');
  bindTextSize(textMetaInput, textMetaValue, 'meta');

  previewDarkBtn?.addEventListener('click', () => {
    previewTheme = 'dark';
    applyPreview();
    setStatus('Previewing dark theme');
  });
  previewLightBtn?.addEventListener('click', () => {
    previewTheme = 'light';
    applyPreview();
    setStatus('Previewing light theme');
  });

  restoreTextBtn.addEventListener('click', () => {
    working.textSizes = UISettings.deepClone(UISettings.DEFAULT_UI_SETTINGS.textSizes);
    renderAll();
    setStatus('Text sizes restored to defaults');
  });

  restoreDarkBtn.addEventListener('click', () => {
    working.colors.dark = UISettings.deepClone(UISettings.DEFAULT_UI_SETTINGS.colors.dark);
    renderAll();
    setStatus('Dark colors restored');
  });

  restoreLightBtn.addEventListener('click', () => {
    working.colors.light = UISettings.deepClone(UISettings.DEFAULT_UI_SETTINGS.colors.light);
    renderAll();
    setStatus('Light colors restored');
  });

  restoreAllBtn.addEventListener('click', () => {
    working = UISettings.deepClone(UISettings.DEFAULT_UI_SETTINGS);
    renderAll();
    setStatus('All UI settings restored to defaults');
  });

  saveBtn.addEventListener('click', async () => {
    working = await UISettings.save(working);
    setStatus('Saved. Reopen sidebar/popup to confirm changes.');
  });

  renderAll();
})();

