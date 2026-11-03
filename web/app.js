const $ = (id) => document.getElementById(id);
const transcript = $('transcript');
const input = $('input');
const sendButton = $('send');
const composer = $('composer');
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
    const pre = el('pre');
    pre.append(el('code', null, block.code));
    container.append(pre);
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
      row.append(el('span', 'tool-name', event.name), summary, state);
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

async function send(text, options = {}) {
  if (state.sending) return;
  state.sending = true;
  const turn = {
    id: newTurnId(),
    controller: new AbortController(),
    stopping: false,
    watchdog: null,
  };
  state.turn = turn;
  // Deliberately *not* disabled: this button is the stop control now, and a
  // disabled button never receives the click. `type="button"` plus the
  // `state.sending` guard is what prevents a second turn, not `disabled`.
  setSendMode('stop');
  // A continuation is not what the person was typing; keep any draft.
  if (!options.continue) {
    input.value = '';
    resize();
  }

  // The server derives a title from the first message, but the sidebar and the
  // topbar should not sit on "新的对话" while it does. This is the same rule.
  if (!state.conversationId || !conversationTitles.get(state.conversationId)) {
    setThreadTitle(deriveTitle(text));
  }

  addTurn('user', text);
  const { bubble, text: body, note, actions } = addTurn('assistant');
  const waiting = dots();
  body.append(waiting);
  body.dataset.streaming = 'true';

  let thinking = null;
  let trace = null;
  let reply = '';
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
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: text,
        conversationId: state.conversationId,
        turnId: turn.id,
        ...(options.continue ? { continue: true } : {}),
      }),
      signal: turn.controller.signal,
    });

    if (!response.ok || !response.body) {
      const detail = await response.json().catch(() => ({}));
      throw new Error(detail.error || `HTTP ${response.status}`);
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
      } else if (event.type === 'interrupted') {
        terminal = true;
        finishInterrupted(event);
      } else if (event.type === 'error') {
        terminal = true;
        throw new Error(event.message);
      } else if (event.type === 'tool_call') {
        settled();
        trace ??= addToolTrace(bubble);
        trace.call(event);
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

    if (messageId) addFeedback(actions, messageId);
  } catch (error) {
    // A stop also surfaces as an AbortError when the connection had to be cut.
    if (isAbortError(error) && turn.stopping) {
      finishInterrupted(null);
    } else {
      // A half-shown thought with no ending is worse than none; close it.
      thinking?.abort();
      trace?.finish();
      settled();
      body.textContent = '';
      body.append(el('span', null, `出错了：${error.message}`));
      body.style.color = 'var(--danger)';
    }
  } finally {
    // Whether it finished, failed, or was cut off, nothing is arriving now.
    delete body.dataset.streaming;
    if (turn.watchdog) clearTimeout(turn.watchdog);
    state.sending = false;
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
  actions.textContent = '';
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
  const { messages = [] } = await response.json();
  if (messages.length === 0) return false;

  transcript.textContent = '';
  transcript.classList.remove('empty');
  for (const [index, message] of messages.entries()) {
    const { note, actions } = addTurn(message.role, message.content);
    if (message.role === 'assistant') {
      if (message.interrupted) {
        // Only the reply that is still the last thing said can be continued;
        // an older break was already continued by whatever follows it.
        if (index === messages.length - 1) {
          addContinueAction(note, () => void send('继续', { continue: true }));
        } else {
          note.textContent = '已打断';
          note.classList.add('interrupted-note');
        }
      }
      addFeedback(actions, message.id);
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
  if (text.length > 0) void send(text);
});

// The same button sends and stops. While a turn is streaming its `type` is
// "button", so this never also submits the composer.
sendButton.addEventListener('click', (event) => {
  if (!state.sending) return;
  event.preventDefault();
  void stopTurn();
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
  await restore().catch(() => undefined);
  await refreshHistory();
  await refreshMemoryStatus();
  await refreshPermissions().catch(() => undefined);
  await restoreWorkbench().catch(() => undefined);
}

resize();
input.focus();
void bootstrap();
