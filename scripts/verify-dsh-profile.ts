/** Verify local bundle installation with an installed DSH and an isolated profile home. */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const repositoryRoot = resolve('.')
const isolatedHome = mkdtempSync(join(tmpdir(), 'dsh-notebook-profile-'))
const environment = { ...process.env, DSH_HOME: isolatedHome }

function dsh(args: readonly string[]): string {
  return execFileSync('dsh', [...args], {
    cwd: repositoryRoot,
    env: environment,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

const expectedEntries = [
  '# == @younthing/dsh-notebook',
  'notebook-core',
  'notebook-environment-uv',
  'notebook-kernel-jupyter',
  'notebook-remote',
  'tool-notebook',
  'ui-notebook',
] as const

try {
  dsh(['plugin', '--profile', 'web', 'add', './packages/notebook'])
  const installed = dsh(['web', '--dump-config'])
  for (const entry of expectedEntries) {
    if (!installed.includes(entry)) throw new Error(`installed profile omits ${entry}`)
  }

  dsh(['plugin', '--profile', 'web', 'remove', '@younthing/dsh-notebook'])
  const removed = dsh(['web', '--dump-config'])
  if (removed.includes('# == @younthing/dsh-notebook')) {
    throw new Error('Notebook bundle layer remains after removal')
  }
  process.stdout.write('verified Notebook install and removal in an isolated DSH profile\n')
} finally {
  rmSync(isolatedHome, { recursive: true, force: true })
}
