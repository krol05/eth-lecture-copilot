/**
 * sidebar/history.js — Saved lectures — persistence, the history browser, search, restore.
 *
 * Part of the sidebar, loaded as a plain script in the order listed in
 * sidebar.html. All sidebar modules share one global scope on purpose:
 * it is what lets each file be a straight move out of the old sidebar.js.
 */

// ─── History Persistence ──────────────────────────────────────────────────

function persistChat() {
  for (const chat of qaChats) {
    chat.messages = stripLectureSummaryChatMessages(chat.messages);
  }
  qaMessages = qaChats[activeQaChatIdx]?.messages || [];
  const allChats = qaChats.map(c => ({
    id: c.id, name: c.name, messages: c.messages,
    guideSentForLectureUrl: c.guideSentForLectureUrl || null,
    summaryInContext: !!c.summaryInContext
  }));
  storageSet({ currentQaMessages: qaChats[0]?.messages || [], currentQaChats: allChats });
  saveToHistory();
}

// ─── History: lecture ID assignment ──────────────────────────────────────
// lectureIdMap: { [normalizedUrl]: { number, courseKey } }
// Numbers are permanent per URL — deletion does not free a slot.

function assignLectureNumber(norm, courseKey, idMap) {
  if (idMap[norm]) return idMap[norm].number;          // already assigned
  const sameCoursePeers = Object.values(idMap).filter(v => v.courseKey === courseKey);
  const nextNum = sameCoursePeers.length
    ? Math.max(...sameCoursePeers.map(v => v.number)) + 1
    : 1;
  idMap[norm] = { number: nextNum, courseKey };
  return nextNum;
}

function saveToHistory() {
  if (!guide?.guide?.length || !currentLectureUrl) return;
  const norm      = normalizeLectureUrl(currentLectureUrl);
  const courseKey = transcript?.courseKey || deriveCourseKeyFromUrl(currentLectureUrl);
  const courseName= transcript?.courseName || transcript?.lectureTitle || 'Unknown Course';

  chrome.storage?.local?.get(['guideHistory', 'lectureIdMap'], saved => {
    let history = Array.isArray(saved.guideHistory) ? [...saved.guideHistory] : [];
    const idMap  = (typeof saved.lectureIdMap === 'object' && saved.lectureIdMap) ? { ...saved.lectureIdMap } : {};

    const lectureNumber = assignLectureNumber(norm, courseKey, idMap);
    const prevSame = history.find(h => normalizeLectureUrl(h.lectureUrl) === norm);
    history = history.filter(h => normalizeLectureUrl(h.lectureUrl) !== norm);

    const entry = {
      lectureUrl:    currentLectureUrl,
      lectureTitle:  transcript?.lectureTitle || guide?.lecture_title || 'Lecture',
      guideTitle:    getGuideTitle(guide),
      lectureDate:   transcript?.lectureDate  || null,
      guideDate:     new Date().toISOString(),
      date:          new Date().toISOString(),   // kept for back-compat
      courseKey,
      courseName,
      lectureNumber,
      guide,
      // unlimitedStorage permission allows keeping images; they persist across sessions.
      // Always save first chat's messages to keep history backward-compatible.
      qaMessages: (qaChats[0]?.messages?.length ? qaChats[0].messages : null) || prevSame?.qaMessages || [],
      qaChatsData: qaChats.map(c => ({
        id: c.id, name: c.name, messages: c.messages,
        guideSentForLectureUrl: c.guideSentForLectureUrl || null,
        summaryInContext: !!c.summaryInContext
      })),
      lectureSummary: (lectureSummaryText || '').trim() ? lectureSummaryText : (prevSame?.lectureSummary || null),
      lectureSummarySource: (lectureSummaryText || '').trim() ? lectureSummarySource : (prevSame?.lectureSummarySource || null),
      toolOutputs: buildToolOutputsSnapshot()
    };
    history.unshift(entry);
    if (history.length > 50) history.length = 50;
    storageSet({ guideHistory: history, lectureIdMap: idMap });
  });
}

/** Fallback course-key derivation for URLs already in storage without a courseKey. */
function deriveCourseKeyFromUrl(href) {
  if (!href) return 'other';
  try {
    const parts = new URL(href).pathname.split('/').filter(Boolean);
    if (parts[0] === 'lectures' && parts.length >= 5) return `${parts[1]}::${parts[4]}`;
    return parts.slice(0, 3).join('::') || 'other';
  } catch { return 'other'; }
}

/** Extract { year, season } from a lecture URL for the year/season tree grouping. */
function extractYearSeason(href) {
  try {
    const parts = new URL(href).pathname.split('/').filter(Boolean);
    // ['lectures', 'd-infk', '2026', 'spring', '01337', ...]
    if (parts[0] === 'lectures' && parts.length >= 4) {
      const yr = /^\d{4}$/.test(parts[2]) ? parts[2] : null;
      const raw = parts[3] || '';
      const sn = /^(spring|fall|autumn|winter|summer|herbst|frühling|sommer)$/i.test(raw)
        ? raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase()
        : null;
      if (yr && sn) return { year: yr, season: sn };
    }
  } catch {}
  return { year: 'Other', season: '' };
}

const SEASON_ORDER = { Spring: 0, Summer: 1, Autumn: 2, Fall: 2, Herbst: 2, Winter: 3 };

function loadHistory() {
  const container = document.getElementById('history-list');
  if (!container) return;
  // Reset saved search state whenever history reloads
  _historySearchPreState = null;
  container.innerHTML = '<p style="color:var(--text-muted);font-size:12px;padding:14px 16px;">Loading…</p>';

  chrome.storage?.local?.get(['guideHistory', 'hiddenCourses'], saved => {
    const history   = Array.isArray(saved.guideHistory) ? saved.guideHistory : [];
    const hiddenSet = new Set(Array.isArray(saved.hiddenCourses) ? saved.hiddenCourses : []);

    if (!history.length) {
      container.innerHTML = `
          <div class="history-empty">
            <span class="history-empty-mark">§</span>
            <p class="history-empty-text">No guides generated yet.</p>
          </div>`;
      return;
    }

    // ── Repair pass: fix courseNames that don't match the lecture ──────────
    // Bug: extractCourseName() used 'nav a' which grabbed the alphabetically
    // first entry in the ETH course-list sidebar nav (e.g. "Building Control
    // and Automation") for every lecture, regardless of the actual course.
    // Heuristic: if the stored courseName does not appear anywhere in the
    // lectureTitle, re-derive it by stripping the "– Lecture N" suffix.
    const _BAD_NAME_RE  = /^(spring|fall|autumn|winter|summer|herbst|früh?ling|sommer|lectures?|d-\w{1,8}|\d{4}|lecture)$/i;
    const _isBadName    = n => !n || _BAD_NAME_RE.test(n.trim());
    const _deriveName   = e => {
      const t = (e.lectureTitle || '').trim();
      return t.replace(/[\s—–-]+lecture\s*\d+.*/i, '').replace(/[\s—–-]+\d{4}.*/i, '').trim() || t || 'Lecture';
    };
    const _nameConflict = e => {
      if (_isBadName(e.courseName)) return true;
      if (!e.courseName || !e.lectureTitle) return false;
      // If the stored course name (first 12 chars) does not appear in the
      // lecture title, it's stale data from the wrong nav element.
      const cn = e.courseName.toLowerCase();
      const lt = e.lectureTitle.toLowerCase();
      return !lt.includes(cn.slice(0, Math.min(cn.length, 12)));
    };
    const patchedHistory = history.map(e => ({
      ...e,
      courseKey:  e.courseKey  || deriveCourseKeyFromUrl(e.lectureUrl),
      courseName: _nameConflict(e) ? _deriveName(e) : e.courseName,
      guideTitle: e.guideTitle || getGuideTitle(e.guide),
    }));
    if (history.some(e => _nameConflict(e) || !e.guideTitle)) {
      storageSet({ guideHistory: patchedHistory });
    }

    const normCurrent    = normalizeLectureUrl(currentLectureUrl);
    const activeCourseKey = patchedHistory.find(e => normalizeLectureUrl(e.lectureUrl) === normCurrent)?.courseKey;

    // ── Group by courseKey ────────────────────────────────────────────────
    const groups = {};
    for (const entry of patchedHistory) {
      const k = entry.courseKey || 'other';
      if (!groups[k]) groups[k] = { courseName: entry.courseName, entries: [], yearSeason: extractYearSeason(entry.lectureUrl) };
      groups[k].entries.push(entry);
    }

    for (const g of Object.values(groups)) {
      g.entries.sort((a, b) => {
        const da = a.lectureDate || a.guideDate || a.date || '';
        const db = b.lectureDate || b.guideDate || b.date || '';
        return da < db ? -1 : da > db ? 1 : 0;
      });
      const allHaveNumbers = g.entries.every(e => typeof e.lectureNumber === 'number');
      g.entries.forEach((e, i) => { e._displayNum = allHaveNumbers ? e.lectureNumber : (i + 1); });
    }

    container.innerHTML = '';

    // ── Section A: Recent ─────────────────────────────────────────────────
    const allEntriesByDate = [...patchedHistory].sort((a, b) => {
      const da = a.guideDate || a.date || '';
      const db = b.guideDate || b.date || '';
      return da > db ? -1 : da < db ? 1 : 0;
    });
    // Attach _displayNum from their group for display
    allEntriesByDate.forEach(e => {
      const g = groups[e.courseKey || 'other'];
      e._displayNum = g ? e._displayNum : null;
    });
    container.appendChild(buildRecentSection(allEntriesByDate, normCurrent, hiddenSet));

    // ── Section B: Year/Season tree ───────────────────────────────────────
    const visibleKeys = Object.keys(groups).filter(k => !hiddenSet.has(k));
    const hiddenKeys  = Object.keys(groups).filter(k =>  hiddenSet.has(k));

    // Build Year → Season → [courseKeys] index
    const yearTree = {}; // { year: { season: [courseKey] } }
    for (const k of visibleKeys) {
      const { year, season } = groups[k].yearSeason;
      const yr = year || 'Other';
      const sn = season || 'Other';
      if (!yearTree[yr]) yearTree[yr] = {};
      if (!yearTree[yr][sn]) yearTree[yr][sn] = [];
      yearTree[yr][sn].push(k);
    }

    // Sort years descending, seasons by calendar order
    const sortedYears = Object.keys(yearTree).sort((a, b) => {
      if (a === 'Other') return 1;
      if (b === 'Other') return -1;
      return b.localeCompare(a);
    });

    // Determine active path for auto-open
    const activeEntry = patchedHistory.find(e => normalizeLectureUrl(e.lectureUrl) === normCurrent);
    const activeYS = activeEntry ? extractYearSeason(activeEntry.lectureUrl) : null;

    for (const year of sortedYears) {
      const yearEl = buildYearGroup(year, yearTree[year], groups, hiddenSet, activeCourseKey, activeYS);
      container.appendChild(yearEl);
    }

    // Hidden courses at the bottom (same as before)
    if (hiddenKeys.length) {
      const hiddenSection = document.createElement('details');
      hiddenSection.className = 'history-hidden-section';
      hiddenSection.innerHTML = `<summary class="history-hidden-summary">Hidden courses (${hiddenKeys.length})</summary>`;
      for (const k of hiddenKeys) {
        hiddenSection.appendChild(buildCourseGroup(k, groups[k], hiddenSet, true, activeCourseKey));
      }
      container.appendChild(hiddenSection);
    }
  });
}

const RECENT_PAGE_SIZE = 6;

function buildRecentSection(entriesByDate, normCurrent, hiddenSet) {
  const wrapper = document.createElement('details');
  wrapper.className = 'history-recent-group';
  wrapper.innerHTML = `<summary class="history-recent-summary">
      <span class="history-recent-chevron">›</span>
      <span class="history-recent-label">Recent</span>
      <span class="history-recent-count">${entriesByDate.length} guide${entriesByDate.length !== 1 ? 's' : ''}</span>
    </summary>`;

  let shownCount = 0;
  const itemsContainer = document.createElement('div');
  itemsContainer.className = 'history-recent-items';

  function renderPage() {
    const slice = entriesByDate.slice(shownCount, shownCount + RECENT_PAGE_SIZE);
    slice.forEach(entry => {
      itemsContainer.appendChild(buildRecentItem(entry, normCurrent));
    });
    shownCount += slice.length;
    if (shownCount < entriesByDate.length) {
      const remaining = entriesByDate.length - shownCount;
      const next = Math.min(RECENT_PAGE_SIZE, remaining);
      const moreBtn = document.createElement('button');
      moreBtn.className = 'history-show-more-btn';
      moreBtn.textContent = `Show ${next} more`;
      moreBtn.addEventListener('click', () => {
        moreBtn.remove();
        renderPage();
      });
      itemsContainer.appendChild(moreBtn);
    }
  }
  renderPage();

  wrapper.appendChild(itemsContainer);
  return wrapper;
}

function buildRecentItem(entry, normCurrent) {
  const isActive = normalizeLectureUrl(entry.lectureUrl) === normCurrent;

  // Lecture upload date (when the lecture was recorded/published)
  const lectureDate = entry.lectureDate;
  const lectureDateLabel = lectureDate
    ? new Date(lectureDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    : null;

  // Guide creation date
  const guideDate = entry.guideDate || entry.date;
  const guideDateLabel = guideDate
    ? new Date(guideDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    : '—';

  const div = document.createElement('div');
  div.className = 'history-recent-item' + (isActive ? ' history-active' : '');
  div.innerHTML = `
      <div class="history-recent-item-meta">
        <span class="history-recent-course">${escHtml(entry.courseName || '—')}</span>
        <span class="history-recent-date">${lectureDateLabel ? lectureDateLabel : guideDateLabel}</span>
      </div>
      <div class="history-recent-item-title">${escHtml(getHistoryDisplayTitle(entry))}</div>
      ${lectureDateLabel ? `<div class="history-guide-date">Guide created: ${guideDateLabel}</div>` : ''}
      <div class="history-actions history-recent-actions">
        ${!isActive && entry.lectureUrl ? '<button class="history-go-btn" type="button" title="Open this lecture in the video player">Go to lecture</button>' : ''}
        <button class="history-load-btn" title="Load guide">Load</button>
        <button class="history-pdf-btn" type="button" title="Export as PDF">PDF</button>
      </div>
    `;
  div.querySelector('.history-go-btn')?.addEventListener('click', () => goToLecture(entry.lectureUrl));
  div.querySelector('.history-load-btn').addEventListener('click', () => loadHistoryEntry(entry));
  div.querySelector('.history-pdf-btn').addEventListener('click', () => {
    if (entry.guide?.guide?.length) openGuidePrintWindow(entry.guide, getHistoryDisplayTitle(entry));
  });
  return div;
}

function buildYearGroup(year, seasonMap, groups, hiddenSet, activeCourseKey, activeYS) {
  const totalGuides  = Object.values(seasonMap).flat().reduce((n, k) => n + (groups[k]?.entries.length || 0), 0);

  const details = document.createElement('details');
  details.className = 'history-year-group';
  details.innerHTML = `<summary class="history-year-summary">
      <span class="history-year-chevron">›</span>
      <span class="history-year-label">${escHtml(year)}</span>
      <span class="history-year-count">${totalGuides} guide${totalGuides !== 1 ? 's' : ''}</span>
    </summary>`;

  const sortedSeasons = Object.keys(seasonMap).sort((a, b) => {
    const oa = SEASON_ORDER[a] ?? 99;
    const ob = SEASON_ORDER[b] ?? 99;
    return oa !== ob ? oa - ob : a.localeCompare(b);
  });

  for (const season of sortedSeasons) {
    const courseKeys = seasonMap[season];
    const isActiveSeason = !!(activeYS?.year === year && activeYS?.season === season);
    const seasonDetails = buildSeasonGroup(season, courseKeys, groups, hiddenSet, activeCourseKey, isActiveSeason);
    details.appendChild(seasonDetails);
  }

  return details;
}

function buildSeasonGroup(season, courseKeys, groups, hiddenSet, activeCourseKey, isActiveSeason) {
  const totalGuides = courseKeys.reduce((n, k) => n + (groups[k]?.entries.length || 0), 0);

  const details = document.createElement('details');
  details.className = 'history-season-group';
  details.innerHTML = `<summary class="history-season-summary">
      <span class="history-season-chevron">›</span>
      <span class="history-season-label">${escHtml(season)}</span>
      <span class="history-season-count">${totalGuides} guide${totalGuides !== 1 ? 's' : ''}</span>
    </summary>`;

  // Sort courses: active first, then alphabetically
  const sortedCourseKeys = [...courseKeys].sort((a, b) => {
    if (a === activeCourseKey) return -1;
    if (b === activeCourseKey) return  1;
    return groups[a].courseName.localeCompare(groups[b].courseName);
  });

  for (const k of sortedCourseKeys) {
    details.appendChild(buildCourseGroup(k, groups[k], hiddenSet, false, activeCourseKey));
  }

  return details;
}

function buildCourseGroup(courseKey, group, hiddenSet, isHidden, activeCourseKey) {
  const normCurrent = normalizeLectureUrl(currentLectureUrl);
  const hasActive   = group.entries.some(e => normalizeLectureUrl(e.lectureUrl) === normCurrent);
  const count       = group.entries.length;

  const details = document.createElement('details');
  details.className = 'history-course-group';

  const guideWord = count === 1 ? 'guide' : 'guides';
  details.innerHTML = `
      <summary class="history-course-summary">
        <span class="history-course-chevron">›</span>
        <span class="history-course-name">${escHtml(group.courseName)}</span>
        <span class="history-course-count">${count} ${guideWord}</span>
        <button class="history-course-predict-btn" title="Predict exam questions across lectures in this course" data-key="${escAttr(courseKey)}">
          Predict exam
        </button>
        <button class="history-course-hide-btn" title="${isHidden ? 'Unhide course' : 'Hide course'}" data-key="${escAttr(courseKey)}">
          ${isHidden ? 'Unhide' : 'Hide'}
        </button>
      </summary>
    `;

  details.querySelector('.history-course-predict-btn').addEventListener('click', e => {
    e.stopPropagation();
    e.preventDefault();
    openCrossExamModalForCourse(group.entries);
  });

  details.querySelector('.history-course-hide-btn').addEventListener('click', e => {
    e.stopPropagation();
    e.preventDefault();
    if (isHidden) unhideHistoryCourse(courseKey);
    else          hideHistoryCourse(courseKey);
  });

  for (const entry of group.entries) {
    const isActive    = normalizeLectureUrl(entry.lectureUrl) === normCurrent;
    const num         = entry._displayNum;
    const blockCount  = entry.guide?.guide?.length || 0;
    const chatCount   = Math.floor((entry.qaMessages?.length || 0) / 2);

    // Prefer lecture upload date for display; fall back to guide creation date
    const displayDate = entry.lectureDate || entry.guideDate || entry.date;
    const guideDate   = entry.guideDate || entry.date;
    const dateLabel   = displayDate
      ? new Date(displayDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
      : '—';
    const guideDateLabel = guideDate
      ? new Date(guideDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : '';

    const item = document.createElement('div');
    item.className = 'history-item' + (isActive ? ' history-active' : '');

    item.innerHTML = `
        <div class="history-item-header">
          <span class="history-lecture-num">${num}</span>
          <span class="history-title">${escHtml(getHistoryDisplayTitle(entry))}</span>
        </div>
        <div class="history-meta">
          <span title="Lecture date">${dateLabel}</span>
          <span>${blockCount} block${blockCount !== 1 ? 's' : ''}</span>
          ${chatCount ? `<span>${chatCount} Q&amp;A${chatCount !== 1 ? 's' : ''}</span>` : ''}
        </div>
        ${guideDateLabel ? `<div class="history-guide-date">Guide created: ${guideDateLabel}</div>` : ''}
        <div class="history-actions">
          ${!isActive && entry.lectureUrl ? '<button class="history-go-btn" type="button" title="Open this lecture in the video player">Go to lecture</button>' : ''}
          <button class="history-load-btn" title="Load guide">Load</button>
          <button class="history-pdf-btn" type="button" title="Export as PDF">PDF</button>
          ${!isActive ? `<button class="history-delete-btn" title="Delete guide">Delete</button>` : ''}
        </div>
      `;

    item.querySelector('.history-go-btn')?.addEventListener('click', () => goToLecture(entry.lectureUrl));
    item.querySelector('.history-load-btn').addEventListener('click', () => loadHistoryEntry(entry));
    item.querySelector('.history-pdf-btn').addEventListener('click', () => {
      if (entry.guide?.guide?.length) openGuidePrintWindow(entry.guide, getHistoryDisplayTitle(entry));
    });
    const delBtn = item.querySelector('.history-delete-btn');
    if (delBtn) delBtn.addEventListener('click', () => deleteHistoryEntry(entry.lectureUrl));

    details.appendChild(item);
  }

  return details;
}

function hideHistoryCourse(courseKey) {
  chrome.storage?.local?.get(['hiddenCourses'], saved => {
    const hidden = new Set(Array.isArray(saved.hiddenCourses) ? saved.hiddenCourses : []);
    hidden.add(courseKey);
    storageSet({ hiddenCourses: [...hidden] }, () => loadHistory());
  });
}

function unhideHistoryCourse(courseKey) {
  chrome.storage?.local?.get(['hiddenCourses'], saved => {
    const hidden = new Set(Array.isArray(saved.hiddenCourses) ? saved.hiddenCourses : []);
    hidden.delete(courseKey);
    storageSet({ hiddenCourses: [...hidden] }, () => loadHistory());
  });
}

function loadHistoryEntry(entry) {
  // Guard: if there's an active guide for a DIFFERENT URL with unsaved Q&A, prompt
  const differentLecture = currentLectureUrl &&
    normalizeLectureUrl(entry.lectureUrl) !== normalizeLectureUrl(currentLectureUrl);
  if (differentLecture && guide?.guide?.length && qaMessages.length > 0) {
    const proceed = window.confirm(
      'Loading this history entry will replace your current guide and Q&A conversation. Continue?'
    );
    if (!proceed) return;
  }

  // Loading a saved lecture supersedes anything Regenerate was holding on to.
  discardedByRegenerate = null;

  guide = sanitizeGuide(entry.guide || { guide: [] });
  const restoredMsgs = Array.isArray(entry.qaMessages) ? entry.qaMessages : [];
  if (Array.isArray(entry.qaChatsData) && entry.qaChatsData.length > 0) {
    qaChats = entry.qaChatsData.map(c => ({
      id: c.id || 1, name: c.name || 'Chat 1',
      messages: Array.isArray(c.messages) ? c.messages : [],
      guideSentForLectureUrl: c.guideSentForLectureUrl || null,
      summaryInContext: typeof c.summaryInContext === 'boolean'
        ? c.summaryInContext
        : chatSummaryInContextFromMessages(c.messages)
    }));
    _nextChatId = Math.max(...qaChats.map(c => c.id), 1) + 1;
  } else {
    qaChats = [{ id: 1, name: 'Chat 1', messages: restoredMsgs, guideSentForLectureUrl: null,
      summaryInContext: chatSummaryInContextFromMessages(restoredMsgs) }];
    _nextChatId = 2;
  }
  activeQaChatIdx = 0;
  qaMessages = qaChats[0].messages;
  if (entry.lectureUrl) currentLectureUrl = entry.lectureUrl;
  if (entry.lectureSummary) {
    lectureSummaryText = entry.lectureSummary;
    lectureSummarySource = entry.lectureSummarySource || null;
    persistLectureSummary();
  } else {
    clearLectureSummaryState();
  }
  transcript = transcript || { cues: [], text: '', lectureTitle: entry.lectureTitle, videoDuration: 0 };

  // Persist loaded history entry as the current session so refresh keeps matching lecture identity
  // and does not clear tool outputs as "new lecture detected".
  storageSet({
    currentGuide: guide,
    currentLectureUrl: currentLectureUrl,
    currentGuideLectureUrl: normalizeLectureUrl(currentLectureUrl),
    currentQaMessages: qaChats[0]?.messages || [],
    currentQaChats: qaChats.map(c => ({
      id: c.id, name: c.name, messages: c.messages,
      guideSentForLectureUrl: c.guideSentForLectureUrl || null,
      summaryInContext: !!c.summaryInContext
    })),
    currentLectureSummary: entry.lectureSummary ? {
      lectureUrl: normalizeLectureUrl(entry.lectureUrl),
      text: entry.lectureSummary,
      source: entry.lectureSummarySource || null
    } : undefined
  });

  showGuideContent();
  setStatus('ready', `Guide loaded · ${guide.guide.length} blocks`);

  hideQaReplyReadyToast();
  sanitizeQaChatsSummaryHistory();
  initQaChatCols();
  ensureLectureSummaryRestored({});
  updateLectureSummaryBtn();
  applyToolOutputsSnapshot(entry.toolOutputs || null);
  if (entry.toolOutputs && toolOutputsHasData(entry.toolOutputs)) {
    const norm = normalizeLectureUrl(entry.lectureUrl);
    storageSet({
      currentToolOutputs: { lectureUrl: norm, ...entry.toolOutputs },
      currentGuideToolOutputs: { lectureUrl: norm, ...entry.toolOutputs }
    });
  }
  switchTab('guide');
}

let _deleteUndoTimer = null;
let _deletedEntry = null;
let _deletedOriginalHistory = null;

function deleteHistoryEntry(url) {
  // Removes the guide entry but preserves the lectureIdMap slot (number stays reserved)
  chrome.storage?.local?.get(['guideHistory'], saved => {
    const history = saved.guideHistory || [];
    const deleted = history.find(h => h.lectureUrl === url);
    if (!deleted) return;
    _deletedEntry = deleted;
    _deletedOriginalHistory = history;
    const filtered = history.filter(h => h.lectureUrl !== url);
    storageSet({ guideHistory: filtered }, () => loadHistory());

    // Show undo toast
    const toast = document.getElementById('history-undo-toast');
    const msg = document.getElementById('history-undo-msg');
    const undoBtn = document.getElementById('history-undo-btn');
    if (toast && msg && undoBtn) {
      msg.textContent = `"${deleted.lectureTitle || 'Entry'}" deleted`;
      toast.hidden = false;
      clearTimeout(_deleteUndoTimer);
      _deleteUndoTimer = setTimeout(() => {
        toast.hidden = true;
        _deletedEntry = null;
        _deletedOriginalHistory = null;
      }, 5000);
      undoBtn.onclick = () => {
        clearTimeout(_deleteUndoTimer);
        toast.hidden = true;
        if (_deletedOriginalHistory) {
          storageSet({ guideHistory: _deletedOriginalHistory }, () => loadHistory());
        }
        _deletedEntry = null;
        _deletedOriginalHistory = null;
      };
    }
  });
}

/** Saved accordion open/close state before search started */
let _historySearchPreState = null;

function onHistorySearch() {
  const q = (document.getElementById('history-search')?.value || '').trim().toLowerCase();
  const list = document.getElementById('history-list');
  const clearBtn = document.getElementById('history-search-clear');
  if (!list) return;

  if (clearBtn) clearBtn.hidden = !q;

  if (!q) {
    // Restore all visibility
    list.querySelectorAll('[data-hidden]').forEach(el => delete el.dataset.hidden);
    // Restore accordion open/closed states from before search
    if (_historySearchPreState) {
      _historySearchPreState.forEach(({ el, open }) => {
        if (el.isConnected) el.open = open;
      });
      _historySearchPreState = null;
    }
    return;
  }

  // Save accordion state before first search modifies it
  if (!_historySearchPreState) {
    _historySearchPreState = Array.from(list.querySelectorAll('details'))
      .map(el => ({ el, open: el.open }));
  }

  // Course groups — match on course name or lecture titles within
  list.querySelectorAll('.history-course-group').forEach(group => {
    const courseName = group.querySelector('.history-course-name')?.textContent?.toLowerCase() || '';
    const titles = Array.from(group.querySelectorAll('.history-title, .history-recent-item-title'))
      .map(el => el.textContent.toLowerCase());
    const match = courseName.includes(q) || titles.some(t => t.includes(q));
    if (match) { delete group.dataset.hidden; group.open = true; }
    else group.dataset.hidden = '';
  });

  // Recent items — show individually based on title or course name
  list.querySelectorAll('.history-recent-item').forEach(item => {
    const text = item.textContent.toLowerCase();
    if (text.includes(q)) delete item.dataset.hidden; else item.dataset.hidden = '';
  });

  // Recent group — open if any item is visible
  const recentGroup = list.querySelector('.history-recent-group');
  if (recentGroup) {
    const hasVisible = Array.from(recentGroup.querySelectorAll('.history-recent-item'))
      .some(i => i.dataset.hidden === undefined);
    if (hasVisible) recentGroup.open = true;
  }

  // Season groups — hide if all courses hidden, else open
  list.querySelectorAll('.history-season-group').forEach(season => {
    const allHidden = Array.from(season.querySelectorAll('.history-course-group'))
      .every(g => g.dataset.hidden !== undefined);
    if (allHidden) season.dataset.hidden = '';
    else { delete season.dataset.hidden; season.open = true; }
  });

  // Year groups — hide if all seasons hidden, else open
  list.querySelectorAll('.history-year-group').forEach(year => {
    const allHidden = Array.from(year.querySelectorAll('.history-season-group'))
      .every(s => s.dataset.hidden !== undefined);
    if (allHidden) year.dataset.hidden = '';
    else { delete year.dataset.hidden; year.open = true; }
  });
}
