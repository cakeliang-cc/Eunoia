/**
 * The workbench in the client module.
 *
 * This drives the real module out of `web/app.js` against the shared DOM
 * shim. It covers the things that break silently: a panel that opens without
 * its tree, an expanded directory that never lists, a preview that shows the
 * model's line-number gutter instead of the file, a terminal that streams text
 * but never settles, and a picker whose choice is never persisted.
 */

import { describe, expect, it } from 'vitest';

import { boot, type El, type Harness, type Route } from './harness.ts';

const ROOT = '/repo';
const FILE_PATH = 'src/a.ts';

const WORKSPACE = {
  configured: true,
  root: ROOT,
  name: 'repo',
  source: 'config',
  agentRoot: null,
  terminal: true,
  git: true,
  maxFileBytes: 2048,
  browseStart: '/Users/you',
};

const ROUTES: Record<string, Route> = {
  'GET /api/workspace': { json: WORKSPACE },
  'GET /api/workspace/files?path=.': {
    json: {
      path: '.',
      entries: [
        { name: 'src', path: 'src', type: 'directory' },
        { name: 'README.md', path: 'README.md', type: 'file' },
      ],
      truncated: false,
    },
  },
  'GET /api/workspace/files?path=src': {
    json: {
      path: 'src',
      entries: [{ name: 'a.ts', path: FILE_PATH, type: 'file' }],
      truncated: false,
    },
  },
  [`GET /api/workspace/file?path=${encodeURIComponent(FILE_PATH)}`]: {
    json: {
      path: FILE_PATH,
      text: 'export const a = 1;\n',
      start: 1,
      end: 2,
      totalLines: 2,
      complete: true,
      size: 20,
      mtimeMs: 1,
    },
  },
  'GET /api/workspace/git/status': {
    json: {
      repo: true,
      branch: 'main',
      changes: [
        {
          path: FILE_PATH,
          kind: 'modified',
          status: ' M',
          staged: false,
          unstaged: true,
          renamedFrom: null,
        },
      ],
      truncated: false,
      error: null,
    },
  },
  [`GET /api/workspace/git/diff?path=${encodeURIComponent(FILE_PATH)}`]: {
    json: {
      path: FILE_PATH,
      patch: [
        `diff --git a/${FILE_PATH} b/${FILE_PATH}`,
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '@@ -1 +1 @@',
        '-export const a = 1;',
        '+export const a = 2;',
      ].join('\n'),
      binary: false,
      untracked: false,
      oversized: false,
      truncated: false,
    },
  },
  'POST /api/workspace/terminal': {
    stream: [
      { type: 'terminal_stdout', text: 'hello\n' },
      { type: 'terminal_stderr', text: 'oops\n' },
      {
        type: 'terminal_exit',
        code: 0,
        signal: null,
        timedOut: false,
        durationMs: 12,
        truncated: false,
      },
    ],
  },
  [`GET /api/workspace/browse?path=${encodeURIComponent(ROOT)}`]: {
    json: {
      path: ROOT,
      parent: '/',
      entries: [{ name: 'Proj', path: `${ROOT}/Proj` }],
      rooted: false,
    },
  },
  'POST /api/workspace': {
    json: { ...WORKSPACE, root: `${ROOT}/Proj`, name: 'Proj', source: 'selected' },
  },
};

async function openWorkbench(routes: Record<string, Route> = ROUTES): Promise<Harness> {
  const harness = await boot({
    local: { df_workbench_open: 'true' },
    routes,
    // The terminal requires the per-process token the server injects into the
    // page; the fake server here only checks that the client sends it.
    token: 'test-token',
  });
  await waitFor(() => harness.element('wb-tree').children.length > 0, 'the tree never rendered');
  return harness;
}

async function waitFor(check: () => boolean, message: string, timeoutMs = 800): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

function rows(harness: Harness, name?: string): El[] {
  const found = harness
    .element('wb-tree')
    .find((node) => node.classList.contains('wb-row') && node.child('wb-name') !== undefined);
  if (name === undefined) return found;
  return found.filter((node) => node.child('wb-name')?.textContent === name);
}

function treeNames(harness: Harness): string[] {
  return harness
    .element('wb-tree')
    .find((node) => node.classList.contains('wb-name'))
    .map((node) => node.textContent);
}

function allText(node: El): string {
  return node
    .find((child) => child.textContent !== '' && child.children.length === 0)
    .map((child) => child.textContent)
    .join('');
}

describe('opening the panel', () => {
  it('restores the open state and renders the workspace root', async () => {
    const harness = await openWorkbench();

    expect(harness.element('workbench').dataset.open).toBe('true');
    expect(harness.element('wb-root-name').textContent).toBe('repo');
    expect(harness.element('wb-body').dataset.empty).toBe('false');
    expect(treeNames(harness)).toEqual(['src', 'README.md']);
    expect(allText(harness.element('wb-foot'))).toContain('agent 文件工具未启用');
  });

  it('shows the empty state when no root is selected', async () => {
    const harness = await boot({
      local: { df_workbench_open: 'true' },
      routes: {
        'GET /api/workspace': {
          json: { configured: false, root: null, terminal: false, git: false },
        },
      },
    });
    await harness.settle();

    expect(harness.element('wb-body').dataset.empty).toBe('true');
    expect(harness.element('wb-root-name').textContent).toBe('没有打开目录');
  });
});

describe('the file tree and preview', () => {
  it('lists a directory when it is expanded', async () => {
    const harness = await openWorkbench();

    rows(harness, 'src')[0]?.onclick?.();
    await waitFor(() => rows(harness, 'a.ts').length === 1, 'src never expanded');

    expect(rows(harness, 'a.ts')).toHaveLength(1);
  });

  it('opens a file without the line-number gutter and shows the text', async () => {
    const harness = await openWorkbench();

    rows(harness, 'src')[0]?.onclick?.();
    await waitFor(() => rows(harness, FILE_PATH.split('/').pop() as string).length === 1, 'src never expanded');
    rows(harness, 'a.ts')[0]?.onclick?.();
    await waitFor(
      () => harness.element('wb-preview').dataset.open === 'true' &&
        harness.element('wb-preview-body').find((node) => node.classList.contains('wb-code')).length > 0,
      'the preview never rendered',
    );

    expect(harness.element('wb-preview-path').textContent).toBe(FILE_PATH);
    const coded = harness
      .element('wb-preview-body')
      .find((node) => node.classList.contains('wb-code'));
    expect(coded.map((node) => node.textContent)).toEqual(['export const a = 1;']);
  });
});

describe('changes', () => {
  it('lists git changes and shows a diff with additions and deletions', async () => {
    const harness = await openWorkbench();

    harness.element('wb-tab-changes').onclick?.();
    await waitFor(
      () => harness.element('wb-changes').find((node) => node.classList.contains('wb-change')).length === 1,
      'the change list never rendered',
    );

    const row = harness
      .element('wb-changes')
      .find((node) => node.classList.contains('wb-change'))[0];
    expect(row?.child('wb-change-path')?.textContent).toBe(FILE_PATH);

    row?.onclick?.();
    await waitFor(
      () => harness.element('wb-preview').dataset.open === 'true' &&
        harness.element('wb-preview-body').find((node) => node.classList.contains('wb-diff-line')).length > 0,
      'the diff never rendered',
    );

    const diffLines = harness
      .element('wb-preview-body')
      .find((node) => node.classList.contains('wb-diff-line'));
    expect(diffLines.map((node) => node.className)).toContain('wb-diff-line add');
    expect(diffLines.map((node) => node.className)).toContain('wb-diff-line del');
  });

  it('marks a file the agent wrote during a turn', async () => {
    const harness = await boot({
      local: { df_workbench_open: 'true' },
      routes: ROUTES,
      frames: [
        {
          type: 'tool_call',
          callId: 'c1',
          name: 'write',
          displayable: true,
          summary: '写入 src/a.ts（20 B）',
        },
        {
          type: 'tool_result',
          callId: 'c1',
          name: 'write',
          ok: true,
          durationMs: 5,
          summary: '写入 src/a.ts（20 B）',
        },
        { type: 'completed', text: '改好了。', conversationId: 'c1', messageId: 'm1' },
      ],
    });
    await waitFor(() => harness.element('wb-tree').children.length > 0, 'the tree never rendered');
    await harness.send('改一下 a.ts');

    // Git status has not been read yet, so the count is the session's one file.
    expect(harness.element('wb-changes-count').textContent).toBe('1');

    harness.element('wb-tab-changes').onclick?.();
    await waitFor(
      () => allText(harness.element('wb-changes')).includes('本次对话改动') &&
        allText(harness.element('wb-changes')).includes('src/a.ts'),
      'the session change section never appeared',
    );
    // The same path is in the session's list and git's list; the badge counts
    // distinct files, not the two sections.
    await waitFor(
      () => harness.element('wb-changes-count').textContent === '1',
      'the git change never joined the count',
    );
  });
});

describe('the terminal', () => {
  it('streams stdout, stderr and the exit status, then re-enables the input', async () => {
    const harness = await openWorkbench();

    harness.element('wb-tab-terminal').onclick?.();
    const input = harness.element('wb-term-input');
    input.value = 'printf hello';
    const submit = harness.element('wb-term-form').listeners.submit?.[0];
    if (!submit) throw new Error('the terminal form no longer listens for submit');
    submit({ preventDefault() {} });

    await waitFor(
      () => allText(harness.element('wb-terminal')).includes('完成'),
      'the terminal never settled',
    );

    const text = allText(harness.element('wb-terminal'));
    expect(text).toContain('hello');
    expect(text).toContain('oops');
    expect(text).toContain('完成');
    expect(input.disabled).toBe(false);
    expect(
      harness.requests.find((request) => request.url === '/api/workspace/terminal')?.body,
    ).toMatchObject({ command: 'printf hello' });
    expect(
      harness.requests.find((request) => request.url === '/api/workspace/terminal')?.headers,
    ).toMatchObject({ 'X-Eunoia-Token': 'test-token' });
  });
});

describe('the directory picker', () => {
  it('opens at the current root and switches to the chosen directory', async () => {
    const harness = await openWorkbench();

    harness.element('wb-root').onclick?.();
    await waitFor(
      () => harness.element('wb-picker').dataset.open === 'true' &&
        harness.element('wb-picker-list').find((node) => node.classList.contains('wb-dir')).length === 1,
      'the picker never listed the root',
    );

    harness.element('wb-picker-choose').onclick?.();
    await waitFor(
      () => harness.element('wb-picker').dataset.open === 'false',
      'the picker never closed',
    );

    const posted = harness.requests.find(
      (request) => request.method === 'POST' && request.url === '/api/workspace',
    );
    expect(posted?.body).toMatchObject({ path: ROOT });
    expect(harness.element('wb-root-name').textContent).toBe('Proj');
  });
});
