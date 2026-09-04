/**
 * sidebar/quiz-exam.js — Quiz, exam-question, and cross-lecture prediction features.
 *
 * Part of the sidebar, loaded as a plain script in the order listed in
 * sidebar.html. All sidebar modules share one global scope on purpose:
 * it is what lets each file be a straight move out of the old sidebar.js.
 */

// ─── Quiz feature ─────────────────────────────────────────────────────────

function showQuizPanel(panel) {
  const qs = document.getElementById('quiz-settings');
  const qa = document.getElementById('quiz-active');
  const qr = document.getElementById('quiz-results');
  if (qs) qs.style.display = panel === 'settings' ? 'flex' : 'none';
  if (qa) qa.style.display = panel === 'active'   ? 'flex' : 'none';
  if (qr) qr.style.display = panel === 'results'  ? 'flex' : 'none';
  if (panel === 'settings') {
    const errEl = document.getElementById('quiz-error');
    if (errEl) errEl.style.display = 'none';
  }
}

async function generateQuiz() {
  await runToolGeneration({
    type: 'QUIZ_REQUEST',
    thinkingKey: 'quiz',
    buttonId: 'quiz-generate-btn',
    errorId: 'quiz-error',
    buildPrompt: () => promptForQuiz(guide, readQuizOptions(TAB_TOOL_IDS.quiz)),
    onSuccess: (data) => {
      startQuiz(data?.questions || []);
    }
  });
}

/** Validate, store and start a generated quiz. Both copies land here. */
function startQuiz(questions) {
  if (!questions.length) throw new Error('No quiz questions returned. Try different settings.');
  quizState = {
    questions,
    currentIndex: 0,
    scores: new Array(questions.length).fill(null),
    done: false
  };
  quizData = questions;
  showQuizPanel('active');
  renderQuizQuestion();
  persistToolOutputs();
}

function renderQuizQuestion() {
  if (!quizState) return;
  const { questions, currentIndex } = quizState;
  const q = questions[currentIndex];
  if (!q) return;

  const total = questions.length;
  const pct = Math.round((currentIndex / total) * 100);
  const counter = document.getElementById('quiz-q-counter');
  const fill = document.getElementById('quiz-progress-fill');
  if (counter) counter.textContent = `${currentIndex + 1} / ${total}`;
  if (fill) fill.style.width = `${pct}%`;

  const qText = document.getElementById('quiz-question-text');
  if (qText) {
    setRichTextHtml(qText, q.question);
  }

  const mcArea = document.getElementById('quiz-mc-options');
  const saArea = document.getElementById('quiz-sa-area');
  const revealBtn = document.getElementById('quiz-reveal-btn');
  const submitMcBtn = document.getElementById('quiz-submit-mc-btn');
  const answerReveal = document.getElementById('quiz-answer-reveal');

  if (answerReveal) answerReveal.style.display = 'none';
  const nextBtn = document.getElementById('quiz-next-btn');
  if (nextBtn) nextBtn.style.display = 'none';

  if (q.type === 'mc') {
    saArea.style.display = 'none';
    revealBtn.style.display = 'none';
    submitMcBtn.style.display = '';
    mcArea.style.display = 'flex';
    mcArea.innerHTML = '';
    const _LETTERS = ['A','B','C','D','E','F'];
    (q.options || []).forEach((opt, i) => {
      const btn = document.createElement('button');
      btn.className = 'quiz-mc-option';
      btn.dataset.optionIndex = i;
      btn.type = 'button';
      btn.innerHTML = `<span class="quiz-mc-letter">${_LETTERS[i] || i+1}</span><span class="quiz-mc-text"></span>`;
      setRichInlineHtml(btn.querySelector('.quiz-mc-text'), opt);
      btn.addEventListener('click', () => {
        mcArea.querySelectorAll('.quiz-mc-option').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
      });
      mcArea.appendChild(btn);
    });
  } else {
    mcArea.style.display = 'none';
    submitMcBtn.style.display = 'none';
    revealBtn.style.display = '';
    saArea.style.display = '';
    const sa = document.getElementById('quiz-sa-input');
    if (sa) sa.value = '';
  }

  const quizAskSlot = document.getElementById('quiz-ask-slot');
  if (quizAskSlot) {
    quizAskSlot.innerHTML = '';
    appendToolAskButton(quizAskSlot, 'quiz', currentIndex);
  }
}

function quizRevealAnswer() {
  if (!quizState) return;
  const q = quizState.questions[quizState.currentIndex];
  showQuizAnswerReveal(q);
}

function quizSubmitMC() {
  if (!quizState) return;
  const q = quizState.questions[quizState.currentIndex];
  const mcArea = document.getElementById('quiz-mc-options');
  const selected = mcArea?.querySelector('.quiz-mc-option.selected');
  if (!selected) {
    selected || (mcArea && (mcArea.style.border = '1px solid var(--error, red)'));
    return;
  }
  const selectedIdx = parseInt(selected.dataset.optionIndex, 10);
  const isCorrect = selectedIdx === q.correct;

  // Highlight correct/wrong
  mcArea.querySelectorAll('.quiz-mc-option').forEach((btn, i) => {
    btn.disabled = true;
    if (i === q.correct) btn.classList.add('correct');
    else if (i === selectedIdx && !isCorrect) btn.classList.add('wrong');
  });

  // Record score
  quizState.scores[quizState.currentIndex] = isCorrect;
  persistToolOutputs();
  showQuizAnswerReveal(q, isCorrect);
}

function showQuizAnswerReveal(q, isCorrect) {
  const answerReveal = document.getElementById('quiz-answer-reveal');
  const answerText = document.getElementById('quiz-answer-text');
  const explanationText = document.getElementById('quiz-explanation-text');
  const gradeRow = document.querySelector('.quiz-grade-row');

  const answer = q.answer || (q.options?.[q.correct] ? q.options[q.correct].replace(/^[A-D]\) /, '') : '');
  if (answerText) {
    setRichTextHtml(answerText, answer);
  }
  if (explanationText) {
    setRichTextHtml(explanationText, q.explanation || '');
    explanationText.style.display = q.explanation ? '' : 'none';
  }

  // For MC, grade is already determined; hide grade buttons
  if (q.type === 'mc') {
    if (gradeRow) gradeRow.style.display = 'none';
  } else {
    if (gradeRow) gradeRow.style.display = 'flex';
  }

  if (answerReveal) answerReveal.style.display = 'flex';

  // Show Next button instead of auto-advancing — let user read the answer
  const nextBtn = document.getElementById('quiz-next-btn');
  if (nextBtn) {
    nextBtn.style.display = '';
    nextBtn.onclick = () => quizGrade(isCorrect ?? true);
  }
}

function quizGrade(correct) {
  if (!quizState) return;
  const { questions, currentIndex } = quizState;
  quizState.scores[currentIndex] = correct;
  persistToolOutputs();

  const nextIndex = currentIndex + 1;
  if (nextIndex >= questions.length) {
    showQuizResults();
    return;
  }
  quizState.currentIndex = nextIndex;
  renderQuizQuestion();
}

function showQuizResults() {
  if (quizState) quizState.done = true;
  persistToolOutputs();
  showQuizPanel('results');
  const { questions, scores } = quizState;
  const correct = scores.filter(Boolean).length;
  const total   = questions.length;
  const pct     = Math.round((correct / total) * 100);

  const circle = document.getElementById('quiz-score-circle');
  const pctEl  = document.getElementById('quiz-score-pct');
  const textEl = document.getElementById('quiz-score-text');
  const encourageEl = document.getElementById('quiz-score-encouragement');

  if (pctEl) pctEl.textContent = `${pct}%`;
  if (textEl) textEl.textContent = `${correct} / ${total} correct`;

  const encouragement = pct >= 90 ? '🎉 Excellent! Exam-ready.' :
                        pct >= 70 ? '👍 Good work. Review missed questions.' :
                        pct >= 50 ? '📚 Keep studying — review the missed topics.' :
                                    '💪 Let\'s review — go back over the guide.';
  if (encourageEl) encourageEl.textContent = encouragement;

  // Color the circle by score
  if (circle) {
    circle.style.borderColor = pct >= 70 ? '#38a169' : pct >= 50 ? '#d69e2e' : '#e53e3e';
    if (pctEl) pctEl.style.color = pct >= 70 ? '#38a169' : pct >= 50 ? '#d69e2e' : '#e53e3e';
  }

  // Fill in missed questions
  const missedSection = document.getElementById('quiz-missed-section');
  const missedList    = document.getElementById('quiz-missed-list');
  const missed = questions.filter((_, i) => !scores[i]);
  if (missed.length && missedList) {
    missedSection.style.display = '';
    missedList.innerHTML = '';
    missed.forEach(q => {
      const item = document.createElement('div');
      item.className = 'quiz-missed-item';
      const answer = q.answer || (q.options?.[q.correct] ? q.options[q.correct].replace(/^[A-D]\) /, '') : '');
      item.innerHTML = `
          <div class="quiz-missed-q">${richTextHtml(q.question)}</div>
          <div class="quiz-missed-a"><strong>Answer:</strong> ${richTextHtml(answer)}</div>
        `;
      applyKatex(item);
      missedList.appendChild(item);
    });
  } else if (missedSection) {
    missedSection.style.display = 'none';
  }
}

// ─── Exam questions feature (Part 3A) ─────────────────────────────────────

function showExamPanel(panel) {
  const es = document.getElementById('exam-settings');
  const er = document.getElementById('exam-results');
  if (es) es.style.display = panel === 'settings' ? 'flex' : 'none';
  if (er) er.style.display = panel === 'results'  ? 'flex' : 'none';
  if (panel === 'settings') {
    const errEl = document.getElementById('exam-error');
    if (errEl) errEl.style.display = 'none';
  }
}

function onExamScopeChange(value) {
  const selectArea = document.getElementById('exam-block-select-area');
  if (selectArea) selectArea.style.display = value === 'select' ? '' : 'none';

  const infoRow   = document.getElementById('exam-current-block-info');
  const infoLabel = document.getElementById('exam-current-block-label');
  if (infoRow && infoLabel) {
    if (value === 'current') {
      const b = guide?.guide?.[Math.max(0, currentBlockIndex)];
      infoLabel.textContent = b?.title
        ? `Block ${currentBlockIndex + 1}: ${b.title}`
        : 'No block selected yet';
      infoRow.style.display = '';
    } else {
      infoRow.style.display = 'none';
    }
  }
}

function populateExamBlockCheckboxes() {
  const container = document.getElementById('exam-block-checkboxes');
  if (!container || !guide?.guide?.length) return;
  container.innerHTML = '';
  guide.guide.forEach((block, i) => {
    const row = document.createElement('label');
    row.className = 'exam-block-checkbox-row';
    row.innerHTML = `
        <input type="checkbox" value="${i}" checked>
        <span class="toggle-thumb"></span>
        <span class="exam-block-cb-label">${escHtml(`${i + 1}. ${block.title}`)}</span>
      `;
    container.appendChild(row);
  });
}

function getSelectedExamBlocks() {
  const scope = getActivePillValue('exam-scope-pills') || 'whole';
  if (scope === 'whole') return guide.guide.map(b => b.title);
  if (scope === 'current') {
    const b = guide.guide[Math.max(0, currentBlockIndex)];
    return b ? [b.title] : guide.guide.map(b => b.title);
  }
  // scope === 'select'
  const checks = document.querySelectorAll('#exam-block-checkboxes input[type=checkbox]:checked');
  const indices = [...checks].map(c => parseInt(c.value, 10));
  return indices.map(i => guide.guide[i]?.title).filter(Boolean);
}

async function generateExamQuestions() {
  const selectedBlocks = getSelectedExamBlocks();
  await runToolGeneration({
    type: 'EXAM_QUESTIONS_REQUEST',
    thinkingKey: 'exam',
    buttonId: 'exam-generate-btn',
    errorId: 'exam-error',
    buildPrompt: () => promptForExam(guide, selectedBlocks, readExamOptions(TAB_TOOL_IDS.exam)),
    onSuccess: (data) => {
      const questions = acceptExamQuestions(data);
      renderExamQuestionList('exam-question-list', questions);
      const countLabel = document.getElementById('exam-count-label');
      if (countLabel) {
        countLabel.textContent = `${questions.length} question${questions.length !== 1 ? 's' : ''}`;
      }
      showExamPanel('results');
    }
  });
}

function renderCrossExamTopics(topics) {
  const topicsSection = document.getElementById('cross-exam-topics-section');
  const topicsList = document.getElementById('cross-exam-topics-list');
  if (!topics?.length || !topicsList) {
    if (topicsSection) topicsSection.style.display = 'none';
    return;
  }
  topicsSection.style.display = '';
  topicsList.innerHTML = '';
  topics.forEach((t, idx) => {
    const item = document.createElement('div');
    item.className = 'cross-exam-topic-item';
    const confClass = `cross-exam-confidence-${t.confidence || 'medium'}`;
    item.innerHTML = `
        <div class="cross-exam-topic-header">
          <span class="cross-exam-topic-name">${escHtml(t.topic)}</span>
          <span class="cross-exam-confidence ${confClass}">${t.confidence || 'medium'}</span>
          <span class="cross-exam-topic-ask-slot"></span>
        </div>
        <div class="cross-exam-topic-rationale">${escHtml(t.rationale || '')}</div>
      `;
    topicsList.appendChild(item);
    appendToolAskButton(item.querySelector('.cross-exam-topic-ask-slot'), 'cross_exam_topic', idx);
  });
}

/**
 * Draws a question list. Storing and persisting is the caller's job — this
 * used to guess from the container id, which meant restoring a saved lecture
 * wrote the same questions straight back to storage.
 */
function renderExamQuestionList(containerId, questions) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';

  const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];
  const cap = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
  const examSource = containerId === 'cross-exam-question-list' ? 'cross_exam' : 'exam';

  questions.forEach((q, i) => {
    const item = document.createElement('div');
    item.className = 'exam-question-item';

    // Badges — capitalized, with softer colors via CSS classes
    const badges = [
      q.difficulty ? `<span class="exam-badge exam-badge-${q.difficulty}">${cap(q.difficulty)}</span>` : '',
      q.type       ? `<span class="exam-badge exam-badge-type">${q.type.toUpperCase()}</span>` : '',
      q.relevant_block ? `<span class="exam-badge exam-badge-block" title="Source block">${escHtml(q.relevant_block)}</span>` : ''
    ].filter(Boolean).join('');

    // MC options — lettered (A, B, C…) with NO correct-answer class yet (prevents spoiler)
    // Correct index stored in data attr; applied only when answer is revealed.
    let mcOptionsHtml = '';
    if (q.type === 'mc' && q.options?.length) {
      const opts = q.options.map((o, oi) =>
        `<div class="exam-mc-option" data-idx="${oi}">
             <span class="exam-mc-letter">${LETTERS[oi] || (oi + 1)}</span>
             <span class="exam-mc-text">${richInlineHtml(o)}</span>
           </div>`
      ).join('');
      mcOptionsHtml = `<div class="exam-mc-options" data-correct="${q.correct ?? -1}">${opts}</div>`;
    }

    // Answer text rendered as markdown (supports bold, bullet lists, etc.) + LaTeX
    const answerHtml = richTextHtml(q.sample_answer || '');

    item.innerHTML = `
        <div class="exam-question-head">
          <div class="exam-question-num">${i + 1}</div>
          <div class="exam-question-main">
            ${badges ? `<div class="exam-question-badges">${badges}</div>` : ''}
            <div class="exam-question-text"></div>
          </div>
        </div>
        ${mcOptionsHtml}
        <div class="exam-answer-section">
          <button class="exam-answer-toggle" type="button" aria-expanded="false">
            <svg class="exam-toggle-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
            Show model answer
          </button>
          <div class="exam-answer-content" hidden>
            <div class="exam-answer-body">${answerHtml}</div>
          </div>
        </div>
        <div class="exam-question-actions"><span class="exam-ask-slot"></span></div>
      `;

    // Render question text as markdown then apply KaTeX
    const qTextEl = item.querySelector('.exam-question-text');
    setRichTextHtml(qTextEl, q.question);

    // Apply KaTeX to each MC option text span (markdown already rendered in innerHTML)
    item.querySelectorAll('.exam-mc-text').forEach(el => applyKatex(el));

    const toggle      = item.querySelector('.exam-answer-toggle');
    const answerContent = item.querySelector('.exam-answer-content');
    const mcOptions   = item.querySelector('.exam-mc-options');
    const chevron     = toggle?.querySelector('.exam-toggle-chevron');

    toggle?.addEventListener('click', () => {
      const isShown = !answerContent.hidden;
      answerContent.hidden = isShown;
      toggle.setAttribute('aria-expanded', String(!isShown));
      toggle.querySelector('.exam-toggle-chevron').style.transform = isShown ? '' : 'rotate(180deg)';
      toggle.childNodes[toggle.childNodes.length - 1].textContent =
        isShown ? ' Show model answer' : ' Hide model answer';

      // Reveal / hide the correct MC option highlight
      if (mcOptions) {
        const correctIdx = parseInt(mcOptions.dataset.correct ?? '-1', 10);
        mcOptions.querySelectorAll('.exam-mc-option').forEach((opt, idx) => {
          opt.classList.toggle('exam-correct-option', !isShown && idx === correctIdx);
        });
      }

      // Apply KaTeX to answer body on first reveal
      const answerBody = answerContent.querySelector('.exam-answer-body');
      if (!isShown && answerBody && !answerBody.dataset.katexDone) {
        answerBody.dataset.katexDone = '1';
        applyKatex(answerBody);
      }
    });

    appendToolAskButton(item.querySelector('.exam-ask-slot'), examSource, i);
    container.appendChild(item);
  });
}

// ─── Cross-lecture exam prediction (Part 3B) ──────────────────────────────

/** Open cross-exam section pre-filtered to a course group (called from history "Predict" button). */
function openCrossExamModalForCourse(courseEntries) {
  showCrossExamPanel('settings');
  openToolSection('tool-cross-exam');
  // Load full history, render grouped, then auto-check only entries in courseEntries
  const targetUrls = new Set((courseEntries || []).map(e => normalizeLectureUrl(e.lectureUrl)));
  _populateCrossExamGrouped({ preselectUrls: targetUrls });
}

function showCrossExamPanel(panel) {
  const cs = document.getElementById('cross-exam-settings');
  const cr = document.getElementById('cross-exam-results');
  if (cs) cs.style.display = panel === 'settings' ? 'flex' : 'none';
  if (cr) cr.style.display = panel === 'results'  ? 'flex' : 'none';
  if (panel === 'settings') {
    const errEl = document.getElementById('cross-exam-error');
    if (errEl) errEl.style.display = 'none';
  }
}

/**
 * Render the cross-exam lecture picker as a grouped (by course) list,
 * mirroring the History panel layout.
 * @param {{ preselectUrls?: Set<string> }} opts
 *   preselectUrls — if provided, only those lecture URLs will be pre-checked.
 *                   If omitted, nothing is pre-checked.
 */
function _populateCrossExamGrouped({ preselectUrls } = {}) {
  const listEl = document.getElementById('cross-exam-lecture-list');
  if (!listEl) return;
  listEl.innerHTML = '<p style="color:var(--text-muted);font-size:11.5px">Loading…</p>';

  chrome.storage.local.get(['guideHistory'], res => {
    const history      = Array.isArray(res.guideHistory) ? res.guideHistory : [];
    const validEntries = history.filter(e => e?.guide?.guide?.length && e?.lectureTitle);

    if (!validEntries.length) {
      listEl.innerHTML = '<p style="color:var(--text-muted);font-size:11.5px">No guides in history yet. Generate guides for at least 2 lectures first.</p>';
      return;
    }

    // Store flat array for lookup during generation
    listEl._allHistory = validEntries;

    // ── Group by courseKey ──────────────────────────────────────────────
    const groups = {};
    validEntries.forEach((entry, globalIdx) => {
      const k = entry.courseKey || deriveCourseKeyFromUrl(entry.lectureUrl) || 'other';
      if (!groups[k]) groups[k] = { courseName: entry.courseName || k, entries: [] };
      groups[k].entries.push({ entry, globalIdx });
    });

    // Sort courses: current-lecture's course first, then alpha
    const activeCourseKey = transcript?.courseKey || deriveCourseKeyFromUrl(currentLectureUrl);
    const sortedKeys = Object.keys(groups).sort((a, b) => {
      if (a === activeCourseKey) return -1;
      if (b === activeCourseKey) return  1;
      return groups[a].courseName.localeCompare(groups[b].courseName);
    });

    listEl.innerHTML = '';

    for (const k of sortedKeys) {
      const g = groups[k];
      // Sort entries newest-first within course
      g.entries.sort((a, b) => {
        const da = a.entry.lectureDate || a.entry.date || '';
        const db = b.entry.lectureDate || b.entry.date || '';
        return db.localeCompare(da);
      });

      const groupDiv = document.createElement('div');
      groupDiv.className = 'cross-exam-course-group';

      // Course header with "Select all" checkbox
      const header = document.createElement('div');
      header.className = 'cross-exam-course-header';
      const selectAllId = `cross-exam-selall-${k}`;
      header.innerHTML = `
          <label class="cross-exam-course-selall" title="Select / deselect all in this course">
            <input type="checkbox" id="${escHtml(selectAllId)}" class="cross-exam-selall-cb">
            <span class="toggle-thumb"></span>
          </label>
          <span class="cross-exam-course-name">${escHtml(g.courseName)}</span>
          <span class="cross-exam-course-count">${g.entries.length} lecture${g.entries.length !== 1 ? 's' : ''}</span>
        `;
      groupDiv.appendChild(header);

      const rowsDiv = document.createElement('div');
      rowsDiv.className = 'cross-exam-course-rows';

      const rowCheckboxes = [];

      g.entries.forEach(({ entry, globalIdx }) => {
        const isPreselected = preselectUrls
          ? preselectUrls.has(normalizeLectureUrl(entry.lectureUrl))
          : false;
        const dateStr = entry.lectureDate
          ? new Date(entry.lectureDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
          : (entry.guideDate ? new Date(entry.guideDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '');
        const numLabel = entry.lectureNumber ? `#${entry.lectureNumber} · ` : '';
        const cbId = `cross-exam-cb-${globalIdx}`;

        const row = document.createElement('label');
        row.className = 'cross-exam-lecture-row';
        row.setAttribute('for', cbId);
        row.innerHTML = `
            <input type="checkbox" id="${cbId}" data-idx="${globalIdx}"${isPreselected ? ' checked' : ''}>
            <span class="toggle-thumb"></span>
            <div class="cross-exam-lecture-info">
              <div class="cross-exam-lecture-title">${escHtml(getHistoryDisplayTitle(entry))}</div>
              ${dateStr ? `<div class="cross-exam-lecture-meta">${numLabel}${escHtml(dateStr)}</div>` : ''}
            </div>
          `;
        const cb = row.querySelector('input');
        cb.addEventListener('change', () => {
          _syncCrossExamGroupHeader(header, rowCheckboxes);
          updateCrossExamGenerateBtn();
        });
        rowCheckboxes.push(cb);
        rowsDiv.appendChild(row);
      });

      // Wire select-all checkbox and set initial header state
      const selectAllCb = header.querySelector('.cross-exam-selall-cb');
      selectAllCb.addEventListener('change', () => {
        rowCheckboxes.forEach(cb => { cb.checked = selectAllCb.checked; });
        updateCrossExamGenerateBtn();
      });

      groupDiv.appendChild(rowsDiv);
      listEl.appendChild(groupDiv);

      // Sync indeterminate/checked state based on current row selections
      _syncCrossExamGroupHeader(header, rowCheckboxes);
    }

    updateCrossExamGenerateBtn();
  });
}

/** Sync the "select all" checkbox state (checked/indeterminate) based on row states */
function _syncCrossExamGroupHeader(header, rowCheckboxes) {
  const selAllCb = header.querySelector('.cross-exam-selall-cb');
  if (!selAllCb) return;
  const total   = rowCheckboxes.length;
  const checked = rowCheckboxes.filter(c => c.checked).length;
  selAllCb.checked       = checked === total;
  selAllCb.indeterminate = checked > 0 && checked < total;
}

/** Kept for backward compatibility (called from Tools tab click) */
function populateCrossExamLectureList() {
  _populateCrossExamGrouped({});
}

function updateCrossExamGenerateBtn() {
  const generateBtn = document.getElementById('cross-exam-generate-btn');
  if (!generateBtn) return;
  const checked = document.querySelectorAll('#cross-exam-lecture-list input[data-idx]:checked').length;
  generateBtn.disabled = checked < 2;
  const btnText = generateBtn.querySelector('.btn-text');
  if (btnText) btnText.textContent = checked < 2
    ? `Predict Exam Questions (select ≥2 lectures)`
    : `Predict Exam Questions (${checked} lectures)`;
}

async function generateCrossLecturePrediction() {
  if (!hasUsableSettings()) return;

  const listEl = document.getElementById('cross-exam-lecture-list');
  const history = listEl?._allHistory;
  if (!history) return;

  // Only count checkboxes that have data-idx (lecture rows, not "select all" checkboxes)
  const checkedInputs = [...document.querySelectorAll('#cross-exam-lecture-list input[data-idx]:checked')];
  const selectedIndices = checkedInputs.map(inp => parseInt(inp.dataset.idx, 10));
  if (selectedIndices.length < 2) return;

  const selectedEntries = selectedIndices.map(i => history[i]).filter(Boolean);
  const lectures = selectedEntries.map(e => ({ lectureTitle: e.lectureTitle, guide: e.guide }));

  const difficulty = getActivePillValue('cross-exam-difficulty-pills') || 'mixed';
  const format     = getActivePillValue('cross-exam-format-pills') || 'open';
  const customCountEl = document.getElementById('cross-exam-custom-count');
  const customCountRaw = parseInt(customCountEl?.value?.trim() || '', 10);
  const count = (!isNaN(customCountRaw) && customCountRaw > 0)
    ? customCountRaw
    : parseInt(getActivePillValue('cross-exam-count-pills') || '5', 10);

  const btn = document.getElementById('cross-exam-generate-btn');
  const errEl = document.getElementById('cross-exam-error');
  setFeatureBtnLoading(btn, true);
  errEl.style.display = 'none';

  try {
    const language = getToolLanguage('cross-exam-lang-select');
    const systemPrompt = buildCrossLecturePredictionPrompt(lectures, { difficulty, format, count, language });
    const payload = {
      ...buildApiPayloadBase(),
      type: 'CROSS_LECTURE_EXAM_REQUEST',
      toolThinking: getToolThinking('exam'),
      guidesJson: lectures,
      systemPrompt
    };
    const resp = await apiRequest(payload);
    if (!resp.success) throw new Error(resp.error);
    const data = resp.data || {};

    crossExamTopics = data.exam_topics || [];
    renderCrossExamTopics(crossExamTopics);

    // Render questions
    const questions = data.questions || [];
    if (!questions.length) throw new Error('No predictions returned. Try different settings.');
    crossExamQuestionData = questions;
    persistToolOutputs();
    renderExamQuestionList('cross-exam-question-list', questions);
    const countLabel = document.getElementById('cross-exam-count-label');
    if (countLabel) countLabel.textContent = `${questions.length} question${questions.length !== 1 ? 's' : ''}`;
    showCrossExamPanel('results');
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = '';
  } finally {
    setFeatureBtnLoading(btn, false);
  }
}
