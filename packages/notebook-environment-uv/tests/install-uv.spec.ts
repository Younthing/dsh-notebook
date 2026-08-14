import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SandboxProvider, { type ConfinedArgv, type SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import SubprocessRuntime, {
  type SubprocessHandle,
  type SubprocessSpawnSpec,
  type SubprocessTerminalHandle,
  type SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'

const archiveState = vi.hoisted(() => ({
  supported: true,
  privateValid: false,
  publishValid: true,
  downloadFailure: undefined as Error | undefined,
  downloadCalls: 0,
  extractCalls: 0,
  publishCalls: 0,
}))

vi.mock('../src/archive.ts', () => {
  const archive = {
    filename: 'uv-fixture.zip',
    sha256: 'a'.repeat(64),
    format: 'zip' as const,
    executableName: 'uv.exe' as const,
  }
  return {
    PRIVATE_UV_VERSION: '0.11.32',
    currentUvArchive: () => archiveState.supported ? archive : undefined,
    privateUvExecutable: (dshHome: string) => `${dshHome}/tools/uv/0.11.32/${archive.sha256}/uv.exe`,
    downloadUvArchive: async () => {
      archiveState.downloadCalls += 1
      if (archiveState.downloadFailure !== undefined) throw archiveState.downloadFailure
      return new Uint8Array([1])
    },
    extractUvExecutable: () => {
      archiveState.extractCalls += 1
      return new Uint8Array([2])
    },
    publishUvExecutable: async (target: string, executable: Uint8Array) => {
      archiveState.publishCalls += 1
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, executable)
      archiveState.privateValid = archiveState.publishValid
    },
  }
})

const {
  default: UvNotebookEnvironmentManager,
} = await import('@deepseek-ai/dsh-notebook-environment-uv')
const {
  currentUvArchive,
  privateUvExecutable,
} = await import('../src/archive.ts')

class FixtureSandbox extends SandboxProvider {
  override confine(argv: readonly string[], _policy: SandboxPolicy): ConfinedArgv {
    return { argv: [...argv], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }
  }
}

class FixtureSubprocess extends SubprocessRuntime {
  aliasUv?: string
  externalVersion = '0.11.32'
  readonly spawns: SubprocessSpawnSpec[] = []

  override async resolveExecutable(command: string): Promise<string> {
    if (command === 'uv') {
      if (this.aliasUv !== undefined) return this.aliasUv
      throw new Error('uv is not on PATH')
    }
    return command
  }

  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    this.spawns.push(spec)
    let stdout = ''
    let exitCode = 0
    if (spec.argv[1] === '--version') {
      const privateExecutable = spec.argv[0]?.includes('/tools/uv/') === true
        || spec.argv[0]?.includes('\\tools\\uv\\') === true
      stdout = privateExecutable
        ? archiveState.privateValid ? 'uv 0.11.32\n' : 'corrupt\n'
        : `uv ${this.externalVersion}\n`
    } else if (spec.argv[1] === '-I' && spec.argv[2] === '-c') {
      stdout = '3.12.9\n'
    } else {
      exitCode = 1
    }
    return completedHandle(stdout, exitCode)
  }

  override async spawnTerminal(_spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    throw new Error('unused')
  }
}

function completedHandle(stdout: string, exitCode: number): SubprocessHandle {
  return {
    pid: 1,
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    collected: {
      stdout: { readFrom: () => ({ text: stdout, nextOffset: Buffer.byteLength(stdout), lossy: false }) },
      stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
    },
    done: Promise.resolve({ exitCode, signal: null }),
    terminate() {},
    async waitForExit() { return true },
  }
}

interface SetupResult {
  readonly ctx: Context
  readonly subprocess: FixtureSubprocess
  readonly workspaceRoot: string
  readonly dshHome: string
  readonly pythonExecutable: string
}

const contexts: Context[] = []
const temporaryDirectories: string[] = []

beforeEach(() => {
  archiveState.supported = true
  archiveState.privateValid = false
  archiveState.publishValid = true
  archiveState.downloadFailure = undefined
  archiveState.downloadCalls = 0
  archiveState.extractCalls = 0
  archiveState.publishCalls = 0
})

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function setup(uvExecutable?: string): Promise<SetupResult> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-notebook-private-uv-'))
  temporaryDirectories.push(root)
  const workspaceRoot = join(root, 'workspace')
  const dshHome = join(root, 'dsh-home')
  const pythonExecutable = join(root, 'python')
  await mkdir(workspaceRoot)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(FixtureSandbox)
  await ctx.plugin(FixtureSubprocess)
  await ctx.plugin(UvNotebookEnvironmentManager, {
    ...(uvExecutable === undefined ? {} : { uvExecutable }),
    pythonExecutable,
    dshHome,
    operationTimeoutMs: 30_000,
  })
  return { ctx, subprocess: ctx.subprocess as FixtureSubprocess, workspaceRoot, dshHome, pythonExecutable }
}

function request(setup: SetupResult, mode: 'workspace-write' | 'danger-full-access' = 'danger-full-access') {
  return {
    workspaceRoot: setup.workspaceRoot,
    sandboxPolicy: { mode, workspaceRoot: setup.workspaceRoot },
    signal: new AbortController().signal,
  } as const
}

describe('private uv installation', () => {
  it('downloads, verifies, atomically publishes, and then reuses the pinned executable', async () => {
    const fixture = await setup()

    await expect(fixture.ctx.notebookEnvironments.environmentCatalog(request(fixture))).resolves.toMatchObject({
      manager: { status: 'missing', canInstall: true },
    })
    await expect(fixture.ctx.notebookEnvironments.installUv(request(fixture))).resolves.toMatchObject({
      manager: { status: 'ready', version: '0.11.32', canInstall: true },
    })
    expect(archiveState).toMatchObject({ downloadCalls: 1, extractCalls: 1, publishCalls: 1 })
    const target = privateUvExecutable(fixture.dshHome, currentUvArchive()!)
    await expect(readFile(target)).resolves.toEqual(Buffer.from([2]))

    await expect(fixture.ctx.notebookEnvironments.installUv(request(fixture))).resolves.toMatchObject({
      manager: { status: 'ready' },
    })
    expect(archiveState.downloadCalls).toBe(1)
  })

  it('repairs a corrupt private file but refuses to remove a directory at the executable target', async () => {
    const repaired = await setup()
    const repairedTarget = privateUvExecutable(repaired.dshHome, currentUvArchive()!)
    await mkdir(dirname(repairedTarget), { recursive: true })
    await writeFile(repairedTarget, 'corrupt')
    await expect(repaired.ctx.notebookEnvironments.installUv(request(repaired))).resolves.toMatchObject({
      manager: { status: 'ready' },
    })
    await expect(readFile(repairedTarget)).resolves.toEqual(Buffer.from([2]))

    archiveState.privateValid = false
    const occupied = await setup()
    const occupiedTarget = privateUvExecutable(occupied.dshHome, currentUvArchive()!)
    await mkdir(occupiedTarget, { recursive: true })
    await expect(occupied.ctx.notebookEnvironments.installUv(request(occupied))).rejects.toMatchObject({
      code: 'NOTEBOOK_ENVIRONMENT_MANAGER_INTEGRITY',
      category: 'manager',
      retryable: false,
    })
    expect((await stat(occupiedTarget)).isDirectory()).toBe(true)
  })

  it('reports download integrity and post-publication version failures with stable retryability', async () => {
    const download = await setup()
    archiveState.downloadFailure = new Error('network failed')
    await expect(download.ctx.notebookEnvironments.installUv(request(download))).rejects.toMatchObject({
      code: 'NOTEBOOK_ENVIRONMENT_MANAGER_INTEGRITY',
      category: 'manager',
      retryable: true,
    })

    archiveState.downloadFailure = undefined
    archiveState.publishValid = false
    const published = await setup()
    await expect(published.ctx.notebookEnvironments.installUv(request(published))).rejects.toMatchObject({
      code: 'NOTEBOOK_ENVIRONMENT_MANAGER_INTEGRITY',
      category: 'manager',
      retryable: false,
    })
  })

  it('fails loud for configured uv and bypasses an unusable PATH candidate', async () => {
    const configuredPath = join(tmpdir(), 'configured-broken-uv')
    const configured = await setup(configuredPath)
    configured.subprocess.externalVersion = 'invalid'
    await expect(configured.ctx.notebookEnvironments.installUv(request(configured))).rejects.toMatchObject({
      code: 'NOTEBOOK_ENVIRONMENT_MANAGER_REQUIRED',
      retryable: false,
    })

    const path = await setup()
    path.subprocess.aliasUv = join(tmpdir(), 'path-broken-uv')
    path.subprocess.externalVersion = 'invalid'
    await expect(path.ctx.notebookEnvironments.installUv(request(path))).resolves.toMatchObject({
      manager: { status: 'ready', version: '0.11.32' },
    })
    expect(archiveState.downloadCalls).toBe(1)
  })

  it('fails unsupported platforms, restricted permission, and concurrent private installation explicitly', async () => {
    archiveState.supported = false
    const unsupported = await setup()
    await expect(unsupported.ctx.notebookEnvironments.installUv(request(unsupported))).rejects.toMatchObject({
      code: 'NOTEBOOK_ENVIRONMENT_MANAGER_UNSUPPORTED',
      retryable: false,
    })
    const unsupportedCatalog = await unsupported.ctx.notebookEnvironments.environmentCatalog(request(unsupported))
    await expect(unsupported.ctx.notebookEnvironments.provision({
      ...request(unsupported, 'workspace-write'),
      environmentId: unsupportedCatalog.environments[0]!.id,
      allowExisting: false,
      rebuild: false,
    })).rejects.toMatchObject({
      code: 'NOTEBOOK_ENVIRONMENT_MANAGER_UNSUPPORTED',
      retryable: false,
    })

    archiveState.supported = true
    const restricted = await setup()
    await expect(restricted.ctx.notebookEnvironments.installUv(request(restricted, 'workspace-write'))).rejects.toMatchObject({
      code: 'NOTEBOOK_ENVIRONMENT_PERMISSION_REQUIRED',
      category: 'permission',
    })

    const busy = await setup()
    const target = privateUvExecutable(busy.dshHome, currentUvArchive()!)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(`${target}.install.lock`, 'another installer\n')
    await expect(busy.ctx.notebookEnvironments.installUv(request(busy))).rejects.toMatchObject({
      code: 'NOTEBOOK_ENVIRONMENT_BUSY',
      category: 'dependency',
      retryable: true,
    })
  })
})
