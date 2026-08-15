import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { NotebookId } from '@younthing/dsh-notebook-core'
import UvNotebookEnvironmentManager from '@younthing/dsh-notebook-environment-uv'
import { JupyterKernelBackend } from '@younthing/dsh-notebook-kernel-jupyter'
import LocalSandboxProvider from '@deepseek-ai/dsh-sandbox-local'
import { SessionId } from '@deepseek-ai/dsh-session'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'

const REAL_ENVIRONMENT_E2E = process.env.DSH_NOTEBOOK_REAL_E2E === '1'
const REAL_ENVIRONMENT_TIMEOUT_MS = 20 * 60 * 1_000

it.skipIf(!REAL_ENVIRONMENT_E2E)(
  'provisions a real uv environment, runs its Jupyter kernel, and preserves project metadata',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-notebook-real-environment-'))
    const workspaceRoot = join(root, 'workspace')
    const dshHome = join(root, 'dsh-home')
    const externalPath = join(root, 'outside-workspace.txt')
    const projectFiles = new Map([
      ['pyproject.toml', '[project]\nname = "notebook-e2e-sentinel"\nversion = "0"\n'],
      ['uv.lock', 'version = 1\nrevision = 1\n'],
      ['requirements.txt', 'sentinel==0\n'],
    ])
    await mkdir(workspaceRoot)
    await writeFile(externalPath, 'preserve')
    await Promise.all([...projectFiles].map(([name, content]) => writeFile(join(workspaceRoot, name), content)))

    const ctx = new Context()
    let backend: JupyterKernelBackend | undefined
    let handle: Awaited<ReturnType<JupyterKernelBackend['start']>> | undefined
    try {
      await ctx.plugin(LocalSubprocessRuntime)
      await ctx.plugin(LocalSandboxProvider)
      await ctx.plugin(UvNotebookEnvironmentManager, {
        dshHome,
        operationTimeoutMs: 15 * 60 * 1_000,
        maxOutputBytes: 256 * 1_024,
        maxDownloadBytes: 64 * 1_024 * 1_024,
        graceMs: 3_000,
      })
      const signal = new AbortController().signal
      const elevatedPolicy = { mode: 'danger-full-access', workspaceRoot } as const
      let catalog = await ctx.notebookEnvironments.environmentCatalog({
        workspaceRoot,
        sandboxPolicy: elevatedPolicy,
        signal,
      })
      if (catalog.manager.status !== 'ready') {
        catalog = await ctx.notebookEnvironments.installUv({
          workspaceRoot,
          sandboxPolicy: elevatedPolicy,
          signal,
        })
      }
      expect(catalog.manager.status).toBe('ready')

      catalog = await ctx.notebookEnvironments.installPython({
        workspaceRoot,
        sandboxPolicy: elevatedPolicy,
        version: '3.12',
        signal,
      })
      expect(catalog.pythons.some(python => python.version.startsWith('3.12.'))).toBe(true)

      const environmentId = catalog.environments[0]!.id
      const sessionId = SessionId('notebook-real-environment')
      const confinedPolicy = { mode: 'workspace-write', workspaceRoot, sessionId } as const
      await expect(ctx.notebookEnvironments.provision({
        workspaceRoot,
        sandboxPolicy: confinedPolicy,
        environmentId,
        allowExisting: false,
        rebuild: false,
        signal,
      })).resolves.toMatchObject({ status: 'ready', managed: true })

      backend = new JupyterKernelBackend(ctx, {
        startupTimeoutMs: 60_000,
        executionTimeoutMs: 30_000,
        interruptTimeoutMs: 5_000,
        responseGraceMs: 2_000,
        inspectTimeoutMs: 30_000,
        shutdownTimeoutMs: 10_000,
        graceMs: 3_000,
        maxStderrBytes: 64 * 1_024,
        maxCellOutputBytes: 1 * 1_024 * 1_024,
        maxInspectBytes: 1 * 1_024 * 1_024,
        maxResponseBytes: 2 * 1_024 * 1_024,
      })
      handle = await backend.start({
        sessionId,
        notebookId: NotebookId('notebook-real-environment'),
        environmentId,
        backend: 'jupyter',
        kernelName: 'python3',
        cwd: workspaceRoot,
        sandboxPolicy: confinedPolicy,
        signal,
      })

      const events = []
      for await (const event of backend.execute(handle, 'answer = 6 * 7\nprint("REAL_NOTEBOOK_OK", answer)', signal)) {
        events.push(event)
      }
      expect(JSON.stringify(events)).toContain('REAL_NOTEBOOK_OK')
      expect(JSON.stringify(events)).toContain('42')
      await expect(backend.inspect(handle, 'answer', signal)).resolves.toContain('42')

      const encodedExternalPath = Buffer.from(externalPath).toString('base64')
      const denialEvents = []
      const denialProgram = [
        'import base64',
        'from pathlib import Path',
        `outside = Path(base64.b64decode("${encodedExternalPath}").decode())`,
        'try:',
        '    outside.write_text("escaped")',
        '    print("EXTERNAL_WRITE_ALLOWED")',
        'except OSError:',
        '    print("EXTERNAL_WRITE_DENIED")',
      ].join('\n')
      for await (const event of backend.execute(handle, denialProgram, signal)) denialEvents.push(event)
      expect(JSON.stringify(denialEvents)).toContain('EXTERNAL_WRITE_DENIED')
      expect(JSON.stringify(denialEvents)).not.toContain('EXTERNAL_WRITE_ALLOWED')
      await expect(readFile(externalPath, 'utf8')).resolves.toBe('preserve')

      await backend.shutdown(handle, signal)
      handle = undefined
      for (const [name, content] of projectFiles) {
        await expect(readFile(join(workspaceRoot, name), 'utf8')).resolves.toBe(content)
      }
      expect(await readdir(workspaceRoot)).toEqual(expect.arrayContaining([
        '.venv',
        'pyproject.toml',
        'requirements.txt',
        'uv.lock',
      ]))
      await expect(readFile(join(workspaceRoot, '.venv', '.dsh-notebook-environment.json'), 'utf8'))
        .resolves.toContain('"provider": "uv"')
    } finally {
      if (backend !== undefined && handle !== undefined) {
        await backend.shutdown(handle, new AbortController().signal).catch(() => undefined)
      }
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  },
  REAL_ENVIRONMENT_TIMEOUT_MS,
)
