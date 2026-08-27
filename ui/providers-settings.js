/**
 * ui/providers-settings.js — the "AI Providers" section of the options page.
 * Edits chrome.storage.local.{providerOverrides, customProviders, adapterSpecs}
 * (M3). Resolution/merging logic lives in lib/providers/overrides.js; the
 * adapter-spec validation in lib/providers/adapter-spec.js.
 */
(function () {
  const NEW_ID = '__new__';

  const sel          = document.getElementById('prov-select');
  const labelRow     = document.getElementById('prov-label-row');
  const labelInput   = document.getElementById('prov-label');
  const adapterRow   = document.getElementById('prov-adapter-row');
  const adapterSel   = document.getElementById('prov-adapter');
  const baseInput    = document.getElementById('prov-base');
  const baseHint     = document.getElementById('prov-base-hint');
  const headersInput = document.getElementById('prov-headers');
  const modelsInput  = document.getElementById('prov-models');
  const defaultInput = document.getElementById('prov-default-model');
  const hiddenRow    = document.getElementById('prov-hidden-row');
  const hiddenCb     = document.getElementById('prov-hidden');
  const noAuthRow    = document.getElementById('prov-noauth-row');
  const noAuthCb     = document.getElementById('prov-noauth');
  const specInput    = document.getElementById('prov-spec');
  const specValidate = document.getElementById('prov-spec-validate');
  const specClear    = document.getElementById('prov-spec-clear');
  const specStatus   = document.getElementById('prov-spec-status');
  const resetBtn     = document.getElementById('prov-reset');
  const deleteBtn    = document.getElementById('prov-delete');
  const saveBtn      = document.getElementById('prov-save');
  const statusEl     = document.getElementById('prov-status');

  let store = { providerOverrides: {}, customProviders: {}, adapterSpecs: {} };

  function loadStore() {
    return new Promise(resolve => {
      chrome.storage.local.get(['providerOverrides', 'customProviders', 'adapterSpecs'], r => {
        store = {
          providerOverrides: r.providerOverrides || {},
          customProviders: r.customProviders || {},
          adapterSpecs: r.adapterSpecs || {}
        };
        resolve();
      });
    });
  }

  function saveStore() {
    return new Promise(resolve => chrome.storage.local.set(store, resolve));
  }

  function flash(el, ok, text) {
    el.textContent = text;
    el.style.color = ok ? 'var(--success, #4a4)' : 'var(--error, #c44)';
    if (ok) setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 3000);
  }

  function isCustom(id) { return String(id).startsWith('custom_'); }

  function populateSelect(selectedId) {
    sel.replaceChildren();
    for (const p of Catalog.list()) {
      const opt = document.createElement('option');
      opt.value = p.id;
      const marks = [];
      if (store.providerOverrides[p.id] && Object.keys(store.providerOverrides[p.id]).length) marks.push('edited');
      if (store.providerOverrides[p.id]?.hidden) marks.push('hidden');
      if (store.adapterSpecs[p.id]) marks.push('custom API');
      opt.textContent = p.label + (marks.length ? ` (${marks.join(', ')})` : '');
      sel.appendChild(opt);
    }
    for (const id of Object.keys(store.customProviders)) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = `${store.customProviders[id]?.label || id} (custom)`;
      sel.appendChild(opt);
    }
    const newOpt = document.createElement('option');
    newOpt.value = NEW_ID;
    newOpt.textContent = '➕ New custom provider…';
    sel.appendChild(newOpt);
    if (selectedId) sel.value = selectedId;
  }

  function modelsToText(models) {
    return (models || []).map(m => m.label && m.label !== m.id ? `${m.id} | ${m.label}` : m.id).join('\n');
  }

  function textToModels(text) {
    return String(text || '').split('\n')
      .map(line => line.trim()).filter(Boolean)
      .map(line => {
        const [id, ...rest] = line.split('|');
        return { id: id.trim(), label: rest.join('|').trim() || id.trim() };
      })
      .filter(m => m.id);
  }

  function fillForm(id) {
    statusEl.textContent = '';
    specStatus.textContent = '';
    const creating = id === NEW_ID;
    const custom = creating || isCustom(id);

    labelRow.style.display = custom ? '' : 'none';
    adapterRow.style.display = custom ? '' : 'none';
    noAuthRow.style.display = custom ? '' : 'none';
    hiddenRow.style.display = custom ? 'none' : '';
    deleteBtn.style.display = (!creating && custom) ? '' : 'none';
    resetBtn.style.display = custom ? 'none' : '';

    if (creating) {
      labelInput.value = '';
      adapterSel.value = 'oai';
      baseInput.value = '';
      baseHint.textContent = '';
      headersInput.value = '';
      modelsInput.value = '';
      defaultInput.value = '';
      noAuthCb.checked = false;
      specInput.value = '';
      return;
    }

    if (custom) {
      const c = store.customProviders[id] || {};
      labelInput.value = c.label || '';
      adapterSel.value = c.adapter || 'oai';
      baseInput.value = c.baseUrl || '';
      baseHint.textContent = '';
      headersInput.value = c.headers ? JSON.stringify(c.headers, null, 2) : '';
      modelsInput.value = modelsToText(c.models && c.models.map(m => typeof m === 'string' ? { id: m, label: m } : m));
      defaultInput.value = c.defaultModel || '';
      noAuthCb.checked = !!c.noAuth;
    } else {
      const entry = Catalog.get(id);
      const o = store.providerOverrides[id] || {};
      baseInput.value = o.baseUrl || '';
      baseHint.textContent = `— built-in: ${entry.base}`;
      headersInput.value = o.headers ? JSON.stringify(o.headers, null, 2) : '';
      modelsInput.value = modelsToText(o.models);
      defaultInput.value = o.defaultModel || '';
      hiddenCb.checked = !!o.hidden;
    }
    specInput.value = store.adapterSpecs[id] ? JSON.stringify(store.adapterSpecs[id], null, 2) : '';
  }

  function parseHeaders() {
    const raw = headersInput.value.trim();
    if (!raw) return { ok: true, value: undefined };
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      return { ok: true, value: parsed };
    } catch {
      return { ok: false };
    }
  }

  function parseSpec() {
    const raw = specInput.value.trim();
    if (!raw) return { ok: true, value: undefined };
    let parsed;
    try { parsed = JSON.parse(raw); } catch (e) {
      return { ok: false, errors: [`Not valid JSON: ${e.message}`] };
    }
    const v = validateSpec(parsed);
    return v.ok ? { ok: true, value: parsed } : { ok: false, errors: v.errors };
  }

  function slugify(label) {
    let slug = 'custom_' + String(label).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    if (slug === 'custom_') slug = 'custom_provider';
    let unique = slug, n = 2;
    while (store.customProviders[unique]) unique = `${slug}_${n++}`;
    return unique;
  }

  async function save() {
    const id = sel.value;
    const creating = id === NEW_ID;
    const custom = creating || isCustom(id);

    const headers = parseHeaders();
    if (!headers.ok) { flash(statusEl, false, 'Extra headers must be a JSON object like {"Name": "value"}.'); return; }
    const spec = parseSpec();
    if (!spec.ok) { flash(statusEl, false, 'Adapter spec is invalid — use "Validate spec" for details.'); return; }

    if (custom) {
      const label = labelInput.value.trim();
      const base = normalizeOAIBase(baseInput.value);
      if (!label) { flash(statusEl, false, 'Give the provider a name.'); return; }
      if (!base) { flash(statusEl, false, 'Base URL must start with http:// or https://.'); return; }
      const targetId = creating ? slugify(label) : id;
      store.customProviders[targetId] = {
        label,
        adapter: adapterSel.value,
        baseUrl: base,
        ...(headers.value ? { headers: headers.value } : {}),
        models: textToModels(modelsInput.value),
        ...(defaultInput.value.trim() ? { defaultModel: defaultInput.value.trim() } : {}),
        noAuth: noAuthCb.checked
      };
      if (spec.value) store.adapterSpecs[targetId] = spec.value;
      else delete store.adapterSpecs[targetId];
      await saveStore();
      populateSelect(targetId);
      fillForm(targetId);
      flash(statusEl, true, creating ? `Saved — pick "${label}" in the extension popup to use it.` : 'Saved.');
      return;
    }

    // Catalog provider override
    const o = {};
    const rawBase = baseInput.value.trim();
    if (rawBase) {
      const base = normalizeOAIBase(rawBase);
      if (!base) { flash(statusEl, false, 'Base URL must start with http:// or https://.'); return; }
      o.baseUrl = base;
    }
    if (headers.value) o.headers = headers.value;
    const models = textToModels(modelsInput.value);
    if (models.length) o.models = models;
    if (defaultInput.value.trim()) o.defaultModel = defaultInput.value.trim();
    if (hiddenCb.checked) o.hidden = true;

    if (Object.keys(o).length) store.providerOverrides[id] = o;
    else delete store.providerOverrides[id];
    if (spec.value) store.adapterSpecs[id] = spec.value;
    else delete store.adapterSpecs[id];

    await saveStore();
    populateSelect(id);
    flash(statusEl, true, 'Saved.');
  }

  async function resetProvider() {
    const id = sel.value;
    delete store.providerOverrides[id];
    delete store.adapterSpecs[id];
    await saveStore();
    populateSelect(id);
    fillForm(id);
    flash(statusEl, true, 'Back to built-in defaults.');
  }

  async function deleteProvider() {
    const id = sel.value;
    if (!isCustom(id)) return;
    if (!confirm(`Delete "${store.customProviders[id]?.label || id}"? This cannot be undone.`)) return;
    delete store.customProviders[id];
    delete store.adapterSpecs[id];
    await saveStore();
    populateSelect(Catalog.list()[0].id);
    fillForm(sel.value);
    flash(statusEl, true, 'Deleted.');
  }

  function validateSpecClick() {
    const spec = parseSpec();
    if (!specInput.value.trim()) { flash(specStatus, true, 'No spec — the built-in API format is used.'); return; }
    if (spec.ok) flash(specStatus, true, 'Spec is valid ✓ (saved when you hit "Save provider")');
    else specStatus.textContent = spec.errors.join('\n'), specStatus.style.color = 'var(--error, #c44)';
  }

  async function init() {
    if (!sel) return;
    await loadStore();
    populateSelect();
    fillForm(sel.value);
    sel.addEventListener('change', () => fillForm(sel.value));
    saveBtn.addEventListener('click', save);
    resetBtn.addEventListener('click', resetProvider);
    deleteBtn.addEventListener('click', deleteProvider);
    specValidate.addEventListener('click', validateSpecClick);
    specClear.addEventListener('click', () => { specInput.value = ''; flash(specStatus, true, 'Spec cleared — save to apply.'); });
  }

  init();
})();
