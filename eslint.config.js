import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'web/**', 'coverage/**'],
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
