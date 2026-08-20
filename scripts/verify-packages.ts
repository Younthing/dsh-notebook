/** Verify every publishable workspace from the exact npm tarball inventory. */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

interface Manifest {
  readonly name: string
  readonly version: string
  readonly private?: boolean
  readonly license?: string
  readonly publishConfig?: { readonly access?: string }
  readonly repository?: { readonly url?: string; readonly directory?: string }
  readonly exports?: Readonly<Record<string, { readonly default?: string }>>
  readonly dsh?: {
    readonly bundle?: { readonly patch?: string }
    readonly client?: { readonly platform?: string }
  }
}

interface PackEntry {
  readonly files: readonly { readonly path: string }[]
}

const packageDirectories = [
  'client-ui-notebook',
  'notebook',
  'notebook-core',
  'notebook-environment',
  'notebook-environment-uv',
  'notebook-kernel-jupyter',
  'notebook-remote',
  'tool-notebook',
] as const

let version: string | undefined
for (const directory of packageDirectories) {
  const root = resolve('packages', directory)
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as Manifest
  if (manifest.private === true) throw new Error(`${manifest.name}: publishable package is private`)
  if (manifest.license !== 'MIT') throw new Error(`${manifest.name}: license must be MIT`)
  if (manifest.publishConfig?.access !== 'public') throw new Error(`${manifest.name}: publishConfig.access must be public`)
  if (manifest.repository?.url !== 'git+https://github.com/Younthing/dsh-notebook.git') {
    throw new Error(`${manifest.name}: repository URL does not point to dsh-notebook`)
  }
  if (manifest.repository.directory !== `packages/${directory}`) {
    throw new Error(`${manifest.name}: repository.directory does not match its workspace`)
  }
  version ??= manifest.version
  if (manifest.version !== version) throw new Error(`${manifest.name}: version differs from ${version}`)
  if (manifest.name === '@younthing/dsh-notebook') {
    if (manifest.dsh?.bundle?.patch !== './cordis.patch.yml') {
      throw new Error(`${manifest.name}: install bundle declaration is missing`)
    }
  } else if (manifest.dsh?.bundle !== undefined) {
    throw new Error(`${manifest.name}: only the user-facing package may declare a bundle`)
  }
  if (manifest.name === '@younthing/dsh-client-ui-notebook') {
    if (manifest.exports?.['./client']?.default !== './lib/client.cjs') {
      throw new Error(`${manifest.name}: client export must point to ./lib/client.cjs`)
    }
    if (manifest.dsh?.client?.platform !== 'web') {
      throw new Error(`${manifest.name}: dsh.client must declare the web platform`)
    }
  }

  const output = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
  const packed = (JSON.parse(output) as readonly PackEntry[])[0]
  if (packed === undefined) throw new Error(`${manifest.name}: npm returned no pack inventory`)
  const files = new Set(packed.files.map(file => file.path.replaceAll('\\', '/')))
  for (const required of ['package.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    if (!files.has(required)) throw new Error(`${manifest.name}: tarball omits ${required}`)
  }
  if (manifest.name === '@younthing/dsh-notebook' && !files.has('cordis.patch.yml')) {
    throw new Error(`${manifest.name}: tarball omits cordis.patch.yml`)
  }
  if (manifest.name === '@younthing/dsh-client-ui-notebook' && !files.has('lib/client.cjs')) {
    throw new Error(`${manifest.name}: tarball omits lib/client.cjs`)
  }
}

process.stdout.write(`verified ${String(packageDirectories.length)} public packages at ${version}\n`)
