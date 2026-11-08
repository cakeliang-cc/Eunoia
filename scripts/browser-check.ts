/**
 * A real-browser check for the multimodal composer, via the DevTools Protocol.
 *
 * It starts an isolated in-memory server with a stub model, drives Chrome
 * headless at 390px and desktop widths, drops a real PNG into the composer,
 * sends an image-only turn, opens the preview and records screenshots. No
 * dependency on Playwright: Node's `fetch`/`WebSocket` speak CDP, and the only
 * external requirement is a Chrome install.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/api/server.ts';
import { InMemoryStore } from '../src/db/in-memory-store.ts';
import { MemoryMediaBlobStore } from '../src/media/blob-store.ts';
import { MediaService } from '../src/media/service.ts';
import { DEFAULT_MEDIA_LIMITS } from '../src/media/limits.ts';
import { DecodeGate } from '../src/media/decode.ts';
import { defaultImagePolicies } from '../src/provider/image-policy-registry.ts';
import { sessionConfig } from '../src/session/config.ts';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Cdp {
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<any>;
  close(): void;
}

async function connect(wsUrl: string): Promise<Cdp> {
  const socket = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP socket timed out')), 10_000);
    socket.addEventListener(
      'open',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      'error',
      () => {
        clearTimeout(timer);
        reject(new Error('CDP socket failed'));
      },
      { once: true },
    );
  });
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)) as {
      id?: number;
      result?: unknown;
      error?: { message?: string };
    };
    if (message.id === undefined) return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message ?? 'CDP error'));
    else entry.resolve(message.result);
  });
  return {
    send(method, params = {}, sessionId) {
      const id = nextId++;
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    close() {
      socket.close();
    },
  };
}

async function main(): Promise<void> {
  process.env.DEEPSEEK_API_KEY ??= 'browser-check-placeholder';
  const store = new InMemoryStore();
  const media = new MediaService({
    store,
    blobs: new MemoryMediaBlobStore(),
    limits: DEFAULT_MEDIA_LIMITS,
    gate: new DecodeGate(2),
  });
  const config = sessionConfig({ SESSION_PROMPT_RESERVE_TOKENS: '0' });
  const server: Server = createApp({
    store,
    media,
    imagePolicies: defaultImagePolicies(),
    mediaLimits: DEFAULT_MEDIA_LIMITS,
    sessionConfig: config,
    runner: async function* () {
      yield { type: 'text_delta', text: '这是一张测试图片。' };
      yield { type: 'completed', text: '这是一张测试图片。' };
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}/`;

  // Chrome's own sandbox cannot create a headless profile under the system
  // temporary directory in this environment; a workspace-local directory is
  // writable and is removed afterwards.
  const profile = await mkdtemp(join(process.cwd(), '.chrome-check-'));
  const debugPort = 9333;
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-breakpad',
      '--disable-crash-reporter',
      '--hide-scrollbars',
      '--window-size=1280,900',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  chrome.stderr?.on('data', (chunk: Buffer) => {
    const line = chunk.toString();
    // Chrome is noisy about Keychain and crashpad in a sandboxed shell; only
    // surface a fatal launch problem.
    if (/Failed to|FATAL|cannot/i.test(line)) process.stderr.write(`chrome: ${line}`);
  });
  // A hung headless browser must not leave the command running forever.
  const guard = setTimeout(() => {
    process.stderr.write('browser check: timed out\n');
    chrome.kill('SIGKILL');
    process.exit(3);
  }, 90_000);
  guard.unref();

  try {
    let wsUrl = '';
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
        if (response.ok) {
          wsUrl = ((await response.json()) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl;
          break;
        }
      } catch {
        // Chrome is still starting.
      }
      await sleep(200);
    }
    if (!wsUrl) throw new Error('Chrome did not expose a DevTools endpoint');

    const cdp = await connect(wsUrl);
    const target = (await cdp.send('Target.createTarget', { url: 'about:blank' })) as {
      targetId: string;
    };
    const attached = (await cdp.send('Target.attachToTarget', {
      targetId: target.targetId,
      flatten: true,
    })) as { sessionId: string };
    const session = attached.sessionId;
    await cdp.send('Page.enable', {}, session);
    await cdp.send('Runtime.enable', {}, session);

    const evaluate = async (expression: string): Promise<any> => {
      const result = (await cdp.send(
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true },
        session,
      )) as { result: { value: unknown } };
      return result.result.value;
    };

    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { width: 390, height: 844, deviceScaleFactor: 2, mobile: true },
      session,
    );
    await cdp.send('Page.navigate', { url }, session);
    await sleep(1_200);

    const png = await sharp({
      create: { width: 480, height: 300, channels: 3, background: '#2374d8' },
    })
      .png()
      .toBuffer();
    const base64 = png.toString('base64');
    await evaluate(`(async () => {
      const bytes = Uint8Array.from(atob('${base64}'), (c) => c.charCodeAt(0));
      const file = new File([bytes], 'check.png', { type: 'image/png' });
      const data = new DataTransfer();
      data.items.add(file);
      document.getElementById('composer').dispatchEvent(
        new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true })
      );
      return true;
    })()`);
    await sleep(1_000);

    const ready = await evaluate(
      `document.querySelectorAll('.media-card[data-state="ready"]').length`,
    );
    if (ready < 1) throw new Error('the image draft did not reach ready');

    // The default route is text-only; a person sending an image selects the
    // Flash route. The UI blocks the send until they do, and this checks the
    // selector actually saves the choice before the turn.
    await evaluate(`(() => {
      const select = document.getElementById('model-select');
      select.value = 'deepseek-flash';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await sleep(600);
    const warningGone = await evaluate(
      `document.querySelectorAll('.media-warning').length`,
    );
    if (warningGone !== 0) throw new Error('the capability warning did not clear after switching models');

    await evaluate(`(() => {
      const input = document.getElementById('input');
      input.value = '';
      document.getElementById('composer').requestSubmit();
      return true;
    })()`);
    await sleep(1_200);

    const userImages = await evaluate(
      `document.querySelectorAll('.turn.user .msg-media img').length`,
    );
    if (userImages < 1) throw new Error('the user turn did not render the image');
    await evaluate(`(() => {
      const button = document.querySelector('.turn.user .msg-media button');
      if (button) button.click();
      return true;
    })()`);
    await sleep(250);
    const previewOpen = await evaluate(`Boolean(document.querySelector('.image-preview'))`);
    if (!previewOpen) throw new Error('the preview did not open');

    const previewShot = (await cdp.send('Page.captureScreenshot', { format: 'png' }, session)) as {
      data: string;
    };
    await evaluate(`(() => { document.querySelector('.preview-close')?.click(); return true; })()`);

    const mobileShot = (await cdp.send('Page.captureScreenshot', { format: 'png' }, session)) as {
      data: string;
    };
    const mobileLayout = await evaluate(`(() => {
      const composer = document.getElementById('composer').getBoundingClientRect();
      const row = document.getElementById('media-row').getBoundingClientRect();
      return {
        viewport: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        composerWidth: Math.round(composer.width),
        mediaRight: Math.round(row.right),
        noHorizontalOverflow: document.documentElement.scrollWidth <= window.innerWidth + 1,
        composerInside: composer.left >= 0 && composer.right <= window.innerWidth + 1,
      };
    })()`);

    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false },
      session,
    );
    await sleep(400);
    const desktopShot = (await cdp.send('Page.captureScreenshot', { format: 'png' }, session)) as {
      data: string;
    };

    await mkdir('docs/captures', { recursive: true });
    await writeFile('docs/captures/multimodal-desktop.png', Buffer.from(desktopShot.data, 'base64'));
    await writeFile('docs/captures/multimodal-390.png', Buffer.from(mobileShot.data, 'base64'));
    await writeFile('docs/captures/multimodal-preview.png', Buffer.from(previewShot.data, 'base64'));
    await writeFile(
      'docs/captures/browser-check.json',
      `${JSON.stringify(
        { url, readyDrafts: ready, warningGone, userImages, previewOpen, mobileLayout },
        null,
        2,
      )}\n`,
    );
    process.stdout.write(
      `browser check: drafts=${ready} user-images=${userImages} preview=${previewOpen}\n` +
        `  390px: ${JSON.stringify(mobileLayout)}\n` +
        `  screenshots: docs/captures/multimodal-{desktop,390,preview}.png\n`,
    );
    cdp.close();
    clearTimeout(guard);
  } finally {
    chrome.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`browser check failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
