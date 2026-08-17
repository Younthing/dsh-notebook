import { memo, type ReactNode, useLayoutEffect, useRef, useState } from 'react'
import type {
  CellId,
  CellType,
  NotebookCellStatus,
  NotebookDocument,
  NotebookKernelRuntimeStatus,
} from '@younthing/dsh-notebook-core/types'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import {
  Button, IconCheckOutline14, IconChevronDownOutline14, IconChevronUpOutline14,
  IconCopyOutline16, IconTrashOutline16, IconTriangleRightFill14, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import { CellEditor } from './CellEditor.tsx'
import { MarkdownCell } from './MarkdownCell.tsx'
import { MimeOutput, NotebookMarkdown } from './MimeOutput.tsx'
import type { MimeOutputLabels, NotebookAttachmentLoader } from './MimeOutput.tsx'
import {
  NotebookOperationNotice, type NotebookMutationState,
} from './NotebookOperationNotice.tsx'
import css from './notebook.module.css'

function cellKey(notebookId: string, cellId: string): string {
  return `${notebookId.length}:${notebookId}${cellId}`
}

function countLabel(cell: {
  readonly cellType: string
  readonly status?: NotebookCellStatus
  readonly executionCount?: number
}, running: boolean): string {
  if (cell.cellType !== 'code') return ''
  if (running) return '[*]'
  if (cell.executionCount === undefined) return '[ ]'
  return `[${String(cell.executionCount)}]`
}

function kernelDot(
  runtime: NotebookKernelRuntimeStatus,
  cells: readonly { readonly status?: NotebookCellStatus }[],
): StateDotState {
  if (runtime.status === 'failed' || cells.some(cell => cell.status === 'error')) return 'error'
  if (runtime.status === 'starting' || runtime.status === 'running'
    || cells.some(cell => cell.status === 'running')) return 'ongoing'
  if (runtime.status === 'detached' || runtime.status === 'stopped') return 'warning'
  return 'done'
}

function runtimeLabel(
  runtime: NotebookKernelRuntimeStatus,
  t: PropsLocale<'notebook'>['t'],
): string {
  switch (runtime.status) {
    case 'detached': return t('kernel.detached')
    case 'starting': return t('kernel.starting')
    case 'ready': return t('kernel.ready')
    case 'running': return t('kernel.running')
    case 'stopped': return t('kernel.stopped')
    case 'failed': return t('kernel.failed')
  }
}

function InsertBar({
  disabled, onInsert, t,
}: {
  readonly disabled: boolean
  readonly onInsert: (cellType: CellType) => void
  readonly t: PropsLocale<'notebook'>['t']
}) {
  return (
    <div className={css.insert} role="group" aria-label={t('cell.insertLabel')}>
      <button type="button" className={css.insertHit} disabled={disabled} onClick={() => { onInsert('code') }}>
        {t('cell.insertCode')}
      </button>
      <button type="button" className={css.insertHit} disabled={disabled} onClick={() => { onInsert('markdown') }}>
        {t('cell.insertMarkdown')}
      </button>
      <button type="button" className={css.insertHit} disabled={disabled} onClick={() => { onInsert('raw') }}>
        {t('cell.insertRaw')}
      </button>
    </div>
  )
}

/** Pure single-canvas Notebook document renderer. */
export interface NotebookDocumentViewProps {
  readonly document: NotebookDocument
  readonly runtime: NotebookKernelRuntimeStatus
  readonly environmentCard: ReactNode
  readonly environmentOpen: boolean
  readonly onToggleEnvironment: () => void
  readonly protocolLocked: boolean
  readonly selectedCellKey: string | undefined
  readonly scrollTop: number
  readonly actionFor: (key: string) => NotebookMutationState | undefined
  readonly draftFor: (cellId: CellId, source: string) => string
  readonly onSelectCell: (key: string) => void
  readonly onScrollTopChange: (scrollTop: number) => void
  readonly onDraft: (cellId: CellId, durableSource: string, value: string) => void
  readonly onCommit: (cellId: CellId, durableSource: string, value: string) => void
  readonly onRun: (cellId: CellId, source: string) => Promise<boolean>
  readonly onDeleteCell: (cellId: CellId) => void
  readonly onMoveCell: (cellId: CellId, toIndex: number) => void
  readonly onCopyCell: (cellId: CellId) => void
  readonly onInsert: (afterCellId: CellId | undefined, cellType: CellType) => void
  readonly onInterrupt: () => void
  readonly onReload: () => void
  readonly onRestart: () => void
  readonly loadAttachment: NotebookAttachmentLoader
  readonly outputLabels: MimeOutputLabels
  readonly formatOmitted: (count: number, unit: 'rows' | 'points' | 'columns') => string
  readonly t: PropsLocale<'notebook'>['t']
}

/**
 * Render one selected Notebook document while preserving detached edit access.
 * @param props - projected document, process-local runtime, and mutation callbacks.
 * @returns One document canvas with optional in-place environment recovery.
 */
export const NotebookDocumentView = memo(function NotebookDocumentView({
  document, runtime, environmentCard, environmentOpen, onToggleEnvironment, protocolLocked, selectedCellKey, actionFor,
  scrollTop, draftFor, onSelectCell, onScrollTopChange, onDraft, onCommit, onRun, onDeleteCell,
  onMoveCell, onCopyCell, onInsert, onInterrupt, onReload, onRestart, loadAttachment, outputLabels,
  formatOmitted, t,
}: NotebookDocumentViewProps) {
  const cellsRef = useRef<HTMLDivElement>(null)
  const [runAllProgress, setRunAllProgress] = useState<{ readonly done: number; readonly total: number } | undefined>()
  const [deleteConfirmKey, setDeleteConfirmKey] = useState<string>()
  useLayoutEffect(() => {
    const node = cellsRef.current
    if (node !== null) node.scrollTop = scrollTop
  }, [document.id, scrollTop])
  const notebookId = String(document.id)
  const codeCells = document.cells.filter(cell => cell.cellType === 'code')
  const insertKey = `insert:${notebookId}`
  const interruptKey = `interrupt:${notebookId}`
  const restartKey = `restart:${notebookId}`
  const reloadKey = `reload:${notebookId}`
  const inserting = actionFor(insertKey)?.phase === 'pending'
  const interrupting = actionFor(interruptKey)?.phase === 'pending'
  const restarting = actionFor(restartKey)?.phase === 'pending'
  const reloading = actionFor(reloadKey)?.phase === 'pending'
  const running = document.cells.some(cell => cell.status === 'running')
    || codeCells.some(cell => actionFor(`run:${cellKey(notebookId, String(cell.id))}`)?.phase === 'pending')
  const processBusy = runtime.status === 'starting' || runtime.status === 'running'
  const operationBusy = restarting || reloading || interrupting || running
  const executionDisabled = protocolLocked || document.kernel === undefined || processBusy || operationBusy
  const kernelLabel = document.kernel === undefined
    ? t('kernel.noEnvironment')
    : `${document.kernel.kernelName ?? document.kernel.backend} #${String(document.kernel.generation)}`
  const runAllRunning = runAllProgress !== undefined
  const runAllLabel = runAllRunning
    ? `${t('cell.runAll')} ${String(runAllProgress.done)}/${String(runAllProgress.total)}`
    : t('cell.runAll')

  return (
    <section className={css.notebook} aria-label={document.path}>
        <header className={css.header}>
        <span className={css.pathValue} title={document.path}>{document.path}</span>
        <div className={css.headerActions} role="toolbar" aria-label={t('view.notebook')}>
          <button
            type="button"
            className={css.kernel}
            aria-label={t(document.kernel === undefined ? 'kernel.select' : 'kernel.change')}
            aria-expanded={environmentOpen}
            aria-controls="notebook-environment-picker"
            onClick={onToggleEnvironment}
          >
            <StateDot state={kernelDot(runtime, document.cells)} />
            <span className={css.kernelLabel}>{kernelLabel}</span>
            <span className={css.kernelStatus} aria-live="polite">{runtimeLabel(runtime, t)}</span>
          </button>
          <span className={css.headerControls}>
            <Button
              variant="primary"
              size="sm"
              disabled={executionDisabled || codeCells.length === 0 || runAllRunning}
              onClick={() => {
                void (async () => {
                  setRunAllProgress({ done: 0, total: codeCells.length })
                  try {
                    for (const cell of codeCells) {
                      const didRun = await onRun(cell.id, draftFor(cell.id, cell.source))
                      if (!didRun) break
                      setRunAllProgress(current => current === undefined
                        ? undefined
                        : { done: Math.min(current.total, current.done + 1), total: current.total })
                    }
                  } finally {
                    setRunAllProgress(undefined)
                  }
                })()
              }}
            >
              {runAllLabel}
              {runAllRunning ? <span className={css.srOnly} role="status">{t('cell.runAllInProgress')}</span> : null}
            </Button>
            {running
              ? (
                <Button variant="outline" size="sm" disabled={interrupting || protocolLocked} onClick={onInterrupt}>
                  {t('cell.interrupt')}
                </Button>
              )
              : null}
            <span className={css.headerDivider} aria-hidden />
            <Button
              variant="ghost"
              size="sm"
              disabled={protocolLocked || reloading || operationBusy}
              title={t('cell.reloadTitle')}
              onClick={onReload}
            >
              {t('cell.reload')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={protocolLocked || document.kernel === undefined || restarting || operationBusy}
              title={t('cell.restartTitle')}
              onClick={onRestart}
            >
              {t('cell.restart')}
            </Button>
          </span>
        </div>
      </header>
    {environmentCard}
    <div className={css.notebookNotices}>
      <NotebookOperationNotice state={actionFor(insertKey)} t={t} />
      <NotebookOperationNotice state={actionFor(interruptKey)} t={t} />
      <NotebookOperationNotice state={actionFor(reloadKey)} t={t} />
      <NotebookOperationNotice state={actionFor(restartKey)} t={t} />
    </div>
      <div
        ref={cellsRef}
        className={css.cells}
        onScroll={(event) => { onScrollTopChange(event.currentTarget.scrollTop) }}
      >
        <InsertBar disabled={inserting || protocolLocked} onInsert={(cellType) => { onInsert(undefined, cellType) }} t={t} />
        {document.cells.map((cell, cellIndex) => {
          const key = cellKey(notebookId, String(cell.id))
          const source = draftFor(cell.id, cell.source)
          const editState = actionFor(`edit:${key}`)
          const runState = actionFor(`run:${key}`)
          const copyState = actionFor(`copy:${key}`)
          const moveState = actionFor(`move:${key}`)
          const deleteState = actionFor(`delete:${key}`)
          const mutating = editState?.phase === 'pending'
            || runState?.phase === 'pending'
            || copyState?.phase === 'pending'
            || moveState?.phase === 'pending'
            || deleteState?.phase === 'pending'
          const saving = editState?.phase === 'pending'
          const cellRunning = runState?.phase === 'pending' || cell.status === 'running'
          const firstPending = [editState, runState, copyState, moveState, deleteState]
            .find(state => state?.phase === 'pending')
          const operationState = firstPending ?? runState ?? editState
            ?? copyState ?? moveState ?? deleteState
          return (
            <div key={key}>
              <div
                className={css.cell}
                data-kind={cell.cellType}
                data-status={cell.status}
                data-selected={selectedCellKey === key || undefined}
                data-testid={`notebook-cell-${notebookId}-${String(cell.id)}`}
                onClick={() => { onSelectCell(key) }}
              >
                <div className={css.rail}>
                  {cell.cellType === 'code'
                    ? cellRunning
                      ? (
                        <span className={css.runningState} role="status" aria-label={t('status.running')}>
                          <StateDot state="ongoing" size={16} />
                        </span>
                      )
                      : (
                        <button
                          type="button"
                          className={css.run}
                          aria-label={t('cell.run')}
                          aria-keyshortcuts="Shift+Enter Ctrl+Enter Meta+Enter"
                          title={t('cell.shortcutTitle')}
                          disabled={executionDisabled}
                          onClick={(event) => {
                            event.stopPropagation()
                            void onRun(cell.id, source)
                          }}
                        >
                          <IconTriangleRightFill14 />
                        </button>
                      )
                    : null}
                  <div className={css.prompt} aria-hidden>
                    {countLabel(cell, cellRunning)}
                    {cell.status === 'ok' ? <IconCheckOutline14 size={12} className={css.ok} /> : null}
                  </div>
                </div>
                <div className={css.cellBody}>
                  <div className={css.input}>
                    {cell.cellType === 'code'
                      ? (
                        <CellEditor
                          label={t('cell.source')}
                          value={source}
                          disabled={saving || protocolLocked}
                          onChange={(next) => { onDraft(cell.id, cell.source, next) }}
                          onCommit={(next) => { onCommit(cell.id, cell.source, next) }}
                          onRun={() => { void onRun(cell.id, source) }}
                        />
                      )
                      : cell.cellType === 'markdown'
                        ? (
                          <MarkdownCell
                            label={t('cell.markdown')}
                            emptyLabel={t('cell.markdownEmpty')}
                            value={source}
                            preview={(
                              <NotebookMarkdown
                                text={source}
                                attachments={cell.attachments}
                                loadAttachment={loadAttachment}
                                labels={outputLabels}
                                formatOmitted={formatOmitted}
                              />
                            )}
                            disabled={saving || protocolLocked}
                            onChange={(next) => { onDraft(cell.id, cell.source, next) }}
                            onCommit={(next) => { onCommit(cell.id, cell.source, next) }}
                          />
                        )
                        : (
                          <CellEditor
                            label={t('cell.raw')}
                            value={source}
                            disabled={saving || protocolLocked}
                            onChange={(next) => { onDraft(cell.id, cell.source, next) }}
                            onCommit={(next) => { onCommit(cell.id, cell.source, next) }}
                          />
                        )}
                  </div>
                  <div className={css.cellActions} role="group" aria-label={t('cell.actions')}>
                    <button
                      type="button"
                      className={css.cellAction}
                      aria-label={t('cell.moveUp')}
                      title={t('cell.moveUp')}
                      disabled={mutating || cellIndex === 0}
                      onClick={(event) => {
                        event.stopPropagation()
                        setDeleteConfirmKey(undefined)
                        onMoveCell(cell.id, cellIndex - 1)
                      }}
                    >
                      <IconChevronUpOutline14 />
                    </button>
                    <button
                      type="button"
                      className={css.cellAction}
                      aria-label={t('cell.moveDown')}
                      title={t('cell.moveDown')}
                      disabled={mutating || cellIndex === document.cells.length - 1}
                      onClick={(event) => {
                        event.stopPropagation()
                        setDeleteConfirmKey(undefined)
                        onMoveCell(cell.id, cellIndex + 1)
                      }}
                    >
                      <IconChevronDownOutline14 />
                    </button>
                    <button
                      type="button"
                      className={css.cellAction}
                      aria-label={t('cell.copy')}
                      title={t('cell.copy')}
                      disabled={mutating}
                      onClick={(event) => {
                        event.stopPropagation()
                        setDeleteConfirmKey(undefined)
                        onCopyCell(cell.id)
                      }}
                    >
                      <IconCopyOutline16 size={14} />
                    </button>
                    <button
                      type="button"
                      className={`${css.cellAction} ${deleteConfirmKey === key ? css.cellActionDanger : ''}`}
                      aria-label={deleteConfirmKey === key ? t('cell.deleteConfirm') : t('cell.delete')}
                      title={deleteConfirmKey === key ? t('cell.deleteConfirm') : t('cell.delete')}
                      disabled={mutating || document.cells.length <= 1}
                      onClick={(event) => {
                        event.stopPropagation()
                        if (deleteConfirmKey !== key) {
                          setDeleteConfirmKey(key)
                          return
                        }
                        setDeleteConfirmKey(undefined)
                        onDeleteCell(cell.id)
                      }}
                    >
                      <IconTrashOutline16 size={14} />
                    </button>
                  </div>
                  {cell.outputs.length > 0
                    ? (
                      <div className={css.outputs}>
                        <span className={css.outputMark} aria-hidden>↪</span>
                        <div className={css.outputBody}>
                          {cell.outputs.map((output, outputIndex) => (
                            <MimeOutput
                              key={`${String(cell.id)}:${String(outputIndex)}:${output.type}`}
                              output={output}
                              loadAttachment={loadAttachment}
                              labels={outputLabels}
                              formatOmitted={formatOmitted}
                            />
                          ))}
                        </div>
                      </div>
                    )
                    : null}
                  <NotebookOperationNotice state={operationState} t={t} />
                  <span className={css.srOnly} role="status">
                    {t(cellRunning
                      ? 'status.running'
                      : cell.status === 'error'
                        ? 'status.error'
                        : cell.status === 'cancelled'
                          ? 'status.cancelled'
                          : cell.status === 'ok'
                            ? 'status.ok'
                            : 'status.idle')}
                  </span>
                </div>
              </div>
              <InsertBar disabled={inserting || protocolLocked} onInsert={(cellType) => { onInsert(cell.id, cellType) }} t={t} />
            </div>
          )
        })}
        <button
          type="button"
          className={css.continue}
          disabled={inserting || protocolLocked}
          onClick={() => { onInsert(document.cells.at(-1)?.id, 'code') }}
        >
          {t('cell.continue')}
        </button>
      </div>
    </section>
  )
})
