const $ = (id) => document.getElementById(id);
const transcript = $('transcript');
const input = $('input');
const sendButton = $('send');
const composer = $('composer');
const attachButton = $('attach');
const attachInput = $('attach-input');
const attachRow = $('attach-row');
const imagePick = $('image-pick');
const imageInput = $('image-input');
const mediaRow = $('media-row');
const modelSelect = $('model-select');
const historyDrawer = $('history');
const titleEl = $('thread-title');
const root = document.documentElement;

const state = {
  conversationId: null,
  sending: false,
  /**
   * The turn currently streaming, or null.
   *
   * `controller` is the fallback stop (cut the connection); `stopping` records
   * that the person asked, which is what tells an intentional stop apart from
   * a dropped network when the stream ends without a terminal frame.
   */
  turn: null,
  /** Non-visual files uploaded for the next message: `{ path, name, mime, bytes }`. */
  attachments: [],
  /**
   * Visual image drafts, in selection order.
   *
   * Each item is `{ key, file, name, bytes, state, asset, error, previewUrl,
   * conversationId }`. The server asset id is the only durable fact; the local
   * object URL exists to show the picture before it is uploaded.
   */
  mediaDrafts: [],
  /** Uploads that have started but not answered yet. */
  uploading: 0,
  /** Server-published limits and route capabilities; null until fetched. */
  mediaLimits: null,
  models: [],
  defaultModelId: null,
  selectedModelId: null,
  memoryEnabled: true,
  showArchived: false,
  feedback: new Map(),
  /** Last `GET /api/permissions` payload, or null before the first answer. */
  permission: null,
};

/**
 * The local control token, written into <head> by the server that served this
 * page. A copy opened from disk has none, and the permission control then stays
 * hidden instead of firing requests it knows will be refused.
 */
const localToken =
  document.querySelector('meta[name="eunoia-token"]')?.getAttribute('content') || null;

/** Titles from the conversation list, so the topbar and sidebar agree. */
const conversationTitles = new Map();
/** The row element per conversation, so the active state can move without a refetch. */
const threadNodes = new Map();
/** Only the newest list request may paint; older ones are discarded on arrival. */
let historyRequest = 0;

// ---------------------------------------------------------------- render ----

/** Everything user- or model-authored goes in via textContent, never HTML. */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Put text on the clipboard.
 *
 * `navigator.clipboard` only exists in a secure context. This page can be
 * opened over plain http on a LAN address the operator allowed, so the old
 * selection-based command is kept as a fallback rather than making copy depend
 * on how the page was reached.
 */
async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Permission denied or not focused: try the legacy path before giving up.
  }

  const body = document.body;
  if (!body || typeof document.execCommand !== 'function') return false;
  const helper = document.createElement('textarea');
  helper.value = text;
  helper.setAttribute('readonly', '');
  helper.style.position = 'fixed';
  helper.style.top = '-1000px';
  helper.style.opacity = '0';
  body.append(helper);
  helper.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    helper.remove();
  }
}

/**
 * Copy, then say so on the button itself.
 *
 * The label is the feedback: a toast for an action this small would cover the
 * text the person is about to paste into. The timer is per button so copying a
 * second block does not reset the first one's label early.
 */
async function copyWithFeedback(button, text) {
  const ok = await copyText(text);
  button.dataset.copied = String(ok);
  const icon = button.classList.contains('msg-action');
  const label = ok ? '已复制' : '复制失败';
  // An icon button has no text to replace; its label is the feedback.
  if (icon) {
    button.setAttribute('aria-label', label);
    button.title = label;
  } else {
    button.textContent = label;
  }
  if (button.copyReset) clearTimeout(button.copyReset);
  button.copyReset = setTimeout(() => {
    if (icon) {
      button.setAttribute('aria-label', '复制');
      button.title = '复制';
    } else {
      button.textContent = '复制';
    }
    delete button.dataset.copied;
  }, 1600);
}

/**
 * A message toolbar icon.
 *
 * The paths are inline rather than an icon font or a network sprite: this page
 * has no build step and no external requests, and a 24×24 stroke path is small
 * enough to keep beside the code that uses it.
 */
const ACTION_ICONS = {
  copy: [
    'M9 9h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2z',
    'M5 15V6a2 2 0 0 1 2-2h9',
  ],
  speak: [
    'M11 5 6 9H3v6h3l5 4V5z',
    'M15 9a4 4 0 0 1 0 6',
    'M17.5 6.5a8 8 0 0 1 0 11',
  ],
  share: ['M12 16V4', 'M8 8l4-4 4 4', 'M5 14v5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5'],
  regenerate: ['M20 4v6h-6', 'M20 10a8 8 0 1 0-1.6 6.4'],
  more: ['M5 12h.01', 'M12 12h.01', 'M19 12h.01'],
};

function svgIcon(paths) {
  if (typeof document.createElementNS !== 'function') return el('span', 'icon');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  for (const definition of paths) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', definition);
    svg.append(path);
  }
  return svg;
}

function actionButton(iconName, label, onClick) {
  const button = el('button', 'msg-action');
  button.type = 'button';
  button.dataset.action = iconName;
  button.setAttribute('aria-label', label);
  button.title = label;
  button.append(svgIcon(ACTION_ICONS[iconName] ?? []));
  button.onclick = onClick;
  return button;
}

/**
 * Markdown as something worth saying aloud.
 *
 * Code is announced rather than read: hearing a loop body character by
 * character helps nobody, and the person can open the block if they want it.
 */
function plainText(markdown) {
  return markdown
    .replace(/```[\s\S]*?```/g, '（代码略）')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_~]{1,3}/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

let speakingButton = null;

function stopSpeaking(button) {
  button.dataset.speaking = 'false';
  button.setAttribute('aria-label', '朗读');
  button.title = '朗读';
  if (speakingButton === button) speakingButton = null;
}

/**
 * Read a reply aloud, or stop it if it is already speaking.
 *
 * `speechSynthesis` is browser-only and absent in the test shim, so the guard is
 * what keeps a click from throwing there. Chinese is pinned because the reply
 * is Chinese and a system default of English turns it into noise.
 */
function toggleSpeak(button, content) {
  const synth = window.speechSynthesis;
  const Utterance = window.SpeechSynthesisUtterance;
  if (!synth || typeof Utterance !== 'function') {
    notice('这个浏览器不支持朗读。');
    return;
  }
  if (button.dataset.speaking === 'true') {
    synth.cancel();
    stopSpeaking(button);
    return;
  }
  if (speakingButton && speakingButton !== button) {
    synth.cancel();
    stopSpeaking(speakingButton);
  }

  const utterance = new Utterance(plainText(content));
  utterance.lang = 'zh-CN';
  utterance.rate = 1;
  utterance.onend = () => stopSpeaking(button);
  utterance.onerror = () => stopSpeaking(button);
  speakingButton = button;
  button.dataset.speaking = 'true';
  button.setAttribute('aria-label', '停止朗读');
  button.title = '停止朗读';
  synth.speak(utterance);
}

/** A local export: the Web Share sheet when there is one, a file when not. */
async function shareText(text, filename) {
  if (navigator.share) {
    try {
      await navigator.share({ text });
      return;
    } catch (error) {
      // A canceled share is not a failure and must not fall through to a
      // download the person did not ask for.
      if (error?.name === 'AbortError') return;
    }
  }
  downloadText(filename, text);
}

function downloadText(filename, text) {
  const host = document.body;
  if (!host || typeof URL.createObjectURL !== 'function' || typeof Blob !== 'function') {
    notice('这个浏览器不支持导出。');
    return;
  }
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  host.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/** The whole thread as Markdown, for keeping or handing to someone else. */
async function exportConversation() {
  if (!state.conversationId) {
    notice('还没有对话可以导出。');
    return;
  }
  const response = await fetch(`/api/conversations/${state.conversationId}/messages`).catch(
    () => null,
  );
  if (!response || !response.ok) {
    notice('读不到这段对话。');
    return;
  }
  const { messages = [] } = await response.json();
  const body = messages
    .map((message) => {
      const parts = Array.isArray(message.contentParts?.parts)
        ? message.contentParts.parts
        : [{ type: 'text', text: message.content }];
      const rendered = parts
        .map((part) =>
          part.type === 'text'
            ? part.text
            : `图片附件：${part.image?.name ?? '图片'}（不可公开ID：${part.assetId}）`,
        )
        .join('\n');
      return `${message.role === 'user' ? '你' : 'Eunoia'}：\n${rendered}`;
    })
    .join('\n\n');
  await shareText(`# Eunoia 对话\n\n${body}\n`, 'eunoia-conversation.md');
}

let messageMenu = null;

function closeMessageMenu() {
  if (messageMenu) messageMenu.remove();
  messageMenu = null;
}

function openMessageMenu(anchor, content) {
  closeMessageMenu();
  const menu = el('div', 'msg-menu');
  menu.setAttribute('role', 'menu');

  const plain = el('button', null, '复制纯文本');
  plain.type = 'button';
  plain.onclick = () => {
    closeMessageMenu();
    void copyText(plainText(content)).then((ok) => {
      if (!ok) notice('复制失败，可能需要先点一下页面。');
    });
  };

  const exportThread = el('button', null, '导出整段对话');
  exportThread.type = 'button';
  exportThread.onclick = () => {
    closeMessageMenu();
    void exportConversation();
  };

  menu.append(plain, exportThread);
  const host = document.body ?? anchor.parent ?? anchor;
  host.append(menu);

  if (document.body) {
    // Fixed positioning keeps the menu out of the bubble's overflow and off the
    // transcript scroll. The shim has no layout, so it simply lands appended.
    const rect = anchor.getBoundingClientRect();
    menu.style.top = `${Math.round(rect.bottom + 6)}px`;
    menu.style.left = `${Math.max(8, Math.round(rect.right - 152))}px`;
  }

  messageMenu = menu;
  // The click that opened the menu is still bubbling; close on the next one.
  setTimeout(() => {
    document.addEventListener('click', closeMessageMenu, { once: true });
  }, 0);
}

/**
 * The action row under an assistant reply: copy, read aloud, export, regenerate
 * (last reply only), more. Rating controls stay text so they remain obvious.
 */
/**
 * The undo affordance for one turn.
 *
 * Two clicks, not a browser confirm: the first arms it and says what will be
 * touched, the second applies. Conflicts are listed rather than overwritten, and
 * a second, explicit "force" button exists for the person who has read them.
 */
function undoAction(actions, info) {
  const label = `撤销本轮 · ${info.fileCount}`;
  const button = el('button', 'msg-action msg-undo');
  button.type = 'button';
  button.textContent = label;
  button.title = `撤销这一轮改动的 ${info.fileCount} 个文件（新增 ${info.added}，修改 ${info.modified}，删除 ${info.deleted}）`;
  let timer = null;
  button.onclick = async () => {
    if (button.dataset.armed !== 'true') {
      button.dataset.armed = 'true';
      button.textContent = '再点一次确认';
      timer = globalThis.setTimeout(() => {
        button.dataset.armed = 'false';
        button.textContent = label;
      }, 5_000);
      return;
    }
    if (timer) globalThis.clearTimeout(timer);
    button.disabled = true;
    button.textContent = '撤销中…';
    await runUndo(actions, info, button, false);
  };
  return button;
}

async function runUndo(actions, info, button, force) {
  const response = await fetch(
    `/api/conversations/${state.conversationId}/changes/${info.changesetId}/undo`,
    {
      method: 'POST',
      headers: permissionHeaders(),
      body: JSON.stringify({ force }),
    },
  ).catch(() => null);
  const payload = response ? await response.json().catch(() => ({})) : {};
  if (!response || !response.ok) {
    button.disabled = false;
    button.dataset.armed = 'false';
    button.textContent = '撤销失败，重试';
    return;
  }
  let report = actions.parentElement?.querySelector('.undo-report');
  if (!report) {
    report = el('div', 'undo-report');
    actions.after(report);
  }
  report.textContent = '';
  const restored = Array.isArray(payload.restored) ? payload.restored : [];
  const deleted = Array.isArray(payload.deleted) ? payload.deleted : [];
  const conflicts = Array.isArray(payload.conflicts) ? payload.conflicts : [];
  const skipped = Array.isArray(payload.skipped) ? payload.skipped : [];
  report.append(
    el(
      'div',
      null,
      `已恢复 ${restored.length} 个文件${deleted.length > 0 ? `，删除 ${deleted.length} 个本轮新增的文件` : ''}。`,
    ),
  );
  for (const conflict of conflicts) {
    report.append(el('div', 'undo-conflict', `${conflict.path}：${conflict.reason}`));
  }
  for (const skip of skipped) {
    report.append(el('div', 'undo-conflict', `${skip.path}：${skip.reason}`));
  }
  if (conflicts.length > 0 || skipped.length > 0) {
    const forceButton = el('button', 'msg-action msg-undo', '强制撤销其余文件');
    forceButton.type = 'button';
    forceButton.title = '会覆盖你在本轮之后对这些文件做的修改';
    forceButton.onclick = async () => {
      forceButton.disabled = true;
      forceButton.textContent = '强制撤销中…';
      await runUndo(actions, info, button, true);
    };
    report.append(forceButton);
  }
  button.textContent = payload.status === 'undone' ? '已撤销' : '部分撤销';
  button.disabled = true;
  if (wbState.info?.configured) {
    wbState.levels.clear();
    void loadLevel('.');
    if (wbState.tab === 'changes') void refreshChanges();
  }
}

function addMessageActions(
  actions,
  { content, messageId, canRegenerate = false, regenerate = null, undo = null },
) {
  actions.textContent = '';
  if (content && content.trim().length > 0) {
    const copy = actionButton('copy', '复制', () => void copyWithFeedback(copy, content));
    const speak = actionButton('speak', '朗读', () => toggleSpeak(speak, content));
    const share = actionButton('share', '导出', () => void shareText(content, 'eunoia-reply.md'));
    const more = actionButton('more', '更多', () => openMessageMenu(more, content));
    actions.append(copy, speak, share);
    if (undo) actions.append(undoAction(actions, undo));
    if (canRegenerate && regenerate) {
      const again = actionButton('regenerate', '重新生成', regenerate);
      again.classList.add('msg-regenerate');
      actions.append(again);
    }
    actions.append(more);
  }
  if (messageId) addFeedback(actions, messageId);
}

/**
 * Render the assistant's Markdown subset into a container.
 *
 * The model writes headings, quotes, tables, lists, fenced code and inline
 * emphasis; without this they reach the page as literal `##`, `>` and `|`.
 * Everything is built from DOM nodes — never innerHTML — so model output
 * cannot become markup.
 *
 * Deliberately still text: links (a click target the product has not decided
 * to trust), raw HTML, and images. Lists stay one level deep: indentation-
 * dependent nesting is where a small renderer starts growing bugs, and a chat
 * bubble does not reward it.
 */
function renderText(container, text) {
  container.textContent = '';
  for (const block of splitFences(text)) {
    if (block.code === null) {
      renderProse(container, block.text);
      continue;
    }
    const wrapper = el('div', 'code-block');
    const pre = el('pre');
    pre.append(el('code', null, block.code));
    const copy = el('button', 'code-copy', '复制');
    copy.type = 'button';
    copy.setAttribute('aria-label', '复制这段代码');
    copy.onclick = () => void copyWithFeedback(copy, block.code);
    wrapper.append(copy, pre);
    container.append(wrapper);
  }
}

/**
 * Render one prose run: headings, quotes, rules, tables, lists, paragraphs.
 *
 * Streaming calls this on every delta, so a construct is only emitted once its
 * markers are complete. An incomplete table header stays a paragraph; the next
 * delta promotes it. That is the flicker the alternative — buffering the whole
 * reply — would trade for a blank bubble.
 */
function renderProse(container, text, depth = 0) {
  const lines = text.split('\n');
  let paragraph = [];
  let list = null;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const block = el('div', 'para');
    appendInline(block, paragraph.join('\n'));
    container.append(block);
    paragraph = [];
  };
  const flushList = () => {
    if (list === null) return;
    container.append(list.node);
    list = null;
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    if (line.trim() === '') {
      flushAll();
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading !== null) {
      flushAll();
      const content = heading[2].replace(/\s+#+\s*$/, '').trim();
      const node = el(`h${heading[1].length}`);
      appendInline(node, content);
      container.append(node);
      continue;
    }

    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushAll();
      container.append(el('hr'));
      continue;
    }

    if (/^\s*>/.test(line)) {
      flushAll();
      const quoted = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        quoted.push(lines[i].replace(/^\s*>\s?/, ''));
        i += 1;
      }
      i -= 1;
      const quote = el('blockquote');
      if (depth < 2) renderProse(quote, quoted.join('\n'), depth + 1);
      else appendInline(quote, quoted.join('\n'));
      if (quote.children.length > 0) container.append(quote);
      continue;
    }

    if (
      line.includes('|') &&
      !/^\s*(?:[-*+]\s|\d+[.)]\s|#{1,6}\s|>)/.test(line) &&
      i + 1 < lines.length &&
      isTableDelimiter(lines[i + 1])
    ) {
      flushAll();
      const header = splitTableRow(line);
      const aligns = tableAlignments(lines[i + 1]) ?? [];
      const rows = [];
      let j = i + 2;
      while (j < lines.length && lines[j].trim() !== '' && lines[j].includes('|')) {
        rows.push(splitTableRow(lines[j]));
        j += 1;
      }
      renderTable(container, header, aligns, rows);
      i = j - 1;
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
    if (bullet === null && numbered === null) {
      flushList();
      paragraph.push(line);
      continue;
    }

    flushParagraph();
    const type = bullet === null ? 'ol' : 'ul';
    const start = numbered === null ? 1 : Number.parseInt(numbered[1], 10);
    if (list === null || list.type !== type) {
      flushList();
      const node = el(type);
      if (type === 'ol' && Number.isFinite(start) && start !== 1) {
        node.setAttribute('start', String(start));
      }
      list = { type, node };
    }
    const item = el('li');
    appendInline(item, (bullet === null ? numbered[2] : bullet[1]) ?? '');
    list.node.append(item);
  }
  flushAll();
}

/** Parse one `| a | b |` row, honoring `\|` as a literal pipe. */
function splitTableRow(line) {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells = [];
  let cell = '';
  for (let i = 0; i < trimmed.length; i += 1) {
    if (trimmed[i] === '\\' && trimmed[i + 1] === '|') {
      cell += '|';
      i += 1;
      continue;
    }
    if (trimmed[i] === '|') {
      cells.push(cell.trim());
      cell = '';
      continue;
    }
    cell += trimmed[i];
  }
  cells.push(cell.trim());
  return cells;
}

/** `|---|:---:|---:|` -> ['left','center','right']; null if not a delimiter. */
function tableAlignments(line) {
  if (!line.includes('|')) return null;
  const aligns = [];
  for (const raw of splitTableRow(line)) {
    const cell = raw.replace(/\s+/g, '');
    if (!/^:?-{3,}:?$/.test(cell)) return null;
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    aligns.push(left && right ? 'center' : right ? 'right' : left ? 'left' : null);
  }
  return aligns.length > 0 ? aligns : null;
}

function isTableDelimiter(line) {
  return tableAlignments(line) !== null;
}

/** A table is laid out in a scrollable wrapper: chat width is not a page. */
function renderTable(container, header, aligns, rows) {
  const wrap = el('div', 'table-wrap');
  const table = el('table');
  const thead = el('thead');
  const head = el('tr');
  const columns = Math.max(header.length, aligns.length);
  for (let i = 0; i < columns; i += 1) {
    const th = el('th');
    if (aligns[i] !== null && aligns[i] !== undefined) th.setAttribute('data-align', aligns[i]);
    appendInline(th, header[i] ?? '');
    head.append(th);
  }
  thead.append(head);
  table.append(thead);
  if (rows.length > 0) {
    const tbody = el('tbody');
    for (const row of rows) {
      const tr = el('tr');
      for (let i = 0; i < columns; i += 1) {
        const td = el('td');
        if (aligns[i] !== null && aligns[i] !== undefined) td.setAttribute('data-align', aligns[i]);
        appendInline(td, row[i] ?? '');
        tr.append(td);
      }
      tbody.append(tr);
    }
    table.append(tbody);
  }
  wrap.append(table);
  container.append(wrap);
}

/** Split fenced code blocks from prose. An unclosed fence stays text. */
function splitFences(text) {
  const blocks = [];
  let prose = [];
  let code = null;
  const flushProse = () => {
    if (prose.length === 0) return;
    blocks.push({ code: null, text: prose.join('\n') });
    prose = [];
  };

  for (const line of text.split('\n')) {
    if (code === null) {
      if (/^```/.test(line)) {
        flushProse();
        code = [];
      } else {
        prose.push(line);
      }
      continue;
    }
    if (/^```\s*$/.test(line)) {
      blocks.push({ code: code.join('\n'), text: '' });
      code = null;
      continue;
    }
    code.push(line);
  }
  // Mid-stream: the closing fence has not arrived. Showing the opening marker
  // as text is better than swallowing the rest of the reply.
  if (code !== null) {
    prose.push('```', ...code);
    code = null;
  }
  flushProse();
  return blocks;
}

/** Inline code and bold, in that order, so `**` inside code stays literal. */
function appendInline(container, text) {
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > cursor) {
      container.append(el('span', null, text.slice(cursor, match.index)));
    }
    const token = match[0];
    if (token.startsWith('`')) {
      container.append(el('code', null, token.slice(1, -1)));
    } else {
      container.append(el('strong', null, token.slice(2, -2)));
    }
    cursor = match.index + token.length;
  }
  if (cursor < text.length) container.append(el('span', null, text.slice(cursor)));
}

/** The conversation title in the topbar. Empty means "nothing chosen yet". */
function setThreadTitle(text) {
  if (titleEl) titleEl.textContent = text;
}

/**
 * Adopt the listed title for the open conversation.
 *
 * Deliberately a no-op when the id is not in the list: a new conversation has
 * no row yet, and its optimistic title should survive until the server names it.
 */
function updateThreadTitle() {
  if (!state.conversationId) {
    setThreadTitle('新的对话');
    return;
  }
  const title = conversationTitles.get(state.conversationId);
  if (title) setThreadTitle(title);
}

/** Move the selected state between rows without re-fetching the list. */
function markActiveThread() {
  for (const [id, node] of threadNodes) {
    const active = id === state.conversationId;
    node.setAttribute('aria-current', String(active));
    // `parent` exists in the test shim; `parentElement` is the browser's.
    const row = node.parentElement ?? node.parent;
    if (!row) continue;
    if (active) row.classList.add('active');
    else row.classList.remove('active');
  }
}

/** Mirror the server's derived-title rule for the instant before the list lands. */
function deriveTitle(text) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= 24 ? flat : `${flat.slice(0, 24)}…`;
}

/** Keep the memory badge in the topbar honest after either panel is read. */
function setMemoryStatus(enabled) {
  const status = $('memory-status');
  if (status) status.dataset.off = String(!enabled);
  const label = $('memory-status-label');
  if (label) label.textContent = enabled ? '长期记忆' : '记忆已关';
}

/** The three dots for the gap before any content at all has arrived. */
function dots() {
  const box = el('div', 'dots');
  box.append(el('span'), el('span'), el('span'));
  return box;
}

/**
 * The assistant's face, drawn from the symbol in the page.
 *
 * The test shim has no `createElementNS`, so it gets the empty span and the
 * class it asserts on; a browser gets the drawing. Nothing here is model text,
 * and nothing goes through innerHTML.
 */
function mascotAvatar() {
  const face = el('span', 'msg-avatar');
  face.setAttribute('aria-hidden', 'true');
  if (typeof document.createElementNS === 'function') {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 64 64');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#sprout-avatar');
    svg.append(use);
    face.append(svg);
  }
  return face;
}

function addTurn(role, text = '') {
  transcript.classList.remove('empty');
  const turn = el('div', `turn ${role}`);
  const bubble = el('div', 'bubble');
  if (role === 'assistant') bubble.append(mascotAvatar());
  const body = el('div', 'text');
  // User text stays literal; only the assistant's prose is Markdown. A person
  // who types ** on purpose should see exactly what they typed.
  if (text) {
    if (role === 'assistant') renderText(body, text);
    else body.textContent = text;
  }
  bubble.append(body);
  turn.append(bubble);

  const meta = el('div', 'meta');
  const note = el('span');
  const actions = el('span');
  meta.append(note, actions);
  turn.append(meta);

  transcript.append(turn);
  scrollToEnd();
  return { turn, bubble, text: body, note, actions };
}

/**
 * The reasoning block.
 *
 * The model thinks for several seconds before its first visible character, and
 * without this the person watches a motionless `…` and cannot tell a slow reply
 * from a stalled one. It is shown as a margin note rather than as part of the
 * reply — its own muted tone, and closed the moment the answer begins — so the
 * answer stays the thing being read. See ADR 010.
 *
 * Built from DOM nodes rather than markup because the text inside is model
 * output, and the chevron is drawn from a border so no icon markup is needed.
 */
function addThinking(bubble) {
  const box = el('div', 'thinking');
  box.dataset.open = 'true';
  box.dataset.state = 'live';

  const label = el('span', 'label', '正在想…');
  const head = el('button', 'thinking-head');
  head.type = 'button';
  head.setAttribute('aria-expanded', 'true');
  head.append(el('span', 'dot'), label, el('span', 'chev'));

  const stream = el('span');
  const body = el('div', 'thinking-body');
  body.append(stream);

  box.append(head, body);
  bubble.prepend(box);

  let open = true;
  // Once the person opens or closes it themselves, stop deciding for them.
  let touched = false;
  let tailing = true;
  let closed = false;

  const setOpen = (next) => {
    open = next;
    box.dataset.open = String(next);
    head.setAttribute('aria-expanded', String(next));
  };
  head.onclick = () => {
    touched = true;
    setOpen(!open);
  };

  // Follow the tail while it streams, but do not fight someone who has
  // scrolled up to read what was already said.
  body.addEventListener('scroll', () => {
    tailing = body.scrollHeight - body.scrollTop - body.clientHeight < 24;
  });

  return {
    append(text) {
      stream.textContent += text;
      if (tailing) body.scrollTop = body.scrollHeight;
    },
    /** Idempotent: the first close wins, whichever path reached it. */
    close(summary) {
      if (closed) return;
      closed = true;
      box.dataset.state = 'done';
      label.textContent = summary;
      if (!touched) setOpen(false);
    },
    finish(elapsedMs) {
      // Round up: "思考了 0 秒" reads as a bug even when it is accurate.
      this.close(`思考了 ${Math.max(1, Math.round(elapsedMs / 1000))} 秒`);
    },
    abort() {
      this.close('思考过程');
    },
  };
}

/**
 * The tool trace.
 *
 * A coding turn is mostly actions the model does not put into prose: which file
 * it read, what it ran, whether it worked. The server sends a one-line summary
 * and a duration, never the tool output — the reply is where the result belongs,
 * and a trace that repeated a file's contents would double the thing the person
 * is trying to read.
 */
function addToolTrace(bubble) {
  const box = el('div', 'tool-trace');
  box.dataset.open = 'true';

  const label = el('span', 'tool-trace-label', '工具');
  const count = el('span', 'tool-trace-count', '0');
  const head = el('button', 'tool-trace-head');
  head.type = 'button';
  head.setAttribute('aria-expanded', 'true');
  head.append(label, count, el('span', 'chev'));

  const body = el('div', 'tool-trace-body');
  box.append(head, body);

  // Keep the trace after the reasoning block, above the reply text: it is
  // context for the answer, not part of it.
  const thinkingNode = bubble.querySelector('.thinking');
  if (thinkingNode) thinkingNode.after(box);
  else bubble.prepend(box);

  let open = true;
  head.onclick = () => {
    open = !open;
    box.dataset.open = String(open);
    head.setAttribute('aria-expanded', String(open));
  };

  const rows = new Map();
  let total = 0;

  return {
    call(event) {
      const row = el('div', 'tool-row');
      row.dataset.state = 'running';
      row.dataset.callId = event.callId;
      const summary = el('span', 'tool-summary', event.summary || '');
      const state = el('span', 'tool-state', '运行中');
      if (event.source === 'mcp') row.append(el('span', 'tool-source', 'MCP'));
      row.append(el('span', 'tool-name', event.originLabel || event.name), summary, state);
      body.append(row);
      rows.set(event.callId, { row, summary, state });
      total += 1;
      count.textContent = String(total);
      body.scrollTop = body.scrollHeight;
    },
    resolve(event) {
      const entry = rows.get(event.callId);
      if (!entry) return;
      entry.row.dataset.state = event.ok ? 'ok' : 'error';
      if (event.summary) entry.summary.textContent = event.summary;
      const duration =
        typeof event.durationMs === 'number'
          ? ` · ${(event.durationMs / 1000).toFixed(1)}s`
          : '';
      entry.state.textContent = `${event.ok ? '完成' : '失败'}${duration}`;
      if (!event.ok && event.error) entry.row.title = event.error;
      if (event.sources) addSourceCards(entry.row, event.sources);
      noteToolResult(event.name, event.summary || entry.summary.textContent, event.ok);
    },
    finish() {
      for (const entry of rows.values()) {
        if (entry.row.dataset.state !== 'running') continue;
        entry.row.dataset.state = 'ok';
        entry.state.textContent = '完成';
      }
    },
  };
}

/**
 * The sources a web tool actually returned, under its trace row.
 *
 * The server only forwards a title, an http(s) URL and the metadata it really
 * has. This function trusts none of that blindly: it drops anything without a
 * title or a safe URL instead of inventing one, and it always says either the
 * real cost or "费用未知". A missing date is printed as unknown; today's date
 * is never substituted for a search result's publication date.
 */
function addSourceCards(row, sources) {
  if (!Array.isArray(sources) || sources.length === 0) return;
  const box = el('div', 'source-cards');
  box.setAttribute('role', 'list');
  box.setAttribute('aria-label', '来源');
  let count = 0;
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    const url = typeof source.url === 'string' ? source.url.trim() : '';
    const title = typeof source.title === 'string' ? source.title.trim() : '';
    if (title.length === 0 || !/^https?:\/\//i.test(url)) continue;
    const card = el('div', 'source-card');
    card.setAttribute('role', 'listitem');
    const link = el('a', 'source-title', title);
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    card.append(link);
    card.append(el('span', 'source-url', url));
    const meta = el('div', 'source-meta');
    if (typeof source.costUsd === 'number' && Number.isFinite(source.costUsd)) {
      meta.append(el('span', 'source-cost', `费用 $${source.costUsd.toFixed(4)}`));
    } else {
      meta.append(el('span', 'source-cost unknown', '费用未知'));
    }
    if (typeof source.provider === 'string' && source.provider.length > 0) {
      meta.append(el('span', null, source.provider));
    }
    if (typeof source.publishedAt === 'string' && source.publishedAt.length > 0) {
      meta.append(el('span', null, `日期 ${source.publishedAt}`));
    } else if (typeof source.fetchedAt === 'string' && source.fetchedAt.length > 0) {
      meta.append(el('span', null, `抓取 ${source.fetchedAt}`));
    } else {
      meta.append(el('span', 'source-date unknown', '日期未知'));
    }
    if (typeof source.query === 'string' && source.query.length > 0) {
      meta.append(el('span', null, `查询「${source.query}」`));
    }
    card.append(meta);
    if (typeof source.snippet === 'string' && source.snippet.length > 0) {
      card.append(el('p', 'source-snippet', source.snippet));
    }
    box.append(card);
    count += 1;
  }
  if (count === 0) return;
  box.dataset.callId = row.dataset.callId || '';
  row.after(box);
}

function scrollToEnd() {
  transcript.scrollTop = transcript.scrollHeight;
}

function notice(text) {
  const box = el('div', 'notice', text);
  transcript.classList.remove('empty');
  transcript.append(box);
  scrollToEnd();
}

// ---------------------------------------------------------- permissions ----

/**
 * The permission control.
 *
 * The server owns every rule — which modes exist, what each one means, whether
 * auto-review is on — and this side only draws the answer. That is deliberate:
 * a client that hard-codes "four modes" (or the risk levels) drifts from the
 * deployment the first time an operator narrows `SANDBOX_PERMISSION_ALLOWED_MODES`.
 *
 * Two things are stateful here, both of them UI state rather than policy:
 *
 *   - the pill shows the mode of the open conversation, or the deployment
 *     default when no conversation is open yet;
 *   - an approval card is created from the `tool_result` event's `approval`
 *     field, keyed by approval id so a retried call does not draw it twice.
 */

/** Cards by approval id, so a repeated event updates rather than duplicates. */
const approvalCards = new Map();
/** Only the newest permission read may paint. */
let permissionRequest = 0;
/** Menu visibility is state, not a read of the attribute: the attribute is the
 *  paint, and a test shim (or a browser mid-transition) may not reflect it. */
let permMenuOpen = false;

function permissionEnabled() {
  return Boolean(localToken);
}

function permissionHeaders() {
  return { 'Content-Type': 'application/json', 'X-Eunoia-Token': localToken };
}

async function refreshPermissions() {
  const pill = $('perm-pill');
  if (!pill) return;
  if (!permissionEnabled()) {
    pill.hidden = true;
    return;
  }
  const request = ++permissionRequest;
  const query = state.conversationId
    ? `?conversationId=${encodeURIComponent(state.conversationId)}`
    : '';
  const response = await fetch(`/api/permissions${query}`).catch(() => null);
  // A slower earlier read has nothing useful to say about the current view.
  if (request !== permissionRequest) return;
  if (!response || !response.ok) {
    pill.hidden = true;
    return;
  }
  const payload = await response.json().catch(() => null);
  // A partial answer is worse than none: without `modes` there is no menu to
  // draw, and assuming it exists would throw inside a fire-and-forget call.
  if (!payload || payload.enabled === false || !Array.isArray(payload.modes)) {
    pill.hidden = true;
    return;
  }
  state.permission = payload;
  pill.hidden = false;
  paintPermissionPill();
  if (isPermissionMenuOpen()) paintPermissionMenu();
  reconcileApprovalCards(payload);
}

/**
 * Bring a card in line with the queue after a refresh.
 *
 * The same request can be decided from the menu, from the CLI, or from another
 * tab; a card that kept saying "等你批准" after that would be a stale prompt.
 */
function reconcileApprovalCards(permission) {
  const approvals = permission.approvals || [];
  for (const [id, card] of approvalCards) {
    if (!card.isConnected) {
      approvalCards.delete(id);
      continue;
    }
    if (card.dataset.state !== 'pending') continue;
    const record = approvals.find((entry) => entry.approvalRequestId === id);
    if (!record) continue;
    if (record.status === 'APPROVED') finishApprovalCard(card, true);
    else if (record.status === 'DENIED') finishApprovalCard(card, false);
  }
}

function paintPermissionPill() {
  const permission = state.permission;
  const pill = $('perm-pill');
  if (!permission || !pill) return;
  const option = permission.modes.find((entry) => entry.id === permission.mode);
  $('perm-label').textContent = option ? option.label : permission.mode;
  pill.dataset.mode = permission.mode;
  const pending = permission.pending ? permission.pending.length : 0;
  pill.dataset.pending = String(pending);
  $('perm-count').textContent = pending > 0 ? String(pending) : '';
  pill.title = pending > 0 ? `${pending} 个操作等你批准` : '权限模式';
}

function isPermissionMenuOpen() {
  return permMenuOpen;
}

function openPermissionMenu() {
  const menu = $('perm-menu');
  const pill = $('perm-pill');
  if (!menu || !pill) return;
  paintPermissionMenu();
  permMenuOpen = true;
  menu.hidden = false;
  pill.setAttribute('aria-expanded', 'true');
  placePermissionMenu();
}

function closePermissionMenu() {
  const menu = $('perm-menu');
  const pill = $('perm-pill');
  permMenuOpen = false;
  if (menu) menu.hidden = true;
  if (pill) pill.setAttribute('aria-expanded', 'false');
}

/**
 * Put the menu above the pill, or below it when the pill is near the top.
 *
 * Measured after the menu is visible: a hidden element has no height, and the
 * first paint used to jump.
 */
function placePermissionMenu() {
  const menu = $('perm-menu');
  const pill = $('perm-pill');
  if (!menu || !pill) return;
  const rect = pill.getBoundingClientRect();
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  // Right-aligned to the pill: the pill sits at the end of the composer bar, so
  // a left-aligned menu would hang past the window edge before it clamps.
  const left = Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12));
  const above = rect.top - height - 8;
  const top =
    above >= 12 ? above : Math.min(rect.bottom + 8, window.innerHeight - height - 12);
  menu.style.left = `${left}px`;
  menu.style.top = `${Math.max(12, top)}px`;
}

function labelOfMode(mode) {
  const option = state.permission?.modes.find((entry) => entry.id === mode);
  return option ? option.label : mode;
}

/**
 * Risk levels arrive as the deployment spells them; the page reads in Chinese.
 *
 * A map rather than a server field: the levels are a closed set in the permission
 * types, and putting the translation here keeps the API free of display copy.
 */
const RISK_LABELS = { low: '低', medium: '中', high: '高', critical: '危急' };

function riskLabel(level) {
  return RISK_LABELS[level] || level;
}

function paintPermissionMenu() {
  const permission = state.permission;
  const menu = $('perm-menu');
  if (!menu || !permission) return;
  menu.textContent = '';
  menu.append(el('div', 'perm-menu-title', '权限模式'));

  // Read at click time, not at paint time: the checkbox below can change after
  // the options were drawn.
  let remember = permission.default_mode === permission.mode;

  for (const option of permission.modes) {
    const button = el('button', 'perm-option');
    button.type = 'button';
    button.setAttribute('aria-current', String(option.id === permission.mode));
    button.append(
      el('span', 'name', option.label),
      el('span', 'desc', option.description),
    );
    button.onclick = () => void changePermissionMode(option.id, remember);
    menu.append(button);
  }

  // The one thing about a mode that is invisible until it fires.
  const auto = permission.auto_review;
  const human = permission.approval?.requireHumanForRiskLevels ?? [];
  menu.append(
    el(
      'div',
      'perm-note',
      permission.mode === 'auto' && auto && auto.enabled
        ? `自动审核会批准「${auto.allowedRiskLevels.map(riskLabel).join(' / ')}」风险；「${human.map(riskLabel).join(' / ')}」仍然问你。`
        : '自动审核只在「自动」模式里参与；其他模式需要扩展时直接问你。',
    ),
  );

  if (permission.pending && permission.pending.length > 0) {
    menu.append(el('div', 'perm-sep'));
    menu.append(el('div', 'perm-menu-title', `等你的批准（${permission.pending.length}）`));
    for (const entry of permission.pending) menu.append(pendingApprovalRow(entry));
  }

  menu.append(el('div', 'perm-sep'));
  const rememberLabel = el('label', 'perm-remember');
  const box = el('input');
  box.type = 'checkbox';
  box.checked = remember;
  box.onchange = () => {
    remember = box.checked;
    const fallback = permission.deployment?.mode ?? permission.mode;
    void setRememberedMode(box.checked ? permission.mode : fallback);
  };
  rememberLabel.append(box, el('span', null, '新对话也用这个模式'));
  menu.append(rememberLabel);
}

async function changePermissionMode(mode, remember) {
  // There is no task to scope a policy to until the conversation exists; a
  // conversation is created by the first message.
  if (!state.conversationId) {
    closePermissionMenu();
    notice('先发一句话；权限模式是跟着对话走的。');
    return;
  }
  const response = await fetch('/api/permissions/mode', {
    method: 'POST',
    headers: permissionHeaders(),
    body: JSON.stringify({ conversationId: state.conversationId, mode, remember }),
  }).catch(() => null);
  const payload = response ? await response.json().catch(() => ({})) : {};
  if (!response || !response.ok) {
    notice(`没能切换：${payload.error || '请求没有到达'}`);
    return;
  }
  closePermissionMenu();
  await refreshPermissions();
  notice(`已切换到「${labelOfMode(mode)}」。下一次动手会按新的权限执行。`);
}

async function setRememberedMode(mode) {
  const response = await fetch('/api/preferences', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ 'permission.mode.default': mode }),
  }).catch(() => null);
  if (!response || !response.ok) {
    notice('没能记住这个默认模式。');
    return;
  }
  await refreshPermissions();
}

/** The compact row the menu uses for requests opened in an earlier turn. */
function pendingApprovalRow(entry) {
  const row = el('div', 'perm-pending-item');
  row.append(
    el(
      'div',
      'perm-pending-title',
      `${entry.tool || '工具调用'} · ${entry.risk_level ? `${riskLabel(entry.risk_level)}风险` : '未知风险'}`,
    ),
  );
  if (entry.resource) row.append(el('div', 'perm-pending-resource', entry.resource));
  if (entry.reason) row.append(el('div', 'perm-pending-resource', entry.reason));

  const actions = el('div', 'perm-pending-actions');
  const approve = el('button', null, '批准');
  approve.type = 'button';
  approve.onclick = () =>
    void decideFromMenu(entry.approvalRequestId, 'approve', { scope: 'once', ttlSeconds: 60 });
  const deny = el('button', null, '拒绝');
  deny.type = 'button';
  deny.onclick = () => void decideFromMenu(entry.approvalRequestId, 'deny', {});
  actions.append(approve, deny);
  row.append(actions);
  return row;
}

async function decideFromMenu(approvalRequestId, action, options) {
  const response = await fetch(
    `/api/permissions/approvals/${approvalRequestId}/${action}`,
    {
      method: 'POST',
      headers: permissionHeaders(),
      body: JSON.stringify(options),
    },
  ).catch(() => null);
  const payload = response ? await response.json().catch(() => ({})) : {};
  if (!response || !response.ok) {
    notice(`没能${action === 'approve' ? '批准' : '拒绝'}：${payload.error || '请求没有到达'}`);
    return;
  }
  closePermissionMenu();
  await refreshPermissions();
  notice(
    action === 'approve'
      ? '已批准。让 ta 重试刚才那一步；批准只对下一次同样的调用生效。'
      : '已拒绝，这次调用不会再执行。',
  );
}

/**
 * The card under a stopped tool call.
 *
 * Drawn from the event rather than from a poll so the person sees the request
 * in the same breath as the failed row; the menu's pending list is the fallback
 * for a page that was reloaded.
 */
function addApprovalCard(bubble, event) {
  const approval = event.approval;
  if (!approval || !approval.approvalRequestId) return;
  const existing = approvalCards.get(approval.approvalRequestId);
  if (existing && existing.isConnected) return;

  const card = el('div', 'approval');
  card.dataset.state = 'pending';
  card.append(el('div', 'approval-head', `需要你批准：${event.name}`));

  const body = el('div', 'approval-body');
  if (event.summary) body.append(el('div', null, event.summary));
  if (event.error) body.append(el('div', null, event.error));
  card.append(body, el('div', 'approval-actions'));

  bubble.append(card);
  approvalCards.set(approval.approvalRequestId, card);
  renderApprovalActions(card, approval.approvalRequestId);
  scrollToEnd();
}

function renderApprovalActions(card, approvalRequestId) {
  const actions = card.querySelector('.approval-actions');
  actions.textContent = '';
  const once = el('button', 'primary', '批准一次');
  once.type = 'button';
  once.onclick = () =>
    void decideInCard(card, approvalRequestId, 'approve', { scope: 'once', ttlSeconds: 60 });
  const forAWhile = el('button', null, '批准 30 分钟');
  forAWhile.type = 'button';
  forAWhile.onclick = () =>
    void decideInCard(card, approvalRequestId, 'approve', { scope: 'task', ttlSeconds: 1800 });
  const deny = el('button', null, '拒绝');
  deny.type = 'button';
  deny.onclick = () => void decideInCard(card, approvalRequestId, 'deny', {});
  actions.append(once, forAWhile, deny);
}

async function decideInCard(card, approvalRequestId, action, options) {
  const actions = card.querySelector('.approval-actions');
  for (const button of actions.querySelectorAll('button')) button.disabled = true;
  const response = await fetch(
    `/api/permissions/approvals/${approvalRequestId}/${action}`,
    {
      method: 'POST',
      headers: permissionHeaders(),
      body: JSON.stringify(options),
    },
  ).catch(() => null);
  const payload = response ? await response.json().catch(() => ({})) : {};
  if (!response || !response.ok) {
    actions.textContent = '';
    const retry = el('button', null, '重试');
    retry.type = 'button';
    retry.onclick = () => void decideInCard(card, approvalRequestId, action, options);
    actions.append(
      el('span', 'perm-error', `失败：${payload.error || '网络错误'}`),
      retry,
    );
    return;
  }
  finishApprovalCard(card, action === 'approve');
  await refreshPermissions();
}

function finishApprovalCard(card, approved) {
  card.dataset.state = approved ? 'approved' : 'denied';
  const head = card.querySelector('.approval-head');
  if (head) head.textContent = approved ? '已批准' : '已拒绝';

  const body = card.querySelector('.approval-body');
  if (body) {
    body.append(
      el(
        'div',
        null,
        approved
          ? '批准只对下一次同样的调用生效：点下面的按钮让 ta 接着做。'
          : '这次调用不会再执行。',
      ),
    );
  }

  const actions = card.querySelector('.approval-actions');
  actions.textContent = '';
  if (approved) {
    const again = el('button', 'primary', '让 ta 继续');
    again.type = 'button';
    again.onclick = () => {
      // A tool can be approved while the turn is still streaming; starting a
      // second turn now would be dropped by `send` and the button would stay
      // disabled with nothing to explain it.
      if (state.sending) {
        notice('这一轮还没说完，等它停下来再让它继续。');
        return;
      }
      again.disabled = true;
      void send('已经批准了，请继续刚才那一步。');
    };
    actions.append(again);
  }
}

// ------------------------------------------------------------ transport ----

/**
 * Parse an SSE byte stream by hand.
 *
 * `EventSource` cannot be used: it only issues GET, and the chat endpoint is
 * POST — putting a person's message in a URL would leak it into access logs and
 * browser history. Reading the body as a stream is also exactly what the
 * mini-program client has to do, so this logic transfers rather than being
 * thrown away.
 */
/**
 * Parse an SSE byte stream by hand.
 *
 * `EventSource` cannot be used: it only issues GET, and the chat endpoint is
 * POST — putting a person's message in a URL would leak it into access logs and
 * browser history. Reading the body as a stream is also exactly what the
 * mini-program client has to do, so this logic transfers rather than being
 * thrown away.
 *
 * Line endings are accepted as either LF or CRLF (a proxy may normalise them),
 * multiple `data:` lines are joined as the SSE spec says, and a final frame
 * without the trailing blank line is still parsed. A malformed payload is
 * dropped rather than killing the stream; the next frame is probably fine.
 */
async function* readFrames(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const parseFrame = (frame) => {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data) return null;
    try {
      return JSON.parse(data);
    } catch {
      return null;
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let match = /\r?\n\r?\n/.exec(buffer);
    while (match) {
      const event = parseFrame(buffer.slice(0, match.index));
      buffer = buffer.slice(match.index + match[0].length);
      if (event) yield event;
      match = /\r?\n\r?\n/.exec(buffer);
    }
  }

  buffer += decoder.decode();
  const tail = parseFrame(buffer);
  if (tail) yield tail;
}

/** The two states of the composer's one button. */
const SEND_LABELS = { send: '发送', stop: '停止生成' };

function setSendMode(mode) {
  sendButton.dataset.mode = mode;
  // While a turn is running the button must not submit the form — it stops the
  // turn instead. The type flip is what makes one element able to do both.
  sendButton.type = mode === 'stop' ? 'button' : 'submit';
  sendButton.setAttribute('aria-label', SEND_LABELS[mode] ?? '发送');
}

/** An abort is how a stop and a cut connection both surface. */
function isAbortError(error) {
  return error?.name === 'AbortError';
}

/**
 * A v4 uuid for the turn id.
 *
 * `crypto.randomUUID` is only available in a secure context, and this page can
 * be opened over plain http on a LAN address the operator allowed. Sending must
 * not depend on where the page was opened, so the bytes are filled directly.
 */
function newTurnId() {
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Ask the server to stop the turn that is streaming.
 *
 * Deliberately does *not* cut the connection on the normal path: the server
 * persists the partial reply and sends an `interrupted` frame on the existing
 * stream, and aborting here would throw that away. The connection is the
 * fallback, for a server that cannot be reached or has already forgotten the
 * turn.
 */
async function stopTurn() {
  const turn = state.turn;
  if (!turn || turn.stopping) return;
  turn.stopping = true;
  sendButton.disabled = true;
  sendButton.setAttribute('aria-label', '正在停止…');

  // A stop that never lands must still end. This fires only while this exact
  // turn is the active one, so a late timer cannot abort a later turn; the
  // turn's own finally clears it when the stream ends first.
  turn.watchdog = setTimeout(() => {
    if (state.turn === turn) turn.controller.abort();
  }, 5000);

  const response = await fetch('/api/chat/stop', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ turnId: turn.id }),
  }).catch(() => null);

  // Either the server accepted it and the interruption is on its way, or this
  // turn already ended (the stream is finishing on its own). Wait for the
  // stream in both cases; the watchdog above is the backstop.
  if (!response || !response.ok) return;
  const result = await response.json().catch(() => ({}));
  if (result.stopped === false) return;
}

/**
 * Mark a turn as stopped and, when it belongs to a conversation, offer the one
 * action that makes sense next: continue from the break.
 */
function addContinueAction(note, onContinue) {
  note.textContent = '';
  note.classList.add('interrupted-note');
  // Built from nodes rather than by appending a bare string: the test DOM
  // models children, and a text node would not survive there.
  note.append(el('span', null, '已打断'), el('span', null, ' · '));
  const again = el('button', null, '继续');
  again.type = 'button';
  again.onclick = () => {
    again.disabled = true;
    onContinue();
  };
  note.append(again);
}

const MAX_ATTACHMENTS = 5;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

function humanBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * A conversation is where uploads live, so attaching a file before the first
 * message creates the thread here rather than making the person send something
 * first. The chat request then joins it like any other.
 */
async function ensureConversationForUpload() {
  if (state.conversationId) return state.conversationId;
  const modelId = state.pendingModelId || state.selectedModelId;
  const response = await fetch('/api/conversations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(modelId ? { modelId } : {}),
  }).catch(() => null);
  if (!response || !response.ok) throw new Error('创建会话失败');
  const payload = await response.json().catch(() => ({}));
  const id = payload?.conversation?.id;
  if (!id) throw new Error('创建会话失败');
  rememberConversation(id);
  void refreshHistory();
  return id;
}

function renderAttachments() {
  attachRow.textContent = '';
  attachRow.hidden = state.attachments.length === 0 && state.uploading === 0;
  for (const [index, file] of state.attachments.entries()) {
    const chip = el('span', 'attach-chip');
    chip.append(el('span', 'name', file.name), el('span', 'size', humanBytes(file.bytes)));
    const remove = el('button', null, '×');
    remove.type = 'button';
    remove.setAttribute('aria-label', `移除 ${file.name}`);
    remove.onclick = () => {
      state.attachments.splice(index, 1);
      renderAttachments();
    };
    chip.append(remove);
    attachRow.append(chip);
  }
  if (state.uploading > 0) {
    const pending = el('span', 'attach-chip', '上传中…');
    pending.dataset.state = 'uploading';
    attachRow.append(pending);
  }
}

// ------------------------------------------------------------ images ----

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

function isVisualImage(file) {
  const type = String(file?.type || '').toLowerCase();
  if (IMAGE_TYPES.includes(type)) return true;
  // A browser can leave `type` empty for a drag from some file managers. The
  // extension is only a hint; the server still decodes and verifies the bytes.
  return /\.(jpe?g|png|webp)$/i.test(String(file?.name || ''));
}

function mediaLimits() {
  return (
    state.mediaLimits || {
      maxImagesPerMessage: 5,
      maxImageBytes: 10 * 1024 * 1024,
      maxDimension: 8192,
      maxPixels: 40000000,
    }
  );
}

function releasePreview(draft) {
  if (!draft?.objectUrl) return;
  try {
    URL.revokeObjectURL(draft.objectUrl);
  } catch {
    // The URL already went away with the page; nothing to release.
  }
  draft.objectUrl = null;
}

function currentModel() {
  return state.models.find((model) => model.id === state.selectedModelId) || null;
}

function modelSupportsImages() {
  const model = currentModel();
  // Unknown declarations are not a reason to block locally: the server owns the
  // decision, and it returns an actionable code. Only a declared "unsupported"
  // is shown as a definite incompatibility.
  return model ? model.input?.image === 'supported' : null;
}

function modelLabel(model) {
  const visual = model?.input?.image === 'supported' ? ' · 可看图' : '';
  return `${model?.displayName || model?.id || '模型'}${visual}`;
}

async function refreshModelCapabilities() {
  const response = await fetch('/api/media/capabilities').catch(() => null);
  if (!response || !response.ok) return;
  const payload = await response.json().catch(() => null);
  if (!payload) return;
  state.mediaLimits = payload.limits || null;
  state.models = Array.isArray(payload.models) ? payload.models : [];
  state.defaultModelId = payload.defaultModelId || null;
  state.selectedModelId = state.selectedModelId || state.defaultModelId;
  if (!modelSelect) return;
  modelSelect.textContent = '';
  for (const model of state.models) {
    const option = el('option', null, modelLabel(model));
    option.value = model.id;
    option.disabled = model.available === false;
    modelSelect.append(option);
  }
  modelSelect.hidden = state.models.length === 0;
  if (state.selectedModelId) modelSelect.value = state.selectedModelId;
  renderMediaDrafts();
}

async function chooseModel(modelId) {
  state.selectedModelId = modelId || null;
  if (!state.conversationId) {
    // Saved locally; `ensureConversationForUpload` creates the conversation with
    // it. The current message is not rewritten either way.
    state.pendingModelId = modelId || null;
    renderMediaDrafts();
    return;
  }
  const response = await fetch(`/api/conversations/${state.conversationId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ modelId: modelId || null }),
  }).catch(() => null);
  if (!response || !response.ok) {
    notice('模型切换没有保存，请再试一次。');
  }
  renderMediaDrafts();
}

function addDraftMedia(body, drafts) {
  if (drafts.length === 0) return;
  const strip = el('div', 'msg-media');
  for (const draft of drafts) {
    const src = draft.asset?.url || draft.objectUrl;
    if (!src) {
      strip.append(el('span', 'missing', '图片不可用'));
      continue;
    }
    const button = el('button');
    button.type = 'button';
    button.setAttribute('aria-label', `查看图片 ${draft.name}`);
    const img = el('img');
    img.src = src;
    img.alt = draft.name;
    button.append(img);
    button.onclick = () => openImagePreview(src, draft.name);
    strip.append(button);
  }
  body.append(strip);
}

/**
 * Render stored blocks in their stored order.
 *
 * The order is the message: "第一张是设计稿，第二张是实现" means nothing if the
 * transcript puts both images after both paragraphs. Consecutive images share
 * one strip; a text block between them starts a new one.
 */
function renderStoredParts(body, parts) {
  let strip = null;
  for (const part of parts) {
    if (part.type === 'text') {
      if (strip) {
        body.append(strip);
        strip = null;
      }
      body.append(el('span', null, part.text));
      continue;
    }
    if (!strip) {
      strip = el('div', 'msg-media');
      body.append(strip);
    }
    const meta = part.image;
    if (!meta || meta.status === 'missing' || !meta.url) {
      strip.append(el('span', 'missing', '图片不可用'));
      continue;
    }
    const button = el('button');
    button.type = 'button';
    button.setAttribute('aria-label', `查看图片 ${meta.name}`);
    const img = el('img');
    img.src = meta.url;
    img.alt = meta.name;
    img.loading = 'lazy';
    button.append(img);
    button.onclick = () => openImagePreview(meta.url, meta.name);
    strip.append(button);
  }
  if (strip) body.append(strip);
}

let previewOverlay = null;
let previewReturnFocus = null;

function closeImagePreview() {
  if (!previewOverlay) return;
  previewOverlay.remove();
  previewOverlay = null;
  if (previewReturnFocus?.focus) previewReturnFocus.focus();
  previewReturnFocus = null;
}

function openImagePreview(src, name) {
  closeImagePreview();
  previewReturnFocus = document.activeElement;
  const overlay = el('div', 'image-preview');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', `预览 ${name}`);
  const img = el('img');
  img.src = src;
  img.alt = name;
  const bar = el('div', 'preview-bar');
  const caption = el('span', null, name);
  const close = el('button', 'preview-close', '关闭');
  close.type = 'button';
  close.onclick = () => closeImagePreview();
  bar.append(caption, close);
  const wrap = el('div');
  wrap.append(img, bar);
  overlay.append(wrap);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) closeImagePreview();
  });
  if (document.body) document.body.append(overlay);
  previewOverlay = overlay;
  close.focus?.();
}

function renderMediaDrafts() {
  if (!mediaRow) return;
  mediaRow.textContent = '';
  mediaRow.hidden = state.mediaDrafts.length === 0;
  for (const draft of state.mediaDrafts) {
    const card = el('div', 'media-card');
    card.dataset.state = draft.state;
    const src = draft.asset?.url || draft.objectUrl;
    if (src) {
      const img = el('img');
      img.src = src;
      img.alt = draft.name;
      card.append(img);
    }
    const meta = el('div', 'media-meta');
    meta.append(el('span', 'media-name', draft.name));
    const detail =
      draft.state === 'failed'
        ? draft.error || '上传失败'
        : draft.state === 'uploading' || draft.state === 'local'
          ? '上传中…'
          : `${draft.asset?.width || '?'}×${draft.asset?.height || '?'} · ${humanBytes(
              draft.asset?.bytes ?? draft.bytes,
            )}`;
    meta.append(el('span', null, detail));
    if (draft.state === 'failed') {
      const retry = el('button', 'media-retry', '重试');
      retry.type = 'button';
      retry.onclick = () => void uploadImageDraft(draft);
      meta.append(retry);
    }
    card.append(meta);

    const remove = el('button', null, '×');
    remove.type = 'button';
    remove.setAttribute('aria-label', `移除 ${draft.name}`);
    remove.onclick = () => void removeImageDraft(draft);
    card.append(remove);
    mediaRow.append(card);
  }

  const ready = state.mediaDrafts.filter((draft) => draft.state === 'ready');
  if (ready.length > 0 && modelSupportsImages() === false) {
    mediaRow.append(
      el(
        'div',
        'media-warning',
        '当前模型不支持图片。可以换到“可看图”的模型，或移除图片；图片会保留不丢。',
      ),
    );
  }
  if (!state.sending) sendButton.disabled = state.uploading > 0;
}

function nextDraftKey() {
  state.draftSeq = (state.draftSeq || 0) + 1;
  return `img-${state.draftSeq}`;
}

function createImageDraft(file) {
  const draft = {
    key: nextDraftKey(),
    file,
    name: file.name || 'image',
    bytes: file.size || 0,
    state: 'local',
    asset: null,
    error: null,
    objectUrl: null,
    conversationId: null,
  };
  try {
    if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
      draft.objectUrl = URL.createObjectURL(file);
    }
  } catch {
    // A preview is a convenience; the upload can proceed without one.
  }
  return draft;
}

async function uploadImageDraft(draft) {
  if (!draft || draft.state === 'uploading' || draft.state === 'ready') return;
  const limits = mediaLimits();
  if (draft.bytes > limits.maxImageBytes) {
    draft.state = 'failed';
    draft.error = `超过 ${humanBytes(limits.maxImageBytes)}`;
    renderMediaDrafts();
    return;
  }

  draft.state = 'uploading';
  draft.error = null;
  state.uploading += 1;
  renderMediaDrafts();
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  draft.controller = controller;

  try {
    const conversationId = await ensureConversationForUpload();
    draft.conversationId = conversationId;
    const query =
      `conversationId=${encodeURIComponent(conversationId)}` +
      `&name=${encodeURIComponent(draft.name)}`;
    const response = await fetch(`/api/media/images?${query}`, {
      method: 'POST',
      headers: { 'Content-Type': draft.file.type || 'application/octet-stream' },
      body: draft.file,
      ...(controller ? { signal: controller.signal } : {}),
    }).catch(() => null);
    const payload = await response?.json().catch(() => ({}));
    if (!response || !response.ok || !payload?.asset) {
      const error = payload?.error;
      throw new Error(
        (error && typeof error === 'object' ? error.message : error) ||
          `HTTP ${response?.status ?? '网络错误'}`,
      );
    }

    // A late answer belongs to the conversation the upload started in. Putting
    // it into the current draft strip would attach A's image to B's message.
    if (state.conversationId !== conversationId) {
      void fetch(`/api/media/images/${encodeURIComponent(payload.asset.id)}`, {
        method: 'DELETE',
      }).catch(() => undefined);
      releasePreview(draft);
      draft.state = 'failed';
      draft.error = '会话已切换，图片没有加入当前对话';
      return;
    }

    draft.asset = payload.asset;
    draft.name = payload.asset.name || draft.name;
    releasePreview(draft);
    draft.state = 'ready';
    if (payload.asset.url) draft.objectUrl = null;
  } catch (error) {
    if (error?.name === 'AbortError') {
      draft.state = 'failed';
      draft.error = '上传已取消';
    } else {
      draft.state = 'failed';
      draft.error = error?.message || String(error);
    }
  } finally {
    draft.controller = null;
    state.uploading = Math.max(0, state.uploading - 1);
    renderMediaDrafts();
  }
}

async function removeImageDraft(draft) {
  const index = state.mediaDrafts.indexOf(draft);
  if (index === -1) return;
  if (draft.controller) draft.controller.abort();
  state.mediaDrafts.splice(index, 1);
  releasePreview(draft);
  renderMediaDrafts();
  // A ready-but-unbound image is a draft on the server too; release it rather
  // than waiting for the 24h sweep. A bound image answers 409 and is left alone.
  if (draft.asset?.id) {
    void fetch(`/api/media/images/${encodeURIComponent(draft.asset.id)}`, {
      method: 'DELETE',
    }).catch(() => undefined);
  }
}

function clearImageDrafts() {
  for (const draft of state.mediaDrafts) {
    if (draft.controller) draft.controller.abort();
    releasePreview(draft);
  }
  state.mediaDrafts = [];
  renderMediaDrafts();
}

/**
 * Partition selected or pasted files: pictures go to the visual queue, other
 * files keep the existing workspace upload path. The two are deliberately not
 * silently merged — only one of them makes the model see pixels.
 */
function addFilesByKind(files) {
  const list = Array.from(files ?? []);
  const images = [];
  const others = [];
  for (const file of list) {
    if (isVisualImage(file)) images.push(file);
    else others.push(file);
  }
  if (others.length > 0) void addFiles(others);
  if (images.length > 0) void addImageFiles(images);
}

async function addImageFiles(files) {
  const limits = mediaLimits();
  const existing = state.mediaDrafts.length;
  const room = Math.max(0, limits.maxImagesPerMessage - existing);
  if (room === 0) {
    notice(`一次最多发送 ${limits.maxImagesPerMessage} 张图片。`);
    return;
  }
  const accepted = [];
  for (const file of Array.from(files ?? []).slice(0, room)) {
    if (file.size > limits.maxImageBytes) {
      notice(`${file.name} 超过 ${humanBytes(limits.maxImageBytes)}，没有上传。`);
      continue;
    }
    const draft = createImageDraft(file);
    state.mediaDrafts.push(draft);
    accepted.push(draft);
  }
  if (state.mediaDrafts.length > limits.maxImagesPerMessage) {
    notice(`一次最多发送 ${limits.maxImagesPerMessage} 张图片。`);
  }
  renderMediaDrafts();
  // Sequential: one conversation is created once and the server's decode gate
  // is the thing that should decide decode concurrency, not this loop.
  for (const draft of accepted) await uploadImageDraft(draft);
}

/**
 * Upload files one at a time.
 *
 * Sequential rather than `Promise.all`: the failure message names the file, and
 * five parallel 10 MB uploads on a local server gain nothing but a bigger memory
 * spike. A failed file is skipped; the others still go.
 */
async function addFiles(files) {
  for (const file of Array.from(files ?? [])) {
    if (state.attachments.length + state.uploading >= MAX_ATTACHMENTS) {
      notice(`一次最多附上 ${MAX_ATTACHMENTS} 个文件。`);
      break;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      notice(`${file.name} 超过 10 MB，没有上传。`);
      continue;
    }

    state.uploading += 1;
    renderAttachments();
    try {
      const conversationId = await ensureConversationForUpload();
      const query =
        `conversationId=${encodeURIComponent(conversationId)}` +
        `&name=${encodeURIComponent(file.name)}`;
      const response = await fetch(`/api/uploads?${query}`, {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: file,
      }).catch(() => null);
      const payload = await response?.json().catch(() => ({}));
      if (!response || !response.ok || !payload?.attachment) {
        throw new Error(payload?.error || `HTTP ${response?.status ?? '网络错误'}`);
      }
      state.attachments.push(payload.attachment);
    } catch (error) {
      notice(`上传失败：${error?.message ?? String(error)}`);
    } finally {
      state.uploading -= 1;
      renderAttachments();
    }
  }
}

/** Rerun the last reply: drop it, then let the server repeat the user turn. */
function regenerateTurn(turnEl) {
  if (state.sending || !state.conversationId) return;
  turnEl.remove();
  void send('', { regenerate: true });
}

async function send(text, options = {}) {
  if (state.sending) return;
  const regenerate = options.regenerate === true;
  const retry = options.retry === true;
  // A retry of an accepted-but-cut turn must resend the *same* body: the image
  // drafts were deliberately cleared once the server accepted them, and
  // rebuilding the payload from an empty strip would change the request digest.
  const resend = options.resend && typeof options.resend === 'object' ? options.resend : null;
  const readyImages = state.mediaDrafts.filter((draft) => draft.state === 'ready' && draft.asset);
  if (regenerate && !state.conversationId) return;
  if (!regenerate && state.uploading > 0) {
    notice('图片还在上传，等它完成再发送。');
    return;
  }
  if (!regenerate && !resend && readyImages.length > 0 && modelSupportsImages() === false) {
    notice('当前模型不支持图片，先换到“可看图”的模型，或移除图片。');
    return;
  }
  if (!regenerate && !options.continue && !retry && !resend) {
    if (text.trim().length === 0 && readyImages.length === 0 && state.attachments.length === 0) {
      notice('说点什么，或者选一张图片。');
      return;
    }
    // A non-default model selection has to exist before the first chat request,
    // because the server pins the route to the conversation it admits.
    if (!state.conversationId && state.selectedModelId && state.selectedModelId !== state.defaultModelId) {
      await ensureConversationForUpload().catch(() => undefined);
    }
  }
  state.sending = true;
  startMcpPolling();
  const turn = {
    // A retry reuses the idempotency key; the server answers from the record
    // instead of running the same request twice.
    id: options.requestId || newTurnId(),
    controller: new AbortController(),
    stopping: false,
    watchdog: null,
  };
  state.turn = turn;
  // Deliberately *not* disabled: this button is the stop control now, and a
  // disabled button never receives the click. `type="button"` plus the
  // `state.sending` guard is what prevents a second turn, not `disabled`.
  setSendMode('stop');
  // A continuation or a regeneration is not what the person was typing; keep
  // any draft.
  if (!options.continue && !regenerate && !retry) {
    input.value = '';
    resize();
  }

  if (!regenerate && !retry) {
    // Only the newest reply can be regenerated; the previous turn's control is
    // no longer the last one once this send starts.
    for (const node of transcript.querySelectorAll('.msg-regenerate')) node.remove();

    // The server derives a title from the first message, but the sidebar and the
    // topbar should not sit on "新的对话" while it does. This is the same rule.
    if (!state.conversationId || !conversationTitles.get(state.conversationId)) {
      setThreadTitle(deriveTitle(text || (readyImages.length > 0 ? '图片' : '对话')));
    }
    const echo = addTurn('user', text);
    addDraftMedia(echo.text, readyImages);
  }

  const { turn: turnEl, bubble, text: body, note, actions } = addTurn('assistant');
  const waiting = dots();
  body.append(waiting);
  body.dataset.streaming = 'true';

  let thinking = null;
  let trace = null;
  let reply = '';
  let workspaceChanges = null;
  let messageId = null;

  /** Drop the placeholder the moment there is anything real to show. */
  const settled = () => {
    if (waiting.isConnected) waiting.remove();
  };

  // A full re-render per delta is O(n²) over the reply and forces a layout on
  // every token. Coalesce deltas to one paint per frame; `completed` still
  // renders synchronously, so the final text is never waiting on a frame.
  let renderQueued = false;
  const scheduleRender = () => {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      renderText(body, reply);
      scrollToEnd();
    });
  };

  /**
   * End the turn as stopped rather than failed.
   *
   * `event` is the server's `interrupted` frame when there was one; its text is
   * authoritative because it is what was persisted. A cut connection has no
   * event, and then whatever was rendered locally is what remains.
   */
  const finishInterrupted = (event) => {
    thinking?.abort();
    trace?.finish();
    settled();
    const partial = (event?.text || reply).trim();
    if (partial.length > 0) {
      reply = partial;
      renderText(body, partial);
    } else {
      // Nothing visible was produced (the stop landed during reasoning or a
      // tool call). Keep the turn — and any tool trace in it — rather than
      // making the work look like it never happened.
      body.textContent = '';
    }
    if (event?.conversationId) {
      const untitled = !conversationTitles.get(event.conversationId);
      rememberConversation(event.conversationId);
          void pollMcpPending();
          void pollQuestions();
      if (untitled) void refreshHistory();
    }
    messageId = event?.messageId ?? null;
    if (state.conversationId) {
      addContinueAction(note, () => void send('继续', { continue: true }));
    } else {
      // Nothing to continue from: the turn never reached a stored conversation.
      note.textContent = '已打断';
      note.classList.add('interrupted-note');
    }
    scrollToEnd();
  };

  let terminal = false;

  try {
    const endpoint = regenerate ? '/api/chat/regenerate' : '/api/chat';
    // `requestId` is the idempotency key: a retry that reuses it is answered
    // from the recorded outcome instead of running the model twice. It shares a
    // value with `turnId` because both identify this send, and the stop request
    // needs the latter.
    // The visual message uses the versioned block field; a text-only send keeps
    // the legacy field so its request digest is unchanged.
    const parts = [];
    if (text.trim().length > 0) parts.push({ type: 'text', text });
    for (const draft of readyImages) {
      parts.push({ type: 'image', assetId: draft.asset.id });
    }
    const structured = readyImages.length > 0 && parts.length > 0;
    const payload = regenerate
      ? { conversationId: state.conversationId, turnId: turn.id, requestId: turn.id }
      : resend ?? {
          ...(structured ? { content: { version: 1, parts } } : { message: text }),
          conversationId: state.conversationId,
          turnId: turn.id,
          requestId: turn.id,
          ...(options.continue ? { continue: true } : {}),
          ...(state.attachments.length > 0
            ? { attachments: state.attachments.map((file) => file.path) }
            : {}),
        };
    if (!regenerate) turn.sentPayload = payload;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: turn.controller.signal,
    });

    if (!response.ok || !response.body) {
      const detail = await response.json().catch(() => ({}));
      const error = detail.error;
      const message =
        error && typeof error === 'object'
          ? `${error.message}${error.code ? `（${error.code}）` : ''}`
          : error || `HTTP ${response.status}`;
      throw new Error(message);
    }

    if (!regenerate) {
      // The server accepted the turn: the drafts are now message references, so
      // keeping them on the strip would attach them to the next message too.
      if (state.attachments.length > 0) {
        state.attachments = [];
        renderAttachments();
      }
      if (readyImages.length > 0) clearImageDrafts();
    }

    for await (const event of readFrames(response)) {
      if (event.type === 'thinking_delta') {
        settled();
        // Created on the first delta, so a turn the model answers without
        // thinking never grows an empty block.
        thinking ??= addThinking(bubble);
        thinking.append(event.text);
      } else if (event.type === 'thinking_done') {
        thinking?.finish(event.elapsedMs);
      } else if (event.type === 'text_delta') {
        settled();
        // The server always closes the block before the first reply delta, so
        // this only fires if that ever stops being true.
        thinking?.abort();
        reply += event.text;
        scheduleRender();
      } else if (event.type === 'memory_retrieved') {
        note.textContent = event.count > 0 ? `参考了 ${event.count} 条记忆` : '';
      } else if (event.type === 'safety_notice') {
        if (event.replaced) notice('这一轮触发了安全回应。如果你现在很危险，请打 120 或 110。');
      } else if (event.type === 'completed') {
        terminal = true;
        trace?.finish();
        reply = event.text;
        workspaceChanges = event.workspaceChanges ?? null;
        renderText(body, reply);
        // Only when the server names one: a turn that was not persisted reports
        // null, and taking that at face value would forget a conversation that
        // is still perfectly good.
        if (event.conversationId) {
          const untitled = !conversationTitles.get(event.conversationId);
          rememberConversation(event.conversationId);
          // The first persisted turn is also the moment the conversation earns
          // its title and its row, so this is the one refresh that matters.
          if (untitled) void refreshHistory();
        }
        messageId = event.messageId ?? null;
        // The text is kept either way; this line only says whether the model
        // actually finished. Without it, a cut stream looked like a full answer
        // until the person reached the half sentence at the end.
        if (event.finishReason === 'incomplete_stream') {
          note.textContent = '回复可能未完整：连接在结束信号之前断开了';
        } else if (event.finishReason === 'budget_exhausted') {
          note.textContent = '上下文预算用尽，这一轮先停在这里';
        }
      } else if (event.type === 'interrupted') {
        terminal = true;
        workspaceChanges = event.workspaceChanges ?? workspaceChanges;
        finishInterrupted(event);
      } else if (event.type === 'error') {
        terminal = true;
        throw new Error(event.message);
      } else if (event.type === 'tool_call') {
        settled();
        trace ??= addToolTrace(bubble);
        trace.call(event);
      } else if (event.type === 'approval_required') {
        settled();
        addMcpApprovalCard(bubble, event);
      } else if (event.type === 'tool_result') {
        trace?.resolve(event);
        if (event.approval) addApprovalCard(bubble, event);
      } else if (event.type === 'loop_exhausted') {
        note.textContent = `达到 ${event.steps} 步工具上限`;
      }
    }

    // A stream that ends without a terminal frame is also how a stop surfaces
    // when the server's `interrupted` frame could not be delivered (the turn
    // was aborted before it started streaming). Only a stop is inferred here:
    // a genuinely cut connection is left as it was rather than guessed at.
    if (!terminal && turn.stopping) finishInterrupted(null);

    // The toolbar is added for an interrupted reply too when there is text:
    // the half that was said is still the part someone might want to keep.
    addMessageActions(actions, {
      content: reply,
      messageId,
      canRegenerate: Boolean(messageId) && Boolean(state.conversationId),
      regenerate: () => regenerateTurn(turnEl),
      undo: workspaceChanges,
    });
  } catch (error) {
    // A stop also surfaces as an AbortError when the connection had to be cut.
    if (isAbortError(error) && turn.stopping) {
      finishInterrupted(null);
    } else if (regenerate) {
      // The old turn was removed optimistically. Read the transcript back so a
      // refused regeneration (409) restores the reply that is still in the
      // database, rather than leaving an error bubble in its place.
      turnEl.remove();
      if (state.conversationId) await loadConversation(state.conversationId);
      notice(`重新生成失败：${error.message}`);
    } else {
      // A half-shown thought with no ending is worse than none; close it.
      thinking?.abort();
      trace?.finish();
      settled();
      body.textContent = '';
      body.append(el('span', null, `出错了：${error.message}`));
      body.style.color = 'var(--danger)';
      // A retry reuses the same request id: if the turn was actually accepted
      // before the connection broke, the server replays its outcome instead of
      // running the model again. The image drafts were kept on failure, so this
      // does not re-upload anything.
      const retryButton = el('button', null, '重试');
      retryButton.type = 'button';
      retryButton.onclick = () => {
        turnEl.remove();
        void send(text, {
          requestId: turn.id,
          retry: true,
          ...(turn.sentPayload ? { resend: turn.sentPayload } : {}),
        });
      };
      body.append(retryButton);
    }
  } finally {
    // Whether it finished, failed, or was cut off, nothing is arriving now.
    delete body.dataset.streaming;
    if (turn.watchdog) clearTimeout(turn.watchdog);
    state.sending = false;
    stopMcpPolling();
    state.turn = null;
    sendButton.disabled = false;
    setSendMode('send');
    scrollToEnd();
    // A turn can leave a request pending; the badge has to learn about it even
    // if this client chose not to draw the card.
    void refreshPermissions();
  }
}

function addFeedback(actions, messageId) {
  // The caller has already cleared the row for the toolbar; clearing here would
  // delete the copy/read/export controls that precede the rating buttons.
  const up = el('button', null, '有帮助');
  const down = el('button', null, '不太对');
  up.type = 'button';
  down.type = 'button';

  const rate = async (rating) => {
    state.feedback.set(messageId, rating);
    up.setAttribute('aria-pressed', String(rating === 'good'));
    down.setAttribute('aria-pressed', String(rating === 'bad'));
    await fetch('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageId, rating }),
    }).catch(() => undefined);
  };

  up.onclick = () => void rate('good');
  down.onclick = () => void rate('bad');
  actions.append(up, down);
}

// --------------------------------------------------------- conversations ----

/**
 * The conversation id survives a reload.
 *
 * `localStorage` rather than the URL, because a URL is a thing people paste and
 * a conversation is private. Both directions are wrapped: storage throws in some
 * privacy modes, and failing to remember which conversation this is costs less
 * than a page that will not start.
 */
const STORAGE_KEY = 'df_conversation';

function rememberConversation(id) {
  state.conversationId = id;
  try {
    if (id) localStorage.setItem(STORAGE_KEY, id);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // The conversation still works for this page view; only the reload is lost.
  }
  markActiveThread();
  if (!id) setThreadTitle('新的对话');
  else updateThreadTitle();
  // The permission mode is per conversation, so the pill has to follow the
  // thread; a stale label would claim a mode this task is not running under.
  void refreshPermissions();
}

function recallConversation() {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/** "刚刚" / "12 分钟前" / "3 小时前" / "9 月 28 日" */
function whenLabel(iso) {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return '';
  const minutes = Math.round((Date.now() - then.getTime()) / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)} 小时前`;
  return `${then.getMonth() + 1} 月 ${then.getDate()} 日`;
}

/**
 * Render a stored conversation.
 *
 * No streaming and no reasoning block: those described a turn while it was
 * happening, and replaying them would be a re-enactment rather than a record.
 * What is drawn is what was said.
 */
async function loadConversation(id) {
  const response = await fetch(`/api/conversations/${id}/messages`).catch(() => null);
  if (!response || !response.ok) return false;

  // `?? []` rather than trusting the shape: a proxy or a future server that
  // answers 200 with something else should leave the page usable, not throw
  // inside a click handler where nothing is listening for it.
  const payload = await response.json();
  const { messages = [], modelId = null } = payload ?? {};
  if (messages.length === 0) return false;
  // The route is pinned to the conversation; the selector follows it rather than
  // claiming the process default.
  if (modelId) {
    state.selectedModelId = modelId;
    if (modelSelect) modelSelect.value = modelId;
    renderMediaDrafts();
  }

  transcript.textContent = '';
  transcript.classList.remove('empty');
  // Staged files belong to the thread they were uploaded for.
  state.attachments = [];
  renderAttachments();
  clearImageDrafts();
  for (const [index, message] of messages.entries()) {
    const rendered =
      message.role === 'user' && Array.isArray(message.contentParts?.parts)
        ? addTurn('user', '')
        : addTurn(message.role, message.content);
    const { turn, note, actions } = rendered;
    if (message.role === 'user' && Array.isArray(message.contentParts?.parts)) {
      renderStoredParts(rendered.text, message.contentParts.parts);
    }
    if (message.role === 'assistant') {
      const last = index === messages.length - 1;
      if (message.interrupted) {
        // Only the reply that is still the last thing said can be continued;
        // an older break was already continued by whatever follows it.
        if (last) {
          addContinueAction(note, () => void send('继续', { continue: true }));
        } else {
          note.textContent = '已打断';
          note.classList.add('interrupted-note');
        }
      }
      addMessageActions(actions, {
        content: message.content,
        messageId: message.id,
        canRegenerate: last,
        regenerate: () => regenerateTurn(turn),
      });
    }
  }
  rememberConversation(id);
  setThreadTitle(conversationTitles.get(id) ?? '对话');
  scrollToEnd();
  return true;
}

function setHistoryNote(text) {
  $('history-note').textContent = text;
}

/** Clear the transcript and forget which conversation it was. */
function clearConversationView() {
  rememberConversation(null);
  state.attachments = [];
  renderAttachments();
  clearImageDrafts();
  transcript.textContent = '';
  transcript.classList.add('empty');
  // On mobile the list covers the canvas; starting a new conversation is a
  // decision to leave it.
  if (historyDrawer) historyDrawer.dataset.open = 'false';
  input.focus();
}

async function refreshHistory() {
  const request = ++historyRequest;
  const list = $('history-list');
  list.textContent = '';
  setHistoryNote('');
  threadNodes.clear();
  conversationTitles.clear();

  // Archived rows are a separate view, not a second list. The server keeps them
  // out of the ordinary response, so the toggle has to ask for them explicitly.
  const response = await fetch(
    state.showArchived ? '/api/conversations?includeArchived=1' : '/api/conversations',
  ).catch(() => null);
  // A slower earlier request has nothing useful to say about the current view.
  if (request !== historyRequest) return;
  if (!response || !response.ok) {
    list.append(el('div', 'empty-note', '读不到历史对话。'));
    return;
  }

  const { conversations = [] } = await response.json();
  if (request !== historyRequest) return;
  if (conversations.length === 0) {
    list.append(el('div', 'empty-note', '还没有对话，从第一句开始吧。'));
    return;
  }

  for (const conversation of conversations) {
    const archived = Boolean(conversation.archivedAt);
    const row = el('div', 'thread-row');
    if (conversation.id === state.conversationId) row.classList.add('active');

    const open = el('button', 'thread');
    open.type = 'button';
    const named = Boolean(conversation.title);
    // The mark is the first grid cell, but `name` and `when` stay direct
    // children so a row can still be read without unpacking a wrapper.
    open.append(el('span', 'thread-mark'));
    open.append(
      el('span', `name${named ? '' : ' unnamed'}`, conversation.title ?? '（没有名字的对话）'),
    );
    const when = whenLabel(conversation.lastTurnAt ?? conversation.startedAt);
    open.append(el('span', 'when', archived ? `${when} · 已归档` : when));
    open.setAttribute('aria-current', String(conversation.id === state.conversationId));
    open.onclick = async () => {
      // Already open: just close the drawer rather than re-fetching what is
      // already on screen.
      if (conversation.id !== state.conversationId) await loadConversation(conversation.id);
      if (historyDrawer) historyDrawer.dataset.open = 'false';
    };

    threadNodes.set(conversation.id, open);
    conversationTitles.set(conversation.id, conversation.title ?? '');

    // A conversation has a lifecycle, so the row does too: rename and archive
    // are reversible; delete asks twice because it is not.
    const actions = el('div', 'thread-actions');
    const rename = el('button', null, '改名');
    rename.type = 'button';
    rename.onclick = () => beginRename(row, conversation);

    const archive = el('button', null, archived ? '恢复' : '归档');
    archive.type = 'button';
    archive.onclick = () => void setArchived(conversation, !archived);

    const remove = el('button', 'thread-delete', '删除');
    remove.type = 'button';
    remove.onclick = () => void deleteThread(conversation, remove);

    actions.append(rename, archive, remove);
    row.append(open, actions);
    list.append(row);
  }

  // No title to adopt for a brand-new conversation; the composer keeps the
  // optimistic one set at send time until the server names it.
  if (state.conversationId) updateThreadTitle();
}

function beginRename(row, conversation) {
  setHistoryNote('');
  row.textContent = '';

  const editor = el('div', 'thread-rename');
  const field = el('input');
  field.value = conversation.title ?? '';
  field.setAttribute('maxlength', '80');
  field.setAttribute('aria-label', '对话名称');

  const save = el('button', 'primary', '保存');
  save.type = 'button';
  const cancel = el('button', null, '取消');
  cancel.type = 'button';

  const commit = async () => {
    save.disabled = true;
    const response = await fetch(`/api/conversations/${conversation.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: field.value }),
    }).catch(() => null);
    save.disabled = false;

    if (!response || !response.ok) {
      setHistoryNote('改名失败，稍后再试。');
      field.focus();
      return;
    }
    await refreshHistory();
  };

  save.onclick = () => void commit();
  cancel.onclick = () => void refreshHistory();
  field.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void commit();
    } else if (event.key === 'Escape') {
      void refreshHistory();
    }
  });

  editor.append(field, save, cancel);
  row.append(editor);
  field.focus();
}

async function setArchived(conversation, archived) {
  setHistoryNote('');
  const response = await fetch(`/api/conversations/${conversation.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ archived }),
  }).catch(() => null);

  if (!response || !response.ok) {
    setHistoryNote(archived ? '归档失败，稍后再试。' : '恢复失败，稍后再试。');
    return;
  }

  // Archiving the conversation that is on screen would leave an open thread
  // with no row in the list. Start clean instead of hiding it underneath.
  if (archived && state.conversationId === conversation.id) clearConversationView();
  await refreshHistory();
}

async function deleteThread(conversation, button) {
  if (button.dataset.armed !== 'true') {
    button.dataset.armed = 'true';
    button.textContent = '确认删除';
    setTimeout(() => {
      if (!button.isConnected) return;
      button.dataset.armed = 'false';
      button.textContent = '删除';
    }, 4000);
    return;
  }

  setHistoryNote('');
  button.disabled = true;
  button.textContent = '删除中…';
  const response = await fetch(`/api/conversations/${conversation.id}`, {
    method: 'DELETE',
  }).catch(() => null);

  if (!response || !response.ok) {
    setHistoryNote('删除失败，稍后再试。');
    button.disabled = false;
    button.dataset.armed = 'false';
    button.textContent = '删除';
    return;
  }

  if (state.conversationId === conversation.id) clearConversationView();
  await refreshHistory();
}

// -------------------------------------------------------------- memory ------

async function openDrawer() {
  // On mobile the drawer and the conversation list are two layers; opening the
  // upper one should put the lower one away.
  if (historyDrawer) historyDrawer.dataset.open = 'false';
  $('drawer').dataset.open = 'true';
  await refreshMemory();
}

async function refreshMemory() {
  const list = $('memory-list');
  list.textContent = '';

  const response = await fetch('/api/memory').catch(() => null);
  if (!response || !response.ok) {
    list.append(el('div', 'empty-note', '读不到记忆。'));
    return;
  }

  const { memories, enabled } = await response.json();
  state.memoryEnabled = enabled;
  $('memory-enable').textContent = enabled ? '开' : '关';
  $('memory-enable').setAttribute('aria-pressed', String(enabled));
  setMemoryStatus(enabled);

  const active = memories.filter((m) => m.status !== 'deleted');
  const count = $('memory-count');
  if (count) count.textContent = active.length > 0 ? `${active.length} 条` : '';
  if (active.length === 0) {
    list.append(el('div', 'empty-note', '还没有记住什么。'));
    return;
  }

  const sourceLabels = {
    user_explicit: '你让我记住的',
    user_stated: '你说过的',
    inferred: '我的推测',
  };
  const typeLabels = { episodic: '一件事', semantic: '关于你', narrative: '你正在经历的' };

  for (const memory of active) {
    const item = el('div', 'memory');
    item.append(el('p', null, memory.content));

    const tags = el('div', 'tags');
    const label = el('span', 'tag' + (memory.status === 'unconfirmed' ? ' unconfirmed' : ''),
      `${sourceLabels[memory.source] ?? memory.source} · ${typeLabels[memory.type] ?? memory.type}` +
      (memory.status === 'unconfirmed' ? ' · 待确认' : ''));
    tags.append(label);

    if (memory.accessCount > 0) tags.append(el('span', null, `被想起 ${memory.accessCount} 次`));

    const remove = el('button', null, '删除');
    remove.type = 'button';
    remove.onclick = async () => {
      await fetch(`/api/memory/${memory.id}`, { method: 'DELETE' }).catch(() => undefined);
      await refreshMemory();
    };
    tags.append(remove);

    item.append(tags);
    list.append(item);
  }
}

// ------------------------------------------------------- forgetting all -----

/**
 * Delete everything (spec §44, `deletion`).
 *
 * Two clicks rather than a `confirm()` dialog, for the same reason the rest of
 * this panel avoids modals: a browser dialog is a thing people dismiss on
 * reflex, and the reflex is trained by dialogs that do not matter. Arming the
 * button changes what it says and what it looks like, so the second click is
 * made deliberately.
 *
 * The armed state expires, because a button left armed while the drawer sits
 * open is a button that eventually gets clicked by someone who has forgotten
 * why it is red.
 */
const FORGET_ARM_MS = 5000;
let forgetTimer = null;

async function forgetEverything() {
  const button = $('forget-all');
  const armed = button.dataset.armed === 'true';

  if (!armed) {
    button.dataset.armed = 'true';
    button.textContent = '再点一次，删除';
    clearTimeout(forgetTimer);
    forgetTimer = setTimeout(disarmForget, FORGET_ARM_MS);
    return;
  }

  clearTimeout(forgetTimer);
  button.disabled = true;
  button.textContent = '正在删除…';

  const response = await fetch('/api/me', { method: 'DELETE' }).catch(() => null);
  button.disabled = false;

  if (!response || !response.ok) {
    // Left armed would be a trap: the next click would delete after a failure
    // the person was never told about.
    disarmForget();
    button.textContent = '删除失败，稍后再试';
    return;
  }

  // The client's half of the deletion. The cookie is gone, so the conversation
  // id in `localStorage` now points at nothing, and a transcript left on screen
  // would be the only remaining copy of what was just deleted.
  rememberConversation(null);
  transcript.textContent = '';
  transcript.classList.add('empty');
  $('history-list').textContent = '';
  disarmForget();
  button.textContent = '都删掉了';
  // The transcript's empty state is a stylesheet rule, not an element, so the
  // confirmation goes where the click was rather than over the top of it.
  setTimeout(() => { if (!button.disabled) button.textContent = '删除全部数据'; }, 2500);
}

function disarmForget() {
  const button = $('forget-all');
  button.dataset.armed = 'false';
  button.textContent = '删除全部数据';
}

// ------------------------------------------------------------- workbench ----

const workbench = $('workbench');
const wbBody = $('wb-body');
const wbTree = $('wb-tree');
const wbChanges = $('wb-changes');
const wbTerminal = $('wb-terminal');
const wbPreview = $('wb-preview');
const wbPreviewBody = $('wb-preview-body');
const wbPicker = $('wb-picker');
const wbPickerList = $('wb-picker-list');
const WB_OPEN_KEY = 'df_workbench_open';
const WB_TAB_KEY = 'df_workbench_tab';
const WB_TABS = ['files', 'changes', 'terminal'];

const wbState = {
  open: false,
  tab: 'files',
  info: null,
  statePromise: null,
  levels: new Map(),
  expanded: new Set(),
  preview: null,
  previewToken: 0,
  gitStatus: null,
  gitLoading: false,
  sessionChanges: new Map(),
  terminalBusy: false,
  terminalHistory: [],
  terminalIndex: -1,
  pickerPath: '',
  pickerParent: null,
  pickerRooted: false,
};

function wbBaseName(path) {
  const parts = String(path ?? '').split('/').filter(Boolean);
  return parts[parts.length - 1] || path || '';
}

function wbFormatBytes(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function wbExt(name) {
  const clean = String(name ?? '');
  if (clean === '.env.example' || clean === '.env.sample' || clean === '.env.template') return 'ENV';
  const dot = clean.lastIndexOf('.');
  if (dot > 0 && dot < clean.length - 1) {
    return clean.slice(dot + 1, dot + 5).toUpperCase();
  }
  const known = {
    Dockerfile: 'DOCK',
    Makefile: 'MAKE',
    LICENSE: 'LIC',
    README: 'MD',
  };
  return known[clean] ?? '·';
}

function wbNote(text, kind = '') {
  return el('div', kind ? `wb-note ${kind}` : 'wb-note', text);
}

function persistWorkbench() {
  try {
    localStorage.setItem(WB_OPEN_KEY, wbState.open ? 'true' : 'false');
    localStorage.setItem(WB_TAB_KEY, wbState.tab);
  } catch {
    // The choice still applies to this page view.
  }
}

function recallWorkbench() {
  try {
    return {
      open: localStorage.getItem(WB_OPEN_KEY) === 'true',
      tab: localStorage.getItem(WB_TAB_KEY),
    };
  } catch {
    return { open: false, tab: null };
  }
}

function paintTabs() {
  for (const tab of WB_TABS) {
    const button = $(`wb-tab-${tab}`);
    if (button) button.setAttribute('aria-selected', String(tab === wbState.tab));
    const pane = $(`wb-${tab}-pane`);
    if (pane) pane.dataset.active = String(tab === wbState.tab);
  }
}

function paintFoot() {
  const foot = $('wb-foot');
  if (!foot) return;
  foot.textContent = '';
  const info = wbState.info;
  if (!info?.configured) {
    foot.append(el('span', null, '选择一个目录后，这里显示文件、改动和终端。'));
    return;
  }
  if (info.agentRoot && info.agentRoot !== info.root) {
    foot.append(el('span', null, 'agent 工具目录：'));
    foot.append(el('code', null, info.agentRoot));
  } else {
    foot.append(el('span', null, '文件只读 · 终端运行在你自己的 shell 里'));
  }
  if (!info.terminal) foot.append(el('span', null, ' · 终端已关闭'));
  if (!info.git) foot.append(el('span', null, ' · 未检测到 git'));
  if (!info.agentRoot) foot.append(el('span', null, ' · agent 文件工具未启用'));
}

function paintTerminalChrome() {
  const info = wbState.info;
  const ready = Boolean(info?.configured && info?.terminal);
  const input = $('wb-term-input');
  const run = $('wb-term-run');
  if (input) {
    input.disabled = !ready || wbState.terminalBusy;
    input.placeholder = ready ? '输入命令，回车运行' : '终端不可用';
  }
  if (run) run.disabled = !ready || wbState.terminalBusy;
  const cwd = $('wb-term-cwd');
  if (cwd) cwd.textContent = info?.configured ? wbBaseName(info.root) : '—';
}

function updateChangesCount() {
  const session = wbState.sessionChanges.size;
  const paths = new Set(wbState.sessionChanges.keys());
  for (const change of wbState.gitStatus?.changes ?? []) paths.add(change.path);
  const total = paths.size;
  const count = $('wb-changes-count');
  if (count) count.textContent = total > 0 ? String(total) : '';
  const tab = $('wb-tab-changes');
  if (tab) tab.dataset.hot = String(session > 0);
  const toggle = $('workspace-toggle');
  if (toggle) toggle.dataset.hot = String(!wbState.open && total > 0);
}

function paintWorkbench() {
  if (!workbench) return;
  workbench.dataset.open = String(wbState.open);
  const toggle = $('workspace-toggle');
  if (toggle) toggle.setAttribute('aria-pressed', String(wbState.open));
  const info = wbState.info;
  const configured = Boolean(info?.configured && info?.root);
  const name = $('wb-root-name');
  const path = $('wb-root-path');
  const rootButton = $('wb-root');
  if (name) name.textContent = configured ? info.name || wbBaseName(info.root) : '没有打开目录';
  if (path) path.textContent = configured ? info.root : '选择一个本地目录';
  if (rootButton) rootButton.title = configured ? info.root : '选择工作区目录';
  if (wbBody) wbBody.dataset.empty = String(!configured);
  paintTabs();
  paintFoot();
  paintTerminalChrome();
  updateChangesCount();
}

function setWorkbenchTab(tab) {
  wbState.tab = WB_TABS.includes(tab) ? tab : 'files';
  closePreview();
  paintTabs();
  persistWorkbench();
  if (!wbState.info?.configured) return;
  if (wbState.tab === 'files') {
    if (!wbState.levels.has('.')) void loadLevel('.');
  } else if (wbState.tab === 'changes') {
    void refreshChanges();
  } else if (wbState.tab === 'terminal') {
    renderTerminal();
    $('wb-term-input').focus();
  }
}

async function setWorkbenchOpen(open) {
  wbState.open = Boolean(open);
  paintWorkbench();
  persistWorkbench();
  if (wbState.open) {
    if (historyDrawer) historyDrawer.dataset.open = 'false';
    await ensureWorkbench();
    if (wbState.tab === 'terminal') $('wb-term-input').focus();
  } else {
    closePreview();
  }
}

async function loadWorkspaceState(force = false) {
  if (wbState.info && !force) return wbState.info;
  if (wbState.statePromise) return wbState.statePromise;
  wbState.statePromise = (async () => {
    const response = await fetch('/api/workspace').catch(() => null);
    if (!response || !response.ok) {
      wbState.info = { configured: false, root: null, name: null, terminal: false, git: false };
      paintWorkbench();
      return wbState.info;
    }
    const payload = await response.json().catch(() => ({}));
    const root = typeof payload.root === 'string' && payload.root.length > 0 ? payload.root : null;
    wbState.info = {
      configured: payload.configured === true && root !== null,
      root,
      name: typeof payload.name === 'string' ? payload.name : root ? wbBaseName(root) : null,
      source: payload.source ?? null,
      agentRoot: typeof payload.agentRoot === 'string' ? payload.agentRoot : null,
      terminal: payload.terminal === true,
      git: payload.git === true,
      maxFileBytes: payload.maxFileBytes ?? 0,
      browseStart: typeof payload.browseStart === 'string' ? payload.browseStart : '',
    };
    paintWorkbench();
    return wbState.info;
  })().finally(() => {
    wbState.statePromise = null;
  });
  return wbState.statePromise;
}

async function ensureWorkbench() {
  await loadWorkspaceState();
  if (!wbState.info?.configured) return;
  if (wbState.tab === 'files' && !wbState.levels.has('.')) await loadLevel('.');
  if (wbState.tab === 'changes') await refreshChanges();
  if (wbState.tab === 'terminal') renderTerminal();
}

async function loadLevel(path) {
  if (!wbState.info?.configured) return;
  const rootAtStart = wbState.info.root;
  const previous = wbState.levels.get(path);
  const seq = (previous?.seq ?? 0) + 1;
  wbState.levels.set(path, { state: 'loading', entries: [], truncated: false, seq });
  if (path === '.' || wbState.expanded.has(path)) renderTree();

  const response = await fetch(
    `/api/workspace/files?path=${encodeURIComponent(path)}`,
  ).catch(() => null);
  if (wbState.info?.root !== rootAtStart) return;
  const current = wbState.levels.get(path);
  if (!current || current.seq !== seq) return;

  if (!response || !response.ok) {
    const detail = response ? await response.json().catch(() => ({})) : {};
    wbState.levels.set(path, {
      state: 'failed',
      entries: [],
      truncated: false,
      seq,
      error: detail.error || '读不到这个目录。',
    });
    renderTree();
    return;
  }

  const payload = await response.json().catch(() => ({}));
  wbState.levels.set(path, {
    state: 'ready',
    entries: Array.isArray(payload.entries) ? payload.entries : [],
    truncated: payload.truncated === true,
    seq,
  });
  renderTree();

  for (const entry of payload.entries ?? []) {
    if (entry.type === 'directory' && wbState.expanded.has(entry.path)) {
      const childLevel = wbState.levels.get(entry.path);
      if (!childLevel || childLevel.state === 'failed') void loadLevel(entry.path);
    }
  }
}

function renderTree() {
  if (!wbTree) return;
  const scroll = wbTree.scrollTop;
  wbTree.textContent = '';
  const label = $('wb-path');
  if (label) label.textContent = wbState.info?.configured ? '工作区根目录' : '未选择目录';
  if (!wbState.info?.configured) return;
  wbTree.append(renderLevel('.'));
  wbTree.scrollTop = scroll;
}

function renderLevel(path) {
  const level = wbState.levels.get(path);
  const list = el('ul', 'wb-list');
  if (!level || level.state === 'loading') {
    list.append(wbNote('正在读取…'));
    return list;
  }
  if (level.state === 'failed') {
    list.append(wbNote(level.error || '读不到这个目录。', 'error'));
    return list;
  }
  if (level.entries.length === 0) {
    list.append(wbNote('空目录'));
    return list;
  }

  for (const entry of level.entries) {
    const item = el('li', 'wb-item');
    if (entry.type === 'directory') {
      const open = wbState.expanded.has(entry.path);
      const row = el('button', 'wb-row');
      row.type = 'button';
      row.dataset.type = 'directory';
      row.setAttribute('aria-expanded', String(open));
      row.append(el('span', 'wb-chev', '›'));
      row.append(el('span', 'wb-folder'));
      row.append(el('span', 'wb-name', entry.name));
      row.onclick = () => {
        if (wbState.expanded.has(entry.path)) wbState.expanded.delete(entry.path);
        else {
          wbState.expanded.add(entry.path);
          const level = wbState.levels.get(entry.path);
          if (!level || level.state === 'failed') void loadLevel(entry.path);
        }
        renderTree();
      };
      item.append(row);
      if (open) item.append(renderLevel(entry.path));
    } else if (entry.type === 'file') {
      const row = el('button', 'wb-row');
      row.type = 'button';
      row.dataset.type = 'file';
      row.append(el('span', 'wb-chev'));
      row.append(el('span', 'wb-ext', wbExt(entry.name)));
      row.append(el('span', 'wb-name', entry.name));
      row.onclick = () => void openFile(entry.path);
      item.append(row);
    } else {
      const row = el('button', 'wb-row');
      row.type = 'button';
      row.dataset.type = 'other';
      row.setAttribute('aria-disabled', 'true');
      row.title = '这不是文件或目录，没法打开。';
      row.append(el('span', 'wb-chev'));
      row.append(el('span', 'wb-ext', '·'));
      row.append(el('span', 'wb-name', entry.name));
      item.append(row);
    }
    list.append(item);
  }

  if (level.truncated) list.append(wbNote('条目太多，只显示了一部分。'));
  return list;
}

// ------------------------------------------------------------- preview ------

function openPreview(mode, path) {
  wbState.preview = { mode, path };
  wbState.previewToken += 1;
  if (wbPreview) wbPreview.dataset.open = 'true';
  const pathEl = $('wb-preview-path');
  if (pathEl) pathEl.textContent = path;
  const meta = $('wb-preview-meta');
  if (meta) meta.textContent = '读取中…';
  if (wbPreviewBody) {
    wbPreviewBody.textContent = '';
    wbPreviewBody.append(wbNote('正在读取…'));
  }
  void loadPreview();
}

function closePreview() {
  wbState.preview = null;
  wbState.previewToken += 1;
  if (wbPreview) wbPreview.dataset.open = 'false';
}

async function loadPreview() {
  const preview = wbState.preview;
  if (!preview) return;
  const token = ++wbState.previewToken;
  const meta = $('wb-preview-meta');
  if (wbPreviewBody) {
    wbPreviewBody.textContent = '';
    wbPreviewBody.append(wbNote('正在读取…'));
  }
  const query = `path=${encodeURIComponent(preview.path)}`;
  const url = preview.mode === 'diff'
    ? `/api/workspace/git/diff?${query}`
    : `/api/workspace/file?${query}`;
  const response = await fetch(url).catch(() => null);
  if (token !== wbState.previewToken) return;
  if (!response || !response.ok) {
    const detail = response ? await response.json().catch(() => ({})) : {};
    if (meta) meta.textContent = '';
    if (wbPreviewBody) {
      wbPreviewBody.textContent = '';
      wbPreviewBody.append(wbNote(detail.error || '读不到这个文件。', 'error'));
    }
    return;
  }
  const payload = await response.json().catch(() => ({}));
  if (token !== wbState.previewToken) return;
  if (preview.mode === 'diff') renderDiffPreview(payload);
  else renderFilePreview(payload);
}

function renderFilePreview(file) {
  if (!wbPreviewBody) return;
  const meta = $('wb-preview-meta');
  const total = Number(file.totalLines) || 0;
  wbPreviewBody.textContent = '';
  const text = typeof file.text === 'string' ? file.text : '';
  if (text.length === 0) {
    if (meta) meta.textContent = `0 行 · ${wbFormatBytes(file.size)}`;
    wbPreviewBody.append(wbNote('空文件。'));
    return;
  }
  let lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (meta) {
    // The server counts a trailing newline as a line; the gutter does not.
    const shownTotal = file.complete ? lines.length : total;
    meta.textContent = `${shownTotal} 行 · ${wbFormatBytes(file.size)}${file.complete ? '' : ' · 部分'}`;
  }
  const cap = 4000;
  const start = Number(file.start) || 1;
  for (let index = 0; index < Math.min(lines.length, cap); index += 1) {
    const row = el('div', 'wb-code-line');
    row.append(el('span', 'wb-ln', String(start + index)));
    row.append(el('span', 'wb-code', lines[index]));
    wbPreviewBody.append(row);
  }
  if (lines.length > cap) {
    wbPreviewBody.append(wbNote(`只显示前 ${cap} 行；完整文件有 ${total} 行。`));
  }
}

function renderDiffPreview(diff) {
  if (!wbPreviewBody) return;
  const meta = $('wb-preview-meta');
  const binary = diff.binary === true;
  const oversized = diff.oversized === true;
  const untracked = diff.untracked === true;
  if (meta) {
    meta.textContent = binary
      ? '二进制'
      : oversized
        ? '文件过大'
        : untracked
          ? '新增文件'
          : 'diff';
  }
  wbPreviewBody.textContent = '';
  if (binary) {
    wbPreviewBody.append(wbNote('这是二进制文件，没有文本差异。'));
    return;
  }
  if (oversized) {
    wbPreviewBody.append(wbNote('文件超过预览上限，没有读取内容。'));
    return;
  }
  const patch = typeof diff.patch === 'string' ? diff.patch : '';
  if (patch.trim().length === 0) {
    wbPreviewBody.append(wbNote('没有可见的文本差异。'));
    return;
  }
  const lines = patch.split('\n');
  const cap = 5000;
  for (let index = 0; index < Math.min(lines.length, cap); index += 1) {
    const line = lines[index];
    let kind = '';
    if (line.startsWith('@@')) kind = 'hunk';
    else if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff --git') || line.startsWith('index ')) kind = 'meta';
    else if (line.startsWith('+')) kind = 'add';
    else if (line.startsWith('-')) kind = 'del';
    wbPreviewBody.append(el('div', kind ? `wb-diff-line ${kind}` : 'wb-diff-line', line || ' '));
  }
  if (lines.length > cap) wbPreviewBody.append(wbNote(`只显示前 ${cap} 行 diff。`));
  if (diff.truncated) wbPreviewBody.append(wbNote('diff 太大，已经截断。'));
}

function openFile(path) {
  openPreview('file', path);
}

function openDiff(path) {
  openPreview('diff', path);
}

// ------------------------------------------------------------- changes ------

function statusLetter(change) {
  if (change.kind === 'untracked') return '?';
  if (change.kind === 'added') return 'A';
  if (change.kind === 'deleted') return 'D';
  if (change.kind === 'renamed') return 'R';
  if (change.kind === 'copied') return 'C';
  if (change.kind === 'modified') return 'M';
  if (change.kind === 'conflicted') return 'U';
  if (change.kind === 'typechange') return 'T';
  return '·';
}

function renderSessionChanges() {
  const paths = [...wbState.sessionChanges.entries()];
  if (paths.length === 0) return;
  wbChanges.append(el('div', 'wb-section-title', '本次对话改动'));
  for (const [path, kind] of paths) {
    const row = el('button', 'wb-change');
    row.type = 'button';
    row.append(el('span', `wb-change-badge ${kind}`, kind === 'untracked' ? '?' : 'M'));
    row.append(el('span', 'wb-change-path', path));
    row.append(el('span', 'wb-change-arrow', '›'));
    row.onclick = () => openFile(path);
    wbChanges.append(row);
  }
}

function renderChanges() {
  if (!wbChanges) return;
  wbChanges.textContent = '';
  if (!wbState.info?.configured) {
    wbChanges.append(wbNote('选择一个目录后才能读取改动。'));
    return;
  }

  renderSessionChanges();

  if (!wbState.info.git) {
    wbChanges.append(wbNote('没有检测到 git，改动只能看本次对话里工具写过的文件。'));
    updateChangesCount();
    return;
  }
  if (wbState.gitLoading) {
    wbChanges.append(wbNote('正在读取 git 状态…'));
    return;
  }
  const status = wbState.gitStatus;
  if (!status) {
    wbChanges.append(wbNote('还没有读取改动。'));
    return;
  }
  if (status.error) {
    wbChanges.append(wbNote(status.error, 'error'));
    return;
  }
  if (!status.repo) {
    wbChanges.append(wbNote('这个目录不在 git 仓库里。改动只能从本次对话里工具的结果看到。'));
    return;
  }

  const head = el('div', 'wb-git-head');
  head.append(el('span', 'wb-branch', status.branch || 'git'));
  head.append(el('span', null, `${status.changes?.length ?? 0} 个改动${status.truncated ? '（已截断）' : ''}`));
  wbChanges.append(head);

  if (!status.changes || status.changes.length === 0) {
    wbChanges.append(wbNote('工作区干净。'));
    updateChangesCount();
    return;
  }

  for (const change of status.changes) {
    const row = el('button', 'wb-change');
    row.type = 'button';
    row.title = change.status;
    row.append(el('span', `wb-change-badge ${change.kind}`, statusLetter(change)));
    row.append(el('span', 'wb-change-path', change.renamedFrom ? `${change.path} ← ${change.renamedFrom}` : change.path));
    row.append(el('span', 'wb-change-arrow', '›'));
    row.onclick = () => openDiff(change.path);
    wbChanges.append(row);
  }
  updateChangesCount();
}

async function refreshChanges() {
  if (!wbState.info?.configured) {
    renderChanges();
    return;
  }
  const rootAtStart = wbState.info.root;
  wbState.gitLoading = true;
  renderChanges();
  const response = await fetch('/api/workspace/git/status').catch(() => null);
  if (wbState.info?.root !== rootAtStart) return;
  wbState.gitLoading = false;
  if (!response || !response.ok) {
    const detail = response ? await response.json().catch(() => ({})) : {};
    wbState.gitStatus = {
      repo: false,
      branch: null,
      changes: [],
      truncated: false,
      error: detail.error || '读不到 git 状态。',
    };
    renderChanges();
    return;
  }
  const payload = await response.json().catch(() => ({}));
  wbState.gitStatus = {
    repo: payload.repo === true,
    branch: typeof payload.branch === 'string' ? payload.branch : null,
    changes: Array.isArray(payload.changes) ? payload.changes : [],
    truncated: payload.truncated === true,
    error: typeof payload.error === 'string' ? payload.error : null,
  };
  renderChanges();
}

/** Mark a successful write/edit from the agent's tool trace. */
function noteToolResult(name, summary, ok) {
  if (!ok || (name !== 'write' && name !== 'edit')) return;
  const match = /^(?:创建|写入|修改)\s+(.+?)(?:（|$)/.exec(summary || '');
  const path = match?.[1]?.trim().replace(/^\.\//, '');
  if (!path || path.startsWith('/')) return;
  wbState.sessionChanges.set(path, 'modified');
  updateChangesCount();
  if (wbState.tab === 'changes' && wbState.open) renderChanges();
}

// ------------------------------------------------------------- terminal -----

function renderTerminal() {
  if (!wbTerminal) return;
  if (!wbState.info?.configured) {
    wbTerminal.textContent = '';
    const note = el('div', 'wb-term-empty');
    note.append(el('strong', null, '没有工作区'));
    note.append(el('span', null, '先从右上角选择一个目录，终端才有可以运行的地方。'));
    wbTerminal.append(note);
    paintTerminalChrome();
    return;
  }
  if (!wbState.info.terminal) {
    wbTerminal.textContent = '';
    const note = el('div', 'wb-term-empty');
    note.append(el('strong', null, '终端已关闭'));
    note.append(el('span', null, '在服务端设置 WORKSPACE_TERMINAL=1 后重启，才能从这里运行命令。'));
    wbTerminal.append(note);
    paintTerminalChrome();
    return;
  }
  if (wbTerminal.children.length === 0) {
    const note = el('div', 'wb-term-empty');
    note.append(el('strong', null, '本机命令台'));
    note.append(el('span', null, '每条命令独立运行，cd 不会延续到下一条。输出与退出码会留在这里。'));
    wbTerminal.append(note);
  }
  paintTerminalChrome();
}

function scrollTerminal() {
  if (wbTerminal) wbTerminal.scrollTop = wbTerminal.scrollHeight;
}

function termAppend(output, text, kind = '') {
  if (!text) return;
  // A terminal that shows raw escape sequences is worse than one without
  // colour: the sequences are most of what a colourised command prints.
  const clean = String(text)
    // The control character is what is being stripped, so this regex is the
    // one place `no-control-regex` would be wrong to enforce.
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '');
  if (!clean) return;
  output.append(el('span', kind ? kind : null, clean));
  scrollTerminal();
}

async function runTerminal(command) {
  if (wbState.terminalBusy || !wbState.info?.configured || !wbState.info.terminal) return;
  const value = command.trim();
  if (!value) return;

  wbState.terminalBusy = true;
  paintTerminalChrome();
  const empty = wbTerminal.querySelector('.wb-term-empty');
  if (empty) empty.remove();

  const entry = el('div', 'wb-term-entry');
  const echo = el('div', 'wb-term-cmd');
  echo.append(el('span', 'wb-term-prompt', '$'));
  echo.append(el('span', null, value));
  const output = el('div', 'wb-term-output');
  const meta = el('div', 'wb-term-meta', '运行中…');
  entry.append(echo, output, meta);
  wbTerminal.append(entry);
  scrollTerminal();

  wbState.terminalHistory.push(value);
  if (wbState.terminalHistory.length > 60) wbState.terminalHistory.shift();
  wbState.terminalIndex = wbState.terminalHistory.length;

  const finish = (text, ok) => {
    meta.textContent = text;
    meta.dataset.ok = String(ok);
    wbState.terminalBusy = false;
    paintTerminalChrome();
    scrollTerminal();
    if (wbState.open && wbState.tab === 'changes') void refreshChanges();
    else wbState.gitStatus = null;
  };

  try {
    const response = await fetch('/api/workspace/terminal', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Workspace-UI': '1',
        ...(localToken ? { 'X-Eunoia-Token': localToken } : {}),
      },
      body: JSON.stringify({ command: value }),
    });
    if (!response.ok || !response.body) {
      const detail = await response.json().catch(() => ({}));
      termAppend(output, detail.error || `HTTP ${response.status}`, 'err');
      finish('没能运行', false);
      return;
    }

    let exit = null;
    for await (const event of readFrames(response)) {
      if (event.type === 'terminal_stdout') termAppend(output, event.text);
      else if (event.type === 'terminal_stderr') termAppend(output, event.text, 'err');
      else if (event.type === 'terminal_truncated') termAppend(output, `\n${event.message}`, 'err');
      else if (event.type === 'terminal_error') termAppend(output, event.message, 'err');
      else if (event.type === 'terminal_exit') exit = event;
    }

    if (exit) {
      const duration = typeof exit.durationMs === 'number' ? ` · ${(exit.durationMs / 1000).toFixed(1)}s` : '';
      if (exit.timedOut) finish(`超时，已停止${duration}`, false);
      else if (exit.code === 0) finish(`完成${duration}${exit.truncated ? ' · 输出已截断' : ''}`, true);
      else finish(`退出码 ${exit.code ?? 'signal'}${duration}`, false);
    } else {
      finish('连接中断', false);
    }
  } catch (error) {
    termAppend(output, error instanceof Error ? error.message : String(error), 'err');
    finish('运行失败', false);
  }
}

// --------------------------------------------------------------- picker -----

function renderPicker() {
  if (!wbPickerList) return;
  wbPickerList.textContent = '';
  if (!wbState.pickerPath) {
    wbPickerList.append(wbNote('正在读取…'));
    return;
  }
  if (wbState.pickerEntries.length === 0) {
    wbPickerList.append(wbNote('这个目录下面没有子目录。'));
    return;
  }
  for (const entry of wbState.pickerEntries) {
    const row = el('button', 'wb-dir');
    row.type = 'button';
    row.append(el('span', 'wb-folder'));
    row.append(el('span', 'wb-dir-name', entry.name));
    row.append(el('span', 'wb-change-arrow', '›'));
    row.onclick = () => void loadBrowse(entry.path);
    wbPickerList.append(row);
  }
}

async function loadBrowse(path) {
  const note = $('wb-picker-note');
  if (note) note.textContent = '';
  const choose = $('wb-picker-choose');
  if (choose) choose.disabled = true;
  if (wbPickerList) {
    wbPickerList.textContent = '';
    wbPickerList.append(wbNote('正在读取…'));
  }

  const query = path && path.trim().length > 0 ? `?path=${encodeURIComponent(path.trim())}` : '';
  const response = await fetch(`/api/workspace/browse${query}`).catch(() => null);
  if (choose) choose.disabled = false;
  if (!response || !response.ok) {
    const detail = response ? await response.json().catch(() => ({})) : {};
    if (note) note.textContent = detail.error || '读不到这个目录。';
    if (wbPickerList) {
      wbPickerList.textContent = '';
      wbPickerList.append(wbNote('换一个目录试试。', 'error'));
    }
    return;
  }
  const payload = await response.json().catch(() => ({}));
  wbState.pickerPath = typeof payload.path === 'string' ? payload.path : '';
  wbState.pickerParent = typeof payload.parent === 'string' ? payload.parent : null;
  wbState.pickerRooted = payload.rooted === true;
  wbState.pickerEntries = Array.isArray(payload.entries) ? payload.entries : [];
  const input = $('wb-picker-input');
  if (input) input.value = wbState.pickerPath;
  const up = $('wb-picker-up');
  if (up) up.disabled = !wbState.pickerParent;
  if (note) note.textContent = wbState.pickerRooted ? '只能在配置的浏览范围内选择。' : '';
  renderPicker();
}

function openPicker() {
  if (!wbPicker) return;
  wbPicker.dataset.open = 'true';
  const note = $('wb-picker-note');
  if (note) note.textContent = '';
  const choose = $('wb-picker-choose');
  if (choose) choose.disabled = false;
  const start = wbState.info?.root || wbState.info?.browseStart || '';
  void loadBrowse(start);
  $('wb-picker-input').focus();
}

function closePicker() {
  if (wbPicker) wbPicker.dataset.open = 'false';
}

async function chooseWorkspace(path) {
  if (!path) return;
  const note = $('wb-picker-note');
  const choose = $('wb-picker-choose');
  if (note) note.textContent = '';
  if (choose) choose.disabled = true;
  const response = await fetch('/api/workspace', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Workspace-UI': '1' },
    body: JSON.stringify({ path }),
  }).catch(() => null);
  if (choose) choose.disabled = false;
  if (!response || !response.ok) {
    const detail = response ? await response.json().catch(() => ({})) : {};
    if (note) note.textContent = detail.error || '切换失败，换一个目录试试。';
    return;
  }

  const payload = await response.json().catch(() => ({}));
  wbState.info = {
    configured: payload.configured === true,
    root: typeof payload.root === 'string' ? payload.root : path,
    name: typeof payload.name === 'string' ? payload.name : wbBaseName(path),
    source: payload.source ?? 'selected',
    agentRoot: typeof payload.agentRoot === 'string' ? payload.agentRoot : wbState.info?.agentRoot ?? null,
    terminal: payload.terminal === true,
    git: payload.git === true,
    maxFileBytes: payload.maxFileBytes ?? 0,
    browseStart: typeof payload.browseStart === 'string' ? payload.browseStart : '',
  };
  wbState.levels.clear();
  wbState.expanded.clear();
  wbState.sessionChanges.clear();
  wbState.gitStatus = null;
  wbState.preview = null;
  closePreview();
  closePicker();
  paintWorkbench();
  wbTerminal.textContent = '';
  await loadLevel('.');
  if (wbState.tab === 'changes') await refreshChanges();
  if (wbState.tab === 'terminal') renderTerminal();
}

// --------------------------------------------------------------- wiring -----

$('workspace-toggle').onclick = () => void setWorkbenchOpen(!wbState.open);
$('wb-close').onclick = () => void setWorkbenchOpen(false);
$('wb-root').onclick = () => openPicker();
$('wb-choose').onclick = () => openPicker();
$('wb-refresh').onclick = () => {
  if (!wbState.info?.configured) return;
  wbState.levels.clear();
  wbState.gitStatus = null;
  void loadLevel('.');
  if (wbState.tab === 'changes') void refreshChanges();
};

for (const tab of WB_TABS) {
  $(`wb-tab-${tab}`).onclick = () => setWorkbenchTab(tab);
}

$('wb-up').onclick = () => {
  wbState.expanded.clear();
  renderTree();
  if (wbTree) wbTree.scrollTop = 0;
};

$('wb-preview-back').onclick = () => closePreview();
$('wb-preview-refresh').onclick = () => void loadPreview();

$('wb-term-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = $('wb-term-input');
  const command = input.value;
  input.value = '';
  void runTerminal(command);
});

$('wb-term-input').addEventListener('keydown', (event) => {
  const input = $('wb-term-input');
  if (event.key === 'ArrowUp') {
    event.preventDefault();
    if (wbState.terminalHistory.length === 0) return;
    wbState.terminalIndex = Math.max(0, wbState.terminalIndex - 1);
    input.value = wbState.terminalHistory[wbState.terminalIndex] ?? '';
    return;
  }
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    if (wbState.terminalHistory.length === 0) return;
    wbState.terminalIndex = Math.min(wbState.terminalHistory.length, wbState.terminalIndex + 1);
    input.value = wbState.terminalHistory[wbState.terminalIndex] ?? '';
    return;
  }
  if ((event.metaKey || event.ctrlKey) && (event.key === 'l' || event.key === 'L')) {
    event.preventDefault();
    wbTerminal.textContent = '';
    renderTerminal();
  }
});

$('wb-picker-close').onclick = () => closePicker();
$('wb-picker-cancel').onclick = () => closePicker();
$('wb-picker-up').onclick = () => {
  if (wbState.pickerParent) void loadBrowse(wbState.pickerParent);
};
$('wb-picker-go').onclick = () => {
  const value = $('wb-picker-input').value.trim();
  if (value) void loadBrowse(value);
};
$('wb-picker-input').addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  const value = $('wb-picker-input').value.trim();
  if (value) void loadBrowse(value);
});
$('wb-picker-choose').onclick = () => {
  if (wbState.pickerPath) void chooseWorkspace(wbState.pickerPath);
};

document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.shiftKey && (event.key === 'e' || event.key === 'E')) {
    event.preventDefault();
    void setWorkbenchOpen(!wbState.open);
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (wbPicker?.dataset.open === 'true') {
    closePicker();
    return;
  }
  if (wbPreview?.dataset.open === 'true') {
    closePreview();
    return;
  }
  if (wbState.open) void setWorkbenchOpen(false);
});

/**
 * Bring back the panel and its tab, then read the workspace state.
 *
 * The state request is cheap and happens even when the panel is closed, because
 * the topbar toggle needs to know whether this process has a root at all.
 */
async function restoreWorkbench() {
  const remembered = recallWorkbench();
  wbState.tab = WB_TABS.includes(remembered.tab) ? remembered.tab : 'files';
  paintTabs();
  await loadWorkspaceState();
  wbState.open = remembered.open === true;
  paintWorkbench();
  if (wbState.open) await ensureWorkbench();
}

// --------------------------------------------------------------- events -----

function resize() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
  if (input.value.trim()) composer.classList.add('has-text');
  else composer.classList.remove('has-text');
}

// The theme is written onto <html> by the inline head script before first
// paint; this only has to keep the label and the stored choice in sync.
function currentTheme() {
  return root && root.dataset.theme === 'dark' ? 'dark' : 'light';
}

function paintThemeLabel(theme) {
  const label = $('theme-label');
  if (label) label.textContent = theme === 'dark' ? '浅色模式' : '深色模式';
}

paintThemeLabel(currentTheme());
$('theme-toggle').onclick = () => {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  if (root) root.dataset.theme = next;
  try {
    localStorage.setItem('df_theme', next);
  } catch {
    // The choice still applies for this page view.
  }
  paintThemeLabel(next);
};

// The empty state is a set of openers, not a form. Picking one puts the words
// in the composer so they can be changed before they are sent.
const starters = [
  ['starter-1', '今天有点累，不想说话'],
  ['starter-2', '帮我理一理最近的想法'],
  ['starter-3', '记住：我喜欢下雨天'],
  ['starter-4', '随便聊聊就好'],
];
for (const [id, prompt] of starters) {
  const button = $(id);
  if (!button) continue;
  button.onclick = () => {
    input.value = prompt;
    resize();
    input.focus();
  };
}

const greeting = $('greeting');
if (greeting) {
  const hour = new Date().getHours();
  greeting.textContent =
    hour < 6 ? '还醒着吗？' : hour < 12 ? '早上好。' : hour < 18 ? '下午好。' : '晚上好。';
}

input.addEventListener('input', resize);
input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    $('composer').requestSubmit();
  }
});

$('composer').addEventListener('submit', (event) => {
  event.preventDefault();
  const text = input.value.trim();
  const hasImages = state.mediaDrafts.some((draft) => draft.state === 'ready');
  // A picture with no words is a complete request; the server keeps it that way
  // rather than inventing a prompt for the person.
  if (text.length > 0 || hasImages || state.attachments.length > 0) void send(text);
});

// The same button sends and stops. While a turn is streaming its `type` is
// "button", so this never also submits the composer.
sendButton.addEventListener('click', (event) => {
  if (!state.sending) return;
  event.preventDefault();
  void stopTurn();
});

attachButton.onclick = () => {
  // Before the first reply's `completed` there is no conversation id yet;
  // uploading would create a second thread and attach the file to the wrong one.
  if (state.sending) {
    notice('等这一轮结束再添加文件。');
    return;
  }
  if (typeof attachInput.click === 'function') attachInput.click();
};
attachInput.addEventListener('change', () => {
  // Copy before clearing: `input.value = ''` empties the live FileList, and an
  // empty list would make the upload look like it silently did nothing.
  const files = Array.from(attachInput.files ?? []);
  attachInput.value = '';
  void addFiles(files);
});

if (imagePick) {
  imagePick.onclick = () => {
    if (state.sending) {
      notice('等这一轮结束再添加图片。');
      return;
    }
    if (typeof imageInput?.click === 'function') imageInput.click();
  };
}
if (imageInput) {
  imageInput.addEventListener('change', () => {
    const files = Array.from(imageInput.files ?? []);
    imageInput.value = '';
    if (files.length > 0) void addImageFiles(files);
  });
}

if (modelSelect) {
  modelSelect.addEventListener('change', () => {
    void chooseModel(modelSelect.value);
  });
}

/**
 * Paste and drop feed the same queue as the picker.
 *
 * A text paste is untouched. A file paste is intercepted only when it carries
 * files, because letting the browser insert a binary into a textarea produces a
 * NUL-laden draft that fails much later.
 */
input.addEventListener('paste', (event) => {
  const files = Array.from(event.clipboardData?.files ?? []);
  if (files.length === 0) return;
  event.preventDefault();
  addFilesByKind(files);
});

const composerForm = $('composer');
composerForm.addEventListener('dragover', (event) => {
  event.preventDefault();
  composerForm.classList.add('dragging');
});
composerForm.addEventListener('dragleave', () => {
  composerForm.classList.remove('dragging');
});
composerForm.addEventListener('drop', (event) => {
  event.preventDefault();
  composerForm.classList.remove('dragging');
  const files = Array.from(event.dataTransfer?.files ?? []);
  if (files.length > 0) addFilesByKind(files);
});

// Forget the id as well as clearing the screen: otherwise the next reload
// would pull the old conversation back and the "new" one would have been a view
// change rather than a new conversation.
function startNewConversation() {
  clearConversationView();
}

$('new-conversation').onclick = startNewConversation;
$('new-conversation-top').onclick = startNewConversation;

$('memory-toggle').onclick = () => void openDrawer();
$('memory-toggle-top').onclick = () => void openDrawer();
$('forget-all').onclick = () => void forgetEverything();
// Closing the drawer disarms: an armed button that survives being put away is
// an armed button someone finds later without the context that made it red.
$('drawer-close').onclick = () => {
  $('drawer').dataset.open = 'false';
  disarmForget();
};
$('drawer').addEventListener('click', (event) => {
  if (event.target === $('drawer')) {
    $('drawer').dataset.open = 'false';
    disarmForget();
  }
});

$('history-toggle').onclick = () => {
  if (historyDrawer) historyDrawer.dataset.open = 'true';
  void refreshHistory();
};
$('history-close').onclick = () => {
  if (historyDrawer) historyDrawer.dataset.open = 'false';
};
$('sidebar-scrim').onclick = () => {
  if (historyDrawer) historyDrawer.dataset.open = 'false';
};
$('history-archived').onclick = () => {
  state.showArchived = !state.showArchived;
  $('history-archived').setAttribute('aria-pressed', String(state.showArchived));
  $('history-archived').textContent = state.showArchived ? '隐藏已归档' : '显示已归档';
  void refreshHistory();
};

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  // Escape stops a running turn — but a menu or drawer is the closer thing on
  // screen, so it closes first and the turn is not stopped by surprise.
  if (messageMenu) {
    closeMessageMenu();
    return;
  }
  if (isPermissionMenuOpen()) closePermissionMenu();
  const openPanel = ['drawer', 'history'].find((id) => $(id).dataset.open === 'true');
  if (openPanel) {
    $(openPanel).dataset.open = 'false';
    return;
  }
  if (state.sending) void stopTurn();
});

// The pill opens a menu rather than a modal: choosing a mode is one click and
// the conversation stays visible while the description is read.
const permPill = $('perm-pill');
if (permPill) {
  permPill.onclick = (event) => {
    event.stopPropagation();
    if (isPermissionMenuOpen()) closePermissionMenu();
    else openPermissionMenu();
  };
}
const permMenu = $('perm-menu');
if (permMenu) permMenu.onclick = (event) => event.stopPropagation();
document.addEventListener('click', () => {
  if (isPermissionMenuOpen()) closePermissionMenu();
});
window.addEventListener('resize', () => {
  if (isPermissionMenuOpen()) placePermissionMenu();
});

$('memory-enable').onclick = async () => {
  state.memoryEnabled = !state.memoryEnabled;
  await fetch('/api/preferences', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ 'memory.enabled': state.memoryEnabled }),
  }).catch(() => undefined);
  await refreshMemory();
};

/**
 * The last conversation comes back on reload.
 *
 * This is the whole point of storing the id: a companion you have to re-introduce
 * yourself to every time you open the page is not keeping anything. Failures are
 * silent — the stored id is kept rather than cleared, because a request that
 * failed once says nothing about whether the conversation still exists, and the
 * server treats an id that is not this user's as "start a new one" anyway.
 */
async function restore() {
  const saved = recallConversation();
  if (!saved) return;
  // Adopted before the fetch, not after: if reading the messages fails, the next
  // message still continues that conversation instead of quietly starting a new
  // one and leaving the thread behind.
  state.conversationId = saved;
  await loadConversation(saved);
}

/** The badge describes the preference even before the memory drawer is opened. */
async function refreshMemoryStatus() {
  const response = await fetch('/api/preferences').catch(() => null);
  if (!response || !response.ok) return;
  const payload = await response.json().catch(() => ({}));
  setMemoryStatus(payload.memoryEnabled !== false);
}

/**
 * Read the page in one order rather than three parallel ones.
 *
 * Identity is minted by the first request that has no cookie, so a first-ever
 * visit used to be able to open two of them at once and leave an orphaned user
 * row behind. The transcript is the thing worth waiting for; the list and the
 * badge can follow it.
 */
async function bootstrap() {
  await refreshModelCapabilities().catch(() => undefined);
  await restore().catch(() => undefined);
  await refreshHistory();
  await refreshMemoryStatus();
  await refreshPermissions().catch(() => undefined);
  await restoreWorkbench().catch(() => undefined);
}

resize();
input.focus();
void bootstrap();

// ------------------------------------------------------------ MCP host ----
//
// External services are a separate management surface, not a settings tab buried
// in the memory drawer: adding a server, approving a write and reading a resource
// are all things a person needs to understand while they watch a turn. The
// server owns every rule; this side only draws state it was given.

const mcpPendingBox = $('mcp-pending');
const mcpDrawer = $('mcp-drawer');
const mcpBody = $('mcp-body');

const mcpState = {
  loaded: false,
  loading: false,
  servers: [],
  pending: [],
  bindings: [],
  editing: null,
  error: null,
  importText: '',
  importPreview: null,
  importError: null,
  armedDelete: null,
};
let mcpPollTimer = null;
let questionPollTimer = null;
let pendingQuestions = [];

function mcpHeaders() {
  return permissionHeaders();
}

async function mcpCall(path, options = {}) {
  const method = options.method || 'GET';
  const response = await fetch(path, {
    method,
    ...(options.body !== undefined
      ? { headers: mcpHeaders(), body: JSON.stringify(options.body) }
      : {}),
  }).catch(() => null);
  if (!response) throw new Error('网络错误');
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const details = payload.details ? `（${JSON.stringify(payload.details)}）` : '';
    throw new Error(`${payload.error || `HTTP ${response.status}`}${details}`);
  }
  return payload;
}

async function refreshMcp() {
  mcpState.loading = true;
  mcpState.error = null;
  try {
    const servers = await mcpCall('/api/mcp/servers');
    mcpState.servers = Array.isArray(servers.servers) ? servers.servers : [];
    if (state.conversationId) {
      const [pending, bindings] = await Promise.all([
        mcpCall(`/api/mcp/interactions?conversationId=${state.conversationId}`).catch(() => ({ interactions: [] })),
        mcpCall(`/api/mcp/conversations/${state.conversationId}/servers`).catch(() => ({ serverIds: [] })),
      ]);
      mcpState.pending = pending.interactions || [];
      mcpState.bindings = bindings.serverIds || [];
    } else {
      mcpState.pending = [];
      mcpState.bindings = [];
    }
    mcpState.loaded = true;
  } catch (error) {
    mcpState.error = error instanceof Error ? error.message : String(error);
  } finally {
    mcpState.loading = false;
    renderMcp();
    renderMcpPending();
  }
}

function openMcpDrawer() {
  if (!mcpDrawer) return;
  mcpDrawer.dataset.open = 'true';
  mcpState.editing = null;
  renderMcp();
  void refreshMcp();
}

function closeMcpDrawer() {
  if (mcpDrawer) mcpDrawer.dataset.open = 'false';
  mcpState.editing = null;
}

function mcpButton(label, onClick, extra = '') {
  const button = el('button', extra, label);
  button.type = 'button';
  button.onclick = onClick;
  return button;
}

function classificationLabel(classification) {
  if (classification === 'external_read') return '只读';
  if (classification === 'external_write') return '写入';
  return '未知副作用';
}

function statusLabel(status) {
  const map = {
    disabled: '未启用',
    connecting: '连接中',
    ready: '可用',
    auth_required: '需要登录',
    reconnecting: '重连中',
    failed: '失败',
    closing: '关闭中',
  };
  return map[status?.state] || '未知';
}

function renderMcp() {
  if (!mcpBody) return;
  mcpBody.textContent = '';
  if (!localToken) {
    mcpBody.append(el('p', 'mcp-empty', '这个页面没有控制令牌，不能管理外部服务。请通过本地服务地址打开。'));
    return;
  }
  if (mcpState.error) {
    mcpBody.append(el('div', 'mcp-banner', `加载失败：${mcpState.error}`));
  }
  if (mcpState.editing) {
    mcpBody.append(renderMcpEditor(mcpState.editing));
    return;
  }
  if (mcpState.loading && !mcpState.loaded) {
    mcpBody.append(el('p', 'mcp-empty', '正在读取…'));
    return;
  }

  if (mcpState.pending.length > 0) {
    mcpBody.append(el('div', 'mcp-section-title', '等待你的决定'));
    for (const interaction of mcpState.pending) {
      mcpBody.append(renderInteractionCard(interaction));
    }
  }

  mcpBody.append(el('div', 'mcp-section-title', '已连接的服务'));
  if (mcpState.servers.length === 0) {
    mcpBody.append(
      el(
        'p',
        'mcp-empty',
        '还没有外部服务。添加一个 MCP 服务后，它会以自己的账户和权限范围运行；模型只能看到你启用的工具。',
      ),
    );
  }
  for (const server of mcpState.servers) {
    mcpBody.append(renderServerCard(server));
  }

  mcpBody.append(el('div', 'mcp-section-title', '从 mcpServers 导入'));
  const importBox = el('div', 'mcp-form');
  const textarea = el('textarea');
  textarea.value = mcpState.importText;
  textarea.placeholder =
    '{"mcpServers":{"docs":{"url":"https://example.com/mcp","headers":{"Authorization":"${MCP_DOCS_TOKEN}"}}}}';
  textarea.oninput = () => {
    mcpState.importText = textarea.value;
  };
  importBox.append(textarea);
  const importActions = el('div', 'mcp-actions');
  importActions.append(
    mcpButton('预览', async () => {
      mcpState.importError = null;
      mcpState.importPreview = null;
      try {
        const parsed = JSON.parse(mcpState.importText);
        mcpState.importPreview = await mcpCall('/api/mcp/servers/import/preview', {
          method: 'POST',
          body: parsed,
        });
      } catch (error) {
        mcpState.importError = error instanceof Error ? error.message : String(error);
      }
      renderMcp();
    }),
  );
  importBox.append(importActions);
  if (mcpState.importError) {
    importBox.append(el('div', 'mcp-error', mcpState.importError));
  }
  if (mcpState.importPreview) {
    const preview = mcpState.importPreview;
    const list = el('div', 'mcp-tools');
    for (const entry of preview.servers || []) {
      list.append(
        el(
          'div',
          'mcp-tool',
          `${entry.name} · ${entry.transport}${entry.endpoint ? ` · ${entry.endpoint}` : ''}`,
        ),
      );
      for (const warning of entry.warnings || []) {
        list.append(el('div', 'mcp-error', warning));
      }
    }
    for (const skipped of preview.skipped || []) {
      list.append(el('div', 'mcp-error', `跳过 ${skipped.name}：${skipped.reason}`));
    }
    importBox.append(list);
    if ((preview.servers || []).length > 0) {
      importBox.append(
        mcpButton('全部添加（默认不启用）', async () => {
          try {
            for (const entry of preview.servers) {
              await mcpCall('/api/mcp/servers', { method: 'POST', body: entry.input });
            }
            mcpState.importPreview = null;
            mcpState.importText = '';
            await refreshMcp();
          } catch (error) {
            mcpState.importError = error instanceof Error ? error.message : String(error);
            renderMcp();
          }
        }, 'primary'),
      );
    }
  }
  mcpBody.append(importBox);

  if (state.conversationId) {
    mcpBody.append(el('div', 'mcp-section-title', '这个对话可以使用的服务'));
    const bindingBox = el('div', 'mcp-form');
    if (mcpState.servers.length === 0) {
      bindingBox.append(el('p', 'mcp-empty', '没有可绑定的服务。'));
    } else {
      for (const server of mcpState.servers) {
        const label = el('label', 'mcp-check');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = mcpState.bindings.includes(server.id);
        checkbox.onchange = () => {
          mcpState.bindings = checkbox.checked
            ? [...mcpState.bindings, server.id]
            : mcpState.bindings.filter((id) => id !== server.id);
        };
        label.append(checkbox, el('span', null, server.name));
        bindingBox.append(label);
      }
      bindingBox.append(
        el(
          'p',
          'hint',
          '没有勾选任何服务时，这一轮会使用所有已启用的服务；勾选后只使用勾选的。',
        ),
      );
      bindingBox.append(
        mcpButton('保存绑定', async () => {
          try {
            await mcpCall(`/api/mcp/conversations/${state.conversationId}/servers`, {
              method: 'PUT',
              body: { serverIds: mcpState.bindings },
            });
            await refreshMcp();
          } catch (error) {
            mcpState.error = error instanceof Error ? error.message : String(error);
            renderMcp();
          }
        }, 'primary'),
      );
    }
    mcpBody.append(bindingBox);
  }
  if (mcpState.pending.length === 0) {
    mcpBody.append(
      el('p', 'mcp-empty', '外部工具的写操作与未知副作用总会先询问你；批准只对那一次调用有效。'),
    );
  }
}

function renderServerCard(server) {
  const card = el('div', 'mcp-card');
  const head = el('div', 'mcp-card-head');
  const dot = el('span', 'mcp-dot');
  dot.dataset.state = server.status?.state || 'disabled';
  const title = el('div', 'mcp-card-title');
  title.append(el('strong', null, server.name));
  const place = server.transport === 'http' ? server.endpoint : `${server.endpoint}（${server.runLocation === 'host' ? '宿主进程' : server.runLocation === 'browser' ? '隔离浏览器（会话/成员独立）' : '沙箱'}）`;
  title.append(el('span', null, `${server.transport.toUpperCase()} · ${place || '未配置'}`));
  title.append(
    el(
      'span',
      null,
      `${statusLabel(server.status)} · ${server.toolCount} 个工具${server.required ? ' · 必需' : ''}${server.auth !== 'none' ? ` · ${server.auth}` : ''}`,
    ),
  );
  if (server.status?.lastError) {
    title.append(el('span', 'mcp-error', server.status.lastError.message));
  }
  head.append(dot, title);
  card.append(head);

  const actions = el('div', 'mcp-actions');
  const busy = server.status?.state === 'connecting' || server.status?.state === 'reconnecting';
  actions.append(
    mcpButton(busy ? '连接中…' : '连接', async () => {
      await mcpRun(() => mcpCall(`/api/mcp/servers/${server.id}/connect`, { method: 'POST', body: {} }));
    }, 'primary'),
    mcpButton('断开', async () => {
      await mcpRun(() => mcpCall(`/api/mcp/servers/${server.id}/disconnect`, { method: 'POST', body: {} }));
    }),
    mcpButton('刷新目录', async () => {
      await mcpRun(() => mcpCall(`/api/mcp/servers/${server.id}/refresh`, { method: 'POST', body: {} }));
    }),
    mcpButton('编辑', () => {
      mcpState.editing = server;
      renderMcp();
    }),
  );
  if (server.auth === 'oauth') {
    actions.append(
      mcpButton('登录', async () => {
        try {
          const started = await mcpCall(`/api/mcp/servers/${server.id}/auth/start`, {
            method: 'POST',
            body: {},
          });
          if (started.authorization_url) window.open(started.authorization_url, '_blank', 'noopener');
        } catch (error) {
          mcpState.error = error instanceof Error ? error.message : String(error);
          renderMcp();
        }
      }),
      mcpButton('退出登录', async () => {
        await mcpRun(() => mcpCall(`/api/mcp/servers/${server.id}/auth/logout`, { method: 'POST', body: {} }));
      }),
    );
  }
  const armed = mcpState.armedDelete === server.id;
  actions.append(
    mcpButton(armed ? '确认删除' : '删除', async () => {
      if (!armed) {
        mcpState.armedDelete = server.id;
        renderMcp();
        return;
      }
      mcpState.armedDelete = null;
      await mcpRun(() => mcpCall(`/api/mcp/servers/${server.id}`, { method: 'DELETE' }));
    }, armed ? 'danger' : ''),
  );
  card.append(actions);

  if (server.tools.length > 0) {
    const tools = el('div', 'mcp-tools');
    for (const tool of server.tools.slice(0, 12)) {
      const row = el('div', 'mcp-tool');
      const tag = el('span', 'tag', classificationLabel(tool.classification));
      tag.dataset.kind = tool.classification;
      row.append(tag, el('code', null, tool.originalName));
      tools.append(row);
    }
    if (server.tools.length > 12) {
      tools.append(el('div', 'mcp-tool', `还有 ${server.tools.length - 12} 个…`));
    }
    card.append(tools);
  }
  return card;
}

async function mcpRun(work) {
  mcpState.error = null;
  try {
    await work();
  } catch (error) {
    mcpState.error = error instanceof Error ? error.message : String(error);
  }
  await refreshMcp();
}

function renderMcpEditor(server) {
  const box = el('div', 'mcp-form');
  const isNew = !server.id;
  const editable = server.editable || {};
  const refLines = (record) =>
    Object.entries(record || {})
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
  const draft = {
    name: server.name || '',
    transport: server.transport || 'http',
    url: editable.http?.url || '',
    command: editable.stdio?.command || '',
    args: (editable.stdio?.args || []).join('\n'),
    runLocation: editable.stdio?.runLocation || server.runLocation || 'sandbox',
    auth: editable.http?.auth || server.auth || 'none',
    bearerRef: editable.http?.bearerRef || '',
    headers: refLines(editable.http?.headerRefs),
    env: refLines(editable.stdio?.envRefs),
    required: server.required === true,
    enabled: server.enabled === true,
    allow: (server.policy?.allow || []).join(', '),
    deny: (server.policy?.deny || []).join(', '),
    autoApproveReads: server.policy?.autoApproveReads === true,
    trustReadOnlyHint: server.policy?.trustReadOnlyHint === true,
  };

  const addField = (label, control, hint) => {
    const field = el('div', 'mcp-field');
    const id = `mcp-field-${Math.random().toString(36).slice(2)}`;
    control.id = id;
    const labelNode = document.createElement('label');
    labelNode.htmlFor = id;
    labelNode.textContent = label;
    field.append(labelNode, control);
    if (hint) field.append(el('span', 'hint', hint));
    box.append(field);
  };

  const name = el('input');
  name.value = draft.name;
  name.placeholder = '例如：GitHub';
  name.oninput = () => (draft.name = name.value);
  addField('名称', name);

  const transport = el('select');
  for (const value of ['http', 'stdio']) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value === 'http' ? 'Streamable HTTP' : 'stdio（本地进程）';
    transport.append(option);
  }
  transport.value = draft.transport;
  transport.onchange = () => {
    draft.transport = transport.value;
    renderMcp();
  };
  addField('传输', transport);

  if (draft.transport === 'http') {
    const url = el('input');
    url.value = draft.url;
    url.placeholder = 'https://example.com/mcp';
    url.oninput = () => (draft.url = url.value);
    addField('服务地址', url, 'https 默认；本地/私网地址需要部署显式允许。');

    const auth = el('select');
    for (const value of ['none', 'bearer', 'header', 'oauth']) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = { none: '匿名', bearer: 'Bearer', header: '自定义头', oauth: 'OAuth 登录' }[value];
      auth.append(option);
    }
    auth.value = draft.auth;
    auth.onchange = () => {
      draft.auth = auth.value;
      renderMcp();
    };
    addField('认证', auth);

    if (draft.auth === 'bearer' || draft.auth === 'oauth') {
      const input = el('input');
      input.placeholder = 'env:MCP_TOKEN';
      input.value = draft.bearerRef;
      input.oninput = () => (draft.bearerRef = input.value);
      addField('凭据引用', input, '只写引用；值从部署环境的 MCP_ 变量读取，不会存进数据库。');
    }
    if (draft.auth === 'header') {
      const input = el('textarea');
      input.placeholder = 'X-Api-Key=env:MCP_KEY';
      input.value = draft.headers;
      input.oninput = () => (draft.headers = input.value);
      addField('请求头引用', input, '每行一个 KEY=env:NAME。值不读回。');
    }
  } else {
    const command = el('input');
    command.value = draft.command;
    command.placeholder = 'node';
    command.oninput = () => (draft.command = command.value);
    addField('可执行文件', command, '只写一个可执行文件，不经过 shell。');
    const args = el('textarea');
    args.placeholder = 'server.mjs\n--stdio';
    args.value = draft.args;
    args.oninput = () => (draft.args = args.value);
    addField('参数（每行一个）', args);
    const location = el('select');
    for (const value of ['browser', 'sandbox', 'host']) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value === 'browser' ? '隔离浏览器（按会话和成员分开）' : value === 'sandbox' ? '沙箱容器（默认）' : '宿主进程（需要部署允许）';
      location.append(option);
    }
    location.value = draft.runLocation;
    location.onchange = () => {
      draft.runLocation = location.value;
      const managed = location.value === 'browser';
      if (managed) { draft.command = command.value = 'eunoia-browser'; draft.args = args.value = ''; draft.env = env.value = ''; draft.cwd = ''; draft.image = ''; }
      command.disabled = args.disabled = env.disabled = managed;
    };
    command.disabled = args.disabled = draft.runLocation === 'browser';
    addField('运行位置', location);
    const env = el('textarea');
    env.placeholder = 'TOKEN=env:MCP_TOKEN';
    env.value = draft.env;
    env.disabled = draft.runLocation === 'browser';
    env.oninput = () => (draft.env = env.value);
    addField('环境变量引用', env, '每行一个 KEY=env:NAME；父进程其它变量不会传入。');
  }

  const allow = el('input');
  allow.value = draft.allow;
  allow.placeholder = 'tool_a, tool_b';
  allow.oninput = () => (draft.allow = allow.value);
  addField('允许列表', allow, '留空表示全部；deny 优先。');
  const deny = el('input');
  deny.value = draft.deny;
  deny.placeholder = 'dangerous_tool';
  deny.oninput = () => (draft.deny = deny.value);
  addField('禁止列表', deny);

  const reads = el('label', 'mcp-check');
  const readsBox = document.createElement('input');
  readsBox.type = 'checkbox';
  readsBox.checked = draft.autoApproveReads;
  readsBox.onchange = () => (draft.autoApproveReads = readsBox.checked);
  reads.append(readsBox, el('span', null, '只读调用不询问（写操作仍会询问）'));
  box.append(reads);

  const trust = el('label', 'mcp-check');
  const trustBox = document.createElement('input');
  trustBox.type = 'checkbox';
  trustBox.checked = draft.trustReadOnlyHint;
  trustBox.onchange = () => (draft.trustReadOnlyHint = trustBox.checked);
  trust.append(trustBox, el('span', null, '相信服务的 readOnlyHint（只影响分类，不自动放行）'));
  box.append(trust);

  for (const [key, label] of [['enabled', '启用'], ['required', '必需（连不上就让回合失败）']]) {
    const row = el('label', 'mcp-check');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = draft[key];
    input.onchange = () => (draft[key] = input.checked);
    row.append(input, el('span', null, label));
    box.append(row);
  }

  const actions = el('div', 'mcp-actions');
  actions.append(
    mcpButton('取消', () => {
      mcpState.editing = null;
      renderMcp();
    }),
  );
  actions.append(
    mcpButton(isNew ? '添加' : '保存', async () => {
      const parseRefs = (text, keyName) => {
        const out = {};
        for (const line of text.split('\n')) {
          const trimmed = line.trim();
          if (trimmed.length === 0) continue;
          const index = trimmed.indexOf('=');
          if (index <= 0) throw new Error(`${keyName} 需要 KEY=env:NAME 格式`);
          out[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
        }
        return out;
      };
      try {
        const body = {
          name: draft.name,
          enabled: draft.enabled,
          required: draft.required,
          transport: draft.transport,
          toolPolicy: {
            ...(draft.allow.trim() ? { allow: draft.allow.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
            ...(draft.deny.trim() ? { deny: draft.deny.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
            autoApproveReads: draft.autoApproveReads,
            trustReadOnlyHint: draft.trustReadOnlyHint,
          },
          ...(draft.transport === 'http'
            ? {
                http: {
                  url: draft.url,
                  auth: draft.auth,
                  ...((draft.auth === 'bearer' || draft.auth === 'oauth') && draft.bearerRef
                    ? { bearerRef: draft.bearerRef }
                    : {}),
                  ...(draft.auth === 'header'
                    ? { headerRefs: parseRefs(draft.headers, '请求头') }
                    : {}),
                },
              }
            : {
                stdio: {
                  command: draft.command,
                  args: draft.args.split('\n').map((line) => line.trim()).filter(Boolean),
                  runLocation: draft.runLocation,
                  ...(draft.env.trim() ? { envRefs: parseRefs(draft.env, '环境变量') } : {}),
                },
              }),
        };
        if (isNew) {
          await mcpCall('/api/mcp/servers', { method: 'POST', body });
        } else {
          await mcpCall(`/api/mcp/servers/${server.id}`, {
            method: 'PUT',
            body: { ...body, configRevision: server.configRevision },
          });
        }
        mcpState.editing = null;
        await refreshMcp();
      } catch (error) {
        mcpState.error = error instanceof Error ? error.message : String(error);
        renderMcp();
      }
    }, 'primary'),
  );
  box.append(actions);
  return box;
}

function renderInteractionCard(interaction) {
  const card = el('div', 'mcp-card');
  const payload = interaction.payload || {};
  card.append(el('strong', null, interaction.summary));
  const facts = [];
  if (payload.serverName) facts.push(`服务：${payload.serverName}`);
  if (payload.account) facts.push(`账户：${payload.account}`);
  if (payload.classification) facts.push(`类型：${classificationLabel(payload.classification)}`);
  if (Array.isArray(payload.argumentKeys) && payload.argumentKeys.length > 0) {
    facts.push(`参数：${payload.argumentKeys.join(', ')}`);
  }
  if (facts.length > 0) card.append(el('span', null, facts.join(' · ')));
  card.append(el('span', 'mcp-url', `过期：${new Date(interaction.expiresAt).toLocaleTimeString()}`));

  const form = {};
  if (interaction.kind === 'elicitation') {
    const message = payload.message || '';
    card.append(el('span', null, message));
    if (payload.mode === 'url' && payload.url) {
      let parsed = null;
      try {
        parsed = new URL(payload.url);
      } catch {
        parsed = null;
      }
      if (!parsed || !/^https?:$/.test(parsed.protocol)) {
        card.append(el('div', 'mcp-error', '这个链接不是 http(s) 地址，不能打开。'));
      } else {
        const link = document.createElement('a');
        link.href = parsed.toString();
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.className = 'mcp-url';
        link.textContent = `打开 ${parsed.host}（不会自动跳转）`;
        card.append(link);
      }
    }
    const schema = payload.requestedSchema;
    if (schema && schema.properties) {
      for (const [key, property] of Object.entries(schema.properties)) {
        const field = el('div', 'mcp-field');
        const label = document.createElement('label');
        label.textContent = property.title || key;
        field.append(label);
        let control;
        if (Array.isArray(property.enum)) {
          control = el('select');
          for (const value of property.enum) {
            const option = document.createElement('option');
            option.value = String(value);
            option.textContent = String(value);
            control.append(option);
          }
        } else if (property.type === 'boolean') {
          control = document.createElement('input');
          control.type = 'checkbox';
        } else if (property.type === 'number' || property.type === 'integer') {
          control = el('input');
          control.type = 'number';
        } else {
          control = el('input');
          control.type = 'text';
        }
        control.dataset.mcpField = key;
        field.append(control);
        if ((schema.required || []).includes(key)) {
          field.append(el('span', 'hint', '必填'));
        }
        card.append(field);
      }
    }
  }

  const actions = el('div', 'mcp-actions');
  actions.append(
    mcpButton('批准', async () => {
      try {
        const response =
          interaction.kind === 'elicitation'
            ? { content: collectElicitationValues(card) }
            : { content: {} };
        await mcpCall(`/api/mcp/interactions/${interaction.id}/accept`, {
          method: 'POST',
          body: { response },
        });
        await refreshMcp();
      } catch (error) {
        mcpState.error = error instanceof Error ? error.message : String(error);
        renderMcp();
      }
    }, 'primary'),
    mcpButton('拒绝', async () => {
      await mcpRun(() =>
        mcpCall(`/api/mcp/interactions/${interaction.id}/reject`, { method: 'POST', body: {} }),
      );
    }),
    mcpButton('取消', async () => {
      await mcpRun(() =>
        mcpCall(`/api/mcp/interactions/${interaction.id}/cancel`, { method: 'POST', body: {} }),
      );
    }),
  );
  card.append(actions);
  void form;
  return card;
}

function collectElicitationValues(card) {
  const values = {};
  for (const control of card.querySelectorAll('[data-mcp-field]')) {
    const key = control.dataset.mcpField;
    if (control.type === 'checkbox') values[key] = Boolean(control.checked);
    else if (control.type === 'number') {
      const parsed = Number(control.value);
      values[key] = Number.isFinite(parsed) ? parsed : 0;
    } else values[key] = control.value;
  }
  return values;
}

function renderMcpPending() {
  if (!mcpPendingBox) return;
  mcpPendingBox.textContent = '';
  if (mcpState.pending.length === 0) {
    mcpPendingBox.hidden = true;
    return;
  }
  mcpPendingBox.hidden = false;
  for (const interaction of mcpState.pending) {
    mcpPendingBox.append(renderInteractionCard(interaction));
  }
}

async function pollMcpPending() {
  if (!state.conversationId) return;
  try {
    const pending = await mcpCall(`/api/mcp/interactions?conversationId=${state.conversationId}`);
    mcpState.pending = pending.interactions || [];
  } catch {
    return;
  }
  renderMcpPending();
}

function startMcpPolling() {
  if (mcpPollTimer) return;
  mcpPollTimer = globalThis.setInterval(() => void pollMcpPending(), 2_500);
  questionPollTimer = globalThis.setInterval(() => void pollQuestions(), 2_500);
}
function stopMcpPolling() {
  if (mcpPollTimer) globalThis.clearInterval(mcpPollTimer);
  if (questionPollTimer) globalThis.clearInterval(questionPollTimer);
  mcpPollTimer = null;
  questionPollTimer = null;
  pendingQuestions = [];
  renderQuestions();
}

async function pollQuestions() {
  if (!state.conversationId || !localToken) return;
  try {
    const response = await fetch(
      `/api/questions?conversationId=${state.conversationId}`,
    );
    if (!response.ok) return;
    const payload = await response.json().catch(() => ({}));
    pendingQuestions = Array.isArray(payload.questions) ? payload.questions : [];
    renderQuestions();
  } catch {
    // A poll failure is not a turn failure; the next tick retries.
  }
}

function renderQuestions() {
  const box = $('question-pending');
  if (!box) return;
  box.textContent = '';
  if (pendingQuestions.length === 0) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  for (const question of pendingQuestions) {
    const card = el('div', 'mcp-card question-card');
    card.append(el('strong', null, question.prompt));
    const fields = question.schema?.fields || [];
    if (fields.length === 0) {
      const input = el('input');
      input.type = 'text';
      input.placeholder = '你的回答';
      input.dataset.questionFree = 'true';
      card.append(input);
    }
    for (const field of fields) {
      const wrapper = el('div', 'mcp-field');
      const label = document.createElement('label');
      label.textContent = `${field.label}${field.required ? ' *' : ''}`;
      wrapper.append(label);
      let control;
      if (field.type === 'select' || field.type === 'multi') {
        control = el('select');
        if (field.type === 'multi') control.multiple = true;
        for (const option of field.options || []) {
          const opt = document.createElement('option');
          opt.value = option.value;
          opt.textContent = option.label;
          control.append(opt);
        }
      } else if (field.type === 'boolean') {
        control = document.createElement('input');
        control.type = 'checkbox';
      } else if (field.type === 'number') {
        control = el('input');
        control.type = 'number';
      } else {
        control = el('input');
        control.type = 'text';
        if (field.placeholder) control.placeholder = field.placeholder;
      }
      control.dataset.questionField = field.key;
      control.dataset.questionType = field.type;
      wrapper.append(control);
      card.append(wrapper);
    }
    const actions = el('div', 'mcp-actions');
    const error = el('div', 'mcp-error');
    actions.append(
      mcpButton('回答', async () => {
        const answer = collectQuestionValues(card, fields);
        try {
          const response = await fetch(`/api/questions/${question.id}/answer`, {
            method: 'POST',
            headers: permissionHeaders(),
            body: JSON.stringify({ answer }),
          }).catch(() => null);
          if (!response || !response.ok) {
            const payload = response ? await response.json().catch(() => ({})) : {};
            error.textContent = payload.error || '回答失败';
            return;
          }
          await pollQuestions();
        } catch (failure) {
          error.textContent = failure instanceof Error ? failure.message : String(failure);
        }
      }, 'primary'),
      mcpButton('取消提问', async () => {
        await fetch(`/api/questions/${question.id}/cancel`, {
          method: 'POST',
          headers: permissionHeaders(),
          body: '{}',
        }).catch(() => null);
        await pollQuestions();
      }),
    );
    card.append(actions, error);
    box.append(card);
  }
}

function collectQuestionValues(card, fields) {
  const answer = {};
  if (fields.length === 0) {
    const free = card.querySelector('[data-question-free]');
    answer.text = free ? free.value : '';
    return answer;
  }
  for (const field of fields) {
    const control = card.querySelector(`[data-question-field="${field.key}"]`);
    if (!control) continue;
    if (field.type === 'boolean') {
      answer[field.key] = Boolean(control.checked);
    } else if (field.type === 'multi') {
      answer[field.key] = [...control.selectedOptions].map((option) => option.value);
    } else if (field.type === 'number') {
      const value = Number(control.value);
      if (control.value !== '' && Number.isFinite(value)) answer[field.key] = value;
    } else if (control.value !== '') {
      answer[field.key] = control.value;
    }
  }
  return answer;
}

function addMcpApprovalCard(bubble, event) {
  const card = el('div', 'mcp-card mcp-approval-inline');
  const title = el('strong', null, `需要你批准：${event.originLabel || event.name}`);
  card.append(title, el('span', null, event.summary || '这次外部调用会先暂停，等你决定。'));
  const actions = el('div', 'mcp-actions');
  const status = el('span', null, '');
  const finish = (text) => {
    actions.textContent = '';
    actions.append(status);
    status.textContent = text;
  };
  actions.append(
    mcpButton('批准', async () => {
      try {
        await mcpCall(`/api/mcp/interactions/${event.interactionId}/accept`, {
          method: 'POST',
          body: { response: { content: {} } },
        });
        finish('已批准，继续执行…');
      } catch (error) {
        finish(`失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }, 'primary'),
    mcpButton('拒绝', async () => {
      try {
        await mcpCall(`/api/mcp/interactions/${event.interactionId}/reject`, {
          method: 'POST',
          body: {},
        });
        finish('已拒绝');
      } catch (error) {
        finish(`失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }),
  );
  card.append(actions);
  bubble.append(card);
}

// A test page and an old cached shell may not have these nodes. Binding them
// defensively keeps the rest of the client working instead of failing to load.
const mcpToggleButton = $('mcp-toggle-top');
if (mcpToggleButton) mcpToggleButton.onclick = () => openMcpDrawer();
const mcpCloseButton = $('mcp-close');
if (mcpCloseButton) mcpCloseButton.onclick = () => closeMcpDrawer();
const mcpAddButton = $('mcp-add');
if (mcpAddButton) {
  mcpAddButton.onclick = () => {
    mcpState.editing = { id: null, name: '', transport: 'http', enabled: false };
    renderMcp();
  };
}
if (mcpDrawer) {
  mcpDrawer.addEventListener('click', (event) => {
    if (event.target === mcpDrawer) closeMcpDrawer();
  });
}
