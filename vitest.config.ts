import { defineConfig } from 'vitest/config';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@orcha/domain': resolve(__dirname, 'src/domain/index.ts'),
      '@orcha/db': resolve(__dirname, 'src/db/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/terminal/__integration__/**/*.test.ts'],
    setupFiles: ['src/test-setup.ts'],
    passWithNoTests: true,
    testTimeout: 30000,
  },
});
