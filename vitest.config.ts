import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // The default 5s is too short for a live model turn; the smoke test sets its
    // own timeout and this keeps the rest of the suite honest.
    testTimeout: 10_000,
    environment: 'node',
    coverage: {
      provider: 'v8',
      // `web/app.js` is executed through `new Function` by the DOM harness, so
      // V8 sees it as unevaluated source; a 0% there would be a measurement
      // artefact, not a coverage fact.
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts'],
      reporter: ['text-summary'],
      // A floor, not a target: below this, a change has removed more tests than
      // it added. Raise it deliberately when a module earns it.
      thresholds: {
        statements: 70,
        branches: 60,
        functions: 70,
        lines: 70,
      },
    },
  },
});
