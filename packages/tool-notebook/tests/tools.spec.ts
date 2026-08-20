import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { isJsonValue, Session, SessionId } from '@deepseek-ai/dsh-session'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import NotebookService, {
  MemoryKernelBackend,
  NotebookId,
} from '@younthing/dsh-notebook-core'
import { NotebookEnvironmentId } from '@younthing/dsh-notebook-environment'
import * as toolNotebook from '@younthing/dsh-tool-notebook'
import { toolRunContext } from './tool-run-context.ts'

let context: Context | undefined
let temporaryRoot: string | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (temporaryRoot !== undefined) await rm(temporaryRoot, { recursive: true, force: true })
  temporaryRoot = undefined
})

function stubAgent(ctx: Context, session: Session): { agent: Agent; inject: ReturnType<typeof vi.fn> } {
  const scopeFiber = ctx.plugin(() => {})
  const inject = vi.fn()
  const agent: Agent = {
    id: session.id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle',
    ctx: scopeFiber.ctx,
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject,
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  return { agent, inject }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tool-notebook-'))
  temporaryRoot = root
  await writeFile(join(root, 'unit.ipynb'), `${JSON.stringify({
    cells: [],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5,
  })}\n`)
  const ctx = new Context()
  context = ctx
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalAttachmentStore, { dshHome: root })
  await ctx.plugin(LocalFileSystem, { cwd: root })
  await ctx.plugin(SandboxPolicyService, {
    mode: 'danger-full-access',
    workspaceRoot: root,
  })
  await ctx.plugin(NotebookService)
  ctx.notebooks.registerBackend(new MemoryKernelBackend())
  const toolsFiber = await ctx.plugin(toolNotebook)
  const id = SessionId('tool-notebook')
  const session = Session.create(id, [], {
    version: 0,
    id,
    createdAt: 0,
    cwd: root,
  })
  return { ctx, ...stubAgent(ctx, session), root, toolsFiber }
}

describe('tool-notebook unit surface', () => {
  it('directs the model to use cell tools instead of generic file writes', async () => {
    const { ctx } = await setup()
    const assembly = await ctx.systemPrompt.assemble()
    const notebookPrompt = assembly.sections.find(section => section.name === 'tool:notebook')
    expect(notebookPrompt?.text).toContain('delete, move, or copy cells')
    expect(notebookPrompt?.text).toContain('Never modify an opened .ipynb through generic filesystem tools')
  })

  it('copies a selected cell immediately after the source cell', async () => {
    const { ctx, agent } = await setup()
    const open = ctx.tools.get('notebook_open')
    const insert = ctx.tools.get('notebook_insert_cell')
    const copy = ctx.tools.get('notebook_copy_cell')
    expect(open).toBeDefined()
    expect(insert).toBeDefined()
    expect(copy).toBeDefined()
    if (open === undefined || insert === undefined || copy === undefined) {
      throw new Error('notebook copy tool registration is incomplete')
    }

    const opened = await open.execute({ path: 'unit.ipynb' }, toolRunContext(agent)) as { notebookId: string }
    await insert.execute({
      notebookId: opened.notebookId,
      cellType: 'code',
      source: 'copy_me = 1',
    }, toolRunContext(agent))

    const result = await copy.execute({
      notebookId: opened.notebookId,
      cellId: 'cell-1',
    }, toolRunContext(agent))
    expect(result).toContain('#0 code id="cell-1"')
    expect(result).toContain('#1 code id="cell-2"')
    expect(result.match(/copy_me = 1/g)).toHaveLength(2)
  })

  it('moves a selected cell to an exact notebook index', async () => {
    const { ctx, agent } = await setup()
    const open = ctx.tools.get('notebook_open')
    const insert = ctx.tools.get('notebook_insert_cell')
    const move = ctx.tools.get('notebook_move_cell')
    expect(open).toBeDefined()
    expect(insert).toBeDefined()
    expect(move).toBeDefined()
    if (open === undefined || insert === undefined || move === undefined) {
      throw new Error('notebook move tool registration is incomplete')
    }

    const opened = await open.execute({ path: 'unit.ipynb' }, toolRunContext(agent)) as { notebookId: string }
    await insert.execute({
      notebookId: opened.notebookId,
      cellType: 'raw',
      source: 'first',
    }, toolRunContext(agent))
    await insert.execute({
      notebookId: opened.notebookId,
      afterCellId: 'cell-1',
      cellType: 'code',
      source: 'second = True',
    }, toolRunContext(agent))

    const result = await move.execute({
      notebookId: opened.notebookId,
      cellId: 'cell-2',
      toIndex: 0,
    }, toolRunContext(agent))
    expect(result.indexOf('#0 code id="cell-2"')).toBeLessThan(result.indexOf('#1 raw id="cell-1"'))
  })

  it('deletes a selected cell while retaining another cell', async () => {
    const { ctx, agent } = await setup()
    const open = ctx.tools.get('notebook_open')
    const insert = ctx.tools.get('notebook_insert_cell')
    const remove = ctx.tools.get('notebook_delete_cell')
    expect(open).toBeDefined()
    expect(insert).toBeDefined()
    expect(remove).toBeDefined()
    if (open === undefined || insert === undefined || remove === undefined) {
      throw new Error('notebook delete tool registration is incomplete')
    }

    const opened = await open.execute({ path: 'unit.ipynb' }, toolRunContext(agent)) as { notebookId: string }
    await insert.execute({
      notebookId: opened.notebookId,
      cellType: 'raw',
      source: 'remove me',
    }, toolRunContext(agent))
    await insert.execute({
      notebookId: opened.notebookId,
      afterCellId: 'cell-1',
      cellType: 'code',
      source: 'keep_me = True',
    }, toolRunContext(agent))

    const result = await remove.execute({
      notebookId: opened.notebookId,
      cellId: 'cell-1',
    }, toolRunContext(agent))
    expect(result).not.toContain('remove me')
    expect(result).toContain('#0 code id="cell-2"')
    expect(result).toContain('keep_me = True')
  })

  it('keeps detached documents editable, reports environment setup, then executes and restarts', async () => {
    const { ctx, agent, inject, root, toolsFiber } = await setup()
    const open = ctx.tools.get('notebook_open')
    const create = ctx.tools.get('notebook_create')
    const insert = ctx.tools.get('notebook_insert_cell')
    const edit = ctx.tools.get('notebook_edit_cell')
    const remove = ctx.tools.get('notebook_delete_cell')
    const move = ctx.tools.get('notebook_move_cell')
    const copy = ctx.tools.get('notebook_copy_cell')
    const execute = ctx.tools.get('notebook_execute')
    const restart = ctx.tools.get('notebook_restart')
    const reload = ctx.tools.get('notebook_reload')
    expect(open).toBeDefined()
    expect(create).toBeDefined()
    expect(insert).toBeDefined()
    expect(edit).toBeDefined()
    expect(remove).toBeDefined()
    expect(move).toBeDefined()
    expect(copy).toBeDefined()
    expect(execute).toBeDefined()
    expect(restart).toBeDefined()
    expect(reload).toBeDefined()
    expect(ctx.tools.get('notebook_interrupt')).toBeUndefined()
    if (
      open === undefined
      || create === undefined
      || insert === undefined
      || edit === undefined
      || remove === undefined
      || move === undefined
      || copy === undefined
      || execute === undefined
      || restart === undefined
      || reload === undefined
    ) {
      throw new Error('tool-notebook registration is incomplete')
    }

    const opened = await open.execute({ path: 'unit.ipynb' }, toolRunContext(agent)) as {
      notebookId: string
      path: string
    }
    expect(opened).toEqual({ notebookId: 'notebook-1', path: 'unit.ipynb' })
    await expect(create.execute({ path: 'unit.ipynb' }, toolRunContext(agent)))
      .rejects.toMatchObject({ code: 'ALREADY_EXISTS' })
    await expect(create.execute({ path: 'created.ipynb' }, toolRunContext(agent)))
      .resolves.toMatchObject({ path: 'created.ipynb' })
    const openedId = NotebookId(opened.notebookId)
    expect(ctx.notebooks.get(agent.session, openedId).cells).toEqual([])

    await insert.execute({
      notebookId: opened.notebookId,
      cellType: 'raw',
      source: 'raw preamble',
    }, toolRunContext(agent))
    const rawCell = ctx.notebooks.get(agent.session, openedId).cells[0]
    expect(rawCell).toBeDefined()
    if (rawCell === undefined) throw new Error('raw insertion did not publish a cell')
    expect(rawCell.cellType).toBe('raw')

    await insert.execute({
      notebookId: opened.notebookId,
      afterCellId: rawCell.id,
      cellType: 'code',
      source: 'value = 2',
    }, toolRunContext(agent))
    const codeCell = ctx.notebooks.get(agent.session, openedId).cells[1]
    expect(codeCell).toBeDefined()
    if (codeCell === undefined) throw new Error('code insertion did not publish a cell')
    expect(codeCell.cellType).toBe('code')

    await edit.execute({
      notebookId: opened.notebookId,
      cellId: codeCell.id,
      source: 'value = 3\nprint(value)',
    }, toolRunContext(agent))

    const detachedExecution = await execute.execute({
      notebookId: opened.notebookId,
      cellId: codeCell.id,
    }, toolRunContext(agent))
    expect(detachedExecution).toEqual({
      status: 'environment-required',
      code: 'ENVIRONMENT_REQUIRED',
      message: 'notebook "unit.ipynb" requires an attached environment',
    })
    if (!isJsonValue(detachedExecution)) throw new Error('tool execution must return JSON')
    const detachedJson = detachedExecution as JsonValue
    expect(execute.output.render({
      notebookId: opened.notebookId,
      cellId: codeCell.id,
    }, detachedJson)).toEqual([{
      type: 'text',
      text: '{"status":"environment-required","code":"ENVIRONMENT_REQUIRED","message":"notebook \\"unit.ipynb\\" requires an attached environment"}',
    }])

    await ctx.notebooks.attachEnvironment(
      agent.session,
      openedId,
      NotebookEnvironmentId('tool-test-environment'),
      { initiator: 'user', backend: 'memory', kernelName: 'python-unit' },
    )
    await toolNotebook.executeNotebookCellAsUser(ctx, agent, openedId, codeCell.id)
    expect(inject).toHaveBeenCalledOnce()
    expect(JSON.stringify(inject.mock.calls[0]?.[0])).toContain('3')

    await writeFile(join(root, 'unit.ipynb'), `${JSON.stringify({
      cells: [{
        cell_type: 'raw',
        id: 'external-raw',
        metadata: { origin: 'external' },
        source: 'external snapshot',
      }],
      metadata: { kernelspec: { display_name: 'External Python', language: 'python', name: 'python-external' } },
      nbformat: 4,
      nbformat_minor: 5,
    })}\n`)
    const reloaded = await reload.execute({
      notebookId: opened.notebookId,
    }, toolRunContext(agent)) as {
      notebookId: string
      fileVersion: string
    }
    expect(reloaded).toMatchObject({ notebookId: opened.notebookId })
    expect(reloaded.fileVersion.length).toBeGreaterThan(0)
    expect(ctx.notebooks.get(agent.session, openedId).cells).toMatchObject([{
      id: 'external-raw',
      cellType: 'raw',
      source: 'external snapshot',
    }])
    expect(ctx.notebooks.get(agent.session, openedId).kernel).toMatchObject({
      environmentId: 'tool-test-environment',
      backend: 'memory',
      kernelName: 'python-unit',
      generation: 1,
    })

    await expect(restart.execute({
      notebookId: opened.notebookId,
    }, toolRunContext(agent))).resolves.toEqual({
      notebookId: opened.notebookId,
      environmentId: 'tool-test-environment',
      backend: 'memory',
      kernelName: 'python-unit',
      generation: 2,
    })

    await toolsFiber.dispose()
    expect(ctx.tools.get('notebook_open')).toBeUndefined()
    expect(ctx.tools.get('notebook_create')).toBeUndefined()
    expect(ctx.tools.get('notebook_delete_cell')).toBeUndefined()
    expect(ctx.tools.get('notebook_move_cell')).toBeUndefined()
    expect(ctx.tools.get('notebook_copy_cell')).toBeUndefined()
    expect(ctx.tools.get('notebook_restart')).toBeUndefined()
    expect(ctx.tools.get('notebook_reload')).toBeUndefined()
  })

  it('rejects direct application with an unsafe result cap', () => {
    const ctx = new Context()
    expect(() => {
      toolNotebook.apply(ctx, { maxResultBytes: 127 })
    })
      .toThrow('maxResultBytes must be a safe integer of at least 128')
  })
})
