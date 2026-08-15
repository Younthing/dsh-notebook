import { defineConfig } from 'tsdown'

/**
 * Build all Host package entries.
 *
 * The Typert Remote artifacts (`lib/typert.host.*` and `lib/typert.remote-client.*`
 * in `@younthing/dsh-notebook-remote`) are committed generated output. The
 * rc.6 `@deepseek-ai/dsh-typert-generator` only recognizes the `@Remote`
 * decorator when `@deepseek-ai/dsh-typert-protocol` is a sibling workspace
 * package (the Harness monorepo layout), so it cannot regenerate them from the
 * published dependency, so this repository retains generated rc.6-compatible
 * Remote artifacts.
 */
export default defineConfig({
  workspace: ['packages/*'],
  entry: ['lib/types/{index,invariant}.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
