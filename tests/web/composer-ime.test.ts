import { describe, expect, it, vi } from 'vitest';
import { boot, type El } from './harness.ts';

function fire(element: El, type: string, event: Record<string, unknown> = {}): void {
  for (const listener of element.listeners[type] ?? []) listener(event);
}

async function composer() {
  const harness = await boot();
  const input = harness.element('input');
  input.value = 'zhong';
  const submit = vi.spyOn(harness.element('composer'), 'requestSubmit');
  return { input, submit };
}

function enter(overrides: Record<string, unknown> = {}) {
  return { key: 'Enter', keyCode: 13, isComposing: false, shiftKey: false, preventDefault: vi.fn(), ...overrides };
}

describe('composer IME confirmation', () => {
  it('leaves Enter to the IME when the browser reports active composition', async () => {
    const { input, submit } = await composer();
    const event = enter({ isComposing: true });
    fire(input, 'keydown', event);
    expect(submit).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('tracks composition when an Enter event omits the composing flag', async () => {
    const { input, submit } = await composer();
    fire(input, 'compositionstart');
    const event = enter();
    fire(input, 'keydown', event);
    expect(submit).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('accepts the legacy IME marker even if compositionend arrives before keydown', async () => {
    const { input, submit } = await composer();
    fire(input, 'compositionstart');
    fire(input, 'compositionend');
    const event = enter({ keyCode: 229 });
    fire(input, 'keydown', event);
    expect(submit).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('sends on the next normal Enter after composition is committed, without a cooldown', async () => {
    const { input, submit } = await composer();
    fire(input, 'compositionstart');
    fire(input, 'keydown', enter({ isComposing: true }));
    fire(input, 'compositionend');
    input.value = '中';
    const event = enter();
    fire(input, 'keydown', event);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it('preserves Shift+Enter for a newline', async () => {
    const { input, submit } = await composer();
    fire(input, 'compositionstart');
    fire(input, 'compositionend');
    const event = enter({ shiftKey: true });
    fire(input, 'keydown', event);
    expect(submit).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('still sends plain text on ordinary Enter', async () => {
    const { input, submit } = await composer();
    const event = enter();
    fire(input, 'keydown', event);
    expect(submit).toHaveBeenCalledOnce();
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });
});
