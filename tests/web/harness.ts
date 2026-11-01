/**
 * A hand-written DOM and fetch double for the workbench and the chat client.
 *
 * The client is one static file with no build step, so this shim exists instead
 * of jsdom: it proves event routing, ordering, classes and the requests the
 * module makes, not that a browser lays the result out the same way.
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
  title = '';
  disabled = false;
  onclick: (() => void) | null = null;

  constructor(readonly tagName = 'div') {
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
    return this.text;
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
  /** Run one turn by submitting the composer. */
  send(text: string): Promise<void>;
  /** Let queued microtasks and the module's fire-and-forget calls settle. */
  settle(): Promise<void>;
}

/**
 * Load `web/index.html`'s module against a hand-written DOM.
 *
 * The module is compiled with `new Function` rather than imported: it has no
 * imports of its own, and this keeps vitest's module pipeline out of the way of
 * a file that was never meant to go through one.
 *
 * `routes` is the fake server. Anything not routed still answers `200 {}`, so a
 * test only has to describe the requests its subject actually depends on.
 */
export async function boot(options: {
  frames?: Frame[];
  routes?: Record<string, Route>;
  stored?: string;
  /** Extra localStorage entries, written before the module runs. */
  local?: Record<string, string>;
} = {}): Promise<Harness> {
  const html = readFileSync(join(import.meta.dirname, '..', '..', 'web', 'index.html'), 'utf8');
  const source = /<script type="module">([\s\S]*?)<\/script>/.exec(html)?.[1];
  if (!source) throw new Error('web/index.html no longer contains a module script');

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

  (globalThis as { document?: unknown }).document = {
    createElement: (tag: string) => new El(tag),
    getElementById: element,
    addEventListener: () => {},
  };
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, String(value)),
    removeItem: (key: string) => void store.delete(key),
  };
  (globalThis as { fetch?: unknown }).fetch = async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    requests.push({ url, method, body });

    // The stream the turn is read from, for whatever asked for the chat route.
    if (url === '/api/chat') {
      const frames = options.frames ?? [];
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        body: new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            for (const frame of frames) {
              const type = String(frame.type);
              controller.enqueue(
                encoder.encode(`event: ${type}\ndata: ${JSON.stringify(frame)}\n\n`),
              );
            }
            controller.close();
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

