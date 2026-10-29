import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  // The simulation core must stay headless and deterministic.
  {
    files: ['src/sim/**/*.ts'],
    languageOptions: { globals: {} },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['**/ui/**', 'gsap', 'gsap/*'], message: 'src/sim must not depend on the UI.' },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'window', message: 'src/sim is headless.' },
        { name: 'document', message: 'src/sim is headless.' },
        { name: 'Date', message: 'Sim time comes from the Simulator clock, not Date.' },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'Use the seeded Rng in src/sim/core/Rng.ts.' },
      ],
    },
  },
  { files: ['scripts/**/*.{js,mjs,ts}', 'vite.config.ts'], languageOptions: { globals: { ...globals.node } } },
  prettier,
);
