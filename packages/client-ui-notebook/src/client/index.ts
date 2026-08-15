/**
 * Browser notebook plugin occupying the optional details column.
 */
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {
  CellId,
  CellType,
  NotebookDocument,
  NotebookId,
  NotebookKernelRuntimeStatus,
} from '@younthing/dsh-notebook-core/client'
import type {
  NotebookEnvironmentCatalog,
  NotebookEnvironmentId,
} from '@younthing/dsh-notebook-environment/client'
import notebookRemote from '@younthing/dsh-notebook-remote/remote'
import type { NotebookRemoteError, NotebookRemoteResult } from '@younthing/dsh-notebook-remote/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
// Type-only: supplies ctx.remote and the generated notebooks namespace merge.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@younthing/dsh-notebook-remote/remote'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the details SlotMap row must be in the program.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { en, NS, zh } from './locales.ts'
import { registerNotebookConversationView } from './notebook-event-definition.ts'
import { NotebookView, type NotebookViewInjected } from './NotebookView.tsx'
import {
  NotebookPanelAction, type NotebookPanelActionInjected,
} from './NotebookPanelAction.tsx'

/** Required services: slots, registries, Session/Workspace actions, locale, and the Remote gateway. */
export const inject = [
  'slots', 'conversationEvents', 'conversationViews', 'sessions', 'workspaces', 'layout', 'locale', 'remote',
]

class NotebookRemoteFailure extends Error {
  readonly source: NotebookRemoteError['source']
  readonly code: string

  constructor(error: NotebookRemoteError) {
    super(error.message)
    this.name = 'NotebookRemoteFailure'
    this.source = error.source
    this.code = error.code
  }
}

function unwrap<T>(result: RemoteResult<NotebookRemoteResult<T>>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  if (!result.value.ok) throw new NotebookRemoteFailure(result.value.error)
  return result.value.value
}

function environmentCatalog(value: import('@younthing/dsh-notebook-remote/types').NotebookEnvironmentCatalog): NotebookEnvironmentCatalog {
  return {
    ...value,
    environments: value.environments.map(entry => ({
      ...entry,
      id: entry.id as NotebookEnvironmentId,
    })),
  }
}

function runtimeStatus(value: import('@younthing/dsh-notebook-remote/types').NotebookKernelRuntimeStatus): NotebookKernelRuntimeStatus {
  if (value.status === 'detached') return value
  return { ...value, environmentId: value.environmentId as NotebookEnvironmentId }
}

function notebookDocument(
  value: import('@younthing/dsh-notebook-remote/types').NotebookDocument,
): NotebookDocument {
  return value as unknown as NotebookDocument
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value)
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}

/**
 * Client plugin body: register the notebook pane.
 * @param ctx - client root context.
 */
export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(notebookRemote)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-notebook: dictionaries')
  registerNotebookConversationView(ctx)
  ctx.slots.inject(
    'conversation.session.header.actions',
    () => ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'notebook-panel',
      order: 30,
      locale: NS,
      inject: (): NotebookPanelActionInjected => ({
        toggleNotebookPanel: () => { ctx.layout.openDetails() },
      }),
    }, NotebookPanelAction),
  )
  // rc.6 baseline: the AppFrame right column is the single `details` seat
  // occupied by ui-conversation's tool-details panel at priority 0. The
  // The notebook panel shadows the standard tool-details cell because lower priority wins.
  ctx.slots.inject('details', () => ctx.slots.register({
    name: 'details',
    priority: -1,
    locale: NS,
    inject: (sessionId: SessionId): NotebookViewInjected => ({
      discoverNotebooks: async (after, signal) => unwrap(await ctx.remote.notebooks.discover({
        sessionId,
        ...(after === undefined ? {} : { after }),
      }, signal)),
      openNotebook: async (path, signal) => notebookDocument(
        unwrap(await ctx.remote.notebooks.open({ sessionId, path }, signal)),
      ),
      createNotebook: async (path, signal) => notebookDocument(
        unwrap(await ctx.remote.notebooks.create({ sessionId, path }, signal)),
      ),
      environmentCatalog: async signal => environmentCatalog(unwrap(
        await ctx.remote.notebooks.environmentCatalog({ sessionId }, signal),
      )),
      installUv: async signal => environmentCatalog(unwrap(
        await ctx.remote.notebooks.installUv({ sessionId }, signal),
      )),
      installPython: async signal => environmentCatalog(unwrap(
        await ctx.remote.notebooks.installPython({ sessionId, version: '3.12' }, signal),
      )),
      createEnvironment: async (
        environmentId: NotebookEnvironmentId,
        allowExisting: boolean,
        rebuild: boolean,
        signal: AbortSignal,
      ) => environmentCatalog(unwrap(await ctx.remote.notebooks.createEnvironment({
        sessionId, environmentId, allowExisting, rebuild,
      }, signal))),
      attachEnvironment: async (
        notebookId: NotebookId,
        environmentId: NotebookEnvironmentId,
        signal: AbortSignal,
      ) => {
        return notebookDocument(unwrap(await ctx.remote.notebooks.attachEnvironment({
          sessionId, notebookId, environmentId,
        }, signal)))
      },
      runtimeStatus: async (notebookId: NotebookId, signal: AbortSignal) => runtimeStatus(unwrap(
        await ctx.remote.notebooks.runtimeStatus({ sessionId, notebookId }, signal),
      )),
      editCell: async (notebookId: NotebookId, cellId: CellId, source: string) => {
        return notebookDocument(unwrap(
          await ctx.remote.notebooks.editCell({ sessionId, notebookId, cellId, source }),
        ).document)
      },
      insertCell: async (
        notebookId: NotebookId,
        afterCellId: CellId | undefined,
        cellType: CellType,
      ) => {
        return notebookDocument(unwrap(await ctx.remote.notebooks.insertCell({
          sessionId,
          notebookId,
          cellType,
          ...(afterCellId === undefined ? {} : { afterCellId }),
        })).document)
      },
      runCell: async (notebookId: NotebookId, cellId: CellId, source: string) => {
        const result = unwrap(await ctx.remote.notebooks.runCell({
          sessionId, notebookId, cellId, source,
        }))
        if (result.status === 'error') {
          throw new Error(result.error ?? 'notebook execution failed')
        }
        return { status: result.status, document: notebookDocument(result.document) }
      },
      restartNotebook: async (notebookId: NotebookId) => {
        return notebookDocument(unwrap(
          await ctx.remote.notebooks.restart({ sessionId, notebookId }),
        ).document)
      },
      reloadNotebook: async (notebookId: NotebookId) => {
        return notebookDocument(unwrap(
          await ctx.remote.notebooks.reload({ sessionId, notebookId }),
        ).document)
      },
      interruptNotebook: async (notebookId: NotebookId) => {
        unwrap(await ctx.remote.notebooks.interrupt({ sessionId, notebookId }))
      },
      loadAttachment: async (attachment: ImageAttachmentRef) => {
        const result = unwrap(await ctx.remote.notebooks.readAttachment({
          sessionId,
          attachmentId: String(attachment.attachmentId),
        }))
        return {
          attachment: result.attachment as ImageAttachmentRef,
          data: decodeBase64(result.data),
        }
      },
      loadOlder: async () => {
        const session = ctx.sessions.binding(sessionId)?.session
        if (session === undefined) throw new Error(`notebook session ${String(sessionId)} is unavailable`)
        await session.loadOlder()
      },
      replaceSession: async () => {
        // rc.6 workspaces exposes archiveSession only: archiving the current
        // session clears the selection into the New Session view, which is the
        // replacement available through the rc.6 workspace API.
        await ctx.workspaces.archiveSession(sessionId)
      },
      closeNotebookPanel: () => { ctx.layout.closeDetails() },
    }),
  }, NotebookView))
  return async () => {
    ctx.layout.closeDetails()
    await disposeRemote()
  }
}
