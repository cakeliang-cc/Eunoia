/**
 * The transcript renders the model's Markdown subset.
 *
 * The model writes `**bold**`, inline code and fenced blocks; before this it
 * reached the page as literal asterisks and backticks. What is checked here is
 * the boundary: the subset renders, the user's own text does not, and nothing
 * model-authored can become markup.
 */

import { describe, expect, it } from 'vitest';

import { boot, El, type Frame } from './harness.ts';

async function reply(frames: Frame[]): Promise<El> {
  const harness = await boot({ frames });
  await harness.send('说说看。');
  const turn = harness.transcript.find((node) => node.classList.contains('assistant')).at(-1);
  return turn?.child('bubble')?.child('text') as El;
}

describe('markdown in the transcript', () => {
  it('renders bold and inline code instead of the markers', async () => {
    const body = await reply([
      { type: 'text_delta', text: '**重点** 是 `read` 这个工具。' },
      { type: 'completed', text: '**重点** 是 `read` 这个工具。' },
    ]);

    expect(body.textContent).toContain('重点');
    expect(body.textContent).toContain('read');
    expect(body.textContent).not.toContain('**');
    expect(body.textContent).not.toContain('`');

    expect(body.find((node) => node.tagName === 'strong')).toHaveLength(1);
    expect(body.find((node) => node.tagName === 'code')).toHaveLength(1);
  });

  it('renders fenced code as a pre block, without the fence', async () => {
    const body = await reply([
      { type: 'text_delta', text: '看这里：\n```ts\nconst a = 1;\n```\n完。' },
      { type: 'completed', text: '看这里：\n```ts\nconst a = 1;\n```\n完。' },
    ]);

    const pre = body.find((node) => node.tagName === 'pre');
    expect(pre).toHaveLength(1);
    expect(pre[0]?.children[0]?.textContent).toBe('const a = 1;');
    expect(body.textContent).toContain('看这里');
    expect(body.textContent).not.toContain('```');
  });

  it('leaves an unclosed fence as text while the stream is still arriving', async () => {
    const body = await reply([
      { type: 'text_delta', text: '正在写：\n```ts\nconst a = 1;' },
      { type: 'completed', text: '正在写：\n```ts\nconst a = 1;' },
    ]);

    expect(body.find((node) => node.tagName === 'pre')).toHaveLength(0);
    expect(body.textContent).toContain('```');
    expect(body.textContent).toContain('const a = 1;');
  });

  it('keeps the user’s own text literal', async () => {
    const harness = await boot({ frames: [] });
    await harness.send('我想说 **加粗** 和 `反引号`。');

    const user = harness.transcript.find((node) => node.classList.contains('user')).at(-1);
    const body = user?.child('bubble')?.child('text') as El;
    expect(body.textContent).toContain('**加粗**');
    expect(body.find((node) => node.tagName === 'strong')).toHaveLength(0);
  });

  it('never turns model text into markup', async () => {
    const body = await reply([
      { type: 'text_delta', text: '<img src=x onerror=alert(1)> **ok**' },
      { type: 'completed', text: '<img src=x onerror=alert(1)> **ok**' },
    ]);

    expect(body.find((node) => node.tagName === 'img')).toHaveLength(0);
    expect(body.textContent).toContain('<img');
    expect(body.find((node) => node.tagName === 'strong')).toHaveLength(1);
  });
});
