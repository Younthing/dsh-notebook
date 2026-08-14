import { useEffect, useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {
  NotebookCellAttachments,
  NotebookJsonValue,
  NotebookMimeBundle,
  NotebookMimeValue,
  NotebookOutput,
} from '@deepseek-ai/dsh-notebook-core/types'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarkdownImages } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './notebook.module.css'

/** Session-authorized raster bytes returned to a pure Notebook component. */
export interface NotebookAttachmentBytes {
  /** Verified durable attachment metadata returned with the bytes. */
  readonly attachment: ImageAttachmentRef
  /** Complete encoded raster bytes. */
  readonly data: Uint8Array
}

/** Resolve one durable raster reference through the currently rendered session. */
export type NotebookAttachmentLoader = (
  attachment: ImageAttachmentRef,
) => Promise<NotebookAttachmentBytes>

/** Localized labels used by notebook output renderers. */
export interface MimeOutputLabels {
  /** Loading placeholder for an authorized raster. */
  readonly imageLoading: string
  /** Visible error when authorized raster loading fails. */
  readonly imageLoadFailed: string
  /** Retry control for a failed raster load. */
  readonly imageRetry: string
  /** Notice for an inline binary format without a browser renderer. */
  readonly binaryOmitted: string
  /** Notice for a rich output with no MIME alternatives. */
  readonly emptyBundle: string
}

/** Props for one durable notebook execution output. */
export interface MimeOutputProps {
  /** Structured stream, rich display, result, or error record. */
  readonly output: NotebookOutput
  /** Session-authorized raster loader; the renderer owns resulting object URLs. */
  readonly loadAttachment: NotebookAttachmentLoader
  /** Localized loading, retry, and fallback labels. */
  readonly labels?: MimeOutputLabels
  /** Format a visible notice when a renderer caps rows or points. */
  readonly formatOmitted?: (count: number, unit: 'rows' | 'points' | 'columns') => string
}

/** Props for Markdown that can resolve nbformat `attachment:name` images. */
export interface NotebookMarkdownProps {
  /** Markdown cell source. */
  readonly text: string
  /** Cell-local MIME bundles keyed by nbformat attachment name. */
  readonly attachments: NotebookCellAttachments
  /** Session-authorized raster loader. */
  readonly loadAttachment: NotebookAttachmentLoader
  /** Localized loading, retry, and fallback labels. */
  readonly labels?: MimeOutputLabels
  /** Format a visible notice when a renderer caps rows or points. */
  readonly formatOmitted?: (count: number, unit: 'rows' | 'points' | 'columns') => string
}

interface ChartSeries {
  readonly xs: number[]
  readonly ys: number[]
  readonly kind: 'line' | 'bar'
  readonly omitted: number
}

interface MimeSelection {
  readonly mimeType: string
  readonly value: NotebookMimeValue
}

const MAX_CHART_POINTS = 500
const MAX_TABLE_ROWS = 200
const MAX_TABLE_COLUMNS = 32
const HTML_OUTPUT_CSP = "default-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; connect-src 'none'; img-src data:; media-src data:; font-src data:; style-src 'unsafe-inline'"
const MIME_PREFERENCE = [
  'application/vnd.plotly.v1+json',
  'application/vnd.vegalite.v5+json',
  'application/vnd.dataresource+json',
  'text/html',
  'image/svg+xml',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'text/markdown',
  'application/json',
  'text/plain',
] as const
const DEFAULT_LABELS: MimeOutputLabels = {
  imageLoading: 'Loading image…',
  imageLoadFailed: 'Image could not be loaded.',
  imageRetry: 'Retry image',
  binaryOmitted: 'Binary output is not displayed.',
  emptyBundle: 'This output has no MIME alternatives.',
}

function assertNever(value: never): never {
  throw new Error(`unsupported notebook output ${JSON.stringify(value)}`)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function prettyJson(value: NotebookJsonValue): string {
  return JSON.stringify(value, null, 2)
}

function asNumbers(value: unknown, limit: number): { readonly values: number[]; readonly total: number } | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const numbers: number[] = []
  for (const entry of value.slice(0, limit)) {
    if (typeof entry !== 'number' || !Number.isFinite(entry)) return undefined
    numbers.push(entry)
  }
  return { values: numbers, total: value.length }
}

function parsePlotly(value: NotebookJsonValue): ChartSeries | undefined {
  const parsed = asRecord(value)
  const data = parsed?.data
  if (!Array.isArray(data)) return undefined
  const series = asRecord(data[0])
  const ys = asNumbers(series?.y, MAX_CHART_POINTS)
  if (ys === undefined) return undefined
  const suppliedXs = series?.x === undefined ? undefined : asNumbers(series.x, MAX_CHART_POINTS)
  if (series?.x !== undefined && suppliedXs === undefined) return undefined
  if (suppliedXs !== undefined && suppliedXs.total !== ys.total) return undefined
  const xs = suppliedXs?.values ?? ys.values.map((_, index) => index)
  let omitted = Math.max(0, ys.total - ys.values.length)
  for (const extra of data.slice(1)) {
    const extraY = asRecord(extra)?.y
    if (Array.isArray(extraY)) {
      omitted = Math.min(Number.MAX_SAFE_INTEGER, omitted + extraY.length)
    }
  }
  return {
    xs,
    ys: ys.values,
    kind: series?.type === 'bar' ? 'bar' : 'line',
    omitted,
  }
}

function parseVegaLite(value: NotebookJsonValue): ChartSeries | undefined {
  const parsed = asRecord(value)
  const data = asRecord(parsed?.data)
  const encoding = asRecord(parsed?.encoding)
  const xEncoding = asRecord(encoding?.x)
  const yEncoding = asRecord(encoding?.y)
  const values = data?.values
  const xField = xEncoding?.field
  const yField = yEncoding?.field
  if (!Array.isArray(values) || typeof xField !== 'string' || typeof yField !== 'string') return undefined
  const xs: number[] = []
  const ys: number[] = []
  for (const row of values.slice(0, MAX_CHART_POINTS)) {
    const record = asRecord(row)
    const x = record?.[xField]
    const y = record?.[yField]
    if (typeof x !== 'number' || !Number.isFinite(x) || typeof y !== 'number' || !Number.isFinite(y)) {
      return undefined
    }
    xs.push(x)
    ys.push(y)
  }
  if (xs.length === 0) return undefined
  const mark = typeof parsed?.mark === 'string' ? parsed.mark : asRecord(parsed?.mark)?.type
  return {
    xs,
    ys,
    kind: mark === 'bar' ? 'bar' : 'line',
    omitted: Math.max(0, values.length - xs.length),
  }
}

function formatTick(value: number): string {
  if (Number.isInteger(value)) return String(value)
  return value.toFixed(1)
}

function ChartSvg({ series, mimeType }: { series: ChartSeries; mimeType: string }): ReactElement {
  const width = 420
  const height = 220
  const pad = { l: 44, r: 16, t: 16, b: 32 }
  let minX = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let minY = 0
  let maxY = 0
  for (const x of series.xs) {
    minX = Math.min(minX, x)
    maxX = Math.max(maxX, x)
  }
  for (const y of series.ys) {
    minY = Math.min(minY, y)
    maxY = Math.max(maxY, y)
  }
  const spanX = maxX - minX || 1
  const spanY = maxY - minY || 1
  const xOf = (x: number) => pad.l + ((x - minX) / spanX) * (width - pad.l - pad.r)
  const yOf = (y: number) => height - pad.b - ((y - minY) / spanY) * (height - pad.t - pad.b)
  const points: string[] = []
  for (let index = 0; index < series.xs.length; index++) {
    const x = series.xs[index]
    const y = series.ys[index]
    if (x === undefined || y === undefined) continue
    points.push(`${xOf(x)},${yOf(y)}`)
  }
  const barWidth = Math.max(8, (width - pad.l - pad.r) / (series.xs.length * 2))
  const axis = 'var(--dsw-alias-border-l3)'
  const caption = 'var(--dsw-alias-label-caption)'
  const firstX = series.xs[0]
  const lastX = series.xs[series.xs.length - 1]
  const area = firstX === undefined || lastX === undefined
    ? undefined
    : `${xOf(firstX)},${yOf(0)} ${points.join(' ')} ${xOf(lastX)},${yOf(0)}`
  return (
    <svg
      className={css.chart}
      role="img"
      data-mime={mimeType}
      viewBox={`0 0 ${width} ${height}`}
      aria-label={mimeType}
    >
      <line x1={pad.l} y1={height - pad.b} x2={width - pad.r} y2={height - pad.b} stroke={axis} />
      <line x1={pad.l} y1={pad.t} x2={pad.l} y2={height - pad.b} stroke={axis} />
      <text x={4} y={yOf(maxY) + 4} fill={caption} fontSize="10">{formatTick(maxY)}</text>
      <text x={4} y={yOf(minY)} fill={caption} fontSize="10">{formatTick(minY)}</text>
      {series.kind === 'bar'
        ? series.xs.map((x, index) => {
          const y = series.ys[index]
          if (y === undefined) return null
          const top = yOf(Math.max(y, 0))
          const bottom = yOf(Math.min(y, 0))
          return (
            <rect
              key={`${x}:${index}`}
              x={xOf(x) - barWidth / 2}
              y={top}
              width={barWidth}
              height={Math.max(1, bottom - top)}
              fill="currentColor"
              opacity="0.82"
            />
          )
        })
        : (
          <>
            {area !== undefined && <polygon points={area} fill="currentColor" opacity="0.12" />}
            <polyline fill="none" stroke="currentColor" strokeWidth="2" points={points.join(' ')} />
          </>
        )}
    </svg>
  )
}

function cellText(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value === null || value === undefined) return ''
  return JSON.stringify(value)
}

function OmittedNotice({
  count, unit, format,
}: {
  readonly count: number
  readonly unit: 'rows' | 'points' | 'columns'
  readonly format: (count: number, unit: 'rows' | 'points' | 'columns') => string
}): ReactElement | null {
  return count === 0
    ? null
    : <p className={css.omitted} role="status">{format(count, unit)}</p>
}

function renderDataResource(
  value: NotebookJsonValue,
  fallback: string | undefined,
  formatOmitted: (count: number, unit: 'rows' | 'points' | 'columns') => string,
): ReactElement {
  const parsed = asRecord(value)
  const schema = asRecord(parsed?.schema)
  const fieldsValue = schema?.fields
  const rowsValue = parsed?.data
  if (!Array.isArray(fieldsValue) || !Array.isArray(rowsValue)) {
    return <pre className={css.outputPre}>{fallback ?? prettyJson(value)}</pre>
  }
  const allFields: string[] = []
  for (const fieldValue of fieldsValue) {
    const name = asRecord(fieldValue)?.name
    if (typeof name !== 'string') return <pre className={css.outputPre}>{fallback ?? prettyJson(value)}</pre>
    allFields.push(name)
  }
  const rows: Record<string, unknown>[] = []
  for (const rowValue of rowsValue.slice(0, MAX_TABLE_ROWS)) {
    const row = asRecord(rowValue)
    if (row === undefined) return <pre className={css.outputPre}>{fallback ?? prettyJson(value)}</pre>
    rows.push(row)
  }
  if (allFields.length === 0 || rowsValue.length === 0) {
    return <pre className={css.outputPre}>{fallback ?? prettyJson(value)}</pre>
  }
  const fields = allFields.slice(0, MAX_TABLE_COLUMNS)
  return (
    <div>
      <div className={css.tableWrap}>
        <table className={css.table}>
          <thead>
            <tr>{fields.map((field, index) => <th key={`${field}:${String(index)}`}>{field}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {fields.map((field, columnIndex) => (
                  <td key={`${field}:${String(columnIndex)}`}>
                    {cellText(Object.hasOwn(row, field) ? row[field] : undefined)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <OmittedNotice
        count={Math.max(0, rowsValue.length - rows.length)}
        unit="rows"
        format={formatOmitted}
      />
      <OmittedNotice
        count={Math.max(0, allFields.length - fields.length)}
        unit="columns"
        format={formatOmitted}
      />
    </div>
  )
}

function renderChart(
  mimeType: string,
  value: NotebookJsonValue,
  fallback: string | undefined,
  parser: (raw: NotebookJsonValue) => ChartSeries | undefined,
  formatOmitted: (count: number, unit: 'rows' | 'points' | 'columns') => string,
): ReactElement {
  const series = parser(value)
  if (series === undefined) {
    return <pre className={css.outputPre} data-mime={mimeType}>{fallback ?? prettyJson(value)}</pre>
  }
  return (
    <div>
      <ChartSvg series={series} mimeType={mimeType} />
      <OmittedNotice count={series.omitted} unit="points" format={formatOmitted} />
    </div>
  )
}

function htmlDocument(data: string): string {
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${HTML_OUTPUT_CSP}"></head><body>${data}</body></html>`
}

function isRasterMime(mimeType: string): boolean {
  return mimeType === 'image/png'
    || mimeType === 'image/jpeg'
    || mimeType === 'image/webp'
    || mimeType === 'image/gif'
}

function canRender(mimeType: string, value: NotebookMimeValue): boolean {
  if (isRasterMime(mimeType)) return value.type === 'image'
  switch (mimeType) {
    case 'application/vnd.plotly.v1+json':
    case 'application/vnd.vegalite.v5+json':
    case 'application/vnd.dataresource+json':
    case 'application/json':
      return value.type === 'json'
    case 'text/html':
    case 'text/markdown':
    case 'text/plain':
      return value.type === 'text'
    case 'image/svg+xml':
      return value.type === 'text' || value.type === 'base64'
    default:
      return true
  }
}

function selectBundle(bundle: NotebookMimeBundle): MimeSelection | undefined {
  for (const mimeType of MIME_PREFERENCE) {
    const value = bundle[mimeType]
    if (value !== undefined && canRender(mimeType, value)) return { mimeType, value }
  }
  for (const [mimeType, value] of Object.entries(bundle)) {
    if (canRender(mimeType, value)) return { mimeType, value }
  }
  return undefined
}

function textFallback(bundle: NotebookMimeBundle, selectedMimeType: string): string | undefined {
  for (const mimeType of ['text/plain', 'text/markdown'] as const) {
    if (mimeType === selectedMimeType) continue
    const value = bundle[mimeType]
    if (value?.type === 'text') return value.text
  }
  return undefined
}

function AttachmentImage({
  attachment,
  alt,
  fallback,
  inline,
  loadAttachment,
  labels,
}: {
  readonly attachment: ImageAttachmentRef
  readonly alt: string
  readonly fallback: string | undefined
  readonly inline: boolean
  readonly loadAttachment: NotebookAttachmentLoader
  readonly labels: MimeOutputLabels
}): ReactElement {
  const [attempt, setAttempt] = useState(0)
  const [src, setSrc] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let live = true
    let objectUrl: string | undefined
    setSrc(null)
    setFailed(false)
    void loadAttachment(attachment).then((loaded) => {
      if (typeof URL.createObjectURL !== 'function') throw new Error('browser object URLs are unavailable')
      const bytes = Uint8Array.from(loaded.data)
      const next = URL.createObjectURL(new Blob([bytes.buffer], { type: loaded.attachment.mediaType }))
      if (!live) {
        URL.revokeObjectURL(next)
        return
      }
      objectUrl = next
      setSrc(next)
    }).catch(() => {
      if (live) setFailed(true)
    })
    return () => {
      live = false
      if (objectUrl !== undefined) URL.revokeObjectURL(objectUrl)
    }
  }, [attachment, attempt, loadAttachment])

  if (failed) {
    const ErrorContainer = inline ? 'span' : 'div'
    const FallbackContainer = inline ? 'span' : 'pre'
    return (
      <ErrorContainer className={css.outputImageError} role="alert">
        <span>{labels.imageLoadFailed}</span>
        <button type="button" onClick={() => { setAttempt(value => value + 1) }}>
          {labels.imageRetry}
        </button>
        {fallback === undefined ? null : <FallbackContainer className={css.outputPre}>{fallback}</FallbackContainer>}
      </ErrorContainer>
    )
  }
  if (src === null) {
    const LoadingContainer = inline ? 'span' : 'p'
    return <LoadingContainer className={css.outputLoading} role="status">{labels.imageLoading}</LoadingContainer>
  }
  return (
    <img
      className={css.outputImage}
      alt={alt}
      src={src}
      width={attachment.width}
      height={attachment.height}
    />
  )
}

function SvgOutput({ mimeType, value }: { mimeType: string; value: NotebookMimeValue }): ReactElement {
  const source = value.type === 'text'
    ? value.text
    : value.type === 'base64'
      ? `<img alt="${mimeType}" src="data:image/svg+xml;base64,${value.data}">`
      : ''
  return (
    <iframe
      className={css.outputFrame}
      title={mimeType}
      sandbox=""
      srcDoc={htmlDocument(source)}
    />
  )
}

function MimeBundle({
  bundle,
  imageAlt,
  inlineImage = false,
  loadAttachment,
  labels,
  formatOmitted,
}: {
  readonly bundle: NotebookMimeBundle
  readonly imageAlt?: string
  readonly inlineImage?: boolean
  readonly loadAttachment: NotebookAttachmentLoader
  readonly labels: MimeOutputLabels
  readonly formatOmitted: (count: number, unit: 'rows' | 'points' | 'columns') => string
}): ReactElement {
  const selection = selectBundle(bundle)
  if (selection === undefined) return <pre className={css.outputPre}>{labels.emptyBundle}</pre>
  const { mimeType, value } = selection
  const fallback = textFallback(bundle, mimeType)
  if (isRasterMime(mimeType) && value.type === 'image') {
    return (
      <AttachmentImage
        key={value.attachment.attachmentId}
        attachment={value.attachment}
        alt={imageAlt ?? value.attachment.name ?? mimeType}
        fallback={fallback}
        inline={inlineImage}
        loadAttachment={loadAttachment}
        labels={labels}
      />
    )
  }
  switch (mimeType) {
    case 'text/plain':
      return <pre className={css.outputPre}>{value.type === 'text' ? value.text : ''}</pre>
    case 'text/markdown':
      return value.type === 'text'
        ? <MarkdownText text={value.text} />
        : <pre className={css.outputPre}>{fallback ?? ''}</pre>
    case 'image/svg+xml':
      return <SvgOutput mimeType={mimeType} value={value} />
    case 'application/vnd.plotly.v1+json':
      return value.type === 'json'
        ? renderChart(mimeType, value.value, fallback, parsePlotly, formatOmitted)
        : <pre className={css.outputPre}>{fallback ?? ''}</pre>
    case 'application/vnd.vegalite.v5+json':
      return value.type === 'json'
        ? renderChart(mimeType, value.value, fallback, parseVegaLite, formatOmitted)
        : <pre className={css.outputPre}>{fallback ?? ''}</pre>
    case 'application/vnd.dataresource+json':
      return value.type === 'json'
        ? renderDataResource(value.value, fallback, formatOmitted)
        : <pre className={css.outputPre}>{fallback ?? ''}</pre>
    case 'application/json':
      return value.type === 'json'
        ? <pre className={css.outputPre}>{prettyJson(value.value)}</pre>
        : <pre className={css.outputPre}>{fallback ?? ''}</pre>
    case 'text/html':
      return value.type === 'text'
        ? (
          <iframe
            className={css.outputFrame}
            title={mimeType}
            sandbox=""
            srcDoc={htmlDocument(value.text)}
          />
        )
        : <pre className={css.outputPre}>{fallback ?? ''}</pre>
    default:
      switch (value.type) {
        case 'text':
          return <pre className={css.outputPre} data-mime={mimeType}>{`[${mimeType}]\n${value.text}`}</pre>
        case 'json':
          return <pre className={css.outputPre} data-mime={mimeType}>{`[${mimeType}]\n${prettyJson(value.value)}`}</pre>
        case 'base64':
          return <pre className={css.outputPre} data-mime={mimeType}>{`[${mimeType}]\n${labels.binaryOmitted}`}</pre>
        case 'image':
          return <pre className={css.outputPre} data-mime={mimeType}>{`[${mimeType}]\n${labels.binaryOmitted}`}</pre>
        default:
          return assertNever(value)
      }
  }
}

/**
 * Render one durable notebook output, selecting one supported MIME alternative per rich bundle.
 * @param props - Structured output, authorized raster loader, labels, and omission formatter.
 * @returns A bounded stream, error, chart, table, frame, image, or text representation.
 */
export function MimeOutput({
  output,
  loadAttachment,
  labels = DEFAULT_LABELS,
  formatOmitted = (count, unit) => `${String(count)} additional ${unit} omitted.`,
}: MimeOutputProps): ReactElement {
  switch (output.type) {
    case 'stream':
      return (
        <pre className={css.outputPre} data-stream={output.name}>
          {output.text}
        </pre>
      )
    case 'display':
    case 'execute-result':
      return (
        <MimeBundle
          bundle={output.data}
          loadAttachment={loadAttachment}
          labels={labels}
          formatOmitted={formatOmitted}
        />
      )
    case 'error':
      return (
        <div className={css.outputError} role="alert">
          <strong>{`${output.name}: ${output.value}`}</strong>
          {output.traceback.length === 0
            ? null
            : <pre className={css.outputPre}>{output.traceback.join('\n')}</pre>}
        </div>
      )
    default:
      return assertNever(output)
  }
}

function attachmentName(url: string): string | undefined {
  if (!url.startsWith('attachment:')) return undefined
  const encoded = url.slice('attachment:'.length)
  if (encoded.length === 0) return undefined
  try {
    return decodeURIComponent(encoded)
  } catch {
    // A malformed percent escape cannot name an nbformat attachment.
    return undefined
  }
}

/**
 * Render Markdown while resolving only its cell-local `attachment:name` image vocabulary.
 * @param props - Source text, cell bundles, authorized raster loader, labels, and omission formatter.
 * @returns Safe GFM with owner-rendered cell attachments.
 */
export function NotebookMarkdown({
  text,
  attachments,
  loadAttachment,
  labels = DEFAULT_LABELS,
  formatOmitted = (count, unit) => `${String(count)} additional ${unit} omitted.`,
}: NotebookMarkdownProps): ReactElement {
  const images = useMemo<MarkdownImages>(() => ({
    resolve: (url, alt) => {
      const name = attachmentName(url)
      const bundle = name === undefined || !Object.hasOwn(attachments, name)
        ? undefined
        : attachments[name]
      if (bundle === undefined) return undefined
      return (
        <MimeBundle
          bundle={bundle}
          imageAlt={alt}
          inlineImage
          loadAttachment={loadAttachment}
          labels={labels}
          formatOmitted={formatOmitted}
        />
      )
    },
  }), [attachments, formatOmitted, labels, loadAttachment])
  return <MarkdownText text={text} images={images} />
}
