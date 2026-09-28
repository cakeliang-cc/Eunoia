import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // The default 5s is too short for a live model turn; the smoke test sets its
    // own timeout and this keeps the rest of the suite honest.
    testTimeout: 10_000,
    environment: 'node',
  },
});
