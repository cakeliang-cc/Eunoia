/**
 * The developer panel: jobs, previews and scoped undo.
 *
 * This is a separate module for the same reason the Team drawer is one: it is a
 * view over APIs the chat already owns, and a failure here must not take the
 * conversation down. Every value it draws comes from a response; when the server
 * has not given a title, a date or a URL, the panel prints that it is unknown
 * rather than filling the gap.
 *
 * The three surfaces answer different questions:
 *
 *   jobs     — what is running, what did it print, how did it end;
 *   previews — is the route live, and which address is safe to open;
 *   changes  — what did a turn change, what conflicts, and what did an undo
 *              actually apply (a scope is never widened silently).
 *
 * Undo is intentionally two-phase. A subset is preflighted, and the panel only
 * sends `paths` it showed the person. The server re-checks the scope, so a stale
 * page cannot turn "undo this file" into "undo the whole turn".
 */

const CONVERSATION_KEY = 'df_conversation';

const JOB_STATUS = {
  starting: '启动中',
  running: '运行中',
  exited: '已退出',
  stopping: '停止中',
  stopped: '已停止',
  unknown: '未知',
};

const PREVIEW_STATUS = {
  starting: '启动中',
  ready: '就绪',
  failed: '失败',
  stopped: '已停止',
  expired: '已过期',
};

const CHANGE_KIND = {
  added: '新增',
  modified: '修改',
  deleted: '删除',
  moved: '移动',
  renamed: '移动',
};

const state = {
  open: false,
  tab: 'jobs',
  conversationId: null,
  jobs: [],
  jobsNote: '',
  logs: new Map(),
  previews: [],
  previewsAvailable: true,
  previewsNote: '',
  previewResult: null,
  previewLogs: new Map(),
  changesets: [],
  changesetsNote: '',
  changeset: null,
  selectedPaths: new Set(),
  plan: null,
  planKey: '',
  undoResult: null,
  applied: new Set(),
  openedFrom: null,
  busy: false,
};

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function token() {
  const meta = document.querySelector('meta[name="eunoia-token"]');
  return meta ? meta.getAttribute('content') : '';
}

function conversationId() {
  try {
    return localStorage.getItem(CONVERSATION_KEY);
  } catch {
    return null;
  }
}

function shortId(value, length = 8) {
  const text = String(value ?? '');
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

function formatBytes(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(iso) {
  if (typeof iso !== 'string' || iso.length === 0) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('zh-CN', { hour12: false });
}

function errorText(error) {
  if (!error) return '请求失败。';
  const code = error.code ? `（${error.code}）` : '';
  return `${error.message || '请求失败。'}${code}`;
}

/** A fetch that keeps the status and body, for routes where 409 is an answer. */
async function request(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.method && options.method !== 'GET') {
    const local = token();
    if (local) headers['x-eunoia-token'] = local;
  }
  const init = { ...options, headers };
  if (options.body !== undefined && typeof options.body !== 'string') {
    init.body = JSON.stringify(options.body);
  }
  let response;
  try {
    response = await fetch(path, init);
  } catch (error) {
    const wrapped = new Error(
      `连不上服务：${error instanceof Error ? error.message : String(error)}`,
    );
    wrapped.status = 0;
    throw wrapped;
  }
  const text = await response.text();
  let body = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { error: text.slice(0, 300) };
    }
  }
  return { ok: response.ok, status: response.status, body };
}

async function api(path, options = {}) {
  const result = await request(path, options);
  if (!result.ok) {
    const error = new Error(result.body?.error || `请求失败（${result.status}）`);
    error.code = result.body?.code || null;
    error.status = result.status;
    throw error;
  }
  return result.body;
}

// ------------------------------------------------------------------- panel ---

function openPanel() {
  if (state.open) return;
  state.open = true;
  state.openedFrom = document.activeElement;
  const drawer = $('dev-drawer');
  const scrim = $('dev-scrim');
  if (drawer) drawer.hidden = false;
  if (scrim) scrim.hidden = false;
  $('dev-open')?.setAttribute('aria-pressed', 'true');
  state.conversationId = conversationId();
  paintTabs();
  void loadActive();
  ($('dev-close') || drawer)?.focus();
}

function closePanel() {
  if (!state.open) return;
  state.open = false;
  const drawer = $('dev-drawer');
  const scrim = $('dev-scrim');
  if (drawer) drawer.hidden = true;
  if (scrim) scrim.hidden = true;
  $('dev-open')?.setAttribute('aria-pressed', 'false');
  const from = state.openedFrom;
  state.openedFrom = null;
  if (from && typeof from.focus === 'function') from.focus();
  else $('dev-open')?.focus();
}

function setTab(tab) {
  state.tab = ['jobs', 'previews', 'changes'].includes(tab) ? tab : 'jobs';
  paintTabs();
  void loadActive();
}

function paintTabs() {
  for (const tab of ['jobs', 'previews', 'changes']) {
    const button = $(`dev-tab-${tab}`);
    if (button) button.setAttribute('aria-selected', String(state.tab === tab));
    const pane = $(`dev-${tab}-pane`);
    if (pane) pane.hidden = state.tab !== tab;
  }
}

async function loadActive() {
  if (!state.open) return;
  state.conversationId = conversationId();
  if (state.tab === 'jobs') await loadJobs();
  else if (state.tab === 'previews') await loadPreviews();
  else await loadChangesets();
}

function requireConversation(noteTarget) {
  if (state.conversationId) return true;
  if (noteTarget) noteTarget.textContent = '先开始一段对话：作业、预览和改动都属于一个会话。';
  return false;
}

// -------------------------------------------------------------------- jobs ---

async function loadJobs() {
  const note = $('dev-jobs-note');
  state.conversationId = conversationId();
  if (!state.conversationId) {
    state.jobs = [];
    state.jobsNote = '先开始一段对话：作业属于一个会话。';
    renderJobs();
    return;
  }
  if (note) note.textContent = '正在读取作业…';
  try {
    const payload = await api(
      `/api/processes?conversationId=${encodeURIComponent(state.conversationId)}`,
    );
    state.jobs = Array.isArray(payload?.jobs) ? payload.jobs : [];
    state.jobsNote =
      payload?.available === false ? payload.reason || '这个部署没有启动作业服务。' : '';
  } catch (error) {
    state.jobs = [];
    state.jobsNote = errorText(error);
  }
  renderJobs();
}

function renderJobs() {
  const list = $('dev-jobs-list');
  const note = $('dev-jobs-note');
  if (!list) return;
  if (note) note.textContent = state.jobsNote;
  list.textContent = '';
  if (state.jobs.length === 0) {
    const empty = el('p', 'dev-empty', '还没有作业。agent 启动的长命令会出现在这里。');
    list.append(empty);
    return;
  }
  for (const job of state.jobs) list.append(jobRow(job));
}

function jobRow(job) {
  const row = el('article', 'dev-job');
  row.dataset.status = String(job.status || 'unknown');
  row.dataset.jobId = String(job.id);

  const head = el('div', 'dev-row-head');
  head.append(el('span', 'dev-badge', JOB_STATUS[job.status] || String(job.status || '未知')));
  head.append(el('code', 'dev-command', job.command || '（没有命令）'));
  row.append(head);

  const meta = el('div', 'dev-meta');
  meta.append(el('span', null, `归属：${job.userId ? shortId(job.userId) : '未知'}`));
  if (job.memberId) meta.append(el('span', null, `成员：${shortId(job.memberId)}`));
  meta.append(
    el('span', null, `退出码：${typeof job.exitCode === 'number' ? job.exitCode : '—'}`),
  );
  const read = state.logs.get(job.id);
  meta.append(el('span', 'dev-cursor', `日志游标：${read ? read.nextCursor : 0}`));
  meta.append(el('span', null, `工作目录：${job.cwd || '—'}`));
  if (job.startedAt) meta.append(el('span', null, `开始：${formatTime(job.startedAt)}`));
  if (job.endedAt) meta.append(el('span', null, `结束：${formatTime(job.endedAt)}`));
  row.append(meta);
  if (job.error) row.append(el('p', 'dev-error', `错误：${job.error}`));

  const actions = el('div', 'dev-actions');
  const readButton = el('button', 'dev-button', '读日志');
  readButton.type = 'button';
  readButton.setAttribute('aria-label', `读取作业 ${job.id} 的日志`);
  readButton.onclick = () => {
    readButton.disabled = true;
    void readJobLogs(job, readButton);
  };
  actions.append(readButton);

  const running = job.status === 'running' || job.status === 'starting';
  const stopButton = el('button', 'dev-button danger', '停止');
  stopButton.type = 'button';
  stopButton.disabled = !running;
  stopButton.setAttribute('aria-label', `停止作业 ${job.id}`);
  stopButton.onclick = () => {
    stopButton.disabled = true;
    void stopJob(job, stopButton);
  };
  actions.append(stopButton);
  row.append(actions);

  if (read) {
    if (read.gap) row.append(el('p', 'dev-warn', '游标超过了日志长度，可能丢失过一段输出。'));
    const pre = el('pre', 'dev-log');
    pre.setAttribute('aria-label', `作业 ${job.id} 的标准输出`);
    pre.textContent = read.text.length > 0 ? read.text : '（还没有标准输出）';
    row.append(pre);
    if (read.stderrText.length > 0) {
      const stderr = el('pre', 'dev-log stderr');
      stderr.setAttribute('aria-label', `作业 ${job.id} 的标准错误`);
      stderr.textContent = read.stderrText;
      row.append(stderr);
    }
    row.append(
      el(
        'p',
        'dev-hint',
        `stdout ${formatBytes(read.stdoutBytes)} · stderr ${formatBytes(read.stderrBytes)} · 下次从这里继续：${read.nextCursor}`,
      ),
    );
  }
  return row;
}

async function readJobLogs(job, button) {
  try {
    const cursor = state.logs.get(job.id)?.nextCursor ?? 0;
    const payload = await api(
      `/api/processes/${encodeURIComponent(job.id)}/logs` +
        `?conversationId=${encodeURIComponent(state.conversationId)}&cursor=${cursor}`,
    );
    const previous = state.logs.get(job.id);
    state.logs.set(job.id, {
      text: `${previous ? previous.text : ''}${payload?.text ?? ''}`,
      stderrText: `${previous ? previous.stderrText : ''}${payload?.stderrText ?? ''}`,
      nextCursor: typeof payload?.nextCursor === 'number' ? payload.nextCursor : cursor,
      stdoutBytes: payload?.stdoutBytes ?? 0,
      stderrBytes: payload?.stderrBytes ?? 0,
      gap: payload?.gap === true || Boolean(previous?.gap),
    });
    renderJobs();
  } catch (error) {
    state.jobsNote = errorText(error);
    renderJobs();
    if (button) button.disabled = false;
  }
}

async function stopJob(job, button) {
  try {
    await api(`/api/processes/${encodeURIComponent(job.id)}/stop`, {
      method: 'POST',
      body: { conversationId: state.conversationId },
    });
    state.jobsNote = `已请求停止 ${shortId(job.id)}。`;
    await loadJobs();
  } catch (error) {
    state.jobsNote = errorText(error);
    renderJobs();
    if (button) button.disabled = false;
  }
}

// ---------------------------------------------------------------- previews ---

async function loadPreviews() {
  const note = $('dev-previews-note');
  state.conversationId = conversationId();
  if (!state.conversationId) {
    state.previews = [];
    state.previewsNote = '';
    renderPreviews();
    noteText('dev-previews-note', '先开始一段对话：预览租约属于一个会话。');
    return;
  }
  if (note && !state.previewsNote) note.textContent = '正在读取预览…';
  try {
    const payload = await api(
      `/api/previews?conversationId=${encodeURIComponent(state.conversationId)}`,
    );
    state.previews = Array.isArray(payload?.previews) ? payload.previews : [];
    state.previewsAvailable = payload?.available !== false;
    // Keep the last explicit message (a start result or a refusal) visible; a
    // concurrent refresh must not erase it. The refresh button clears it.
    noteText(
      'dev-previews-note',
      state.previewsNote ||
        (state.previewsAvailable ? '' : payload?.reason || '这个部署没有启用预览网关。'),
    );
  } catch (error) {
    state.previews = [];
    noteText('dev-previews-note', errorText(error));
  }
  renderPreviews();
}

function noteText(id, text) {
  const node = $(id);
  if (node) node.textContent = text;
}

function renderPreviews() {
  renderPreviewResult();
  const list = $('dev-previews-list');
  if (!list) return;
  list.textContent = '';
  if (state.previews.length === 0) {
    list.append(el('p', 'dev-empty', '还没有预览租约。启动一个开发服务器后会出现在这里。'));
    return;
  }
  for (const lease of state.previews) list.append(previewRow(lease));
}

function previewRow(lease) {
  const row = el('article', 'dev-preview');
  row.dataset.status = String(lease.status || 'unknown');
  row.dataset.previewId = String(lease.id);

  const head = el('div', 'dev-row-head');
  head.append(
    el('span', 'dev-badge', PREVIEW_STATUS[lease.status] || String(lease.status || '未知')),
  );
  head.append(el('span', 'dev-command', `端口 ${lease.containerPort}`));
  row.append(head);

  const meta = el('div', 'dev-meta');
  meta.append(el('span', null, `作业：${shortId(lease.jobId)}`));
  if (lease.memberId) meta.append(el('span', null, `成员：${shortId(lease.memberId)}`));
  meta.append(el('span', null, `到期：${formatTime(lease.expiresAt)}`));
  if (lease.readyAt) meta.append(el('span', null, `就绪：${formatTime(lease.readyAt)}`));
  row.append(meta);

  const url = el('div', 'dev-url');
  // Only a live lease gets a link. A failed or expired lease keeps `userUrl`
  // in the record, and rendering it would hand someone a dead address.
  if (
    lease.status === 'ready' &&
    typeof lease.userUrl === 'string' &&
    /^https?:\/\//i.test(lease.userUrl)
  ) {
    const link = el('a', 'dev-preview-open', lease.userUrl);
    link.href = lease.userUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.setAttribute('aria-label', `打开预览 ${lease.userUrl}`);
    url.append(link);
  } else {
    url.append(
      el(
        'span',
        'dev-muted',
        `地址不可用：${lease.error || PREVIEW_STATUS[lease.status] || '未就绪'}`,
      ),
    );
  }
  row.append(url);

  if (lease.error) row.append(el('p', 'dev-error', `错误：${lease.error}`));

  const actions = el('div', 'dev-actions');
  const logButton = el('button', 'dev-button', '看日志');
  logButton.type = 'button';
  logButton.setAttribute('aria-label', `读取预览 ${lease.id} 的启动日志`);
  logButton.onclick = () => {
    logButton.disabled = true;
    void readPreviewLogs(lease.jobId, logButton);
  };
  actions.append(logButton);

  const stopButton = el('button', 'dev-button danger', '停止');
  stopButton.type = 'button';
  stopButton.disabled = lease.status === 'stopped' || lease.status === 'expired';
  stopButton.setAttribute('aria-label', `停止预览 ${lease.id}`);
  stopButton.onclick = () => {
    stopButton.disabled = true;
    void stopPreview(lease, stopButton);
  };
  actions.append(stopButton);
  row.append(actions);

  const logs = state.previewLogs.get(lease.jobId);
  if (logs) {
    const pre = el('pre', 'dev-log');
    pre.setAttribute('aria-label', `预览作业 ${lease.jobId} 的日志`);
    pre.textContent = logs.text.length > 0 ? logs.text : '（还没有标准输出）';
    row.append(pre);
    if (logs.stderrText.length > 0) {
      const stderr = el('pre', 'dev-log stderr');
      stderr.textContent = logs.stderrText;
      row.append(stderr);
    }
  }
  return row;
}

function renderPreviewResult() {
  const box = $('dev-preview-result');
  if (!box) return;
  box.textContent = '';
  const result = state.previewResult;
  if (!result) return;
  const ready = result.ready === true;
  const panel = el('div', ready ? 'dev-result ok' : 'dev-result error');
  panel.append(
    el(
      'p',
      'dev-result-title',
      ready ? '预览已就绪。' : `预览未就绪：${result.detail || '没有说明原因'}`,
    ),
  );
  if (result.preview?.id) panel.append(el('p', 'dev-hint', `租约：${result.preview.id}`));
  if (result.internalUrl) {
    panel.append(el('p', 'dev-hint', `容器内地址：${result.internalUrl}`));
  }
  if (!ready && result.preview?.error) {
    panel.append(el('p', 'dev-error', `错误：${result.preview.error}`));
  }
  if (!ready && result.job?.id) {
    const logs = el('button', 'dev-button', '读启动日志');
    logs.type = 'button';
    logs.setAttribute('aria-label', `读取未就绪预览 ${result.job.id} 的日志`);
    logs.onclick = () => {
      logs.disabled = true;
      void readPreviewLogs(result.job.id, logs);
    };
    panel.append(logs);
  }
  if (!ready) {
    panel.append(el('p', 'dev-hint', '失败的预览不会显示“打开”链接。'));
  }
  box.append(panel);
}

async function readPreviewLogs(jobId, button) {
  try {
    const cursor = state.previewLogs.get(jobId)?.nextCursor ?? 0;
    const payload = await api(
      `/api/processes/${encodeURIComponent(jobId)}/logs` +
        `?conversationId=${encodeURIComponent(state.conversationId)}&cursor=${cursor}`,
    );
    const previous = state.previewLogs.get(jobId);
    state.previewLogs.set(jobId, {
      text: `${previous ? previous.text : ''}${payload?.text ?? ''}`,
      stderrText: `${previous ? previous.stderrText : ''}${payload?.stderrText ?? ''}`,
      nextCursor: typeof payload?.nextCursor === 'number' ? payload.nextCursor : cursor,
    });
    renderPreviews();
  } catch (error) {
    noteText('dev-previews-note', errorText(error));
    if (button) button.disabled = false;
  }
}

async function stopPreview(lease, button) {
  try {
    await api(`/api/previews/${encodeURIComponent(lease.id)}/stop`, {
      method: 'POST',
      body: { conversationId: state.conversationId },
    });
    state.previewsNote = `已停止预览 ${shortId(lease.id)}。`;
    await loadPreviews();
  } catch (error) {
    noteText('dev-previews-note', errorText(error));
    if (button) button.disabled = false;
  }
}

async function startPreview(event) {
  event.preventDefault();
  const note = $('dev-previews-note');
  const button = $('dev-preview-start');
  const command = String($('dev-preview-command')?.value ?? '').trim();
  const port = Number($('dev-preview-port')?.value);
  const cwd = String($('dev-preview-cwd')?.value ?? '').trim();
  const timeoutRaw = String($('dev-preview-timeout')?.value ?? '').trim();
  if (command.length === 0) {
    noteText('dev-previews-note', '先写要运行的命令。');
    return;
  }
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    noteText('dev-previews-note', '端口必须是 1024–65535 之间的整数。');
    return;
  }
  state.conversationId = conversationId();
  if (!requireConversation(note)) return;
  if (button) button.disabled = true;
  noteText('dev-previews-note', '正在启动并等待预览就绪…');
  const body = {
    conversationId: state.conversationId,
    command,
    port,
    ...(cwd.length > 0 ? { cwd } : {}),
  };
  if (timeoutRaw.length > 0 && Number.isFinite(Number(timeoutRaw))) {
    body.ready_timeout_ms = Number(timeoutRaw);
  }
  try {
    const result = await request('/api/previews', { method: 'POST', body });
    if (result.status !== 201 && result.status !== 409) {
      throw new Error(result.body?.error || `请求失败（${result.status}）`);
    }
    state.previewResult = {
      ready: result.body?.ready === true && result.status === 201,
      detail: result.body?.detail ?? '',
      preview: result.body?.preview ?? null,
      job: result.body?.job ?? null,
      internalUrl: result.body?.internalUrl ?? null,
    };
    state.previewsNote = state.previewResult.ready
      ? '预览已就绪，可以用新标签页打开。'
      : `预览未就绪：${state.previewResult.detail || '服务没有说明原因'}`;
    await loadPreviews();
  } catch (error) {
    state.previewsNote = errorText(error);
    noteText('dev-previews-note', state.previewsNote);
  } finally {
    if (button) button.disabled = false;
  }
}

// ----------------------------------------------------------------- changes ---

async function loadChangesets() {
  const note = $('dev-changes-note');
  state.conversationId = conversationId();
  if (!state.conversationId) {
    state.changesets = [];
    state.changesetsNote = '';
    renderChangesets();
    noteText('dev-changes-note', '先开始一段对话：修改集属于一个会话。');
    return;
  }
  if (note) note.textContent = '正在读取修改集…';
  try {
    const payload = await api(
      `/api/conversations/${encodeURIComponent(state.conversationId)}/changes`,
    );
    state.changesets = Array.isArray(payload?.changesets) ? payload.changesets : [];
    state.changesetsNote =
      state.changesets.length === 0 ? '这个会话还没有可撤销的修改集。' : '';
  } catch (error) {
    state.changesets = [];
    state.changesetsNote = errorText(error);
  }
  if (state.changeset && !state.changesets.some((entry) => entry.id === state.changeset.id)) {
    state.changeset = null;
    state.selectedPaths.clear();
    state.plan = null;
  }
  renderChangesets();
  renderChangeset();
}

function renderChangesets() {
  const list = $('dev-changesets');
  const note = $('dev-changes-note');
  if (note) note.textContent = state.changesetsNote;
  if (!list) return;
  list.textContent = '';
  for (const summary of state.changesets) {
    const row = el('button', 'dev-changeset');
    row.type = 'button';
    row.dataset.changesetId = String(summary.id);
    row.setAttribute('aria-pressed', String(state.changeset?.id === summary.id));
    row.setAttribute('aria-label', `查看修改集 ${summary.id}`);
    row.append(el('span', 'dev-badge', summary.status === 'undone' ? '已撤销' : '可撤销'));
    row.append(
      el(
        'span',
        'dev-changeset-title',
        `${formatTime(summary.createdAt)} · ${summary.fileCount} 个文件`,
      ),
    );
    row.append(
      el(
        'span',
        'dev-hint',
        `+${summary.added} ~${summary.modified} -${summary.deleted} · 第 ${shortId(summary.turnId)} 轮`,
      ),
    );
    row.onclick = () => void selectChangeset(summary.id);
    list.append(row);
  }
  if (state.changesets.length === 0) {
    list.append(el('p', 'dev-empty', '没有修改集。'));
  }
}

async function selectChangeset(id) {
  state.changeset = null;
  state.plan = null;
  state.planKey = '';
  state.undoResult = null;
  state.applied.clear();
  try {
    const payload = await api(
      `/api/conversations/${encodeURIComponent(state.conversationId)}/changes/${encodeURIComponent(id)}`,
    );
    const changeset = payload?.changeset ?? null;
    state.changeset = changeset;
    state.selectedPaths = new Set(
      Array.isArray(changeset?.files) ? changeset.files.map((file) => file.path) : [],
    );
  } catch (error) {
    state.changesetsNote = errorText(error);
  }
  renderChangesets();
  renderChangeset();
}

function selectionKey() {
  return [...state.selectedPaths].sort().join('\u0000');
}

function renderChangeset() {
  const box = $('dev-changeset-detail');
  if (!box) return;
  box.textContent = '';
  const changeset = state.changeset;
  if (!changeset) {
    box.append(el('p', 'dev-empty', '选择一个修改集，查看它改了哪些文件。'));
    return;
  }

  const head = el('div', 'dev-changeset-head');
  head.append(el('h3', null, `第 ${shortId(changeset.turnId)} 轮 · ${changeset.fileCount} 个文件`));
  head.append(
    el(
      'p',
      'dev-hint',
      `状态：${changeset.status === 'undone' ? '已撤销' : changeset.status === 'partial' ? '部分撤销' : '可撤销'} · 创建：${formatTime(changeset.createdAt)}`,
    ),
  );
  head.append(
    el(
      'p',
      'dev-hint',
      `新增 ${changeset.added} · 修改 ${changeset.modified} · 删除 ${changeset.deleted} · 移动只在 git 改动视图里表示`,
    ),
  );
  box.append(head);

  for (const file of changeset.files) box.append(changeFileRow(file));

  const actions = el('div', 'dev-actions');
  const all = el('button', 'dev-button', '全选');
  all.type = 'button';
  all.setAttribute('aria-label', '全选所有文件');
  all.onclick = () => {
    state.selectedPaths = new Set(changeset.files.map((file) => file.path));
    invalidatePlan();
    renderChangeset();
  };
  actions.append(all);
  const none = el('button', 'dev-button', '全不选');
  none.type = 'button';
  none.setAttribute('aria-label', '取消选择所有文件');
  none.onclick = () => {
    state.selectedPaths.clear();
    invalidatePlan();
    renderChangeset();
  };
  actions.append(none);

  const preflight = el('button', 'dev-button', '预检范围');
  preflight.type = 'button';
  preflight.setAttribute('aria-label', '预检选中文件的撤销范围');
  preflight.disabled = state.selectedPaths.size === 0;
  preflight.onclick = () => {
    preflight.disabled = true;
    void refreshPlan();
  };
  actions.append(preflight);

  const undo = el('button', 'dev-button danger', '撤销选中');
  undo.type = 'button';
  undo.id = 'dev-undo-apply';
  undo.setAttribute('aria-label', '撤销选中的文件');
  undo.disabled = state.selectedPaths.size === 0 || state.busy;
  undo.onclick = () => {
    undo.disabled = true;
    void applyUndo(false);
  };
  actions.append(undo);
  box.append(actions);

  if (state.plan || state.undoResult) box.append(planReport());
}

function changeFileRow(file) {
  const row = el('div', 'dev-change-file');
  row.dataset.path = String(file.path);
  const selected = state.selectedPaths.has(file.path);
  if (state.applied.has(file.path)) row.dataset.applied = 'true';

  const label = el('label', 'dev-check');
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = selected;
  checkbox.setAttribute('aria-label', `选择文件 ${file.path}`);
  checkbox.onchange = () => {
    if (checkbox.checked) state.selectedPaths.add(file.path);
    else state.selectedPaths.delete(file.path);
    invalidatePlan();
    renderChangeset();
  };
  label.append(checkbox);
  label.append(el('span', null, '选择'));
  row.append(label);

  row.append(
    el('span', `wb-change-badge ${file.kind}`, changeLetter(file.kind)),
  );
  const body = el('div', 'dev-change-body');
  body.append(el('code', 'dev-change-path', file.path));
  body.append(
    el(
      'p',
      'dev-hint',
      `${CHANGE_KIND[file.kind] || file.kind} · before ${formatBytes(file.beforeBytes)} ` +
        `${file.beforeSha ? `(${shortId(file.beforeSha, 10)})` : ''} → after ${formatBytes(file.afterBytes)} ` +
        `${file.afterSha ? `(${shortId(file.afterSha, 10)})` : ''}`,
    ),
  );
  if (file.restored) body.append(el('p', 'dev-hint', '这一项已经撤销过。'));
  if (state.applied.has(file.path)) body.append(el('p', 'dev-applied', '实际已应用撤销。'));
  if (typeof file.beforeContent === 'string') {
    const toggle = el('button', 'dev-link', '查看 before 内容');
    toggle.type = 'button';
    toggle.setAttribute('aria-label', `查看 ${file.path} 的 before 内容`);
    toggle.onclick = () => {
      const pre = el('pre', 'dev-log');
      pre.textContent = file.beforeContent;
      body.append(pre);
      toggle.remove();
    };
    body.append(toggle);
  }
  row.append(body);
  return row;
}

function changeLetter(kind) {
  if (kind === 'added') return 'A';
  if (kind === 'modified') return 'M';
  if (kind === 'deleted') return 'D';
  if (kind === 'moved' || kind === 'renamed') return 'R';
  return '·';
}

function invalidatePlan() {
  state.plan = null;
  state.planKey = '';
  state.undoResult = null;
  state.applied.clear();
}

function planReport() {
  const box = el('div', 'dev-plan');
  const plan = state.plan;
  const result = state.undoResult;
  if (result) {
    box.append(el('h4', null, '实际已应用'));
    const applied = [
      ...(Array.isArray(result.restored) ? result.restored : []),
      ...(Array.isArray(result.deleted) ? result.deleted : []),
    ];
    box.append(
      el(
        'p',
        'dev-result ok',
        applied.length > 0 ? `已应用：${applied.join('、')}` : '这次没有文件被写入。',
      ),
    );
    if (Array.isArray(result.conflicts) && result.conflicts.length > 0) {
      box.append(el('h4', null, '冲突（没有覆盖）'));
      for (const conflict of result.conflicts) {
        box.append(el('p', 'dev-error', `${conflict.path}：${conflict.reason}`));
      }
      const force = el('button', 'dev-button danger', '强制撤销冲突文件');
      force.type = 'button';
      force.setAttribute('aria-label', '再点一次确认强制撤销冲突文件');
      force.onclick = () => {
        if (force.dataset.armed !== 'true') {
          force.dataset.armed = 'true';
          force.textContent = '再点一次，覆盖冲突';
          return;
        }
        force.disabled = true;
        void applyUndo(true);
      };
      box.append(force);
    }
    if (Array.isArray(result.skipped) && result.skipped.length > 0) {
      box.append(el('h4', null, '无法恢复'));
      for (const skip of result.skipped) {
        box.append(el('p', 'dev-warn', `${skip.path}：${skip.reason}`));
      }
    }
    if (result.status) {
      box.append(
        el(
          'p',
          'dev-hint',
          result.status === 'undone' ? '整个修改集已经撤销。' : '只撤销了选中的文件，其余保持原样。',
        ),
      );
    }
  }

  if (!plan) return box;
  box.append(el('h4', null, '预检范围'));
  box.append(
    el(
      'p',
      'dev-hint',
      `选中 ${state.selectedPaths.size} / ${state.changeset?.files.length ?? 0} 个文件；` +
        '撤销只作用于选中的路径。',
    ),
  );
  const conflicts = plan.files.filter((file) => file.matches === false);
  if (conflicts.length > 0) {
    box.append(el('h4', null, '冲突清单'));
    for (const file of conflicts) {
      box.append(el('p', 'dev-warn', `${file.path}：${file.reason || '内容已经变化'}`));
    }
  }
  if (Array.isArray(plan.blocked) && plan.blocked.length > 0) {
    const allSelected = state.selectedPaths.size === (state.changeset?.files.length ?? 0);
    box.append(el('h4', null, allSelected ? '整轮撤销提示' : '被拒绝的部分撤销'));
    for (const blocked of plan.blocked) {
      box.append(el('p', 'dev-error', `${blocked.path}：${blocked.reason}`));
    }
    box.append(
      el(
        'p',
        'dev-hint',
        allSelected
          ? '整轮撤销不会覆盖这些文件；它们会出现在冲突清单里，由你决定是否强制。'
          : '可行范围：选择完整修改集，或先处理后续仍引用这些文件的修改。',
      ),
    );
  }
  return box;
}

async function refreshPlan() {
  if (state.selectedPaths.size === 0) {
    state.changesetsNote = '至少选择一个文件。';
    renderChangesets();
    return false;
  }
  const paths = [...state.selectedPaths];
  try {
    const plan = await api(
      `/api/conversations/${encodeURIComponent(state.conversationId)}/changes/${encodeURIComponent(state.changeset.id)}/undo/preflight`,
      { method: 'POST', body: { paths } },
    );
    state.plan = plan ?? null;
    state.planKey = selectionKey();
    state.undoResult = null;
    renderChangeset();
    return !(Array.isArray(plan?.blocked) && plan.blocked.length > 0);
  } catch (error) {
    state.changesetsNote = errorText(error);
    renderChangesets();
    return false;
  }
}

async function applyUndo(force) {
  if (!state.changeset || state.selectedPaths.size === 0) return;
  const paths = [...state.selectedPaths];
  const allSelected = state.selectedPaths.size === state.changeset.files.length;
  state.busy = true;
  try {
    // A preflight that is missing or describes a different selection is refreshed
    // first: undo must never run on a scope the person has not seen.
    if (!state.plan || state.planKey !== selectionKey()) {
      const allowed = await refreshPlan();
      if (!allowed && !allSelected) {
        state.changesetsNote = '预检拒绝了这次部分撤销；没有写入任何文件。';
        renderChangesets();
        return;
      }
    }
    if (
      !allSelected &&
      Array.isArray(state.plan?.blocked) &&
      state.plan.blocked.length > 0
    ) {
      state.changesetsNote = '预检拒绝了这次部分撤销；没有写入任何文件。';
      renderChangesets();
      return;
    }
    // A strict subset names every path it may touch. A full round is the legacy
    // whole-changeset undo, where a later edit becomes a conflict instead of a
    // blocked scope; the person selected all of it explicitly.
    const body = allSelected ? { force } : { paths, force };
    const result = await request(
      `/api/conversations/${encodeURIComponent(state.conversationId)}/changes/${encodeURIComponent(state.changeset.id)}/undo`,
      { method: 'POST', body },
    );
    if (!result.ok) {
      const message = result.body?.error || `撤销失败（${result.status}）`;
      state.changesetsNote = `${message}${result.body?.code ? `（${result.body.code}）` : ''}`;
      renderChangesets();
      return;
    }
    state.undoResult = result.body ?? null;
    state.applied = new Set([
      ...(Array.isArray(result.body?.restored) ? result.body.restored : []),
      ...(Array.isArray(result.body?.deleted) ? result.body.deleted : []),
    ]);
    state.changesetsNote = '撤销结果已写回；这是新的记录，原来的执行历史没有改写。';
    await refreshChangesetAfterUndo();
  } catch (error) {
    state.changesetsNote = errorText(error);
    renderChangesets();
  } finally {
    state.busy = false;
    renderChangeset();
  }
}

async function refreshChangesetAfterUndo() {
  const id = state.changeset?.id;
  if (!id) return;
  try {
    const payload = await api(
      `/api/conversations/${encodeURIComponent(state.conversationId)}/changes/${encodeURIComponent(id)}`,
    );
    if (payload?.changeset) state.changeset = payload.changeset;
  } catch {
    // The report above already says what was applied; a failed reread must not
    // erase it.
  }
  try {
    const list = await api(
      `/api/conversations/${encodeURIComponent(state.conversationId)}/changes`,
    );
    if (Array.isArray(list?.changesets)) state.changesets = list.changesets;
  } catch {
    // Same: keep the detail already shown.
  }
  renderChangesets();
}

// ------------------------------------------------------------------- wires ---

const openButton = $('dev-open');
if (openButton) openButton.addEventListener('click', () => (state.open ? closePanel() : openPanel()));
$('dev-close')?.addEventListener('click', closePanel);
$('dev-scrim')?.addEventListener('click', closePanel);

for (const tab of ['jobs', 'previews', 'changes']) {
  $(`dev-tab-${tab}`)?.addEventListener('click', () => setTab(tab));
}
$('dev-jobs-refresh')?.addEventListener('click', () => void loadJobs());
$('dev-previews-refresh')?.addEventListener('click', () => {
  state.previewsNote = '';
  void loadPreviews();
});
$('dev-changes-refresh')?.addEventListener('click', () => void loadChangesets());
$('dev-preview-form')?.addEventListener('submit', startPreview);

const drawer = $('dev-drawer');
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state.open) {
    event.preventDefault();
    closePanel();
  }
});

drawer?.addEventListener('keydown', (event) => {
  if (event.key !== 'Tab' || !state.open) return;
  const focusable = drawer.querySelectorAll(
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  );
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});

paintTabs();
