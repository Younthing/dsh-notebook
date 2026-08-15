import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import NotebookService, { NotebookId } from '@younthing/dsh-notebook-core'
import { NotebookEnvironmentId } from '@younthing/dsh-notebook-environment'
import * as toolNotebook from '@younthing/dsh-tool-notebook'
import * as memoryBackend from './fixtures/memory-backend-plugin.ts'
import { toolRunContext } from './tool-run-context.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('tool-notebook through a real Loader composition', () => {
  it('edits, accepts an external snapshot, restarts, and injects output through loaded tools', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-tool-notebook-loader-'))
    await writeFile(join(root, 'demo.ipynb'), `${JSON.stringify({
      cells: [],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    })}\n`)
    const fixtureHref = pathToFileURL(join(import.meta.dirname, 'fixtures/memory-backend-plugin.ts')).href
    await writeFile(join(root, 'memory-backend-plugin.ts'), [
      `export { name, inject, apply } from '${fixtureHref}'`,
      '',
    ].join('\n'))
    const configPath = join(root, 'cordis.yml')
    const portableRoot = root.replaceAll('\\', '/')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-session'",
      "- name: '@deepseek-ai/dsh-agent'",
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-tools'",
      "- name: '@deepseek-ai/dsh-attachment-local'",
      '  config:',
      `    dshHome: '${portableRoot}'`,
      "- name: '@deepseek-ai/dsh-fs-local'",
      '  config:',
      `    cwd: '${portableRoot}'`,
      "- name: '@deepseek-ai/dsh-sandbox-policy'",
      '  config:',
      '    mode: danger-full-access',
      `    workspaceRoot: '${portableRoot}'`,
      "- name: '@younthing/dsh-notebook-core'",
      "- name: './memory-backend-plugin.ts'",
      "- name: '@younthing/dsh-tool-notebook'",
      '',
    ].join('\n'))

    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-session', (await import('@deepseek-ai/dsh-session')).default],
      ['@deepseek-ai/dsh-agent', AgentRegistry],
      ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
      ['@deepseek-ai/dsh-tools', ToolRuntime],
      ['@deepseek-ai/dsh-attachment-local', LocalAttachmentStore],
      ['@deepseek-ai/dsh-fs-local', LocalFileSystem],
      ['@deepseek-ai/dsh-sandbox-policy', SandboxPolicyService],
      ['@younthing/dsh-notebook-core', NotebookService],
      ['@younthing/dsh-tool-notebook', toolNotebook],
    ])
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (modules.has(specifier)) return modules.get(specifier)
        if (specifier.endsWith('memory-backend-plugin.ts')) return memoryBackend
        throw new Error(`unexpected Loader import: ${specifier}`)
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await context.loader.await()

    const sessionId = SessionId('loader-notebook')
    const session = Session.create(sessionId, [], {
      version: 0,
      id: sessionId,
      createdAt: 0,
      cwd: root,
    })
    const scopeFiber = context.plugin(() => {})
    const inject = vi.fn()
    const agent: Agent = {
      id: sessionId,
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
    context.agents.register(agent)

    const openTool = context.tools.get('notebook_open')
    const createTool = context.tools.get('notebook_create')
    const insertTool = context.tools.get('notebook_insert_cell')
    const editTool = context.tools.get('notebook_edit_cell')
    const restartTool = context.tools.get('notebook_restart')
    const reloadTool = context.tools.get('notebook_reload')
    expect(openTool).toBeDefined()
    expect(createTool).toBeDefined()
    expect(insertTool).toBeDefined()
    expect(editTool).toBeDefined()
    expect(restartTool).toBeDefined()
    expect(reloadTool).toBeDefined()
    if (
      openTool === undefined
      || createTool === undefined
      || insertTool === undefined
      || editTool === undefined
      || restartTool === undefined
      || reloadTool === undefined
    ) {
      throw new Error('Loader composition did not register every notebook tool')
    }
    const opened = await openTool.execute({ path: 'demo.ipynb' }, toolRunContext(agent)) as { notebookId: string }
    const notebookId = NotebookId(opened.notebookId)
    expect(context.notebooks.get(session, notebookId).cells).toEqual([])
    await insertTool.execute({
      notebookId,
      cellType: 'code',
      source: 'answer = 1',
    }, toolRunContext(agent))
    const cell = context.notebooks.get(session, notebookId).cells[0]
    expect(cell).toBeDefined()
    if (cell === undefined) throw new Error('notebook insert did not publish a code cell')
    await editTool.execute({
      notebookId,
      cellId: cell.id,
      source: 'answer = 7\nprint(answer)',
    }, toolRunContext(agent))

    await context.notebooks.attachEnvironment(
      session,
      notebookId,
      NotebookEnvironmentId('loader-environment'),
      { initiator: 'user', backend: 'memory', kernelName: 'python-loader' },
    )
    await toolNotebook.executeNotebookCellAsUser(context, agent, notebookId, cell.id)
    const edited = JSON.parse(await readFile(join(root, 'demo.ipynb'), 'utf8')) as {
      cells: { source: string }[]
    }
    expect(edited.cells[0]?.source).toBe('answer = 7\nprint(answer)')
    await writeFile(join(root, 'demo.ipynb'), `${JSON.stringify({
      cells: [{
        cell_type: 'raw',
        id: 'loader-external',
        metadata: {},
        source: 'accepted external snapshot',
      }],
      metadata: { kernelspec: { display_name: 'External Python', language: 'python', name: 'python-external' } },
      nbformat: 4,
      nbformat_minor: 5,
    })}\n`)
    const reloaded = await reloadTool.execute({
      notebookId,
    }, toolRunContext(agent)) as {
      notebookId: string
      fileVersion: string
    }
    expect(reloaded).toMatchObject({ notebookId })
    expect(reloaded.fileVersion.length).toBeGreaterThan(0)
    expect(context.notebooks.get(session, notebookId).cells).toMatchObject([{
      id: 'loader-external',
      cellType: 'raw',
      source: 'accepted external snapshot',
    }])
    await restartTool.execute({ notebookId }, toolRunContext(agent))

    expect(session.events.some(event => event.type.startsWith('notebook/'))).toBe(false)
    expect(context.notebooks.get(session, notebookId).kernel?.generation).toBe(2)
    expect(inject).toHaveBeenCalledOnce()
    expect(JSON.stringify(inject.mock.calls[0]?.[0])).toContain('7')
    const persisted = JSON.parse(await readFile(join(root, 'demo.ipynb'), 'utf8')) as {
      cells: { source: string }[]
    }
    expect(persisted.cells[0]?.source).toBe('accepted external snapshot')
    await scopeFiber.dispose()
  })
})
