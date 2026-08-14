// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { NotebookMimeBundle, NotebookOutput } from '@deepseek-ai/dsh-notebook-core/types'
import {
  MimeOutput, NotebookMarkdown,
} from '../src/client/MimeOutput.tsx'
import type { NotebookAttachmentLoader } from '../src/client/MimeOutput.tsx'

const createObjectURL = vi.fn<(blob: Blob) => string>()
const revokeObjectURL = vi.fn<(url: string) => void>()
const unusedLoader: NotebookAttachmentLoader = async () => {
  throw new Error('unexpected attachment load')
}

function attachment(id: string, mediaType: ImageAttachmentRef['mediaType'] = 'image/png'): ImageAttachmentRef {
  return {
    attachmentId: id as ImageAttachmentRef['attachmentId'],
    mediaType,
    bytes: 3,
    width: 16,
    height: 8,
    name: `${id}.png`,
  }
}

function rich(data: NotebookMimeBundle): NotebookOutput {
  return { type: 'display', data, metadata: {} }
}

beforeEach(() => {
  let nextUrl = 0
  createObjectURL.mockImplementation(() => `blob:notebook-${String(++nextUrl)}`)
  const NativeURL = URL
  class TestURL extends NativeURL {
    static override createObjectURL = createObjectURL
    static override revokeObjectURL = revokeObjectURL
  }
  vi.stubGlobal('URL', TestURL)
})

afterEach(() => {
  cleanup()
  createObjectURL.mockReset()
  revokeObjectURL.mockReset()
  vi.unstubAllGlobals()
})

describe('MimeOutput', () => {
  it('renders structured streams and errors', () => {
    const stream = render(
      <MimeOutput
        output={{ type: 'stream', name: 'stderr', text: 'warning\n' }}
        loadAttachment={unusedLoader}
      />,
    )
    expect(stream.container.querySelector('[data-stream="stderr"]')?.textContent).toBe('warning\n')
    stream.unmount()

    render(
      <MimeOutput
        output={{
          type: 'error',
          name: 'ValueError',
          value: 'bad input',
          traceback: ['Traceback (most recent call last)', 'ValueError: bad input'],
        }}
        loadAttachment={unusedLoader}
      />,
    )
    expect(screen.getByRole('alert').textContent).toContain('ValueError: bad input')
    expect(screen.getByRole('alert').textContent).toContain('Traceback')
  })

  it('selects one richest supported MIME alternative and keeps text as fallback', () => {
    const { container } = render(
      <MimeOutput
        output={rich({
          'text/plain': { type: 'text', text: 'plain fallback' },
          'text/html': { type: 'text', text: '<strong>html</strong>' },
          'application/vnd.plotly.v1+json': {
            type: 'json',
            value: { data: [{ y: [3, 4], type: 'scatter' }] },
          },
        })}
        loadAttachment={unusedLoader}
      />,
    )
    expect(screen.getByRole('img').getAttribute('data-mime'))
      .toBe('application/vnd.plotly.v1+json')
    expect(container.querySelectorAll('svg')).toHaveLength(1)
    expect(container.querySelector('iframe')).toBeNull()
    expect(container.textContent).not.toContain('plain fallback')
    expect(container.querySelector('polyline')?.getAttribute('points')?.split(' ')).toHaveLength(2)
  })

  it('uses the text fallback when a preferred structured renderer cannot parse its payload', () => {
    render(
      <MimeOutput
        output={rich({
          'application/vnd.plotly.v1+json': { type: 'json', value: { x: [1] } },
          'text/plain': { type: 'text', text: 'fallback chart text' },
        })}
        loadAttachment={unusedLoader}
      />,
    )
    expect(screen.getByText('fallback chart text')).toBeTruthy()
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('renders HTML and SVG in deny-by-default sandbox documents', () => {
    const hostile = '<img src="https://attacker.invalid/pixel"><script>parent.postMessage(document.cookie, "*")</script>'
    const html = render(
      <MimeOutput
        output={rich({ 'text/html': { type: 'text', text: hostile } })}
        loadAttachment={unusedLoader}
      />,
    )
    const frame = html.container.querySelector('iframe')
    const srcDoc = frame?.getAttribute('srcDoc') ?? ''
    expect(frame?.getAttribute('sandbox')).toBe('')
    expect(srcDoc.indexOf('Content-Security-Policy')).toBeLessThan(srcDoc.indexOf('attacker.invalid'))
    expect(srcDoc).toContain("default-src 'none'")
    expect(srcDoc).toContain("form-action 'none'")
    expect(srcDoc).not.toContain("script-src 'unsafe-inline'")
    html.unmount()

    const svg = render(
      <MimeOutput
        output={rich({
          'image/svg+xml': {
            type: 'text',
            text: '<svg><image href="https://attacker.invalid/svg-pixel"></image></svg>',
          },
        })}
        loadAttachment={unusedLoader}
      />,
    )
    expect(svg.container.querySelector('iframe')?.getAttribute('srcDoc')).toContain("default-src 'none'")
  })

  it('loads raster bytes through the session loader and revokes URLs on change and unmount', async () => {
    const first = attachment('image-1')
    const second = attachment('image-2', 'image/jpeg')
    const loadAttachment = vi.fn<NotebookAttachmentLoader>(async ref => ({
      attachment: ref,
      data: new Uint8Array([1, 2, 3]),
    }))
    const view = render(
      <MimeOutput
        output={rich({
          'image/png': { type: 'image', attachment: first },
          'text/plain': { type: 'text', text: 'first fallback' },
        })}
        loadAttachment={loadAttachment}
      />,
    )
    await waitFor(() => { expect(screen.getByRole('img').getAttribute('src')).toBe('blob:notebook-1') })
    expect(screen.getByRole('img').getAttribute('width')).toBe('16')
    expect(screen.getByRole('img').getAttribute('height')).toBe('8')
    expect(loadAttachment).toHaveBeenCalledWith(first)
    expect(createObjectURL).toHaveBeenCalledTimes(1)

    view.rerender(
      <MimeOutput
        output={rich({ 'image/jpeg': { type: 'image', attachment: second } })}
        loadAttachment={loadAttachment}
      />,
    )
    await waitFor(() => { expect(screen.getByRole('img').getAttribute('src')).toBe('blob:notebook-2') })
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:notebook-1')
    view.unmount()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:notebook-2')
  })

  it('shows a retryable raster error with a text fallback and never exposes inline base64', async () => {
    const ref = attachment('image-failure')
    const loadAttachment = vi.fn<NotebookAttachmentLoader>()
      .mockRejectedValueOnce(new Error('ATTACHMENT_NOT_REFERENCED'))
      .mockResolvedValueOnce({ attachment: ref, data: new Uint8Array([1, 2, 3]) })
    const { container } = render(
      <MimeOutput
        output={rich({
          'image/png': { type: 'image', attachment: ref },
          'text/plain': { type: 'text', text: 'accessible text fallback' },
          'application/octet-stream': { type: 'base64', data: 'secret-base64-payload' },
        })}
        loadAttachment={loadAttachment}
      />,
    )
    await screen.findByRole('alert')
    expect(screen.getByText('accessible text fallback')).toBeTruthy()
    expect(container.textContent).not.toContain('secret-base64-payload')
    fireEvent.click(screen.getByRole('button', { name: 'Retry image' }))
    await waitFor(() => { expect(screen.getByRole('img').getAttribute('src')).toBe('blob:notebook-1') })
    expect(loadAttachment).toHaveBeenCalledTimes(2)
  })

  it('revokes a URL created by a load that settles after unmount', async () => {
    const ref = attachment('late-image')
    const deferred = Promise.withResolvers<Awaited<ReturnType<NotebookAttachmentLoader>>>()
    const view = render(
      <MimeOutput
        output={rich({ 'image/png': { type: 'image', attachment: ref } })}
        loadAttachment={() => deferred.promise}
      />,
    )
    view.unmount()
    deferred.resolve({ attachment: ref, data: new Uint8Array([1, 2, 3]) })
    await waitFor(() => { expect(revokeObjectURL).toHaveBeenCalledWith('blob:notebook-1') })
  })

  it('caps chart series without spread and reports omitted points', () => {
    const values = Array.from({ length: 100_000 }, (_, index) => index)
    const plotly = render(
      <MimeOutput
        output={rich({
          'application/vnd.plotly.v1+json': {
            type: 'json',
            value: { data: [{ x: values, y: values, type: 'scatter' }] },
          },
        })}
        loadAttachment={unusedLoader}
      />,
    )
    expect(screen.getByText('99500 additional points omitted.')).toBeTruthy()
    expect(screen.getByRole('img').querySelector('polyline')?.getAttribute('points')?.split(' '))
      .toHaveLength(500)
    plotly.unmount()

    const rows = Array.from({ length: 10_000 }, (_, index) => ({ x: index, y: index * 2 }))
    render(
      <MimeOutput
        output={rich({
          'application/vnd.vegalite.v5+json': {
            type: 'json',
            value: {
              mark: { type: 'line' },
              data: { values: rows },
              encoding: { x: { field: 'x' }, y: { field: 'y' } },
            },
          },
        })}
        loadAttachment={unusedLoader}
      />,
    )
    expect(screen.getByText('9500 additional points omitted.')).toBeTruthy()
  })

  it('caps dataresource rows and columns with visible omission notices', () => {
    const fields = Array.from({ length: 35 }, (_, index) => ({ name: `field-${String(index)}` }))
    const rows = Array.from({ length: 205 }, (_, row) => Object.fromEntries(
      fields.map((field, column) => [field.name, `${String(row)}:${String(column)}`]),
    ))
    const { container } = render(
      <MimeOutput
        output={rich({
          'application/vnd.dataresource+json': {
            type: 'json',
            value: { schema: { fields }, data: rows },
          },
        })}
        loadAttachment={unusedLoader}
      />,
    )
    expect(container.querySelectorAll('tbody tr')).toHaveLength(200)
    expect(container.querySelectorAll('thead th')).toHaveLength(32)
    expect(screen.getByText('5 additional rows omitted.')).toBeTruthy()
    expect(screen.getByText('3 additional columns omitted.')).toBeTruthy()
  })

  it('labels unknown text/json MIME types and suppresses inline binary payload bytes', () => {
    const text = render(
      <MimeOutput
        output={rich({ 'application/x-custom': { type: 'text', text: 'payload' } })}
        loadAttachment={unusedLoader}
      />,
    )
    expect(text.container.querySelector('pre')?.textContent).toBe('[application/x-custom]\npayload')
    text.unmount()

    const binary = render(
      <MimeOutput
        output={rich({ 'application/x-binary': { type: 'base64', data: 'not-visible' } })}
        loadAttachment={unusedLoader}
      />,
    )
    expect(binary.container.textContent).toContain('Binary output is not displayed.')
    expect(binary.container.textContent).not.toContain('not-visible')
  })
})

describe('NotebookMarkdown', () => {
  it('resolves inline attachment images through the cell bundle and revokes their URL', async () => {
    const ref = attachment('markdown-image')
    const loadAttachment = vi.fn<NotebookAttachmentLoader>(async () => ({
      attachment: ref,
      data: new Uint8Array([1, 2, 3]),
    }))
    const view = render(
      <NotebookMarkdown
        text={'Before ![chart](attachment:markdown-image) after. Missing: ![missing](attachment:not-found).'}
        attachments={{
          'markdown-image': {
            'image/png': { type: 'image', attachment: ref },
            'text/plain': { type: 'text', text: 'chart fallback' },
          },
        }}
        loadAttachment={loadAttachment}
      />,
    )
    await waitFor(() => { expect(screen.getByRole('img', { name: 'chart' }).getAttribute('src')).toBe('blob:notebook-1') })
    expect(view.container.textContent).toContain('Before')
    expect(view.container.textContent).toContain('after')
    expect(view.container.textContent).toContain('missing')
    view.unmount()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:notebook-1')
  })

  it('keeps attachment loading and failure fallbacks valid inside Markdown paragraphs', async () => {
    const ref = attachment('failed-markdown-image')
    let rejectLoad: (reason?: unknown) => void = () => {
      throw new Error('attachment load did not start')
    }
    const pending = new Promise<Awaited<ReturnType<NotebookAttachmentLoader>>>((_, reject) => {
      rejectLoad = reject
    })
    const loadAttachment = vi.fn<NotebookAttachmentLoader>(() => pending)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const view = render(
        <NotebookMarkdown
          text={'Before ![chart](attachment:failed-markdown-image) after.'}
          attachments={{
            'failed-markdown-image': {
              'image/png': { type: 'image', attachment: ref },
              'text/plain': { type: 'text', text: 'chart fallback' },
            },
          }}
          loadAttachment={loadAttachment}
        />,
      )
      const paragraph = view.container.querySelector('p')
      const loading = screen.getByRole('status')
      expect(loading.tagName).toBe('SPAN')
      expect(paragraph?.contains(loading)).toBe(true)
      expect(paragraph?.querySelector('p, div, pre')).toBeNull()

      rejectLoad(new Error('attachment unavailable'))
      const failed = await screen.findByRole('alert')
      expect(failed.tagName).toBe('SPAN')
      expect(failed.textContent).toContain('chart fallback')
      expect(failed.querySelector('p, div, pre')).toBeNull()
      expect(consoleError.mock.calls.flat().join(' ')).not.toContain('validateDOMNesting')
    } finally {
      consoleError.mockRestore()
    }
  })
})
