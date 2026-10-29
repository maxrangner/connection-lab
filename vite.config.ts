import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
  },
});
