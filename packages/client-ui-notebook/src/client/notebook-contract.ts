import type { ConversationLocation, ConversationViewNode } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { FoldedNotebooks } from '@deepseek-ai/dsh-notebook-core/types'

/** Notebook events projected by the browser view. */
export type NotebookSessionEvent = SessionEvent<
  | 'notebook/open'
  | 'notebook/cell'
  | 'notebook/execute'
  | 'notebook/output'
  | 'notebook/execute-end'
  | 'notebook/kernel'
  | 'notebook/reload'
>

/** One notebook event retained for folding. */
export interface NotebookEventContribution {
  readonly kind: 'event'
  readonly event: NotebookSessionEvent
}

/** Engine-owned view node for the notebook target. */
export interface NotebookConversationViewNode extends ConversationViewNode {
  readonly target: 'notebook'
  readonly anchorSeq: number
  readonly location: ConversationLocation
  readonly data: NotebookEventContribution
}

/** Snapshot folded from notebook session events for the notebook pane. */
export interface NotebookSnapshot {
  readonly folded: FoldedNotebooks
  /** Whether the current history window starts after required notebook events. */
  readonly incomplete: boolean
  /** Durable notebook payloads from an unsupported pre-release event revision. */
  readonly protocolError: 'incompatible-history' | null
}

/** Stable empty target used until a Session has notebook events. */
export const EMPTY_NOTEBOOK_SNAPSHOT: NotebookSnapshot = {
  folded: Object.freeze({ notebooks: Object.freeze([]) }),
  incomplete: false,
  protocolError: null,
}

/**
 * Wrap one notebook event in the engine-owned target envelope.
 * @param context - Context that owns the contribution identity.
 * @param anchorSeq - Sequence used to order the contribution.
 * @param event - notebook session event payload.
 * @returns The contribution wrapped as a notebook view node.
 */
export function notebookNode(
  context: {
    readonly key: string
    readonly kind: string
    readonly id: string
    readonly start?: { readonly location: ConversationLocation } | undefined
  },
  anchorSeq: number,
  event: NotebookSessionEvent,
): NotebookConversationViewNode {
  return {
    key: context.key,
    kind: context.kind,
    id: context.id,
    target: 'notebook',
    anchorSeq,
    location: context.start?.location ?? { kind: 'unresolved' },
    data: { kind: 'event', event },
  }
}

declare module '@deepseek-ai/dsh-client-runtime/client' {
  interface ConversationViewSnapshotMap {
    /** Folded notebook documents consumed by the Notebook view. */
    notebook: NotebookSnapshot
  }
}
