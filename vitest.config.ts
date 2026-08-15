import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'
import { standardDecoratorPlugin } from './build/standard-decorators.ts'

export default defineConfig({
  plugins: [tsconfigPaths({ projects: ['./tsconfig.base.json'] }), standardDecoratorPlugin()],
  resolve: {
    alias: [
      // Published Harness client packages expose their `/client` entries as
      // ModuleLoader handoff bundles with no ESM exports. The shims load the
      // real artifacts and re-export their factory results as importable
      // named exports (see packages/client-ui-notebook/tests/client-module-loader.ts).
      {
        find: '@deepseek-ai/dsh-client-runtime/client',
        replacement: fileURLToPath(new URL('./packages/client-ui-notebook/tests/shim-runtime-client.ts', import.meta.url)),
      },
      {
        find: '@deepseek-ai/dsh-client-locale/client',
        replacement: fileURLToPath(new URL('./packages/client-ui-notebook/tests/shim-locale-client.ts', import.meta.url)),
      },
    ],
  },
  test: {
    include: ['packages/*/tests/**/*.spec.ts', 'packages/*/tests/**/*.spec.tsx'],
    // The primitives bundle imports katex CSS; transform the chain so the
    // side-effect stylesheet import resolves instead of failing natively.
    css: true,
    server: {
      deps: {
        inline: [
          // Inlined so their internal imports route through Vite (aliases,
          // CSS, decorators) instead of Node's native loader: primitives
          // carries the katex CSS side-effect, test-runtime imports the
          // runtime client bundle that the aliases above replace.
          /@deepseek-ai\/dsh-client-ui-primitives/,
          /@deepseek-ai\/dsh-client-test-runtime/,
          /katex/,
          /shiki/,
          /@shikijs/,
        ],
      },
    },
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.{ts,tsx}'],
      exclude: ['packages/*/src/**/*.d.ts'],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 70,
        statements: 70,
      },
    },
  },
})
