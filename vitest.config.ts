import { defineConfig } from 'vitest/config';
import * as path from 'path';

// `vscode` is not importable outside the extension host, so tests alias it to a mock.
export default defineConfig({
  resolve: {
    alias: {
      vscode: path.resolve(__dirname, 'test/mocks/vscode.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.{test,spec}.ts'],
    coverage: {
      provider: 'v8',
      // Scope coverage to unit-testable core logic. I/O/glue (host wiring,
      // provider network streams, vscode wrappers, type-only modules) is
      // verified via typecheck + manual smoke, not unit tests.
      include: [
        'src/core/**/*.ts',
        'src/providers/keyPool.ts',
        'src/providers/openaiCompatible.ts',
        'src/providers/anthropic.ts',
        'src/providers/gemini.ts',
        'src/prompts/**/*.ts',
        'src/session/**/*.ts',
        'src/secrets.ts',
        'src/editUtils.ts',
        'src/diffUtils.ts',
      ],
      exclude: ['src/**/*.d.ts'],
      reporter: ['text', 'summary'],
    },
  },
});
