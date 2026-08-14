import { useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './notebook.module.css'

/** Props for one markdown cell: rendered preview, click to edit. */
export interface MarkdownCellProps {
  /** Accessible label for the editor and preview. */
  readonly label: string
  /** Placeholder shown when the cell has no source. */
  readonly emptyLabel: string
  /** Current markdown source. */
  readonly value: string
  /** Owner-rendered preview, including cell-local attachment images. */
  readonly preview?: ReactNode
  /** Called when the editor value changes. */
  readonly onChange: (next: string) => void
  /** Called when the editor loses focus with the current value. */
  readonly onCommit: (next: string) => void
  /** Whether a pending mutation temporarily locks this cell. */
  readonly disabled?: boolean
}

/**
 * Markdown cell: GFM preview until the user focuses it, then a textarea.
 * Empty source stays in the editor so a new cell is immediately writable.
 * @param props - Localized labels, current source/preview, disabled state, and edit callbacks.
 * @returns The accessible preview/edit control or active textarea.
 */
export function MarkdownCell({
  label, emptyLabel, value, preview, onChange, onCommit, disabled = false,
}: MarkdownCellProps) {
  const [editing, setEditing] = useState(false)
  const editorRef = useRef<HTMLTextAreaElement>(null)
  const editButtonRef = useRef<HTMLButtonElement>(null)
  const restoreEditFocus = useRef(false)
  useLayoutEffect(() => {
    if (editing) editorRef.current?.focus()
    else if (restoreEditFocus.current) {
      restoreEditFocus.current = false
      editButtonRef.current?.focus()
    }
  }, [editing])
  if (editing) {
    const lines = value.length === 0 ? 1 : value.split('\n').length
    return (
      <textarea
        ref={editorRef}
        className={css.markdownEditor}
        value={value}
        rows={Math.max(3, lines)}
        aria-label={label}
        disabled={disabled}
        onChange={(event) => { onChange(event.target.value) }}
        onBlur={(event) => {
          const next = event.currentTarget.value
          onCommit(next)
          if (next.trim().length > 0) setEditing(false)
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return
          event.preventDefault()
          onCommit(event.currentTarget.value)
          restoreEditFocus.current = true
          setEditing(false)
        }}
      />
    )
  }
  return (
    <div className={css.markdownPreview}>
      <button
        ref={editButtonRef}
        type="button"
        className={css.markdownEdit}
        aria-label={label}
        disabled={disabled}
        onClick={() => { setEditing(true) }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            setEditing(true)
          }
        }}
      >
        <span aria-hidden>✎</span>
      </button>
      <div
        className={css.markdownContent}
        onClick={(event) => {
          const target = event.target
          if (
            disabled
            || (target instanceof Element && target.closest('button, a') !== null)
          ) return
          setEditing(true)
        }}
      >
        {value.trim().length === 0
          ? <p className={css.markdownPlaceholder}>{emptyLabel}</p>
          : preview ?? <MarkdownText text={value} />}
      </div>
    </div>
  )
}
