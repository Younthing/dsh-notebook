import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './notebook.module.css'

/** Notebook mutation names whose progress is rendered in the pane. */
export type NotebookMutationKind =
  | 'open' | 'create' | 'edit' | 'insert' | 'run' | 'interrupt' | 'restart' | 'reload' | 'history' | 'replace'
  | 'copy' | 'move' | 'delete'

/** One bounded, transient mutation state retained outside the durable projector. */
export interface NotebookMutationState {
  readonly kind: NotebookMutationKind
  readonly phase: 'pending' | 'settled' | 'error'
  readonly error?: string
  readonly writeConflict?: boolean
}

function mutationMessage(
  state: NotebookMutationState,
  t: PropsLocale<'notebook'>['t'],
): string {
  if (state.phase === 'error') {
    const detail = state.error === undefined || state.error.trim().length === 0
      ? ''
      : ` ${state.error}`
    const recovery = state.writeConflict ? ` ${t('action.writeConflict')}` : ''
    return `${t('action.failed')}${detail}${recovery}`.trim()
  }
  switch (state.kind) {
    case 'open':
      return t(state.phase === 'pending' ? 'action.open.pending' : 'action.open.settled')
    case 'create':
      return t(state.phase === 'pending' ? 'action.create.pending' : 'action.create.settled')
    case 'edit':
      return t(state.phase === 'pending' ? 'action.edit.pending' : 'action.edit.settled')
    case 'insert':
      return t(state.phase === 'pending' ? 'action.insert.pending' : 'action.insert.settled')
    case 'run':
      return t(state.phase === 'pending' ? 'action.run.pending' : 'action.run.settled')
    case 'interrupt':
      return t(state.phase === 'pending' ? 'action.interrupt.pending' : 'action.interrupt.settled')
    case 'restart':
      return t(state.phase === 'pending' ? 'action.restart.pending' : 'action.restart.settled')
    case 'reload':
      return t(state.phase === 'pending' ? 'action.reload.pending' : 'action.reload.settled')
    case 'history':
      return t(state.phase === 'pending' ? 'action.history.pending' : 'action.history.settled')
    case 'replace':
      return t(state.phase === 'pending' ? 'action.replace.pending' : 'action.replace.settled')
    case 'copy':
      return t(state.phase === 'pending' ? 'action.copy.pending' : 'action.copy.settled')
    case 'move':
      return t(state.phase === 'pending' ? 'action.move.pending' : 'action.move.settled')
    case 'delete':
      return t(state.phase === 'pending' ? 'action.delete.pending' : 'action.delete.settled')
  }
}

/**
 * Render one localized mutation status or failure.
 * @param props - mutation state and Notebook locale lookup.
 * @returns A polite status, assertive error, or no node for absent state.
 */
export function NotebookOperationNotice({
  state, t,
}: {
  readonly state: NotebookMutationState | undefined
  readonly t: PropsLocale<'notebook'>['t']
}) {
  if (state === undefined) return null
  return (
    <p
      className={state.phase === 'error' ? css.mutationError : css.mutationStatus}
      role={state.phase === 'error' ? 'alert' : 'status'}
      aria-live="polite"
    >
      {mutationMessage(state, t)}
    </p>
  )
}
