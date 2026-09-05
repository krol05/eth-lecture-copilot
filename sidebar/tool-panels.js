/**
 * sidebar/tool-panels.js — The inline study-tool panels shared by the Guide and Tools tabs.
 *
 * Part of the sidebar, loaded as a plain script in the order listed in
 * sidebar.html. All sidebar modules share one global scope on purpose:
 * it is what lets each file be a straight move out of the old sidebar.js.
 */

// ─── Shared pill-group helper ─────────────────────────────────────────────

/**
 * Initialize a pill group — clicking a pill makes it active, deactivates others.
 * @param {string} groupId  — the container element's id
 * @param {function} [onChange]  — optional callback called with the new active value
 */
function initPillGroup(groupId, onChange) {
  const group = document.getElementById(groupId);
  if (!group) return;
  group.querySelectorAll('.pill').forEach(btn => {
    btn.addEventListener('click', () => {
      group.querySelectorAll('.pill').forEach(b => b.classList.remove('pill-active'));
      btn.classList.add('pill-active');
      if (onChange) onChange(btn.dataset.value);
    });
  });
}

function getActivePillValue(groupId) {
  const group = document.getElementById(groupId);
  if (!group) return null;
  const active = group.querySelector('.pill.pill-active');
  return active ? active.dataset.value : null;
}

function initFlashcardTypePills(groupId) {
  const group = document.getElementById(groupId);
  if (!group) return;
  group.querySelectorAll('.pill').forEach(btn => {
    btn.addEventListener('click', () => {
      const value = btn.dataset.value;
      const all = [...group.querySelectorAll('.pill')];
      if (value === 'auto') {
        all.forEach(b => b.classList.toggle('pill-active', b.dataset.value === 'auto'));
      } else {
        const auto = group.querySelector('.pill[data-value="auto"]');
        auto?.classList.remove('pill-active');
        btn.classList.toggle('pill-active');
        if (!group.querySelector('.pill.pill-active')) {
          auto?.classList.add('pill-active');
        }
      }
      all.forEach(b => b.setAttribute('aria-pressed', b.classList.contains('pill-active') ? 'true' : 'false'));
    });
  });
}

function getSelectedFlashcardTypes(groupId = 'flashcards-card-type-pills') {
  const group = document.getElementById(groupId);
  if (!group) return ['auto'];
  const selected = [...group.querySelectorAll('.pill.pill-active')]
    .map(btn => btn.dataset.value)
    .filter(Boolean);
  if (!selected.length || selected.includes('auto')) return ['auto'];
  return selected;
}

function buildApiPayloadBase() {
  return {
    provider: settings.provider,
    model: settings.model || null,
    apiKey: settings.apiKey,
    localBase: getLocalBase()
  };
}

// ─── One generation path per tool, two places to start it ─────────────────
//
// Every study tool exists twice: as a section in the Tools tab and as a panel
// inline in the guide. Both used to carry their own copy of the whole
// generate-and-render sequence, which is how they drifted apart — the inline
// exam never stored its questions, the inline flashcards skipped the settings
// check, and error wording differed. The request is written once here; the two
// copies supply only their own control ids and their own way of showing the
// result.

/**
 * Run a study-tool generation and hand the response to the caller.
 *
 * @param {object}   spec
 * @param {string}   spec.type          message type for the background worker
 * @param {string}   spec.thinkingKey   which tool's thinking level to send
 * @param {string}   spec.buttonId      button to show a spinner in
 * @param {string}   spec.errorId       element to write a failure into
 * @param {Function} spec.buildPrompt   () => system prompt
 * @param {Function} spec.onSuccess     (data) => void, may throw to show an error
 */
async function runToolGeneration({ type, thinkingKey, buttonId, errorId, buildPrompt, onSuccess }) {
  const btn = document.getElementById(buttonId);
  const errEl = document.getElementById(errorId);

  const showError = (message) => {
    if (errEl) {
      errEl.textContent = message;
      errEl.style.display = '';
    } else {
      setStatus('error', message);
    }
  };

  if (!guide?.guide?.length) {
    showError('Generate a study guide first — the tools work from it.');
    return;
  }
  // Silently doing nothing here is what made the button look broken.
  if (!hasUsableSettings()) {
    showError('Set your API key in the extension popup first.');
    return;
  }

  setFeatureBtnLoading(btn, true);
  if (errEl) errEl.style.display = 'none';
  let req = null;
  try {
    req = apiRequest({
      ...buildApiPayloadBase(),
      type,
      toolThinking: getToolThinking(thinkingKey),
      guideJson: guide,
      systemPrompt: buildPrompt()
    });
    // These responses already stream; until now the sidebar threw the chunks
    // away and showed a spinner, so a three-minute generation looked identical
    // to a hang. Counting finished items costs nothing and says it is alive.
    trackToolProgress(req._requestId, type, btn);
    const resp = await req;
    if (!resp.success) throw new Error(resp.error);
    onSuccess(resp.data);
  } catch (err) {
    showError(err.message);
  } finally {
    if (req?._requestId) untrackToolProgress(req._requestId);
    setFeatureBtnLoading(btn, false);
  }
}

/** Flashcard controls, wherever they live. Ids are unique across the page. */
function readFlashcardOptions(ids) {
  const customRaw = parseInt(document.getElementById(ids.custom)?.value?.trim() || '', 10);
  return {
    count: (!isNaN(customRaw) && customRaw > 0)
      ? String(customRaw)
      : (getActivePillValue(ids.count) || 'auto'),
    cardTypes: getSelectedFlashcardTypes(ids.types),
    includeFormulas: !!document.getElementById(ids.formulas)?.checked,
    language: getToolLanguage(ids.lang)
  };
}

/** Quiz controls, wherever they live. */
function readQuizOptions(ids) {
  const customRaw = parseInt(document.getElementById(ids.custom)?.value?.trim() || '', 10);
  return {
    count: (!isNaN(customRaw) && customRaw > 0)
      ? customRaw
      : parseInt(getActivePillValue(ids.count) || '10', 10),
    type: getActivePillValue(ids.type) || 'mixed',
    language: getToolLanguage(ids.lang)
  };
}

/**
 * Exam controls other than block selection, which differs between the two
 * copies and is passed in separately.
 */
function readExamOptions(ids) {
  const countPill = getActivePillValue(ids.count) || '5';
  const perBlock = countPill === 'per-block';
  const customRaw = parseInt(document.getElementById(ids.custom)?.value?.trim() || '', 10);
  return {
    difficulty: getActivePillValue(ids.difficulty) || 'mixed',
    // Depth was fully written into the exam prompt (surface / deep / research)
    // and read from nowhere, so it sat pinned at 'deep' whatever the user did.
    depth: getActivePillValue(ids.depth) || 'deep',
    format: getActivePillValue(ids.format) || 'open',
    answerLength: getActivePillValue(ids.answer) || 'medium',
    questionsPerBlock: perBlock,
    count: perBlock ? 2
      : ((!isNaN(customRaw) && customRaw > 0) ? customRaw : parseInt(countPill, 10) || 5),
    language: getToolLanguage(ids.lang)
  };
}

/** Control ids for the Tools-tab copy of each generator. */
const TAB_TOOL_IDS = {
  flashcards: { count: 'flashcards-count-pills', custom: 'flashcards-custom-count',
    types: 'flashcards-card-type-pills', formulas: 'flashcards-formulas-cb',
    lang: 'flashcards-lang-select' },
  quiz: { count: 'quiz-count-pills', custom: 'quiz-custom-count',
    type: 'quiz-type-pills', lang: 'quiz-lang-select' },
  exam: { count: 'exam-count-pills', custom: 'exam-custom-count',
    difficulty: 'exam-difficulty-pills', depth: 'exam-depth-pills',
    format: 'exam-format-pills', answer: 'exam-answer-pills',
    lang: 'exam-lang-select' }
};

/** Control ids for the inline-panel copy of each generator. */
const INLINE_TOOL_IDS = {
  flashcards: { count: 'it-fc-count-pills', custom: 'it-fc-custom-count',
    types: 'it-fc-card-type-pills', formulas: 'it-fc-formulas-cb',
    lang: 'it-fc-lang-select' },
  quiz: { count: 'it-quiz-count-pills', custom: 'it-quiz-custom-count',
    type: 'it-quiz-type-pills', lang: 'it-quiz-lang-select' },
  exam: { count: 'it-exam-count-pills', custom: 'it-exam-custom-count',
    difficulty: 'it-exam-difficulty-pills', depth: 'it-exam-depth-pills',
    format: 'it-exam-format-pills', answer: 'it-exam-answer-pills',
    lang: 'it-exam-lang-select' }
};

/** Store a freshly generated flashcard deck. Both copies land here. */
function acceptFlashcards(data) {
  applyFlashcardsResponse(data);
  if (!flashcardData.length) throw new Error('No flashcards returned. Try different settings.');
  persistToolOutputs();
}

/** Store freshly generated exam questions. Both copies land here. */
function acceptExamQuestions(data) {
  const questions = data?.questions || [];
  if (!questions.length) throw new Error('No questions returned. Try different settings.');
  examQuestionData = questions;
  persistToolOutputs();
  return questions;
}

// ─── Tool section helpers ─────────────────────────────────────────────────

/** Switch to the Tools tab and open a specific tool section (details element). */
function openToolSection(sectionId) {
  switchTab('tools');
  const section = document.getElementById(sectionId);
  if (section) {
    section.open = true;
    setTimeout(() => section.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
  }
}

// ─── Inline guide tool panel ──────────────────────────────────────────────
// Opens a split-panel within the Guide tab instead of switching to Tools tab.

let _inlineToolActive = null;   // 'flashcards' | 'quiz' | 'exam' | 'summary' | null

/**
 * Open (or toggle) the inline tool panel at the bottom of the Guide tab.
 * @param {'flashcards'|'quiz'|'exam'|'summary'} toolKey
 * @param {string} titleText   Panel header label
 * @param {Function} buildFn   Called with the body element to populate it
 */
function openInlineToolPanel(toolKey, titleText, buildFn) {
  if (!guide?.guide?.length) { setStatus('warning', 'Generate a guide first'); return; }

  const guideContent = document.getElementById('guide-content');
  const panel        = document.getElementById('guide-inline-tool');
  const nameEl       = document.getElementById('guide-inline-tool-name');
  const bodyEl       = document.getElementById('guide-inline-tool-body');
  if (!panel || !bodyEl) return;

  // Toggle off if same tool clicked again
  if (_inlineToolActive === toolKey) {
    closeInlineToolPanel();
    return;
  }

  if (_inlineToolActive) closeToolAskPanel();

  _inlineToolActive = toolKey;
  nameEl.textContent = titleText;
  bodyEl.innerHTML   = '';
  buildFn(bodyEl);

  // The inline panel is rebuilt from scratch every time it opens, so its
  // controls start at the markup's defaults. Hydrating here is what makes the
  // inline copy and the Tools-tab copy show the same thing — they share one
  // stored key per control.
  setUpRememberedControls();

  // Clear any height left from a previous resize — let content drive the size.
  // The panel will be exactly as tall as its content (the settings form / results).
  // CSS max-height caps it if content is very long.
  panel.style.height = '';

  panel.hidden = false;
  guideContent?.classList.add('inline-tool-open');

  // Highlight the active toolbar button
  document.querySelectorAll('.guide-toolbar-actions .icon-btn').forEach(btn => {
    btn.classList.toggle('inline-tool-active', btn.dataset.inlineTool === toolKey);
  });

  // Wire resize handle
  _wireInlineResize();
}

function closeInlineToolPanel() {
  closeToolAskPanel();
  const guideContent = document.getElementById('guide-content');
  const panel        = document.getElementById('guide-inline-tool');
  if (panel) {
    panel.hidden = true;
    panel.style.height = '';   // clear JS-set height so CSS rules take over next open
  }
  guideContent?.classList.remove('inline-tool-open');
  _inlineToolActive = null;
  document.querySelectorAll('.guide-toolbar-actions .icon-btn').forEach(btn => {
    btn.classList.remove('inline-tool-active');
  });
}

function _wireInlineResize() {
  const handle = document.getElementById('guide-inline-resize');
  const panel  = document.getElementById('guide-inline-tool');
  if (!handle || !panel || handle.dataset.wired) return;
  handle.dataset.wired = '1';

  let startY = 0, startH = 0;
  handle.addEventListener('mousedown', e => {
    startY = e.clientY;
    startH = panel.offsetHeight;
    const onMove = ev => {
      // Handle is at the TOP of the panel (bottom-anchored panel).
      // Drag UP (ev.clientY decreases) → delta positive → panel grows.
      // Drag DOWN (ev.clientY increases) → delta negative → panel shrinks.
      const delta = startY - ev.clientY;
      const container = panel.parentElement;
      const maxH = (container ? container.offsetHeight : window.innerHeight) - 80;
      const newH = Math.min(Math.max(startH + delta, 120), maxH);
      panel.style.height = `${newH}px`;
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    e.preventDefault();
  });
}

// Returns <select> HTML for a language picker pre-selected to the current guideLanguage.
// ── Per-tool thinking control ─────────────────────────────────────────────
// Every generation can pick its own reasoning depth, the same way guide
// generation can. The chosen level is remembered per tool.
const TOOL_THINKING_LEVELS = [
  ['none', 'None'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']
];
const TOOL_THINKING_KEY = 'toolThinking';
let toolThinking = {};   // toolKey → level, loaded from storage at init

function getToolThinking(toolKey) {
  return toolThinking[toolKey] || 'none';
}

function setToolThinking(toolKey, level) {
  toolThinking[toolKey] = level;
  storageSet({ [TOOL_THINKING_KEY]: toolThinking });
}

/** Markup for a tool's thinking select. `id` must be unique on the page. */
function _toolThinkingSelectHtml(id, toolKey) {
  const current = getToolThinking(toolKey);
  return `<select id="${id}" class="gen-setting-select" data-tool-thinking="${toolKey}">${
    TOOL_THINKING_LEVELS
      .map(([v, l]) => `<option value="${v}"${v === current ? ' selected' : ''}>${l}</option>`)
      .join('')
  }</select>`;
}

/** A full labelled row, so each tool panel adds thinking with one call. */
function _toolThinkingRowHtml(id, toolKey) {
  return `<div class="inline-tool-row">
      <span class="inline-tool-label" title="How much the model reasons before answering. More costs more and takes longer.">Thinking</span>
      ${_toolThinkingSelectHtml(id, toolKey)}
    </div>`;
}

// One delegated listener covers every tool panel, inline or in the Tools tab.
document.addEventListener('change', (ev) => {
  const sel = ev.target?.closest?.('[data-tool-thinking]');
  if (!sel) return;
  setToolThinking(sel.getAttribute('data-tool-thinking'), sel.value);
  syncToolThinkingSelects(sel);   // keep the other copy of this tool in step
});

/** Show the stored level in every tool select (the Tools-tab ones are static). */
function syncToolThinkingSelects(except = null) {
  for (const sel of document.querySelectorAll('[data-tool-thinking]')) {
    if (sel === except) continue;
    const level = getToolThinking(sel.getAttribute('data-tool-thinking'));
    if (sel.value !== level) sel.value = level;
  }
}

function _inlineLangSelectHtml(id) {
  const langs = [
    ['__guide__','Same as guide'],['English','English'],['German','Deutsch'],
    ['French','Français'],['Italian','Italiano'],['Spanish','Español'],
    ['Portuguese','Português'],['Turkish','Türkçe'],['Arabic','العربية'],
    ['Chinese','中文'],['Japanese','日本語'],['Korean','한국어'],['Russian','Русский']
  ];
  const known = langs.slice(1).map(([v]) => v);
  const sel = (guideLanguage && known.includes(guideLanguage)) ? guideLanguage : '__guide__';
  return `<select id="${id}" class="gen-setting-select">${
    langs.map(([v,l]) => `<option value="${v}"${v===sel?' selected':''}>${l}</option>`).join('')
  }</select>`;
}

/** Build the Lecture Summary inline panel body (synced with Q&A) */
/** Style / length / language / focus controls for the lecture summary. */
function _summaryOptionsHtml() {
  const styleOpts = Object.entries(SUMMARY_STYLES)
    .map(([v, d]) => `<option value="${v}"${v === summaryOptions.style ? ' selected' : ''}>${d.label}</option>`).join('');
  const lengthOpts = Object.entries(SUMMARY_LENGTHS)
    .map(([v, d]) => `<option value="${v}"${v === summaryOptions.length ? ' selected' : ''}>${d.label}</option>`).join('');
  const hint = (SUMMARY_STYLES[summaryOptions.style] || SUMMARY_STYLES.exam).hint;
  return `
      <div class="inline-tool-row">
        <span class="inline-tool-label">Style</span>
        <select class="gen-setting-select" data-summary-opt="style">${styleOpts}</select>
      </div>
      <p class="inline-tool-hint summary-style-hint">${escHtml(hint)}</p>
      <div class="inline-tool-row">
        <span class="inline-tool-label">Length</span>
        <select class="gen-setting-select" data-summary-opt="length">${lengthOpts}</select>
      </div>
      <div class="inline-tool-row">
        <span class="inline-tool-label">Language</span>
        ${_inlineLangSelectHtml('it-summary-lang-select').replace('id="it-summary-lang-select"', 'data-summary-opt="language"')}
      </div>
      <div class="inline-tool-row">
        <span class="inline-tool-label" title="Anything you want emphasised, e.g. a topic you find hard">Focus</span>
        <input type="text" class="gen-setting-input" data-summary-opt="focus"
               placeholder="optional — e.g. focus on the proofs"
               value="${escHtml(summaryOptions.focus || '')}">
      </div>`;
}

// One delegated listener for every copy of the summary options.
document.addEventListener('change', (ev) => {
  const el = ev.target?.closest?.('[data-summary-opt]');
  if (!el) return;
  setSummaryOption(el.getAttribute('data-summary-opt'), el.value);
  if (el.getAttribute('data-summary-opt') === 'style') refreshInlineLectureSummaryIfOpen();
});
document.addEventListener('input', (ev) => {
  const el = ev.target?.closest?.('input[data-summary-opt="focus"]');
  if (el) setSummaryOption('focus', el.value);
});

function _buildInlineLectureSummary(body) {
  if (isLectureSummaryGenerating()) {
    if (lectureSummarySource === 'qa') {
      body.innerHTML = '<p class="inline-tool-hint">Generating in Q&amp;A — switch to that tab to watch progress. This panel updates when complete.</p>';
      return;
    }
    _lectureSummaryGuideBody = body;
    _renderGuideSummaryStreaming(body);
    return;
  }
  if (lectureSummaryReady()) {
    const srcHint = lectureSummarySource === 'qa'
      ? '<p class="inline-tool-hint">Generated in Q&amp;A — synced here for reading, resize, and export.</p>'
      : (lectureSummarySource === 'guide'
        ? '<p class="inline-tool-hint">Generated here — use Q&amp;A “Add to context” per chat when you want the AI to use it.</p>'
        : '');
    body.innerHTML = `
        ${srcHint}
        <div class="inline-tool-actions lecture-summary-actions">
          <button type="button" class="history-load-btn lecture-summary-export-pdf-btn">Export PDF</button>
          <button type="button" class="history-load-btn lecture-summary-regen-btn" title="Discard this summary and build a new one with the current options">Regenerate</button>
        </div>
        <details class="summary-options-details">
          <summary>Summary options</summary>
          ${_summaryOptionsHtml()}
        </details>
        <div class="lecture-summary-view"></div>`;
    renderLectureSummaryMarkdown(body.querySelector('.lecture-summary-view'), lectureSummaryText);
    body.querySelector('.lecture-summary-export-pdf-btn')?.addEventListener('click', openSummaryPrintWindow);
    body.querySelector('.lecture-summary-regen-btn')?.addEventListener('click', () => {
      regenerateLectureSummary('guide', body);
    });
    return;
  }
  const canGen = hasUsableSettings() && transcript?.text && guide?.guide?.length;
  body.innerHTML = `
      <p class="inline-tool-hint">One summary built from the full guide and transcript. Synced with the Q&amp;A tab.</p>
      ${_summaryOptionsHtml()}
      <button type="button" class="btn-primary inline-summary-generate-btn" ${canGen ? '' : 'disabled'}>
        Generate lecture summary
      </button>`;
  body.querySelector('.inline-summary-generate-btn')?.addEventListener('click', () => {
    if (!canGen || isLectureSummaryGenerating() || lectureSummaryReady()) return;
    runLectureSummaryGeneration({ source: 'guide', guideBodyEl: body });
  });
}

/** Build the Flashcards inline panel body */
function _buildInlineFlashcards(body) {
  if (flashcardData.length) {
    // Already have cards — show them directly
    _renderInlineFlashcardResults(body);
  } else {
    const countVal   = getActivePillValue('flashcards-count-pills') || 'auto';
    const typeVals   = getSelectedFlashcardTypes('flashcards-card-type-pills');
    const formulasOn = document.getElementById('flashcards-formulas-cb')?.checked ?? true;
    const typeOptions = [
      ['auto', 'Auto'],
      ['recall', 'Recall'],
      ['definition', 'Definition'],
      ['concept', 'Concept'],
      ['application', 'Application'],
      ['comparison', 'Comparison'],
      ['process', 'Process'],
      ['cause_effect', 'Cause / effect'],
      ['example', 'Example'],
      ['misconception', 'Misconception'],
      ['formula_rule', 'Formula / rule']
    ];
    body.innerHTML = `
        <div class="inline-tool-row">
          <span class="inline-tool-label">Count</span>
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
            <div class="pill-group" id="it-fc-count-pills">
              ${['5','10','20','auto'].map(v => `<button class="pill${v===countVal?' pill-active':''}" data-value="${v}" type="button">${v}</button>`).join('')}
            </div>
            <input type="number" id="it-fc-custom-count" class="custom-count-input" min="1" max="200" placeholder="or #">
          </div>
        </div>
        <div class="inline-tool-row">
          <span class="inline-tool-label">Card types</span>
          <div class="pill-group flashcard-type-pills" id="it-fc-card-type-pills" data-multi-select="true">
            ${typeOptions.map(([value, label]) => {
            const active = typeVals.includes(value) || (value === 'auto' && typeVals.includes('auto'));
            return `<button class="pill${active ? ' pill-active' : ''}" data-value="${value}" type="button" aria-pressed="${active ? 'true' : 'false'}">${label}</button>`;
          }).join('')}
          </div>
        </div>
        <div class="inline-tool-row">
          <label class="auto-follow-toggle" title="Include cards that drill formulas and notation">
            <input type="checkbox" id="it-fc-formulas-cb"${formulasOn?' checked':''}>
            <span class="toggle-thumb"></span>
            <span class="toggle-label">Include formula cards</span>
          </label>
        </div>
        <div class="inline-tool-row">
          <span class="inline-tool-label">Language</span>
          ${_inlineLangSelectHtml('it-fc-lang-select')}
        </div>
        ${_toolThinkingRowHtml('it-fc-thinking-select', 'flashcards')}
        <button id="it-fc-generate-btn" class="primary-btn" type="button">
          <span class="btn-text">Generate Flashcards</span>
          <span class="btn-spinner" style="display:none"></span>
        </button>
        <p class="error-msg" id="it-fc-error" style="display:none"></p>
      `;
    initPillGroup('it-fc-count-pills');
    initFlashcardTypePills('it-fc-card-type-pills');
    body.querySelector('#it-fc-generate-btn').addEventListener('click', () => runToolGeneration({
      type: 'FLASHCARDS_REQUEST',
      thinkingKey: 'flashcards',
      buttonId: 'it-fc-generate-btn',
      errorId: 'it-fc-error',
      buildPrompt: () => promptForFlashcards(guide, readFlashcardOptions(INLINE_TOOL_IDS.flashcards)),
      onSuccess: (data) => {
        acceptFlashcards(data);
        body.innerHTML = '';
        _renderInlineFlashcardResults(body);
      }
    }));
  }
}

function _renderInlineFlashcardResults(body) {
  body.innerHTML = `
      <div class="inline-fc-header">
        <div class="inline-fc-header-titles">
          <span id="it-fc-count-label" class="inline-fc-count">${flashcardData.length} card${flashcardData.length !== 1 ? 's' : ''}</span>
          <span id="it-fc-deck-title-label" class="flashcard-deck-title-label"${flashcardDeckTitle ? '' : ' hidden'}>${flashcardDeckTitle ? `Deck: ${escHtml(flashcardDeckTitle)}` : ''}</span>
        </div>
        <div style="display:flex;gap:6px">
          <button id="it-fc-tsv-btn" class="history-load-btn" type="button">Export TSV</button>
          <button id="it-fc-anki-btn" class="history-load-btn" type="button" title="Send to Anki (Subject::AI deck title)">Send to Anki</button>
          <button id="it-fc-regen-btn" class="history-load-btn" type="button">Regenerate</button>
        </div>
      </div>
      <div class="flashcard-nav">
        <button id="it-fc-prev-btn" class="block-nav-btn" type="button" disabled aria-label="Previous card">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <span id="it-fc-counter" class="flashcard-nav-counter">1 / ${flashcardData.length}</span>
        <button id="it-fc-next-btn" class="block-nav-btn" type="button" aria-label="Next card">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
        </button>
      </div>
      <div id="it-fc-card" class="flashcard-item"></div>
    `;
  const renderCard = idx => {
    flashcardIndex = Math.max(0, Math.min(idx, flashcardData.length - 1));
    const card = flashcardData[flashcardIndex];
    const counter = body.querySelector('#it-fc-counter');
    if (counter) counter.textContent = `${flashcardIndex + 1} / ${flashcardData.length}`;
    body.querySelector('#it-fc-prev-btn').disabled = flashcardIndex === 0;
    body.querySelector('#it-fc-next-btn').disabled = flashcardIndex === flashcardData.length - 1;
    const el = body.querySelector('#it-fc-card');
    el.innerHTML = `
        <div class="flashcard-side flashcard-front">
          <div class="flashcard-side-label">Front</div>
          <div class="flashcard-text">${richTextHtml(card.front)}</div>
        </div>
        <div class="flashcard-side flashcard-back">
          <div class="flashcard-side-label">Back</div>
          <div class="flashcard-text">${richTextHtml(card.back)}</div>
        </div>
        ${renderFlashcardMetadata(card)}
        <div class="flashcard-actions"><span class="flashcard-ask-slot"></span></div>`;
    el.querySelectorAll('.flashcard-text').forEach(t => applyKatex(t));
    const askSlot = el.querySelector('.flashcard-ask-slot');
    if (askSlot) {
      askSlot.innerHTML = '';
      appendToolAskButton(askSlot, 'flashcard', flashcardIndex);
    }
  };
  renderCard(flashcardIndex);
  body.querySelector('#it-fc-prev-btn').addEventListener('click', () => renderCard(flashcardIndex - 1));
  body.querySelector('#it-fc-next-btn').addEventListener('click', () => renderCard(flashcardIndex + 1));
  body.querySelector('#it-fc-tsv-btn').addEventListener('click', exportFlashcardsAsTSV);
  body.querySelector('#it-fc-anki-btn').addEventListener('click', sendFlashcardsToAnki);
  body.querySelector('#it-fc-regen-btn').addEventListener('click', () => {
    flashcardData = [];
    flashcardDeckTitle = null;
    flashcardIndex = 0;
    persistToolOutputs();
    body.innerHTML = '';
    _buildInlineFlashcards(body);
  });
}

/** Build the Quiz inline panel body */
function _buildInlineQuiz(body) {
  if (quizState) {
    body.innerHTML = `<p style="color:var(--text-muted);font-size:12px">Quiz is in progress in the Tools tab.</p>
        <button class="primary-btn" type="button" id="it-quiz-goto">Open Quiz →</button>`;
    body.querySelector('#it-quiz-goto')?.addEventListener('click', () => { openToolSection('tool-quiz'); closeInlineToolPanel(); });
    return;
  }
  const typeVal  = getActivePillValue('quiz-type-pills') || 'mixed';
  const countVal = getActivePillValue('quiz-count-pills') || '10';
  body.innerHTML = `
      <div class="inline-tool-row">
        <span class="inline-tool-label">Questions</span>
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
          <div class="pill-group" id="it-quiz-count-pills">
            ${['5','10','20'].map(v => `<button class="pill${v===countVal?' pill-active':''}" data-value="${v}" type="button">${v}</button>`).join('')}
          </div>
          <input type="number" id="it-quiz-custom-count" class="custom-count-input" min="1" max="50" placeholder="or #">
        </div>
      </div>
      <div class="inline-tool-row">
        <span class="inline-tool-label">Type</span>
        <div class="pill-group" id="it-quiz-type-pills">
          <button class="pill${typeVal==='mc'?' pill-active':''}" data-value="mc" type="button">Multiple Choice</button>
          <button class="pill${typeVal==='sa'?' pill-active':''}" data-value="sa" type="button">Short Answer</button>
          <button class="pill${typeVal==='mixed'?' pill-active':''}" data-value="mixed" type="button">Mixed</button>
        </div>
      </div>
      <div class="inline-tool-row">
        <span class="inline-tool-label">Language</span>
        ${_inlineLangSelectHtml('it-quiz-lang-select')}
      </div>
      ${_toolThinkingRowHtml('it-quiz-thinking-select', 'quiz')}
      <button id="it-quiz-start-btn" class="primary-btn" type="button">
        <span class="btn-text">Start Quiz</span><span class="btn-spinner" style="display:none"></span>
      </button>
      <p class="error-msg" id="it-quiz-error" style="display:none"></p>
    `;
  initPillGroup('it-quiz-count-pills');
  initPillGroup('it-quiz-type-pills');
  body.querySelector('#it-quiz-start-btn').addEventListener('click', () => runToolGeneration({
    type: 'QUIZ_REQUEST',
    thinkingKey: 'quiz',
    buttonId: 'it-quiz-start-btn',
    errorId: 'it-quiz-error',
    buildPrompt: () => promptForQuiz(guide, readQuizOptions(INLINE_TOOL_IDS.quiz)),
    onSuccess: (data) => {
      openToolSection('tool-quiz');
      startQuiz(data?.questions || []);
      closeInlineToolPanel();
    }
  }));
}

/** Build the Exam Questions inline panel body */
function _buildInlineExam(body) {
  if (examQuestionData.length) {
    body.innerHTML = `
        <div class="feature-result-header" style="margin-bottom:8px">
          <span class="inline-fc-count">${examQuestionData.length} question${examQuestionData.length !== 1 ? 's' : ''}</span>
        </div>
        <div id="it-exam-results"></div>
      `;
    renderExamQuestionList('it-exam-results', examQuestionData);
    return;
  }
  const scopeVal  = getActivePillValue('exam-scope-pills') || 'whole';
  const depthVal  = getActivePillValue('exam-depth-pills') || 'deep';
  const diffVal   = getActivePillValue('exam-difficulty-pills') || 'mixed';
  const fmtVal    = getActivePillValue('exam-format-pills') || 'open';
  const ansVal    = getActivePillValue('exam-answer-pills') || 'medium';
  const countVal  = getActivePillValue('exam-count-pills') || '5';
  body.innerHTML = `
      <div class="inline-tool-row">
        <span class="inline-tool-label">Scope</span>
        <div class="pill-group" id="it-exam-scope-pills">
          <button class="pill${scopeVal==='whole'?' pill-active':''}" data-value="whole" type="button">Whole guide</button>
          <button class="pill${scopeVal==='current'?' pill-active':''}" data-value="current" type="button">Current block</button>
          <button class="pill${scopeVal==='select'?' pill-active':''}" data-value="select" type="button">Select blocks…</button>
        </div>
      </div>
      <div id="it-exam-block-select-area" style="display:none;flex-direction:column;gap:4px;margin-left:62px"></div>
      <div class="inline-tool-row">
        <span class="inline-tool-label">Difficulty</span>
        <div class="pill-group" id="it-exam-difficulty-pills">
          <button class="pill${diffVal==='easy'?' pill-active':''}" data-value="easy" type="button">Easy</button>
          <button class="pill${diffVal==='mixed'?' pill-active':''}" data-value="mixed" type="button">Mixed</button>
          <button class="pill${diffVal==='hard'?' pill-active':''}" data-value="hard" type="button">Hard</button>
        </div>
      </div>
      <div class="inline-tool-row">
        <span class="inline-tool-label">Format</span>
        <div class="pill-group" id="it-exam-format-pills">
          <button class="pill${fmtVal==='open'?' pill-active':''}" data-value="open" type="button">Open</button>
          <button class="pill${fmtVal==='mc'?' pill-active':''}" data-value="mc" type="button">MC</button>
          <button class="pill${fmtVal==='proof'?' pill-active':''}" data-value="proof" type="button">Proof</button>
          <button class="pill${fmtVal==='mixed'?' pill-active':''}" data-value="mixed" type="button">Mixed</button>
        </div>
      </div>
      <div class="inline-tool-row">
        <span class="inline-tool-label">Depth</span>
        <div class="pill-group" id="it-exam-depth-pills">
          <button class="pill${depthVal==='surface'?' pill-active':''}" data-value="surface" type="button">Surface</button>
          <button class="pill${depthVal==='deep'?' pill-active':''}" data-value="deep" type="button">Deep</button>
          <button class="pill${depthVal==='research'?' pill-active':''}" data-value="research" type="button">Research</button>
        </div>
      </div>
      <div class="inline-tool-row">
        <span class="inline-tool-label">Answer</span>
        <div class="pill-group" id="it-exam-answer-pills">
          <button class="pill${ansVal==='short'?' pill-active':''}" data-value="short" type="button">Short</button>
          <button class="pill${ansVal==='medium'?' pill-active':''}" data-value="medium" type="button">Medium</button>
          <button class="pill${ansVal==='long'?' pill-active':''}" data-value="long" type="button">Long</button>
        </div>
      </div>
      <div class="inline-tool-row">
        <span class="inline-tool-label">Questions</span>
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
          <div class="pill-group" id="it-exam-count-pills">
            <button class="pill${countVal==='3'?' pill-active':''}" data-value="3" type="button">3</button>
            <button class="pill${countVal==='5'?' pill-active':''}" data-value="5" type="button">5</button>
            <button class="pill${countVal==='10'?' pill-active':''}" data-value="10" type="button">10</button>
            <button class="pill${countVal==='per-block'?' pill-active':''}" data-value="per-block" type="button">Per block</button>
          </div>
          <input type="number" id="it-exam-custom-count" class="custom-count-input" min="1" max="30" placeholder="or #">
        </div>
      </div>
      <div class="inline-tool-row">
        <span class="inline-tool-label">Language</span>
        ${_inlineLangSelectHtml('it-exam-lang-select')}
      </div>
      ${_toolThinkingRowHtml('it-exam-thinking-select', 'exam')}
      <button id="it-exam-gen-btn" class="primary-btn" type="button">
        <span class="btn-text">Generate Questions</span><span class="btn-spinner" style="display:none"></span>
      </button>
      <p class="error-msg" id="it-exam-error" style="display:none"></p>
      <div id="it-exam-results"></div>
    `;
  initPillGroup('it-exam-scope-pills');
  initPillGroup('it-exam-difficulty-pills');
  initPillGroup('it-exam-depth-pills');
  initPillGroup('it-exam-format-pills');
  initPillGroup('it-exam-answer-pills');
  initPillGroup('it-exam-count-pills');

  // Populate + toggle block checkboxes
  const blockArea = body.querySelector('#it-exam-block-select-area');
  if (guide?.guide?.length) {
    guide.guide.forEach((block, i) => {
      const row = document.createElement('label');
      row.className = 'exam-block-checkbox-row';
      row.innerHTML = `<input type="checkbox" value="${i}" checked><span class="toggle-thumb"></span><span class="exam-block-cb-label">${escHtml(`${i+1}. ${block.title}`)}</span>`;
      blockArea.appendChild(row);
    });
  }
  const toggleBlockArea = () => {
    const isSelect = getActivePillValue('it-exam-scope-pills') === 'select';
    blockArea.style.display = isSelect ? 'flex' : 'none';
  };
  body.querySelector('#it-exam-scope-pills').addEventListener('click', toggleBlockArea);
  if (scopeVal === 'select') blockArea.style.display = 'flex';

  /** Which block titles the scope pills currently select. */
  const selectedExamBlocks = () => {
    const scope = getActivePillValue('it-exam-scope-pills') || 'whole';
    const allTitles = guide.guide.map(b => b.title);
    if (scope === 'current') {
      const block = guide.guide[Math.max(0, currentBlockIndex)];
      return block ? [block.title] : allTitles;
    }
    if (scope === 'select') {
      const checked = [...blockArea.querySelectorAll('input[type=checkbox]:checked')]
        .map(c => guide.guide[parseInt(c.value, 10)]?.title)
        .filter(Boolean);
      return checked.length ? checked : allTitles;
    }
    return allTitles;
  };

  body.querySelector('#it-exam-gen-btn').addEventListener('click', () => {
    const resDiv = body.querySelector('#it-exam-results');
    if (resDiv) resDiv.innerHTML = '';
    return runToolGeneration({
      type: 'EXAM_QUESTIONS_REQUEST',
      thinkingKey: 'exam',
      buttonId: 'it-exam-gen-btn',
      errorId: 'it-exam-error',
      buildPrompt: () => promptForExam(
        guide, selectedExamBlocks(), readExamOptions(INLINE_TOOL_IDS.exam)
      ),
      onSuccess: (data) => {
        // Storing the questions is what the inline copy used to skip, so they
        // vanished on reload while the Tools-tab copy kept them.
        renderExamQuestionList('it-exam-results', acceptExamQuestions(data));
      }
    });
  });
}
