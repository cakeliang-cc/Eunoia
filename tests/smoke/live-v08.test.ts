/**
 * V08 — product-level design → preview → screenshot → model edit → screenshot.
 *
 * Gated: RUN_SMOKE=1 V08_SMOKE=1. The project is synthetic, the model is the
 * real DeepSeek Flash vision route, and the preview is a real host dev server
 * reached through the same gateway lease used by R04. The browser is a real
 * headless Chrome driven by Playwright MCP; the screenshots go through the R06
 * file-path → media → image-block adapter and into the model request.
 *
 * The assertions are objective: the CSS the model wrote and the final
 * screenshot's pixels. A model that only describes the image without editing
 * the file fails the test.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { connect as netConnect } from 'node:net';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import sharp from 'sharp';
import { Workspace } from '../../src/tools/workspace.ts';
import { codingTools } from '../../src/tools/coding/index.ts';
import { createPreviewTools } from '../../src/tools/preview-tools.ts';
import { ProcessService } from '../../src/processes/service.ts';
import { PreviewGateway } from '../../src/previews/gateway.ts';
import { PreviewService } from '../../src/previews/service.ts';
import { MemoryPreviewStore } from '../../src/previews/store.ts';
import { InMemoryStore } from '../../src/db/in-memory-store.ts';
import { MemoryMediaBlobStore } from '../../src/media/blob-store.ts';
import { MediaService } from '../../src/media/service.ts';
import { DEFAULT_MEDIA_LIMITS } from '../../src/media/limits.ts';
import { DecodeGate } from '../../src/media/decode.ts';
import { createToolMediaPort } from '../../src/media/tool-media.ts';
import { planToolImages } from '../../src/service/media-turn.ts';
import { defaultImagePolicies } from '../../src/provider/image-policy-registry.ts';
import { modelProfile } from '../../src/models/registry.ts';
import { McpClientManager } from '../../src/mcp/manager.ts';
import { MemoryMcpStore } from '../../src/mcp/store-memory.ts';
import { loadSecretBox, McpCredentialVault } from '../../src/mcp/credentials.ts';
import { DEFAULT_CONFIG_PARSE_OPTIONS, parseServerInput } from '../../src/mcp/config.ts';
import { buildMcpTools } from '../../src/mcp/tool-adapter.ts';
import { createCompanionAgent, streamReply } from '../../src/agent/infp-agent.ts';
import { installProvider } from '../../src/agent/model-client.ts';
import { installTracing } from '../../src/observability/tracing.ts';
import { MODEL_IDS } from '../../src/config.ts';
import { ToolRegistry } from '../../src/tools/registry.ts';
import type { ToolExecutor, ToolExecutionResult } from '../../src/tools/types.ts';
import type { ToolPermissionPort } from '../../src/tools/types.ts';

const enabled = process.env.RUN_SMOKE === '1' && process.env.V08_SMOKE === '1';

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function playwrightCli(): string | null {
  const require = createRequire(import.meta.url);
  try {
    return join(dirname(require.resolve('@playwright/mcp')), 'cli.js');
  } catch {
    const bin = join(process.cwd(), 'node_modules', '.bin', 'playwright-mcp');
    return existsSync(bin) ? bin : null;
  }
}

function hostExecutor(cwd: string): ToolExecutor {
  return {
    run(input): Promise<ToolExecutionResult> {
      const started = Date.now();
      const script =
        input.command[0] === 'sh' && input.command[1] === '-c'
          ? String(input.command[2])
          : input.command.join(' ');
      return new Promise((resolve) => {
        execFile(
          'sh',
          ['-c', script],
          { cwd, timeout: input.timeoutMs ?? 30_000, signal: input.signal, maxBuffer: 4 * 1024 * 1024 },
          (error, stdout, stderr) =>
            resolve({
              status: error ? 'FAILED' : 'SUCCEEDED',
              exitCode: error ? ((error as { code?: number }).code ?? 1) : 0,
              stdout: String(stdout),
              stderr: String(stderr),
              timedOut: Boolean(error && (error as { killed?: boolean }).killed),
              durationMs: Date.now() - started,
              executionId: `exec_${randomUUID()}`,
              cwd: '/workspace',
            }),
        );
      });
    },
    tunnel(input) {
      return Promise.resolve(netConnect(input.port, '127.0.0.1'));
    },
  };
}

function allowAll(): ToolPermissionPort {
  return {
    async decide() {
      return { kind: 'allow' };
    },
    async awaitDecision() {
      return { kind: 'allow' };
    },
  };
}

describe.skipIf(!enabled)('V08 — real model design/preview/screenshot loop', () => {
  it(
    'reads the design, starts preview, screenshots, edits CSS, and verifies the second screenshot',
    async () => {
      installProvider();
      installTracing();
      const root = await mkdtemp(join(tmpdir(), 'eunoia-v08-'));
      cleanups.push(async () => rm(root, { recursive: true, force: true }));
      const project = join(root, 'project');
      const output = join(root, 'browser-output');
      await mkdir(project, { recursive: true });
      await mkdir(output, { recursive: true });

      const design = await sharp({
        create: { width: 800, height: 600, channels: 4, background: '#ffffff' },
      })
        .composite([
          {
            input: Buffer.from(
              `<svg width="200" height="200"><rect width="200" height="200" fill="#1e6fd9"/></svg>`,
            ),
            left: 300,
            top: 200,
          },
        ])
        .png()
        .toBuffer();
      await writeFile(join(project, 'design.png'), design);
      await writeFile(
        join(project, 'index.html'),
        '<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><div class="box"></div></body></html>',
      );
      await writeFile(
        join(project, 'style.css'),
        'html,body{margin:0;height:100%;}body{display:grid;place-items:center;}.box{width:40px;height:40px;background:#d93a3a;}\n',
      );

      const store = new InMemoryStore();
      await store.ensureUser('v08-user');
      const media = new MediaService({
        store,
        blobs: new MemoryMediaBlobStore(),
        limits: DEFAULT_MEDIA_LIMITS,
        gate: new DecodeGate(2),
      });
      const workspace = new Workspace({ root: project });
      const executor = hostExecutor(project);
      const processes = new ProcessService({ store });
      const gateway = new PreviewGateway({ host: '127.0.0.1', port: 0, baseDomain: 'preview.localhost' });
      const address = await gateway.start();
      cleanups.push(async () => {
        await previews.stopConversation('v08-user', 'v08-conversation').catch(() => undefined);
        await gateway.stop();
      });
      const previews = new PreviewService({
        processes,
        store: new MemoryPreviewStore(),
        gateway,
        baseDomain: 'preview.localhost',
        gatewayPort: address.port,
        limits: { readyTimeoutMs: 20_000, ttlMs: 10 * 60_000, maxPerConversation: 1 },
      });

      const cli = playwrightCli();
      if (!cli) throw new Error('@playwright/mcp is not installed');
      const parsed = parseServerInput(
        {
          name: 'PlaywrightV08',
          enabled: true,
          transport: 'stdio',
          stdio: {
            command: process.execPath,
            args: [
              cli,
              '--browser',
              'chrome',
              '--headless',
              '--isolated',
              '--no-sandbox',
              '--output-dir',
              output,
              '--image-responses',
              'omit',
            ],
            runLocation: 'host',
          },
          toolPolicy: { deny: ['browser_run_code_unsafe', 'browser_file_upload'] },
        },
        { ...DEFAULT_CONFIG_PARSE_OPTIONS, userId: 'v08-user', allowHostProcess: true } as never,
      );
      const browserHome = join(root, 'browser-home');
      const browserCache = join(root, 'browser-cache');
      await mkdir(browserHome, { recursive: true });
      await mkdir(browserCache, { recursive: true });
      const mcpStore = new MemoryMcpStore();
      const manager = new McpClientManager({
        store: mcpStore,
        vault: new McpCredentialVault(mcpStore, loadSecretBox({})),
        now: () => new Date(),
        connect: (options) =>
          import('../../src/mcp/client.ts').then(({ McpConnection }) =>
            McpConnection.open({
              ...options,
              env: {
                ...process.env,
                HOME: browserHome,
                PLAYWRIGHT_BROWSERS_PATH: browserCache,
              },
            }),
          ),
      });
      await mcpStore.insertMcpServer(parsed.config);
      await manager.connect('v08-user', parsed.config.id);
      const catalog = await manager.catalog('v08-user', parsed.config.id);
      if (!catalog) throw new Error('no browser catalog');
      cleanups.push(async () => manager.shutdown());
      const browserTools = buildMcpTools({
        manager,
        config: parsed.config,
        catalog,
        media: createToolMediaPort(media),
        artifacts: null,
      });

      const tools = new ToolRegistry([
        ...codingTools,
        ...createPreviewTools(previews),
        ...browserTools,
      ]);
      const agent = createCompanionAgent({
        tools,
        workspace,
        executor,
        toolMedia: createToolMediaPort(media),
        policy: { allowWorkspaceWrites: true, allowCommands: true, maxOutputChars: 60_000 },
        model: MODEL_IDS.fast,
        maxSteps: 24,
      });
      const events = [];
      const prompt = [
        '你是产品验收操作员。项目在 /workspace，里面已有 design.png、index.html、style.css。',
        '请严格按顺序完成：',
        '1. 用 read_image 读取 design.png，观察目标布局（蓝色 #1e6fd9 方块，约 200×200，页面居中）。路径必须是相对工作区根的 `design.png`，不要用 /workspace/design.png。',
        '2. 用 preview_start 启动 `python3 -m http.server 4410 --bind 127.0.0.1`，port=4410；拿到 userUrl。',
        '3. 用浏览器 MCP 导航到 userUrl，并用 browser_take_screenshot 截图。',
        '4. 对比截图与 design.png，用 edit 修改 style.css，使 .box 为 200×200、背景 #1e6fd9、页面居中。',
        '5. 再次导航/刷新页面并截图，确认布局匹配。',
        '不要只描述，必须实际调用工具并修改文件；最后只报告完成与关键 CSS。',
      ].join('\n');
      const releases: Array<() => Promise<void>> = [];
      const profile = modelProfile(MODEL_IDS.fast);
      try {
        for await (const event of streamReply(agent, prompt, {
          userId: 'v08-user',
          conversationId: 'v08-conversation',
          permission: allowAll(),
          toolMedia: createToolMediaPort(media),
          prepareMedia: async ({ imageIds }) => {
            const loaded = await planToolImages(
              {
                media,
                policies: defaultImagePolicies(),
                limits: DEFAULT_MEDIA_LIMITS,
                inputBudgetTokens: 200_000,
              },
              {
                userId: 'v08-user',
                conversationId: 'v08-conversation',
                profile,
                imageIds,
                requiresTools: true,
                fixedTokens: 0,
              },
            );
            if (!loaded) return undefined;
            releases.push(loaded.release);
            return loaded.plan;
          },
        })) {
          events.push(event);
        }
      } finally {
        await Promise.all(releases.map((release) => release().catch(() => undefined)));
      }
      const names = events.filter((event) => event.type === 'tool_call').map((event) => event.name);
      const imageReads = events.filter(
        (event) => event.type === 'tool_result' && event.name === 'read_image',
      );
      expect(imageReads.some((event) => event.type === 'tool_result' && event.ok)).toBe(true);
      console.error('V08_TOOL_NAMES', JSON.stringify(names));
      for (const event of events) {
        if (event.type === 'tool_result' && (!event.ok || event.name.includes('browser') || event.name.includes('preview'))) {
          console.error('V08_TOOL_RESULT', event.name, event.ok, event.error ?? event.summary ?? '');
        }
      }
      const completed = events.at(-1);
      console.error('V08_FINAL', completed?.type === 'completed' ? completed.text.slice(0, 1200) : completed?.type);
      expect(names).toContain('read_image');
      expect(names.some((name) => name.includes('preview_start'))).toBe(true);
      expect(names.some((name) => name.includes('browser_navigate'))).toBe(true);
      expect(names.filter((name) => name.includes('browser_take_screenshot')).length).toBeGreaterThanOrEqual(2);
      expect(names.includes('edit') || names.includes('write')).toBe(true);
      const css = await readFile(join(project, 'style.css'), 'utf8');
      expect(css).toMatch(/200px/);
      expect(css.toLowerCase()).toContain('#1e6fd9');

      // The browser writes the screenshot file; its bytes are the same bytes
      // imported into media by the R06 adapter. Assert the centre pixel is the
      // target blue, not the original red.
      const files = (await readdir(output)).filter((name) => name.endsWith('.png'));
      const withTimes = await Promise.all(
        files.map(async (name) => ({ name, mtime: (await stat(join(output, name))).mtimeMs })),
      );
      withTimes.sort((a, b) => b.mtime - a.mtime);
      if (!withTimes[0]) throw new Error('no screenshot file');
      const bytes = await readFile(join(output, withTimes[0].name));
      const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const x = Math.floor(info.width / 2);
      const y = Math.floor(info.height / 2);
      const offset = (y * info.width + x) * 4;
      const [r, g, b] = [data[offset] ?? 0, data[offset + 1] ?? 0, data[offset + 2] ?? 0];
      expect(Math.abs(r - 30)).toBeLessThan(45);
      expect(Math.abs(g - 111)).toBeLessThan(45);
      expect(Math.abs(b - 217)).toBeLessThan(45);
    },
    300_000,
  );
});
