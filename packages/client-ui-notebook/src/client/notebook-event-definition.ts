import type { Context } from '@deepseek-ai/cordis'
import type {
  ConversationNodeContext, ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { notebookNode, type NotebookSessionEvent } from './notebook-contract.ts'
import { notebookViewDefinition } from './notebook-snapshot-builder.ts'

function isNotebookEvent(event: SessionEvent): event is NotebookSessionEvent {
  return event.type === 'notebook/open'
    || event.type === 'notebook/cell'
    || event.type === 'notebook/execute'
    || event.type === 'notebook/output'
    || event.type === 'notebook/execute-end'
    || event.type === 'notebook/kernel'
    || event.type === 'notebook/reload'
}

const notebookEventDefinition: ConversationNodeDefinition<SessionEvent> = {
  kind: 'notebook-event',
  target: 'notebook',
  match: event => isNotebookEvent(event)
    ? { id: String(event.seq), role: 'start' }
    : null,
  start: (_context, match) => {
    if (!isNotebookEvent(match.event)) {
      throw new Error('notebook-event start requires a notebook/* event')
    }
    return match.event
  },
  update: context => context.state,
  buildViewNode: (context: ConversationNodeContext<SessionEvent>) => {
    const event = context.state
    return event === undefined || !isNotebookEvent(event)
      ? null
      : notebookNode(context, event.seq, event)
  },
}

/**
 * Register notebook event Definitions and the notebook view builder.
 * @param ctx - Plugin context receiving the Definitions.
 */
export function registerNotebookConversationView(ctx: Context): void {
  ctx.conversationEvents.register(notebookEventDefinition)
  ctx.conversationViews.register(notebookViewDefinition)
}
