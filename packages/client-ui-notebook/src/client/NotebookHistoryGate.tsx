import type { ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  NotebookOperationNotice, type NotebookMutationState,
} from './NotebookOperationNotice.tsx'
import css from './notebook.module.css'

/** History state consumed before discovery or document UI is allowed to render. */
export interface NotebookHistoryGateProps {
  readonly openState: 'cold' | 'loading' | 'open' | 'error'
  readonly openError: { readonly message: string } | null
  readonly incompatible: boolean
  readonly incomplete: boolean
  readonly hasDocuments: boolean
  readonly hasMore: boolean
  readonly historyPending: boolean
  readonly replacementPending: boolean
  readonly historyAction: NotebookMutationState | undefined
  readonly replacementAction: NotebookMutationState | undefined
  readonly onLoadOlder: () => void
  readonly onReplaceSession: () => void
  readonly children: ReactNode
  readonly t: PropsLocale<'notebook'>['t']
}

/**
 * Gate Notebook UI on authoritative Session history state.
 * @param props - Session history state, recovery transitions, and ready content.
 * @returns Loading, failure, compatibility recovery, incomplete notice, or ready children.
 */
export function NotebookHistoryGate({
  openState, openError, incompatible, incomplete, hasDocuments, hasMore,
  historyPending, replacementPending, historyAction, replacementAction,
  onLoadOlder, onReplaceSession, children, t,
}: NotebookHistoryGateProps) {
  if (openState === 'cold' || openState === 'loading') {
    return (
      <div className={css.root} data-testid="notebook-history-loading" aria-label={t('view.notebook')}>
        <div className={css.empty} role="status">
          <p className={css.emptyTitle}>{t('history.loadingTitle')}</p>
          <p className={css.emptyBody}>{t('history.loadingBody')}</p>
        </div>
      </div>
    )
  }
  if (openState === 'error') {
    return (
      <div className={css.root} data-testid="notebook-history-error" aria-label={t('view.notebook')}>
        <div className={css.empty} role="alert">
          <p className={css.emptyTitle}>{t('history.errorTitle')}</p>
          <p className={css.mutationError}>{openError?.message ?? t('history.errorBody')}</p>
        </div>
      </div>
    )
  }
  if (incompatible) {
    return (
      <div className={css.root} data-testid="notebook-incompatible" aria-label={t('view.notebook')}>
        <div className={`${css.historyNotice} ${css.protocolNotice}`} role="alert" aria-live="assertive">
          <strong>{t('protocol.incompatibleTitle')}</strong>
          <span>{t('protocol.incompatibleBody')}</span>
          <Button variant="outline" size="sm" disabled={replacementPending} onClick={onReplaceSession}>
            {t('protocol.replaceSession')}
          </Button>
        </div>
        <NotebookOperationNotice state={replacementAction} t={t} />
        {hasDocuments ? children : null}
      </div>
    )
  }
  const notice = incomplete
    ? (
      <div className={css.historyNotice} role="status">
        <strong>{t('history.incompleteTitle')}</strong>
        <span>{t('history.incompleteBody')}</span>
        {hasMore
          ? (
            <Button variant="outline" size="sm" disabled={historyPending} onClick={onLoadOlder}>
              {t(historyPending ? 'history.loadingOlder' : 'history.loadOlder')}
            </Button>
          )
          : <span>{t('history.noOlder')}</span>}
        <NotebookOperationNotice state={historyAction} t={t} />
        {openError !== null ? <p className={css.mutationError} role="alert">{openError.message}</p> : null}
      </div>
    )
    : null
  if (incomplete && !hasDocuments) {
    return (
      <div className={css.root} data-testid="notebook-history-incomplete" aria-label={t('view.notebook')}>
        {notice}
      </div>
    )
  }
  return (
    <div className={css.root} data-testid="notebook-view" aria-label={t('view.notebook')}>
      {notice}
      {children}
    </div>
  )
}
