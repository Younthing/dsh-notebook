// @vitest-environment jsdom
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CellEditor } from '../src/client/CellEditor.tsx'

afterEach(cleanup)

function EditorHarness({
  initial = 'print(1)',
  onCommit = () => {},
  onRun = () => {},
}: {
  initial?: string
  onCommit?: (next: string) => void
  onRun?: () => void
}) {
  const [value, setValue] = useState(initial)
  return (
    <CellEditor
      label="源码"
      value={value}
      onChange={setValue}
      onCommit={onCommit}
      onRun={onRun}
    />
  )
}

describe('CellEditor', () => {
  it('runs on Shift+Enter and commits on blur', () => {
    const onCommit = vi.fn()
    const onRun = vi.fn()
    render(<EditorHarness onCommit={onCommit} onRun={onRun} />)
    const editor = screen.getByDisplayValue('print(1)')
    fireEvent.change(editor, { target: { value: 'print(2)' } })
    fireEvent.blur(editor)
    expect(onCommit).toHaveBeenCalledWith('print(2)')
    fireEvent.keyDown(screen.getByDisplayValue('print(2)'), { key: 'Enter', shiftKey: true })
    expect(onRun).toHaveBeenCalled()
  })

  it('runs from Ctrl+Enter or Meta+Enter and ignores a plain Enter', () => {
    const onRun = vi.fn()
    render(
      <CellEditor
        label="源码"
        value=""
        onChange={() => {}}
        onCommit={() => {}}
        onRun={onRun}
      />,
    )
    const editor = screen.getByLabelText('源码')
    fireEvent.keyDown(editor, { key: 'Enter' })
    expect(onRun).not.toHaveBeenCalled()
    fireEvent.keyDown(editor, { key: 'Enter', ctrlKey: true })
    fireEvent.keyDown(editor, { key: 'Enter', metaKey: true })
    expect(onRun).toHaveBeenCalledTimes(2)
  })
})
