/**
 * The web client's rendering of a streamed turn.
 *
 * The client is one static file with no build step (ADR 006), so this drives
 * the real module out of `web/index.html` against a hand-written DOM rather
 * than a browser. That is a deliberate trade: adding jsdom to test one file is
 * a dependency the project does not otherwise need, and the shim is small
 * enough to read in a sitting.
 *
 * What it can prove: the event routing, the ordering, the classes and data
 * attributes the stylesheet keys off. What it cannot prove: that the result
 * *looks* right, or that a browser lays it out the way it does here. A test
 * that claimed otherwise would be lying.
 *
 * The reasoning block is the reason this file exists. It is the one part of
 * the client with real state — created lazily, streamed into, closed once,
 * collapsed unless the person has taken over — and every one of those rules
 * has an observable failure: a block that never appears, one that stays open
 * forever, or one that closes twice and forgets how long it took.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// --------------------------------------------------------------- the shim ---

class El {
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

type Frame = Record<string, unknown>;

/**
 * Load `web/index.html`'s module and run one turn through it.
 *
 * The module is compiled with `new Function` rather than imported: it has no
 * imports of its own, and this keeps vitest's module pipeline out of the way of
 * a file that was never meant to go through one.
 */
async function runTurn(frames: Frame[]): Promise<El> {
  const html = readFileSync(join(import.meta.dirname, '..', '..', 'web', 'index.html'), 'utf8');
  const source = /<script type="module">([\s\S]*?)<\/script>/.exec(html)?.[1];
  if (!source) throw new Error('web/index.html no longer contains a module script');

  const byId = new Map<string, El>();
  const element = (id: string): El => {
    let node = byId.get(id);
    if (!node) byId.set(id, (node = new El()));
    return node;
  };

  (globalThis as { document?: unknown }).document = {
    createElement: (tag: string) => new El(tag),
    getElementById: element,
  };
  (globalThis as { fetch?: unknown }).fetch = async () => ({
    ok: true,
    status: 200,
    body: new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        for (const frame of frames) {
          const type = String(frame.type);
          controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify(frame)}\n\n`));
        }
        controller.close();
      },
    }),
  });

  new Function(source)();

  element('input').value = '今天什么都不想做。';
  const submit = element('composer').listeners.submit?.[0];
  if (!submit) throw new Error('the composer no longer listens for submit');
  submit({ preventDefault() {} });

  // The handler fires `send()` without awaiting it, so the turn has to be given
  // a chance to drain. The stream above is synchronous, so one tick is enough.
  await new Promise((resolve) => setTimeout(resolve, 20));
  return element('transcript');
}

/** The last turn on the transcript, and the parts of it the tests inspect. */
function lastTurn(transcript: El) {
  const turns = transcript.children.filter((node) => node.classList.contains('turn'));
  const turn = turns.at(-1);
  const bubble = turn?.child('bubble');
  return {
    turn,
    turns,
    bubble,
    thinking: bubble?.child('thinking'),
    reply: bubble?.child('text'),
    head: bubble?.child('thinking')?.child('thinking-head'),
    body: bubble?.child('thinking')?.child('thinking-body'),
  };
}

const THINKING_TURN: Frame[] = [
  { type: 'thinking_delta', text: '他说累，' },
  { type: 'thinking_delta', text: '但累可能不是重点。' },
  { type: 'thinking_done', elapsedMs: 12_400 },
  { type: 'text_delta', text: '听起来' },
  { type: 'text_delta', text: '真的很沉。' },
  { type: 'completed', text: '听起来真的很沉。', conversationId: 'c1', messageId: 'm1' },
];

// ------------------------------------------------------------------ tests ---

describe('the reasoning block', () => {
  it('streams the thinking, then closes it with how long it took', async () => {
    const { thinking, head, body } = lastTurn(await runTurn(THINKING_TURN));

    expect(body?.children[0]?.textContent).toBe('他说累，但累可能不是重点。');
    expect(head?.child('label')?.textContent).toBe('思考了 12 秒');
    expect(thinking?.dataset.state).toBe('done');
  });

  it('collapses itself when the answer starts, so the answer is what is read', async () => {
    const { thinking, head } = lastTurn(await runTurn(THINKING_TURN));

    expect(thinking?.dataset.open).toBe('false');
    expect(head?.getAttribute('aria-expanded')).toBe('false');
  });

  it('reopens when the person asks, and then stops deciding for them', async () => {
    const { thinking, head } = lastTurn(await runTurn(THINKING_TURN));

    head?.onclick?.();
    expect(thinking?.dataset.open).toBe('true');
    expect(head?.getAttribute('aria-expanded')).toBe('true');
  });

  it('shows the reasoning while it is still arriving, not only after', async () => {
    // The failure this guards is the original bug in another form: a block that
    // only appears once the turn is over is no better than no block at all.
    const { thinking, head } = lastTurn(
      await runTurn([{ type: 'thinking_delta', text: '正在想…' }]),
    );

    expect(thinking?.dataset.state).toBe('live');
    expect(thinking?.dataset.open).toBe('true');
    expect(head?.child('label')?.textContent).toBe('正在想…');
  });

  it('does not appear at all when the model did not think', async () => {
    // A turn answered directly should not grow an empty box above the reply.
    const { thinking } = lastTurn(
      await runTurn([
        { type: 'text_delta', text: '嗯。' },
        { type: 'completed', text: '嗯。', conversationId: 'c1', messageId: 'm1' },
      ]),
    );

    expect(thinking).toBeUndefined();
  });

  it('closes rather than being left live when the turn fails', async () => {
    // Reasoning that stops mid-sentence with a spinner still turning beside it
    // reads as though something is still coming. It is not.
    const { thinking, head } = lastTurn(
      await runTurn([
        { type: 'thinking_delta', text: '他说累，' },
        { type: 'error', message: 'boom', retryable: true },
      ]),
    );

    expect(thinking?.dataset.state).toBe('done');
    expect(thinking?.dataset.open).toBe('false');
    expect(head?.child('label')?.textContent).toBe('思考过程');
  });
});

describe('the reply', () => {
  it('goes into its own element, so the reasoning above it is not overwritten', async () => {
    const { reply, body } = lastTurn(await runTurn(THINKING_TURN));

    expect(reply?.textContent).toBe('听起来真的很沉。');
    expect(body?.children[0]?.textContent).toBe('他说累，但累可能不是重点。');
  });

  it('drops the typing caret once the turn is over', async () => {
    const { reply } = lastTurn(await runTurn(THINKING_TURN));

    // The attribute is what the stylesheet hangs the caret off; leaving it set
    // would leave a cursor blinking after a finished reply.
    expect(reply?.dataset.streaming).toBeUndefined();
  });

  it('replaces the waiting dots with the reasoning as soon as it arrives', async () => {
    const { bubble, thinking } = lastTurn(await runTurn(THINKING_TURN));

    expect(thinking).toBeDefined();
    expect(bubble?.find((node) => node.classList.contains('dots')).some((n) => n.isConnected)).toBe(
      false,
    );
  });
});
