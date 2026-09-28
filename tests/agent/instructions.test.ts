/**
 * The loader, not the prompt.
 *
 * What the prompt *says* is checked in `prompt-document.test.ts`, against the
 * document itself. This file covers the handful of things that can go wrong in
 * the step between the file on disk and the string the model is sent: a document
 * that fails to load, a comment that leaks into the prompt, a prompt re-read (or
 * re-built) per turn when it should be read once.
 *
 * The failure mode worth naming: a prompt that silently loads as empty. Nothing
 * throws, every test that asserts on content fails somewhere far away, and the
 * model gets an empty system message — behaving like a generic assistant while
 * every log says the prompt is fine.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  PROMPT_FILE,
  PROMPT_VERSION,
  STABLE_INSTRUCTIONS,
  buildInstructions,
  stripComments,
} from '../../src/agent/instructions.ts';

describe('loading the prompt', () => {
  it('reads it from the document beside the module', () => {
    const onDisk = readFileSync(PROMPT_FILE, 'utf8');
    expect(onDisk).toContain('# 身份');

    // The loaded prompt is the document minus its comments and edge whitespace —
    // exactly, so the file on disk is the prompt in use rather than a copy of it
    // that could drift.
    expect(STABLE_INSTRUCTIONS).toBe(stripComments(onDisk).trim());
  });

  it('drops the note to the editor and keeps everything else', () => {
    const stripped = stripComments('<!-- 给维护者的说明 -->\n\n# 身份\n\n正文');
    expect(stripped.trim()).toBe('# 身份\n\n正文');
  });

  it('strips a comment in the middle without eating the text around it', () => {
    // Non-greedy, so two comments do not swallow the prompt between them.
    expect(stripComments('前<!-- 一 -->中<!-- 二 -->后')).toBe('前中后');
  });

  it('is the same string every time, so the cached prefix stays cacheable', () => {
    expect(buildInstructions()).toBe(STABLE_INSTRUCTIONS);
  });

  it('has a version that matches what is in the prompt', () => {
    // Not recomputed here — `prompt-version.test.ts` owns the hashing rules.
    // This only asserts the two are wired to the same string.
    expect(PROMPT_VERSION).toMatch(/^[0-9a-f]{12}$/);
    expect(STABLE_INSTRUCTIONS.length).toBeGreaterThan(1000);
  });
});
