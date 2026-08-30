/**
 * sidebar/qa-chats.js — Q&A chat tabs — creating, switching, closing, and the chat column DOM.
 *
 * Part of the sidebar, loaded as a plain script in the order listed in
 * sidebar.html. All sidebar modules share one global scope on purpose:
 * it is what lets each file be a straight move out of the old sidebar.js.
 */

// ─── Multi-chat helpers ───────────────────────────────────────────────────

function getChatCol(idx) {
  return document.getElementById('qa-chat-col-' + (idx != null ? idx : activeQaChatIdx));
}
function getActiveChatCol() { return getChatCol(activeQaChatIdx); }

function renderQaChatBar() {
  const bar = document.getElementById('qa-chat-bar');
  if (!bar) return;
  // Always render the bar (+ button always visible); tabs only appear once 2+ chats exist
  bar.style.display = '';

  const canClose = qaChats.length > 1;
  bar.innerHTML = qaChats.map((chat, i) => {
    const isActive = i === activeQaChatIdx;
    // Only show close button when 2+ chats exist
    const closeBtn = canClose
      ? `<button class="qa-chat-tab-close" data-close-idx="${i}" type="button" title="Close ${escHtml(chat.name)}" aria-label="Close ${escHtml(chat.name)}">×</button>`
      : '';
    return `<button class="qa-chat-tab${isActive ? ' active' : ''}" data-chat-idx="${i}" type="button">
        <span class="qa-chat-tab-name">${escHtml(chat.name)}</span>${closeBtn}
      </button>`;
  }).join('') +
  `<button class="qa-chat-add-btn" id="qa-chat-add-btn" title="New chat" type="button">+</button>`;

  bar.querySelectorAll('.qa-chat-tab').forEach(btn => {
    btn.addEventListener('click', e => {
      // Don't switch if the close button was clicked
      if (e.target.closest('.qa-chat-tab-close')) return;
      switchQaChat(parseInt(btn.dataset.chatIdx, 10));
    });
  });
  bar.querySelectorAll('.qa-chat-tab-close').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      closeQaChat(parseInt(btn.dataset.closeIdx, 10));
    });
  });
  document.getElementById('qa-chat-add-btn')?.addEventListener('click', addQaChat);
}

function switchQaChat(idx) {
  if (idx < 0 || idx >= qaChats.length) return;
  // Hide current active column
  getActiveChatCol()?.classList.remove('active');
  activeQaChatIdx = idx;
  qaMessages = qaChats[idx].messages;
  // Show new active column
  getChatCol(idx)?.classList.add('active');
  renderQaChatBar();
  updateQaScrollBtn();
  onQaInputChange();
  renderAllQaSummaryPanels();
}

function addQaChat() {
  const id = _nextChatId++;
  qaChats.push({ id, name: 'Chat ' + id, messages: [], guideSentForLectureUrl: null, summaryInContext: false });
  const newIdx = qaChats.length - 1;
  // Build and append the new column (hidden by default via CSS; switchQaChat activates it)
  const col = _buildChatCol(newIdx);
  qaMessages_el?.appendChild(col);
  col.addEventListener('scroll', _onColScroll.bind(null, newIdx), { passive: true });
  switchQaChat(newIdx);
}

function closeQaChat(idx) {
  if (qaChats.length <= 1) return; // can't close the last chat
  const chatName = qaChats[idx]?.name || 'this chat';
  const hasMessages = qaChats[idx]?.messages?.length > 0;
  if (hasMessages && !window.confirm(`Close ${chatName}? Its history will be lost.`)) return;

  // Abort any active stream IN the chat being closed (its DOM element is about
  // to disappear), but leave streams in OTHER chats alone — they must keep flowing.
  for (const [reqId, state] of qaActiveStreams.entries()) {
    if (state.chatIdx === idx) {
      try { state.abortFn?.(); } catch (_) {}
      QaStreamFlush.stopStreamFlush(state);
      qaActiveStreams.delete(reqId);
    }
  }

  // Remove the column from DOM
  getChatCol(idx)?.remove();

  // Remove from array
  qaChats.splice(idx, 1);

  // Re-index remaining columns so their IDs match array positions
  document.querySelectorAll('.qa-chat-col').forEach((col, i) => {
    col.id = 'qa-chat-col-' + i;
  });

  // CRITICAL: remap chatIdx in every still-active stream. Without this, a stream
  // started in chat 2 (idx=1) keeps pointing at idx=1 even after chat 1 (idx=0)
  // was closed, so when its response resolves `qaChats[1]` is undefined and the
  // whole stream blows up with a TypeError that looks like an abort to the user.
  for (const state of qaActiveStreams.values()) {
    if (state.chatIdx > idx) state.chatIdx -= 1;
  }
  if (activeQaStreamChatIdx > idx) activeQaStreamChatIdx -= 1;

  // Determine which chat to switch to
  let nextIdx = activeQaChatIdx;
  if (activeQaChatIdx >= idx) nextIdx = Math.max(0, activeQaChatIdx - 1);
  if (nextIdx >= qaChats.length) nextIdx = qaChats.length - 1;

  // Reset activeQaChatIdx before switchQaChat so it doesn't try to hide a stale index
  activeQaChatIdx = -1;
  switchQaChat(nextIdx);
}

function _buildChatCol(idx) {
  const isActive = idx === activeQaChatIdx;
  const col = document.createElement('div');
  col.className = 'qa-chat-col' + (isActive ? ' active' : '');
  col.id = 'qa-chat-col-' + idx;
  const chat = qaChats[idx];
  if (!chat.messages.length) {
    col.innerHTML = '<div class="qa-welcome"><p>Ask anything about this lecture. I have the full transcript and guide as context.</p></div>';
  } else {
    for (const m of chat.messages) {
      const el = _buildChatMsgEl(m.role, m.content, m.images || m.imageBase64 || []);
      col.appendChild(el);
    }
    col.scrollTop = col.scrollHeight;
  }
  return col;
}

function initQaChatCols() {
  if (!qaMessages_el) return;
  qaMessages_el.innerHTML = '';
  for (let i = 0; i < qaChats.length; i++) {
    const col = _buildChatCol(i);
    qaMessages_el.appendChild(col);
    col.addEventListener('scroll', _onColScroll.bind(null, i), { passive: true });
  }
  renderQaChatBar();
  updateQaScrollBtn();
  renderAllQaSummaryPanels();
}

function resetQaChats() {
  qaChats = [{ id: 1, name: 'Chat 1', messages: [], guideSentForLectureUrl: null, summaryInContext: false }];
  activeQaChatIdx = 0;
  _nextChatId = 2;
  qaMessages = qaChats[0].messages;
  initQaChatCols();
}

function _onColScroll(idx) {
  if (idx === activeQaChatIdx) {
    onQaMessagesScroll();
    updateQaScrollBtn();
  }
}

function updateQaScrollBtn() {
  const btn = document.getElementById('qa-scroll-bottom-btn');
  if (!btn) return;
  if (_currentTab !== 'qa') {
    btn.hidden = true;
    return;
  }
  const toastVisible = qaReplyReadyToast && !qaReplyReadyToast.hidden;
  const root = getActiveChatCol();
  const farUp = root
    ? (root.scrollHeight - root.scrollTop - root.clientHeight > QA_SCROLL_BTN_THRESHOLD_PX)
    : false;
  btn.hidden = toastVisible || !farUp;
}
