// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import {
  NotebookPanelAction, type NotebookPanelActionProps,
} from '../src/client/NotebookPanelAction.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t: NotebookPanelActionProps['t'] = makeTranslate(en)

describe('NotebookPanelAction', () => {
  it('is a labeled native button that restores the Notebook panel', () => {
    const toggleNotebookPanel = vi.fn()
    render(<NotebookPanelAction {...({ t, toggleNotebookPanel } as unknown as NotebookPanelActionProps)} />)

    const action = screen.getByRole('button', { name: en['panel.toggle'] }) as HTMLButtonElement
    expect(action.tagName).toBe('BUTTON')
    expect(action.tabIndex).toBe(0)
    expect(action.getAttribute('aria-controls')).toBe('dsh-notebook-panel')
    action.focus()
    expect(document.activeElement).toBe(action)
    fireEvent.click(action)
    expect(toggleNotebookPanel).toHaveBeenCalledOnce()
  })
})
