/**
 * A hand-written DOM and fetch double for the workbench and the chat client.
 *
 * The client is one static module (`web/app.js`) with no build step, so this
 * shim exists instead of jsdom: it proves event routing, ordering, classes and
 * the requests the module makes, not that a browser lays the result out the same
 * way.
 *
 * It is shared by `client.test.ts` and `workbench.test.ts` so the two suites see
 * the same DOM. A second copy would drift on the first change to either.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// --------------------------------------------------------------- the shim ---

export class El {
  readonly children: El[] = [];
  readonly dataset: Record<string, string> = {};
  readonly attributes: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly listeners: Record<string, ((event: unknown) => void)[]> = {};
  readonly classList: { add(c: string): void; remove(c: string): void; contains(c: string): boolean };

  private text = '';
  private classes = new Set<string>();

  isConnected = false;
  parent: El | null = null;
  scrollTop = 0;
  scrollHeight = 0;
  clientHeight = 0;
  value = '' as string;
  /** Set by the upload test; the real element's `files` is a FileList. */
  files: unknown = null;
  title = '';
  disabled = false;
  onclick: (() => void) | null = null;

  readonly tagName: string;

  constructor(tagName = 'div') {
    this.tagName = tagName;
    // Arrow functions rather than methods, so `this` stays the element. Each
    // one reads the live set: assigning `className` replaces it, and a
    // captured reference would then be answering about a stale one.
    this.classList = {
      add: (c) => void this.classes.add(c),
      remove: (c) => void this.classes.delete(c),
      contains: (c) => this.classes.has(c),
    };
  }

  set className(value: string) {
    this.classes = new Set(value.split(/\s+/).filter(Boolean));
  }
  get className(): string {
    return [...this.classes].join(' ');
  }

  set textContent(value: string) {
    this.text = String(value);
    // As in a real DOM: replacing the text discards the children.
    this.children.length = 0;
  }
  get textContent(): string {
    // Real DOM semantics: textContent includes descendants. The client now
    // renders emphasis and code as child nodes, so reading only the element's
    // own text would make a correctly rendered reply look empty here.
    return this.text + this.children.map((child) => child.textContent).join('');
  }

  append(...nodes: El[]): void {
    for (const node of nodes) {
      this.children.push(node);
      node.parent = this;
      node.isConnected = true;
    }
    this.text = '';
  }

  prepend(node: El): void {
    this.children.unshift(node);
    node.parent = this;
    node.isConnected = true;
  }

  /** Enough of `Element.after` for the trace's insertion point. */
  after(node: El): void {
    const parent = this.parent;
    if (!parent) return;
    const index = parent.children.indexOf(this);
    parent.children.splice(index + 1, 0, node);
    node.parent = parent;
    node.isConnected = true;
  }

  /** Class-selector only; that is all the client uses. */
  querySelector(selector: string): El | null {
    const className = selector.startsWith('.') ? selector.slice(1) : selector;
    return this.find((node) => node.classList.contains(className))[0] ?? null;
  }

  /** Class or tag selector, enough for the approval buttons. */
  querySelectorAll(selector: string): El[] {
    const match = selector.startsWith('.')
      ? (node: El) => node.classList.contains(selector.slice(1))
      : (node: El) => node.tagName === selector;
    return this.find(match);
  }

  /** The menu measures itself before it is positioned. */
  getBoundingClientRect(): {
    left: number; top: number; right: number; bottom: number; width: number; height: number;
  } {
    return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }

  offsetWidth = 0;
  offsetHeight = 0;
  hidden = false;

  remove(): void {
    const index = this.parent?.children.indexOf(this) ?? -1;
    if (index >= 0) this.parent?.children.splice(index, 1);
    this.isConnected = false;
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = String(value);
  }
  getAttribute(name: string): string | undefined {
    return this.attributes[name];
  }
  addEventListener(type: string, handler: (event: unknown) => void): void {
    (this.listeners[type] ??= []).push(handler);
  }
  requestSubmit(): void {}
  focus(): void {}

  /** Everything below this node matching a predicate, depth first. */
  find(predicate: (node: El) => boolean, found: El[] = []): El[] {
    for (const child of this.children) {
      if (predicate(child)) found.push(child);
      child.find(predicate, found);
    }
    return found;
  }
  /** The first direct child with a class. */
  child(className: string): El | undefined {
    return this.children.find((node) => node.classList.contains(className));
  }
}

export type Frame = Record<string, unknown>;

/** Requests the module made, so a test can assert what was asked for. */
export interface CapturedRequest {
  readonly url: string;
  readonly method: string;
  readonly body: Record<string, unknown> | null;
  readonly headers: Record<string, string>;
}

/** What the fake server answers with, keyed by `"METHOD /path"`. */
export interface Route {
  readonly status?: number;
  readonly json?: unknown;
  /** Frames to answer an SSE route with, as the terminal endpoint does. */
  readonly stream?: Frame[];
}

export interface Harness {
  readonly transcript: El;
  readonly element: (id: string) => El;
  readonly store: Map<string, string>;
  readonly requests: CapturedRequest[];
  /** Text the client put on the clipboard, in the order it was copied. */
  readonly copied: string[];
  /** Run one turn by submitting the composer. */
  send(text: string): Promise<void>;
  /** Let queued microtasks and the module's fire-and-forget calls settle. */
  settle(): Promise<void>;
}

/**
 * Load `web/app.js` against a hand-written DOM.
 *
 * The module is compiled with `new Function` rather than imported: it has no
 * imports of its own, and this keeps vitest's module pipeline out of the way of
 * a file that was never meant to go through one. Reading it from its own file
 * (rather than from an inline `<script>`) is what lets the client be linted and
 * keeps `index.html` from being a two-thousand-line surprise.
 *
 * `routes` is the fake server. Anything not routed still answers `200 {}`, so a
 * test only has to describe the requests its subject actually depends on.
 */
export async function boot(options: {
  frames?: Frame[];
  /** Raw SSE text for `/api/chat`, for parser edge cases the frame builder cannot express. */
  rawFrames?: string;
  /**
   * Delay before each streamed frame, in ms.
   *
   * Zero (the default) delivers the whole turn synchronously. A delay is what
   * lets a test observe the client *during* a turn — the stop button exists
   * only while the stream is open.
   */
  frameDelayMs?: number;
  routes?: Record<string, Route>;
  stored?: string;
  /** Extra localStorage entries, written before the module runs. */
  local?: Record<string, string>;
  /**
   * The local permission token the server injects into `<head>`.
   *
   * Omitted means "opened from disk": the client must then keep the permission
   * control hidden rather than sending mutations the server would refuse.
   */
  token?: string;
} = {}): Promise<Harness> {
  const source = readFileSync(join(import.meta.dirname, '..', '..', 'web', 'app.js'), 'utf8');

  const byId = new Map<string, El>();
  const element = (id: string): El => {
    let node = byId.get(id);
    if (!node) byId.set(id, (node = new El()));
    return node;
  };

  const routes = options.routes ?? {};
  const requests: CapturedRequest[] = [];
  const store = new Map<string, string>();
  if (options.stored) store.set('df_conversation', options.stored);
  for (const [key, value] of Object.entries(options.local ?? {})) store.set(key, value);

  const copied: string[] = [];
  // A clipboard stub. `navigator` is a getter on Node's global in newer
  // versions, so replace the whole property rather than mutating it.
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      clipboard: {
        writeText: async (text: string) => {
          copied.push(String(text));
        },
      },
    },
  });

  const documentElement = new El('html');
  (globalThis as { window?: unknown }).window = {
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener: () => {},
  };
  (globalThis as { document?: unknown }).document = {
    createElement: (tag: string) => new El(tag),
    getElementById: element,
    addEventListener: () => {},
    documentElement,
    querySelector: (selector: string) => {
      if (options.token && selector.includes('eunoia-token')) {
        return { getAttribute: (name: string) => (name === 'content' ? options.token : null) };
      }
      return null;
    },
  };
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, String(value)),
    removeItem: (key: string) => void store.delete(key),
  };
  // Synchronous, so a render scheduled by the streaming throttle has happened by
  // the time `send()` resolves. A real browser coalesces; this double only has
  // to preserve ordering.
  (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = (
    callback: (time: number) => void,
  ) => {
    callback(0);
    return 1;
  };
  (globalThis as { fetch?: unknown }).fetch = async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const contentType = String(headers['Content-Type'] ?? headers['content-type'] ?? '');
    // An upload's body is a File, not JSON; only parse what claims to be JSON.
    let body: Record<string, unknown> | null = null;
    if (typeof init?.body === 'string' && /json/i.test(contentType)) {
      body = JSON.parse(init.body) as Record<string, unknown>;
    }
    requests.push({ url, method, body, headers });

    // The stream the turn is read from, for whatever asked for the chat route.
    if (url === '/api/chat') {
      const frames = options.frames ?? [];
      const raw = options.rawFrames;
      const delay = options.frameDelayMs ?? 0;
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        body: new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            const send = (type: string, frame: Frame) => {
              controller.enqueue(
                encoder.encode(`event: ${type}\ndata: ${JSON.stringify(frame)}\n\n`),
              );
            };
            if (raw !== undefined) {
              const rawSend = () => {
                controller.enqueue(encoder.encode(raw));
                controller.close();
              };
              if (delay > 0) setTimeout(rawSend, delay);
              else rawSend();
              return;
            }
            if (delay <= 0) {
              for (const frame of frames) send(String(frame.type), frame);
              controller.close();
              return;
            }
            if (frames.length === 0) {
              controller.close();
              return;
            }
            frames.forEach((frame, index) => {
              setTimeout(() => {
                send(String(frame.type), frame);
                if (index === frames.length - 1) controller.close();
              }, delay * (index + 1));
            });
          },
        }),
      };
    }

    const route = routes[`${method} ${url}`];
    if (route?.stream) {
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        body: new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            for (const frame of route.stream ?? []) {
              controller.enqueue(
                encoder.encode(`event: ${String(frame.type)}\ndata: ${JSON.stringify(frame)}\n\n`),
              );
            }
            controller.close();
          },
        }),
      };
    }
    const status = route?.status ?? 200;
    const payload = route?.json ?? {};
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
      body: null,
    };
  };

  new Function(source)();

  const settle = (): Promise<void> =>
    new Promise((resolve) => {
      setTimeout(resolve, 20);
    });

  const harness: Harness = {
    transcript: element('transcript'),
    element,
    store,
    requests,
    copied,
    settle,
    async send(text: string) {
      element('input').value = text;
      const submit = element('composer').listeners.submit?.[0];
      if (!submit) throw new Error('the composer no longer listens for submit');
      submit({ preventDefault() {} });
      // The handler fires `send()` without awaiting it, so the turn has to be
      // given a chance to drain. The stream above is synchronous, so one tick is
      // enough.
      await settle();
    },
  };

  // The module restores the remembered conversation without being asked; give
  // that fetch a chance to land before the test inspects the transcript.
  await settle();
  return harness;
}

