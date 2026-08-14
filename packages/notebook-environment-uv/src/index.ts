/**
 * uv-backed notebook environment provider. It discovers configured, PATH, then pinned private uv;
 * provisions one relocatable workspace `.venv`; and resolves opaque environment ids for Jupyter.
 *
 * @module @deepseek-ai/dsh-notebook-environment-uv
 */

import { createHash, randomUUID } from 'node:crypto'
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import {
  NotebookEnvironmentError,
  NotebookEnvironmentId,
  NotebookEnvironmentManager,
  type NotebookEnvironmentCatalog,
  type NotebookEnvironmentCatalogEntry,
  type NotebookEnvironmentErrorCategory,
  type NotebookEnvironmentLaunchSpec,
  type NotebookEnvironmentOperationRequest,
  type NotebookEnvironmentProvisionRequest,
  type NotebookEnvironmentTargetRequest,
  type NotebookExistingEnvironmentInspection,
  type NotebookPythonCatalogEntry,
  type NotebookPythonInstallRequest,
  type NotebookPythonSource,
} from '@deepseek-ai/dsh-notebook-environment'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  currentUvArchive,
  downloadUvArchive,
  extractUvExecutable,
  privateUvExecutable,
  PRIVATE_UV_VERSION,
  publishUvExecutable,
  type UvArchive,
} from './archive.ts'
import { EnvironmentCommandRunner } from './runner.ts'

const DEFAULT_OPERATION_TIMEOUT_MS = 15 * 60 * 1_000
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1_024
const DEFAULT_MAX_DOWNLOAD_BYTES = 64 * 1_024 * 1_024
const DEFAULT_GRACE_MS = 3_000
const MAX_OUTPUT_BYTES = 4 * 1_024 * 1_024
const MAX_DOWNLOAD_BYTES = 256 * 1_024 * 1_024
const ENVIRONMENT_DIR = '.venv'
const LOCK_FILE = '.dsh-notebook-environment.lock'
const SIDECAR_FILE = '.dsh-notebook-environment.json'
const STAGING_PREFIX = `${ENVIRONMENT_DIR}.dsh-staging-`
const STAGING_MARKER_SUFFIX = '.owner.json'
const REBUILD_BACKUP_PREFIX = `${ENVIRONMENT_DIR}.dsh-rebuild-backup-`
const RETAINED_RESIDUE_PREFIX = `${ENVIRONMENT_DIR}.dsh-residue-`
const SIDECAR_VERSION = 1
const PYTHON_LINE = '3.12'
const JUPYTER_CLIENT_VERSION = '8.9.1'
const IPYKERNEL_VERSION = '7.3.0'
const KERNEL_NAME = 'python3'
const MINIMUM_UV_MINOR = 9
const MAXIMUM_UV_MINOR = 11
const REQUIREMENTS_PATH = join(dirname(fileURLToPath(import.meta.url)), '../requirements.lock')
const PROCESS_STARTED_AT_MS = Math.floor(Date.now() - process.uptime() * 1_000)
const ACTIVE_LOCK_OWNERS = new Set<string>()
const PYTHON_VERSION_PROGRAM = [
  'import sys',
  'print(".".join(str(value) for value in sys.version_info[:3]))',
].join(';')

const DEPENDENCY_PROBE_PROGRAM = [
  'import json',
  'import os',
  'import ipykernel',
  'import jupyter_client',
  'from ipykernel.kernelspec import RESOURCES',
  'from jupyter_client.kernelspec import KernelSpecManager',
  'spec = KernelSpecManager(kernel_dirs=[]).get_kernel_spec("python3")',
  'print(json.dumps({"ipykernel": ipykernel.__version__, "jupyter_client": jupyter_client.__version__, "kernel": os.path.realpath(spec.resource_dir) == os.path.realpath(RESOURCES)}))',
].join(';')

/** uv provider configuration. */
export interface Config {
  /** Configured uv executable, resolved before PATH and the DSH-private copy. */
  readonly uvExecutable?: string
  /** Configured Python executable, used instead of uv/system discovery. */
  readonly pythonExecutable?: string
  /** Optional Harness home override for private uv and Python installations. */
  readonly dshHome?: string
  /** Complete discovery, download, or provisioning deadline in milliseconds. */
  readonly operationTimeoutMs?: number
  /** Aggregate stdout plus stderr cap for one provider subprocess. */
  readonly maxOutputBytes?: number
  /** Complete compressed uv archive download cap. */
  readonly maxDownloadBytes?: number
  /** Subprocess TERM-to-KILL grace in milliseconds. */
  readonly graceMs?: number
}

interface ResolvedConfig {
  readonly uvExecutable?: string
  readonly pythonExecutable?: string
  readonly dshHome: string
  readonly operationTimeoutMs: number
  readonly maxOutputBytes: number
  readonly maxDownloadBytes: number
  readonly graceMs: number
}

interface OperationWorkspace {
  readonly root: string
  readonly policy: SandboxExecutionPolicy
  readonly environmentId: ReturnType<typeof NotebookEnvironmentId>
  readonly environmentPath: string
}

interface UvResolution {
  readonly status: 'ready' | 'missing' | 'broken' | 'unsupported'
  readonly canInstall: boolean
  readonly executable?: string
  readonly version?: string
  readonly source?: 'configured' | 'path' | 'private'
}

interface PythonResolution {
  readonly executable: string
  readonly version: string
  readonly source: NotebookPythonSource
}

interface EnvironmentProbe {
  readonly kind: 'absent' | 'unmanaged' | 'managed' | 'broken'
  readonly environmentId: ReturnType<typeof NotebookEnvironmentId>
  readonly pythonExecutable: string
  readonly pythonVersion?: string
  readonly ready: boolean
  readonly canAttach: boolean
  readonly owned: boolean
  readonly message?: string
}

interface OwnershipSidecar {
  readonly schemaVersion: 1
  readonly provider: 'uv'
  readonly environmentId: string
  readonly python: '3.12'
  readonly dependencies: {
    readonly jupyterClient: '8.9.1'
    readonly ipykernel: '7.3.0'
  }
}

interface StagingMarker {
  readonly schemaVersion: 1
  readonly provider: 'uv'
  readonly kind: 'staging'
  readonly environmentId: string
  readonly stagingName: string
}

interface StagedEnvironment {
  readonly path: string
  readonly markerPath: string
}

interface LockRecord {
  readonly schemaVersion: 1
  readonly ownerId: string
  readonly nonce: string
  readonly pid: number
  readonly processStartedAtMs: number
}

/** uv-backed implementation of `ctx.notebookEnvironments`. */
export class UvNotebookEnvironmentManager extends NotebookEnvironmentManager {
  static inject = ['sandbox', 'subprocess']
  static Config: z<Config> = z.object({
    uvExecutable: z.string().min(1),
    pythonExecutable: z.string().min(1),
    dshHome: z.string().min(1),
    operationTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_OPERATION_TIMEOUT_MS),
    maxOutputBytes: z.number().step(1).min(1).max(MAX_OUTPUT_BYTES).default(DEFAULT_MAX_OUTPUT_BYTES),
    maxDownloadBytes: z.number().step(1).min(1).max(MAX_DOWNLOAD_BYTES).default(DEFAULT_MAX_DOWNLOAD_BYTES),
    graceMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_GRACE_MS),
  })

  private readonly config: ResolvedConfig
  private readonly runner: EnvironmentCommandRunner
  private readonly lifetime = new AbortController()
  private readonly operations = new Set<Promise<void>>()
  private readonly provisioning = new Set<string>()
  private readonly lockOwner = randomUUID()
  private disposed = false

  /**
   * @param ctx - sandbox and subprocess services in one execution world.
   * @param config - validated provider paths and resource bounds.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx)
    this.config = resolveConfig(config)
    this.runner = new EnvironmentCommandRunner(ctx, this.config.maxOutputBytes, this.config.graceMs)
    ACTIVE_LOCK_OWNERS.add(this.lockOwner)
    ctx.effect(() => async () => {
      this.disposed = true
      this.lifetime.abort(new Error('notebook environment manager disposed'))
      await Promise.allSettled(this.operations)
      ACTIVE_LOCK_OWNERS.delete(this.lockOwner)
    }, 'notebook-environment-uv.teardown')
  }

  override environmentCatalog(request: NotebookEnvironmentOperationRequest): Promise<NotebookEnvironmentCatalog> {
    return this.runOperation(request.signal, 'manager', async (signal) => {
      const workspace = await this.resolveWorkspace(request, signal)
      return await this.catalog(workspace, signal)
    })
  }

  override installUv(request: NotebookEnvironmentOperationRequest): Promise<NotebookEnvironmentCatalog> {
    return this.runOperation(request.signal, 'manager', async (signal) => {
      requirePrivateInstallPermission(request.sandboxPolicy)
      const workspace = await this.resolveWorkspace(request, signal)
      const existing = await this.resolveUv(workspace, signal)
      if (existing.status === 'ready') return await this.catalog(workspace, signal)
      if (this.config.uvExecutable !== undefined) {
        throw environmentError(
          'The configured uv executable is not usable.',
          'NOTEBOOK_ENVIRONMENT_MANAGER_REQUIRED',
          'manager',
          false,
        )
      }
      const archive = currentUvArchive()
      if (archive === undefined) {
        throw environmentError(
          'Private uv installation is not supported on this platform.',
          'NOTEBOOK_ENVIRONMENT_MANAGER_UNSUPPORTED',
          'manager',
          false,
        )
      }
      const target = privateUvExecutable(this.config.dshHome, archive)
      await withExclusiveFileLock(`${target}.install.lock`, this.lockOwner, signal, async () => {
        const ready = await this.probePrivateUv(target, archive, workspace, signal)
        /* v8 ignore next -- another process must publish the pinned executable between the outer probe and lock acquisition. */
        if (ready !== undefined) return
        let compressed: Uint8Array
        let executable: Uint8Array
        try {
          compressed = await downloadUvArchive(archive, this.config.maxDownloadBytes, signal)
          executable = extractUvExecutable(archive, compressed)
        } catch (cause) {
          signal.throwIfAborted()
          throw environmentError(
            'The pinned uv archive failed download or integrity verification.',
            'NOTEBOOK_ENVIRONMENT_MANAGER_INTEGRITY',
            'manager',
            true,
            cause,
          )
        }
        await removeReplaceableFile(target)
        await publishUvExecutable(target, executable)
        const published = await this.probePrivateUv(target, archive, workspace, signal)
        if (published === undefined) {
          throw environmentError(
            'The pinned uv executable did not pass its version check.',
            'NOTEBOOK_ENVIRONMENT_MANAGER_INTEGRITY',
            'manager',
            false,
          )
        }
      })
      return await this.catalog(workspace, signal)
    })
  }

  override installPython(request: NotebookPythonInstallRequest): Promise<NotebookEnvironmentCatalog> {
    return this.runOperation(request.signal, 'python', async (signal) => {
      requirePrivateInstallPermission(request.sandboxPolicy)
      const workspace = await this.resolveWorkspace(request, signal)
      const uv = await this.requireUv(workspace, signal)
      await this.runUv(uv, workspace, signal, [
        'python', 'install', request.version,
      ], {
        downloads: 'manual',
        label: 'notebook Python install',
        failureCode: 'NOTEBOOK_ENVIRONMENT_PROVISION_FAILED',
        category: 'python',
      })
      return await this.catalog(workspace, signal)
    })
  }

  override inspectExisting(request: NotebookEnvironmentTargetRequest): Promise<NotebookExistingEnvironmentInspection> {
    return this.runOperation(request.signal, 'python', async (signal) => {
      const workspace = await this.resolveWorkspace(request, signal)
      assertEnvironmentId(workspace, request.environmentId)
      const probe = await this.probeEnvironment(workspace, signal, true)
      return {
        environmentId: probe.environmentId,
        status: probe.kind,
        ...probe.pythonVersion === undefined ? {} : { pythonVersion: probe.pythonVersion },
        canAttach: probe.canAttach,
        canRebuild: probe.owned,
        ...probe.message === undefined ? {} : { message: probe.message },
      }
    })
  }

  override provision(request: NotebookEnvironmentProvisionRequest): Promise<NotebookEnvironmentCatalogEntry> {
    return this.runOperation(request.signal, 'dependency', async (signal) => {
      requireWorkspaceWritePermission(request.sandboxPolicy)
      const workspace = await this.resolveWorkspace(request, signal)
      assertEnvironmentId(workspace, request.environmentId)
      const key = String(workspace.environmentId)
      if (this.provisioning.has(key)) {
        throw environmentError(
          'This workspace environment is already being provisioned.',
          'NOTEBOOK_ENVIRONMENT_BUSY',
          'dependency',
          true,
        )
      }
      this.provisioning.add(key)
      try {
        return await withExclusiveFileLock(join(workspace.root, LOCK_FILE), this.lockOwner, signal, async () => {
          await recoverOwnedResidue(workspace, () => { this.warnRetainedResidue() })
          const uv = await this.requireUv(workspace, signal)
          let probe = await this.probeEnvironment(workspace, signal, false)
          if (probe.kind === 'unmanaged' && request.allowExisting) {
            probe = await this.probeEnvironment(workspace, signal, true)
          }
          if (probe.kind === 'broken') {
            if (probe.owned && request.rebuild) {
              const python = await this.resolvePythonForProvision(uv, workspace, signal)
              await this.rebuildEnvironment(uv, python, workspace, signal)
            } else {
              throw environmentError(
                probe.owned
                  ? 'The DSH-owned workspace environment requires explicit rebuild authorization.'
                  : (probe.message ?? 'The workspace environment is not usable.'),
                probe.owned
                  ? 'NOTEBOOK_ENVIRONMENT_REBUILD_REQUIRED'
                  : 'NOTEBOOK_ENVIRONMENT_BROKEN',
                probe.owned ? 'dependency' : 'python',
                false,
              )
            }
          } else if (probe.kind === 'unmanaged' && !request.allowExisting) {
            throw environmentError(
              'An existing unmanaged environment requires explicit attachment.',
              'NOTEBOOK_ENVIRONMENT_ATTACH_REQUIRED',
              'permission',
              false,
            )
          } else if (probe.kind === 'unmanaged' && request.rebuild) {
            throw environmentError(
              'Rebuild authorization cannot replace an unmanaged environment.',
              'NOTEBOOK_ENVIRONMENT_REBUILD_REQUIRED',
              'permission',
              false,
            )
          } else if (probe.kind === 'managed' && request.rebuild) {
            const python = await this.resolvePythonForProvision(uv, workspace, signal)
            await this.rebuildEnvironment(uv, python, workspace, signal)
          } else if (probe.kind === 'managed' && probe.ready) {
            return catalogEntry(probe, false)
          } else if (probe.kind === 'absent') {
            const python = await this.resolvePythonForProvision(uv, workspace, signal)
            await this.createEnvironment(uv, python, workspace, signal)
          } else {
            await this.installDependencies(uv, probe.pythonExecutable, workspace, signal)
            await this.verifyDependencies(probe.pythonExecutable, workspace, signal)
            await writeOwnershipSidecar(workspace.environmentPath, workspace.environmentId)
          }
          const ready = await this.probeEnvironment(workspace, signal, true)
          if (ready.kind !== 'managed' || !ready.ready) {
            throw environmentError(
              'The environment did not become ready after provisioning.',
              'NOTEBOOK_ENVIRONMENT_DEPENDENCY_FAILED',
              'dependency',
              true,
            )
          }
          return catalogEntry(ready, false)
        })
      } finally {
        this.provisioning.delete(key)
      }
    })
  }

  override resolveLaunch(request: NotebookEnvironmentTargetRequest): Promise<NotebookEnvironmentLaunchSpec> {
    return this.runOperation(request.signal, 'kernel-start', async (signal) => {
      const workspace = await this.resolveWorkspace(request, signal)
      assertEnvironmentId(workspace, request.environmentId)
      const probe = await this.probeEnvironment(workspace, signal, false)
      if (probe.kind === 'unmanaged') {
        throw environmentError(
          'The selected environment must be explicitly attached before it can launch a kernel.',
          'NOTEBOOK_ENVIRONMENT_ATTACH_REQUIRED',
          'permission',
          false,
        )
      }
      if (probe.kind !== 'managed' || !probe.ready) {
        throw environmentError(
          probe.message ?? 'The selected environment is not ready.',
          probe.kind === 'managed'
            ? 'NOTEBOOK_ENVIRONMENT_DEPENDENCY_FAILED'
            : 'NOTEBOOK_ENVIRONMENT_BROKEN',
          probe.kind === 'managed' ? 'dependency' : 'python',
          probe.kind === 'managed',
        )
      }
      return {
        environmentId: workspace.environmentId,
        pythonExecutable: probe.pythonExecutable,
        kernelName: KERNEL_NAME,
      }
    })
  }

  private async catalog(workspace: OperationWorkspace, signal: AbortSignal): Promise<NotebookEnvironmentCatalog> {
    const [manager, probe] = await Promise.all([
      this.resolveUv(workspace, signal),
      this.probeEnvironment(workspace, signal, false),
    ])
    const pythons = await this.pythonCatalog(manager, workspace, signal)
    return {
      manager: {
        status: manager.status,
        ...manager.version === undefined ? {} : { version: manager.version },
        canInstall: manager.canInstall,
      },
      pythons,
      environments: [catalogEntry(probe, this.provisioning.has(String(workspace.environmentId)))],
    }
  }

  private async resolveWorkspace(
    request: NotebookEnvironmentOperationRequest,
    signal: AbortSignal,
  ): Promise<OperationWorkspace> {
    signal.throwIfAborted()
    let root: string
    let policyRoot: string
    try {
      [root, policyRoot] = await Promise.all([
        realpath(request.workspaceRoot),
        realpath(request.sandboxPolicy.workspaceRoot),
      ])
      if (!(await stat(root)).isDirectory()) throw new Error('workspace root is not a directory')
    } catch (cause) {
      throw environmentError(
        'The notebook workspace directory is unavailable.',
        'NOTEBOOK_ENVIRONMENT_BROKEN',
        'permission',
        false,
        cause,
      )
    }
    signal.throwIfAborted()
    if (!samePath(root, policyRoot)) {
      throw environmentError(
        'The environment workspace does not match the sandbox workspace.',
        'NOTEBOOK_ENVIRONMENT_PERMISSION_REQUIRED',
        'permission',
        false,
      )
    }
    const environmentId = environmentIdFor(root)
    return {
      root,
      policy: { ...request.sandboxPolicy, workspaceRoot: root },
      environmentId,
      environmentPath: join(root, ENVIRONMENT_DIR),
    }
  }

  private async resolveUv(workspace: OperationWorkspace, signal: AbortSignal): Promise<UvResolution> {
    if (this.config.uvExecutable !== undefined) {
      const executable = await this.tryResolveExecutable(this.config.uvExecutable, signal)
      if (executable === undefined
        || await isWorkspaceEnvironmentExecutable(executable, workspace.environmentPath)) {
        return { status: 'broken', canInstall: false, source: 'configured' }
      }
      const version = await this.tryUvVersion(executable, workspace, signal)
      return version === undefined
        ? { status: 'broken', canInstall: false, source: 'configured' }
        : { status: 'ready', canInstall: false, executable, version, source: 'configured' }
    }

    const pathExecutable = await this.tryResolveExecutable('uv', signal)
    if (pathExecutable !== undefined
      && !(await isWorkspaceEnvironmentExecutable(pathExecutable, workspace.environmentPath))) {
      const version = await this.tryUvVersion(pathExecutable, workspace, signal)
      if (version !== undefined) {
        return { status: 'ready', canInstall: false, executable: pathExecutable, version, source: 'path' }
      }
    }

    const archive = currentUvArchive()
    if (archive === undefined) return { status: 'unsupported', canInstall: false }
    const privateExecutable = privateUvExecutable(this.config.dshHome, archive)
    const privateVersion = await this.probePrivateUv(privateExecutable, archive, workspace, signal)
    return privateVersion === undefined
      ? { status: await pathExists(privateExecutable) ? 'broken' : 'missing', canInstall: true, source: 'private' }
      : {
        status: 'ready',
        canInstall: true,
        executable: privateExecutable,
        version: privateVersion,
        source: 'private',
      }
  }

  private async probePrivateUv(
    executable: string,
    archive: UvArchive,
    workspace: OperationWorkspace,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    const info = await safeLstat(executable)
    if (info === undefined || info.isSymbolicLink() || !info.isFile()) return undefined
    const resolved = await this.tryResolveExecutable(executable, signal)
    if (resolved === undefined) return undefined
    const version = await this.tryUvVersion(resolved, workspace, signal)
    return version === PRIVATE_UV_VERSION && executable === privateUvExecutable(this.config.dshHome, archive)
      ? version
      : undefined
  }

  private async tryUvVersion(
    executable: string,
    workspace: OperationWorkspace,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    try {
      const result = await this.runner.run({
        argv: [executable, '--version'],
        cwd: workspace.root,
        sandboxPolicy: workspace.policy,
        env: commandEnvironment(this.config, false),
        signal,
        label: 'notebook uv version probe',
        failureCode: 'NOTEBOOK_ENVIRONMENT_MANAGER_REQUIRED',
        category: 'manager',
        logFailure: false,
      })
      const match = /^uv\s+(\d+\.\d+\.\d+)(?:\s|$)/.exec(result.stdout.trim())
      if (match === null) return undefined
      const version = match[1]
      if (version === undefined) return undefined
      const [major, minor] = version.split('.').map(Number)
      return major === 0 && minor !== undefined && minor >= MINIMUM_UV_MINOR && minor <= MAXIMUM_UV_MINOR
        ? version
        : undefined
    } catch {
      signal.throwIfAborted()
      return undefined
    }
  }

  private async requireUv(workspace: OperationWorkspace, signal: AbortSignal): Promise<string> {
    const resolution = await this.resolveUv(workspace, signal)
    if (resolution.status === 'ready' && resolution.executable !== undefined) return resolution.executable
    if (resolution.status === 'unsupported') {
      throw environmentError(
        'uv is unavailable and private installation is unsupported on this platform.',
        'NOTEBOOK_ENVIRONMENT_MANAGER_UNSUPPORTED',
        'manager',
        false,
      )
    }
    throw environmentError(
      'uv is required before this environment can be provisioned.',
      'NOTEBOOK_ENVIRONMENT_MANAGER_REQUIRED',
      'manager',
      resolution.status === 'missing',
    )
  }

  private async pythonCatalog(
    manager: UvResolution,
    workspace: OperationWorkspace,
    signal: AbortSignal,
  ): Promise<readonly NotebookPythonCatalogEntry[]> {
    const candidates: PythonResolution[] = []
    if (this.config.pythonExecutable !== undefined) {
      const resolved = await this.tryResolveExecutable(this.config.pythonExecutable, signal)
      const python = resolved === undefined || await isWorkspaceEnvironmentExecutable(resolved, workspace.environmentPath)
        ? undefined
        : await this.tryPython(resolved, 'configured', workspace, signal)
      /* v8 ignore next -- the configured-probe miss has no side effect; catalog tests assert its empty result. */
      if (python !== undefined) candidates.push(python)
    } else if (manager.status === 'ready' && manager.executable !== undefined) {
      for (const scope of ['managed', 'system'] as const) {
        const python = await this.tryFindPython(manager.executable, scope, workspace, signal)
        if (python !== undefined
          && !candidates.some(candidate => samePath(candidate.executable, python.executable))) candidates.push(python)
      }
    } else {
      /* v8 ignore next -- Windows coverage exercises its command names; POSIX CI exercises the peer list. */
      for (const command of process.platform === 'win32' ? ['python3.12', 'python'] : ['python3.12', 'python3']) {
        const resolved = await this.tryResolveExecutable(command, signal)
        if (resolved === undefined || candidates.some(candidate => samePath(candidate.executable, resolved))) continue
        const python = await this.tryPython(resolved, pythonSource(resolved, this.config.dshHome), workspace, signal)
        if (python !== undefined) candidates.push(python)
      }
    }
    return candidates.map(candidate => ({
      id: pythonId(candidate.executable, candidate.source),
      version: candidate.version,
      source: candidate.source,
    }))
  }

  private async resolvePythonForProvision(
    uv: string,
    workspace: OperationWorkspace,
    signal: AbortSignal,
  ): Promise<string> {
    if (this.config.pythonExecutable !== undefined) {
      const executable = await this.tryResolveExecutable(this.config.pythonExecutable, signal)
      if (executable !== undefined
        && !(await isWorkspaceEnvironmentExecutable(executable, workspace.environmentPath))) {
        const python = await this.tryPython(executable, 'configured', workspace, signal)
        if (python?.version.startsWith(`${PYTHON_LINE}.`) === true) return python.executable
      }
      throw environmentError(
        'The configured Python executable is not Python 3.12.',
        'NOTEBOOK_ENVIRONMENT_PYTHON_REQUIRED',
        'python',
        false,
      )
    }
    for (const scope of ['managed', 'system'] as const) {
      const found = await this.tryFindPython(uv, scope, workspace, signal)
      if (found?.version.startsWith(`${PYTHON_LINE}.`) === true) return found.executable
    }
    throw environmentError(
      'Python 3.12 is required. Install it explicitly before creating the environment.',
      'NOTEBOOK_ENVIRONMENT_PYTHON_REQUIRED',
      'python',
      false,
    )
  }

  private async tryFindPython(
    uv: string,
    scope: 'managed' | 'system',
    workspace: OperationWorkspace,
    signal: AbortSignal,
  ): Promise<PythonResolution | undefined> {
    try {
      const result = await this.runUv(uv, workspace, signal, [
        'python', 'find', PYTHON_LINE, scope === 'managed' ? '--managed-python' : '--system',
      ], {
        downloads: 'never',
        label: 'notebook Python discovery',
        failureCode: 'NOTEBOOK_ENVIRONMENT_PYTHON_REQUIRED',
        category: 'python',
        logFailure: false,
      })
      const candidate = result.stdout.trim().split(/\r?\n/, 1)[0]
      if (candidate === undefined || !isAbsolute(candidate)) return undefined
      const executable = await this.tryResolveExecutable(candidate, signal)
      return executable === undefined || await isWorkspaceEnvironmentExecutable(executable, workspace.environmentPath)
        ? undefined
        : await this.tryPython(executable, pythonSource(executable, this.config.dshHome), workspace, signal)
    } catch {
      signal.throwIfAborted()
      return undefined
    }
  }

  private async tryPython(
    executable: string,
    source: NotebookPythonSource,
    workspace: OperationWorkspace,
    signal: AbortSignal,
  ): Promise<PythonResolution | undefined> {
    try {
      const result = await this.runner.run({
        argv: [executable, '-I', '-c', PYTHON_VERSION_PROGRAM],
        cwd: workspace.root,
        sandboxPolicy: workspace.policy,
        env: commandEnvironment(this.config, false),
        signal,
        label: 'notebook Python version probe',
        failureCode: 'NOTEBOOK_ENVIRONMENT_BROKEN',
        category: 'python',
        logFailure: false,
      })
      const version = result.stdout.trim()
      return /^\d+\.\d+\.\d+$/.test(version) ? { executable, version, source } : undefined
    } catch {
      signal.throwIfAborted()
      return undefined
    }
  }

  private async probeEnvironment(
    workspace: OperationWorkspace,
    signal: AbortSignal,
    inspectUnmanaged: boolean,
  ): Promise<EnvironmentProbe> {
    const pythonExecutable = environmentPython(workspace.environmentPath)
    const info = await safeLstat(workspace.environmentPath)
    if (info === undefined) {
      return {
        kind: 'absent',
        environmentId: workspace.environmentId,
        pythonExecutable,
        ready: false,
        canAttach: false,
        owned: false,
        message: 'Create a Python 3.12 environment to run notebook cells.',
      }
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      return {
        kind: 'broken',
        environmentId: workspace.environmentId,
        pythonExecutable,
        ready: false,
        canAttach: false,
        owned: false,
        message: 'The workspace .venv is not a regular directory.',
      }
    }
    let sidecar: OwnershipSidecar | undefined
    try {
      sidecar = await readOwnershipSidecar(workspace.environmentPath)
    } catch {
      return {
        kind: 'broken',
        environmentId: workspace.environmentId,
        pythonExecutable,
        ready: false,
        canAttach: false,
        owned: false,
        message: 'The DSH environment ownership record is invalid.',
      }
    }
    if (sidecar?.environmentId !== undefined && sidecar.environmentId !== workspace.environmentId) {
      return {
        kind: 'broken',
        environmentId: workspace.environmentId,
        pythonExecutable,
        ready: false,
        canAttach: false,
        owned: false,
        message: 'The DSH environment ownership record belongs to another workspace.',
      }
    }
    const owned = sidecar !== undefined
    if (!owned && !inspectUnmanaged) {
      return {
        kind: 'unmanaged',
        environmentId: workspace.environmentId,
        pythonExecutable,
        ready: false,
        canAttach: false,
        owned: false,
        message: 'Inspect the existing workspace environment before explicitly attaching it.',
      }
    }
    const python = await this.tryPython(pythonExecutable, 'path', workspace, signal)
    if (python === undefined || !python.version.startsWith(`${PYTHON_LINE}.`)) {
      return {
        kind: 'broken',
        environmentId: workspace.environmentId,
        pythonExecutable,
        ...python === undefined ? {} : { pythonVersion: python.version },
        ready: false,
        canAttach: false,
        owned,
        message: owned
          ? 'The DSH-owned workspace environment must be rebuilt with Python 3.12.'
          : 'The workspace .venv must use Python 3.12.',
      }
    }
    if (sidecar === undefined) {
      return {
        kind: 'unmanaged',
        environmentId: workspace.environmentId,
        pythonExecutable,
        pythonVersion: python.version,
        ready: false,
        canAttach: true,
        owned: false,
        message: 'Attach the existing Python 3.12 environment before DSH installs notebook dependencies.',
      }
    }
    const ready = await this.dependenciesReady(pythonExecutable, workspace, signal)
    return {
      kind: 'managed',
      environmentId: workspace.environmentId,
      pythonExecutable,
      pythonVersion: python.version,
      ready,
      canAttach: true,
      owned: true,
      ...ready ? {} : { message: 'The pinned notebook dependencies need repair.' },
    }
  }

  private async dependenciesReady(
    pythonExecutable: string,
    workspace: OperationWorkspace,
    signal: AbortSignal,
  ): Promise<boolean> {
    try {
      await this.verifyDependencies(pythonExecutable, workspace, signal)
      return true
    } catch {
      signal.throwIfAborted()
      return false
    }
  }

  private async verifyDependencies(
    pythonExecutable: string,
    workspace: OperationWorkspace,
    signal: AbortSignal,
  ): Promise<void> {
    const result = await this.runner.run({
      argv: [pythonExecutable, '-I', '-c', DEPENDENCY_PROBE_PROGRAM],
      cwd: workspace.root,
      sandboxPolicy: workspace.policy,
      env: commandEnvironment(this.config, false),
      signal,
      label: 'notebook dependency probe',
      failureCode: 'NOTEBOOK_ENVIRONMENT_DEPENDENCY_FAILED',
      category: 'dependency',
      logFailure: false,
    })
    let value: unknown
    try {
      value = JSON.parse(result.stdout)
    } catch (cause) {
      throw environmentError(
        'The notebook dependency probe returned invalid data.',
        'NOTEBOOK_ENVIRONMENT_DEPENDENCY_FAILED',
        'dependency',
        false,
        cause,
      )
    }
    if (!isRecord(value)
      || value.ipykernel !== IPYKERNEL_VERSION
      || value.jupyter_client !== JUPYTER_CLIENT_VERSION
      || value.kernel !== true) {
      throw environmentError(
        'The environment does not contain the pinned Jupyter dependencies and python3 kernelspec.',
        'NOTEBOOK_ENVIRONMENT_KERNELSPEC_MISSING',
        'kernelspec',
        true,
      )
    }
  }

  private async createEnvironment(
    uv: string,
    python: string,
    workspace: OperationWorkspace,
    signal: AbortSignal,
  ): Promise<void> {
    const staged = await this.buildStagedEnvironment(uv, python, workspace, signal)
    try {
      if (await pathExists(workspace.environmentPath)) {
        throw environmentError(
          'The workspace .venv appeared while provisioning was in progress.',
          'NOTEBOOK_ENVIRONMENT_BUSY',
          'dependency',
          true,
        )
      }
      await rename(staged.path, workspace.environmentPath)
    } catch (operationError) {
      try {
        const retained = await retainOwnedStaging(
          workspace.root,
          staged.path,
          workspace.environmentId,
        )
        if (retained) this.warnRetainedResidue()
      } catch (cleanupError) {
        throw preserveEnvironmentFailure(operationError, cleanupError, 'The environment staging directory could not be retained safely.')
      }
      throw operationError
    }
    await removePublishedStagingMarker(this.ctx, staged.markerPath)
  }

  private async rebuildEnvironment(
    uv: string,
    python: string,
    workspace: OperationWorkspace,
    signal: AbortSignal,
  ): Promise<void> {
    const staged = await this.buildStagedEnvironment(uv, python, workspace, signal)
    const backup = join(workspace.root, `${REBUILD_BACKUP_PREFIX}${randomUUID()}`)
    let oldMoved = false
    try {
      signal.throwIfAborted()
      if (!(await isOwnedEnvironmentDirectory(workspace.environmentPath, workspace.environmentId))) {
        throw environmentError(
          'The workspace environment no longer has a matching DSH ownership record.',
          'NOTEBOOK_ENVIRONMENT_REBUILD_REQUIRED',
          'permission',
          false,
        )
      }
      await rename(workspace.environmentPath, backup)
      oldMoved = true
      await rename(staged.path, workspace.environmentPath)
    } catch (operationError) {
      let failure = operationError
      /* v8 ignore start -- this rollback needs a second writer to occupy the environment between the two adjacent atomic renames. */
      if (oldMoved && !(await pathExists(workspace.environmentPath))) {
        try {
          await rename(backup, workspace.environmentPath)
        } catch (restoreError) {
          failure = preserveEnvironmentFailure(failure, restoreError, 'The previous environment could not be restored after rebuild failure.')
        }
      }
      /* v8 ignore stop */
      try {
        const retained = await retainOwnedStaging(
          workspace.root,
          staged.path,
          workspace.environmentId,
        )
        if (retained) this.warnRetainedResidue()
      } catch (cleanupError) {
        /* v8 ignore next -- staged-cleanup failure after a rebuild failure requires an independent namespace mutation during rollback. */
        failure = preserveEnvironmentFailure(failure, cleanupError, 'The rebuild staging directory could not be retained safely.')
      }
      throw failure
    }
    await removePublishedStagingMarker(this.ctx, staged.markerPath)
    try {
      const retained = await retainOwnedRebuildBackup(
        workspace.root,
        backup,
        workspace.environmentId,
      )
      if (retained) this.warnRetainedResidue()
    } catch {
      /* v8 ignore next -- post-publication cleanup failure needs a concurrent mutation or host filesystem failure. */
      this.ctx.logger.warn('notebook environment rebuild left an owned backup for recovery')
    }
  }

  private async buildStagedEnvironment(
    uv: string,
    python: string,
    workspace: OperationWorkspace,
    signal: AbortSignal,
  ): Promise<StagedEnvironment> {
    const staging = join(workspace.root, `${STAGING_PREFIX}${randomUUID()}`)
    const markerPath = await writeStagingMarker(staging, workspace.environmentId)
    try {
      await this.runUv(uv, workspace, signal, [
        'venv', '--relocatable', '--python', python, staging,
      ], {
        downloads: 'never',
        label: 'notebook environment creation',
        failureCode: 'NOTEBOOK_ENVIRONMENT_PROVISION_FAILED',
        category: 'python',
      })
      const stagingPython = environmentPython(staging)
      await this.installDependencies(uv, stagingPython, workspace, signal)
      await this.verifyDependencies(stagingPython, { ...workspace, environmentPath: staging }, signal)
      await writeOwnershipSidecar(staging, workspace.environmentId)
      return { path: staging, markerPath }
    } catch (operationError) {
      try {
        const retained = await retainOwnedStaging(
          workspace.root,
          staging,
          workspace.environmentId,
        )
        if (retained) this.warnRetainedResidue()
      } catch (cleanupError) {
        throw preserveEnvironmentFailure(operationError, cleanupError, 'The environment staging directory could not be retained safely.')
      }
      throw operationError
    }
  }

  private installDependencies(
    uv: string,
    python: string,
    workspace: OperationWorkspace,
    signal: AbortSignal,
  ): Promise<void> {
    return this.runUv(uv, workspace, signal, [
      'pip', 'install',
      '--python', python,
      '--require-hashes',
      '--no-deps',
      '--only-binary', ':all:',
      '-r', REQUIREMENTS_PATH,
    ], {
      downloads: 'never',
      label: 'notebook dependency installation',
      failureCode: 'NOTEBOOK_ENVIRONMENT_DEPENDENCY_FAILED',
      category: 'dependency',
    }).then(() => undefined)
  }

  private runUv(
    executable: string,
    workspace: OperationWorkspace,
    signal: AbortSignal,
    args: readonly string[],
    options: {
      readonly downloads: 'manual' | 'never'
      readonly label: string
      readonly failureCode: Parameters<typeof environmentError>[1]
      readonly category: NotebookEnvironmentErrorCategory
      readonly logFailure?: boolean
    },
  ) {
    return this.runner.run({
      argv: [executable, ...args],
      cwd: workspace.root,
      sandboxPolicy: workspace.policy,
      env: commandEnvironment(this.config, options.downloads === 'manual'),
      signal,
      label: options.label,
      failureCode: options.failureCode,
      category: options.category,
      ...options.logFailure === undefined ? {} : { logFailure: options.logFailure },
    })
  }

  private warnRetainedResidue(): void {
    this.ctx.logger.warn('notebook environment retained an owned residue for manual removal')
  }

  private async tryResolveExecutable(command: string, signal: AbortSignal): Promise<string | undefined> {
    try {
      return await this.ctx.subprocess.resolveExecutable(command, lookupEnvironment(this.config), signal)
    } catch {
      signal.throwIfAborted()
      return undefined
    }
  }

  private runOperation<T>(
    callerSignal: AbortSignal,
    timeoutCategory: NotebookEnvironmentErrorCategory,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.disposed) {
      return Promise.reject(environmentError(
        'The notebook environment manager is disposed.',
        'NOTEBOOK_ENVIRONMENT_BROKEN',
        'manager',
        false,
      ))
    }
    if (callerSignal.aborted) {
      return Promise.reject(errorFromReason(callerSignal.reason, 'notebook environment operation cancelled'))
    }
    const timeout = new AbortController()
    const timer = setTimeout(() => {
      timeout.abort(new Error('notebook environment operation timed out'))
    }, this.config.operationTimeoutMs)
    const signal = AbortSignal.any([callerSignal, this.lifetime.signal, timeout.signal])
    let finish!: () => void
    const finished = new Promise<void>((resolveFinished) => { finish = resolveFinished })
    this.operations.add(finished)
    const result = (async () => {
      try {
        return await operation(signal)
      } catch (error) {
        callerSignal.throwIfAborted()
        if (timeout.signal.aborted) {
          throw environmentError(
            'The notebook environment operation exceeded its configured deadline.',
            'NOTEBOOK_ENVIRONMENT_TIMEOUT',
            timeoutCategory,
            true,
            error,
          )
        }
        if (this.lifetime.signal.aborted) {
          throw environmentError(
            'The notebook environment manager stopped before the operation completed.',
            'NOTEBOOK_ENVIRONMENT_BROKEN',
            'manager',
            true,
            error,
          )
        }
        if (error instanceof NotebookEnvironmentError) throw error
        throw environmentError(
          'The notebook environment operation failed.',
          'NOTEBOOK_ENVIRONMENT_BROKEN',
          timeoutCategory,
          false,
          error,
        )
      } finally {
        clearTimeout(timer)
        finish()
        this.operations.delete(finished)
      }
    })()
    return result
  }
}

function resolveConfig(config: Config): ResolvedConfig {
  return {
    ...config.uvExecutable === undefined ? {} : { uvExecutable: config.uvExecutable },
    ...config.pythonExecutable === undefined ? {} : { pythonExecutable: config.pythonExecutable },
    dshHome: resolveDshHome(config.dshHome),
    operationTimeoutMs: config.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS,
    maxOutputBytes: config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    maxDownloadBytes: config.maxDownloadBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES,
    graceMs: config.graceMs ?? DEFAULT_GRACE_MS,
  }
}

function environmentError(
  message: string,
  code: ConstructorParameters<typeof NotebookEnvironmentError>[1],
  category: NotebookEnvironmentErrorCategory,
  retryable: boolean,
  cause?: unknown,
): NotebookEnvironmentError {
  return new NotebookEnvironmentError(
    message,
    code,
    category,
    retryable,
    cause === undefined ? undefined : { cause },
  )
}

function errorFromReason(reason: unknown, message: string): Error {
  return reason instanceof Error ? reason : new Error(message, { cause: reason })
}

function requireWorkspaceWritePermission(policy: SandboxExecutionPolicy): void {
  if (policy.mode === 'read-only') {
    throw environmentError(
      'Creating or attaching an environment requires workspace-write permission.',
      'NOTEBOOK_ENVIRONMENT_PERMISSION_REQUIRED',
      'permission',
      false,
    )
  }
}

function requirePrivateInstallPermission(policy: SandboxExecutionPolicy): void {
  if (policy.mode !== 'danger-full-access') {
    throw environmentError(
      'Installing private runtime components requires danger-full-access permission.',
      'NOTEBOOK_ENVIRONMENT_PERMISSION_REQUIRED',
      'permission',
      false,
    )
  }
}

function environmentIdFor(workspaceRoot: string) {
  /* v8 ignore next -- Windows coverage exercises case-folding; POSIX CI exercises case-sensitive identity. */
  const identity = process.platform === 'win32' ? normalize(workspaceRoot).toLowerCase() : normalize(workspaceRoot)
  const digest = createHash('sha256').update(`uv-workspace-v1\0${identity}`).digest('hex').slice(0, 32)
  return NotebookEnvironmentId(`uv:${digest}`)
}

function pythonId(executable: string, source: NotebookPythonSource): string {
  /* v8 ignore next -- Windows coverage exercises case-folding; POSIX CI exercises case-sensitive identity. */
  const identity = process.platform === 'win32' ? normalize(executable).toLowerCase() : normalize(executable)
  return `python:${source}:${createHash('sha256').update(identity).digest('hex').slice(0, 24)}`
}

function pythonSource(executable: string, dshHome: string): NotebookPythonSource {
  const inside = relative(resolve(dshHome, 'tools', 'python'), resolve(executable))
  return inside !== '' && !inside.startsWith('..') && !isAbsolute(inside) ? 'managed' : 'path'
}

function assertEnvironmentId(workspace: OperationWorkspace, selected: ReturnType<typeof NotebookEnvironmentId>): void {
  if (selected !== workspace.environmentId) {
    throw environmentError(
      'The selected environment does not belong to this workspace.',
      'NOTEBOOK_ENVIRONMENT_UNKNOWN',
      'permission',
      false,
    )
  }
}

function environmentPython(environmentPath: string): string {
  /* v8 ignore next -- Windows coverage exercises Scripts; POSIX CI exercises bin. */
  return process.platform === 'win32'
    ? join(environmentPath, 'Scripts', 'python.exe')
    : join(environmentPath, 'bin', 'python')
}

function catalogEntry(probe: EnvironmentProbe, provisioning: boolean): NotebookEnvironmentCatalogEntry {
  return {
    id: probe.environmentId,
    displayName: 'Workspace Python (.venv)',
    status: provisioning
      ? 'provisioning'
      : probe.kind === 'broken'
        ? 'broken'
        : probe.ready
          ? 'ready'
          : 'setup-required',
    ...probe.pythonVersion === undefined ? {} : { pythonVersion: probe.pythonVersion },
    managed: probe.owned,
  }
}

function commandEnvironment(config: ResolvedConfig, allowPythonInstall: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of Object.keys(process.env)) {
    const upper = key.toUpperCase()
    if (upper.startsWith('UV_')
      || upper.startsWith('PIP_')
      || upper.startsWith('PYTHON')
      || upper.startsWith('JUPYTER_')
      || upper.startsWith('IPYTHON')
      || upper === 'VIRTUAL_ENV'
      || upper === 'CONDA_PREFIX') env[key] = undefined
  }
  return {
    ...env,
    NO_COLOR: '1',
    TERM: 'dumb',
    PAGER: 'cat',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONUNBUFFERED: '1',
    UV_NO_CACHE: '1',
    UV_NO_CONFIG: '1',
    UV_NO_SYSTEM_CONFIG: '1',
    UV_NO_PROJECT: '1',
    UV_NO_ENV_FILE: '1',
    UV_NO_MODIFY_PATH: '1',
    UV_NO_PROGRESS: '1',
    UV_NO_WRAP: '1',
    UV_PYTHON_DOWNLOADS: allowPythonInstall ? 'manual' : 'never',
    UV_PYTHON_INSTALL_DIR: join(config.dshHome, 'tools', 'python'),
    UV_PYTHON_INSTALL_BIN: '0',
    UV_PYTHON_INSTALL_REGISTRY: '0',
  }
}

function lookupEnvironment(config: ResolvedConfig): Readonly<Record<string, string>> {
  const entries = Object.entries(commandEnvironment(config, false))
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
  return Object.fromEntries(entries)
}

async function readOwnershipSidecar(environmentPath: string): Promise<OwnershipSidecar | undefined> {
  let source: string
  try {
    source = await readFile(join(environmentPath, SIDECAR_FILE), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const value = JSON.parse(source) as unknown
  if (!isRecord(value)
    || value.schemaVersion !== SIDECAR_VERSION
    || value.provider !== 'uv'
    || typeof value.environmentId !== 'string'
    || value.python !== PYTHON_LINE
    || !isRecord(value.dependencies)
    || value.dependencies.jupyterClient !== JUPYTER_CLIENT_VERSION
    || value.dependencies.ipykernel !== IPYKERNEL_VERSION) {
    throw new Error('invalid notebook environment sidecar')
  }
  return value as unknown as OwnershipSidecar
}

async function writeOwnershipSidecar(
  environmentPath: string,
  environmentId: ReturnType<typeof NotebookEnvironmentId>,
): Promise<void> {
  const sidecar: OwnershipSidecar = {
    schemaVersion: 1,
    provider: 'uv',
    environmentId,
    python: '3.12',
    dependencies: {
      jupyterClient: '8.9.1',
      ipykernel: '7.3.0',
    },
  }
  await writeFileAtomic(
    join(environmentPath, SIDECAR_FILE),
    `${JSON.stringify(sidecar, undefined, 2)}\n`,
    { mode: 0o600 },
  )
}

async function writeStagingMarker(
  staging: string,
  environmentId: ReturnType<typeof NotebookEnvironmentId>,
): Promise<string> {
  const markerPath = `${staging}${STAGING_MARKER_SUFFIX}`
  const marker: StagingMarker = {
    schemaVersion: 1,
    provider: 'uv',
    kind: 'staging',
    environmentId,
    stagingName: basename(staging),
  }
  await writeFileAtomic(markerPath, `${JSON.stringify(marker, undefined, 2)}\n`, { mode: 0o600 })
  return markerPath
}

async function readStagingMarker(
  staging: string,
  environmentId: ReturnType<typeof NotebookEnvironmentId>,
): Promise<StagingMarker | undefined> {
  const markerPath = `${staging}${STAGING_MARKER_SUFFIX}`
  const info = await safeLstat(markerPath)
  if (info === undefined || info.isSymbolicLink() || !info.isFile()) return undefined
  let value: unknown
  try {
    value = JSON.parse(await readFile(markerPath, 'utf8')) as unknown
  } catch {
    return undefined
  }
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || value.provider !== 'uv'
    || value.kind !== 'staging'
    || value.environmentId !== environmentId
    || value.stagingName !== basename(staging)) return undefined
  return value as unknown as StagingMarker
}

async function removePublishedStagingMarker(ctx: Context, markerPath: string): Promise<void> {
  try {
    await unlink(markerPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      ctx.logger.warn('notebook environment publish left an owned staging marker for recovery')
    }
  }
}

async function isOwnedEnvironmentDirectory(
  path: string,
  environmentId: ReturnType<typeof NotebookEnvironmentId>,
): Promise<boolean> {
  const info = await safeLstat(path)
  if (info === undefined || info.isSymbolicLink() || !info.isDirectory()) return false
  try {
    const sidecar = await readOwnershipSidecar(path)
    return sidecar?.environmentId === environmentId
  } catch {
    return false
  }
}

async function recoverOwnedResidue(
  workspace: OperationWorkspace,
  onRetained: () => void,
): Promise<void> {
  const entries = await readdir(workspace.root, { withFileTypes: true })
  let reported = false
  const reportRetained = () => {
    if (reported) return
    reported = true
    onRetained()
  }
  if (entries.some(entry => entry.name.startsWith(RETAINED_RESIDUE_PREFIX))) reportRetained()
  for (const entry of entries) {
    if (!entry.name.startsWith(STAGING_PREFIX) || !entry.name.endsWith(STAGING_MARKER_SUFFIX)) continue
    const stagingName = entry.name.slice(0, -STAGING_MARKER_SUFFIX.length)
    const staging = join(workspace.root, stagingName)
    if (await readStagingMarker(staging, workspace.environmentId) !== undefined) {
      if (await retainOwnedStaging(workspace.root, staging, workspace.environmentId)) reportRetained()
    }
  }

  const backups: string[] = []
  for (const entry of entries) {
    if (!entry.name.startsWith(REBUILD_BACKUP_PREFIX)) continue
    const backup = join(workspace.root, entry.name)
    if (await isOwnedEnvironmentDirectory(backup, workspace.environmentId)) backups.push(backup)
  }
  const environmentInfo = await safeLstat(workspace.environmentPath)
  if (environmentInfo === undefined) {
    if (backups.length > 1) {
      throw environmentError(
        'Multiple owned rebuild backups require manual recovery.',
        'NOTEBOOK_ENVIRONMENT_BROKEN',
        'dependency',
        false,
      )
    }
    const [backup] = backups
    if (backup !== undefined) await rename(backup, workspace.environmentPath)
    return
  }
  if (!(await isOwnedEnvironmentDirectory(workspace.environmentPath, workspace.environmentId))) return
  for (const backup of backups) {
    if (await retainOwnedRebuildBackup(workspace.root, backup, workspace.environmentId)) reportRetained()
  }
}

async function withExclusiveFileLock<T>(
  lockPath: string,
  ownerId: string,
  signal: AbortSignal,
  operation: () => Promise<T>,
): Promise<T> {
  signal.throwIfAborted()
  const record: LockRecord = {
    schemaVersion: 1,
    ownerId,
    nonce: randomUUID(),
    pid: process.pid,
    processStartedAtMs: PROCESS_STARTED_AT_MS,
  }
  const content = `${JSON.stringify(record)}\n`
  try {
    await acquireExclusiveFileLock(lockPath, content)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 })
      try {
        await acquireExclusiveFileLock(lockPath, content)
      } catch (retryCause) {
        /* v8 ignore start -- another process must alter the lock after this process creates its parent. */
        if ((retryCause as NodeJS.ErrnoException).code !== 'EEXIST'
          || !(await recoverStaleLock(lockPath))) throw lockError(retryCause)
        try {
          await acquireExclusiveFileLock(lockPath, content)
        } catch (recoveryCause) {
          throw lockError(recoveryCause)
        }
        /* v8 ignore stop */
      }
    } else {
      if ((cause as NodeJS.ErrnoException).code !== 'EEXIST'
        || !(await recoverStaleLock(lockPath))) throw lockError(cause)
      try {
        await acquireExclusiveFileLock(lockPath, content)
      } catch (recoveryCause) {
        /* v8 ignore next -- another process must acquire the lock after stale recovery and before this adjacent retry. */
        throw lockError(recoveryCause)
      }
    }
  }
  let result: T
  try {
    result = await operation()
  } catch (operationError) {
    try {
      await releaseOwnedLock(lockPath, content)
    } catch (cleanupError) {
      throw preserveEnvironmentFailure(operationError, cleanupError, 'The environment lock could not be released.')
    }
    throw operationError
  }
  try {
    await releaseOwnedLock(lockPath, content)
  } catch (cleanupError) {
    throw environmentError(
      'The environment operation completed, but its lock could not be released.',
      'NOTEBOOK_ENVIRONMENT_BROKEN',
      'dependency',
      false,
      cleanupError,
    )
  }
  return result
}

async function acquireExclusiveFileLock(lockPath: string, content: string): Promise<void> {
  await writeFile(lockPath, content, { flag: 'wx', mode: 0o600 })
}

async function recoverStaleLock(lockPath: string): Promise<boolean> {
  const info = await safeLstat(lockPath)
  /* v8 ignore next -- exclusive-create saw this entry; only a concurrent namespace swap reaches the guard. */
  if (info === undefined || info.isSymbolicLink() || !info.isFile()) return false
  let content: string
  let value: unknown
  try {
    content = await readFile(lockPath, 'utf8')
    value = JSON.parse(content) as unknown
  } catch {
    return false
  }
  if (!isLockRecord(value) || !isStaleLockRecord(value)) return false
  try {
    /* v8 ignore next -- a different writer must replace the lock between the adjacent verified reads. */
    if (await readFile(lockPath, 'utf8') !== content) return false
    await unlink(lockPath)
    return true
  } catch (error) {
    /* v8 ignore start -- unlink failure here requires a concurrent mutation or host filesystem failure. */
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
    return false
    /* v8 ignore stop */
  }
}

function isLockRecord(value: unknown): value is LockRecord {
  return isRecord(value)
    && value.schemaVersion === 1
    && typeof value.ownerId === 'string'
    && value.ownerId.length > 0
    && typeof value.nonce === 'string'
    && value.nonce.length > 0
    && Number.isSafeInteger(value.pid)
    && (value.pid as number) > 0
    && Number.isSafeInteger(value.processStartedAtMs)
    && (value.processStartedAtMs as number) > 0
}

function isStaleLockRecord(record: LockRecord): boolean {
  if (record.pid === process.pid) {
    return record.processStartedAtMs !== PROCESS_STARTED_AT_MS || !ACTIVE_LOCK_OWNERS.has(record.ownerId)
  }
  try {
    process.kill(record.pid, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

async function releaseOwnedLock(lockPath: string, content: string): Promise<void> {
  try {
    if (await readFile(lockPath, 'utf8') === content) await unlink(lockPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

function preserveEnvironmentFailure(
  operationError: unknown,
  cleanupError: unknown,
  cleanupMessage: string,
): NotebookEnvironmentError {
  if (operationError instanceof NotebookEnvironmentError) {
    return new NotebookEnvironmentError(
      operationError.message,
      operationError.code,
      operationError.category,
      operationError.retryable,
      { cause: new AggregateError([operationError, cleanupError], cleanupMessage) },
    )
  }
  return environmentError(
    cleanupMessage,
    'NOTEBOOK_ENVIRONMENT_BROKEN',
    'dependency',
    false,
    new AggregateError([operationError, cleanupError], cleanupMessage),
  )
}

function lockError(cause: unknown): NotebookEnvironmentError {
  return environmentError(
    'Another process is already provisioning this environment.',
    'NOTEBOOK_ENVIRONMENT_BUSY',
    'dependency',
    true,
    cause,
  )
}

async function removeReplaceableFile(path: string): Promise<void> {
  const info = await safeLstat(path)
  if (info === undefined) return
  if (info.isDirectory() && !info.isSymbolicLink()) {
    throw environmentError(
      'The private uv executable location is occupied by a directory.',
      'NOTEBOOK_ENVIRONMENT_MANAGER_INTEGRITY',
      'manager',
      false,
    )
  }
  await rm(path, { force: true })
}

async function retainOwnedStaging(
  workspaceRoot: string,
  staging: string,
  environmentId: ReturnType<typeof NotebookEnvironmentId>,
): Promise<boolean> {
  const root = resolve(workspaceRoot)
  const target = resolve(staging)
  /* v8 ignore start -- all callers pass a UUID staging child constructed in this module. */
  if (dirname(target) !== root || !basename(target).startsWith(STAGING_PREFIX)) {
    throw new Error('refusing to clean an unowned notebook environment staging path')
  }
  /* v8 ignore stop */
  if (await readStagingMarker(target, environmentId) === undefined) {
    throw new Error('refusing to clean notebook environment staging without its ownership marker')
  }
  const markerPath = `${target}${STAGING_MARKER_SUFFIX}`
  const residue = join(root, `${RETAINED_RESIDUE_PREFIX}${randomUUID()}`)
  const residueMarker = await writeStagingMarker(residue, environmentId)
  try {
    await rename(target, residue)
  } catch (error) {
    await unlinkIfPresent(residueMarker)
    /* v8 ignore next -- non-ENOENT rename failure requires a host filesystem failure after marker verification. */
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await unlinkIfPresent(markerPath)
    return false
  }
  await unlinkIfPresent(markerPath)
  return true
}

async function retainOwnedRebuildBackup(
  workspaceRoot: string,
  backup: string,
  environmentId: ReturnType<typeof NotebookEnvironmentId>,
): Promise<boolean> {
  const root = resolve(workspaceRoot)
  const target = resolve(backup)
  /* v8 ignore start -- all callers pass a UUID backup child constructed or selected by this module. */
  if (dirname(target) !== root || !basename(target).startsWith(REBUILD_BACKUP_PREFIX)) {
    throw new Error('refusing to clean an unowned notebook environment rebuild backup')
  }
  /* v8 ignore stop */
  const residue = join(root, `${RETAINED_RESIDUE_PREFIX}${randomUUID()}`)
  await rename(target, residue)
  /* v8 ignore start -- only another workspace writer can change ownership after the atomic residue rename. */
  if (!(await isOwnedEnvironmentDirectory(residue, environmentId))) {
    try {
      if (!(await pathExists(target))) await rename(residue, target)
    } catch (cause) {
      throw new Error('the rebuild backup changed ownership during retention and could not be restored', { cause })
    }
    throw new Error('the rebuild backup changed ownership during retention')
  }
  /* v8 ignore stop */
  return true
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (error) {
    /* v8 ignore next -- callers use this only for optional owned markers; other failures are host filesystem error dialects. */
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

async function safeLstat(path: string) {
  try {
    return await lstat(path)
  } catch (error) {
    /* v8 ignore next -- provider-level error wrapping owns host filesystem failures other than absence. */
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    /* v8 ignore next -- provider-level error wrapping owns host filesystem failures other than absence. */
    throw error
  }
}

async function pathExists(path: string): Promise<boolean> {
  return await safeLstat(path) !== undefined
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = normalize(left)
  const normalizedRight = normalize(right)
  /* v8 ignore next -- Windows coverage exercises case-insensitive equality; POSIX CI exercises the peer. */
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight
}

async function isWorkspaceEnvironmentExecutable(executable: string, environmentPath: string): Promise<boolean> {
  if (isWithinPath(environmentPath, executable)) return true
  let canonicalEnvironment: string
  let canonicalExecutable: string
  try {
    [canonicalEnvironment, canonicalExecutable] = await Promise.all([
      realpath(environmentPath),
      realpath(executable),
    ])
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT'
  }
  return isWithinPath(canonicalEnvironment, canonicalExecutable)
}

function isWithinPath(root: string, candidate: string): boolean {
  const inside = relative(resolve(root), resolve(candidate))
  return inside === '' || (!inside.startsWith('..') && !isAbsolute(inside))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export default UvNotebookEnvironmentManager
