/**
 * sidebar/guide-render.js — Rendering guide blocks, timestamp sync, block navigation, LaTeX copy.
 *
 * Part of the sidebar, loaded as a plain script in the order listed in
 * sidebar.html. All sidebar modules share one global scope on purpose:
 * it is what lets each file be a straight move out of the old sidebar.js.
 */

// ─── Guide Display ────────────────────────────────────────────────────────

function showGuideContent() {
  guideEmpty.style.display = 'none';
  guideContent.style.display = 'flex';
  updateLectureSummaryBtn();
  syncAutoFollowCheckbox();
  let startIdx = 0;
  if (autoTimeFollow && !autoFollowPaused && guide?.guide?.length) {
    startIdx = findBlockIndex(lastVideoTime);
  }
  if (guide?.guide?.length) {
    startIdx = Math.max(0, Math.min(startIdx, guide.guide.length - 1));
  }
  renderBlock(startIdx);
}

function syncAutoFollowCheckbox() {
  if (autoTimeFollowCb) autoTimeFollowCb.checked = autoTimeFollow;
  const isPaused = autoTimeFollow && autoFollowPaused;
  if (autoFollowPauseHint) {
    autoFollowPauseHint.style.display = isPaused ? '' : 'none';
  }
  const guideNavFollow = document.querySelector('.guide-nav-follow');
  if (guideNavFollow) {
    if (isPaused) {
      guideNavFollow.dataset.paused = '';
    } else {
      delete guideNavFollow.dataset.paused;
    }
  }
}

function persistAutoTimeFollow() {
  localStorage.setItem('eth-copilot-auto-time-follow', autoTimeFollow ? '1' : '0');
}

function onAutoTimeFollowChange() {
  autoTimeFollow = !!autoTimeFollowCb?.checked;
  autoFollowPaused = false;
  persistAutoTimeFollow();
  syncAutoFollowCheckbox();
}

function navigateBlock(delta) {
  if (!guide?.guide?.length) return;
  const n = guide.guide.length;
  let idx = currentBlockIndex >= 0 ? currentBlockIndex : 0;
  // Cycle: wrap around at both ends
  idx = ((idx + delta) % n + n) % n;
  if (autoTimeFollow) {
    const liveIdx = findBlockIndex(lastVideoTime);
    autoFollowPaused = idx !== liveIdx;
    syncAutoFollowCheckbox();
  }
  if (guideBlock) guideBlock.dataset.direction = delta > 0 ? 'next' : 'prev';
  renderBlock(idx);
}

function commitBlockJump() {
  if (!guide?.guide?.length) { restoreBlockJumpInput(); return; }
  const n = guide.guide.length;
  const raw = parseInt(blockJumpInput?.value, 10);
  if (!Number.isFinite(raw) || raw < 1 || raw > n) {
    restoreBlockJumpInput(); // out of bounds — silently stay
    return;
  }
  const idx = raw - 1;
  if (autoTimeFollow) {
    const liveIdx = findBlockIndex(lastVideoTime);
    autoFollowPaused = idx !== liveIdx;
    syncAutoFollowCheckbox();
  }
  if (guideBlock) guideBlock.removeAttribute('data-direction');
  renderBlock(idx);
}

function showSidebarSpeedOverlay(rate) {
  const el = document.getElementById('sidebar-speed-toast');
  if (!el) return;
  el.textContent = `${rate}×`;
  // Restart animation on each call: strip class, force reflow, re-add.
  el.classList.remove('animating');
  void el.offsetWidth;
  el.classList.add('animating');
}

function restoreBlockJumpInput() {
  if (blockJumpInput && currentBlockIndex >= 0) {
    blockJumpInput.value = currentBlockIndex + 1;
  }
}

function jumpToCurrentTimeBlock() {
  if (!guide?.guide?.length) return;
  autoFollowPaused = false;
  syncAutoFollowCheckbox();
  if (guideBlock) guideBlock.removeAttribute('data-direction'); // use fadeIn, not slide
  const idx = findBlockIndex(lastVideoTime);
  renderBlock(idx);
}

function handleTimestamp(currentTime) {
  lastVideoTime = currentTime;
  if (!guide?.guide?.length) return;
  if (!autoTimeFollow) return;

  const liveIdx = findBlockIndex(currentTime);

  if (autoFollowPaused) {
    if (liveIdx === currentBlockIndex) {
      autoFollowPaused = false;
      syncAutoFollowCheckbox();
    }
    return;
  }

  if (liveIdx !== currentBlockIndex) {
    renderBlock(liveIdx);
  }
}

/**
 * Which block covers playback time `t`.
 *
 * The search itself lives in lib/block-index.js so the tests exercise the code
 * that actually runs; this only supplies the current guide's blocks.
 */
function findBlockIndex(t) {
  return findBlockIndexForTime(guide?.guide, t);
}

// splitConceptText / isAbbreviationDot live in lib/concept-split.js

function renderConceptItem(concept, label = '', tag = 'li') {
  const structured = concept && typeof concept === 'object' && !Array.isArray(concept);
  const cleanLabel = String(label || (structured ? concept.label : '') || '').trim();
  const showLabel = cleanLabel && cleanLabel.toLowerCase() !== 'concept';
  const split = structured
    ? { lead: String(concept.lead || '').trim(), body: String(concept.body || '').trim() }
    : splitConceptText(concept);
  const lead = split.lead || split.body;
  const body = split.lead ? split.body : '';
  return `<${tag} class="concept-card${body ? '' : ' concept-card-single'}">
      ${showLabel ? `<span class="concept-kind">${guideInline(cleanLabel)}</span>` : ''}
      <span class="concept-text">
        ${body
        ? `<span class="concept-lead">${guideInline(lead)}</span><span class="concept-body">${guideInline(body)}</span>`
        : `<span class="concept-lead">${guideInline(lead)}</span>`}
      </span>
    </${tag}>`;
}

function guideInline(text) {
  return richInlineHtml(text);
}

function renderFormulaCard(f) {
  return `<div class="formula-card">
      <div class="formula-label">${escHtml(f.label || 'Formula')}</div>
      <div class="formula-render" data-latex="${escAttr(f.latex)}"></div>
    </div>`;
}

function renderDefinitionItem(d) {
  return `<div class="definition-item">
      <div class="definition-term"><span class="definition-term-text">${guideInline(d.term)}</span></div>
      <div class="definition-text"><span class="definition-body-text">${guideInline(d.definition)}</span></div>
    </div>`;
}

function renderNotesBox(notes) {
  return `<div class="notes-box">
      <div class="notes-icon-row">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"/>
          <line x1="12" y1="8" x2="12" y2="12"/>
          <line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
        <span class="notes-icon-label">Note</span>
      </div>
      <div class="notes-text"><span class="notes-body-text">${guideInline(notes)}</span></div>
    </div>`;
}

function renderStudyFlow(block) {
  if (!Array.isArray(block.study_flow) || !block.study_flow.length) return '';
  const used = {
    concept: new Set(),
    formula: new Set(),
    definition: new Set(),
    note: false
  };
  const parts = [];

  for (const item of block.study_flow) {
    if (item.type === 'concept' && block.key_concepts?.[item.index]) {
      used.concept.add(item.index);
      parts.push(renderConceptItem(block.key_concepts[item.index], item.label || block.key_concept_labels?.[item.index] || 'Concept', 'div'));
    } else if (item.type === 'formula' && block.formulas?.[item.index]) {
      used.formula.add(item.index);
      parts.push(renderFormulaCard(block.formulas[item.index]));
    } else if (item.type === 'definition' && block.definitions?.[item.index]) {
      used.definition.add(item.index);
      parts.push(renderDefinitionItem(block.definitions[item.index]));
    } else if (item.type === 'note' && block.notes?.trim() && !used.note) {
      used.note = true;
      parts.push(renderNotesBox(block.notes));
    }
  }

  block.key_concepts?.forEach((concept, index) => {
    if (!used.concept.has(index)) parts.push(renderConceptItem(concept, block.key_concept_labels?.[index] || '', 'div'));
  });
  block.formulas?.forEach((formula, index) => {
    if (!used.formula.has(index)) parts.push(renderFormulaCard(formula));
  });
  block.definitions?.forEach((definition, index) => {
    if (!used.definition.has(index)) parts.push(renderDefinitionItem(definition));
  });
  if (block.notes?.trim() && !used.note) parts.push(renderNotesBox(block.notes));

  return `<div>
      <div class="section-label">Study Flow</div>
      <div class="study-flow-list">${parts.join('')}</div>
    </div>`;
}

function renderBlock(idx) {
  if (!guide?.guide) return;
  const blocks = guide.guide;
  const block = blocks[idx];
  if (!block) return;

  currentBlockIndex = idx;

  // Keep exam-tool "current block" label fresh whenever the user navigates
  const _examScopeVal = getActivePillValue('exam-scope-pills');
  if (_examScopeVal === 'current') {
    const _infoLabel = document.getElementById('exam-current-block-label');
    if (_infoLabel) {
      _infoLabel.textContent = block?.title
        ? `Block ${idx + 1}: ${block.title}`
        : 'No block selected yet';
    }
  }

  // Update counter + progress
  if (blockJumpInput) blockJumpInput.value = idx + 1;
  if (blockJumpInput) blockJumpInput.max = String(blocks.length);
  blockCounter.textContent = blocks.length;
  const progressPct = Math.round(((idx + 1) / blocks.length) * 100);
  progressFill.style.width = `${progressPct}%`;
  progressFill.parentElement?.setAttribute('aria-valuenow', String(progressPct));

  // Build block HTML
  let html = `
      <div class="block-head-row">
        <div>
          <div class="block-title">${escHtml(block.title)}</div>
          <div class="block-timestamp">${fmtSec(block.start_time)} – ${fmtSec(block.end_time)}</div>
        </div>
        <button type="button" class="latex-copy-btn" data-block-index="${idx}" title="Copy this full block (including LaTeX)">Copy block</button>
      </div>
    `;

  const studyFlowHtml = renderStudyFlow(block);

  if (studyFlowHtml) {
    html += studyFlowHtml;
  } else if (block.key_concepts?.length) {
    html += `<div>
        <div class="section-label">Key Concepts</div>
        <ul class="concepts-list">
          ${block.key_concepts.map((c, i) => renderConceptItem(c, block.key_concept_labels?.[i] || '')).join('')}
        </ul>
      </div>`;

    if (block.formulas?.length) {
      html += `<div>
          <div class="section-label">Formulas</div>
          ${block.formulas.map(f => renderFormulaCard(f)).join('')}
        </div>`;
    }

    if (block.definitions?.length) {
      html += `<div>
          <div class="section-label">Definitions</div>
          ${block.definitions.map(d => renderDefinitionItem(d)).join('')}
        </div>`;
    }

    if (block.notes?.trim()) {
      html += renderNotesBox(block.notes);
    }
  }

  // ── Freeze visually during render to eliminate KaTeX-induced flicker ──
  const _animDir = guideBlock.dataset.direction || null;
  guideBlock.removeAttribute('data-direction'); // suppress animation during render
  guideBlock.style.opacity = '0';               // hide until fully rendered

  guideBlock.innerHTML = html;

  if (typeof renderMathInElement === 'function') {
    guideBlock.querySelectorAll('.concept-card .concept-text').forEach(el => {
      renderMathInElement(el, {
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '$', right: '$', display: false }
        ],
        throwOnError: false,
        trust: false
      });
    });

    guideBlock.querySelectorAll('.definition-term-text, .definition-body-text').forEach(el => {
      renderMathInElement(el, {
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '$', right: '$', display: false }
        ],
        throwOnError: false,
        trust: false
      });
    });

    guideBlock.querySelectorAll('.notes-body-text').forEach(el => {
      renderMathInElement(el, {
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '$', right: '$', display: false }
        ],
        throwOnError: false,
        trust: false
      });
    });
  }

  // Render KaTeX formulas
  guideBlock.querySelectorAll('.formula-render[data-latex]').forEach(el => {
    const latex = el.dataset.latex;
    try {
      katex.render(normalizeLatexForKatex(latex), el, { displayMode: true, throwOnError: false, trust: false });
    } catch (e) {
      el.textContent = latex;
    }
  });

  // ── Normalize formula sizes BEFORE revealing ──
  normalizeBlockFormulas(guideBlock);

  // ── All rendering done — trigger animation cleanly ──
  void guideBlock.offsetWidth;   // flush layout
  guideBlock.style.opacity = ''; // hand off to CSS animation

  if (_animDir) {
    guideBlock.dataset.direction = _animDir;
    // Use animationend so removing data-direction doesn't trigger a second fadeIn replay
    const _onAnimEnd = () => {
      guideBlock.style.animation = 'none';
      void guideBlock.offsetWidth;
      guideBlock.removeAttribute('data-direction');
      // Leave animation:none — next renderBlock resets cleanly via opacity:0
    };
    guideBlock.addEventListener('animationend', _onAnimEnd, { once: true });
  } else {
    // Replay soft fadeIn for auto-follow / jump transitions
    guideBlock.style.animation = 'none';
    void guideBlock.offsetWidth;
    guideBlock.style.animation = '';
  }

  guideBlock.querySelectorAll('.latex-copy-btn[data-block-index]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const i = parseInt(btn.dataset.blockIndex, 10);
      await copyLatexFromSingleBlock(i);
    });
  });
}

/**
 * After KaTeX renders, measure each formula's natural width and apply a uniform
 * CSS zoom to all formulas in the block so none require horizontal scrolling.
 * The same zoom value is applied to all (smallest needed wins) so they look
 * consistent side-by-side. Zoom is clamped at 0.46 minimum.
 */
function normalizeBlockFormulas(blockEl) {
  const renders = blockEl.querySelectorAll('.formula-render');
  if (!renders.length) return;

  // Reset any previous zoom so measurements reflect natural size
  renders.forEach(r => { r.style.zoom = ''; });
  void blockEl.offsetHeight; // force layout

  const containerW = blockEl.clientWidth - 28; // 16+12 padding buffer
  if (containerW <= 0) return;

  let minScale = 1.0;
  renders.forEach(render => {
    const sw = render.scrollWidth;
    if (sw > containerW && sw > 0) {
      const ratio = containerW / sw;
      if (ratio < minScale) minScale = ratio;
    }
  });

  const scale = Math.max(0.46, minScale);
  if (scale < 0.995) {
    renders.forEach(r => { r.style.zoom = scale.toFixed(3); });
  }
}

function formatBlockForCopy(block, idx) {
  if (!block) return '';
  const out = [];
  out.push(`## Block ${idx + 1}: ${block.title || 'Untitled block'}`);
  out.push(`Time: ${fmtSec(block.start_time)} - ${fmtSec(block.end_time)}`);
  out.push('');

  if (Array.isArray(block.key_concepts) && block.key_concepts.length) {
    out.push('Key Concepts:');
    for (const c of block.key_concepts) out.push(`- ${String(c || '').trim()}`);
    out.push('');
  }

  if (Array.isArray(block.formulas) && block.formulas.length) {
    out.push('Formulas (LaTeX):');
    for (const f of block.formulas) {
      const label = String(f?.label || 'Formula').trim();
      const latex = String(f?.latex || '').trim();
      if (!latex) continue;
      out.push(`- ${label}: ${latex}`);
    }
    out.push('');
  }

  if (Array.isArray(block.definitions) && block.definitions.length) {
    out.push('Definitions:');
    for (const d of block.definitions) {
      out.push(`- ${String(d?.term || 'Term').trim()}: ${String(d?.definition || '').trim()}`);
    }
    out.push('');
  }

  if (String(block.notes || '').trim()) {
    out.push('Notes:');
    out.push(String(block.notes).trim());
    out.push('');
  }

  return out.join('\n').trim();
}

async function copyTextToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return !!ok;
  }
}

async function copyLatexFromSingleBlock(idx) {
  if (!guide?.guide?.[idx]) return;
  const block = guide.guide[idx];
  const text = formatBlockForCopy(block, idx);
  if (!text) {
    setStatus('warning', 'Block is empty');
    return;
  }
  const ok = await copyTextToClipboard(text);
  setStatus(ok ? 'ready' : 'error', ok
    ? 'Copied full block content'
    : 'Could not copy block content');
}

function openLatexSelectModal() {
  if (!guide?.guide?.length) {
    setStatus('warning', 'No guide blocks available');
    return;
  }
  const blocks = guide.guide;
  latexBlockList.innerHTML = blocks.map((b, i) => `
      <label class="latex-block-item">
        <input type="checkbox" data-latex-block="${i}">
        <span class="toggle-thumb"></span>
        <span class="latex-block-title">${i + 1}. ${escHtml(b.title || 'Untitled block')}</span>
      </label>
    `).join('');
  setAllLatexSelections(false);
  latexSelectModal.style.display = '';
}

function closeLatexSelectModal() {
  if (latexSelectModal) latexSelectModal.style.display = 'none';
}

function setAllLatexSelections(selected) {
  latexBlockList?.querySelectorAll('input[type="checkbox"][data-latex-block]').forEach(cb => {
    cb.checked = selected;
  });
}

async function copyLatexFromSelectedBlocks() {
  const selectedIdx = Array.from(
    latexBlockList?.querySelectorAll('input[type="checkbox"][data-latex-block]:checked') || []
  ).map(cb => parseInt(cb.dataset.latexBlock, 10));

  if (!selectedIdx.length) {
    setStatus('warning', 'Select at least one block first');
    return;
  }

  const collected = [];
  for (const i of selectedIdx) {
    const block = guide?.guide?.[i];
    if (!block) continue;
    const blockText = formatBlockForCopy(block, i);
    if (!blockText) continue;
    collected.push(blockText);
    collected.push('');
    collected.push('---');
    collected.push('');
  }

  if (!collected.length) {
    setStatus('warning', 'No content found in selected blocks');
    return;
  }

  const ok = await copyTextToClipboard(collected.join('\n'));
  if (ok) {
    closeLatexSelectModal();
    setStatus('ready', `Copied ${selectedIdx.length} selected full block${selectedIdx.length === 1 ? '' : 's'}`);
  } else {
    setStatus('error', 'Could not copy selected blocks');
  }
}
