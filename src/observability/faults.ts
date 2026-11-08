/**
 * Test-only fault points.
 *
 * A fault point is inert unless the process was started with an explicit
 * `EUNOIA_TEST_FAULT_POINTS` value (or the child was given one by its test
 * parent). It is deliberately not an HTTP endpoint: a production service cannot
 * be asked to crash by a request, and no model-facing tool can reach it.
 *
 * When active, the child reports `{type:'fault'}` to its parent and waits for
 * `{type:'continue'}` on the IPC channel. The parent then decides whether to
 * kill the process, which is the only way to prove crash recovery rather than
 * an in-memory exception.
 */

export interface FaultState {
  readonly [key: string]: unknown;
}

const active = new Set(
  (process.env.EUNOIA_TEST_FAULT_POINTS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean),
);

export function faultPointEnabled(point: string): boolean {
  return active.has(point);
}

/**
 * Pause at `point` until the parent releases the child.
 *
 * Returns immediately in tests that do not enable it, and in production.
 */
export async function faultPoint(point: string, state: FaultState = {}): Promise<void> {
  if (!active.has(point)) return;
  const send = (process as NodeJS.Process & { send?: (message: unknown) => boolean }).send;
  if (typeof send !== 'function') {
    throw new Error(`fault point ${point} is enabled outside an IPC child process`);
  }
  await new Promise<void>((resolve) => {
    const onMessage = (message: unknown): void => {
      if (
        typeof message === 'object' &&
        message !== null &&
        (message as { type?: unknown }).type === 'continue'
      ) {
        process.off('message', onMessage);
        resolve();
      }
    };
    process.on('message', onMessage);
    // `process.send` must be called on `process`: extracting it into a variable
    // detaches `this` and the call silently never sends.
    process.send!({ type: 'fault', point, state, pid: process.pid });
  });
}
