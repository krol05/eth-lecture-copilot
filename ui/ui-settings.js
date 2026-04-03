(async function () {
  'use strict';

  const scaleInput = document.getElementById('sidebar-scale');
  const scaleValue = document.getElementById('sidebar-scale-value');
  const darkGrid = document.getElementById('dark-color-grid');
  const lightGrid = document.getElementById('light-color-grid');
  const statusEl = document.getElementById('status');
  const previewSidebar = document.getElementById('preview-sidebar');
  const previewDarkBtn = document.getElementById('preview-dark');
  const previewLightBtn = document.getElementById('preview-light');
  const restoreScaleBtn = document.getElementById('restore-scale');
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
    scaleInput.value = String(working.sidebarScale);
    scaleValue.textContent = `${working.sidebarScale}%`;
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
    previewSidebar.style.transform = `scale(${(working.sidebarScale || 100) / 100})`;
  }

  scaleInput.addEventListener('input', () => {
    working.sidebarScale = parseInt(scaleInput.value, 10) || 100;
    scaleValue.textContent = `${working.sidebarScale}%`;
    applyPreview();
  });

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

  restoreScaleBtn.addEventListener('click', () => {
    working.sidebarScale = UISettings.DEFAULT_UI_SETTINGS.sidebarScale;
    renderAll();
    setStatus('Scale restored to default');
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

