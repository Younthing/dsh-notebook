import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'
import { standardDecoratorPlugin } from './build/standard-decorators.ts'

export default defineConfig({
  plugins: [tsconfigPaths({ projects: ['./tsconfig.base.json'] }), standardDecoratorPlugin()],
  test: {
    include: ['packages/*/tests/**/*.spec.ts', 'packages/*/tests/**/*.spec.tsx'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.{ts,tsx}'],
      exclude: ['packages/*/src/**/*.d.ts'],
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100,
      },
    },
  },
})
