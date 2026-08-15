import { memo, type ReactNode, useLayoutEffect, useRef } from 'react'
import type {
  CellId,
  CellType,
  NotebookCellStatus,
  NotebookDocument,
  NotebookKernelRuntimeStatus,
} from '@younthing/dsh-notebook-core/types'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import {
  Button, IconCheckOutline14, IconTriangleRightFill14, StateDot,
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
    <div className={css.insert}>
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
  document, runtime, environmentCard, protocolLocked, selectedCellKey, actionFor,
  scrollTop, draftFor, onSelectCell, onScrollTopChange, onDraft, onCommit, onRun, onInsert, onInterrupt,
  onReload, onRestart, loadAttachment, outputLabels, formatOmitted, t,
}: NotebookDocumentViewProps) {
  const cellsRef = useRef<HTMLDivElement>(null)
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

  return (
    <section className={css.notebook} aria-label={document.path}>
      <header className={css.header}>
        <span className={css.pathValue}>{document.path}</span>
        <div className={css.headerActions} role="toolbar" aria-label={t('view.notebook')}>
          <span className={css.kernel} role="status" aria-live="polite">
            <StateDot state={kernelDot(runtime, document.cells)} />
            {kernelLabel}
            <span className={css.kernelStatus}>{runtimeLabel(runtime, t)}</span>
          </span>
          <Button
            variant="ghost"
            size="sm"
            disabled={executionDisabled || codeCells.length === 0}
            onClick={() => {
              void (async () => {
                for (const cell of codeCells) {
                  const didRun = await onRun(cell.id, draftFor(cell.id, cell.source))
                  if (!didRun) break
                }
              })()
            }}
          >
            {t('cell.runAll')}
          </Button>
          {running
            ? (
              <Button variant="outline" size="sm" disabled={interrupting || protocolLocked} onClick={onInterrupt}>
                {t('cell.interrupt')}
              </Button>
            )
            : null}
          <Button variant="outline" size="sm" disabled={protocolLocked || reloading || operationBusy} onClick={onReload}>
            {t('cell.reload')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={protocolLocked || document.kernel === undefined || restarting || operationBusy}
            onClick={onRestart}
          >
            {t('cell.restart')}
          </Button>
        </div>
      </header>
      {environmentCard}
      <NotebookOperationNotice state={actionFor(insertKey)} t={t} />
      <NotebookOperationNotice state={actionFor(interruptKey)} t={t} />
      <NotebookOperationNotice state={actionFor(reloadKey)} t={t} />
      <NotebookOperationNotice state={actionFor(restartKey)} t={t} />
      <div
        ref={cellsRef}
        className={css.cells}
        onScroll={(event) => { onScrollTopChange(event.currentTarget.scrollTop) }}
      >
        <InsertBar disabled={inserting || protocolLocked} onInsert={(cellType) => { onInsert(undefined, cellType) }} t={t} />
        {document.cells.map((cell) => {
          const key = cellKey(notebookId, String(cell.id))
          const source = draftFor(cell.id, cell.source)
          const editState = actionFor(`edit:${key}`)
          const runState = actionFor(`run:${key}`)
          const saving = editState?.phase === 'pending'
          const cellRunning = runState?.phase === 'pending' || cell.status === 'running'
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
                          aria-keyshortcuts="Shift+Enter"
                          title={t('cell.shortcut')}
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
                  <NotebookOperationNotice state={editState?.phase === 'pending' ? editState : runState ?? editState} t={t} />
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
