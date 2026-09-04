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
  } catch (err) {
    reportSidebarError(err, { operation: 'Export guide as Markdown' });
    return;
  }
}

/**
 * Try to open the exported markdown in Obsidian via the obsidian:// URI scheme.
 * Shows a brief toast with an "Open in Obsidian" link.
 */
function openObsidianIfPossible(filename, content) {
  // obsidian://new?name=...&content=... (URL-encoded)
  // Works if Obsidian is installed and the user has it as default handler for obsidian://
  const obsidianUri = `obsidian://new?name=${encodeURIComponent(filename.replace(/\.md$/, ''))}&content=${encodeURIComponent(content)}`;

  // Show a small toast below the status bar
  const existing = document.getElementById('obsidian-toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.id = 'obsidian-toast';
  toast.style.cssText = `
      position:fixed;bottom:56px;left:50%;transform:translateX(-50%);
      background:var(--surface-1);border:1px solid var(--border);border-radius:8px;
      padding:8px 14px;font-size:12px;color:var(--text-primary);
      box-shadow:0 4px 16px rgba(0,0,0,0.2);z-index:9500;
      display:flex;align-items:center;gap:10px;white-space:nowrap;
    `;
  toast.innerHTML = `
      <span>Markdown downloaded.</span>
      <a href="${obsidianUri}" style="color:var(--accent);text-decoration:none;font-weight:600">Open in Obsidian</a>
      <button id="obsidian-toast-dismiss" style="background:none;border:none;cursor:pointer;color:var(--text-muted);font-size:14px;padding:0;margin-left:2px">×</button>
    `;
  document.body.appendChild(toast);
  toast.querySelector('#obsidian-toast-dismiss')?.addEventListener('click', () => toast.remove());
  setTimeout(() => { if (toast.isConnected) toast.remove(); }, 8000);
}
