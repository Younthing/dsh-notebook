import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

interface RootManifest {
  readonly scripts: Readonly<Record<string, string>>
}

interface ClientManifest {
  readonly exports: Readonly<Record<string, { readonly default?: string }>>
  readonly dsh?: { readonly client?: { readonly platform?: string } }
}

describe('standalone Notebook development contract', () => {
  it('exposes one development entry that only builds and starts local watchers', async () => {
    const manifest = JSON.parse(await readFile(resolve('package.json'), 'utf8')) as RootManifest
    expect(Object.keys(manifest.scripts).filter(name => name.startsWith('dev'))).toEqual(['dev'])
    expect(manifest.scripts.dev).toBe('pnpm run build && tsx scripts/dev.ts')

    const source = await readFile(resolve('scripts/dev.ts'), 'utf8')
    expect(source).not.toContain('process.argv')
    expect([...source.matchAll(/start\('([^']+)'/g)].map(match => match[1])).toEqual([
      'watch:types',
      'watch:bundles',
    ])
  })

  it('declares the Web client handoff and complete Notebook bundle layer', async () => {
    const client = JSON.parse(
      await readFile(resolve('packages/client-ui-notebook/package.json'), 'utf8'),
    ) as ClientManifest
    expect(client.exports['./client']?.default).toBe('./lib/client.cjs')
    expect(client.dsh?.client?.platform).toBe('web')

    const patch = await readFile(resolve('packages/notebook/cordis.patch.yml'), 'utf8')
    for (const plugin of [
      'notebook-core',
      'notebook-environment-uv',
      'notebook-kernel-jupyter',
      'notebook-remote',
      'tool-notebook',
      'ui-notebook',
    ]) {
      expect(patch).toContain(`- id: ${plugin}`)
    }
  })

  it('keeps installed-DSH profile verification explicit and isolated', async () => {
    const manifest = JSON.parse(await readFile(resolve('package.json'), 'utf8')) as RootManifest
    expect(manifest.scripts['test:dsh-profile']).toBe('tsx scripts/verify-dsh-profile.ts')

    const source = await readFile(resolve('scripts/verify-dsh-profile.ts'), 'utf8')
    expect(source).toContain("mkdtempSync(join(tmpdir(), 'dsh-notebook-profile-'))")
    expect(source).toContain('DSH_HOME: isolatedHome')
    expect(source).toContain("'./packages/notebook'")
    expect(source).toContain("rmSync(isolatedHome, { recursive: true, force: true })")
  })
})
