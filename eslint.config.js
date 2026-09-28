import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // `reference/` is vendored study material (a clone of an unrelated project),
    // not source this repository maintains. Linting it produced 339 errors and
    // zero signal, which is how a lint gate stops being run.
    ignores: ['dist/**', 'node_modules/**', 'web/**', 'coverage/**', 'reference/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // The architecture guards in tests/ read sources as text and match against
      // `any`-shaped SDK values; explicit `any` there is intentional.
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
);
