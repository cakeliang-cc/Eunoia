/**
 * The transcript renders the model's Markdown subset.
 *
 * The model writes `**bold**`, inline code, fenced blocks, headings, quotes,
 * rules, tables and lists; before this they reached the page as literal
 * markers. What is checked here is the boundary: the subset renders, the
 * user's own text does not, and nothing model-authored can become markup.
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

  it('renders bullet lists instead of literal dashes', async () => {
    const body = await reply([
      {
        type: 'text_delta',
        text: '可以：\n\n- **写代码**：用 `read`\n- **记住你**：偏好\n\n结束。',
      },
      {
        type: 'completed',
        text: '可以：\n\n- **写代码**：用 `read`\n- **记住你**：偏好\n\n结束。',
      },
    ]);

    const lists = body.find((node) => node.tagName === 'ul');
    expect(lists).toHaveLength(1);
    expect(lists[0]?.find((node) => node.tagName === 'li')).toHaveLength(2);
    expect(body.textContent).toContain('写代码');
    expect(body.textContent).not.toContain('- 写代码');
    expect(lists[0]?.find((node) => node.tagName === 'strong')).toHaveLength(2);
  });

  it('renders numbered lists with their starting number', async () => {
    const body = await reply([
      { type: 'text_delta', text: '步骤：\n\n3. 先读\n4. 再改' },
      { type: 'completed', text: '步骤：\n\n3. 先读\n4. 再改' },
    ]);

    const lists = body.find((node) => node.tagName === 'ol');
    expect(lists).toHaveLength(1);
    expect(lists[0]?.attributes.start).toBe('3');
    expect(lists[0]?.find((node) => node.tagName === 'li')).toHaveLength(2);
    expect(body.textContent).toContain('先读');
  });

  it('keeps a user’s own bullet list literal', async () => {
    const harness = await boot({ frames: [] });
    await harness.send('步骤：\n- 先读\n- 再改');

    const user = harness.transcript.find((node) => node.classList.contains('user')).at(-1);
    const body = user?.child('bubble')?.child('text') as El;
    expect(body.textContent).toContain('- 先读');
    expect(body.find((node) => node.tagName === 'ul')).toHaveLength(0);
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

describe('markdown block constructs', () => {
  it('renders headings without leaking the hash markers', async () => {
    const md = '## 它是什么\n\n一句话。\n\n### 技术栈\n\n细节。';
    const body = await reply([
      { type: 'text_delta', text: md },
      { type: 'completed', text: md },
    ]);

    expect(body.find((node) => node.tagName === 'h2')).toHaveLength(1);
    expect(body.find((node) => node.tagName === 'h3')).toHaveLength(1);
    expect(body.textContent).toContain('它是什么');
    expect(body.textContent).toContain('技术栈');
    expect(body.textContent).not.toContain('##');
  });

  it('keeps a hash that belongs to the heading text', async () => {
    const body = await reply([
      { type: 'text_delta', text: '## C# 与 Node' },
      { type: 'completed', text: '## C# 与 Node' },
    ]);

    const heading = body.find((node) => node.tagName === 'h2')[0];
    expect(heading?.textContent).toBe('C# 与 Node');
  });

  it('renders a horizontal rule instead of three dashes', async () => {
    const md = '上面。\n\n---\n\n下面。';
    const body = await reply([
      { type: 'text_delta', text: md },
      { type: 'completed', text: md },
    ]);

    expect(body.find((node) => node.tagName === 'hr')).toHaveLength(1);
    expect(body.textContent).toContain('上面。');
    expect(body.textContent).toContain('下面。');
    expect(body.textContent).not.toContain('---');
  });

  it('renders blockquotes, including their inline emphasis', async () => {
    const md = '> **每一个功能** 都是被失效驱动出来的。\n> 第二条。\n\n正文。';
    const body = await reply([
      { type: 'text_delta', text: md },
      { type: 'completed', text: md },
    ]);

    const quote = body.find((node) => node.tagName === 'blockquote');
    expect(quote).toHaveLength(1);
    expect(quote[0]?.textContent).toContain('每一个功能');
    expect(quote[0]?.find((node) => node.tagName === 'strong')).toHaveLength(1);
    expect(body.textContent).not.toContain('>');
  });

  it('renders a table with a header, rows and wrapped cells', async () => {
    const md = [
      '| 层 | 作用域 | 关键规则 |',
      '| --- | --- | --- |',
      '| working | 单会话 | 进程内 |',
      '| semantic | 长期 | **可更新** |',
    ].join('\n');
    const body = await reply([
      { type: 'text_delta', text: md },
      { type: 'completed', text: md },
    ]);

    const table = body.find((node) => node.tagName === 'table');
    expect(table).toHaveLength(1);
    expect(table[0]?.find((node) => node.tagName === 'th')).toHaveLength(3);
    expect(table[0]?.find((node) => node.tagName === 'td')).toHaveLength(6);
    expect(table[0]?.find((node) => node.tagName === 'tr')).toHaveLength(3);
    expect(body.find((node) => node.classList.contains('table-wrap'))).toHaveLength(1);
    expect(body.find((node) => node.tagName === 'strong')).toHaveLength(1);
    expect(body.textContent).not.toContain('|');
  });

  it('applies the alignment of the delimiter row', async () => {
    const md = [
      '| 左 | 中 | 右 |',
      '| :--- | :---: | ---: |',
      '| a | b | c |',
    ].join('\n');
    const body = await reply([
      { type: 'text_delta', text: md },
      { type: 'completed', text: md },
    ]);

    const headers = body.find((node) => node.tagName === 'th');
    expect(headers[0]?.getAttribute('data-align')).toBe('left');
    expect(headers[1]?.getAttribute('data-align')).toBe('center');
    expect(headers[2]?.getAttribute('data-align')).toBe('right');

    const cells = body.find((node) => node.tagName === 'td');
    expect(cells[0]?.getAttribute('data-align')).toBe('left');
    expect(cells[1]?.getAttribute('data-align')).toBe('center');
    expect(cells[2]?.getAttribute('data-align')).toBe('right');
  });

  it('keeps raw HTML in a table cell as text', async () => {
    const md = [
      '| 内容 | 状态 |',
      '| --- | --- |',
      '| <img src=x onerror=alert(1)> | **ok** |',
    ].join('\n');
    const body = await reply([
      { type: 'text_delta', text: md },
      { type: 'completed', text: md },
    ]);

    expect(body.find((node) => node.tagName === 'img')).toHaveLength(0);
    expect(body.textContent).toContain('<img');
    expect(body.find((node) => node.tagName === 'strong')).toHaveLength(1);
  });

  it('does not eat a literal pipe inside inline code', async () => {
    const md = [
      '| 写法 | 说明 |',
      '| --- | --- |',
      '| `a \\| b` | 管道 |',
    ].join('\n');
    const body = await reply([
      { type: 'text_delta', text: md },
      { type: 'completed', text: md },
    ]);

    const cells = body.find((node) => node.tagName === 'td');
    expect(cells[0]?.textContent).toBe('a | b');
    expect(cells[0]?.find((node) => node.tagName === 'code')).toHaveLength(1);
  });
});
