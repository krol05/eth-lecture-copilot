/**
 * sidebar/guide.js — Transcript intake and guide generation — prompts, generate, regenerate.
 *
 * Part of the sidebar, loaded as a plain script in the order listed in
 * sidebar.html. All sidebar modules share one global scope on purpose:
 * it is what lets each file be a straight move out of the old sidebar.js.
 */

// ─── Transcript Handling ──────────────────────────────────────────────────

function handleTranscriptStatus(msg) {
  switch (msg.status) {
    case 'extracting':
      setStatus('loading', 'Extracting transcript…');
      break;
    case 'no_event_id':
      setStatus('warning', 'No event ID found — paste transcript manually');
      showManualPasteOption();
      break;
    case 'no_captions':
      setStatus('warning', 'No captions found for this lecture');
      showManualPasteOption();
      break;
    case 'error':
      setStatus('error', 'Transcript error: ' + (msg.error || 'unknown'));
      // The full detail goes to the error panel, which can offer a fix when
      // the cause is a media host we have not been granted yet.
      if (msg.errorDetail) {
        try { ErrorPanel.report(msg.errorDetail); } catch { /* panel optional */ }
      }
      showManualPasteOption();
      break;
  }
}

function handleTranscriptReady(msg) {
  if (msg.lectureUrl) currentLectureUrl = msg.lectureUrl;
  transcript = {
    cues:          msg.cues,
    text:          msg.transcriptText,
    lectureTitle:  msg.lectureTitle,
    lectureUrl:    msg.lectureUrl || currentLectureUrl,
    videoDuration: msg.videoDuration,
    lectureDate:   msg.lectureDate  || null,
    courseKey:     msg.courseKey    || null,
    courseName:    msg.courseName   || null,
  };
  storageSet({
    currentTranscript: transcript,
    currentLectureUrl: currentLectureUrl
  });
  if (currentLectureUrl && !scriptCourseId) {
    initScriptsForCourse(currentLectureUrl);
  }
  if (guide?.guide?.length) {
    setStatus('ready', `Guide ready · ${guide.guide.length} blocks · ${msg.cues.length} cues`);
  } else {
    setStatus('ready', `Transcript loaded · ${msg.cues.length} cues`);
  }
  updateGenerateButton();
}

function showManualPasteOption() {
  const existing = document.getElementById('manual-paste-section');
  if (existing) return;

  const section = document.createElement('div');
  section.id = 'manual-paste-section';
  section.style.cssText = 'padding: 12px 14px; border-top: 1px solid var(--border); position: relative;';
  section.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
        <p class="section-label" style="margin:0;">Manual Transcript</p>
        <button id="close-manual-btn" style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:16px;line-height:1;padding:2px 4px;" title="Close">&times;</button>
      </div>
      <textarea id="manual-transcript" placeholder="Paste transcript here (plain text with optional [HH:MM:SS] timestamps)…"
        style="width:100%;height:120px;resize:vertical;background:var(--bg-2);border:1px solid var(--border);
               border-radius:8px;color:var(--text-primary);font-size:12px;padding:8px;outline:none;font-family:inherit;"></textarea>
      <button id="use-manual-btn" class="primary-btn" style="margin-top: 8px; font-size:12px; padding:7px 14px;">
        Use this transcript
      </button>
    `;
  document.getElementById('tab-guide').insertBefore(section, guideEmpty);

  document.getElementById('close-manual-btn').addEventListener('click', () => {
    section.remove();
  });

  document.getElementById('use-manual-btn').addEventListener('click', () => {
    const text = document.getElementById('manual-transcript').value.trim();
    if (!text) return;
    transcript = {
      cues: [],
      text,
      lectureTitle: document.title || 'Lecture',
      lectureUrl: currentLectureUrl,
      videoDuration: 0
    };
    section.remove();
    setStatus('ready', 'Manual transcript loaded');
    updateGenerateButton();
  });
}

// ─── Guide Generation ─────────────────────────────────────────────────────

function updateGenerateButton() {
  const hasTranscript = transcript && transcript.text;
  const hasSettings = hasUsableSettings();
  generateBtn.disabled = !hasTranscript || !hasSettings || isGenerating;

  if (!hasSettings) {
    generateBtn.title = 'Set your API key in the extension popup first';
  }
  updateGuideAbortBtn();
  updateLectureSummaryBtn();
}

function updateGuideAbortBtn() {
  const btn = document.getElementById('guide-abort-btn');
  if (btn) btn.hidden = !isGenerating;
  const contentAbortBtn = document.getElementById('guide-content-abort-btn');
  if (contentAbortBtn) contentAbortBtn.hidden = !isGenerating;
}

function abortGuideGeneration() {
  if (!_activeGuideAbortFn) return;
  _activeGuideAbortFn();
  _activeGuideAbortFn = null;
}

async function onGenerateClick() {
  if (isGenerating || !transcript || !hasUsableSettings()) return;
  isGenerating = true;

  // Reset streaming state so incremental rendering starts fresh
  guideScanner = createGuideBlockScanner();
  clearStreamingBar();
  // If a previous partial/streamed guide exists, clear it so the new stream starts from block 0
  if (guide && guide.guide) guide.guide = [];

  generateBtn.disabled = true;
  generateBtn.querySelector('.btn-text').textContent = 'Generating…';
  generateBtn.querySelector('.btn-spinner').style.display = 'inline-block';
  generateError.style.display = 'none';
  setStatus('loading', 'Generating guide…');

  const useFallback = !!genFallbackCb?.checked;
  const guideTemperature = useFallback ? null : (genTempSlider ? genTempSlider.value / 100 : null);
  const guideThinking = useFallback ? 'none' : (genThinkingSel?.value || 'none');
  const guideDetail = genDetailSel?.value || 'very_high';
  const guideCount = genCountSel?.value || 'very_high';
  const maxTokens = selectedGuideMaxTokens(guideCount);

  const guideLang = getSelectedLanguage();
  const guideMode = !useFallback && genModeSel?.value === 'study_flow' ? 'study_flow' : 'reliable';
  const systemPrompt = guideMode === 'study_flow'
    ? buildStudyFlowGuidePrompt(guideDetail, guideCount, guideLang)
    : buildGuidePrompt(guideDetail, guideCount, guideLang);
  // All providers support SSE streaming via the shared adapter layer.
  const supportsStream = !!settings.provider;

  const payload = {
    type: 'GENERATE_GUIDE',
    transcriptText: transcript.text,
    systemPrompt,
    provider: settings.provider,
    model: settings.model || null,
    apiKey: settings.apiKey,
    localBase: getLocalBase(),
    guideFallback: useFallback,
    guideTemperature,
    guideThinking,
    guideMaxTokens: maxTokens,
    useStream: supportsStream && !useFallback
  };

  window.CopilotDebug?.log('[Copilot] Sending GENERATE_GUIDE', {
    provider: payload.provider,
    model: payload.model,
    transcriptLen: payload.transcriptText?.length,
    hasApiKey: !!payload.apiKey,
    localBase: payload.localBase || '(none)',
    fallback: useFallback,
    temperature: guideTemperature,
    thinking: guideThinking
  });

  try {
    const guideReq = apiRequest(payload);
    _activeGuideAbortFn = guideReq.abort;
    updateGuideAbortBtn();
    const response = await guideReq;
    window.CopilotDebug?.log('[Copilot] GENERATE_GUIDE response received', { success: response.success });

    if (!response.success) throw new Error(response.error);

    clearStreamingBar();
    guide = response.data;
    guide = sanitizeGuide(guide, transcript?.lectureTitle);
    guideLanguage = guideLang;
    guide._language = guideLang;
    guide._guide_mode = guideMode;

    storageSet({
      currentGuide: guide,
      currentLectureUrl: currentLectureUrl,
      currentGuideLectureUrl: normalizeLectureUrl(currentLectureUrl)
    });
    saveToHistory();
    _syncToolLanguageSelects();
    // The replacement is on disk, so the old guide is no longer needed.
    discardedByRegenerate = null;

    setStatus('ready', `Guide ready · ${guide.guide.length} blocks`);
    showGuideContent();
    const mp = document.getElementById('manual-paste-section');
    if (mp) mp.remove();

  } catch (err) {
    console.error('[Copilot] GENERATE_GUIDE error:', err.message);
    clearStreamingBar();
    const aborted = err.message === 'Request aborted.';
    // A regenerate that never produced a guide gives the old one back rather
    // than leaving the lecture empty.
    const restored = restoreDiscardedGuide();

    if (!aborted) {
      showGuideError(err.message);
      setStatus('error', restored
        ? 'Guide generation failed · previous guide restored'
        : 'Guide generation failed');
      if (!restored) showManualPasteOption();
    } else if (restored) {
      setStatus('ready', `Generation stopped · previous guide restored`);
    } else {
      restoreMainStatus();
    }
  } finally {
    isGenerating = false;
    _activeGuideAbortFn = null;
    generateBtn.querySelector('.btn-text').textContent = 'Generate Guide';
    generateBtn.querySelector('.btn-spinner').style.display = 'none';
    updateGenerateButton();
  }
}

let _regenConfirmTimer = null;

function onRegenerateClick() {
  showRegenerateConfirmToast();
}

function hideRegenerateConfirmToast() {
  clearTimeout(_regenConfirmTimer);
  document.getElementById('regen-confirm-toast')?.remove();
  regenerateBtn.title = 'Generate a new guide';
}

function showRegenerateConfirmToast() {
  hideRegenerateConfirmToast();
  regenerateBtn.title = 'Confirm regenerate guide';

  const toast = document.createElement('div');
  toast.id = 'regen-confirm-toast';
  toast.className = 'regen-confirm-toast';
  toast.setAttribute('role', 'alertdialog');
  toast.setAttribute('aria-live', 'polite');
  toast.innerHTML = `
      <div class="regen-confirm-text">
        <strong>Regenerate guide?</strong>
        This clears the current guide, Q&amp;A and lecture summary for this lecture.
      </div>
      <div class="regen-confirm-actions">
        <button type="button" class="regen-confirm-cancel">Cancel</button>
        <button type="button" class="regen-confirm-action">Regenerate</button>
      </div>
    `;
  document.body.appendChild(toast);

  toast.querySelector('.regen-confirm-cancel')?.addEventListener('click', hideRegenerateConfirmToast);
  toast.querySelector('.regen-confirm-action')?.addEventListener('click', confirmRegenerateGuide);

  _regenConfirmTimer = setTimeout(hideRegenerateConfirmToast, 8000);
}

/**
 * Everything Regenerate is about to clear, in a form that can be put back.
 * Deep-copied because the live arrays are cleared in place a moment later.
 */
function snapshotBeforeRegenerate() {
  if (!guide) return null;
  const copy = (value) => {
    try { return structuredClone(value); } catch { return JSON.parse(JSON.stringify(value)); }
  };
  return {
    lectureUrl: normalizeLectureUrl(currentLectureUrl),
    guide: copy(guide),
    guideLanguage,
    blockIndex: currentBlockIndex,
    qaChats: copy(qaChats.map(c => ({
      id: c.id, name: c.name, messages: c.messages,
      guideSentForLectureUrl: c.guideSentForLectureUrl || null,
      summaryInContext: !!c.summaryInContext
    }))),
    lectureSummaryText,
    lectureSummarySource,
    toolOutputs: copy(buildToolOutputsSnapshot())
  };
}

/**
 * Puts back what Regenerate cleared, after the replacement failed to arrive.
 * Returns false when there is nothing to restore or it belongs to another
 * lecture, so the caller can leave the failure message alone.
 */
function restoreDiscardedGuide() {
  const saved = discardedByRegenerate;
  if (!saved) return false;
  if (saved.lectureUrl !== normalizeLectureUrl(currentLectureUrl)) return false;
  discardedByRegenerate = null;

  applyRestoredGuide(saved.guide, null, true, saved.qaChats);
  currentBlockIndex = saved.blockIndex >= 0 ? saved.blockIndex : 0;
  renderBlock(currentBlockIndex);

  if (saved.lectureSummaryText) {
    setLectureSummaryComplete(saved.lectureSummaryText, saved.lectureSummarySource || 'guide');
  }
  if (toolOutputsHasData(saved.toolOutputs)) {
    applyToolOutputsSnapshot(saved.toolOutputs);
    persistToolOutputs();
  }
  return true;
}

function confirmRegenerateGuide() {
  hideRegenerateConfirmToast();
  // Held until the new guide is safely in place — see restoreDiscardedGuide.
  discardedByRegenerate = snapshotBeforeRegenerate();
  guide = null;
  currentBlockIndex = -1;
  resetQaChats();
  // The summary belongs to the old guide — drop it from storage, from the
  // Q&A panels, and from every chat's context flag.
  clearLectureSummaryState();
  guideContent.style.display = 'none';
  guideEmpty.style.display = '';
  generateError.style.display = 'none';
  chrome.storage?.local?.remove(['currentGuide', 'currentGuideLectureUrl', 'currentQaMessages', 'currentQaChats', 'currentToolOutputs', 'currentGuideToolOutputs']);
  clearToolOutputsLocalFallback();
  clearToolOutputsState();
  restoreToolOutputsUI();
  hideQaReplyReadyToast();
  const manualSection = document.getElementById('manual-paste-section');
  if (manualSection) manualSection.remove();

  updateGenerateButton();
  if (transcript?.text) {
    setStatus('ready', `Transcript loaded · ready to generate`);
  } else {
    setStatus('loading', 'Waiting for transcript…');
  }
}

// ─── Guide Profile Definitions ──────────────────────────────────────────

const GUIDE_DETAIL_PROFILES = {
  low: {
    label: 'Low',
    concepts: '1–2 brief sentences per bullet — just the core fact, no elaboration.',
    formulas: 'Only include the most important formulas (skip minor or intermediate steps). LaTeX must be valid KaTeX, no dollar-sign delimiters.',
    definitions: '1 sentence per definition — term and its meaning, nothing more.',
    notes: 'Only include explicit exam hints or professor warnings. Leave empty otherwise.'
  },
  medium: {
    label: 'Medium',
    concepts: '2–3 solid sentences per bullet. State the idea, give brief intuition or a short example.',
    formulas: 'Include main formulas and key theorems. Skip intermediate derivation steps unless they are a main teaching point. LaTeX must be valid KaTeX, no dollar-sign delimiters.',
    definitions: '1–2 sentences — term, meaning, and one condition/caveat if relevant.',
    notes: 'Professor warnings, exam hints, and notable connections. Keep concise.'
  },
  high: {
    label: 'High',
    concepts: '3–5 sentences per bullet. Explain the idea, the intuition, why it matters, and give at least one concrete example or comparison from the lecture.',
    formulas: 'Capture all formulas, theorems, and key equations. Include derivation steps when the professor works through them. LaTeX must be valid KaTeX, no dollar-sign delimiters.',
    definitions: '2–3 sentences — term, formal definition, conditions/domain, and one caveat or remark.',
    notes: 'Professor warnings, exam hints, common mistakes, connections to other topics. Be thorough.'
  },
  very_high: {
    label: 'Very High',
    concepts: '4–8 detailed sentences per bullet. Explain the idea, the intuition behind it, why it matters, and how it connects to the rest of the lecture. Write them so a student who missed class can follow along. Include concrete examples the professor gave, comparisons, and step-by-step reasoning.',
    formulas: 'Capture EVERY formula, theorem, equation, inequality, and key expression. Include intermediate derivation steps when the professor works through them. LaTeX must be valid KaTeX, no dollar-sign delimiters.',
    definitions: 'Formally defined terms WITH full context — include the conditions, domain, and any caveats the professor mentions. Write 2–4 sentences per definition.',
    notes: 'Professor warnings, exam hints, common mistakes students make, connections to other topics, "this will come back later" remarks, practical tips. Be generous — if the professor said something useful beyond the core material, capture it here.'
  }
};

const GUIDE_COUNT_PROFILES = {
  low:       { label: 'Low',       range: '5–10',  rule: 'Merge related subtopics into broad chunks. One block per major lecture section.' },
  medium:    { label: 'Medium',    range: '10–20', rule: 'One block per clear topic shift. Group small asides with the surrounding topic.' },
  high:      { label: 'High',      range: '20–35', rule: 'Split on subtopics, worked examples, and proof steps. Keep blocks focused.' },
  very_high: { label: 'Very High', range: '30–50+', rule: 'Every subtopic, worked example, proof step, or clear topic shift gets its own block. Do NOT merge distant parts of the transcript.' }
};

// No client-side max-token tables: providers enforce their own limits.
// Only an explicit "Custom" value from the user is ever sent.
function selectedGuideMaxTokens(count) {
  if (count !== 'custom') return undefined;
  const n = parseInt(genCustomTokenInput?.value, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function updateCustomTokenVisibility() {
  if (!genCustomTokenRow) return;
  genCustomTokenRow.style.display = genCountSel?.value === 'custom' ? '' : 'none';
}

function updateTokenHint() {
  if (!genTokenHint) return;
  genTokenHint.textContent = genCountSel?.value === 'custom'
    ? 'Manual output-token cap — sent to the provider as-is'
    : 'Output length is left to the provider (no client-side cap)';
}

function getSelectedLanguage() {
  const val = genLangSel?.value || '';
  if (!val) return '';
  if (val === 'other') return genLangCustom?.value?.trim() || '';
  return val;
}

// Returns the effective language for a tool's language select.
// '__guide__' resolves to guideLanguage (the language the current guide was generated in).
function getToolLanguage(selectId) {
  const sel = document.getElementById(selectId);
  const val = sel?.value || '__guide__';
  return val === '__guide__' ? guideLanguage : val;
}

// Sync all tool language selects to the current guide language.
// Called after a guide is loaded or restored.
function _syncToolLanguageSelects() {
  const ids = ['flashcards-lang-select', 'quiz-lang-select', 'exam-lang-select', 'cross-exam-lang-select'];
  for (const id of ids) {
    const sel = document.getElementById(id);
    if (!sel) continue;
    if (guideLanguage) {
      const match = [...sel.options].find(o => o.value === guideLanguage);
      sel.value = match ? guideLanguage : '__guide__';
    } else {
      sel.value = '__guide__';
    }
  }
}

function buildGuidePrompt(detail, count, lang) {
  const d = GUIDE_DETAIL_PROFILES[detail] || GUIDE_DETAIL_PROFILES.very_high;
  const c = GUIDE_COUNT_PROFILES[count] || GUIDE_COUNT_PROFILES.very_high;
  const extraPrefix = customPromptExtras.guide ? customPromptExtras.guide.trim() + '\n\n' : '';
  const langInstruction = lang
    ? `\n\nLANGUAGE: Write ALL text content (lecture_title, guide_title, titles, key_concepts, definitions, notes) in ${lang}. Keep JSON keys, LaTeX, and technical notation unchanged.`
    : `\n\nLANGUAGE: Detect the dominant natural language of the transcript and write ALL text content (lecture_title, guide_title, titles, key_concepts, definitions, notes) in that same language. Do not default to English unless the transcript itself is mainly English. Keep JSON keys, LaTeX, and technical notation unchanged.`;

  return `${extraPrefix}You are an expert academic assistant that converts lecture transcripts into structured study guides.

Your task: Read the provided lecture transcript and produce a JSON lecture guide. The guide divides the lecture into logical topic blocks (not fixed time intervals). Each block covers one coherent topic or subtopic.${langInstruction}

OUTPUT FORMAT — return ONLY valid JSON, no markdown fences, no explanation, no preamble:

{"lecture_title":"string","guide_title":"string","total_duration_seconds":number,"guide":[{"start_time":number,"end_time":number,"title":"string","key_concepts":[{"label":"string","lead":"string","body":"string"}],"formulas":[{"label":"string","latex":"string"}],"definitions":[{"term":"string","definition":"string"}],"notes":"string"}]}

BLOCK COUNT (${c.label} — target ${c.range} blocks):
- ${c.rule}

BLOCK DETAIL (${d.label}):
- key_concepts: ${d.concepts}
- formulas: ${d.formulas}
- definitions: ${d.definitions}
- notes: ${d.notes}

GENERAL RULES:
- The language instruction is mandatory. Examples below are only schema examples; do not copy their English language unless the transcript language is English.
- Blocks follow the logical flow of the lecture. One coherent topic = one block.
- guide_title is mandatory: generate a short, specific title for this guide's main topic, e.g. "Introduction to Caches". Do not use the course name unless the lecture is genuinely a course overview.
- Do NOT hallucinate. Only extract content actually in the transcript.
- Do NOT produce shallow one-liners unless the detail level is set to Low.
- The output token limit is only a ceiling for long lectures. Be complete, but do not pad, repeat, or spend extra tokens when the transcript does not need them.
- Prefer multiple compact key_concepts per block when the lecture gives multiple distinct facts, tradeoffs, steps, examples, limitations, or consequences. Do not collapse a rich topic into one long paragraph.
- key_concepts must be structured objects, not strings. Each object has:
  {"label":"1-3 word pill, under 24 characters","lead":"short bold header sentence, roughly 4-12 words","body":"supporting detail in 1-2 short sentences"}
- The lead must be short and must not contain the whole explanation. Put all supporting information in body. Never leave body empty. Preserve all important information by splitting it into additional key_concepts, formulas, definitions, or notes rather than making one concept long.
- Keep tightly connected condition/result pairs together, but split independent subpoints into separate key_concepts. A good block often has 3–6 short concepts rather than one long concept.
- In textual fields (title, key_concepts, definitions.definition, notes), use LaTeX delimiters for every mathematical expression: $...$ inline, $$...$$ display. Do not write raw math like e^{\\lambda t}, y'' - y = e^{2t}, O(V+E), or P_1 without $...$ delimiters.
- If a key concept contains math, the first sentence and supporting explanation must both preserve math delimiters. Examples: "$y = e^{\\lambda t}$", "$y'' - y = e^{2t}$", "$t^m$", "$\\sin(\\omega t)$", "$\\omega = 1$".
- Markdown is allowed in textual fields when it improves readability (e.g., #/## headings, short lists), but keep it lightweight and do NOT force markdown when plain text is clearer.
- total_duration_seconds: use the last timestamp in the transcript.

EXAMPLE:
Input: "[00:00:00] BFS visits nodes level by level using a queue. [00:01:00] Time complexity is O(V+E). [00:02:00] DFS uses a stack. [00:03:00] Also O(V+E)."
Output: {"lecture_title":"Graph Traversal","guide_title":"Breadth-First and Depth-First Search","total_duration_seconds":180,"guide":[{"start_time":0,"end_time":90,"title":"Breadth-First Search","key_concepts":["BFS explores a graph level by level, starting from a source node and visiting all its direct neighbours before moving to nodes two edges away","The algorithm uses a FIFO queue: enqueue the start node, then repeatedly dequeue the front, enqueue all unvisited neighbours, and mark them visited","BFS naturally finds shortest paths in unweighted graphs because it visits nodes in order of increasing distance from the source","Time complexity is O(V+E) because every vertex is enqueued/dequeued once and every edge is inspected once"],"formulas":[{"label":"BFS Time Complexity","latex":"O(V + E)"}],"definitions":[{"term":"BFS","definition":"Breadth-First Search: a graph traversal that visits all neighbours of a node before going deeper, guaranteeing shortest-path discovery in unweighted graphs"}],"notes":""},{"start_time":90,"end_time":180,"title":"Depth-First Search","key_concepts":["DFS explores as deep as possible along each branch before backtracking, making it suitable for detecting cycles and topological sorting","Can be implemented with an explicit stack or via recursion (the call stack acts as the implicit stack)","Like BFS, DFS runs in O(V+E) time, but it does NOT guarantee shortest paths","DFS is the foundation for many advanced algorithms: topological sort, strongly connected components, and cycle detection"],"formulas":[{"label":"DFS Time Complexity","latex":"O(V + E)"}],"definitions":[{"term":"DFS","definition":"Depth-First Search: a graph traversal that goes deep along each path first, backtracking only when a dead end is reached"}],"notes":"Both BFS and DFS share O(V+E) complexity but have very different properties — BFS gives shortest paths, DFS is better for structural analysis like cycle detection."}]}

Now process the following transcript:`;
}

function buildStudyFlowGuidePrompt(detail, count, lang) {
  const base = buildGuidePrompt(detail, count, lang);
  const marker = '\n\nNow process the following transcript:';
  const insert = `\n\nEXPERIMENTAL STUDY FLOW MODE:\n- Keep the normal fields exactly as specified above. They remain the canonical source of content.\n- Additionally, each guide block MAY include a compact "study_flow" array that controls display order without duplicating content.\n- study_flow items must reference existing content by zero-based index instead of repeating text:\n  {"type":"concept","index":0,"label":"Core idea"}\n  {"type":"formula","index":0}\n  {"type":"definition","index":0}\n  {"type":"note"}\n- Valid type values: "concept", "formula", "definition", "note".\n- For every concept item, add a short label. Each study_flow concept label should match the corresponding key_concept_labels entry unless there is a strong reason to be more specific. Examples include "Overview", "Mechanism", "Tradeoff", "Scenario setup", "Miss count", "Steady state", "Pitfall". Keep labels under 24 characters.\n- Make every referenced key_concepts item work visually under its label: 2-3 sentences total. Sentence 1 = short specific takeaway and must end with a period. Sentence 2 = supporting detail. Optional sentence 3 only when needed. Never output a one-sentence key_concepts item. Split independent subpoints into separate concepts so Study Flow reads like a precise summary, not prose paragraphs. Keep only tightly connected condition/result pairs together.\n- Order study_flow for learning: introduce the idea, then place supporting definitions, formulas, warnings, or examples immediately after the concept they clarify.\n- Do NOT duplicate concept/formula/definition/note text inside study_flow. Only use type, index, and optional label.\n- If a block has no natural mixed order, still include study_flow with concepts first followed by formulas, definitions, and note.\n\nEXPERIMENTAL OUTPUT FORMAT EXTENSION:\n{"lecture_title":"string","guide_title":"string","total_duration_seconds":number,"guide":[{"start_time":number,"end_time":number,"title":"string","key_concepts":["string"],"key_concept_labels":["string"],"formulas":[{"label":"string","latex":"string"}],"definitions":[{"term":"string","definition":"string"}],"notes":"string","study_flow":[{"type":"concept","index":0,"label":"Core idea"},{"type":"definition","index":0},{"type":"formula","index":0},{"type":"note"}]}]}`;

  if (!base.includes(marker)) return `${base}${insert}`;
  return base.replace(marker, `${insert}${marker}`);
}

/** Guide title, falling back to the lecture we are currently watching. */
function getGuideTitle(guideObj = guide) {
  return guideTitleFrom(guideObj, transcript?.lectureTitle);
}

function getHistoryDisplayTitle(entry) {
  const fromEntry = typeof entry?.guideTitle === 'string' ? entry.guideTitle.trim() : '';
  if (fromEntry) return fromEntry;
  return getGuideTitle(entry?.guide) || entry?.lectureTitle || 'Lecture';
}
