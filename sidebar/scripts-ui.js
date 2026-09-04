/**
 * sidebar/scripts-ui.js — Lecture-script uploads and the retrieval-method controls.
 *
 * Part of the sidebar, loaded as a plain script in the order listed in
 * sidebar.html. All sidebar modules share one global scope on purpose:
 * it is what lets each file be a straight move out of the old sidebar.js.
 */

// ─── Script Management ───────────────────────────────────────────────────

async function initScriptsForCourse(lectureUrl) {
  if (!window.ScriptManager) return;
  const courseId = ScriptManager.extractCourseId(lectureUrl);
  if (!courseId) return;
  scriptCourseId = courseId;
  try {
    scriptRecord = await ScriptManager.load(courseId);
  } catch (e) {
    console.warn('[Copilot] Failed to load scripts:', e);
    scriptRecord = null;
  }
  renderScriptFileList();
}

const SEARCH_METHOD_KEY = 'eth-copilot-script-search-method';

function getScriptSearchMethod() {
  const fallback = window.ScriptManager?.DEFAULT_METHOD || 'hybrid';
  const value = scriptSearchMethod?.value || fallback;
  return window.ScriptManager?.normalizeMethod?.(value) ?? value;
}

/** The choice used to reset on every sidebar load. */
function restoreScriptSearchMethod() {
  if (!scriptSearchMethod) return;
  let saved = null;
  try { saved = localStorage.getItem(SEARCH_METHOD_KEY); } catch { /* private mode */ }
  if (saved && [...scriptSearchMethod.options].some(o => o.value === saved)) {
    scriptSearchMethod.value = saved;
  }
  onSearchMethodChange();
}

function onSearchMethodChange() {
  const method = getScriptSearchMethod();
  try { localStorage.setItem(SEARCH_METHOD_KEY, method); } catch { /* private mode */ }
  // Hybrid needs the index just as much as semantic does, so both show the
  // semantic notes and the build-index button.
  const needsIndex = window.ScriptManager?.usesEmbeddings?.(method) ?? (method === 'semantic');
  if (scriptSemanticInfo) scriptSemanticInfo.style.display = needsIndex ? '' : 'none';
  updateEmbedBtnVisibility();
}

function updateEmbedBtnVisibility() {
  if (!scriptEmbedBtn) return;
  const method = getScriptSearchMethod();
  const needsIndex = window.ScriptManager?.usesEmbeddings?.(method) ?? (method === 'semantic');
  const hasChunks = scriptRecord?.chunks?.length > 0;
  const hasEmbeds = window.ScriptManager?.hasEmbeddings(scriptRecord);
  scriptEmbedBtn.style.display = (needsIndex && hasChunks && !hasEmbeds) ? '' : 'none';
  if (scriptEmbedStatus && needsIndex) {
    // Hybrid without an index still answers, just on keywords alone — say so
    // rather than leaving the user thinking semantic search is running.
    scriptEmbedStatus.textContent = hasEmbeds
      ? 'Semantic index ready'
      : (hasChunks ? 'No semantic index yet — using fuzzy search until you build one' : '');
  }
}

async function onEmbedExistingClick() {
  if (!scriptCourseId || !scriptRecord?.chunks?.length) return;
  scriptEmbedBtn.disabled = true;
  scriptEmbedBtn.textContent = 'Building index...';
  try {
    scriptRecord = await ScriptManager.computeEmbeddings(scriptCourseId, (status) => {
      if (scriptEmbedStatus) scriptEmbedStatus.textContent = status;
    });
    if (scriptEmbedStatus) scriptEmbedStatus.textContent = 'Semantic index ready';
  } catch (e) {
    console.error('[Copilot] Embedding failed:', e);
    if (scriptEmbedStatus) scriptEmbedStatus.textContent = 'Indexing failed: ' + e.message;
  } finally {
    scriptEmbedBtn.disabled = false;
    scriptEmbedBtn.textContent = 'Build semantic index for existing scripts';
    updateEmbedBtnVisibility();
  }
}

function renderScriptFileList() {
  if (!scriptFileList) return;
  const files = scriptRecord?.files || [];
  const totalChunks = scriptRecord?.chunks?.length || 0;

  if (scriptBadge) {
    scriptBadge.textContent = files.length;
    scriptBadge.style.display = files.length > 0 ? '' : 'none';
  }

  if (!files.length) {
    scriptFileList.innerHTML = '<p class="script-empty-msg">No scripts uploaded for this course.</p>';
    updateEmbedBtnVisibility();
    return;
  }

  const hasEmbeds = window.ScriptManager?.hasEmbeddings(scriptRecord);
  const embedLabel = hasEmbeds ? ' · semantic indexed' : '';

  scriptFileList.innerHTML = files.map((f, i) => `
      <div class="script-file-item" data-file-index="${i}">
        <div class="script-file-info">
          <span class="script-file-name" title="${f.name}">${f.name}</span>
          <span class="script-file-meta">${f.pageCount} pages · ${f.chunkCount} chunks · ${ScriptManager.formatSize(f.size)}</span>
        </div>
        <button class="script-file-remove" title="Remove this file" data-remove-index="${i}">×</button>
      </div>
    `).join('');

  scriptFileList.querySelectorAll('.script-file-remove').forEach(btn => {
    btn.addEventListener('click', async () => {
      const idx = parseInt(btn.dataset.removeIndex);
      scriptUploadStatus.textContent = 'Removing…';
      try {
        scriptRecord = await ScriptManager.removeFile(scriptCourseId, idx);
        renderScriptFileList();
        scriptUploadStatus.textContent = '';
      } catch (e) {
        scriptUploadStatus.textContent = 'Error: ' + e.message;
      }
    });
  });

  const totalTokensEst = totalChunks * CHUNK_TARGET_DISPLAY;
  scriptFileList.insertAdjacentHTML('beforeend',
    `<p class="script-file-meta" style="padding:2px 0 0;font-style:italic">Total: ${totalChunks} chunks (~${Math.round(totalTokensEst / 1000)}K tokens)${embedLabel}</p>`
  );
  updateEmbedBtnVisibility();
}

const CHUNK_TARGET_DISPLAY = 500;

async function handleScriptUpload() {
  if (!scriptFileInput?.files?.length || !scriptCourseId) return;
  const files = Array.from(scriptFileInput.files);
  scriptFileInput.value = '';
  const method = getScriptSearchMethod();

  for (const file of files) {
    if (!file.name.toLowerCase().endsWith('.pdf')) {
      scriptUploadStatus.textContent = `Skipped ${file.name} — only PDFs are supported`;
      continue;
    }

    scriptUploadStatus.innerHTML = `<span class="script-upload-progress">Processing ${file.name}…</span>`;

    try {
      scriptRecord = await ScriptManager.addPdf(scriptCourseId, file, (status) => {
        scriptUploadStatus.innerHTML = `<span class="script-upload-progress">${status}</span>`;
      }, method);
      renderScriptFileList();
      scriptUploadStatus.textContent = `${file.name} added` + (method === 'semantic' ? ' (with embeddings)' : '');
    } catch (e) {
      console.error('[Copilot] PDF processing failed:', e);
      scriptUploadStatus.textContent = `Failed: ${e.message}`;
    }
  }

  setTimeout(() => { if (scriptUploadStatus) scriptUploadStatus.textContent = ''; }, 5000);
}
