import { defineConfig, type UserConfig } from 'tsdown'

/** Build emitted TypeScript entries into stable ESM package files. */
export function nodeLibrary(entries: readonly string[]): ReturnType<typeof defineConfig> {
  return defineConfig(entries.map((entry): UserConfig => ({
    entry: [entry],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  })))
}
