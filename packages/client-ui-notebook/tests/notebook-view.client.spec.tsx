// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import {
  ConversationEventRegistry, ConversationViewRegistry, createSnapshotStore,
  EMPTY_CHAT_SNAPSHOT, SlotRegistry,
} from '@deepseek-ai/dsh-client-runtime/client'
import type {
  ConversationSnapshot, ConversationViewSnapshotMap, SessionId,
} from '@deepseek-ai/dsh-client-runtime/client'
import { apply as localeApply, inject as localeInject } from '@deepseek-ai/dsh-client-locale/client'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {
  CellId as NotebookCellId,
  ExecutionId as NotebookExecutionId,
  NotebookFileVersion,
  NotebookId as NotebookDocumentId,
} from '@younthing/dsh-notebook-core/types'
import type { NotebookEnvironmentId } from '@younthing/dsh-notebook-environment/types'
import { Session, SessionId as HostSessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { apply, inject } from '../src/client/index.ts'
import { apply as nodeApply } from '../src/index.ts'
import { NotebookView, type NotebookViewInjected } from '../src/client/NotebookView.tsx'
import {
  notebookNode,
  type NotebookSessionEvent,
  type NotebookSnapshot,
} from '../src/client/notebook-contract.ts'
import { NotebookSnapshotBuilder } from '../src/client/notebook-snapshot-builder.ts'
import { en, NS, zh } from '../src/client/locales.ts'

const SID = 's-notebook' as SessionId
const NotebookId = (value: string): NotebookDocumentId => value as NotebookDocumentId
const CellId = (value: string): NotebookCellId => value as NotebookCellId
const ExecutionId = (value: string): NotebookExecutionId => value as NotebookExecutionId
const FileVersion = (value: string): NotebookFileVersion => value as NotebookFileVersion
const EnvironmentId = (value: string): NotebookEnvironmentId => value as NotebookEnvironmentId
const IMAGE_REF: ImageAttachmentRef = {
  attachmentId: 'image-1' as ImageAttachmentRef['attachmentId'],
  mediaType: 'image/png',
  bytes: 3,
  width: 1,
  height: 1,
  name: 'plot.png',
}

function disabled(element: HTMLElement): boolean {
  if (
    element instanceof HTMLButtonElement
    || element instanceof HTMLInputElement
    || element instanceof HTMLTextAreaElement
  ) return element.disabled
  throw new Error('notebook test expected a disableable control')
}

afterEach(cleanup)
beforeEach(() => { localStorage.clear() })

function ok<T>(value: T) {
  return Promise.resolve({ ok: true as const, value: { ok: true as const, value } })
}

function fail(message: string) {
  return Promise.resolve({
    ok: true as const,
    value: {
      ok: false as const,
      error: { source: 'configuration' as const, code: 'internal', message },
    },
  })
}

function writeConflictFailure() {
  return Promise.resolve({
    ok: true as const,
    value: {
      ok: false as const,
      error: {
        source: 'persistence' as const,
        code: 'WRITE_CONFLICT' as const,
        message: 'notebook file changed since it was opened',
      },
    },
  })
}

function buildNotebookSnapshot(
  status: 'ok' | 'running' | 'error' | 'cancelled' = 'ok',
  extra?: { markdown?: string; raw?: string; source?: string; additionalCode?: readonly string[] },
): ConversationSnapshot['views'] {
  const host = Session.create(HostSessionId('notebook-view-spec'))
  const notebookId = NotebookId('notebook-1')
  const cellId = CellId('cell-1')
  const executionId = ExecutionId('exec-1')
  host.append('notebook/open', {
    notebookId,
    path: 'demo.ipynb',
    fileVersion: FileVersion('file-1'),
    nbformatMinor: 5,
    metadata: {},
  })
  host.append('notebook/kernel', {
    notebookId,
    environmentId: EnvironmentId('workspace-venv'),
    backend: 'jupyter',
    kernelName: 'python3',
    generation: 1,
    initiator: 'user',
    fileVersion: FileVersion('file-1'),
  })
  host.append('notebook/cell', {
    notebookId,
    cellId,
    cellType: 'code',
    source: extra?.source ?? 'print("hi")',
    index: 0,
    operation: 'create',
    metadata: {},
    attachments: {},
    fileVersion: FileVersion('file-2'),
  })
  host.append('notebook/execute', {
    notebookId,
    cellId,
    executionId,
    initiator: 'agent',
  })
  host.append('notebook/output', {
    notebookId,
    cellId,
    executionId,
    mutation: {
      operation: 'append',
      output: { type: 'stream', name: 'stdout', text: 'hi\n' },
    },
  })
  if (status === 'ok') {
    host.append('notebook/execute-end', {
      notebookId,
      cellId,
      executionId,
      status: 'ok',
      executionCount: 1,
      fileVersion: FileVersion('file-3'),
    })
  } else if (status === 'error') {
    host.append('notebook/execute-end', {
      notebookId,
      cellId,
      executionId,
      status: 'error',
      error: 'boom',
      executionCount: 1,
      fileVersion: FileVersion('file-3'),
    })
  } else if (status === 'cancelled') {
    host.append('notebook/execute-end', {
      notebookId,
      cellId,
      executionId,
      status: 'cancelled',
      error: 'interrupted',
      executionCount: 1,
      fileVersion: FileVersion('file-3'),
    })
  }
  for (const [index, source] of (extra?.additionalCode ?? []).entries()) {
    host.append('notebook/cell', {
      notebookId,
      cellId: CellId(`cell-extra-${index + 1}`),
      cellType: 'code',
      source,
      index: index + 1,
      operation: 'create',
      metadata: {},
      attachments: {},
      fileVersion: FileVersion(`file-code-${String(index)}`),
    })
  }
  if (extra?.markdown !== undefined) {
    host.append('notebook/cell', {
      notebookId,
      cellId: CellId('cell-md'),
      cellType: 'markdown',
      source: extra.markdown,
      index: 1 + (extra.additionalCode?.length ?? 0),
      operation: 'create',
      metadata: {},
      attachments: {},
      fileVersion: FileVersion('file-markdown'),
    })
  }
  if (extra?.raw !== undefined) {
    host.append('notebook/cell', {
      notebookId,
      cellId: CellId('cell-raw'),
      cellType: 'raw',
      source: extra.raw,
      index: 1 + (extra.additionalCode?.length ?? 0) + (extra.markdown === undefined ? 0 : 1),
      operation: 'create',
      metadata: {},
      attachments: {},
      fileVersion: FileVersion('file-raw'),
    })
  }
  const builder = new NotebookSnapshotBuilder()
  const nodes = host.events
    .filter(isNotebookSessionEvent)
    .map(event => notebookNode({
      key: `notebook-event:${event.seq}`,
      kind: 'notebook-event',
      id: String(event.seq),
    }, event.seq, event))
  const folded = builder.replace({ nodes })
  return notebookViews(folded)
}

function notebookViews(notebook?: NotebookSnapshot): ConversationSnapshot['views'] {
  const snapshots: Partial<ConversationViewSnapshotMap> = notebook === undefined ? {} : { notebook }
  return { get: target => snapshots[target] }
}

function isNotebookSessionEvent(event: SessionEvent): event is NotebookSessionEvent {
  return event.type.startsWith('notebook/')
}

function historySnapshot(
  status: 'ok' | 'running' | 'error' | 'cancelled' = 'ok',
  extra?: { markdown?: string; raw?: string; source?: string; additionalCode?: readonly string[] },
): ConversationSnapshot {
  return {
    sessionId: SID,
    views: buildNotebookSnapshot(status, extra),
    chat: EMPTY_CHAT_SNAPSHOT,
    nodes: [],
    turnTimings: new Map(),
    turnEnds: new Map(),
    partial: null,
    runningCalls: [],
    pending: [],
    queue: [],
    running: false,
    subagent: null,
    composerPhase: 'active',
    removed: false,
    openState: 'open',
    openError: null,
    hasMore: false,
    loadingOlder: false,
    promptError: null,
    blank: false,
    lastAgentError: null,
  }
}

function detachedHistorySnapshot(path = 'detached.ipynb'): ConversationSnapshot {
  const snapshot = historySnapshot()
  snapshot.views = notebookViews({
    folded: {
      notebooks: [{
        id: NotebookId('notebook-detached'),
        path,
        fileVersion: FileVersion('detached-file'),
        nbformatMinor: 5,
        metadata: {},
        cells: [{
          id: CellId('detached-cell'),
          cellType: 'code',
          source: 'value = 1',
          metadata: {},
          attachments: {},
          outputs: [],
        }],
      }],
    },
    incomplete: false,
    protocolError: null,
  })
  return snapshot
}

function viewProps(overrides: Partial<NotebookViewInjected> & {
  snapshot?: ConversationSnapshot
} = {}) {
  const { snapshot = historySnapshot(), ...injected } = overrides
  const store = createSnapshotStore(snapshot)
  const stubs: NotebookViewInjected = {
    discoverNotebooks: injected.discoverNotebooks ?? (async () => ({
      items: [], partial: false,
    })),
    openNotebook: injected.openNotebook ?? (async () => {}),
    createNotebook: injected.createNotebook ?? (async () => {}),
    environmentCatalog: injected.environmentCatalog ?? (async () => ({
      manager: { status: 'ready', version: '0.11.32', canInstall: true },
      pythons: [{ id: 'python-3.12', version: '3.12', source: 'path' }],
      environments: [{
        id: EnvironmentId('workspace-venv'),
        displayName: '.venv',
        status: 'ready',
        pythonVersion: '3.12',
        managed: true,
      }],
    })),
    installUv: injected.installUv ?? (async signal => stubs.environmentCatalog(signal)),
    installPython: injected.installPython ?? (async signal => stubs.environmentCatalog(signal)),
    createEnvironment: injected.createEnvironment ?? (async (_id, _allow, _rebuild, signal) =>
      stubs.environmentCatalog(signal)),
    attachEnvironment: injected.attachEnvironment ?? (async () => {}),
    runtimeStatus: injected.runtimeStatus ?? (async () => ({
      status: 'ready', environmentId: EnvironmentId('workspace-venv'),
    })),
    editCell: injected.editCell ?? (async () => {}),
    deleteCell: injected.deleteCell ?? (async () => {}),
    moveCell: injected.moveCell ?? (async () => {}),
    copyCell: injected.copyCell ?? (async () => {}),
    insertCell: injected.insertCell ?? (async () => {}),
    runCell: injected.runCell ?? (async () => 'ok' as const),
    restartNotebook: injected.restartNotebook ?? (async () => {}),
    reloadNotebook: injected.reloadNotebook ?? (async () => {}),
    interruptNotebook: injected.interruptNotebook ?? (async () => {}),
    loadAttachment: injected.loadAttachment ?? (async attachment => ({
      attachment,
      data: new Uint8Array(),
    })),
    loadOlder: injected.loadOlder ?? (async () => {}),
    replaceSession: injected.replaceSession ?? (async () => {}),
    closeNotebookPanel: injected.closeNotebookPanel ?? (() => {}),
  }
  return {
    sessionId: SID,
    useSession: bindSnapshotSelector(store),
    useSessions: (() => undefined) as never,
    useWorkspaces: (() => undefined) as never,
    useProjection: (() => undefined) as never,
    useInput: (() => { throw new Error('unused notebook test input store') }) as never,
    inputActions: {
      setDraft: () => { throw new Error('unused notebook test input action') },
      submit: () => { throw new Error('unused notebook test input action') },
    } as never,
    t: (key: string) => (zh as Readonly<Record<string, string>>)[key] ?? key,
    ...stubs,
  }
}

async function bench(notebooks?: {
  open?: (payload: { sessionId: SessionId; path: string }) => ReturnType<typeof ok>
  editCell?: () => ReturnType<typeof ok> | ReturnType<typeof writeConflictFailure>
  insertCell?: () => ReturnType<typeof ok>
  runCell?: () => ReturnType<typeof ok> | ReturnType<typeof fail>
  restart?: () => ReturnType<typeof ok> | ReturnType<typeof fail>
  reload?: () => ReturnType<typeof ok> | ReturnType<typeof fail>
  interrupt?: () => ReturnType<typeof ok> | ReturnType<typeof fail>
}, replacement?: () => Promise<void>) {
  const ctx = new Context()
  const slots = new SlotRegistry(ctx)
  const sessionStore = createSnapshotStore(historySnapshot())
  const loadOlder = vi.fn(async () => {})
  const session = {
    getSnapshot: () => sessionStore.getSnapshot(),
    subscribe: (listener: () => void) => sessionStore.subscribe(listener),
    loadOlder,
  }
  await ctx.plugin(ConversationEventRegistry).await()
  await ctx.plugin(ConversationViewRegistry).await()
  ctx.provide('sessions', { binding: () => ({ session }) })
  const replaceSession = vi.fn(replacement ?? (async () => {}))
  ctx.provide('workspaces', { archiveSession: replaceSession })
  ctx.provide('layout', {
    openDetails: vi.fn(),
    closeDetails: vi.fn(),
  })
  slots.register({
    name: 'root',
    children: { details: { kind: 'single', scope: 'session' } },
  } as never, () => null)
  const api = {
    notebooks: {
      discover: vi.fn(async () => ok({ items: [], partial: false })),
      open: vi.fn(notebooks?.open ?? (async (payload: { path: string }) => ok({
        id: 'notebook-open',
        path: payload.path,
        fileVersion: 'file-open',
        nbformatMinor: 5,
        metadata: {},
        cells: [],
      }))),
      create: vi.fn(async (payload: { path: string }) => ok({
        id: 'notebook-create', path: payload.path, fileVersion: 'file-create',
        nbformatMinor: 5, metadata: {}, cells: [],
      })),
      environmentCatalog: vi.fn(async () => ok({
        manager: { status: 'ready', version: '0.11.32', canInstall: true },
        pythons: [{ id: 'python-3.12', version: '3.12', source: 'path' }],
        environments: [],
      })),
      installUv: vi.fn(async () => ok({ manager: { status: 'ready', canInstall: true }, pythons: [], environments: [] })),
      installPython: vi.fn(async () => ok({ manager: { status: 'ready', canInstall: true }, pythons: [], environments: [] })),
      createEnvironment: vi.fn(async () => ok({ manager: { status: 'ready', canInstall: true }, pythons: [], environments: [] })),
      attachEnvironment: vi.fn(async () => ok({
        id: 'notebook-1', path: 'demo.ipynb', fileVersion: 'file-3', nbformatMinor: 5,
        metadata: {}, cells: [], kernel: {
          environmentId: 'workspace-venv', backend: 'jupyter', kernelName: 'python3', generation: 1,
        },
      })),
      runtimeStatus: vi.fn(async () => ok({ status: 'ready', environmentId: 'workspace-venv' })),
      readAttachment: vi.fn(async () => ok({ attachment: IMAGE_REF, data: 'AQID' })),
      editCell: vi.fn(notebooks?.editCell ?? (async () => ok({ ok: true }))),
      deleteCell: vi.fn(notebooks?.deleteCell ?? (async () => ok({ ok: true }))),
      moveCell: vi.fn(notebooks?.moveCell ?? (async () => ok({ ok: true }))),
      copyCell: vi.fn(notebooks?.copyCell ?? (async () => ok({ cellId: 'cell-copy' }))),
      insertCell: vi.fn(notebooks?.insertCell ?? (async () => ok({ cellId: 'cell-insert' }))),
      runCell: vi.fn(notebooks?.runCell ?? (async () => ok({
        executionId: 'exec-run', status: 'ok', executionCount: 1,
      }))),
      restart: vi.fn(notebooks?.restart ?? (async () => ok({
        id: 'notebook-1', path: 'demo.ipynb', fileVersion: 'file-restart', nbformatMinor: 5,
        metadata: {}, cells: [], kernel: {
          environmentId: 'workspace-venv', backend: 'jupyter', kernelName: 'python3', generation: 2,
        },
      }))),
      reload: vi.fn(notebooks?.reload ?? (async () => ok({
        id: 'notebook-1', path: 'demo.ipynb', fileVersion: 'file-reload', nbformatMinor: 5,
        metadata: {}, cells: [], kernel: {
          environmentId: 'workspace-venv', backend: 'jupyter', kernelName: 'python3', generation: 1,
        },
      }))),
      interrupt: vi.fn(notebooks?.interrupt ?? (async () => ok({ interrupted: true }))),
    },
  }
  ctx.provide('remote', {
    notebooks: api.notebooks,
    $mount: vi.fn(async () => async () => {}),
    $on: () => () => {},
  } as never)
  ctx.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
  // The rc.6 locale plugin declares `connection` and `remote` in its inject
  // list (the bundle's apply never reads them) — the bench provides `remote`
  // below, and this dummy satisfies the remaining declared dependency so the
  // real locale service mounts and `ctx.locale` becomes available.
  ctx.provide('connection', {} as never)
  ctx.plugin({ inject: [...localeInject], apply: localeApply })
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, slots, fiber, api, loadOlder, readAttachment: api.notebooks.readAttachment, replaceSession }
}

function notebookInject(slots: SlotRegistry): (sessionId: SessionId) => NotebookViewInjected {
  const injectEntry = slots.entries('details')[0]?.inject
  if (injectEntry === undefined) throw new Error('notebook test slot injection is missing')
  return injectEntry as unknown as (sessionId: SessionId) => NotebookViewInjected
}

describe('NotebookView', () => {
  it('declares the services it binds', () => {
    expect(inject).toEqual([
      'slots', 'conversationEvents', 'conversationViews', 'sessions', 'workspaces', 'layout', 'locale', 'remote',
    ])
  })

  it('registers the notebook column and fiber disposal removes it', async () => {
    const { ctx, slots, fiber } = await bench()
    expect(slots.entries('details')).toHaveLength(1)
    expect(ctx.conversationEvents.entries().some(entry => entry.kind === 'notebook-event')).toBe(true)
    expect(ctx.conversationViews.entries().some(entry => entry.target === 'notebook')).toBe(true)
    await fiber.dispose()
    expect(slots.entries('details')).toHaveLength(0)
    expect(ctx.conversationEvents.entries().some(entry => entry.kind === 'notebook-event')).toBe(false)
    expect(ctx.conversationViews.entries().some(entry => entry.target === 'notebook')).toBe(false)
  })

  it('routes replacement through the awaitable Workspace runtime action', async () => {
    const { slots, replaceSession } = await bench()

    await notebookInject(slots)(SID).replaceSession()

    expect(replaceSession).toHaveBeenCalledWith(SID)
  })

  it('keeps the English dictionary key-identical to the Chinese source of truth', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  it('registers dictionaries under its own namespace and releases them with the fiber', async () => {
    const { ctx, fiber } = await bench()
    const translate = ctx.locale.bind(NS)
    ctx.locale.setLocale('zh')
    expect(translate('empty.open')).toBe(zh['empty.open'])
    ctx.locale.setLocale('en')
    expect(translate('empty.open')).toBe(en['empty.open'])
    await fiber.dispose()
    expect(translate('empty.open')).not.toBe(en['empty.open'])
  })

  it('renders folded notebook cells, In/Out counts, and outputs', () => {
    render(<NotebookView {...viewProps()} />)
    expect(screen.getByTestId('notebook-view')).toBeTruthy()
    expect(screen.getAllByText('demo.ipynb')).toHaveLength(2)
    expect(screen.getByText('[1]')).toBeTruthy()
    expect(screen.getByDisplayValue('print("hi")')).toBeTruthy()
    expect(document.querySelector('[data-testid="notebook-view"]')?.textContent).toContain('hi\n')
  })

  it('shows In [*] while an execution is still running', () => {
    render(<NotebookView {...viewProps({ snapshot: historySnapshot('running') })} />)
    expect(screen.getByText('[*]')).toBeTruthy()
  })

  it('gates discovery until authoritative Session history opens', () => {
    const discoverNotebooks = vi.fn(async () => ({ items: [], partial: false }))
    const snapshot = historySnapshot()
    snapshot.openState = 'loading'
    snapshot.views = notebookViews()
    render(<NotebookView {...viewProps({ snapshot, discoverNotebooks })} />)
    expect(screen.getByTestId('notebook-history-loading')).toBeTruthy()
    expect(screen.getByText('正在载入笔记本历史')).toBeTruthy()
    expect(discoverNotebooks).not.toHaveBeenCalled()
  })

  it('lists discovered notebooks without opening the only candidate', async () => {
    const openNotebook = vi.fn(async () => {})
    const discoverNotebooks = vi.fn(async () => ({
      items: [{ path: 'reports/analysis.IPYNB', size: 2_048 }],
      partial: false,
    }))
    const snapshot = historySnapshot()
    snapshot.views = notebookViews()
    render(<NotebookView {...viewProps({ snapshot, discoverNotebooks, openNotebook })} />)
    const candidate = (await screen.findByText('reports/analysis.IPYNB')).closest('li')
    if (candidate === null) throw new Error('candidate row missing')
    expect(openNotebook).not.toHaveBeenCalled()
    expect(within(candidate).getByText('2.0 KB')).toBeTruthy()
    fireEvent.click(within(candidate).getByRole('button', { name: '打开' }))
    expect(openNotebook).toHaveBeenCalledWith('reports/analysis.IPYNB', expect.any(AbortSignal))
  })

  it('loads another discovery page and preserves partial results', async () => {
    const discoverNotebooks = vi.fn(async (after: string | undefined) => after === undefined
      ? { items: [{ path: 'one.ipynb' }], nextAfter: 'one.ipynb', partial: false }
      : { items: [{ path: 'nested/two.ipynb' }], partial: true })
    const snapshot = historySnapshot()
    snapshot.views = notebookViews()
    render(<NotebookView {...viewProps({ snapshot, discoverNotebooks })} />)
    await screen.findByText('one.ipynb')
    fireEvent.click(screen.getByRole('button', { name: '加载更多' }))
    expect(await screen.findByText('nested/two.ipynb')).toBeTruthy()
    expect(screen.getByText('部分子目录无法访问；已显示可用结果。')).toBeTruthy()
    expect(discoverNotebooks).toHaveBeenLastCalledWith('one.ipynb', expect.any(AbortSignal))
  })

  it('keeps a detached document editable while runtime actions stay disabled', async () => {
    const environmentCatalog = vi.fn(async () => ({
      manager: { status: 'missing' as const, canInstall: true },
      pythons: [],
      environments: [],
    }))
    render(<NotebookView {...viewProps({
      snapshot: detachedHistorySnapshot(),
      environmentCatalog,
      runtimeStatus: async () => ({ status: 'detached' }),
    })} />)
    expect(screen.getByDisplayValue('value = 1')).toBeTruthy()
    expect(disabled(screen.getByDisplayValue('value = 1'))).toBe(false)
    expect(disabled(screen.getByRole('button', { name: '运行' }))).toBe(true)
    expect(disabled(screen.getByRole('button', { name: '全部运行' }))).toBe(true)
    expect(await screen.findByRole('button', { name: '安装 uv' })).toBeTruthy()
  })

  it('installs uv, provisions the fixed workspace environment, then attaches it', async () => {
    const environmentId = EnvironmentId('workspace-venv')
    const missing = {
      manager: { status: 'missing' as const, canInstall: true },
      pythons: [],
      environments: [],
    }
    const setup = {
      manager: { status: 'ready' as const, version: '0.11.32', canInstall: true },
      pythons: [{ id: 'python-3.12', version: '3.12', source: 'path' as const }],
      environments: [{
        id: environmentId,
        displayName: '.venv',
        status: 'setup-required' as const,
        pythonVersion: '3.12',
        managed: true,
      }],
    }
    const ready = {
      ...setup,
      environments: [{ ...setup.environments[0]!, status: 'ready' as const }],
    }
    const installUv = vi.fn(async () => setup)
    const createEnvironment = vi.fn(async () => ready)
    const attachEnvironment = vi.fn(async () => {})
    render(<NotebookView {...viewProps({
      snapshot: detachedHistorySnapshot(),
      environmentCatalog: async () => missing,
      installUv,
      createEnvironment,
      attachEnvironment,
      runtimeStatus: async () => ({ status: 'detached' }),
    })} />)
    fireEvent.click(await screen.findByRole('button', { name: '安装 uv' }))
    fireEvent.click(await screen.findByRole('button', { name: '创建 .venv' }))
    await waitFor(() => {
      expect(createEnvironment).toHaveBeenCalledWith(environmentId, false, false, expect.any(AbortSignal))
      expect(attachEnvironment).toHaveBeenCalledWith(
        NotebookId('notebook-detached'), environmentId, expect.any(AbortSignal),
      )
    })
  })

  it('requires a second explicit confirmation before installing Python', async () => {
    const installPython = vi.fn(async () => ({
      manager: { status: 'ready' as const, version: '0.11.32', canInstall: true },
      pythons: [{ id: 'managed-python', version: '3.12', source: 'managed' as const }],
      environments: [],
    }))
    render(<NotebookView {...viewProps({
      snapshot: detachedHistorySnapshot(),
      environmentCatalog: async () => ({
        manager: { status: 'ready', version: '0.11.32', canInstall: true },
        pythons: [],
        environments: [],
      }),
      installPython,
      runtimeStatus: async () => ({ status: 'detached' }),
    })} />)
    fireEvent.click(await screen.findByRole('button', { name: '安装 Python 3.12' }))
    expect(installPython).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '确认安装' }))
    await waitFor(() => { expect(installPython).toHaveBeenCalledWith(expect.any(AbortSignal)) })
  })

  it('requires ownership-aware confirmation before rebuilding a managed environment', async () => {
    const environmentId = EnvironmentId('workspace-venv')
    const broken = {
      manager: { status: 'ready' as const, version: '0.11.32', canInstall: true },
      pythons: [{ id: 'python-3.12', version: '3.12', source: 'path' as const }],
      environments: [{
        id: environmentId,
        displayName: '.venv',
        status: 'broken' as const,
        pythonVersion: '3.12',
        managed: true,
      }],
    }
    const ready = {
      ...broken,
      environments: [{ ...broken.environments[0]!, status: 'ready' as const }],
    }
    const createEnvironment = vi.fn(async () => ready)
    render(<NotebookView {...viewProps({
      snapshot: detachedHistorySnapshot(),
      environmentCatalog: async () => broken,
      createEnvironment,
      runtimeStatus: async () => ({ status: 'detached' }),
    })} />)
    fireEvent.click(await screen.findByRole('button', { name: '重建 .venv' }))
    expect(createEnvironment).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '确认重建' }))
    await waitFor(() => {
      expect(createEnvironment).toHaveBeenCalledWith(
        environmentId, false, true, expect.any(AbortSignal),
      )
    })
  })

  it('does not refetch runtime status for cell-only projection updates', async () => {
    const initial = historySnapshot('running')
    const store = createSnapshotStore(initial)
    const runtimeStatus = vi.fn(async () => ({
      status: 'running' as const,
      environmentId: EnvironmentId('workspace-venv'),
    }))
    const props = {
      ...viewProps({ snapshot: initial, runtimeStatus }),
      useSession: bindSnapshotSelector(store),
    }
    render(<NotebookView {...props} />)
    await waitFor(() => { expect(runtimeStatus).toHaveBeenCalledTimes(1) })

    act(() => { store.set(historySnapshot('error')) })
    await waitFor(() => {
      expect(screen.getByTestId('notebook-cell-notebook-1-cell-1').getAttribute('data-status')).toBe('error')
    })
    expect(runtimeStatus).toHaveBeenCalledTimes(1)
  })

  it('discovers an empty workspace and suggests a strict new notebook path', async () => {
    const createNotebook = vi.fn(async () => {})
    const empty = historySnapshot()
    empty.views = notebookViews()
    render(<NotebookView {...viewProps({ snapshot: empty, createNotebook })} />)
    expect(screen.getByTestId('notebook-launcher')).toBeTruthy()
    expect(screen.getByText('还没有笔记本')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '新建笔记本' }))
    expect(createNotebook).toHaveBeenCalledWith('notebook.ipynb', expect.any(AbortSignal))
  })

  it('keeps document creation locked after acknowledgement until durable projection catches up', async () => {
    const createNotebook = vi.fn(async () => {})
    const empty = historySnapshot()
    empty.views = notebookViews()
    render(<NotebookView {...viewProps({ snapshot: empty, createNotebook })} />)
    const button = screen.getByRole('button', { name: '新建笔记本' })
    fireEvent.click(button)
    await waitFor(() => { expect(createNotebook).toHaveBeenCalledTimes(1) })
    expect(disabled(button)).toBe(true)
    fireEvent.click(button)
    expect(createNotebook).toHaveBeenCalledTimes(1)
  })

  it('submits an editable workspace-relative ipynb path and rejects unsupported paths', async () => {
    const openNotebook = vi.fn(async () => {})
    const empty = historySnapshot()
    empty.views = notebookViews()
    render(<NotebookView {...viewProps({ snapshot: empty, openNotebook })} />)
    fireEvent.click(screen.getByText('按路径打开已有文件'))
    const path = screen.getByRole('textbox', { name: '工作区内的 .ipynb 路径' })
    fireEvent.change(path, { target: { value: 'reports/final.ipynb' } })
    fireEvent.submit(path.closest('form')!)
    expect(openNotebook).toHaveBeenCalledWith('reports/final.ipynb', expect.any(AbortSignal))

    const second = historySnapshot()
    second.views = notebookViews()
    cleanup()
    render(<NotebookView {...viewProps({ snapshot: second, openNotebook })} />)
    fireEvent.click(screen.getByText('按路径打开已有文件'))
    const invalid = screen.getByRole('textbox', { name: '工作区内的 .ipynb 路径' })
    fireEvent.change(invalid, { target: { value: '../outside.py' } })
    fireEvent.submit(invalid.closest('form')!)
    expect(openNotebook).toHaveBeenCalledTimes(1)
    expect(invalid.getAttribute('aria-invalid')).toBe('true')
    expect((await screen.findByRole('alert')).textContent).toContain('.ipynb')
  })

  it('does not offer a duplicate open while the loaded notebook tail is incomplete', () => {
    const empty = historySnapshot()
    const incomplete = { folded: { notebooks: [] }, incomplete: true, protocolError: null } as const
    empty.views = notebookViews(incomplete)
    render(<NotebookView {...viewProps({ snapshot: empty })} />)
    expect(screen.getByText('正在等待更早的笔记本记录')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '新建笔记本' })).toBeNull()
  })

  it('offers one explicit older-page load for an incomplete notebook tail', async () => {
    const loadOlder = vi.fn(async () => {})
    const tail = historySnapshot()
    const incomplete = { folded: { notebooks: [] }, incomplete: true, protocolError: null } as const
    tail.views = notebookViews(incomplete)
    tail.hasMore = true
    render(<NotebookView {...viewProps({ snapshot: tail, loadOlder })} />)
    fireEvent.click(screen.getByRole('button', { name: '加载较早的笔记本历史' }))
    expect(loadOlder).toHaveBeenCalledTimes(1)
    await screen.findByText('较早历史已加载')
  })

  it('offers an accessible replacement action for incompatible durable history', async () => {
    const deferred = Promise.withResolvers<undefined>()
    const replaceSession = vi.fn(() => deferred.promise)
    const empty = historySnapshot()
    empty.views = notebookViews({
      folded: { notebooks: [] },
      incomplete: false,
      protocolError: 'incompatible-history',
    })
    render(<NotebookView {...viewProps({ snapshot: empty, replaceSession })} />)
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('此会话的 Notebook 历史不兼容')
    expect(alert.textContent).toContain('在同一工作区新建会话')
    expect(screen.queryByRole('button', { name: '新建笔记本' })).toBeNull()
    const replace = screen.getByRole('button', { name: '归档并新建会话' })
    fireEvent.click(replace)
    fireEvent.click(replace)
    expect(replaceSession).toHaveBeenCalledTimes(1)
    expect(disabled(replace)).toBe(true)
    expect(screen.getByText('正在归档当前会话并新建会话…')).toBeTruthy()
    deferred.resolve(undefined)
    await screen.findByText('已新建会话')
  })

  it('keeps the last valid document and recovery error visible for retry', async () => {
    const replaceSession = vi.fn(async () => { throw new Error('replacement create unavailable') })
    const snapshot = historySnapshot()
    const notebook = snapshot.views.get('notebook')
    if (notebook === undefined) throw new Error('notebook test projection missing')
    snapshot.views = notebookViews({ ...notebook, protocolError: 'incompatible-history' })
    render(<NotebookView {...viewProps({ snapshot, replaceSession })} />)
    expect(screen.getByDisplayValue('print("hi")')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('在同一工作区新建会话')
    expect(disabled(screen.getByRole('textbox', { name: '单元格源码' }))).toBe(true)
    expect(disabled(screen.getByRole('button', { name: '运行' }))).toBe(true)
    expect(disabled(screen.getByRole('button', { name: '从磁盘重新加载' }))).toBe(true)
    const replace = screen.getByRole('button', { name: '归档并新建会话' })
    fireEvent.click(replace)
    expect((await screen.findByText(/replacement create unavailable/)).textContent)
      .toContain('操作失败')
    expect(screen.getByText('此会话的 Notebook 历史不兼容')).toBeTruthy()
    expect(disabled(replace)).toBe(false)
    fireEvent.click(replace)
    await waitFor(() => { expect(replaceSession).toHaveBeenCalledTimes(2) })
  })

  it('persists a draft on blur and runs the current source', async () => {
    const editCell = vi.fn(async () => {})
    const runCell = vi.fn(async () => 'ok' as const)
    render(<NotebookView {...viewProps({ editCell, runCell })} />)
    const editor = screen.getByDisplayValue('print("hi")')
    fireEvent.change(editor, { target: { value: 'print("draft")' } })
    fireEvent.blur(editor)
    expect(editCell).toHaveBeenCalledWith(NotebookId('notebook-1'), CellId('cell-1'), 'print("draft")')
    fireEvent.click(screen.getByRole('button', { name: '运行' }))
    await waitFor(() => {
      expect(runCell).toHaveBeenCalledWith(NotebookId('notebook-1'), CellId('cell-1'), 'print("draft")')
    })
  })

  it('duplicates a cell from the cell actions', async () => {
    const copyCell = vi.fn(async () => {})
    render(<NotebookView {...viewProps({ copyCell })} />)
    fireEvent.click(screen.getByRole('button', { name: '复制单元格' }))
    await waitFor(() => {
      expect(copyCell).toHaveBeenCalledWith(NotebookId('notebook-1'), CellId('cell-1'))
    })
  })

  it('moves a cell down from the cell actions', async () => {
    const moveCell = vi.fn(async () => {})
    render(<NotebookView {...viewProps({ moveCell })} />)
    fireEvent.click(screen.getByRole('button', { name: '下移单元格' }))
    await waitFor(() => {
      expect(moveCell).toHaveBeenCalledWith(NotebookId('notebook-1'), CellId('cell-1'), 1)
    })
  })

  it('confirms before deleting a cell', async () => {
    const deleteCell = vi.fn(async () => {})
    render(<NotebookView {...viewProps({ deleteCell })} />)
    const removeButton = screen.getByRole('button', { name: '删除单元格' })
    fireEvent.click(removeButton)
    expect(deleteCell).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '再次点击确认删除' }))
    await waitFor(() => {
      expect(deleteCell).toHaveBeenCalledWith(NotebookId('notebook-1'), CellId('cell-1'))
    })
  })

  it('runs from Shift+Enter and inserts a trailing code cell', async () => {
    const runCell = vi.fn(async () => 'ok' as const)
    const insertCell = vi.fn(async () => {})
    render(<NotebookView {...viewProps({ runCell, insertCell })} />)
    fireEvent.keyDown(screen.getByDisplayValue('print("hi")'), { key: 'Enter', shiftKey: true })
    expect(runCell).toHaveBeenCalledWith(NotebookId('notebook-1'), CellId('cell-1'), 'print("hi")')
    const codeInserts = screen.getAllByRole('button', { name: '代码' })
    fireEvent.click(codeInserts[codeInserts.length - 1]!)
    expect(insertCell).toHaveBeenCalledWith(
      NotebookId('notebook-1'), CellId('cell-1'), 'code',
    )
  })

  it('inserts from the leading and trailing gaps and the continue prompt', async () => {
    const insertCell = vi.fn(async () => {})
    render(<NotebookView {...viewProps({ insertCell })} />)
    fireEvent.click(screen.getByRole('button', { name: '开始编写' }))
    await waitFor(() => {
      expect(insertCell).toHaveBeenCalledWith(
        NotebookId('notebook-1'), CellId('cell-1'), 'code',
      )
    })
    const codeInserts = screen.getAllByRole('button', { name: '代码' })
    fireEvent.click(codeInserts[0]!)
    await waitFor(() => {
      expect(insertCell).toHaveBeenCalledWith(NotebookId('notebook-1'), undefined, 'code')
    })
    fireEvent.click(screen.getAllByRole('button', { name: 'Markdown' })[0]!)
    await waitFor(() => {
      expect(insertCell).toHaveBeenCalledWith(NotebookId('notebook-1'), undefined, 'markdown')
    })
    fireEvent.click(screen.getAllByRole('button', { name: 'Markdown' })[1]!)
    await waitFor(() => {
      expect(insertCell).toHaveBeenCalledWith(
        NotebookId('notebook-1'), CellId('cell-1'), 'markdown',
      )
    })
  })

  it('runs every code cell from Run all', async () => {
    const runCell = vi.fn(async () => 'ok' as const)
    render(<NotebookView {...viewProps({ runCell })} />)
    fireEvent.click(screen.getByRole('button', { name: '全部运行' }))
    expect(runCell).toHaveBeenCalledWith(NotebookId('notebook-1'), CellId('cell-1'), 'print("hi")')
  })

  it('stops Run all after a cancelled cell', async () => {
    const runCell = vi.fn(async () => 'cancelled' as const)
    render(<NotebookView {...viewProps({
      snapshot: historySnapshot('ok', { additionalCode: ['second()'] }),
      runCell,
    })} />)
    fireEvent.click(screen.getByRole('button', { name: '全部运行' }))
    await waitFor(() => { expect(runCell).toHaveBeenCalledTimes(1) })
    expect(runCell).toHaveBeenCalledWith(
      NotebookId('notebook-1'), CellId('cell-1'), 'print("hi")',
    )
  })

  it('shows Restart pending and settled states and rejects duplicate submissions', async () => {
    const deferred = Promise.withResolvers<undefined>()
    const restartNotebook = vi.fn(() => deferred.promise)
    render(<NotebookView {...viewProps({ restartNotebook })} />)
    const restart = screen.getByRole('button', { name: '重启内核' })
    fireEvent.click(restart)
    fireEvent.click(restart)
    expect(restartNotebook).toHaveBeenCalledTimes(1)
    expect(screen.getByText('正在重启内核…')).toBeTruthy()
    expect(disabled(restart)).toBe(true)
    expect(disabled(screen.getByRole('button', { name: '运行' }))).toBe(true)
    deferred.resolve(undefined)
    await screen.findByText('内核已重启')
    expect(disabled(restart)).toBe(false)
  })

  it('shows Restart errors and disables the control during cell execution', async () => {
    const restartNotebook = vi.fn(async () => { throw new Error('kernel replacement failed') })
    const view = render(<NotebookView {...viewProps({ restartNotebook })} />)
    fireEvent.click(screen.getByRole('button', { name: '重启内核' }))
    expect((await screen.findByRole('alert')).textContent).toContain('kernel replacement failed')
    view.unmount()

    render(<NotebookView {...viewProps({ snapshot: historySnapshot('running') })} />)
    expect(disabled(screen.getByRole('button', { name: '重启内核' }))).toBe(true)
    expect(disabled(screen.getByRole('button', { name: '从磁盘重新加载' }))).toBe(true)
  })

  it('shows Reload pending and settled states and rejects duplicate submissions', async () => {
    const deferred = Promise.withResolvers<undefined>()
    const reloadNotebook = vi.fn(() => deferred.promise)
    render(<NotebookView {...viewProps({ reloadNotebook })} />)
    const reload = screen.getByRole('button', { name: '从磁盘重新加载' })
    fireEvent.click(reload)
    fireEvent.click(reload)
    expect(reloadNotebook).toHaveBeenCalledTimes(1)
    expect(screen.getByText('正在从磁盘重新加载…')).toBeTruthy()
    expect(disabled(reload)).toBe(true)
    expect(disabled(screen.getByRole('button', { name: '运行' }))).toBe(true)
    deferred.resolve(undefined)
    await screen.findByText('已从磁盘重新加载')
    await screen.findByText('内核已停止')
    expect(disabled(reload)).toBe(false)
  })

  it('runs code cells in document order and stops Run all after a rejection', async () => {
    const order: string[] = []
    const runCell = vi.fn(async (_notebookId: NotebookDocumentId, id: NotebookCellId) => {
      order.push(String(id))
      if (id === CellId('cell-extra-1')) throw new Error('second cell failed')
      return 'ok' as const
    })
    render(<NotebookView {...viewProps({
      snapshot: historySnapshot('ok', {
        additionalCode: ['second()', 'third()'],
      }),
      runCell,
    })} />)
    fireEvent.click(screen.getByRole('button', { name: '全部运行' }))
    await screen.findByRole('alert')
    expect(order).toEqual(['cell-1', 'cell-extra-1'])
    expect(runCell).toHaveBeenCalledTimes(2)
  })

  it('shows an error kernel badge after a failed cell', () => {
    render(<NotebookView {...viewProps({ snapshot: historySnapshot('error') })} />)
    expect(screen.getByTestId('notebook-cell-notebook-1-cell-1').getAttribute('data-status')).toBe('error')
  })

  it('announces cancelled execution state', () => {
    render(<NotebookView {...viewProps({ snapshot: historySnapshot('cancelled') })} />)
    expect(screen.getByTestId('notebook-cell-notebook-1-cell-1').getAttribute('data-status'))
      .toBe('cancelled')
    expect(screen.getAllByText('运行已取消').length).toBeGreaterThan(0)
  })

  it('renders markdown cells as preview and edits on click', () => {
    const editCell = vi.fn(async () => {})
    render(<NotebookView {...viewProps({
      snapshot: historySnapshot('ok', { markdown: '# 分析' }),
      editCell,
    })} />)
    expect(screen.getByText('分析')).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('button', { name: 'Markdown 单元格' }), { key: ' ' })
    const editor = screen.getByDisplayValue('# 分析')
    expect(document.activeElement).toBe(editor)
    fireEvent.change(editor, { target: { value: '## 结论' } })
    fireEvent.blur(editor)
    expect(editCell).toHaveBeenCalledWith(NotebookId('notebook-1'), CellId('cell-md'), '## 结论')
  })

  it('opens an empty markdown cell from keyboard and shows its placeholder', () => {
    render(<NotebookView {...viewProps({
      snapshot: historySnapshot('ok', { markdown: '' }),
    })} />)
    expect(screen.getByText('写一段说明，或点这里编辑')).toBeTruthy()
    const preview = screen.getByRole('button', { name: 'Markdown 单元格' })
    fireEvent.keyDown(preview, { key: 'Enter' })
    const editor = screen.getByLabelText('Markdown 单元格')
    expect(editor.tagName).toBe('TEXTAREA')
    expect(document.activeElement).toBe(editor)
    fireEvent.keyDown(editor, { key: 'Escape' })
    const restoredPreview = screen.getByRole('button', { name: 'Markdown 单元格' })
    expect(document.activeElement).toBe(restoredPreview)
    fireEvent.keyDown(restoredPreview, { key: 'Enter' })
    const reopenedEditor = screen.getByLabelText('Markdown 单元格')
    fireEvent.blur(reopenedEditor)
    expect(screen.getByLabelText('Markdown 单元格').tagName).toBe('TEXTAREA')
  })

  it('edits raw cells as plain text without exposing a run action', () => {
    const editCell = vi.fn(async () => {})
    render(<NotebookView {...viewProps({
      snapshot: historySnapshot('ok', { raw: '<raw notebook text>' }),
      editCell,
    })} />)
    const raw = screen.getByRole('textbox', { name: '原始文本单元格' })
    fireEvent.change(raw, { target: { value: '<updated raw>' } })
    fireEvent.keyDown(raw, { key: 'Enter', shiftKey: true })
    fireEvent.blur(raw)
    expect(editCell).toHaveBeenCalledWith(
      NotebookId('notebook-1'),
      CellId('cell-raw'),
      '<updated raw>',
    )
    expect(screen.getAllByRole('button', { name: '运行' })).toHaveLength(1)
  })

  it('keeps local draft edits separate from the folded session source', () => {
    render(<NotebookView {...viewProps()} />)
    fireEvent.change(screen.getByDisplayValue('print("hi")'), {
      target: { value: 'print("draft")' },
    })
    expect(screen.getByDisplayValue('print("draft")')).toBeTruthy()
  })

  it('identifies a persistence write conflict and reloads away document-local drafts', async () => {
    const failure = Object.assign(new Error('notebook file changed since it was opened'), {
      code: 'notebook-error',
      details: { source: 'persistence', code: 'WRITE_CONFLICT' },
    })
    const editCell = vi.fn(async () => { throw failure })
    const reloadNotebook = vi.fn(async () => {})
    render(<NotebookView {...viewProps({ editCell, reloadNotebook })} />)
    const editor = screen.getByDisplayValue('print("hi")')
    fireEvent.change(editor, { target: { value: 'print("conflicting draft")' } })
    fireEvent.blur(editor)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('文件已被外部修改')
    fireEvent.click(screen.getByRole('button', { name: '从磁盘重新加载' }))
    await screen.findByText('已从磁盘重新加载')
    expect(reloadNotebook).toHaveBeenCalledWith(NotebookId('notebook-1'))
    expect(screen.getByDisplayValue('print("hi")')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('keeps duplicate cell ids isolated by their owning notebook', () => {
    const host = Session.create(HostSessionId('duplicate-cell-spec'))
    const sharedCell = CellId('shared-cell')
    for (const [index, source] of ['first source', 'second source'].entries()) {
      const owner = NotebookId(`notebook-${index + 1}`)
      host.append('notebook/open', {
        notebookId: owner,
        path: `${index + 1}.ipynb`,
        fileVersion: FileVersion(`duplicate-open-${String(index)}`),
        nbformatMinor: 5,
        metadata: {},
      })
      host.append('notebook/cell', {
        notebookId: owner,
        cellId: sharedCell,
        cellType: 'code',
        source,
        index: 0,
        operation: 'create',
        metadata: {},
        attachments: {},
        fileVersion: FileVersion(`duplicate-cell-${String(index)}`),
      })
    }
    const builder = new NotebookSnapshotBuilder()
    const folded = builder.replace({
      nodes: host.events.map(value => notebookNode({
        key: `notebook-event:${value.seq}`,
        kind: 'notebook-event',
        id: String(value.seq),
      }, value.seq, value as never)),
    })
    const snapshot = historySnapshot()
    snapshot.views = notebookViews(folded)
    render(<NotebookView {...viewProps({ snapshot })} />)

    fireEvent.change(screen.getByDisplayValue('first source'), {
      target: { value: 'first draft' },
    })
    expect(screen.getByDisplayValue('first draft')).toBeTruthy()
    fireEvent.change(screen.getByRole('combobox', { name: '当前笔记本' }), {
      target: { value: 'notebook-2' },
    })
    expect(screen.getByDisplayValue('second source')).toBeTruthy()
    fireEvent.change(screen.getByRole('combobox', { name: '当前笔记本' }), {
      target: { value: 'notebook-1' },
    })
    expect(screen.getByDisplayValue('first draft')).toBeTruthy()
  })

  it('keeps acknowledged drafts until the durable source catches up, then accepts remote edits', async () => {
    const editCell = vi.fn(async () => {})
    const store = createSnapshotStore(historySnapshot())
    const props = {
      ...viewProps({ editCell }),
      useSession: bindSnapshotSelector(store),
    }
    render(<NotebookView {...props} />)
    const editor = screen.getByDisplayValue('print("hi")')
    fireEvent.change(editor, { target: { value: 'print("saved")' } })
    fireEvent.blur(editor)
    await screen.findByText('已保存')
    expect(screen.getByDisplayValue('print("saved")')).toBeTruthy()

    store.set(historySnapshot('ok', { source: 'print("saved")' }))
    await waitFor(() => {
      expect(screen.getByDisplayValue('print("saved")')).toBeTruthy()
    })
    store.set(historySnapshot('ok', { source: 'print("remote")' }))
    await waitFor(() => {
      expect(screen.getByDisplayValue('print("remote")')).toBeTruthy()
    })
  })

  it('shows pending and settled run states and rejects duplicate submissions', async () => {
    let finish: (() => void) | undefined
    const stop = Promise.withResolvers<undefined>()
    const runCell = vi.fn(() => new Promise<'ok'>((resolve) => {
      finish = () => { resolve('ok') }
    }))
    const interruptNotebook = vi.fn(() => stop.promise)
    render(<NotebookView {...viewProps({ runCell, interruptNotebook })} />)
    const editor = screen.getByDisplayValue('print("hi")')
    fireEvent.keyDown(editor, { key: 'Enter', shiftKey: true })
    fireEvent.keyDown(editor, { key: 'Enter', shiftKey: true })
    expect(runCell).toHaveBeenCalledTimes(1)
    expect(screen.getByText('正在提交运行…')).toBeTruthy()
    expect(disabled(screen.getByRole('button', { name: '重启内核' }))).toBe(true)
    const interrupt = screen.getByRole('button', { name: '停止运行' })
    fireEvent.click(interrupt)
    fireEvent.click(interrupt)
    expect(interruptNotebook).toHaveBeenCalledTimes(1)
    expect(screen.getByText('正在停止运行…')).toBeTruthy()
    stop.resolve(undefined)
    await screen.findByText('已请求停止运行')
    await screen.findByText('内核已停止')
    finish?.()
    await screen.findByText('运行已完成')
  })

  it('bounds retained terminal action notices while preserving active mutations', async () => {
    const sources = Array.from({ length: 70 }, (_, index) => `cell_${String(index)}()`)
    const editCell = vi.fn(async () => {})
    render(<NotebookView {...viewProps({
      snapshot: historySnapshot('ok', { additionalCode: sources }),
      editCell,
    })} />)
    const editors = screen.getAllByRole('textbox', { name: '单元格源码' })
    for (const [index, editor] of editors.entries()) {
      fireEvent.change(editor, { target: { value: `saved_${String(index)}()` } })
      fireEvent.blur(editor)
    }
    await waitFor(() => {
      expect(editCell).toHaveBeenCalledTimes(editors.length)
      expect(screen.getAllByText('已保存')).toHaveLength(64)
    })
  })

  it('renders rejected RPCs as an alert without leaking a rejected promise', async () => {
    const runCell = vi.fn(async () => { throw new Error('kernel exploded') })
    render(<NotebookView {...viewProps({ runCell })} />)
    fireEvent.click(screen.getByRole('button', { name: '运行' }))
    expect((await screen.findByRole('alert')).textContent).toContain('kernel exploded')
  })

  it('forwards inject verbs through Host RPC and surfaces a failed run', async () => {
    const { slots, api, loadOlder, readAttachment } = await bench({
      runCell: async () => fail('kernel exploded'),
    })
    const verbs = notebookInject(slots)(SID)
    const signal = new AbortController().signal
    const environmentId = EnvironmentId('workspace-venv')
    await verbs.discoverNotebooks(undefined, signal)
    await verbs.openNotebook('analysis.ipynb', signal)
    await verbs.createNotebook('new.ipynb', signal)
    await verbs.environmentCatalog(signal)
    await verbs.installUv(signal)
    await verbs.installPython(signal)
    await verbs.createEnvironment(environmentId, false, false, signal)
    await verbs.attachEnvironment(NotebookId('n'), environmentId, signal)
    await verbs.runtimeStatus(NotebookId('n'), signal)
    await verbs.editCell(NotebookId('n'), CellId('c'), 'x = 1')
    await verbs.insertCell(NotebookId('n'), CellId('anchor'), 'code')
    await verbs.insertCell(NotebookId('n'), undefined, 'raw')
    await expect(verbs.runCell(NotebookId('n'), CellId('c'), 'x')).rejects.toThrow(/kernel exploded/)
    await verbs.restartNotebook(NotebookId('n'))
    await verbs.reloadNotebook(NotebookId('n'))
    await verbs.interruptNotebook(NotebookId('n'))
    await expect(verbs.loadAttachment(IMAGE_REF)).resolves.toEqual({
      attachment: IMAGE_REF,
      data: new Uint8Array([1, 2, 3]),
    })
    await verbs.loadOlder()
    expect(loadOlder).toHaveBeenCalledTimes(1)
    expect(api.notebooks.discover).toHaveBeenCalledWith({ sessionId: SID }, signal)
    expect(api.notebooks.open).toHaveBeenCalledWith({ sessionId: SID, path: 'analysis.ipynb' }, signal)
    expect(api.notebooks.create).toHaveBeenCalledWith({ sessionId: SID, path: 'new.ipynb' }, signal)
    expect(api.notebooks.environmentCatalog).toHaveBeenCalledWith({ sessionId: SID }, signal)
    expect(api.notebooks.installUv).toHaveBeenCalledWith({ sessionId: SID }, signal)
    expect(api.notebooks.installPython).toHaveBeenCalledWith({ sessionId: SID, version: '3.12' }, signal)
    expect(api.notebooks.createEnvironment).toHaveBeenCalledWith({
      sessionId: SID, environmentId, allowExisting: false, rebuild: false,
    }, signal)
    expect(api.notebooks.attachEnvironment).toHaveBeenCalledWith({
      sessionId: SID, notebookId: NotebookId('n'), environmentId,
    }, signal)
    expect(api.notebooks.runtimeStatus).toHaveBeenCalledWith({
      sessionId: SID, notebookId: NotebookId('n'),
    }, signal)
    expect(api.notebooks.editCell).toHaveBeenCalledWith({
      sessionId: SID, notebookId: NotebookId('n'), cellId: CellId('c'), source: 'x = 1',
    })
    expect(api.notebooks.insertCell).toHaveBeenCalledWith({
      sessionId: SID,
      notebookId: NotebookId('n'),
      afterCellId: CellId('anchor'),
      cellType: 'code',
    })
    expect(api.notebooks.insertCell).toHaveBeenCalledWith({
      sessionId: SID,
      notebookId: NotebookId('n'),
      cellType: 'raw',
    })
    expect(api.notebooks.runCell).toHaveBeenCalledWith({
      sessionId: SID, notebookId: NotebookId('n'), cellId: CellId('c'), source: 'x',
    })
    expect(api.notebooks.restart).toHaveBeenCalledWith({
      sessionId: SID, notebookId: NotebookId('n'),
    })
    expect(api.notebooks.reload).toHaveBeenCalledWith({
      sessionId: SID, notebookId: NotebookId('n'),
    })
    expect(api.notebooks.interrupt).toHaveBeenCalledWith({
      sessionId: SID, notebookId: NotebookId('n'),
    })
    expect(readAttachment).toHaveBeenCalledWith({
      sessionId: SID, attachmentId: String(IMAGE_REF.attachmentId),
    })
  })

  it('preserves typed persistence details from a rejected Host RPC', async () => {
    const { slots } = await bench({ editCell: writeConflictFailure })
    const verbs = notebookInject(slots)(SID)
    await expect(verbs.editCell(NotebookId('n'), CellId('c'), 'changed'))
      .rejects.toMatchObject({ source: 'persistence', code: 'WRITE_CONFLICT' })
  })

  it('treats a completed kernel error acknowledgement as a rejected UI run', async () => {
    const { slots } = await bench({
      runCell: async () => ok({
        executionId: 'exec-error',
        status: 'error' as const,
        executionCount: 1,
        error: 'python raised',
      }),
    })
    const verbs = notebookInject(slots)(SID)
    await expect(verbs.runCell(NotebookId('n'), CellId('c'), 'raise Error'))
      .rejects.toThrow(/python raised/)
  })

  it('returns a cancelled acknowledgement without turning it into an RPC error', async () => {
    const { slots } = await bench({
      runCell: async () => ok({
        executionId: 'exec-cancelled',
        status: 'cancelled' as const,
        executionCount: null,
        error: 'stopped by user',
      }),
    })
    const verbs = notebookInject(slots)(SID)
    await expect(verbs.runCell(NotebookId('n'), CellId('c'), 'while True: pass'))
      .resolves.toMatchObject({ status: 'cancelled' })
  })
})

describe('ui-notebook node half', () => {
  it('contributes no host behavior', () => {
    expect(() => { nodeApply() }).not.toThrow()
  })
})
