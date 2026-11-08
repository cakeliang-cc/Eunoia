import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // `reference/` is vendored study material (a clone of an unrelated project),
    // not source this repository maintains. Linting it produced 339 errors and
    // zero signal, which is how a lint gate stops being run.
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      'reference/**',
      // Local study notes and their one-off experiment scripts are not product
      // source. They are gitignored, but ESLint reads the working tree, and
      // linting them reports missing Node globals rather than a defect.
      'docs/myfree/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // The browser client is a plain ES module served as-is. It used to be inline
    // in index.html, which meant 2,700 lines of JavaScript that no linter or
    // compiler ever saw.
    files: ['web/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        window: 'readonly',
        document: 'readonly',
        localStorage: 'readonly',
        fetch: 'readonly',
        requestAnimationFrame: 'readonly',
        TextDecoder: 'readonly',
        AbortController: 'readonly',
        crypto: 'readonly',
        navigator: 'readonly',
        Blob: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        console: 'readonly',
        URL: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
    },
  },
  {
    rules: {
      // The architecture guards in tests/ read sources as text and match against
      // `any`-shaped SDK values; explicit `any` there is intentional.
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    // Type-aware rules need the project graph. Only the two that catch a bug
    // class the non-typed config cannot see are enabled, as warnings: there are
    // `void promise` call sites whose intent has to be reviewed one at a time,
    // not turned into a 200-error lint gate nobody runs.
    files: ['src/**/*.ts', 'tests/**/*.ts', 'scripts/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-misused-promises': 'warn',
    },
  },
);
