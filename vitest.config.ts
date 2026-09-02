import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

const resolvePath = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolvePath('./shared'),
      '@src': resolvePath('./src'),
      '@worker': resolvePath('./worker'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    // Node by default. A test that needs a DOM opts in with a docblock at the
    // top of the file: `// @vitest-environment happy-dom`.
    environment: 'node',
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      include: ['shared/**/*.ts', 'src/**/*.ts', 'worker/**/*.ts'],
      exclude: ['**/*.d.ts', 'src/app/**'],
    },
  },
});
