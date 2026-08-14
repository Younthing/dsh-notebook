import css from './notebook.module.css'

/** Props for one editable code or raw-text cell textarea. */
export interface CellEditorProps {
  /** Accessible label for the source editor. */
  readonly label: string
  /** Current editor value. */
  readonly value: string
  /** Called when the textarea value changes. */
  readonly onChange: (next: string) => void
  /** Called when the editor loses focus with the current value. */
  readonly onCommit: (next: string) => void
  /** Called when the user runs an executable cell; absent for raw text cells. */
  readonly onRun?: () => void
  /** Whether a pending mutation temporarily locks this editor. */
  readonly disabled?: boolean
}

/**
 * Monospace editor for one source cell. Shift+Enter or Ctrl+Enter runs only
 * when the owner provides an execution action.
 */
export function CellEditor({
  label, value, onChange, onCommit, onRun, disabled = false,
}: CellEditorProps) {
  const lineCount = value.length === 0 ? 1 : value.split('\n').length
  return (
    <div className={css.editor}>
      <textarea
        className={css.textarea}
        value={value}
        rows={Math.max(3, lineCount)}
        aria-label={label}
        disabled={disabled}
        spellCheck={false}
        onChange={(event) => { onChange(event.target.value) }}
        onBlur={(event) => { onCommit(event.currentTarget.value) }}
        onKeyDown={(event) => {
          if (onRun !== undefined
            && event.key === 'Enter'
            && (event.shiftKey || event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            onRun()
          }
        }}
      />
    </div>
  )
}
