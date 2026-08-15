// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { NotebookMimeBundle } from '@younthing/dsh-notebook-core/types'
import { NotebookMarkdown, type NotebookAttachmentLoader } from '../src/client/MimeOutput.tsx'

afterEach(cleanup)

const unusedLoader: NotebookAttachmentLoader = async () => {
  throw new Error('unexpected attachment load')
}

const noAttachments: Record<string, NotebookMimeBundle> = {}

function renderMarkdown(text: string): HTMLElement {
  const view = render(
    <NotebookMarkdown
      text={text}
      attachments={noAttachments}
      loadAttachment={unusedLoader}
    />,
  )
  return view.container
}

describe('NotebookMarkdown block rendering', () => {
  it('renders ATX headings at every depth', () => {
    const root = renderMarkdown('# one\n\n## two\n\n### three\n\n#### four\n\n##### five\n\n###### six')
    expect(root.querySelector('h1')?.textContent).toBe('one')
    expect(root.querySelector('h2')?.textContent).toBe('two')
    expect(root.querySelector('h6')?.textContent).toBe('six')
  })

  it('renders fenced code as a pre/code pair', () => {
    const root = renderMarkdown('```python\nprint(1)\n```')
    expect(root.querySelector('pre')?.textContent).toContain('print(1)')
    expect(root.querySelector('pre > code')).not.toBeNull()
  })

  it('renders ordered and unordered lists with nested items', () => {
    const root = renderMarkdown('- a\n- b\n\n1. x\n2. y')
    expect(root.querySelectorAll('ul > li')).toHaveLength(2)
    expect(root.querySelectorAll('ol > li')).toHaveLength(2)
  })

  it('renders task-list checkboxes', () => {
    const root = renderMarkdown('- [x] done\n- [ ] todo')
    const boxes = root.querySelectorAll('input[type="checkbox"]')
    expect(boxes).toHaveLength(2)
    expect(boxes[0]?.hasAttribute('checked')).toBe(true)
    expect(boxes[1]?.hasAttribute('checked')).toBe(false)
  })

  it('renders blockquotes and thematic breaks', () => {
    const root = renderMarkdown('> quoted\n\n---')
    expect(root.querySelector('blockquote')?.textContent).toBe('quoted')
    expect(root.querySelector('hr')).not.toBeNull()
  })

  it('renders GFM tables with a header and body rows', () => {
    const root = renderMarkdown('| a | b |\n| - | - |\n| 1 | 2 |')
    const table = root.querySelector('table')
    expect(table?.querySelector('thead th')?.textContent).toBe('a')
    expect(table?.querySelectorAll('tbody tr')).toHaveLength(1)
    expect(table?.querySelector('tbody td')?.textContent).toBe('1')
  })

  it('keeps raw HTML blocks as literal text', () => {
    const root = renderMarkdown('<div>raw</div>')
    expect(root.textContent).toContain('<div>raw</div>')
    expect(root.querySelector('div')).toBeNull()
  })
})

describe('NotebookMarkdown inline rendering', () => {
  it('renders emphasis, strong, delete, inline code, and line breaks', () => {
    const root = renderMarkdown('*em* **strong** ~~del~~ `code`  \nnext')
    expect(root.querySelector('em')?.textContent).toBe('em')
    expect(root.querySelector('strong')?.textContent).toBe('strong')
    expect(root.querySelector('del')?.textContent).toBe('del')
    expect(root.querySelector('p code')?.textContent).toBe('code')
    expect(root.querySelector('br')).not.toBeNull()
  })

  it('links absolute HTTP(S) destinations and keeps unsafe ones as text', () => {
    const root = renderMarkdown('[ok](https://example.com) [bad](javascript:alert(1))')
    expect(root.querySelector('a')?.getAttribute('href')).toBe('https://example.com')
    expect(root.querySelector('a')?.textContent).toBe('ok')
    expect(root.textContent).toContain('bad')
  })

  it('renders remote HTTP(S) images directly', () => {
    const root = renderMarkdown('![pic](https://example.com/a.png)')
    expect(root.querySelector('img')?.getAttribute('src')).toBe('https://example.com/a.png')
  })

  it('keeps an unresolved attachment alt text and an unsafe image alt text', () => {
    const root = renderMarkdown('![missing](attachment:nope) ![junk](javascript:alert(1))')
    expect(root.textContent).toContain('missing')
    expect(root.textContent).toContain('junk')
    expect(root.querySelector('img')).toBeNull()
  })

  it('renders footnote references as bracketed text', () => {
    const root = renderMarkdown('a note[^1]\n\n[^1]: the note')
    expect(root.textContent).toContain('[1]')
  })
})
