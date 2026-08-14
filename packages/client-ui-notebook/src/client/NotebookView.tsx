import {
  startTransition, useCallback, useEffect, useMemo, useRef, useState,
} from 'react'
import type {
  CellId,
  CellType,
  NotebookDiscoveryPage,
  NotebookId,
  NotebookKernelRuntimeStatus,
} from '@deepseek-ai/dsh-notebook-core/types'
import type {
  NotebookEnvironmentCatalog,
  NotebookEnvironmentErrorCategory,
  NotebookEnvironmentId,
} from '@deepseek-ai/dsh-notebook-environment/types'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { NotebookDocumentView } from './NotebookDocumentView.tsx'
import { NotebookDocumentSwitcher } from './NotebookDocumentSwitcher.tsx'
import {
  NotebookEnvironmentCard, type NotebookEnvironmentFlow,
} from './NotebookEnvironmentCard.tsx'
import { NotebookHistoryGate } from './NotebookHistoryGate.tsx'
import {
  NotebookLauncher, type NotebookDiscoveryState, type NotebookLauncherProps,
} from './NotebookLauncher.tsx'
import {
  NotebookOperationNotice, type NotebookMutationKind, type NotebookMutationState,
} from './NotebookOperationNotice.tsx'
import type { MimeOutputLabels, NotebookAttachmentLoader } from './MimeOutput.tsx'
import { EMPTY_NOTEBOOK_SNAPSHOT } from './notebook-contract.ts'

const ACTION_STATE_LIMIT = 64

interface CellDraft {
  readonly value: string
  readonly durableSource: string
  readonly acknowledged?: string
}

interface PendingDocument {
  readonly path: string
  readonly kind: 'open' | 'create'
}

interface FailureDetails {
  readonly source?: unknown
  readonly code?: unknown
  readonly category?: unknown
}

interface RuntimeRosterItem {
  readonly id: NotebookId
  readonly environmentId?: NotebookEnvironmentId
}

interface NotebookEnvironmentOperation {
  readonly key: string
  readonly controller: AbortController
  readonly previous: NotebookEnvironmentFlow | undefined
}

function notebookCellPrefix(notebookId: NotebookId): string {
  return `${String(notebookId).length}:${String(notebookId)}`
}

function notebookCellKey(notebookId: NotebookId, cellId: CellId): string {
  return `${notebookCellPrefix(notebookId)}${String(cellId)}`
}

function workspaceNotebookPath(value: string): string | undefined {
  const normalized = value.trim().replaceAll('\\', '/')
  if (
    normalized.length === 0
    || normalized.startsWith('/')
    || /^[a-z]:\//i.test(normalized)
    || normalized.split('/').includes('..')
    || !normalized.toLowerCase().endsWith('.ipynb')
  ) return undefined
  return normalized
}

function suggestedNotebookPath(paths: readonly string[]): string {
  const occupied = new Set(paths.map(path => path.toLowerCase()))
  if (!occupied.has('notebook.ipynb')) return 'notebook.ipynb'
  for (let index = 2; index < Number.MAX_SAFE_INTEGER; index += 1) {
    const candidate = `notebook-${String(index)}.ipynb`
    if (!occupied.has(candidate.toLowerCase())) return candidate
  }
  return 'notebook-new.ipynb'
}

function failureDetails(error: unknown): FailureDetails | undefined {
  if (!(error instanceof Error)) return undefined
  const value = error as Error & { readonly code?: unknown; readonly details?: unknown }
  if (value.code !== 'notebook-error' || typeof value.details !== 'object' || value.details === null) {
    return undefined
  }
  return value.details
}

function isWriteConflict(error: unknown): boolean {
  const details = failureDetails(error)
  return details?.source === 'persistence' && details.code === 'WRITE_CONFLICT'
}

function isStaleCursor(error: unknown): boolean {
  const details = failureDetails(error)
  return details?.source === 'service' && details.code === 'DISCOVERY_CURSOR_STALE'
}

function environmentErrorCategory(error: unknown): NotebookEnvironmentErrorCategory | undefined {
  const category = failureDetails(error)?.category
  if (
    category === 'manager'
    || category === 'python'
    || category === 'permission'
    || category === 'dependency'
    || category === 'kernelspec'
    || category === 'kernel-start'
  ) return category
  return undefined
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

function failedEnvironmentFlow(
  previous: NotebookEnvironmentFlow | undefined,
  error: unknown,
): NotebookEnvironmentFlow {
  const category = environmentErrorCategory(error)
  return {
    phase: 'failed',
    ...(previous?.catalog === undefined ? {} : { catalog: previous.catalog }),
    error: error instanceof Error ? error.message : String(error),
    ...(category === undefined ? {} : { errorCategory: category }),
  }
}

/** Session-bound Notebook reads and mutations through Host RPC. */
export interface NotebookViewInjected {
  /** Discover one bounded page without opening a document or resuming an Agent. */
  discoverNotebooks: (after: string | undefined, signal: AbortSignal) => Promise<NotebookDiscoveryPage>
  /** Open one existing workspace Notebook. */
  openNotebook: (path: string, signal: AbortSignal) => Promise<void>
  /** Create one absent workspace Notebook without overwriting. */
  createNotebook: (path: string, signal: AbortSignal) => Promise<void>
  /** Read the workspace environment catalog without exposing executable paths. */
  environmentCatalog: (signal: AbortSignal) => Promise<NotebookEnvironmentCatalog>
  /** Install the verified private uv release. */
  installUv: (signal: AbortSignal) => Promise<NotebookEnvironmentCatalog>
  /** Install the explicitly confirmed Python 3.12 line. */
  installPython: (signal: AbortSignal) => Promise<NotebookEnvironmentCatalog>
  /** Provision or explicitly enable the fixed workspace environment. */
  createEnvironment: (
    environmentId: NotebookEnvironmentId,
    allowExisting: boolean,
    rebuild: boolean,
    signal: AbortSignal,
  ) => Promise<NotebookEnvironmentCatalog>
  /** Attach one ready environment and publish the kernel selection. */
  attachEnvironment: (
    notebookId: NotebookId,
    environmentId: NotebookEnvironmentId,
    signal: AbortSignal,
  ) => Promise<void>
  /** Read process-local kernel state for one document. */
  runtimeStatus: (
    notebookId: NotebookId,
    signal: AbortSignal,
  ) => Promise<NotebookKernelRuntimeStatus>
  /** Persist one cell's source text. */
  editCell: (notebookId: NotebookId, cellId: CellId, source: string) => Promise<void>
  /** Insert one cell after a stable predecessor. */
  insertCell: (
    notebookId: NotebookId,
    afterCellId: CellId | undefined,
    cellType: CellType,
  ) => Promise<void>
  /** Persist optional source and execute one code cell as a user operation. */
  runCell: (
    notebookId: NotebookId,
    cellId: CellId,
    source: string,
  ) => Promise<'ok' | 'cancelled'>
  /** Restart a document's selected environment. */
  restartNotebook: (notebookId: NotebookId) => Promise<void>
  /** Replace one document with its current complete disk revision. */
  reloadNotebook: (notebookId: NotebookId) => Promise<void>
  /** Interrupt the active execution for one document. */
  interruptNotebook: (notebookId: NotebookId) => Promise<void>
  /** Resolve one raster through the currently rendered Session. */
  loadAttachment: NotebookAttachmentLoader
  /** Load one older page of this Session's event history. */
  loadOlder: () => Promise<void>
  /** Archive this incompatible Session and open a replacement. */
  replaceSession: () => Promise<void>
  /** Close the responsive Notebook panel. */
  closeNotebookPanel: () => void
}

/**
 * Coordinate Notebook history, discovery, environment setup, and one active document canvas.
 * @param props - Session selector, Host operations, layout transition, attachments, and locale.
 * @returns The ordered history gate, launcher, selector, environment card, and document view.
 */
export function NotebookView({
  useSession, discoverNotebooks, openNotebook, createNotebook, environmentCatalog,
  installUv, installPython, createEnvironment, attachEnvironment, runtimeStatus,
  editCell, insertCell, runCell, restartNotebook, reloadNotebook, interruptNotebook,
  loadAttachment, loadOlder, replaceSession, closeNotebookPanel, t,
}: PropsRuntime<'companion'> & InjectFace<NotebookViewInjected> & PropsLocale<'notebook'>) {
  const snapshot = useSession(session => session.views.get('notebook') ?? EMPTY_NOTEBOOK_SNAPSHOT)
  const openState = useSession(session => session.openState)
  const hasMore = useSession(session => session.hasMore)
  const loadingOlder = useSession(session => session.loadingOlder)
  const historyError = useSession(session => session.openError)
  const notebooks = snapshot.folded.notebooks
  const historyReady = openState === 'open'
    && !snapshot.incomplete
    && snapshot.protocolError === null

  const [drafts, setDrafts] = useState<ReadonlyMap<string, CellDraft>>(() => new Map())
  const [actions, setActions] = useState<ReadonlyMap<string, NotebookMutationState>>(() => new Map())
  const [selectedCell, setSelectedCell] = useState<string>()
  const [activeNotebookId, setActiveNotebookId] = useState<NotebookId>()
  const [newDocumentIds, setNewDocumentIds] = useState<ReadonlySet<string>>(() => new Set())
  const [launcherOpen, setLauncherOpen] = useState(true)
  const [createPath, setCreatePath] = useState('notebook.ipynb')
  const [openPath, setOpenPath] = useState('notebook.ipynb')
  const [pendingDocument, setPendingDocument] = useState<PendingDocument>()
  const [discovery, setDiscovery] = useState<NotebookDiscoveryState>({
    phase: 'discovering', items: [], partial: false, loadingMore: false,
  })
  const [environmentFlows, setEnvironmentFlows] = useState<ReadonlyMap<string, NotebookEnvironmentFlow>>(
    () => new Map(),
  )
  const [runtimeStatuses, setRuntimeStatuses] = useState<ReadonlyMap<string, NotebookKernelRuntimeStatus>>(
    () => new Map(),
  )

  const inFlight = useRef(new Map<string, Promise<boolean>>())
  const pendingDocumentRef = useRef<PendingDocument>()
  const documentController = useRef<AbortController>()
  const discoveryController = useRef<AbortController>()
  const discoveryEpoch = useRef(0)
  const environmentControllers = useRef(new Map<string, AbortController>())
  const runtimeController = useRef<AbortController>()
  const runtimeEpoch = useRef(0)
  const runtimeRoster = useRef<readonly RuntimeRosterItem[]>([])
  const knownDocumentIds = useRef<Set<string>>()
  const createPathDirty = useRef(false)
  const scrollPositions = useRef(new Map<string, number>())

  const setAction = useCallback((key: string, state: NotebookMutationState) => {
    setActions((current) => {
      const next = new Map(current)
      next.delete(key)
      next.set(key, state)
      while (next.size > ACTION_STATE_LIMIT) {
        const removable = [...next].find(([candidate, value]) =>
          candidate !== key && value.phase !== 'pending')
        if (removable === undefined) break
        next.delete(removable[0])
      }
      return next
    })
  }, [])

  const perform = useCallback((
    lockKey: string,
    stateKey: string,
    kind: NotebookMutationKind,
    work: () => Promise<void>,
  ): Promise<boolean> => {
    if (inFlight.current.has(lockKey)) return Promise.resolve(false)
    const task = (async () => {
      setAction(stateKey, { kind, phase: 'pending' })
      try {
        await work()
        setAction(stateKey, { kind, phase: 'settled' })
        return true
      } catch (error: unknown) {
        setAction(stateKey, {
          kind,
          phase: 'error',
          error: error instanceof Error ? error.message : String(error),
          ...(isWriteConflict(error) ? { writeConflict: true } : {}),
        })
        return false
      }
    })()
    inFlight.current.set(lockKey, task)
    void task.then(() => {
      if (inFlight.current.get(lockKey) === task) inFlight.current.delete(lockKey)
    })
    return task
  }, [setAction])

  const requestDiscovery = useCallback(async (after: string | undefined, append: boolean): Promise<void> => {
    discoveryController.current?.abort()
    const controller = new AbortController()
    discoveryController.current = controller
    const epoch = discoveryEpoch.current + 1
    discoveryEpoch.current = epoch
    setDiscovery(current => append
      ? (() => {
        const { error: _error, ...retained } = current
        return { ...retained, phase: 'ready', loadingMore: true }
      })()
      : { phase: 'discovering', items: [], partial: false, loadingMore: false })
    try {
      const page = await discoverNotebooks(after, controller.signal)
      if (controller.signal.aborted || discoveryEpoch.current !== epoch) return
      startTransition(() => {
        setDiscovery(current => ({
          phase: 'ready',
          items: append ? [...current.items, ...page.items] : page.items,
          ...(page.nextAfter === undefined ? {} : { nextAfter: page.nextAfter }),
          partial: append ? current.partial || page.partial : page.partial,
          loadingMore: false,
        }))
      })
    } catch (error: unknown) {
      if (controller.signal.aborted || discoveryEpoch.current !== epoch || isAbort(error)) return
      if (append && isStaleCursor(error)) {
        await requestDiscovery(undefined, false)
        return
      }
      setDiscovery(current => ({
        ...current,
        phase: 'error',
        loadingMore: false,
        error: error instanceof Error ? error.message : String(error),
      }))
    }
  }, [discoverNotebooks])

  useEffect(() => {
    if (!historyReady) return
    void requestDiscovery(undefined, false)
    return () => { discoveryController.current?.abort() }
  }, [historyReady, requestDiscovery])

  useEffect(() => {
    if (createPathDirty.current || discovery.phase !== 'ready') return
    setCreatePath(suggestedNotebookPath([
      ...discovery.items.map(item => item.path),
      ...notebooks.map(notebook => notebook.path),
    ]))
  }, [discovery, notebooks])

  useEffect(() => {
    const currentIds = new Set(notebooks.map(notebook => String(notebook.id)))
    const previous = knownDocumentIds.current
    knownDocumentIds.current = currentIds
    if (previous === undefined) {
      if (notebooks[0] !== undefined) {
        setActiveNotebookId(notebooks[0].id)
        setLauncherOpen(false)
      }
      return
    }
    const pending = pendingDocumentRef.current
    const projected = pending === undefined
      ? undefined
      : notebooks.find(notebook => notebook.path === pending.path)
    if (projected !== undefined && pending !== undefined) {
      documentController.current?.abort()
      documentController.current = undefined
      setActiveNotebookId(projected.id)
      setLauncherOpen(false)
      setAction(pending.kind, { kind: pending.kind, phase: 'settled' })
      pendingDocumentRef.current = undefined
      setPendingDocument(undefined)
      setNewDocumentIds((current) => {
        if (!current.has(String(projected.id))) return current
        const next = new Set(current)
        next.delete(String(projected.id))
        return next
      })
      void requestDiscovery(undefined, false)
    } else {
      const additions = notebooks.filter(notebook => !previous.has(String(notebook.id)))
      if (additions.length > 0) {
        setNewDocumentIds(current => new Set([
          ...current,
          ...additions.map(notebook => String(notebook.id)),
        ]))
      }
    }
    const activeExists = notebooks.some(notebook => notebook.id === activeNotebookId)
    if (!activeExists && notebooks[0] !== undefined) setActiveNotebookId(notebooks[0].id)
  }, [activeNotebookId, notebooks, requestDiscovery, setAction])

  const submitDocument = useCallback(async (kind: 'open' | 'create', rawPath: string): Promise<void> => {
    if (pendingDocumentRef.current !== undefined) return
    const path = workspaceNotebookPath(rawPath)
    if (path === undefined) {
      setAction(kind, { kind, phase: 'error', error: t('empty.pathInvalid') })
      return
    }
    const existing = notebooks.find(notebook => notebook.path === path)
    if (kind === 'open' && existing !== undefined) {
      setActiveNotebookId(existing.id)
      setLauncherOpen(false)
      setNewDocumentIds((current) => {
        if (!current.has(String(existing.id))) return current
        const next = new Set(current)
        next.delete(String(existing.id))
        return next
      })
      return
    }
    const pending = { kind, path } satisfies PendingDocument
    pendingDocumentRef.current = pending
    setPendingDocument(pending)
    setAction(kind, { kind, phase: 'pending' })
    const controller = new AbortController()
    documentController.current = controller
    try {
      if (kind === 'open') await openNotebook(path, controller.signal)
      else await createNotebook(path, controller.signal)
    } catch (error: unknown) {
      if (pendingDocumentRef.current !== pending) return
      pendingDocumentRef.current = undefined
      if (documentController.current === controller) documentController.current = undefined
      setPendingDocument(undefined)
      setAction(kind, {
        kind,
        phase: 'error',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }, [createNotebook, notebooks, openNotebook, setAction, t])

  const durableSources = useMemo(() => {
    const sources = new Map<string, string>()
    for (const notebook of notebooks) {
      for (const cell of notebook.cells) sources.set(notebookCellKey(notebook.id, cell.id), cell.source)
    }
    return sources
  }, [notebooks])

  useEffect(() => {
    setDrafts((current) => {
      let changed = false
      const next = new Map(current)
      for (const [key, draft] of current) {
        const source = durableSources.get(key)
        const caughtUp = draft.acknowledged !== undefined && source === draft.acknowledged
        const clean = draft.acknowledged === undefined
          && source === draft.value
          && !inFlight.current.has(`edit:${key}`)
        if (caughtUp || clean || source === undefined) {
          next.delete(key)
          changed = true
        }
      }
      return changed ? next : current
    })
  }, [durableSources])

  const draftFor = useCallback((notebookId: NotebookId, cellId: CellId, source: string) =>
    drafts.get(notebookCellKey(notebookId, cellId))?.value ?? source, [drafts])

  const setDraft = useCallback((
    notebookId: NotebookId,
    cellId: CellId,
    durableSource: string,
    value: string,
  ) => {
    const key = notebookCellKey(notebookId, cellId)
    setDrafts((current) => {
      const next = new Map(current)
      if (value === durableSource && !inFlight.current.has(`edit:${key}`)) next.delete(key)
      else next.set(key, { value, durableSource })
      return next
    })
  }, [])

  const acknowledgeDraft = useCallback((key: string, source: string) => {
    setDrafts((current) => {
      const draft = current.get(key)
      if (draft === undefined || draft.value !== source) return current
      const next = new Map(current)
      next.set(key, { ...draft, acknowledged: source })
      return next
    })
  }, [])

  const commit = useCallback(async (
    notebookId: NotebookId,
    cellId: CellId,
    durableSource: string,
    source: string,
  ): Promise<void> => {
    const key = notebookCellKey(notebookId, cellId)
    if (source === durableSource && !inFlight.current.has(`edit:${key}`)) {
      setDrafts((current) => {
        if (!current.has(key)) return current
        const next = new Map(current)
        next.delete(key)
        return next
      })
      return
    }
    const saved = await perform(
      `edit:${key}`,
      `edit:${key}`,
      'edit',
      async () => { await editCell(notebookId, cellId, source) },
    )
    if (saved) acknowledgeDraft(key, source)
  }, [acknowledgeDraft, editCell, perform])

  const run = useCallback(async (
    notebookId: NotebookId,
    cellId: CellId,
    source: string,
  ): Promise<boolean> => {
    const key = notebookCellKey(notebookId, cellId)
    const pendingEdit = inFlight.current.get(`edit:${key}`)
    if (pendingEdit !== undefined) await pendingEdit
    let outcome: 'ok' | 'cancelled' | undefined
    const submitted = await perform(
      `kernel:${String(notebookId)}`,
      `run:${key}`,
      'run',
      async () => { outcome = await runCell(notebookId, cellId, source) },
    )
    if (submitted) acknowledgeDraft(key, source)
    return submitted && outcome === 'ok'
  }, [acknowledgeDraft, perform, runCell])

  const insert = useCallback(async (
    notebookId: NotebookId,
    afterCellId: CellId | undefined,
    cellType: CellType,
  ): Promise<void> => {
    await perform(
      `insert:${String(notebookId)}`,
      `insert:${String(notebookId)}`,
      'insert',
      async () => { await insertCell(notebookId, afterCellId, cellType) },
    )
  }, [insertCell, perform])

  const restart = useCallback(async (notebookId: NotebookId): Promise<void> => {
    const key = `restart:${String(notebookId)}`
    await perform(`kernel:${String(notebookId)}`, key, 'restart', async () => {
      await restartNotebook(notebookId)
    })
  }, [perform, restartNotebook])

  const reload = useCallback(async (notebookId: NotebookId): Promise<void> => {
    const key = `reload:${String(notebookId)}`
    const environmentId = runtimeRoster.current.find(item => item.id === notebookId)?.environmentId
    const reloaded = await perform(`kernel:${String(notebookId)}`, key, 'reload', async () => {
      await reloadNotebook(notebookId)
    })
    if (!reloaded) return
    if (environmentId !== undefined) {
      setRuntimeStatuses((current) => {
        const next = new Map(current)
        next.set(String(notebookId), { status: 'stopped', environmentId })
        return next
      })
    }
    const cellPrefix = notebookCellPrefix(notebookId)
    setDrafts((current) => {
      const next = new Map(current)
      for (const draftKey of next.keys()) {
        if (draftKey.startsWith(cellPrefix)) next.delete(draftKey)
      }
      return next.size === current.size ? current : next
    })
    setActions((current) => {
      const next = new Map(current)
      for (const actionKey of next.keys()) {
        if (
          actionKey.startsWith(`edit:${cellPrefix}`)
          || actionKey.startsWith(`run:${cellPrefix}`)
          || actionKey === `insert:${String(notebookId)}`
        ) next.delete(actionKey)
      }
      return next.size === current.size ? current : next
    })
    setSelectedCell(current => current?.startsWith(cellPrefix) === true ? undefined : current)
  }, [perform, reloadNotebook])

  const interrupt = useCallback(async (notebookId: NotebookId): Promise<void> => {
    const key = `interrupt:${String(notebookId)}`
    const environmentId = runtimeRoster.current.find(item => item.id === notebookId)?.environmentId
    const interrupted = await perform(key, key, 'interrupt', async () => { await interruptNotebook(notebookId) })
    if (!interrupted || environmentId === undefined) return
    setRuntimeStatuses((current) => {
      const next = new Map(current)
      next.set(String(notebookId), { status: 'stopped', environmentId })
      return next
    })
  }, [interruptNotebook, perform])

  const loadEarlier = useCallback(async (): Promise<void> => {
    await perform('history', 'history', 'history', loadOlder)
  }, [loadOlder, perform])

  const replace = useCallback(async (): Promise<void> => {
    await perform('replace', 'replace', 'replace', replaceSession)
  }, [perform, replaceSession])

  const setEnvironmentFlow = useCallback((notebookId: NotebookId, flow: NotebookEnvironmentFlow) => {
    setEnvironmentFlows((current) => {
      const next = new Map(current)
      next.set(String(notebookId), flow)
      return next
    })
  }, [])

  const setEnvironmentPhase = useCallback((
    notebookId: NotebookId,
    phase: Exclude<NotebookEnvironmentFlow['phase'], 'required' | 'failed'>,
    previous: NotebookEnvironmentFlow | undefined,
  ): void => {
    setEnvironmentFlow(notebookId, {
      phase,
      ...(previous?.catalog === undefined ? {} : { catalog: previous.catalog }),
    })
  }, [setEnvironmentFlow])

  const beginEnvironmentOperation = useCallback((
    notebookId: NotebookId,
    phase: Exclude<NotebookEnvironmentFlow['phase'], 'required' | 'failed'>,
  ): NotebookEnvironmentOperation => {
    const key = String(notebookId)
    environmentControllers.current.get(key)?.abort()
    const controller = new AbortController()
    environmentControllers.current.set(key, controller)
    const previous = environmentFlows.get(key)
    setEnvironmentPhase(notebookId, phase, previous)
    return { key, controller, previous }
  }, [environmentFlows, setEnvironmentPhase])

  const runEnvironmentCatalogOperation = useCallback(async (
    notebookId: NotebookId,
    phase: 'checking' | 'installing-uv' | 'installing-python',
    work: (signal: AbortSignal) => Promise<NotebookEnvironmentCatalog>,
  ): Promise<void> => {
    const { key, controller, previous } = beginEnvironmentOperation(notebookId, phase)
    try {
      const catalog = await work(controller.signal)
      if (controller.signal.aborted || environmentControllers.current.get(key) !== controller) return
      setEnvironmentFlow(notebookId, { phase: 'required', catalog })
    } catch (error: unknown) {
      if (controller.signal.aborted || isAbort(error)) return
      setEnvironmentFlow(notebookId, failedEnvironmentFlow(previous, error))
    }
  }, [beginEnvironmentOperation, setEnvironmentFlow])

  const refreshEnvironment = useCallback(async (notebookId: NotebookId): Promise<void> => {
    await runEnvironmentCatalogOperation(notebookId, 'checking', environmentCatalog)
  }, [environmentCatalog, runEnvironmentCatalogOperation])

  const attach = useCallback(async (
    notebookId: NotebookId,
    environmentId: NotebookEnvironmentId,
    controller?: AbortController,
  ): Promise<void> => {
    const key = String(notebookId)
    const operation = controller ?? new AbortController()
    if (controller === undefined) {
      environmentControllers.current.get(key)?.abort()
      environmentControllers.current.set(key, operation)
    }
    const previous = environmentFlows.get(key)
    setEnvironmentPhase(notebookId, 'attaching', previous)
    try {
      await attachEnvironment(notebookId, environmentId, operation.signal)
      if (operation.signal.aborted || environmentControllers.current.get(key) !== operation) return
    } catch (error: unknown) {
      if (operation.signal.aborted || isAbort(error)) return
      setEnvironmentFlow(notebookId, failedEnvironmentFlow(previous, error))
    }
  }, [attachEnvironment, environmentFlows, setEnvironmentFlow, setEnvironmentPhase])

  const provision = useCallback(async (
    notebookId: NotebookId,
    environmentId: NotebookEnvironmentId,
    allowExisting: boolean,
    rebuild: boolean,
  ): Promise<void> => {
    const { key, controller, previous } = beginEnvironmentOperation(notebookId, 'provisioning')
    try {
      const catalog = await createEnvironment(environmentId, allowExisting, rebuild, controller.signal)
      if (controller.signal.aborted || environmentControllers.current.get(key) !== controller) return
      setEnvironmentFlow(notebookId, { phase: 'attaching', catalog })
      await attach(notebookId, environmentId, controller)
    } catch (error: unknown) {
      if (controller.signal.aborted || isAbort(error)) return
      setEnvironmentFlow(notebookId, failedEnvironmentFlow(previous, error))
    }
  }, [attach, beginEnvironmentOperation, createEnvironment, setEnvironmentFlow])

  runtimeRoster.current = notebooks.map(notebook => ({
    id: notebook.id,
    ...(notebook.kernel === undefined ? {} : { environmentId: notebook.kernel.environmentId }),
  }))
  const runtimeSignature = JSON.stringify(notebooks.map(notebook => [
    notebook.id,
    notebook.kernel?.generation ?? 0,
  ]))
  useEffect(() => {
    if (!historyReady) {
      runtimeController.current?.abort()
      setRuntimeStatuses(new Map())
      return
    }
    runtimeController.current?.abort()
    const controller = new AbortController()
    runtimeController.current = controller
    const epoch = runtimeEpoch.current + 1
    runtimeEpoch.current = epoch
    void (async () => {
      const entries = await Promise.all(runtimeRoster.current.map(async (notebook) => {
        try {
          return [String(notebook.id), await runtimeStatus(notebook.id, controller.signal)] as const
        } catch (error: unknown) {
          if (controller.signal.aborted || isAbort(error)) return undefined
          const fallback: NotebookKernelRuntimeStatus = notebook.environmentId === undefined
            ? { status: 'detached' }
            : {
              status: 'failed',
              environmentId: notebook.environmentId,
              message: error instanceof Error ? error.message : String(error),
            }
          return [String(notebook.id), fallback] as const
        }
      }))
      if (controller.signal.aborted || runtimeEpoch.current !== epoch) return
      setRuntimeStatuses(new Map(entries.filter(entry => entry !== undefined)))
    })()
    return () => { controller.abort() }
  }, [historyReady, runtimeSignature, runtimeStatus])

  const activeNotebook = notebooks.find(notebook => notebook.id === activeNotebookId) ?? notebooks[0]
  useEffect(() => {
    if (!historyReady || activeNotebook === undefined || activeNotebook.kernel !== undefined) return
    if (!environmentFlows.has(String(activeNotebook.id))) void refreshEnvironment(activeNotebook.id)
  }, [activeNotebook, environmentFlows, historyReady, refreshEnvironment])

  useEffect(() => () => {
    documentController.current?.abort()
    discoveryController.current?.abort()
    for (const controller of environmentControllers.current.values()) controller.abort()
    runtimeController.current?.abort()
  }, [])

  const formatOmitted = useCallback((count: number, unit: 'rows' | 'points' | 'columns'): string => {
    const key = unit === 'rows'
      ? 'output.omittedRows'
      : unit === 'points'
        ? 'output.omittedPoints'
        : 'output.omittedColumns'
    return t(key).replace('{count}', String(count))
  }, [t])

  const outputLabels = useMemo<MimeOutputLabels>(() => ({
    imageLoading: t('output.imageLoading'),
    imageLoadFailed: t('output.imageLoadFailed'),
    imageRetry: t('output.imageRetry'),
    binaryOmitted: t('output.binaryOmitted'),
    emptyBundle: t('output.emptyBundle'),
  }), [t])

  const historyPending = loadingOlder || actions.get('history')?.phase === 'pending'
  const replacementPending = actions.get('replace')?.phase === 'pending'
  const documentPending = pendingDocument !== undefined
  const openPaths = new Set(notebooks.map(notebook => notebook.path))
  const launcherDiscovery: NotebookDiscoveryState = {
    ...discovery,
    items: discovery.items.filter(item => !openPaths.has(item.path)),
  }
  const activeRuntime: NotebookKernelRuntimeStatus = activeNotebook === undefined
    ? { status: 'detached' }
    : runtimeStatuses.get(String(activeNotebook.id))
      ?? (activeNotebook.kernel === undefined
        ? { status: 'detached' }
        : { status: 'stopped', environmentId: activeNotebook.kernel.environmentId })
  const activeFlow = activeNotebook === undefined
    ? undefined
    : environmentFlows.get(String(activeNotebook.id)) ?? { phase: 'checking' as const }
  const launcherProps: NotebookLauncherProps = {
    discovery: launcherDiscovery,
    createPath,
    openPath,
    pending: documentPending,
    createInvalid: actions.get('create')?.phase === 'error',
    openInvalid: actions.get('open')?.phase === 'error',
    notice: (
      <>
        <NotebookOperationNotice state={actions.get('create')} t={t} />
        <NotebookOperationNotice state={actions.get('open')} t={t} />
      </>
    ),
    onCreatePathChange: (path) => {
      createPathDirty.current = true
      setCreatePath(path)
    },
    onOpenPathChange: setOpenPath,
    onCreate: () => { void submitDocument('create', createPath) },
    onOpenPath: () => { void submitDocument('open', openPath) },
    onOpenCandidate: (path) => { void submitDocument('open', path) },
    onRefresh: () => { void requestDiscovery(undefined, false) },
    onLoadMore: () => { void requestDiscovery(discovery.nextAfter, true) },
    t,
  }

  return (
    <NotebookHistoryGate
      openState={openState}
      openError={historyError}
      incompatible={snapshot.protocolError !== null}
      incomplete={snapshot.incomplete}
      hasDocuments={notebooks.length > 0}
      hasMore={hasMore}
      historyPending={historyPending}
      replacementPending={replacementPending}
      historyAction={actions.get('history')}
      replacementAction={actions.get('replace')}
      onLoadOlder={() => { void loadEarlier() }}
      onReplaceSession={() => { void replace() }}
      t={t}
    >
      {notebooks.length === 0
        ? (
          <NotebookLauncher {...launcherProps} />
        )
        : activeNotebook === undefined
          ? null
          : (
            <>
              <NotebookDocumentSwitcher
                notebooks={notebooks}
                activeId={activeNotebook.id}
                newDocumentCount={newDocumentIds.size}
                launcherOpen={launcherOpen}
                onSelect={(notebookId) => {
                  setActiveNotebookId(notebookId)
                  setNewDocumentIds((current) => {
                    if (!current.has(String(notebookId))) return current
                    const next = new Set(current)
                    next.delete(String(notebookId))
                    return next
                  })
                }}
                onToggleLauncher={() => { setLauncherOpen(current => !current) }}
                onClosePanel={() => {
                  const toggle = document.querySelector<HTMLElement>('[aria-controls="dsh-notebook-panel"]')
                  closeNotebookPanel()
                  toggle?.focus()
                }}
                t={t}
              />
              {launcherOpen
                ? (
                  <NotebookLauncher
                    {...launcherProps}
                    compact
                    onDismiss={() => { setLauncherOpen(false) }}
                  />
                )
                : null}
              <NotebookDocumentView
                document={activeNotebook}
                runtime={activeRuntime}
                environmentCard={activeNotebook.kernel === undefined && activeFlow !== undefined
                  ? (
                    <NotebookEnvironmentCard
                      flow={activeFlow}
                      onRefresh={() => { void refreshEnvironment(activeNotebook.id) }}
                      onInstallUv={() => {
                        void runEnvironmentCatalogOperation(activeNotebook.id, 'installing-uv', installUv)
                      }}
                      onInstallPython={() => {
                        void runEnvironmentCatalogOperation(activeNotebook.id, 'installing-python', installPython)
                      }}
                      onProvision={(environmentId, allowExisting, rebuild) => {
                        void provision(activeNotebook.id, environmentId, allowExisting, rebuild)
                      }}
                      onAttach={(environmentId) => { void attach(activeNotebook.id, environmentId) }}
                      onCancel={() => {
                        environmentControllers.current.get(String(activeNotebook.id))?.abort()
                        const current = environmentFlows.get(String(activeNotebook.id))
                        setEnvironmentFlow(activeNotebook.id, {
                          phase: 'required',
                          ...(current?.catalog === undefined ? {} : { catalog: current.catalog }),
                        })
                      }}
                      t={t}
                    />
                  )
                  : undefined}
                protocolLocked={snapshot.protocolError !== null}
                selectedCellKey={selectedCell}
                scrollTop={scrollPositions.current.get(String(activeNotebook.id)) ?? 0}
                actionFor={key => actions.get(key)}
                draftFor={(cellId, source) => draftFor(activeNotebook.id, cellId, source)}
                onSelectCell={setSelectedCell}
                onScrollTopChange={(scrollTop) => {
                  scrollPositions.current.set(String(activeNotebook.id), scrollTop)
                }}
                onDraft={(cellId, durableSource, value) => {
                  setDraft(activeNotebook.id, cellId, durableSource, value)
                }}
                onCommit={(cellId, durableSource, value) => {
                  void commit(activeNotebook.id, cellId, durableSource, value)
                }}
                onRun={(cellId, source) => run(activeNotebook.id, cellId, source)}
                onInsert={(afterCellId, cellType) => { void insert(activeNotebook.id, afterCellId, cellType) }}
                onInterrupt={() => { void interrupt(activeNotebook.id) }}
                onReload={() => { void reload(activeNotebook.id) }}
                onRestart={() => { void restart(activeNotebook.id) }}
                loadAttachment={loadAttachment}
                outputLabels={outputLabels}
                formatOmitted={formatOmitted}
                t={t}
              />
            </>
          )}
    </NotebookHistoryGate>
  )
}
