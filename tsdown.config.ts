import { defineConfig } from 'tsdown'
import { typertPlugin } from '@deepseek-ai/dsh-typert-generator/tsdown'

/** Build all Host package entries and generate the Notebook Remote artifacts. */
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
  plugins: [typertPlugin({ mode: 'workspace', faces: ['host'] })],
})
