/**
 * The Agent Team drawer.
 *
 * Plain DOM, no framework: the panel is a view over the Team API, and every
 * action is one `fetch`. It is deliberately independent of app.js so the chat
 * client keeps its existing behaviour and a failure in this panel cannot take
 * the conversation down.
 *
 * What it guarantees:
 *
 *   - the page never rebuilds a run; reconnecting replays events from the cursor
 *     (`/events/stream?after=`) and never creates a second run;
 *   - all model-authored text is inserted with `textContent`, never HTML;
 *   - a rejected action shows the server's structured code, not a generic
 *     "出错了", because CAS and budget conflicts are recoverable states.
 *
 * The conversation id is the same key app.js stores. The panel never invents a
 * conversation: Team runs belong to a real chat.
 */

const CONVERSATION_KEY = 'df_conversation';
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

const state = {
  open: false,
  conversationId: null,
  team: null,
  run: null,
  snapshot: null,
  tab: 'members',
  cursor: 0,
  source: null,
  busy: false,
  error: null,
  note: null,
  integrations: null,
};

const $ = (id) => document.getElementById(id);
const drawer = $('team-drawer');
const scrim = $('team-scrim');
const view = $('team-view');
const openButton = $('team-open');

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

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.method && options.method !== 'GET') headers['x-eunoia-token'] = token();
  const response = await fetch(path, { ...options, headers });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const error = new Error(payload?.error || `请求失败（${response.status}）`);
    error.code = payload?.code || null;
    error.detail = payload?.detail || null;
    error.status = response.status;
    throw error;
  }
  return payload;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function badge(status) {
  const node = el('span', 'team-badge', status || 'unknown');
  node.dataset.status = status || 'unknown';
  return node;
}

function memberName(id) {
  const member = state.snapshot?.members?.find((entry) => entry.id === id);
  return member ? `${member.name}（${id.slice(0, 12)}…）` : id;
}

function shortId(id) {
  return id && id.length > 18 ? `${id.slice(0, 14)}…` : id;
}

function setNote(text, isError = false) {
  state.error = isError ? text : null;
  state.note = isError ? null : text;
  render();
}

function clearNote() {
  state.error = null;
  state.note = null;
}

// ------------------------------------------------------------------ panel ---

function openPanel() {
  state.open = true;
  state.conversationId = conversationId();
  drawer.hidden = false;
  scrim.hidden = false;
  openButton?.setAttribute('aria-pressed', 'true');
  $('team-close')?.focus();
  void load();
}

function closePanel() {
  state.open = false;
  drawer.hidden = true;
  scrim.hidden = true;
  openButton?.setAttribute('aria-pressed', 'false');
  state.source?.close();
  state.source = null;
  openButton?.focus();
}

function togglePanel() {
  if (state.open) closePanel();
  else openPanel();
}

// ------------------------------------------------------------------- load ---

async function load() {
  state.conversationId = conversationId();
  if (!state.conversationId) {
    state.team = null;
    state.run = null;
    state.snapshot = null;
    render();
    return;
  }
  try {
    const team = await api(`/api/teams?conversationId=${encodeURIComponent(state.conversationId)}`);
    state.team = team.team;
    if (team.activeRunId) {
      const snapshot = await api(`/api/teams/runs/${team.activeRunId}`);
      state.snapshot = snapshot;
      state.run = snapshot.run;
      state.cursor = snapshot.eventCursor || 0;
      subscribe();
    } else if (team.runs?.length) {
      const snapshot = await api(`/api/teams/runs/${team.runs[0].id}`);
      state.snapshot = snapshot;
      state.run = snapshot.run;
      state.cursor = snapshot.eventCursor || 0;
    } else {
      state.snapshot = null;
      state.run = null;
    }
    clearNote();
  } catch (error) {
    setNote(error.message, true);
  }
  render();
}

async function refresh() {
  if (!state.run) return;
  try {
    const snapshot = await api(`/api/teams/runs/${state.run.id}`);
    state.snapshot = snapshot;
    state.run = snapshot.run;
    state.team = snapshot.team;
    state.cursor = Math.max(state.cursor, snapshot.eventCursor || 0);
    render();
  } catch (error) {
    setNote(`${error.code ? `${error.code}: ` : ''}${error.message}`, true);
  }
}

function subscribe() {
  if (!state.run || TERMINAL.has(state.run.status)) return;
  state.source?.close();
  const source = new EventSource(
    `/api/teams/runs/${state.run.id}/events/stream?after=${state.cursor}`,
  );
  state.source = source;
  let timer = null;
  const schedule = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      void refresh();
    }, 180);
  };
  const consume = (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (payload && typeof payload.sequence === 'number') {
        state.cursor = Math.max(state.cursor, payload.sequence);
      }
    } catch {
      // A frame that is not JSON is a heartbeat comment; ignore.
    }
    schedule();
  };
  source.addEventListener('team', consume);
  source.addEventListener('team_snapshot', consume);
  source.onmessage = consume;
  source.onerror = () => {
    source.close();
    if (state.open && !TERMINAL.has(state.run?.status || '')) {
      setTimeout(() => subscribe(), 1000);
    }
  };
}

// ----------------------------------------------------------------- action ---

async function act(path, options, note) {
  state.busy = true;
  render();
  try {
    const result = await api(path, options);
    state.note = note || null;
    state.error = null;
    await refresh();
    return result;
  } catch (error) {
    state.error = `${error.code ? `${error.code}: ` : ''}${error.message}`;
    render();
    return null;
  } finally {
    state.busy = false;
    render();
  }
}

function post(path, body) {
  // The write guard requires a JSON content type; a control action with no
  // arguments still sends `{}` so it is not rejected as a form post.
  return act(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
}

// ----------------------------------------------------------------- render ---

function render() {
  if (!state.open) return;
  const modeButton = $('team-mode');
  const mode = state.team?.config?.mode || 'team';
  modeButton.setAttribute('aria-pressed', mode === 'team' ? 'true' : 'false');
  modeButton.textContent = mode === 'team' ? '开启' : '关闭';
  modeButton.disabled = state.busy || !state.team;
  $('team-mode-hint').textContent =
    mode === 'team'
      ? '任务板、依赖与验收可用；关闭只影响后续调度，记录保留。'
      : '只做成员委派，不启用共享任务板；历史任务与运行记录仍然保留。';

  const meta = $('team-meta');
  meta.replaceChildren();
  if (state.team) {
    meta.append(
      metaRow('模式', state.team.config.mode === 'team' ? 'Team' : '仅委派'),
      metaRow('成员上限', String(state.team.config.limits.maxMembers)),
      metaRow('模型', state.team.config.defaultModelId),
      metaRow('请求上限', String(state.team.config.budget.maxRequests)),
      metaRow('输入预算', state.team.config.budget.maxInputTokens.toLocaleString()),
      metaRow('输出预算', state.team.config.budget.maxOutputTokens.toLocaleString()),
    );
  }

  const status = state.run?.status || 'idle';
  $('team-pause').hidden = !state.run || !['running', 'waiting_user'].includes(status);
  $('team-resume').hidden = !state.run || !['paused', 'waiting_user', 'pausing'].includes(status);
  $('team-stop').hidden = !state.run || TERMINAL.has(status);
  $('team-steer').hidden = !state.run || TERMINAL.has(status);

  const startButton = $('team-start').querySelector('button[type="submit"]');
  startButton.disabled = state.busy || !state.conversationId;
  $('team-start-note').textContent = state.conversationId
    ? state.run
      ? `当前运行：${state.run.id.slice(0, 18)}…（${status}）`
      : '一次运行对应一条根会话消息；重复提交同一消息不会创建第二个运行。'
    : '先在对话里发一条消息，再开始协作。';

  for (const tab of drawer.querySelectorAll('[data-team-tab]')) {
    tab.setAttribute('aria-selected', tab.dataset.teamTab === state.tab ? 'true' : 'false');
  }

  view.replaceChildren();
  if (state.error) view.append(el('div', 'team-error', state.error));
  else if (state.note) view.append(el('div', 'team-success', state.note));

  if (!state.conversationId) {
    view.append(el('p', 'team-empty', '先在主对话里发一条消息；协作运行需要一个真实会话。'));
    return;
  }
  if (!state.snapshot) {
    view.append(el('p', 'team-empty', '还没有运行。写一句要协作完成的事，然后点「开始协作」。'));
    return;
  }

  if (state.tab === 'members') renderMembers();
  else if (state.tab === 'tasks') renderTasks();
  else if (state.tab === 'messages') renderMessages();
  else if (state.tab === 'events') renderEvents();
  else renderArtifacts();
}

function metaRow(label, value) {
  const wrap = el('div');
  wrap.append(el('dt', null, label), el('dd', null, value));
  return wrap;
}

function renderMembers() {
  const snapshot = state.snapshot;
  const members = snapshot.members || [];
  const root = members.find((member) => member.role === 'root');
  for (const member of members) {
    const card = el('div', 'team-card');
    const head = el('div', 'team-card-head');
    head.append(
      el('span', 'team-card-title', member.name),
      badge(member.status),
    );
    card.append(head);
    card.append(el('div', 'team-card-id', member.id));
    const body = el('div', 'team-card-body');
    body.append(
      el('p', null, `${member.role} · 深度 ${member.depth} · ${member.profile.modelId} · ${member.contextMode}`),
      el('p', null, `工作区：${member.workspaceMode}${member.currentActivationId ? ` · 正在执行 ${shortId(member.currentActivationId)}` : ''}`),
    );
    if (member.error) body.append(el('pre', null, member.error));
    card.append(body);

    if (!['closed', 'failed'].includes(member.status)) {
      const follow = el('form', 'team-form');
      const label = el('label', 'field-label', '跟进这条成员（同一上下文）');
      const input = document.createElement('input');
      input.placeholder = '例如：先看第 2 个验收条件，再报告证据';
      input.setAttribute('aria-label', `给 ${member.name} 的跟进内容`);
      input.required = true;
      const send = el('button', null, '发送跟进');
      send.type = 'submit';
      follow.append(label, input, send);
      follow.addEventListener('submit', (event) => {
        event.preventDefault();
        void post(`/api/teams/members/${member.id}/followup`, {
          runId: snapshot.run.id,
          message: input.value,
        });
      });
      card.append(follow);

      const actions = el('div', 'team-actions');
      const interrupt = el('button', null, '停止本轮');
      interrupt.type = 'button';
      interrupt.addEventListener('click', () =>
        void post(`/api/teams/members/${member.id}/interrupt`),
      );
      const close = el('button', 'danger', '关闭成员');
      close.type = 'button';
      close.addEventListener('click', () => {
        if (confirm(`关闭 ${member.name}？会停止当前执行；历史与产物保留。`)) {
          void post(`/api/teams/members/${member.id}/close`);
        }
      });
      actions.append(interrupt, close);
      card.append(actions);
    }
    view.append(card);
  }

  const mcpInteractions = snapshot.mcpInteractions || [];
  for (const interaction of mcpInteractions) {
    const card = el('div', 'team-card');
    card.append(
      el('div', 'team-card-head',
        el('span', 'team-card-title', `MCP ${interaction.kind}：${interaction.summary}`),
        badge('pending')),
      el('div', 'team-card-id', `${interaction.memberName}（${shortId(interaction.memberId)}）`),
    );
    const body = el('div', 'team-card-body');
    body.append(el('pre', null, JSON.stringify(interaction.payload, null, 2)));
    const actions = el('div', 'team-actions');
    const response = document.createElement('textarea');
    response.placeholder = '可选的 elicitation 响应（JSON 或文本）';
    response.setAttribute('aria-label', 'MCP 交互响应');
    const accept = el('button', null, '接受');
    accept.type = 'button';
    accept.addEventListener('click', () => {
      let parsed = {};
      if (response.value.trim()) {
        try {
          parsed = JSON.parse(response.value);
        } catch {
          parsed = { text: response.value };
        }
      }
      void post(
        `/api/teams/runs/${snapshot.run.id}/mcp-interactions/${interaction.id}`,
        { action: 'accept', response: parsed },
      );
    });
    const reject = el('button', 'danger', '拒绝');
    reject.type = 'button';
    reject.addEventListener('click', () =>
      void post(
        `/api/teams/runs/${snapshot.run.id}/mcp-interactions/${interaction.id}`,
        { action: 'reject', response: {} },
      ),
    );
    actions.append(accept, reject);
    card.append(body, response, actions);
    view.append(card);
  }

  const approvals = snapshot.approvals || [];
  for (const approval of approvals) {
    const card = el('div', 'team-card');
    card.append(
      el('div', 'team-card-head',
        el('span', 'team-card-title', `待审批：${approval.tool || approval.action || '工具调用'}`),
        badge('pending')),
      el('div', 'team-card-id',
        `${approval.memberName}（${shortId(approval.memberId)}）· ${approval.resource || ''}`),
    );
    const body = el('div', 'team-card-body');
    body.append(
      el('p', null, `风险：${approval.riskLevel || 'unknown'} · 策略：${approval.policyVersion || '-'}`),
      el('p', null, `请求摘要：${approval.requestKey}`),
      el('p', null, `代次：${approval.generation ?? '-'} · 执行：${shortId(approval.activationId || '-')}`),
      el('p', null, approval.reason),
    );
    const actions = el('div', 'team-actions');
    const reason = document.createElement('input');
    reason.placeholder = '审批理由（可选）';
    reason.setAttribute('aria-label', '审批理由');
    const approve = el('button', null, '批准本次');
    approve.type = 'button';
    approve.addEventListener('click', () =>
      void post(`/api/teams/runs/${snapshot.run.id}/approvals/${approval.approvalRequestId}`, {
        decision: 'approved',
        reason: reason.value || '用户批准',
      }),
    );
    const deny = el('button', 'danger', '拒绝');
    deny.type = 'button';
    deny.addEventListener('click', () =>
      void post(`/api/teams/runs/${snapshot.run.id}/approvals/${approval.approvalRequestId}`, {
        decision: 'denied',
        reason: reason.value || '用户拒绝',
      }),
    );
    actions.append(reason, approve, deny);
    card.append(body, actions);
    view.append(card);
  }

  if (root && !TERMINAL.has(snapshot.run.status)) {
    const form = el('form', 'team-form team-card');
    form.append(el('div', 'field-label', '新建成员（默认在主成员下）'));
    const name = document.createElement('input');
    name.placeholder = '成员名称（可选）';
    name.setAttribute('aria-label', '成员名称');
    const task = document.createElement('textarea');
    task.placeholder = '这次委派的具体任务和验收条件';
    task.required = true;
    task.setAttribute('aria-label', '成员任务');
    const context = document.createElement('select');
    context.setAttribute('aria-label', '上下文模式');
    context.append(option('fresh', 'fresh（独立上下文）'), option('fork', 'fork（继承已完成轮次）'));
    const parent = document.createElement('select');
    parent.setAttribute('aria-label', '父成员');
    for (const member of members.filter((entry) => entry.status !== 'closed')) {
      parent.append(option(member.id, `父成员：${member.name}`));
    }
    parent.value = root.id;
    const submit = el('button', null, '创建成员');
    submit.type = 'submit';
    form.append(name, task, context, parent, submit);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void post(`/api/teams/runs/${snapshot.run.id}/members`, {
        parentMemberId: parent.value,
        name: name.value || undefined,
        message: task.value,
        context: context.value,
      });
    });
    view.append(form);
  }
}

function option(value, label) {
  const node = document.createElement('option');
  node.value = value;
  node.textContent = label;
  return node;
}

function renderTasks() {
  const snapshot = state.snapshot;
  const tasks = snapshot.tasks || [];
  if (tasks.length === 0) {
    view.append(el('p', 'team-empty', '任务板是空的。主成员可以创建任务；你也可以在这里先建一个。'));
  }
  for (const task of tasks) {
    const card = el('div', 'team-card');
    const head = el('div', 'team-card-head');
    head.append(el('span', 'team-card-title', task.title), badge(task.status));
    card.append(head, el('div', 'team-card-id', `${task.id} · rev ${task.revision}${task.required ? ' · 必需' : ' · 可选'}`));
    const body = el('div', 'team-card-body');
    body.append(
      el('p', null, `负责人：${task.ownerId ? memberName(task.ownerId) : '未分配'}`),
      el('p', null, `依赖：${(task.dependencies || []).length ? task.dependencies.map(shortId).join('、') : '无'}`),
      el('p', null, `验收：${task.acceptance || '（未填写）'}`),
    );
    if (task.specification) body.append(el('pre', null, task.specification));
    if (task.failureReason) body.append(el('p', null, `原因：${task.failureReason}`));
    card.append(body);

    const actions = el('div', 'team-actions');
    const detail = el('button', null, '查看提交');
    detail.type = 'button';
    const panel = el('pre', null, '');
    panel.hidden = true;
    detail.addEventListener('click', async () => {
      try {
        const data = await api(`/api/teams/tasks/${task.id}`);
        panel.textContent = JSON.stringify(data.attempts, null, 2);
        panel.hidden = !panel.hidden;
      } catch (error) {
        setNote(error.message, true);
      }
    });
    actions.append(detail);

    if (task.status === 'submitted' && !TERMINAL.has(snapshot.run.status)) {
      const reason = document.createElement('input');
      reason.placeholder = '验收/拒绝理由（必填）';
      reason.setAttribute('aria-label', `任务 ${task.title} 的验收理由`);
      const accept = el('button', null, '通过');
      accept.type = 'button';
      accept.addEventListener('click', async () => {
        const result = await post(`/api/teams/tasks/${task.id}/review`, {
          expectedRevision: task.revision,
          decision: 'accepted',
          reason: reason.value || '验收通过',
        });
        if (!result) return;
      });
      const reject = el('button', 'danger', '拒绝');
      reject.type = 'button';
      reject.addEventListener('click', () =>
        void post(`/api/teams/tasks/${task.id}/review`, {
          expectedRevision: task.revision,
          decision: 'rejected',
          reason: reason.value || '证据不充分，请重新提交',
        }),
      );
      actions.append(reason, accept, reject);
    }

    if (!TERMINAL.has(task.status) && task.status !== 'accepted') {
      const cancel = el('button', 'danger', '取消任务');
      cancel.type = 'button';
      cancel.addEventListener('click', () => {
        const reason = prompt('取消原因（必需任务必须填写）');
        if (reason === null) return;
        void post(`/api/teams/tasks/${task.id}/cancel`, {
          expectedRevision: task.revision,
          reason,
        });
      });
      actions.append(cancel);
    }
    card.append(actions, panel);
    view.append(card);
  }

  if (state.team?.config?.mode === 'team' && !TERMINAL.has(snapshot.run.status)) {
    const form = el('form', 'team-form team-card');
    form.append(el('div', 'field-label', '新建任务'));
    const title = document.createElement('input');
    title.placeholder = '标题';
    title.required = true;
    title.setAttribute('aria-label', '任务标题');
    const spec = document.createElement('textarea');
    spec.placeholder = '任务说明（可选）';
    spec.setAttribute('aria-label', '任务说明');
    const acceptance = document.createElement('input');
    acceptance.placeholder = '可检查的验收条件';
    acceptance.setAttribute('aria-label', '验收条件');
    const owner = document.createElement('select');
    owner.setAttribute('aria-label', '负责人');
    owner.append(option('', '未分配（成员可自行领取）'));
    for (const member of snapshot.members) {
      owner.append(option(member.id, `负责人：${member.name}`));
    }
    const required = document.createElement('label');
    required.className = 'team-hint';
    const requiredBox = document.createElement('input');
    requiredBox.type = 'checkbox';
    required.append(requiredBox, document.createTextNode(' 必需任务（必须有验收条件）'));
    const submit = el('button', null, '创建任务');
    submit.type = 'submit';
    form.append(title, spec, acceptance, owner, required, submit);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void post(`/api/teams/runs/${snapshot.run.id}/tasks`, {
        title: title.value,
        specification: spec.value,
        acceptance: acceptance.value,
        required: requiredBox.checked,
        ownerId: owner.value || null,
      });
    });
    view.append(form);
  }
}

function renderMessages() {
  const snapshot = state.snapshot;
  const messages = snapshot.messages || [];
  for (const message of messages) {
    const node = el('div', 'team-message');
    node.dataset.state = message.state;
    node.append(
      el('div', 'team-message-meta',
        `#${message.sequence} · ${memberName(message.senderId)} → ${memberName(message.recipientId)} · ${message.state} · ${message.senderKind}`),
      el('div', null, message.body),
    );
    view.append(node);
  }
  if (messages.length === 0) view.append(el('p', 'team-empty', '还没有协作消息。'));

  if (!TERMINAL.has(snapshot.run.status) && snapshot.members.length > 0) {
    const form = el('form', 'team-form team-card');
    const label = el('div', 'field-label', '以用户身份给成员发消息（带来源，不会被当成系统指令）');
    const recipient = document.createElement('select');
    recipient.setAttribute('aria-label', '收件成员');
    for (const member of snapshot.members) {
      if (member.status !== 'closed') recipient.append(option(member.id, member.name));
    }
    const body = document.createElement('textarea');
    body.placeholder = '消息内容';
    body.required = true;
    body.setAttribute('aria-label', '消息内容');
    const submit = el('button', null, '发送');
    submit.type = 'submit';
    form.append(label, recipient, body, submit);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void post(`/api/teams/runs/${snapshot.run.id}/messages`, {
        recipientId: recipient.value,
        clientMessageId: crypto.randomUUID(),
        body: body.value,
      });
    });
    view.append(form);
  }
}

function renderEvents() {
  const events = state.snapshot.events || [];
  for (const event of events.slice().reverse()) {
    const card = el('div', 'team-card');
    card.append(
      el('div', 'team-card-head',
        el('span', 'team-card-title', `#${event.sequence} ${event.kind}`)),
      el('div', 'team-card-id', event.createdAt),
      el('pre', null, JSON.stringify(event.payload, null, 2)),
    );
    view.append(card);
  }
  if (events.length === 0) view.append(el('p', 'team-empty', '还没有事件。'));
}

async function renderArtifacts() {
  const snapshot = state.snapshot;
  const artifacts = snapshot.artifacts || [];
  if (!state.integrations) {
    try {
      const data = await api(`/api/teams/runs/${snapshot.run.id}/integrations`);
      state.integrations = data.integrations || [];
    } catch {
      state.integrations = [];
    }
  }
  for (const artifact of artifacts) {
    const card = el('div', 'team-card');
    card.append(
      el('div', 'team-card-head', el('span', 'team-card-title', `${artifact.kind} · ${shortId(artifact.id)}`), badge('candidate')),
      el('div', 'team-card-id', `候选哈希：${artifact.manifest.candidateHash}`),
    );
    const body = el('div', 'team-card-body');
    for (const file of artifact.manifest.files || []) {
      body.append(el('div', 'team-artifact', `${file.change} ${file.path}${file.fromPath ? ` ← ${file.fromPath}` : ''} ${file.contentHash || ''}`));
    }
    if ((artifact.testEvidence || []).length) body.append(el('pre', null, artifact.testEvidence.join('\n')));
    card.append(body);
    view.append(card);
  }
  if (artifacts.length === 0) view.append(el('p', 'team-empty', '还没有产物。成员提交 diff 后会出现在这里。'));

  for (const integration of state.integrations) {
    const card = el('div', 'team-card');
    card.append(
      el('div', 'team-card-head', el('span', 'team-card-title', `集成候选 · ${shortId(integration.id)}`), badge(integration.status)),
      el('div', 'team-card-id', `候选：${integration.candidateHash}`),
    );
    const body = el('div', 'team-card-body');
    body.append(el('p', null, `冲突：${(integration.conflicts || []).length ? integration.conflicts.join('、') : '无'}`));
    body.append(el('pre', null, JSON.stringify(integration.journal || [], null, 2)));
    card.append(body);
    if ((integration.conflicts || []).length > 0) {
      const actions = el('div', 'team-actions');
      const open = el('button', null, '解决冲突');
      open.type = 'button';
      open.addEventListener('click', () => {
        void (async () => {
          try {
            const detail = await api(
              `/api/teams/integrations/${integration.id}/conflicts`,
            );
            const panel = el('div', 'team-form');
            for (const conflict of detail.conflicts) {
              panel.append(el('div', 'team-card-id', conflict.path));
              panel.append(el('pre', null, `源文件:\n${conflict.source.content ?? '（不可读）'}`));
              panel.append(el('pre', null, `候选:\n${conflict.candidate.content ?? '（不可读）'}`));
              if (conflict.other) panel.append(el('pre', null, `另一方:\n${conflict.other}`));
              const row = el('div', 'team-actions');
              const keepSource = el('button', null, '保留源文件');
              keepSource.type = 'button';
              keepSource.addEventListener('click', () =>
                void post(
                  `/api/teams/integrations/${integration.id}/conflicts`,
                  { path: conflict.path, resolution: 'source' },
                ).then(() => {
                  state.integrations = null;
                  void renderArtifacts();
                }),
              );
              const keepCandidate = el('button', null, '采用候选');
              keepCandidate.type = 'button';
              keepCandidate.addEventListener('click', () =>
                void post(
                  `/api/teams/integrations/${integration.id}/conflicts`,
                  { path: conflict.path, resolution: 'candidate' },
                ).then(() => {
                  state.integrations = null;
                  void renderArtifacts();
                }),
              );
              const manual = el('button', null, '手工合并…');
              manual.type = 'button';
              manual.addEventListener('click', () => {
                const content = prompt(`编辑 ${conflict.path} 的合并结果`);
                if (content === null) return;
                void post(
                  `/api/teams/integrations/${integration.id}/conflicts`,
                  { path: conflict.path, resolution: 'manual', content },
                ).then(() => {
                  state.integrations = null;
                  void renderArtifacts();
                });
              });
              row.append(keepSource, keepCandidate, manual);
              panel.append(row);
            }
            card.append(panel);
          } catch (error) {
            setNote(error.message, true);
          }
        })();
      });
      const verify = el('button', null, '重新验证');
      verify.type = 'button';
      verify.addEventListener('click', () =>
        void post(`/api/teams/integrations/${integration.id}/verify`),
      );
      actions.append(open, verify);
      card.append(actions);
    } else if (['candidate', 'resolved'].includes(integration.status)) {
      const verify = el('button', null, '重新验证');
      verify.type = 'button';
      verify.addEventListener('click', () =>
        void post(`/api/teams/integrations/${integration.id}/verify`),
      );
      card.append(verify);
    }
    view.append(card);
  }
  for (const integration of state.integrations) {
    if ((integration.conflicts || []).length > 0) continue;
    if (!['candidate', 'verified', 'resolved'].includes(integration.status)) continue;
    const artifact = artifacts.find((entry) => entry.taskId === integration.taskId);
    if (!artifact) continue;
    const actions = el('div', 'team-actions');
    const publish = el('button', null, '发布到源目录');
    publish.type = 'button';
    publish.addEventListener('click', () => {
      if (!confirm('发布前会核对源目录哈希；相关文件被用户改动时会停止。继续？')) return;
      void post(`/api/teams/integrations/${integration.id}/publish`, {
        memberId: artifact.memberId,
      });
    });
    actions.append(publish);
    view.append(actions);
    break;
  }

  const tasks = snapshot.tasks || [];
  const members = (snapshot.members || []).filter((member) => member.workspaceId);
  if (tasks.length > 0 && members.length > 0 && state.team?.config?.mode === 'team') {
    const form = el('form', 'team-form team-card');
    form.append(el('div', 'field-label', '从成员工作区创建集成候选'));
    const task = document.createElement('select');
    task.setAttribute('aria-label', '候选任务');
    for (const entry of tasks) task.append(option(entry.id, `${entry.title}（${entry.status}）`));
    const member = document.createElement('select');
    member.setAttribute('aria-label', '候选成员');
    for (const entry of members) member.append(option(entry.id, entry.name));
    const submit = el('button', null, '创建候选');
    submit.type = 'submit';
    form.append(task, member, submit);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void post(`/api/teams/runs/${snapshot.run.id}/integrations`, {
        taskId: task.value,
        memberId: member.value,
      }).then(() => {
        state.integrations = null;
        void renderArtifacts();
      });
    });
    view.append(form);
  }

  if (state.integrations.length > 0) {
    view.append(el('p', 'team-hint', '发布前必须核对源目录哈希；冲突候选不会自动写入用户目录。'));
  }
}

// ------------------------------------------------------------------- wire ---

openButton?.addEventListener('click', togglePanel);
$('team-close')?.addEventListener('click', closePanel);
scrim?.addEventListener('click', closePanel);

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state.open) {
    event.preventDefault();
    closePanel();
  }
});

drawer?.addEventListener('keydown', (event) => {
  if (event.key !== 'Tab' || !state.open) return;
  const focusable = drawer.querySelectorAll(
    'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
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

for (const tab of drawer?.querySelectorAll('[data-team-tab]') ?? []) {
  tab.addEventListener('click', () => {
    state.tab = tab.dataset.teamTab;
    if (state.tab === 'artifacts') state.integrations = null;
    render();
    if (state.tab === 'artifacts') void renderArtifacts();
  });
}

$('team-mode')?.addEventListener('click', async () => {
  if (!state.team) return;
  const next = state.team.config.mode === 'team' ? 'delegation' : 'team';
  await act('/api/teams/config', {
    method: 'POST',
    body: JSON.stringify({
      conversationId: state.conversationId,
      expectedRevision: state.team.configRevision,
      config: { mode: next },
      enabled: next === 'team',
    }),
  }, next === 'team' ? 'Team 已开启' : 'Team 已关闭；历史记录保留');
});

$('team-start')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('team-start-message');
  if (!input.value.trim()) return;
  const result = await post('/api/teams/runs', {
    conversationId: state.conversationId,
    requestId: crypto.randomUUID(),
    message: input.value,
  });
  if (result) {
    input.value = '';
    state.snapshot = result.snapshot;
    state.run = result.run;
    state.team = result.team;
    state.cursor = result.snapshot.eventCursor || 0;
    subscribe();
    render();
  }
});

$('team-steer')?.addEventListener('submit', (event) => {
  event.preventDefault();
  const input = $('team-steer-input');
  if (!state.run || !input.value.trim()) return;
  void post(`/api/teams/runs/${state.run.id}/steering`, {
    message: input.value,
    clientMessageId: crypto.randomUUID(),
  }).then((result) => {
    if (result) input.value = '';
  });
});

$('team-pause')?.addEventListener('click', () => {
  if (state.run) void post(`/api/teams/runs/${state.run.id}/pause`);
});
$('team-resume')?.addEventListener('click', () => {
  if (state.run) void post(`/api/teams/runs/${state.run.id}/resume`);
});
$('team-stop')?.addEventListener('click', () => {
  if (state.run && confirm('停止整队？会停止所有成员并保留产物与未决副作用记录。')) {
    void post(`/api/teams/runs/${state.run.id}/stop`, { reason: '用户停止整队' });
  }
});

// A conversation switch in the main app changes the stored id; the panel
// follows it the next time it is opened.
window.addEventListener('storage', (event) => {
  if (event.key !== CONVERSATION_KEY || !state.open) return;
  state.conversationId = event.newValue;
  state.snapshot = null;
  state.run = null;
  state.team = null;
  void load();
});
