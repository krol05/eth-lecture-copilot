/**
 * sidebar/flashcards-ui.js — Flashcard generation, the card viewer, TSV export, and AnkiConnect.
 *
 * Part of the sidebar, loaded as a plain script in the order listed in
 * sidebar.html. All sidebar modules share one global scope on purpose:
 * it is what lets each file be a straight move out of the old sidebar.js.
 */

function showFlashcardsPanel(panel) {
  const s = document.getElementById('flashcards-settings');
  const r = document.getElementById('flashcards-results');
  if (s) s.style.display = panel === 'settings' ? 'flex' : 'none';
  if (r) r.style.display = panel === 'results'  ? 'flex' : 'none';
}

function deriveFallbackFlashcardDeckTitle() {
  return getGuideTitle(guide);
}

function applyFlashcardsResponse(data) {
  const cards = Array.isArray(data?.flashcards) ? data.flashcards : [];
  flashcardData = window.normalizeFlashcardsResponse
    ? window.normalizeFlashcardsResponse(data)
    : cards
        .filter(c => c && (c.front != null || c.back != null))
        .map(c => ({ front: String(c.front ?? ''), back: String(c.back ?? '') }));
  // New guides provide the title once at guide creation. Older flashcard outputs
  // may still contain deckTitle, but the current guide title is authoritative.
  flashcardDeckTitle = flashcardData.length ? deriveFallbackFlashcardDeckTitle() : null;
  if (flashcardDeckTitle) flashcardDeckTitle = flashcardDeckTitle.slice(0, 120);
  flashcardIndex = 0;
}

function updateFlashcardDeckTitleUI() {
  const label = flashcardDeckTitle
    ? `Deck: ${flashcardDeckTitle}`
    : '';
  const toolsEl = document.getElementById('flashcards-deck-title-label');
  if (toolsEl) {
    toolsEl.textContent = label;
    toolsEl.hidden = !label;
  }
  const inlineEl = document.getElementById('it-fc-deck-title-label');
  if (inlineEl) {
    inlineEl.textContent = label;
    inlineEl.hidden = !label;
  }
}

function renderFlashcardMetadata(card) {
  const rows = window.getFlashcardMetadataRows ? window.getFlashcardMetadataRows(card) : [];
  if (!rows.length) return '';
  return `<div class="flashcard-meta" aria-label="Flashcard source metadata">
      ${rows.map(([label, value]) => label === 'Study note'
      ? `<details class="flashcard-meta-note">
            <summary><span class="flashcard-meta-label">${escHtml(label)}</span></summary>
            <div class="flashcard-meta-note-body">${escHtml(value)}</div>
          </details>`
      : `
        <span class="flashcard-meta-item">
          <span class="flashcard-meta-label">${escHtml(label)}</span>
          <span class="flashcard-meta-value">${escHtml(value)}</span>
        </span>`
    ).join('')}
    </div>`;
}

async function generateFlashcards() {
  await runToolGeneration({
    type: 'FLASHCARDS_REQUEST',
    thinkingKey: 'flashcards',
    buttonId: 'flashcards-generate-btn',
    errorId: 'flashcards-error',
    buildPrompt: () => promptForFlashcards(guide, readFlashcardOptions(TAB_TOOL_IDS.flashcards)),
    onSuccess: (data) => {
      acceptFlashcards(data);
      renderFlashcardList(flashcardData);
      const countLabel = document.getElementById('flashcards-count-label');
      if (countLabel) {
        countLabel.textContent = `${flashcardData.length} card${flashcardData.length !== 1 ? 's' : ''}`;
      }
      updateFlashcardDeckTitleUI();
      showFlashcardsPanel('results');
    }
  });
}

/** Show all cards in paginated single-card view.  Wires up prev/next nav. */
function renderFlashcardList(cards) {
  flashcardIndex = Math.min(flashcardIndex, Math.max(0, cards.length - 1));
  _wireFlashcardNav();
  renderFlashcard(flashcardIndex);
}

/** Render the card at `idx` into the card-list container. */
function renderFlashcard(idx) {
  const list = document.getElementById('flashcards-card-list');
  if (!list || !flashcardData.length) return;
  idx = Math.max(0, Math.min(idx, flashcardData.length - 1));
  flashcardIndex = idx;

  // Update nav counter
  const counter = document.getElementById('flashcard-nav-counter');
  if (counter) counter.textContent = `${idx + 1} / ${flashcardData.length}`;
  const prevBtn = document.getElementById('flashcard-prev-btn');
  const nextBtn = document.getElementById('flashcard-next-btn');
  if (prevBtn) prevBtn.disabled = idx === 0;
  if (nextBtn) nextBtn.disabled = idx === flashcardData.length - 1;

  // Build card HTML
  const card = flashcardData[idx];
  list.innerHTML = '';
  const item = document.createElement('div');
  item.className = 'flashcard-item';
  item.innerHTML = `
      <div class="flashcard-side flashcard-front">
        <div class="flashcard-side-label">Front</div>
        <div class="flashcard-text">${richTextHtml(card.front)}</div>
      </div>
      <div class="flashcard-side flashcard-back">
        <div class="flashcard-side-label">Back</div>
        <div class="flashcard-text">${richTextHtml(card.back)}</div>
      </div>
      ${renderFlashcardMetadata(card)}
      <div class="flashcard-actions">
        <button class="flashcard-delete-btn" type="button" title="Delete this card">Delete card</button>
        <span class="flashcard-ask-slot"></span>
      </div>
    `;
  item.querySelector('.flashcard-delete-btn').addEventListener('click', () => {
    // Save deleted card for undo
    const deletedCard = { ...flashcardData[idx] };
    const deletedIdx  = idx;
    flashcardData.splice(idx, 1);
    const countLabel = document.getElementById('flashcards-count-label');
    if (countLabel) countLabel.textContent = `${flashcardData.length} card${flashcardData.length !== 1 ? 's' : ''}`;
    persistToolOutputs();

    // Show undo toast
    _showFlashcardUndoToast(deletedCard, deletedIdx);

    if (!flashcardData.length) {
      list.innerHTML = '<p style="color:var(--text-muted);font-size:12px;padding:8px 0">All cards deleted.</p>';
      const c = document.getElementById('flashcard-nav-counter');
      if (c) c.textContent = '0 / 0';
      return;
    }
    renderFlashcard(Math.min(idx, flashcardData.length - 1));
  });
  list.appendChild(item);
  appendToolAskButton(item.querySelector('.flashcard-ask-slot'), 'flashcard', idx);

  // Apply KaTeX to the rendered card
  item.querySelectorAll('.flashcard-text').forEach(el => applyKatex(el));
}

let _flashcardNavWired = false;
function _wireFlashcardNav() {
  if (_flashcardNavWired) return;
  _flashcardNavWired = true;
  document.getElementById('flashcard-prev-btn')?.addEventListener('click', () => {
    if (flashcardIndex > 0) renderFlashcard(flashcardIndex - 1);
  });
  document.getElementById('flashcard-next-btn')?.addEventListener('click', () => {
    if (flashcardIndex < flashcardData.length - 1) renderFlashcard(flashcardIndex + 1);
  });
}

function getEditedFlashcards() {
  return flashcardData;
}

let _flashcardUndoTimeout = null;
function _showFlashcardUndoToast(card, atIndex) {
  // Remove any existing undo toast
  document.getElementById('flashcard-undo-toast')?.remove();
  if (_flashcardUndoTimeout) clearTimeout(_flashcardUndoTimeout);

  const toast = document.createElement('div');
  toast.id = 'flashcard-undo-toast';
  toast.className = 'flashcard-undo-toast';
  toast.innerHTML = `
      <span>Card deleted</span>
      <button class="flashcard-undo-btn" type="button">Undo</button>
    `;
  toast.querySelector('.flashcard-undo-btn').addEventListener('click', () => {
    // Restore card at original position (or end if out of range)
    const insertAt = Math.min(atIndex, flashcardData.length);
    flashcardData.splice(insertAt, 0, card);
    const countLabel = document.getElementById('flashcards-count-label');
    if (countLabel) countLabel.textContent = `${flashcardData.length} card${flashcardData.length !== 1 ? 's' : ''}`;
    renderFlashcard(insertAt);
    persistToolOutputs();
    toast.remove();
    if (_flashcardUndoTimeout) clearTimeout(_flashcardUndoTimeout);
  });

  // Append inside the flashcards results panel
  const panel = document.getElementById('flashcards-results');
  if (panel) panel.appendChild(toast);

  // Auto-dismiss after 5 seconds
  _flashcardUndoTimeout = setTimeout(() => toast.remove(), 5000);
}

function exportFlashcardsAsTSV() {
  const cards = getEditedFlashcards();
  if (!cards.length) return;
  const tsv = cards.map(c => {
    const back = window.buildFlashcardBackWithMetadata ? window.buildFlashcardBackWithMetadata(c) : c.back;
    return `${String(c.front ?? '').replace(/\t/g, ' ')}\t${String(back ?? '').replace(/\t/g, ' ')}`;
  }).join('\n');
  const blob = new Blob([tsv], { type: 'text/tab-separated-values; charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const title = (flashcardDeckTitle || transcript?.lectureTitle || guide?.lecture_title || 'lecture')
    .replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  a.download = `${title}-flashcards.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  setStatus('ready', 'Flashcards exported as TSV');
}

function formatAnkiConnectError(error) {
  const parts = Array.isArray(error) ? error : [error];
  return [...new Set(parts.map(e => String(e).trim()).filter(Boolean))].join('; ');
}

const ANKI_ORIGIN = 'http://127.0.0.1/*';

/**
 * Anki runs AnkiConnect on 127.0.0.1, which is no longer granted at install
 * time. Ask before the first call; Chrome resolves instantly when we already
 * hold it. Must be reached from the export click — a gesture stops counting
 * after an await, so this is called before anything else awaits.
 */
async function ensureAnkiAccess() {
  if (typeof self === 'undefined' || !self.requestPermission) return true;
  const { granted } = await self.requestPermission(ANKI_ORIGIN);
  return granted;
}

async function ankiConnect(action, params = {}) {
  const resp = await fetch('http://127.0.0.1:8765', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, version: 6, params })
  });
  const data = await resp.json();
  if (data.error) throw new Error(formatAnkiConnectError(data.error));
  return data.result;
}

function sanitizeAnkiDeckPart(name) {
  return String(name || 'Untitled')
    .replace(/::/g, ' – ')
    .replace(/[\x00-\x1f]/g, '')
    .trim()
    .slice(0, 90) || 'Untitled';
}

/** Subject::GuideTitle - guide_title groups cards under the course in Anki. */
async function buildAnkiDeckNameForCurrentLecture() {
  const subject = sanitizeAnkiDeckPart(
    transcript?.courseName || guide?.lecture_title || 'Lecture Copilot'
  );
  const deckPart = sanitizeAnkiDeckPart(
    flashcardDeckTitle || deriveFallbackFlashcardDeckTitle() || 'Lecture'
  );
  return `${subject}::${deckPart}`;
}

async function ensureAnkiDeck(deckName) {
  const deckNames = await ankiConnect('deckNames');
  if (!deckNames.includes(deckName)) {
    await ankiConnect('createDeck', { deck: deckName });
  }
}

function buildAnkiNoteSpecs(cards, deckName) {
  const subjectTag = sanitizeAnkiDeckPart(transcript?.courseName || 'lecture-copilot')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .slice(0, 40);
  const guideTitleTag = getGuideTitle(guide)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  const deckScopeOptions = {
    deckName,
    checkChildren: false,
    checkAllModels: false
  };
  return cards.map(c => {
    const tags = window.buildFlashcardAnkiTags
      ? window.buildFlashcardAnkiTags(c, ['lecture-copilot', subjectTag, guideTitleTag])
      : ['lecture-copilot', subjectTag, guideTitleTag].filter(Boolean);
    const back = window.buildFlashcardBackHtmlWithMetadata
      ? window.buildFlashcardBackHtmlWithMetadata(c)
      : (window.buildFlashcardBackWithMetadata ? window.buildFlashcardBackWithMetadata(c) : c.back);
    return {
      deckName,
      modelName: 'Basic',
      fields: {
        Front: window.markdownishToHtml
          ? window.markdownishToHtml(String(c.front ?? '').trim())
          : String(c.front ?? '').trim(),
        Back: String(back ?? '').trim()
      },
      options: {
        allowDuplicate: false,
        // Anki 2.1.45+ — scope duplicate check to this deck only (not whole collection).
        duplicateScope: 'deck',
        duplicateScopeOptions: deckScopeOptions,
        // Legacy AnkiConnect field — keep for older installs.
        duplicateScopeDeckName: deckName
      },
      tags
    };
  });
}

/** Add notes one-by-one so duplicate skips never abort the whole batch. */
async function addAnkiNotesResilient(notes) {
  let added = 0;
  let skipped = 0;
  for (const note of notes) {
    try {
      const id = await ankiConnect('addNote', { note });
      if (id) added++;
      else skipped++;
    } catch (err) {
      if (/duplicate/i.test(String(err.message || ''))) {
        skipped++;
      } else {
        throw err;
      }
    }
  }
  return { added, skipped };
}

async function sendFlashcardsToAnki() {
  const cards = getEditedFlashcards();
  if (!cards.length) return;

  // Before any other await, so this still counts as the export click.
  if (!(await ensureAnkiAccess())) {
    setStatus('error', 'Anki needs permission to reach AnkiConnect on 127.0.0.1. Click "Send to Anki" again and choose Allow, or use "Export as TSV" instead.');
    return;
  }

  const deckName = await buildAnkiDeckNameForCurrentLecture();
  const notes = buildAnkiNoteSpecs(cards, deckName);
  try {
    await ensureAnkiDeck(deckName);

    let notesToAdd = notes;
    let preSkipped = 0;
    try {
      const canAdd = await ankiConnect('canAddNotes', { notes });
      if (Array.isArray(canAdd) && canAdd.length === notes.length) {
        notesToAdd = notes.filter((_, i) => canAdd[i]);
        preSkipped = notes.length - notesToAdd.length;
      }
    } catch {
      // Older AnkiConnect — fall through to resilient add.
    }

    if (!notesToAdd.length) {
      setStatus('warning',
        `All ${notes.length} card${notes.length !== 1 ? 's' : ''} already exist in Anki deck "${deckName}".`);
      return;
    }

    const { added, skipped } = await addAnkiNotesResilient(notesToAdd);
    const totalSkipped = preSkipped + skipped;
    if (added > 0) {
      let msg = `${added} card${added !== 1 ? 's' : ''} added to Anki deck "${deckName}"`;
      if (totalSkipped > 0) {
        msg += ` (${totalSkipped} skipped — duplicate in this deck)`;
      }
      setStatus('ready', msg);
    } else {
      setStatus('warning',
        `No new cards added — all ${notes.length} already exist in "${deckName}".`);
    }
  } catch (err) {
    setStatus('error', 'AnkiConnect error: ' + err.message + '. Is Anki open with AnkiConnect installed?');
  }
}
