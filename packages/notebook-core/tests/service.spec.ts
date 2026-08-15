import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import NotebookService, { MemoryKernelBackend } from '@younthing/dsh-notebook-core'
import { NotebookEnvironmentId } from '@younthing/dsh-notebook-environment'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import { TestAttachmentStore, TestFileSystem } from './helpers.ts'

type LimitConfigKey =
  | 'maxDocumentBytes'
  | 'maxDocumentImages'
  | 'maxOutputBytes'
  | 'maxOutputItems'
  | 'maxExecutionImages'
  | 'maxInspectBytes'

const LIMIT_CONFIGS = [
  ['maxDocumentBytes', 1, 256 * 1024 * 1024],
  ['maxDocumentImages', 0, 4_096],
  ['maxOutputBytes', 1_024, 64 * 1024 * 1024],
  ['maxOutputItems', 1, 4_096],
  ['maxExecutionImages', 0, 256],
  ['maxInspectBytes', 1, 4 * 1024 * 1024],
] as const satisfies readonly (readonly [LimitConfigKey, number, number])[]

async function configContext(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SandboxPolicyService, { mode: 'danger-full-access' })
  await ctx.plugin(TestAttachmentStore)
  await ctx.plugin(TestFileSystem)
  return ctx
}

async function memoryContext(): Promise<Context> {
  const ctx = await configContext()
  await ctx.plugin(NotebookService)
  ctx.notebooks.registerBackend(new MemoryKernelBackend())
  return ctx
}

describe('NotebookService with MemoryKernelBackend', () => {
  it('keeps strict open, absent-only create, and detached document editing independent from kernels', async () => {
    const ctx = await configContext()
    await ctx.plugin(NotebookService)
    const session = Session.create(SessionId('detached-notebook'))

    await expect(ctx.notebooks.open(session, 'detached.ipynb'))
      .rejects.toMatchObject({ code: 'NOT_FOUND' })
    const created = await ctx.notebooks.create(session, 'detached.ipynb')
    expect(ctx.notebooks.runtimeStatus(session, created.id)).toEqual({ status: 'detached' })
    await expect(ctx.notebooks.create(session, 'detached.ipynb'))
      .rejects.toMatchObject({ code: 'ALREADY_EXISTS' })
    expect((await ctx.notebooks.open(session, 'detached.ipynb')).id).toBe(created.id)
    await expect(ctx.notebooks.execute(
      session,
      created.id,
      created.cells[0]!.id,
      { initiator: 'agent' },
    )).rejects.toMatchObject({ code: 'ENVIRONMENT_REQUIRED' })
    await expect(ctx.notebooks.inspect(session, created.id, 'value', { initiator: 'agent' }))
      .rejects.toMatchObject({ code: 'ENVIRONMENT_REQUIRED' })
    await ctx.notebooks.editCell(session, created.id, created.cells[0]!.id, 'value = 1')
    await ctx.fiber.dispose()
  })

  it('discovers bounded workspace pages without reading notebook content', async () => {
    const ctx = await configContext()
    await ctx.plugin(NotebookService, { discoveryPageSize: 1 })
    const fs = ctx.fs as TestFileSystem
    fs.putText('z.ipynb', 'not parsed')
    fs.putText('nested/a.ipynb', 'also not parsed')
    fs.putText('nested/readme.txt', 'ignored')
    fs.putText('.git/hidden.ipynb', 'ignored')
    fs.putText('.hg/hidden.ipynb', 'ignored')
    fs.putText('.ipynb_checkpoints/hidden.ipynb', 'ignored')
    fs.putText('.svn/hidden.ipynb', 'ignored')
    fs.putText('.venv/hidden.ipynb', 'ignored')
    fs.putText('node_modules/hidden.ipynb', 'ignored')
    const reads = fs.readCalls
    const session = Session.create(SessionId('discover-notebooks'))

    const first = await ctx.notebooks.discoverWorkspace(session)
    expect(first).toMatchObject({ items: [{ path: 'nested/a.ipynb' }], nextAfter: 'nested/a.ipynb' })
    await expect(ctx.notebooks.discoverWorkspace(session, { after: 'nested/a.ipynb' }))
      .resolves.toMatchObject({ items: [{ path: 'z.ipynb' }], partial: false })
    expect(fs.readCalls).toBe(reads)
    await ctx.fiber.dispose()
  })

  it('opens, edits, and executes without appending Harness session events', async () => {
    const ctx = await memoryContext()
    const session = Session.create(SessionId('agent-notebook'))
    const opened = await ctx.notebooks.create(session, 'demo.ipynb')
    expect(opened.cells).toHaveLength(1)
    expect(ctx.notebooks.get(session, opened.id)).toBe(opened)
    expect(ctx.notebooks.list(session)[0]).toBe(opened)
    const cellId = opened.cells[0]!.id
    await ctx.notebooks.attachEnvironment(session, opened.id, NotebookEnvironmentId('memory-env'), {
      backend: 'memory',
      initiator: 'agent',
    })

    const edited = await ctx.notebooks.editCell(session, opened.id, cellId, 'x = 41\nprint(x + 1)')
    expect(edited).not.toBe(opened)
    expect(ctx.notebooks.get(session, opened.id)).toBe(edited)
    const result = await ctx.notebooks.execute(session, opened.id, cellId, { initiator: 'agent' })
    expect(result.status).toBe('ok')
    expect(result.outputs.some(output => output.type === 'stream' && output.text.includes('42'))).toBe(true)

    expect(session.events).toEqual([])
    expect(ctx.notebooks.get(session, opened.id).cells[0]?.executionCount).toBe(1)
    expect(await ctx.notebooks.inspect(session, opened.id, 'x', { initiator: 'agent' })).toContain('41')
    await ctx.fiber.dispose()
  })

  it('rejects JavaScript syntax outside its scalar test dialect', async () => {
    const ctx = await memoryContext()
    const session = Session.create(SessionId('memory-kernel-safe-parser'))
    const opened = await ctx.notebooks.create(session, 'safe-parser.ipynb')
    await ctx.notebooks.attachEnvironment(session, opened.id, NotebookEnvironmentId('memory-env'), {
      backend: 'memory',
      initiator: 'agent',
    })
    const cellId = opened.cells[0]!.id
    await ctx.notebooks.editCell(
      session,
      opened.id,
      cellId,
      'print((1).constructor.constructor("return process")())',
    )

    const result = await ctx.notebooks.execute(session, opened.id, cellId, { initiator: 'agent' })

    expect(result).toMatchObject({ status: 'error', error: 'unsupported syntax' })
    expect(result.outputs).toMatchObject([{
      type: 'error',
      name: 'MemoryKernelError',
      value: 'unsupported syntax',
    }])
    await ctx.fiber.dispose()
  })

  it('prefers a jupyter backend when attach omits backend', async () => {
    const ctx = new Context()
    await ctx.plugin(SandboxPolicyService, { mode: 'danger-full-access' })
    await ctx.plugin(TestAttachmentStore)
    await ctx.plugin(TestFileSystem)
    await ctx.plugin(NotebookService)
    ctx.notebooks.registerBackend(new MemoryKernelBackend())
    const jupyter = new MemoryKernelBackend()
    Object.defineProperty(jupyter, 'type', { value: 'jupyter' })
    ctx.notebooks.registerBackend(jupyter)
    const session = Session.create(SessionId('agent-notebook-default'))
    const opened = await ctx.notebooks.create(session, 'demo.ipynb')
    const attached = await ctx.notebooks.attachEnvironment(
      session,
      opened.id,
      NotebookEnvironmentId('default-env'),
      { initiator: 'agent' },
    )
    expect(attached.kernel?.backend).toBe('jupyter')
    await ctx.fiber.dispose()
  })

  it.each(LIMIT_CONFIGS)('accepts only bounded integer %s values', async (key, minimum, maximum) => {
    for (const value of [minimum, maximum]) {
      const accepted = await configContext()
      await accepted.plugin(NotebookService, { [key]: value })
      await accepted.fiber.dispose()
    }

    for (const value of [minimum - 1, minimum + 0.5, maximum + 1]) {
      const rejected = await configContext()
      await expect(rejected.plugin(NotebookService, { [key]: value })).rejects.toThrow()
      await rejected.fiber.dispose()
    }
  })
})
