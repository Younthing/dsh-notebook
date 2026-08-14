import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import z from '@deepseek-ai/schemastery'
import { NotebookEnvironmentId } from '@deepseek-ai/dsh-notebook-environment'
import UvNotebookEnvironmentManager from '@deepseek-ai/dsh-notebook-environment-uv'
import SandboxProvider, {
  type ConfinedArgv,
  type SandboxPolicy,
} from '@deepseek-ai/dsh-sandbox'
import SubprocessRuntime, {
  type SubprocessHandle,
  type SubprocessOutputReader,
  type SubprocessSpawnSpec,
  type SubprocessTerminalHandle,
  type SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { currentUvArchive, privateUvExecutable } from '../src/archive.ts'

interface FixtureSubprocessConfig {
  readonly uvExecutable: string
  readonly pythonExecutable: string
}

interface FixtureCommandResult {
  readonly stdout?: string
  readonly stderr?: string
  readonly exitCode?: number
  readonly done?: SubprocessHandle['done']
  readonly waitForExit?: SubprocessHandle['waitForExit']
  readonly beforeExit?: () => Promise<void>
}

class FixtureSandbox extends SandboxProvider {
  readonly policies: SandboxPolicy[] = []

  override confine(argv: readonly string[], _policy: SandboxPolicy): ConfinedArgv {
    this.policies.push(_policy)
    return {
      argv: [...argv],
      enforcement: 'full',
      denialSignatures: [],
      runnerFailureRules: [],
    }
  }
}

class FixtureSubprocess extends SubprocessRuntime {
  static Config: z<FixtureSubprocessConfig> = z.object({
    uvExecutable: z.string().required(),
    pythonExecutable: z.string().required(),
  })

  readonly spawns: SubprocessSpawnSpec[] = []
  readonly aliases = new Map<string, string>()
  readonly unavailable = new Set<string>()
  respond?: (spec: SubprocessSpawnSpec) => FixtureCommandResult | undefined

  constructor(ctx: Context, private readonly config: FixtureSubprocessConfig) {
    super(ctx)
  }

  override async resolveExecutable(command: string): Promise<string> {
    if (this.unavailable.has(command)) throw new Error(`fixture executable is unavailable: ${command}`)
    const alias = this.aliases.get(command)
    if (alias !== undefined) return alias
    if (command === this.config.uvExecutable || command === this.config.pythonExecutable || isAbsolute(command)) {
      return command
    }
    throw new Error(`fixture executable is unavailable: ${command}`)
  }

  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    this.spawns.push(spec)
    const custom = this.respond?.(spec)
    let stdout = custom?.stdout ?? ''
    let stderr = custom?.stderr ?? ''
    let exitCode = custom?.exitCode ?? 0
    const done = custom?.done ?? (async () => {
      if (custom !== undefined) {
        await custom.beforeExit?.()
        return { exitCode, signal: null }
      }
      const [executable, ...args] = spec.argv
      if (executable === this.config.uvExecutable && args.length === 1 && args[0] === '--version') {
        stdout = 'uv 0.11.32\n'
      } else if (executable === this.config.uvExecutable && args[0] === 'venv') {
        const target = args.at(-1)
        if (target === undefined) throw new Error('fixture venv target is missing')
        await mkdir(process.platform === 'win32' ? join(target, 'Scripts') : join(target, 'bin'), { recursive: true })
      } else if (executable === this.config.uvExecutable && args[0] === 'pip' && args[1] === 'install') {
        // The fixed uv command owns installation semantics; filesystem publication is exercised by the provider.
      } else if (executable === this.config.uvExecutable && args[0] === 'python' && args[1] === 'find') {
        stdout = `${this.config.pythonExecutable}\n`
      } else if (executable === this.config.uvExecutable && args[0] === 'python' && args[1] === 'install') {
        // Explicit Python installation is represented by the succeeding refreshed catalog.
      } else if (executable !== undefined && args[0] === '-I' && args[1] === '-c') {
        stdout = args[2]?.includes('KernelSpecManager') === true
          ? '{"ipykernel":"7.3.0","jupyter_client":"8.9.1","kernel":true}\n'
          : '3.12.9\n'
      } else {
        exitCode = 1
        stderr = 'unexpected fixture command'
      }
      return { exitCode, signal: null }
    })()
    return {
      pid: this.spawns.length,
      stdin: undefined,
      stdout: undefined,
      stderr: undefined,
      collected: {
        stdout: outputReader(() => stdout),
        stderr: outputReader(() => stderr),
      },
      done,
      terminate() {},
      waitForExit: custom?.waitForExit ?? (async () => true),
    }
  }

  override async spawnTerminal(_spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    throw new Error('terminal spawning is not used by the notebook environment provider')
  }
}

function outputReader(value: () => string): SubprocessOutputReader {
  return {
    readFrom(fromByte: number) {
      const text = value()
      return {
        text: fromByte === 0 ? text : '',
        nextOffset: Buffer.byteLength(text),
        lossy: false,
      }
    },
  }
}

interface SetupResult {
  readonly ctx: Context
  readonly sandbox: FixtureSandbox
  readonly workspaceRoot: string
  readonly dshHome: string
  readonly uvExecutable: string
  readonly pythonExecutable: string
  readonly subprocess: FixtureSubprocess
}

const contexts: Context[] = []
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

interface SetupOptions {
  readonly configureUv?: boolean
  readonly configurePython?: boolean
  readonly operationTimeoutMs?: number
  readonly minimalProviderConfig?: boolean
  readonly configuredPythonInWorkspace?: boolean
  readonly managedPython?: boolean
  readonly workspaceRoot?: string
}

async function setupLoader(options: SetupOptions = {}): Promise<SetupResult> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-notebook-environment-loader-'))
  temporaryDirectories.push(root)
  const workspaceRoot = options.workspaceRoot ?? join(root, 'workspace')
  const dshHome = join(root, 'dsh-home')
  const uvExecutable = join(root, 'tools', process.platform === 'win32' ? 'uv.exe' : 'uv')
  const pythonExecutable = options.configuredPythonInWorkspace === true
    ? workspacePython(workspaceRoot)
    : options.managedPython === true
      ? join(dshHome, 'tools', 'python', 'cpython-3.12', process.platform === 'win32' ? 'python.exe' : 'bin/python')
      : join(root, 'tools', process.platform === 'win32' ? 'python.exe' : 'python')
  await mkdir(workspaceRoot, { recursive: true })
  const configPath = join(root, 'cordis.yml')
  const config = [
    '- name: fixture:sandbox',
    '- name: fixture:subprocess',
    '  config:',
    `    uvExecutable: ${JSON.stringify(uvExecutable)}`,
    `    pythonExecutable: ${JSON.stringify(pythonExecutable)}`,
    "- name: '@deepseek-ai/dsh-notebook-environment-uv'",
    '  config:',
  ]
  if (options.minimalProviderConfig === true) {
    config.push('    maxDownloadBytes: 1048576', '    graceMs: 100', '')
  } else {
    if (options.configureUv !== false) config.push(`    uvExecutable: ${JSON.stringify(uvExecutable)}`)
    if (options.configurePython !== false) config.push(`    pythonExecutable: ${JSON.stringify(pythonExecutable)}`)
    config.push(
      `    dshHome: ${JSON.stringify(dshHome)}`,
      `    operationTimeoutMs: ${options.operationTimeoutMs ?? 30_000}`,
      '    maxOutputBytes: 65536',
      '',
    )
  }
  await writeFile(configPath, config.join('\n'))

  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = `${pathToFileURL(root).href}/`
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['fixture:sandbox', FixtureSandbox],
    ['fixture:subprocess', FixtureSubprocess],
    ['@deepseek-ai/dsh-notebook-environment-uv', UvNotebookEnvironmentManager],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      const module = modules.get(specifier)
      if (module !== undefined) return module
      throw new Error(`unexpected Loader import: ${specifier}`)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await ctx.loader.await()

  return {
    ctx,
    sandbox: ctx.sandbox as FixtureSandbox,
    workspaceRoot,
    dshHome,
    uvExecutable,
    pythonExecutable,
    subprocess: ctx.subprocess as FixtureSubprocess,
  }
}

function policy(workspaceRoot: string, mode: 'read-only' | 'workspace-write' | 'danger-full-access') {
  return { mode, workspaceRoot } as const
}

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected promise to reject')
}

function signalError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('fixture signal aborted', { cause: signal.reason })
}

async function discover(setup: SetupResult) {
  return await setup.ctx.notebookEnvironments.environmentCatalog({
    workspaceRoot: setup.workspaceRoot,
    sandboxPolicy: policy(setup.workspaceRoot, 'danger-full-access'),
    signal: new AbortController().signal,
  })
}

function workspacePython(workspaceRoot: string): string {
  return process.platform === 'win32'
    ? join(workspaceRoot, '.venv', 'Scripts', 'python.exe')
    : join(workspaceRoot, '.venv', 'bin', 'python')
}

async function createEnvironmentDirectory(path: string): Promise<void> {
  await mkdir(process.platform === 'win32' ? join(path, 'Scripts') : join(path, 'bin'), { recursive: true })
}

async function writeOwnership(path: string, environmentId: string): Promise<void> {
  await writeFile(join(path, '.dsh-notebook-environment.json'), `${JSON.stringify({
    schemaVersion: 1,
    provider: 'uv',
    environmentId,
    python: '3.12',
    dependencies: { jupyterClient: '8.9.1', ipykernel: '7.3.0' },
  }, undefined, 2)}\n`)
}

async function writeStagingOwnership(staging: string, environmentId: string): Promise<void> {
  await writeFile(`${staging}.owner.json`, `${JSON.stringify({
    schemaVersion: 1,
    provider: 'uv',
    kind: 'staging',
    environmentId,
    stagingName: staging.split(/[\\/]/).at(-1),
  }, undefined, 2)}\n`)
}

describe('uv notebook environment provider', () => {
  it('boots through a real Loader tree and atomically provisions the fixed environment', async () => {
    const setup = await setupLoader()
    const catalog = await discover(setup)

    expect(catalog.manager).toEqual({ status: 'ready', version: '0.11.32', canInstall: false })
    expect(catalog.pythons).toMatchObject([{ version: '3.12.9', source: 'configured' }])
    expect(catalog.environments).toMatchObject([{
      displayName: 'Workspace Python (.venv)',
      status: 'setup-required',
      managed: false,
    }])
    const serialized = JSON.stringify(catalog)
    expect(serialized).not.toContain(setup.workspaceRoot)
    expect(serialized).not.toContain(setup.uvExecutable)
    expect(serialized).not.toContain(setup.pythonExecutable)

    const environmentId = catalog.environments[0]!.id
    await expect(setup.ctx.notebookEnvironments.inspectExisting({
      workspaceRoot: setup.workspaceRoot,
      sandboxPolicy: policy(setup.workspaceRoot, 'danger-full-access'),
      environmentId,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ environmentId, status: 'absent', canAttach: false })

    await expect(setup.ctx.notebookEnvironments.provision({
      workspaceRoot: setup.workspaceRoot,
      sandboxPolicy: policy(setup.workspaceRoot, 'workspace-write'),
      environmentId,
      allowExisting: false,
      rebuild: false,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ id: environmentId, status: 'ready', managed: true, pythonVersion: '3.12.9' })

    const launch = await setup.ctx.notebookEnvironments.resolveLaunch({
      workspaceRoot: setup.workspaceRoot,
      sandboxPolicy: policy(setup.workspaceRoot, 'workspace-write'),
      environmentId,
      signal: new AbortController().signal,
    })
    expect(launch).toEqual({
      environmentId,
      pythonExecutable: process.platform === 'win32'
        ? join(setup.workspaceRoot, '.venv', 'Scripts', 'python.exe')
        : join(setup.workspaceRoot, '.venv', 'bin', 'python'),
      kernelName: 'python3',
    })
    expect(JSON.parse(await readFile(
      join(setup.workspaceRoot, '.venv', '.dsh-notebook-environment.json'),
      'utf8',
    ))).toMatchObject({
      schemaVersion: 1,
      provider: 'uv',
      environmentId,
      python: '3.12',
      dependencies: { jupyterClient: '8.9.1', ipykernel: '7.3.0' },
    })

    const installed = setup.subprocess.spawns.find(spawn => spawn.argv[1] === 'pip')
    expect(installed?.argv.slice(1, 8)).toEqual([
      'pip', 'install', '--python', installed?.argv[4], '--require-hashes', '--no-deps', '--only-binary',
    ])
    expect(installed?.argv).toContain(':all:')
    expect(installed?.argv).toContain('-r')
    expect(installed?.env).toMatchObject({
      UV_NO_PROJECT: '1',
      UV_NO_MODIFY_PATH: '1',
      UV_PYTHON_DOWNLOADS: 'never',
      UV_PYTHON_INSTALL_BIN: '0',
      UV_PYTHON_INSTALL_REGISTRY: '0',
    })
    expect(setup.subprocess.spawns.some(spawn => spawn.argv.includes('sync'))).toBe(false)
  })

  it('requires explicit authorization before changing an unmanaged workspace environment', async () => {
    const setup = await setupLoader()
    await mkdir(process.platform === 'win32'
      ? join(setup.workspaceRoot, '.venv', 'Scripts')
      : join(setup.workspaceRoot, '.venv', 'bin'), { recursive: true })
    const untrustedPython = workspacePython(setup.workspaceRoot)
    const catalog = await discover(setup)
    const environmentId = catalog.environments[0]!.id
    expect(setup.subprocess.spawns.some(spawn => spawn.argv[0] === untrustedPython)).toBe(false)
    await expect(setup.ctx.notebookEnvironments.inspectExisting({
      workspaceRoot: setup.workspaceRoot,
      sandboxPolicy: policy(setup.workspaceRoot, 'workspace-write'),
      environmentId,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ status: 'unmanaged', canAttach: true })
    expect(setup.subprocess.spawns.some(spawn => spawn.argv[0] === untrustedPython)).toBe(true)
    const spawnCount = setup.subprocess.spawns.length

    await expect(setup.ctx.notebookEnvironments.resolveLaunch({
      workspaceRoot: setup.workspaceRoot,
      sandboxPolicy: policy(setup.workspaceRoot, 'workspace-write'),
      environmentId,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'NOTEBOOK_ENVIRONMENT_ATTACH_REQUIRED' })

    await expect(setup.ctx.notebookEnvironments.provision({
      workspaceRoot: setup.workspaceRoot,
      sandboxPolicy: policy(setup.workspaceRoot, 'workspace-write'),
      environmentId,
      allowExisting: false,
      rebuild: false,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: 'NOTEBOOK_ENVIRONMENT_ATTACH_REQUIRED',
      category: 'permission',
      retryable: false,
    })
    await expect(readFile(join(
      setup.workspaceRoot,
      '.venv',
      '.dsh-notebook-environment.json',
    ))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(setup.subprocess.spawns.slice(spawnCount).some(spawn => spawn.argv.includes('install'))).toBe(false)
    expect(setup.subprocess.spawns.slice(spawnCount).some(spawn => spawn.argv[0] === untrustedPython)).toBe(false)

    await expect(setup.ctx.notebookEnvironments.provision({
      workspaceRoot: setup.workspaceRoot,
      sandboxPolicy: policy(setup.workspaceRoot, 'workspace-write'),
      environmentId,
      allowExisting: true,
      rebuild: false,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ id: environmentId, status: 'ready', managed: true })
    await expect(readFile(join(
      setup.workspaceRoot,
      '.venv',
      '.dsh-notebook-environment.json',
    ), 'utf8')).resolves.toContain(String(environmentId))
  })

  it('requires an explicit full-access call for managed Python installation', async () => {
    const setup = await setupLoader()
    const catalog = await discover(setup)
    const environmentId = catalog.environments[0]!.id
    const spawnCount = setup.subprocess.spawns.length

    await expect(setup.ctx.notebookEnvironments.installPython({
      workspaceRoot: setup.workspaceRoot,
      sandboxPolicy: policy(setup.workspaceRoot, 'workspace-write'),
      version: '3.12',
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: 'NOTEBOOK_ENVIRONMENT_PERMISSION_REQUIRED',
      category: 'permission',
      retryable: false,
    })
    expect(setup.subprocess.spawns).toHaveLength(spawnCount)

    await expect(setup.ctx.notebookEnvironments.resolveLaunch({
      workspaceRoot: setup.workspaceRoot,
      sandboxPolicy: policy(setup.workspaceRoot, 'danger-full-access'),
      environmentId,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'NOTEBOOK_ENVIRONMENT_BROKEN' })
  })

  it('requires separate rebuild authorization and replaces only a proven DSH-owned environment', async () => {
    const setup = await setupLoader()
    const catalog = await discover(setup)
    const environmentId = catalog.environments[0]!.id
    const environmentPath = join(setup.workspaceRoot, '.venv')
    await createEnvironmentDirectory(environmentPath)
    await writeOwnership(environmentPath, environmentId)
    await writeFile(join(environmentPath, 'old-user-visible-sentinel'), 'old environment')

    let oldEnvironmentIsBroken = true
    setup.subprocess.respond = (spec) => {
      if (spec.argv[0] === workspacePython(setup.workspaceRoot)
        && spec.argv[1] === '-I'
        && spec.argv[3]?.includes('KernelSpecManager') !== true) {
        return { stdout: oldEnvironmentIsBroken ? '3.11.9\n' : '3.12.9\n' }
      }
      if (spec.argv[0] === setup.uvExecutable && spec.argv[1] === 'venv') {
        const target = spec.argv.at(-1)!
        return {
          beforeExit: async () => {
            oldEnvironmentIsBroken = false
            await createEnvironmentDirectory(target)
          },
        }
      }
      return undefined
    }

    await expect(setup.ctx.notebookEnvironments.inspectExisting({
      workspaceRoot: setup.workspaceRoot,
      sandboxPolicy: policy(setup.workspaceRoot, 'workspace-write'),
      environmentId,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({
      status: 'broken',
      canAttach: false,
      canRebuild: true,
      pythonVersion: '3.11.9',
    })
    await expect(setup.ctx.notebookEnvironments.provision({
      workspaceRoot: setup.workspaceRoot,
      sandboxPolicy: policy(setup.workspaceRoot, 'workspace-write'),
      environmentId,
      allowExisting: false,
      rebuild: false,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: 'NOTEBOOK_ENVIRONMENT_REBUILD_REQUIRED',
      category: 'dependency',
      retryable: false,
    })
    await expect(readFile(join(environmentPath, 'old-user-visible-sentinel'), 'utf8'))
      .resolves.toBe('old environment')

    await expect(setup.ctx.notebookEnvironments.provision({
      workspaceRoot: setup.workspaceRoot,
      sandboxPolicy: policy(setup.workspaceRoot, 'workspace-write'),
      environmentId,
      allowExisting: false,
      rebuild: true,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ id: environmentId, status: 'ready', managed: true })
    await expect(readFile(join(environmentPath, 'old-user-visible-sentinel'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readdir(setup.workspaceRoot)).filter(name => name.includes('dsh-rebuild-backup'))).toEqual([])
    const retainedBackup = (await readdir(setup.workspaceRoot))
      .find(name => name.startsWith('.venv.dsh-residue-') && !name.endsWith('.owner.json'))
    if (retainedBackup === undefined) throw new Error('rebuild did not retain its previous environment')
    await expect(readFile(join(setup.workspaceRoot, retainedBackup, 'old-user-visible-sentinel'), 'utf8'))
      .resolves.toBe('old environment')
  })

  it('never treats rebuild authorization as permission to delete unmanaged or foreign content', async () => {
    const setup = await setupLoader()
    const catalog = await discover(setup)
    const environmentId = catalog.environments[0]!.id
    const environmentPath = join(setup.workspaceRoot, '.venv')
    await createEnvironmentDirectory(environmentPath)
    await writeFile(join(environmentPath, 'foreign-sentinel'), 'preserve me')

    await expect(setup.ctx.notebookEnvironments.provision({
      workspaceRoot: setup.workspaceRoot,
      sandboxPolicy: policy(setup.workspaceRoot, 'workspace-write'),
      environmentId,
      allowExisting: true,
      rebuild: true,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: 'NOTEBOOK_ENVIRONMENT_REBUILD_REQUIRED',
      category: 'permission',
    })
    await expect(readFile(join(environmentPath, 'foreign-sentinel'), 'utf8')).resolves.toBe('preserve me')

    await writeOwnership(environmentPath, 'uv:belongs-to-another-workspace')
    await expect(setup.ctx.notebookEnvironments.provision({
      workspaceRoot: setup.workspaceRoot,
      sandboxPolicy: policy(setup.workspaceRoot, 'workspace-write'),
      environmentId,
      allowExisting: false,
      rebuild: true,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'NOTEBOOK_ENVIRONMENT_BROKEN' })
    await expect(readFile(join(environmentPath, 'foreign-sentinel'), 'utf8')).resolves.toBe('preserve me')
  })

  it('recovers owned staging and rebuild residues while leaving foreign lookalikes untouched', async () => {
    const setup = await setupLoader()
    const catalog = await discover(setup)
    const environmentId = catalog.environments[0]!.id
    const ownedBackup = join(setup.workspaceRoot, '.venv.dsh-rebuild-backup-crash')
    const ownedStaging = join(setup.workspaceRoot, '.venv.dsh-staging-crash')
    const foreignStaging = join(setup.workspaceRoot, '.venv.dsh-staging-foreign')
    await createEnvironmentDirectory(ownedBackup)
    await writeOwnership(ownedBackup, environmentId)
    await writeFile(join(ownedBackup, 'restored-sentinel'), 'restore me')
    await createEnvironmentDirectory(ownedStaging)
    await writeStagingOwnership(ownedStaging, environmentId)
    await createEnvironmentDirectory(foreignStaging)
    await writeStagingOwnership(foreignStaging, 'uv:foreign')

    await expect(setup.ctx.notebookEnvironments.provision({
      workspaceRoot: setup.workspaceRoot,
      sandboxPolicy: policy(setup.workspaceRoot, 'workspace-write'),
      environmentId,
      allowExisting: false,
      rebuild: false,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ id: environmentId, status: 'ready', managed: true })

    await expect(readFile(join(setup.workspaceRoot, '.venv', 'restored-sentinel'), 'utf8')).resolves.toBe('restore me')
    await expect(readFile(`${ownedStaging}.owner.json`)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(`${foreignStaging}.owner.json`, 'utf8')).resolves.toContain('uv:foreign')
    await expect(readFile(join(foreignStaging, '.missing'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('retains a marked staging junction without traversing its external target', async () => {
    const setup = await setupLoader()
    const environmentId = (await discover(setup)).environments[0]!.id
    const external = join(setup.workspaceRoot, '..', 'external-staging-target')
    const staging = join(setup.workspaceRoot, '.venv.dsh-staging-junction')
    await mkdir(external)
    await writeFile(join(external, 'sentinel'), 'preserve')
    await symlink(external, staging, process.platform === 'win32' ? 'junction' : 'dir')
    await writeStagingOwnership(staging, environmentId)

    await expect(setup.ctx.notebookEnvironments.provision({
      workspaceRoot: setup.workspaceRoot,
      sandboxPolicy: policy(setup.workspaceRoot, 'workspace-write'),
      environmentId,
      allowExisting: false,
      rebuild: false,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ status: 'ready' })

    await expect(readFile(join(external, 'sentinel'), 'utf8')).resolves.toBe('preserve')
    await expect(readFile(staging)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(`${staging}.owner.json`)).rejects.toMatchObject({ code: 'ENOENT' })
    const residueName = (await readdir(setup.workspaceRoot))
      .find(name => name.startsWith('.venv.dsh-residue-') && !name.endsWith('.owner.json'))
    if (residueName === undefined) throw new Error('staging junction was not retained')
    expect((await lstat(join(setup.workspaceRoot, residueName))).isSymbolicLink()).toBe(true)
  })

  it('retains quarantined directories without Host or subprocess recursive deletion and ignores them on retry', async () => {
    const setup = await setupLoader()
    const environmentId = (await discover(setup)).environments[0]!.id
    const staging = join(setup.workspaceRoot, '.venv.dsh-staging-retained')
    await createEnvironmentDirectory(staging)
    await writeFile(join(staging, 'sentinel'), 'preserve')
    await writeStagingOwnership(staging, environmentId)

    await expect(setup.ctx.notebookEnvironments.provision({
      workspaceRoot: setup.workspaceRoot,
      sandboxPolicy: policy(setup.workspaceRoot, 'workspace-write'),
      environmentId,
      allowExisting: false,
      rebuild: false,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ status: 'ready' })

    const retained = (await readdir(setup.workspaceRoot))
      .filter(name => name.startsWith('.venv.dsh-residue-') && !name.endsWith('.owner.json'))
    expect(retained).toHaveLength(1)
    const [retainedName] = retained
    if (retainedName === undefined) throw new Error('staging directory was not retained')
    await expect(readFile(join(setup.workspaceRoot, retainedName, 'sentinel'), 'utf8')).resolves.toBe('preserve')
    await expect(readFile(join(setup.workspaceRoot, `${retainedName}.owner.json`), 'utf8'))
      .resolves.toContain(environmentId)
    expect(setup.subprocess.spawns.some(spec => spec.argv[0] === process.execPath)).toBe(false)

    await expect(setup.ctx.notebookEnvironments.provision({
      workspaceRoot: setup.workspaceRoot,
      sandboxPolicy: policy(setup.workspaceRoot, 'workspace-write'),
      environmentId,
      allowExisting: false,
      rebuild: false,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ status: 'ready' })
    expect((await readdir(setup.workspaceRoot))
      .filter(name => name.startsWith('.venv.dsh-residue-') && !name.endsWith('.owner.json'))).toEqual(retained)
    expect(setup.subprocess.spawns.some(spec => spec.argv[0] === process.execPath)).toBe(false)
  })

  it('retains its marked staging directory when provisioning is cancelled', async () => {
    const setup = await setupLoader()
    const catalog = await discover(setup)
    const environmentId = catalog.environments[0]!.id
    let reachedInstall!: () => void
    const installStarted = new Promise<void>((resolve) => { reachedInstall = resolve })
    setup.subprocess.respond = (spec) => {
      if (spec.argv[0] !== setup.uvExecutable || spec.argv[1] !== 'pip') return undefined
      reachedInstall()
      return {
        done: new Promise((_, reject) => {
          const signal = spec.signal
          if (signal === undefined) throw new Error('fixture command signal is missing')
          signal.addEventListener('abort', () => { reject(signalError(signal)) }, { once: true })
        }),
      }
    }
    const controller = new AbortController()
    const provisioning = setup.ctx.notebookEnvironments.provision({
      workspaceRoot: setup.workspaceRoot,
      sandboxPolicy: policy(setup.workspaceRoot, 'workspace-write'),
      environmentId,
      allowExisting: false,
      rebuild: false,
      signal: controller.signal,
    })
    await installStarted
    controller.abort(new Error('user cancelled provisioning'))

    await expect(provisioning).rejects.toThrow('user cancelled provisioning')
    expect((await readdir(setup.workspaceRoot)).filter(name => name.startsWith('.venv.dsh-staging-'))).toEqual([])
    expect((await readdir(setup.workspaceRoot))
      .filter(name => name.startsWith('.venv.dsh-residue-') && !name.endsWith('.owner.json'))).toHaveLength(1)
    await expect(readFile(join(setup.workspaceRoot, '.venv'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('discovers PATH uv and uv-managed Python without exposing either path', async () => {
    const setup = await setupLoader({ configureUv: false, configurePython: false })
    setup.subprocess.aliases.set('uv', setup.uvExecutable)

    const catalog = await discover(setup)

    expect(catalog.manager).toEqual({ status: 'ready', version: '0.11.32', canInstall: false })
    expect(catalog.pythons).toMatchObject([{ version: '3.12.9', source: 'path' }])
    expect(JSON.stringify(catalog)).not.toContain(setup.pythonExecutable)
    const pythonFinds = setup.subprocess.spawns.filter(spawn => spawn.argv.slice(1, 4).join(' ') === 'python find 3.12')
    expect(pythonFinds.map(spawn => spawn.argv[4])).toEqual(['--managed-python', '--system'])
  })

  it('never executes a workspace .venv returned by Python discovery', async () => {
    const setup = await setupLoader({ configurePython: false })
    const untrustedPython = workspacePython(setup.workspaceRoot)
    setup.subprocess.respond = spec => spec.argv[0] === setup.uvExecutable
      && spec.argv[1] === 'python' && spec.argv[2] === 'find'
      ? { stdout: `${untrustedPython}\n` }
      : undefined
    const catalog = await discover(setup)
    expect(catalog.pythons).toEqual([])
    expect(setup.subprocess.spawns.some(spawn => spawn.argv[0] === untrustedPython)).toBe(false)
    await expect(setup.ctx.notebookEnvironments.provision({
      workspaceRoot: setup.workspaceRoot,
      sandboxPolicy: policy(setup.workspaceRoot, 'workspace-write'),
      environmentId: catalog.environments[0]!.id,
      allowExisting: false,
      rebuild: false,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'NOTEBOOK_ENVIRONMENT_PYTHON_REQUIRED' })
    expect(setup.subprocess.spawns.some(spawn => spawn.argv[0] === untrustedPython)).toBe(false)

    await createEnvironmentDirectory(join(setup.workspaceRoot, '.venv'))
    await writeFile(untrustedPython, '')
    const alias = join(setup.workspaceRoot, 'python-alias')
    await symlink(join(setup.workspaceRoot, '.venv'), alias, process.platform === 'win32' ? 'junction' : 'dir')
    const aliasedPython = process.platform === 'win32'
      ? join(alias, 'Scripts', 'python.exe')
      : join(alias, 'bin', 'python')
    setup.subprocess.respond = spec => spec.argv[0] === setup.uvExecutable
      && spec.argv[1] === 'python' && spec.argv[2] === 'find'
      ? { stdout: `${aliasedPython}\n` }
      : undefined
    await expect(discover(setup)).resolves.toMatchObject({ pythons: [] })
    expect(setup.subprocess.spawns.some(spawn => spawn.argv[0] === aliasedPython)).toBe(false)
  })

  it('never executes a configured Python inside the workspace .venv during discovery', async () => {
    const setup = await setupLoader({ configuredPythonInWorkspace: true })
    const catalog = await discover(setup)
    expect(catalog.pythons).toEqual([])
    expect(setup.subprocess.spawns.some(spawn => spawn.argv[0] === setup.pythonExecutable)).toBe(false)
  })

  it('never executes PATH uv inside an unmanaged workspace .venv', async () => {
    const setup = await setupLoader({ configureUv: false, configurePython: false })
    const environmentPath = join(setup.workspaceRoot, '.venv')
    await createEnvironmentDirectory(environmentPath)
    const untrustedUv = process.platform === 'win32'
      ? join(environmentPath, 'Scripts', 'uv.exe')
      : join(environmentPath, 'bin', 'uv')
    await writeFile(untrustedUv, '')
    setup.subprocess.aliases.set('uv', untrustedUv)
    await expect(discover(setup)).resolves.toMatchObject({ manager: { status: 'missing', canInstall: true } })
    expect(setup.subprocess.spawns.some(spawn => spawn.argv[0] === untrustedUv)).toBe(false)
  })

  it('falls back to unique PATH Python entries when uv is missing', async () => {
    const setup = await setupLoader({ configureUv: false, configurePython: false })
    const commands = process.platform === 'win32' ? ['python3.12', 'python'] : ['python3.12', 'python3']
    setup.subprocess.aliases.set(commands[0]!, setup.pythonExecutable)
    setup.subprocess.aliases.set(commands[1]!, setup.pythonExecutable)

    const catalog = await discover(setup)

    expect(catalog.manager).toMatchObject({ status: 'missing', canInstall: true })
    expect(catalog.pythons).toHaveLength(1)
    expect(catalog.pythons[0]).toMatchObject({ version: '3.12.9', source: 'path' })
  })

  it('requires manager installation before provisioning when uv is missing', async () => {
    const setup = await setupLoader({ configureUv: false, configurePython: false })
    setup.subprocess.unavailable.add('uv')
    const commands = process.platform === 'win32' ? ['python3.12', 'python'] : ['python3.12', 'python3']
    for (const command of commands) setup.subprocess.unavailable.add(command)
    const environmentId = (await discover(setup)).environments[0]!.id

    await expect(setup.ctx.notebookEnvironments.provision({
      workspaceRoot: setup.workspaceRoot,
      sandboxPolicy: policy(setup.workspaceRoot, 'workspace-write'),
      environmentId,
      allowExisting: false,
      rebuild: false,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: 'NOTEBOOK_ENVIRONMENT_MANAGER_REQUIRED',
      category: 'manager',
      retryable: true,
    })
  })

  it('provisions with a Python interpreter found through uv managed discovery', async () => {
    const setup = await setupLoader({ configurePython: false })
    const environmentId = (await discover(setup)).environments[0]!.id

    await expect(setup.ctx.notebookEnvironments.provision({
      workspaceRoot: setup.workspaceRoot,
      sandboxPolicy: policy(setup.workspaceRoot, 'workspace-write'),
      environmentId,
      allowExisting: false,
      rebuild: false,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ id: environmentId, status: 'ready' })
    expect(setup.subprocess.spawns.some(spec => spec.argv.slice(1).join(' ') === 'python find 3.12 --managed-python'))
      .toBe(true)
  })

  it('labels a Python interpreter under the private tools directory as managed', async () => {
    const setup = await setupLoader({ configurePython: false, managedPython: true })

    await expect(discover(setup)).resolves.toMatchObject({
      pythons: [{ version: '3.12.9', source: 'managed' }],
    })
  })

  it('fails loud for configured uv but bypasses an unusable PATH candidate', async () => {
    const configured = await setupLoader()
    configured.subprocess.unavailable.add(configured.uvExecutable)
    configured.subprocess.unavailable.add(configured.pythonExecutable)
    await expect(discover(configured)).resolves.toMatchObject({
      manager: { status: 'broken', canInstall: false },
      pythons: [],
    })

    const path = await setupLoader({ configureUv: false, configurePython: false })
    path.subprocess.aliases.set('uv', path.uvExecutable)
    path.subprocess.respond = spec => spec.argv[0] === path.uvExecutable && spec.argv[1] === '--version'
      ? { stdout: 'not uv\n' }
      : undefined
    await expect(discover(path)).resolves.toMatchObject({
      manager: { status: 'missing', canInstall: true },
    })
  })

  it.each(['0.8.9', '0.12.0'])('bypasses incompatible PATH uv %s', async (version) => {
    const setup = await setupLoader({ configureUv: false, configurePython: false })
    setup.subprocess.aliases.set('uv', setup.uvExecutable)
    setup.subprocess.respond = spec => spec.argv[0] === setup.uvExecutable && spec.argv[1] === '--version'
      ? { stdout: `uv ${version}\n` }
      : undefined
    await expect(discover(setup)).resolves.toMatchObject({
      manager: { status: 'missing', canInstall: true },
    })
  })

  it('reports a corrupt private manager artifact as repairable but broken', async () => {
    const setup = await setupLoader({ configureUv: false, configurePython: false })
    const archive = currentUvArchive()
    expect(archive).toBeDefined()
    const executable = privateUvExecutable(setup.dshHome, archive!)
    await mkdir(join(executable, '..'), { recursive: true })
    await writeFile(executable, 'corrupt private uv')
    setup.subprocess.unavailable.add(executable)

    await expect(discover(setup)).resolves.toMatchObject({
      manager: { status: 'broken', canInstall: true },
    })
  })

  it('runs Python installation only on an explicit full-access operation', async () => {
    const setup = await setupLoader()

    const catalog = await setup.ctx.notebookEnvironments.installPython({
      workspaceRoot: setup.workspaceRoot,
      sandboxPolicy: policy(setup.workspaceRoot, 'danger-full-access'),
      version: '3.12',
      signal: new AbortController().signal,
    })

    expect(catalog.manager.status).toBe('ready')
    const install = setup.subprocess.spawns.find(spawn => spawn.argv[1] === 'python' && spawn.argv[2] === 'install')
    expect(install?.argv).toEqual([setup.uvExecutable, 'python', 'install', '3.12'])
    expect(install?.env).toMatchObject({
      UV_PYTHON_DOWNLOADS: 'manual',
      UV_PYTHON_INSTALL_BIN: '0',
      UV_PYTHON_INSTALL_REGISTRY: '0',
    })
  })

  it('rejects mismatched workspace, unknown environment, read-only mutation, and prior cancellation', async () => {
    const setup = await setupLoader()
    const catalog = await discover(setup)
    const environmentId = catalog.environments[0]!.id
    const otherRoot = join(setup.workspaceRoot, 'other')
    await mkdir(otherRoot)

    await expect(setup.ctx.notebookEnvironments.environmentCatalog({
      workspaceRoot: setup.workspaceRoot,
      sandboxPolicy: policy(otherRoot, 'danger-full-access'),
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'NOTEBOOK_ENVIRONMENT_PERMISSION_REQUIRED' })
    await expect(setup.ctx.notebookEnvironments.environmentCatalog({
      workspaceRoot: join(setup.workspaceRoot, 'missing'),
      sandboxPolicy: policy(setup.workspaceRoot, 'danger-full-access'),
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'NOTEBOOK_ENVIRONMENT_BROKEN', category: 'permission' })
    await expect(setup.ctx.notebookEnvironments.inspectExisting({
      workspaceRoot: setup.workspaceRoot,
      sandboxPolicy: policy(setup.workspaceRoot, 'danger-full-access'),
      environmentId: NotebookEnvironmentId('uv:not-this-workspace'),
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'NOTEBOOK_ENVIRONMENT_UNKNOWN' })
    await expect(setup.ctx.notebookEnvironments.provision({
      workspaceRoot: setup.workspaceRoot,
      sandboxPolicy: policy(setup.workspaceRoot, 'read-only'),
      environmentId,
      allowExisting: false,
      rebuild: false,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'NOTEBOOK_ENVIRONMENT_PERMISSION_REQUIRED' })

    const controller = new AbortController()
    controller.abort(new Error('cancelled before discovery'))
    await expect(setup.ctx.notebookEnvironments.environmentCatalog({
      workspaceRoot: setup.workspaceRoot,
      sandboxPolicy: policy(setup.workspaceRoot, 'danger-full-access'),
      signal: controller.signal,
    })).rejects.toThrow('cancelled before discovery')
  })

  it('classifies the configured operation deadline and refuses calls after disposal', async () => {
    const setup = await setupLoader({ operationTimeoutMs: 5 })
    setup.subprocess.respond = spec => spec.argv[0] === setup.uvExecutable && spec.argv[1] === '--version'
      ? {
        done: new Promise((_, reject) => {
          const signal = spec.signal
          if (signal === undefined) throw new Error('fixture command signal is missing')
          signal.addEventListener('abort', () => { reject(signalError(signal)) }, { once: true })
        }),
      }
      : undefined

    await expect(discover(setup)).rejects.toMatchObject({
      code: 'NOTEBOOK_ENVIRONMENT_TIMEOUT',
      category: 'manager',
      retryable: true,
    })

    const manager = setup.ctx.notebookEnvironments
    await setup.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(setup.ctx), 1)
    await expect(manager.environmentCatalog({
      workspaceRoot: setup.workspaceRoot,
      sandboxPolicy: policy(setup.workspaceRoot, 'danger-full-access'),
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'NOTEBOOK_ENVIRONMENT_BROKEN', category: 'manager' })
  })

  it('rebuilds an already ready owned environment only on the explicit rebuild call', async () => {
    const setup = await setupLoader()
    const environmentId = (await discover(setup)).environments[0]!.id
    await setup.ctx.notebookEnvironments.provision({
      workspaceRoot: setup.workspaceRoot,
      sandboxPolicy: policy(setup.workspaceRoot, 'workspace-write'),
      environmentId,
      allowExisting: false,
      rebuild: false,
      signal: new AbortController().signal,
    })
    await writeFile(join(setup.workspaceRoot, '.venv', 'old-sentinel'), 'old')

    await expect(setup.ctx.notebookEnvironments.provision({
      workspaceRoot: setup.workspaceRoot,
      sandboxPolicy: policy(setup.workspaceRoot, 'workspace-write'),
      environmentId,
      allowExisting: false,
      rebuild: true,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ id: environmentId, status: 'ready', managed: true })
    await expect(readFile(join(setup.workspaceRoot, '.venv', 'old-sentinel'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('classifies non-directory, malformed-sidecar, and broken-dependency environments without deleting them', async () => {
    const setup = await setupLoader()
    const environmentId = (await discover(setup)).environments[0]!.id
    const environmentPath = join(setup.workspaceRoot, '.venv')
    await writeFile(environmentPath, 'foreign file')
    await expect(setup.ctx.notebookEnvironments.inspectExisting({
      workspaceRoot: setup.workspaceRoot,
      sandboxPolicy: policy(setup.workspaceRoot, 'workspace-write'),
      environmentId,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ status: 'broken', canRebuild: false })
    await expect(readFile(environmentPath, 'utf8')).resolves.toBe('foreign file')

    await rm(environmentPath)
    await createEnvironmentDirectory(environmentPath)
    await writeFile(join(environmentPath, '.dsh-notebook-environment.json'), '{not json')
    await expect(setup.ctx.notebookEnvironments.inspectExisting({
      workspaceRoot: setup.workspaceRoot,
      sandboxPolicy: policy(setup.workspaceRoot, 'workspace-write'),
      environmentId,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ status: 'broken', canRebuild: false })

    await rm(join(environmentPath, '.dsh-notebook-environment.json'))
    await mkdir(join(environmentPath, '.dsh-notebook-environment.json'))
    await expect(setup.ctx.notebookEnvironments.inspectExisting({
      workspaceRoot: setup.workspaceRoot,
      sandboxPolicy: policy(setup.workspaceRoot, 'workspace-write'),
      environmentId,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ status: 'broken', canRebuild: false })

    await rm(join(environmentPath, '.dsh-notebook-environment.json'), { recursive: true })
    await writeOwnership(environmentPath, environmentId)
    setup.subprocess.respond = spec => spec.argv[3]?.includes('KernelSpecManager') === true
      ? { stdout: 'not json\n' }
      : undefined
    await expect(setup.ctx.notebookEnvironments.resolveLaunch({
      workspaceRoot: setup.workspaceRoot,
      sandboxPolicy: policy(setup.workspaceRoot, 'workspace-write'),
      environmentId,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: 'NOTEBOOK_ENVIRONMENT_DEPENDENCY_FAILED',
      category: 'dependency',
      retryable: true,
    })
    await expect(setup.ctx.notebookEnvironments.provision({
      workspaceRoot: setup.workspaceRoot,
      sandboxPolicy: policy(setup.workspaceRoot, 'workspace-write'),
      environmentId,
      allowExisting: false,
      rebuild: false,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: 'NOTEBOOK_ENVIRONMENT_DEPENDENCY_FAILED',
      retryable: false,
    })

    setup.subprocess.respond = spec => spec.argv[3]?.includes('KernelSpecManager') === true
      ? { stdout: '{"ipykernel":"0","jupyter_client":"8.9.1","kernel":true}\n' }
      : undefined
    await expect(setup.ctx.notebookEnvironments.provision({
      workspaceRoot: setup.workspaceRoot,
      sandboxPolicy: policy(setup.workspaceRoot, 'workspace-write'),
      environmentId,
      allowExisting: false,
      rebuild: false,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: 'NOTEBOOK_ENVIRONMENT_KERNELSPEC_MISSING',
      category: 'kernelspec',
      retryable: true,
    })
  })

  it('requires a real Python 3.12 interpreter before creating a workspace environment', async () => {
    const configured = await setupLoader()
    const configuredId = (await discover(configured)).environments[0]!.id
    configured.subprocess.respond = spec => spec.argv[0] === configured.pythonExecutable
      && spec.argv[1] === '-I'
      ? { stdout: '3.11.9\n' }
      : undefined
    await expect(configured.ctx.notebookEnvironments.provision({
      workspaceRoot: configured.workspaceRoot,
      sandboxPolicy: policy(configured.workspaceRoot, 'workspace-write'),
      environmentId: configuredId,
      allowExisting: false,
      rebuild: false,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'NOTEBOOK_ENVIRONMENT_PYTHON_REQUIRED', retryable: false })

    configured.subprocess.unavailable.add(configured.pythonExecutable)
    await expect(configured.ctx.notebookEnvironments.provision({
      workspaceRoot: configured.workspaceRoot,
      sandboxPolicy: policy(configured.workspaceRoot, 'workspace-write'),
      environmentId: configuredId,
      allowExisting: false,
      rebuild: false,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'NOTEBOOK_ENVIRONMENT_PYTHON_REQUIRED', retryable: false })

    const discovered = await setupLoader({ configurePython: false })
    const discoveredId = (await discover(discovered)).environments[0]!.id
    discovered.subprocess.respond = spec => spec.argv[0] === discovered.uvExecutable
      && spec.argv[1] === 'python'
      && spec.argv[2] === 'find'
      ? { stdout: 'relative-python\n' }
      : undefined
    await expect(discovered.ctx.notebookEnvironments.provision({
      workspaceRoot: discovered.workspaceRoot,
      sandboxPolicy: policy(discovered.workspaceRoot, 'workspace-write'),
      environmentId: discoveredId,
      allowExisting: false,
      rebuild: false,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'NOTEBOOK_ENVIRONMENT_PYTHON_REQUIRED', retryable: false })
  })

  it('reports an explicitly inspected unmanaged Python 3.11 environment as broken', async () => {
    const setup = await setupLoader()
    const environmentId = (await discover(setup)).environments[0]!.id
    await createEnvironmentDirectory(join(setup.workspaceRoot, '.venv'))
    setup.subprocess.respond = spec => spec.argv[0] === workspacePython(setup.workspaceRoot)
      && spec.argv[1] === '-I'
      ? { stdout: '3.11.9\n' }
      : undefined

    await expect(setup.ctx.notebookEnvironments.inspectExisting({
      workspaceRoot: setup.workspaceRoot,
      sandboxPolicy: policy(setup.workspaceRoot, 'workspace-write'),
      environmentId,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({
      status: 'broken',
      pythonVersion: '3.11.9',
      canAttach: false,
      canRebuild: false,
      message: 'The workspace .venv must use Python 3.12.',
    })

    setup.subprocess.respond = spec => spec.argv[0] === workspacePython(setup.workspaceRoot)
      && spec.argv[1] === '-I'
      ? { exitCode: 1 }
      : undefined
    await expect(setup.ctx.notebookEnvironments.inspectExisting({
      workspaceRoot: setup.workspaceRoot,
      sandboxPolicy: policy(setup.workspaceRoot, 'workspace-write'),
      environmentId,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ status: 'broken', canAttach: false, canRebuild: false })
  })

  it('reports concurrent provisioning before a second operation can touch the lock', async () => {
    const setup = await setupLoader()
    const environmentId = (await discover(setup)).environments[0]!.id
    let releaseVenv!: () => Promise<void>
    let reachedVenv!: () => void
    const venvStarted = new Promise<void>((resolve) => { reachedVenv = resolve })
    setup.subprocess.respond = (spec) => {
      if (spec.argv[0] !== setup.uvExecutable || spec.argv[1] !== 'venv') return undefined
      const target = spec.argv.at(-1)!
      let resolveDone!: (outcome: { exitCode: number; signal: null }) => void
      const done = new Promise<{ exitCode: number; signal: null }>((resolve) => { resolveDone = resolve })
      releaseVenv = async () => {
        await createEnvironmentDirectory(target)
        resolveDone({ exitCode: 0, signal: null })
      }
      reachedVenv()
      return { done }
    }
    const first = setup.ctx.notebookEnvironments.provision({
      workspaceRoot: setup.workspaceRoot,
      sandboxPolicy: policy(setup.workspaceRoot, 'workspace-write'),
      environmentId,
      allowExisting: false,
      rebuild: false,
      signal: new AbortController().signal,
    })
    await venvStarted
    await expect(discover(setup)).resolves.toMatchObject({
      environments: [{ status: 'provisioning' }],
    })
    await expect(setup.ctx.notebookEnvironments.provision({
      workspaceRoot: setup.workspaceRoot,
      sandboxPolicy: policy(setup.workspaceRoot, 'workspace-write'),
      environmentId,
      allowExisting: false,
      rebuild: false,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'NOTEBOOK_ENVIRONMENT_BUSY', retryable: true })
    await releaseVenv()
    await expect(first).resolves.toMatchObject({ status: 'ready' })
  })

  it('recovers a lock left by a crashed manager but preserves an unverifiable lock', async () => {
    const stale = await setupLoader()
    const staleEnvironmentId = (await discover(stale)).environments[0]!.id
    const staleLock = join(stale.workspaceRoot, '.dsh-notebook-environment.lock')
    await writeFile(staleLock, `${JSON.stringify({
      schemaVersion: 1,
      ownerId: 'crashed-manager',
      nonce: 'stale-nonce',
      pid: process.pid,
      processStartedAtMs: 1,
    })}\n`)
    await expect(stale.ctx.notebookEnvironments.provision({
      workspaceRoot: stale.workspaceRoot,
      sandboxPolicy: policy(stale.workspaceRoot, 'workspace-write'),
      environmentId: staleEnvironmentId,
      allowExisting: false,
      rebuild: false,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ status: 'ready' })
    await expect(readFile(staleLock)).rejects.toMatchObject({ code: 'ENOENT' })

    const foreign = await setupLoader()
    const foreignEnvironmentId = (await discover(foreign)).environments[0]!.id
    const foreignLock = join(foreign.workspaceRoot, '.dsh-notebook-environment.lock')
    await writeFile(foreignLock, '{}\n')
    await expect(foreign.ctx.notebookEnvironments.provision({
      workspaceRoot: foreign.workspaceRoot,
      sandboxPolicy: policy(foreign.workspaceRoot, 'workspace-write'),
      environmentId: foreignEnvironmentId,
      allowExisting: false,
      rebuild: false,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'NOTEBOOK_ENVIRONMENT_BUSY', retryable: true })
    await expect(readFile(foreignLock, 'utf8')).resolves.toBe('{}\n')
  })

  it('distinguishes active, disposed, and exited process lock owners', async () => {
    const first = await setupLoader()
    const environmentId = (await discover(first)).environments[0]!.id
    const lock = join(first.workspaceRoot, '.dsh-notebook-environment.lock')
    let releaseVenv!: () => Promise<void>
    let reachedVenv!: () => void
    const venvStarted = new Promise<void>((resolve) => { reachedVenv = resolve })
    first.subprocess.respond = (spec) => {
      if (spec.argv[0] !== first.uvExecutable || spec.argv[1] !== 'venv') return undefined
      const target = spec.argv.at(-1)!
      let resolveDone!: (outcome: { exitCode: number; signal: null }) => void
      const done = new Promise<{ exitCode: number; signal: null }>((resolve) => { resolveDone = resolve })
      releaseVenv = async () => {
        await createEnvironmentDirectory(target)
        resolveDone({ exitCode: 0, signal: null })
      }
      reachedVenv()
      return { done }
    }
    const firstProvision = first.ctx.notebookEnvironments.provision({
      workspaceRoot: first.workspaceRoot,
      sandboxPolicy: policy(first.workspaceRoot, 'workspace-write'),
      environmentId,
      allowExisting: false,
      rebuild: false,
      signal: new AbortController().signal,
    })
    await venvStarted
    const activeLock = await readFile(lock, 'utf8')

    const second = await setupLoader({ workspaceRoot: first.workspaceRoot })
    const secondEnvironmentId = (await discover(second)).environments[0]!.id
    await expect(second.ctx.notebookEnvironments.provision({
      workspaceRoot: second.workspaceRoot,
      sandboxPolicy: policy(second.workspaceRoot, 'workspace-write'),
      environmentId: secondEnvironmentId,
      allowExisting: false,
      rebuild: false,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'NOTEBOOK_ENVIRONMENT_BUSY' })

    await releaseVenv()
    await expect(firstProvision).resolves.toMatchObject({ status: 'ready' })
    await first.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(first.ctx), 1)
    await writeFile(lock, activeLock)
    await expect(second.ctx.notebookEnvironments.provision({
      workspaceRoot: second.workspaceRoot,
      sandboxPolicy: policy(second.workspaceRoot, 'workspace-write'),
      environmentId: secondEnvironmentId,
      allowExisting: false,
      rebuild: false,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ status: 'ready' })

    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    if (child.pid === undefined) throw new Error('lock owner fixture did not start')
    const processLock = `${JSON.stringify({
      schemaVersion: 1,
      ownerId: 'other-process',
      nonce: 'other-process-lock',
      pid: child.pid,
      processStartedAtMs: 1,
    })}\n`
    await writeFile(lock, processLock)
    try {
      await expect(second.ctx.notebookEnvironments.provision({
        workspaceRoot: second.workspaceRoot,
        sandboxPolicy: policy(second.workspaceRoot, 'workspace-write'),
        environmentId: secondEnvironmentId,
        allowExisting: false,
        rebuild: false,
        signal: new AbortController().signal,
      })).rejects.toMatchObject({ code: 'NOTEBOOK_ENVIRONMENT_BUSY' })
    } finally {
      const exited = once(child, 'exit')
      child.kill()
      await exited
    }
    await expect(second.ctx.notebookEnvironments.provision({
      workspaceRoot: second.workspaceRoot,
      sandboxPolicy: policy(second.workspaceRoot, 'workspace-write'),
      environmentId: secondEnvironmentId,
      allowExisting: false,
      rebuild: false,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ status: 'ready' })
  })

  it('wraps unknown host failures without exposing the workspace path', async () => {
    const setup = await setupLoader()
    const environmentId = (await discover(setup)).environments[0]!.id
    setup.subprocess.respond = spec => spec.argv[0] === setup.pythonExecutable
      && spec.argv[1] === '-I'
      && spec.argv[3]?.includes('KernelSpecManager') !== true
      ? {
        stdout: '3.12.9\n',
        beforeExit: async () => {
          await rm(setup.workspaceRoot, { recursive: true, force: true })
          await writeFile(setup.workspaceRoot, 'occupied by a concurrent host writer')
        },
      }
      : undefined
    const error = await setup.ctx.notebookEnvironments.provision({
      workspaceRoot: setup.workspaceRoot,
      sandboxPolicy: policy(setup.workspaceRoot, 'workspace-write'),
      environmentId,
      allowExisting: false,
      rebuild: false,
      signal: new AbortController().signal,
    }).catch((failure: unknown) => failure)
    expect(error).toMatchObject({
      code: 'NOTEBOOK_ENVIRONMENT_BROKEN',
      category: 'dependency',
    })
    expect((error as Error).message).not.toContain(setup.workspaceRoot)
  })

  it('keeps a concurrently appearing foreign .venv and retains only its own staged replacement', async () => {
    const setup = await setupLoader()
    const environmentId = (await discover(setup)).environments[0]!.id
    const environmentPath = join(setup.workspaceRoot, '.venv')
    setup.subprocess.respond = spec => spec.argv[0]?.includes('.venv.dsh-staging-') === true
      && spec.argv[3]?.includes('KernelSpecManager') === true
      ? {
        stdout: '{"ipykernel":"7.3.0","jupyter_client":"8.9.1","kernel":true}\n',
        beforeExit: async () => {
          await createEnvironmentDirectory(environmentPath)
          await writeFile(join(environmentPath, 'foreign-sentinel'), 'preserve')
        },
      }
      : undefined

    await expect(setup.ctx.notebookEnvironments.provision({
      workspaceRoot: setup.workspaceRoot,
      sandboxPolicy: policy(setup.workspaceRoot, 'workspace-write'),
      environmentId,
      allowExisting: false,
      rebuild: false,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'NOTEBOOK_ENVIRONMENT_BUSY', retryable: true })
    await expect(readFile(join(environmentPath, 'foreign-sentinel'), 'utf8')).resolves.toBe('preserve')
    expect((await readdir(setup.workspaceRoot)).filter(name => name.startsWith('.venv.dsh-staging-'))).toEqual([])
    expect((await readdir(setup.workspaceRoot))
      .filter(name => name.startsWith('.venv.dsh-residue-') && !name.endsWith('.owner.json'))).toHaveLength(1)
  })

  it('preserves publication failure when a concurrent writer removes the staging ownership marker', async () => {
    const setup = await setupLoader()
    const environmentId = (await discover(setup)).environments[0]!.id
    const environmentPath = join(setup.workspaceRoot, '.venv')
    let staging = ''
    setup.subprocess.respond = (spec) => {
      if (spec.argv[0] === setup.uvExecutable && spec.argv[1] === 'venv') {
        staging = spec.argv.at(-1)!
        return undefined
      }
      if (staging !== '' && spec.argv[0]?.startsWith(staging) === true
        && spec.argv[3]?.includes('KernelSpecManager') === true) {
        return {
          stdout: '{"ipykernel":"7.3.0","jupyter_client":"8.9.1","kernel":true}\n',
          beforeExit: async () => {
            await createEnvironmentDirectory(environmentPath)
            await rm(`${staging}.owner.json`, { force: true })
          },
        }
      }
      return undefined
    }

    const publicationError = await captureRejection(setup.ctx.notebookEnvironments.provision({
      workspaceRoot: setup.workspaceRoot,
      sandboxPolicy: policy(setup.workspaceRoot, 'workspace-write'),
      environmentId,
      allowExisting: false,
      rebuild: false,
      signal: new AbortController().signal,
    }))
    expect(publicationError).toMatchObject({ code: 'NOTEBOOK_ENVIRONMENT_BUSY' })
    expect((publicationError as { cause?: unknown }).cause).toBeInstanceOf(AggregateError)
  })

  it('refuses ambiguous crash recovery when more than one owned rebuild backup exists', async () => {
    const setup = await setupLoader()
    const environmentId = (await discover(setup)).environments[0]!.id
    for (const suffix of ['one', 'two']) {
      const backup = join(setup.workspaceRoot, `.venv.dsh-rebuild-backup-${suffix}`)
      await createEnvironmentDirectory(backup)
      await writeOwnership(backup, environmentId)
    }

    await expect(setup.ctx.notebookEnvironments.provision({
      workspaceRoot: setup.workspaceRoot,
      sandboxPolicy: policy(setup.workspaceRoot, 'workspace-write'),
      environmentId,
      allowExisting: false,
      rebuild: false,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'NOTEBOOK_ENVIRONMENT_BROKEN', retryable: false })
    expect((await readdir(setup.workspaceRoot)).filter(name => name.startsWith('.venv.dsh-rebuild-backup-')))
      .toHaveLength(2)
  })

  it('uses provider defaults without exposing discovered executable paths', async () => {
    const setup = await setupLoader({ minimalProviderConfig: true })
    setup.subprocess.unavailable.add('uv')
    const platformCommands = process.platform === 'win32' ? ['python3.12', 'python'] : ['python3.12', 'python3']
    for (const command of platformCommands) setup.subprocess.unavailable.add(command)
    const catalog = await discover(setup)
    expect(catalog).toMatchObject({
      pythons: [],
      environments: [{ status: 'setup-required' }],
    })
    expect(catalog.manager.status).toMatch(/^(missing|broken)$/)
  })

  it('materializes defaults for direct provider construction', () => {
    const ctx = new Context()
    contexts.push(ctx)
    expect(() => new UvNotebookEnvironmentManager(ctx)).not.toThrow()
  })

  it('rejects a workspace root that resolves to a file', async () => {
    const setup = await setupLoader()
    const file = join(setup.workspaceRoot, 'not-a-directory')
    await writeFile(file, 'content')
    await expect(setup.ctx.notebookEnvironments.environmentCatalog({
      workspaceRoot: file,
      sandboxPolicy: policy(file, 'danger-full-access'),
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'NOTEBOOK_ENVIRONMENT_BROKEN', category: 'permission' })
  })

  it('rejects a final environment whose dependencies changed during atomic publication', async () => {
    const setup = await setupLoader()
    const environmentId = (await discover(setup)).environments[0]!.id
    let dependencyProbes = 0
    setup.subprocess.respond = spec => spec.argv[3]?.includes('KernelSpecManager') === true
      ? {
        stdout: ++dependencyProbes === 1
          ? '{"ipykernel":"7.3.0","jupyter_client":"8.9.1","kernel":true}\n'
          : '{"ipykernel":"0","jupyter_client":"0","kernel":false}\n',
      }
      : undefined
    await expect(setup.ctx.notebookEnvironments.provision({
      workspaceRoot: setup.workspaceRoot,
      sandboxPolicy: policy(setup.workspaceRoot, 'workspace-write'),
      environmentId,
      allowExisting: false,
      rebuild: false,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'NOTEBOOK_ENVIRONMENT_DEPENDENCY_FAILED', retryable: true })
  })

  it('handles failed uv and Python probes as discovery misses', async () => {
    const uvFind = await setupLoader({ configurePython: false })
    uvFind.subprocess.respond = spec => spec.argv[0] === uvFind.uvExecutable
      && spec.argv[1] === 'python' && spec.argv[2] === 'find'
      ? { exitCode: 1 }
      : undefined
    await expect(discover(uvFind)).resolves.toMatchObject({ pythons: [] })

    const invalidPython = await setupLoader({ configureUv: false, configurePython: false })
    invalidPython.subprocess.unavailable.add('uv')
    const commands = process.platform === 'win32' ? ['python3.12', 'python'] : ['python3.12', 'python3']
    for (const command of commands) invalidPython.subprocess.aliases.set(command, invalidPython.pythonExecutable)
    invalidPython.subprocess.respond = spec => spec.argv[1] === '-I'
      ? { stdout: 'not-a-version\n' }
      : undefined
    await expect(discover(invalidPython)).resolves.toMatchObject({ pythons: [] })

    invalidPython.subprocess.respond = spec => spec.argv[1] === '-I'
      ? { exitCode: 1 }
      : undefined
    await expect(discover(invalidPython)).resolves.toMatchObject({ pythons: [] })
  })

  it('validates every ownership-sidecar field and omits messages from a ready inspection', async () => {
    const setup = await setupLoader()
    const environmentId = (await discover(setup)).environments[0]!.id
    const environmentPath = join(setup.workspaceRoot, '.venv')
    await createEnvironmentDirectory(environmentPath)
    const invalidSidecars: unknown[] = [
      null,
      { schemaVersion: 0, provider: 'uv', environmentId, python: '3.12', dependencies: { jupyterClient: '8.9.1', ipykernel: '7.3.0' } },
      { schemaVersion: 1, provider: 'other', environmentId, python: '3.12', dependencies: { jupyterClient: '8.9.1', ipykernel: '7.3.0' } },
      { schemaVersion: 1, provider: 'uv', environmentId: 1, python: '3.12', dependencies: { jupyterClient: '8.9.1', ipykernel: '7.3.0' } },
      { schemaVersion: 1, provider: 'uv', environmentId, python: '3.11', dependencies: { jupyterClient: '8.9.1', ipykernel: '7.3.0' } },
      { schemaVersion: 1, provider: 'uv', environmentId, python: '3.12', dependencies: null },
      { schemaVersion: 1, provider: 'uv', environmentId, python: '3.12', dependencies: { jupyterClient: '0', ipykernel: '7.3.0' } },
      { schemaVersion: 1, provider: 'uv', environmentId, python: '3.12', dependencies: { jupyterClient: '8.9.1', ipykernel: '0' } },
    ]
    for (const sidecar of invalidSidecars) {
      await writeFile(join(environmentPath, '.dsh-notebook-environment.json'), `${JSON.stringify(sidecar)}\n`)
      await expect(discover(setup)).resolves.toMatchObject({ environments: [{ status: 'broken' }] })
      await expect(setup.ctx.notebookEnvironments.inspectExisting({
        workspaceRoot: setup.workspaceRoot,
        sandboxPolicy: policy(setup.workspaceRoot, 'danger-full-access'),
        environmentId,
        signal: new AbortController().signal,
      })).resolves.toMatchObject({ status: 'broken', canRebuild: false })
    }

    await writeOwnership(environmentPath, environmentId)
    await expect(setup.ctx.notebookEnvironments.inspectExisting({
      workspaceRoot: setup.workspaceRoot,
      sandboxPolicy: policy(setup.workspaceRoot, 'danger-full-access'),
      environmentId,
      signal: new AbortController().signal,
    })).resolves.toEqual({
      environmentId,
      status: 'managed',
      pythonVersion: '3.12.9',
      canAttach: true,
      canRebuild: true,
    })
  })

  it('recovers absent and non-directory staging, rejects invalid markers, and retains owned backups', async () => {
    const setup = await setupLoader()
    const environmentId = (await discover(setup)).environments[0]!.id
    const absentStaging = join(setup.workspaceRoot, '.venv.dsh-staging-absent')
    await writeStagingOwnership(absentStaging, environmentId)
    const fileStaging = join(setup.workspaceRoot, '.venv.dsh-staging-file')
    await writeFile(fileStaging, 'staging file')
    await writeStagingOwnership(fileStaging, environmentId)
    const invalidStaging = join(setup.workspaceRoot, '.venv.dsh-staging-invalid')
    await writeFile(`${invalidStaging}.owner.json`, '{invalid json')
    const markerDirectory = join(setup.workspaceRoot, '.venv.dsh-staging-directory.owner.json')
    await mkdir(markerDirectory)
    const invalidBackup = join(setup.workspaceRoot, '.venv.dsh-rebuild-backup-invalid')
    await createEnvironmentDirectory(invalidBackup)
    await writeFile(join(invalidBackup, '.dsh-notebook-environment.json'), '{}\n')
    const fileBackup = join(setup.workspaceRoot, '.venv.dsh-rebuild-backup-file')
    await writeFile(fileBackup, 'foreign file')

    await expect(setup.ctx.notebookEnvironments.provision({
      workspaceRoot: setup.workspaceRoot,
      sandboxPolicy: policy(setup.workspaceRoot, 'workspace-write'),
      environmentId,
      allowExisting: false,
      rebuild: false,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ status: 'ready' })
    await expect(readFile(`${absentStaging}.owner.json`)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(fileStaging)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(`${invalidStaging}.owner.json`, 'utf8')).resolves.toBe('{invalid json')

    const ownedBackup = join(setup.workspaceRoot, '.venv.dsh-rebuild-backup-owned')
    await createEnvironmentDirectory(ownedBackup)
    await writeOwnership(ownedBackup, environmentId)
    await expect(setup.ctx.notebookEnvironments.provision({
      workspaceRoot: setup.workspaceRoot,
      sandboxPolicy: policy(setup.workspaceRoot, 'workspace-write'),
      environmentId,
      allowExisting: false,
      rebuild: false,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ status: 'ready' })
    await expect(readFile(ownedBackup)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readdir(setup.workspaceRoot))
      .filter(name => name.startsWith('.venv.dsh-residue-') && !name.endsWith('.owner.json'))).toHaveLength(2)
  })

  it('rechecks DSH ownership immediately before replacing an environment', async () => {
    const setup = await setupLoader()
    const environmentId = (await discover(setup)).environments[0]!.id
    await setup.ctx.notebookEnvironments.provision({
      workspaceRoot: setup.workspaceRoot,
      sandboxPolicy: policy(setup.workspaceRoot, 'workspace-write'),
      environmentId,
      allowExisting: false,
      rebuild: false,
      signal: new AbortController().signal,
    })
    const environmentPath = join(setup.workspaceRoot, '.venv')
    setup.subprocess.respond = spec => spec.argv[0]?.includes('.venv.dsh-staging-') === true
      && spec.argv[3]?.includes('KernelSpecManager') === true
      ? {
        stdout: '{"ipykernel":"7.3.0","jupyter_client":"8.9.1","kernel":true}\n',
        beforeExit: async () => { await writeOwnership(environmentPath, 'uv:foreign') },
      }
      : undefined
    await expect(setup.ctx.notebookEnvironments.provision({
      workspaceRoot: setup.workspaceRoot,
      sandboxPolicy: policy(setup.workspaceRoot, 'workspace-write'),
      environmentId,
      allowExisting: false,
      rebuild: true,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'NOTEBOOK_ENVIRONMENT_REBUILD_REQUIRED', retryable: false })
    expect((await readdir(setup.workspaceRoot)).filter(name => name.startsWith('.venv.dsh-staging-'))).toEqual([])
  })

  it('preserves typed and untyped failures when staging ownership disappears during cleanup', async () => {
    const typed = await setupLoader()
    const typedEnvironmentId = (await discover(typed)).environments[0]!.id
    typed.subprocess.respond = spec => spec.argv[0] === typed.uvExecutable && spec.argv[1] === 'venv'
      ? {
        exitCode: 1,
        beforeExit: async () => { await rm(`${spec.argv.at(-1)!}.owner.json`, { force: true }) },
      }
      : undefined
    const typedError = await captureRejection(typed.ctx.notebookEnvironments.provision({
      workspaceRoot: typed.workspaceRoot,
      sandboxPolicy: policy(typed.workspaceRoot, 'workspace-write'),
      environmentId: typedEnvironmentId,
      allowExisting: false,
      rebuild: false,
      signal: new AbortController().signal,
    }))
    expect(typedError).toMatchObject({ code: 'NOTEBOOK_ENVIRONMENT_PROVISION_FAILED' })
    expect((typedError as { cause?: unknown }).cause).toBeInstanceOf(AggregateError)

    const untyped = await setupLoader()
    const untypedEnvironmentId = (await discover(untyped)).environments[0]!.id
    let staging = ''
    untyped.subprocess.respond = (spec) => {
      if (spec.argv[0] === untyped.uvExecutable && spec.argv[1] === 'venv') {
        staging = spec.argv.at(-1)!
        return undefined
      }
      if (staging !== '' && spec.argv[0]?.startsWith(staging) === true
        && spec.argv[3]?.includes('KernelSpecManager') === true) {
        return {
          stdout: '{"ipykernel":"7.3.0","jupyter_client":"8.9.1","kernel":true}\n',
          beforeExit: async () => {
            await rm(staging, { recursive: true, force: true })
            await mkdir(join(staging, '.dsh-notebook-environment.json'), { recursive: true })
            await rm(`${staging}.owner.json`, { force: true })
          },
        }
      }
      return undefined
    }
    const untypedError = await captureRejection(untyped.ctx.notebookEnvironments.provision({
      workspaceRoot: untyped.workspaceRoot,
      sandboxPolicy: policy(untyped.workspaceRoot, 'workspace-write'),
      environmentId: untypedEnvironmentId,
      allowExisting: false,
      rebuild: false,
      signal: new AbortController().signal,
    }))
    expect(untypedError).toMatchObject({ code: 'NOTEBOOK_ENVIRONMENT_BROKEN' })
    expect((untypedError as { cause?: unknown }).cause).toBeInstanceOf(AggregateError)
  })

  it.each(['missing', 'foreign', 'directory'] as const)('handles a %s lock after successful publication', async (lockState) => {
    const setup = await setupLoader()
    const environmentId = (await discover(setup)).environments[0]!.id
    const lock = join(setup.workspaceRoot, '.dsh-notebook-environment.lock')
    let staging = ''
    setup.subprocess.respond = (spec) => {
      if (spec.argv[0] === setup.uvExecutable && spec.argv[1] === 'venv') {
        staging = spec.argv.at(-1)!
        return undefined
      }
      if (staging !== '' && spec.argv[0]?.startsWith(staging) === true
        && spec.argv[3]?.includes('KernelSpecManager') === true) {
        return {
          stdout: '{"ipykernel":"7.3.0","jupyter_client":"8.9.1","kernel":true}\n',
          beforeExit: async () => {
            await rm(lock, { force: true })
            if (lockState === 'foreign') await writeFile(lock, 'foreign owner\n')
            if (lockState === 'directory') await mkdir(lock)
          },
        }
      }
      return undefined
    }
    const provisioning = setup.ctx.notebookEnvironments.provision({
      workspaceRoot: setup.workspaceRoot,
      sandboxPolicy: policy(setup.workspaceRoot, 'workspace-write'),
      environmentId,
      allowExisting: false,
      rebuild: false,
      signal: new AbortController().signal,
    })
    if (lockState === 'directory') {
      await expect(provisioning).rejects.toMatchObject({ code: 'NOTEBOOK_ENVIRONMENT_BROKEN' })
    } else {
      await expect(provisioning).resolves.toMatchObject({ status: 'ready' })
    }
  })

  it('preserves an operation failure when its lock also becomes unreadable', async () => {
    const setup = await setupLoader()
    const environmentId = (await discover(setup)).environments[0]!.id
    const lock = join(setup.workspaceRoot, '.dsh-notebook-environment.lock')
    setup.subprocess.respond = spec => spec.argv[0] === setup.uvExecutable && spec.argv[1] === 'venv'
      ? {
        exitCode: 1,
        beforeExit: async () => {
          await rm(lock, { force: true })
          await mkdir(lock)
        },
      }
      : undefined
    const operationError = await captureRejection(setup.ctx.notebookEnvironments.provision({
      workspaceRoot: setup.workspaceRoot,
      sandboxPolicy: policy(setup.workspaceRoot, 'workspace-write'),
      environmentId,
      allowExisting: false,
      rebuild: false,
      signal: new AbortController().signal,
    }))
    expect(operationError).toMatchObject({ code: 'NOTEBOOK_ENVIRONMENT_PROVISION_FAILED' })
    expect((operationError as { cause?: unknown }).cause).toBeInstanceOf(AggregateError)
  })

  it.each(['missing', 'directory'] as const)('tolerates a %s published staging marker according to ownership rules', async (markerState) => {
    const setup = await setupLoader()
    const environmentId = (await discover(setup)).environments[0]!.id
    let staging = ''
    setup.subprocess.respond = (spec) => {
      if (spec.argv[0] === setup.uvExecutable && spec.argv[1] === 'venv') {
        staging = spec.argv.at(-1)!
        return undefined
      }
      if (staging !== '' && spec.argv[0]?.startsWith(staging) === true
        && spec.argv[3]?.includes('KernelSpecManager') === true) {
        return {
          stdout: '{"ipykernel":"7.3.0","jupyter_client":"8.9.1","kernel":true}\n',
          beforeExit: async () => {
            await rm(`${staging}.owner.json`, { force: true })
            if (markerState === 'directory') await mkdir(`${staging}.owner.json`)
          },
        }
      }
      return undefined
    }
    await expect(setup.ctx.notebookEnvironments.provision({
      workspaceRoot: setup.workspaceRoot,
      sandboxPolicy: policy(setup.workspaceRoot, 'workspace-write'),
      environmentId,
      allowExisting: false,
      rebuild: false,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ status: 'ready' })
  })

  it('aborts and joins an in-flight operation during provider disposal', async () => {
    const setup = await setupLoader()
    let started!: () => void
    const operationStarted = new Promise<void>((resolve) => { started = resolve })
    setup.subprocess.respond = spec => spec.argv[0] === setup.uvExecutable && spec.argv[1] === '--version'
      ? {
        done: new Promise((_, reject) => {
          started()
          const signal = spec.signal
          if (signal === undefined) throw new Error('fixture command signal is missing')
          signal.addEventListener('abort', () => { reject(signalError(signal)) }, { once: true })
        }),
      }
      : undefined
    const catalog = discover(setup)
    await operationStarted
    const manager = setup.ctx.notebookEnvironments
    await setup.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(setup.ctx), 1)
    await expect(catalog).rejects.toThrow('notebook environment manager stopped')
    await expect(manager.environmentCatalog({
      workspaceRoot: setup.workspaceRoot,
      sandboxPolicy: policy(setup.workspaceRoot, 'danger-full-access'),
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'NOTEBOOK_ENVIRONMENT_BROKEN' })
  })
})
