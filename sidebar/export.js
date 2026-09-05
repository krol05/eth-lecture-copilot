/**
 * sidebar/export.js — Print views, Markdown export, and the Obsidian hand-off.
 *
 * Part of the sidebar, loaded as a plain script in the order listed in
 * sidebar.html. All sidebar modules share one global scope on purpose:
 * it is what lets each file be a straight move out of the old sidebar.js.
 */


function renderFormulaLatexForExport(latex) {
  try {
    return katex.renderToString(normalizeLatexForKatex(String(latex || '')), { displayMode: true, throwOnError: false, trust: false });
  } catch (e) {
    return `<span class="formula-fallback">${escHtml(latex)}</span>`;
  }
}

function renderInlineLatexForExport(text) {
  return normalizeLatexForKatex(unescapeMathDelimiters(text))
    .split(/(\$[^$\n]+\$)/g)
    .map(part => {
      if (part.startsWith('$') && part.endsWith('$') && part.length > 2) {
        try {
          return katex.renderToString(part.slice(1, -1), { displayMode: false, throwOnError: false, trust: false });
        } catch (e) {
          return escHtml(part);
        }
      }
      return escHtml(part);
    })
    .join('');
}

function buildExportBlockHtml(block) {
  let html = `
      <div class="export-block">
        <div>
          <div class="block-title">${escHtml(block.title)}</div>
          <div class="block-timestamp">${fmtSec(block.start_time)} – ${fmtSec(block.end_time)}</div>
        </div>
    `;

  if (block.key_concepts?.length) {
    html += `<div>
        <div class="section-label">Key Concepts</div>
        <ul class="concepts-list">
          ${block.key_concepts.map(c => `<li><span class="concept-text">${renderInlineLatexForExport(c)}</span></li>`).join('')}
        </ul>
      </div>`;
  }

  if (block.formulas?.length) {
    html += `<div>
        <div class="section-label">Formulas</div>
        ${block.formulas.map(f => `
          <div class="formula-card">
            <div class="formula-label">${escHtml(f.label)}</div>
            <div class="formula-render-wrap">${renderFormulaLatexForExport(f.latex)}</div>
          </div>
        `).join('')}
      </div>`;
  }

  if (block.definitions?.length) {
    html += `<div>
        <div class="section-label">Definitions</div>
        ${block.definitions.map(d => `
          <div class="definition-item">
            <div class="definition-term">${renderInlineLatexForExport(d.term)}</div>
            <div class="definition-text">${renderInlineLatexForExport(d.definition)}</div>
          </div>
        `).join('')}
      </div>`;
  }

  if (block.notes?.trim()) {
    html += `
        <div class="notes-box">
          <div class="notes-icon-label">Note</div>
          <div class="notes-text">${renderInlineLatexForExport(block.notes)}</div>
        </div>
      `;
  }

  html += '</div>';
  return html;
}

function buildGuideExportBodyHtml(guideObj) {
  if (!guideObj?.guide?.length) return '';
  return guideObj.guide.map(b => buildExportBlockHtml(b)).join('');
}

function openSummaryPrintWindow() {
  if (!lectureSummaryReady()) {
    setStatus('warning', 'Generate a lecture summary first');
    return;
  }
  if (typeof chrome === 'undefined' || !chrome.runtime?.getURL) {
    setStatus('error', 'Export unavailable in this context');
    return;
  }
  const tmp = document.createElement('div');
  renderLectureSummaryMarkdown(tmp, lectureSummaryText);
  const title = transcript?.lectureTitle || guide?.lecture_title || 'Lecture summary';
  const payload = {
    title,
    subtitle: 'Exam-focused lecture summary · ETH Lecture Copilot',
    bodyHtml: tmp.innerHTML
  };
  try {
    localStorage.setItem('eth-copilot-print-summary', JSON.stringify(payload));
    window.open(chrome.runtime.getURL('sidebar/print-summary.html'), '_blank');
    setStatus('ready', 'Print view opened — use “Save as PDF” in the print dialog');
  } catch (e) {
    console.error('[Copilot] export summary PDF', e);
    setStatus('error', 'Export failed: ' + (e.message || String(e)));
  }
}

function openGuidePrintWindow(guideObj, lectureTitle) {
  if (!guideObj?.guide?.length) {
    setStatus('warning', 'No guide to export');
    return;
  }
  if (typeof chrome === 'undefined' || !chrome.runtime?.getURL) {
    setStatus('error', 'Export unavailable in this context');
    return;
  }
  const bodyHtml = buildGuideExportBodyHtml(guideObj);
  const title = lectureTitle || getGuideTitle(guideObj) || 'Lecture guide';
  const n = guideObj.guide.length;
  const dur = guideObj.total_duration_seconds;
  const subtitle = `${n} section${n === 1 ? '' : 's'} · ${fmtSec(dur || 0)} total`;
  const payload = { title, subtitle, bodyHtml };
  try {
    localStorage.setItem('eth-copilot-print-guide', JSON.stringify(payload));
    window.open(chrome.runtime.getURL('sidebar/print-guide.html'), '_blank');
    setStatus('ready', 'Print view opened — use “Save as PDF” in the print dialog');
  } catch (e) {
    console.error('[Copilot] export PDF', e);
    setStatus('error', 'Export failed: ' + (e.message || String(e)));
  }
}

/**
 * Collect all terms defined in the guide (definitions.term fields).
 * Returns a Set of lowercased terms for WikiLink matching.
 */
function collectGuideTerms(guideObj) {
  const terms = new Set();
  for (const block of (guideObj?.guide || [])) {
    for (const d of (block.definitions || [])) {
      if (d.term) terms.add(d.term.trim());
    }
  }
  return terms;
}

/**
 * Wrap recurring defined terms with [[WikiLinks]] in a text string.
 * Only wraps the first occurrence per term per block to avoid noise.
 */
function applyWikiLinks(text, terms) {
  if (!terms.size) return text;
  let result = text;
  for (const term of terms) {
    // Escape special regex characters in the term
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?<![\\[#*_])\\b(${escaped})\\b(?![\\]])`, 'gi');
    let applied = false;
    result = result.replace(re, (match) => {
      if (applied) return match; // only first occurrence
      applied = true;
      return `[[${match}]]`;
    });
  }
  return result;
}

function exportGuideAsMarkdown() {
  if (!guide?.guide?.length) {
    setStatus('warning', 'No guide to export');
    return;
  }
  const title = getGuideTitle(guide) || transcript?.lectureTitle || guide.lecture_title || 'Lecture Guide';
  const now = new Date();
  const isoDate = now.toISOString().split('T')[0];
  const courseName = transcript?.courseName || '';
  const lectureUrl = transcript?.lectureUrl || currentLectureUrl || '';
  const platform   = transcript?.platform || 'video.ethz.ch';

  // ── YAML frontmatter ──────────────────────────────────────────────────
  const tags = ['lecture-guide'];
  if (courseName) tags.push(courseName.replace(/\s+/g, '-').toLowerCase());
  const frontmatter = [
    '---',
    `title: "${title.replace(/"/g, '\\"')}"`,
    `date: ${isoDate}`,
    courseName ? `course: "${courseName.replace(/"/g, '\\"')}"` : '',
    `source: "${lectureUrl}"`,
    `platform: ${platform}`,
    `tags: [${tags.map(t => `"${t}"`).join(', ')}]`,
    '---',
    ''
  ].filter(l => l !== null && l !== undefined && !(l === '' && false));
  // Remove empty lines but keep structure
  const fmLines = frontmatter.filter((l, i) => l !== '' || (i === frontmatter.length - 1));

  // ── Collect terms for WikiLinks ───────────────────────────────────────
  const wikiTerms = collectGuideTerms(guide);

  const lines = [...fmLines, `# ${title}`, ''];
  for (const block of guide.guide) {
    lines.push(`## ${block.title}`);
    lines.push(`*${fmtSec(block.start_time)} – ${fmtSec(block.end_time)}*`);
    lines.push('');
    if (block.key_concepts?.length) {
      lines.push('### Key Concepts');
      // key_concepts are {label, lead, body} objects in current guides and
      // plain strings in older saved ones — conceptToParts handles both.
      for (const rawConcept of block.key_concepts) {
        const parts = conceptToParts(rawConcept);
        const text = [parts.lead, parts.body].filter(Boolean).join(' ');
        if (!text) continue;
        const prefix = parts.label ? `**${parts.label}** — ` : '';
        lines.push(`- ${prefix}${applyWikiLinks(text.replace(/\n/g, ' '), wikiTerms)}`);
      }
      lines.push('');
    }
    if (block.formulas?.length) {
      lines.push('### Formulas');
      for (const f of block.formulas) {
        if (f.label) lines.push(`**${f.label}**`);
        if (f.latex) lines.push(`$$${f.latex}$$`);
      }
      lines.push('');
    }
    if (block.definitions?.length) {
      lines.push('### Definitions');
      for (const d of block.definitions) {
        lines.push(`**[[${String(d.term ?? '')}]]** — ${String(d.definition ?? '')}`);
      }
      lines.push('');
    }
    if (block.notes?.trim()) {
      lines.push('### Notes');
      lines.push(`> ${applyWikiLinks(block.notes, wikiTerms).replace(/\n/g, '\n> ')}`);
      lines.push('');
    }
  }
  const md = lines.join('\n');
  const safeName = title.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  const filename = `${safeName}-guide.md`;

  // ── Download file ─────────────────────────────────────────────────────
  // The anchor must be in the document: a detached click is ignored inside
  // the sidebar iframe, which is why exporting silently did nothing.
  try {
    const blob = new Blob([md], { type: 'text/markdown; charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      a.remove();
      URL.revokeObjectURL(url);
    }, 5000);
    setStatus('ready', 'Markdown exported');
    offerObsidianHandoff(filename, md);
  } catch (err) {
    reportSidebarError(err, { operation: 'Export guide as Markdown' });
    return;
  }
}

/**
 * Offer to open the exported Markdown in Obsidian.
 *
 * ALPHA — the link format follows Obsidian's documented URI scheme but has not
 * been checked against a real install yet. Nothing here can lose your work:
 * the .md file is already downloaded by the time this runs, so the worst case
 * is a link that does nothing.
 *
 * A whole guide does not fit in a URI, so the usual path is to put the
 * Markdown on the clipboard and let Obsidian read it from there. Both the
 * copy and the link happen on the button press, which is the only moment the
 * browser allows either.
 */
function offerObsidianHandoff(filename, content) {
  chrome.storage?.local?.get(['obsidianVault', 'obsidianFolder'], (saved) => {
    let link;
    try {
      link = Obsidian.buildObsidianUri({
        vault: saved?.obsidianVault,
        folder: saved?.obsidianFolder,
        filename,
        content
      });
    } catch (err) {
      // Never let the hand-off break an export that already succeeded.
      window.CopilotDebug?.warn('sidebar.obsidian.buildFailed', { error: err?.message });
      return;
    }

    document.getElementById('obsidian-toast')?.remove();
    const toast = document.createElement('div');
    toast.id = 'obsidian-toast';
    toast.className = 'obsidian-toast';
    toast.setAttribute('role', 'status');
    toast.innerHTML = `
      <div class="obsidian-toast-text">
        <strong>Markdown downloaded.</strong>
        <span>${link.usesClipboard
          ? 'Too long for a link, so it will be copied and pasted in.'
          : 'Ready to open directly.'}</span>
      </div>
      <a class="obsidian-toast-open" href="${escAttr(link.uri)}">Open in Obsidian</a>
      <button class="obsidian-toast-dismiss" type="button" title="Dismiss">&times;</button>
    `;
    document.body.appendChild(toast);

    const open = toast.querySelector('.obsidian-toast-open');
    open?.addEventListener('click', () => {
      if (link.usesClipboard) {
        // Not awaited: the link must be followed by this same click, and the
        // copy finishes long before Obsidian has finished launching.
        navigator.clipboard?.writeText(content).catch(err => {
          setStatus('error', `Could not copy the guide for Obsidian: ${err.message}`);
        });
      }
      setStatus('ready', `Sent “${link.path}” to Obsidian`);
      setTimeout(() => toast.remove(), 400);
    });
    toast.querySelector('.obsidian-toast-dismiss')?.addEventListener('click', () => toast.remove());
    setTimeout(() => { if (toast.isConnected) toast.remove(); }, 12000);
  });
}
