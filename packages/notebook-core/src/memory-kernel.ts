/**
 * In-process memory kernel for tests and keyless compositions.
 * @module @younthing/dsh-notebook-core/memory-kernel
 */

import type {
  NotebookKernelBackend,
  NotebookKernelExecutionEvent,
  NotebookKernelHandle,
  NotebookKernelStartSpec,
} from './kernel-types.ts'

/** Minimal 1×1 PNG payload used when source contains `# mime:image/png`. */
const ONE_BY_ONE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/** Mutable namespace retained by one in-process memory kernel. */
interface MemoryKernelState {
  readonly vars: Map<string, MemoryValue>
  executionCount: number
}

type MemoryValue = string | number | boolean | null

type AtomResult =
  | { readonly matched: false }
  | { readonly matched: true; readonly value: MemoryValue }

/** In-process notebook kernel that evaluates a tiny assignment and print dialect. */
export class MemoryKernelBackend implements NotebookKernelBackend {
  /** Stable backend type registered on {@link NotebookService}. */
  readonly type = 'memory'

  /** @inheritdoc */
  start(_spec: NotebookKernelStartSpec): Promise<NotebookKernelHandle> {
    return Promise.resolve({
      vars: new Map<string, MemoryValue>(),
      executionCount: 0,
    } satisfies MemoryKernelState)
  }

  /** @inheritdoc */
  async *execute(handle: NotebookKernelHandle, source: string, signal: AbortSignal): AsyncIterable<NotebookKernelExecutionEvent> {
    // Let cancellation win before this in-process backend mutates its retained namespace.
    await Promise.resolve()
    signal.throwIfAborted()
    const state = handle as MemoryKernelState
    state.executionCount += 1
    const executionCount = state.executionCount
    if (source.includes('# mime:image/png')) {
      yield {
        type: 'output',
        mutation: {
          operation: 'append',
          output: {
            type: 'display',
            data: {
              'image/png': { type: 'base64', data: ONE_BY_ONE_PNG_BASE64 },
              'text/plain': { type: 'text', text: '<1×1 PNG>' },
            },
            metadata: {},
          },
        },
      }
      yield { type: 'complete', status: 'ok', executionCount }
      return
    }
    if (/\b(import|from)\b/.test(source)) {
      const error = 'import statements are not supported in the memory kernel'
      yield {
        type: 'output',
        mutation: {
          operation: 'append',
          output: { type: 'error', name: 'MemoryKernelError', value: error, traceback: [] },
        },
      }
      yield { type: 'complete', status: 'error', error, executionCount }
      return
    }
    const lines = source.split('\n')
    for (const rawLine of lines) {
      signal.throwIfAborted()
      const line = rawLine.trim()
      if (line.length === 0 || line.startsWith('#')) continue
      try {
        const printMatch = line.match(/^print\((.+)\)$/)
        if (printMatch !== null) {
          const value = evaluateExpression(capture(printMatch, 1), state.vars)
          yield {
            type: 'output',
            mutation: {
              operation: 'append',
              output: { type: 'stream', name: 'stdout', text: `${formatValue(value)}\n` },
            },
          }
          continue
        }
        const assignMatch = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/)
        if (assignMatch !== null) {
          state.vars.set(
            capture(assignMatch, 1),
            evaluateExpression(capture(assignMatch, 2), state.vars),
          )
          continue
        }
        const value = evaluateExpression(line, state.vars)
        yield {
          type: 'output',
          mutation: {
            operation: 'append',
            output: {
              type: 'execute-result',
              data: { 'text/plain': { type: 'text', text: formatValue(value) } },
              metadata: {},
              executionCount,
            },
          },
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        yield {
          type: 'output',
          mutation: {
            operation: 'append',
            output: { type: 'error', name: 'MemoryKernelError', value: message, traceback: [] },
          },
        }
        yield { type: 'complete', status: 'error', error: message, executionCount }
        return
      }
    }
    yield { type: 'complete', status: 'ok', executionCount }
  }

  /** @inheritdoc */
  inspect(handle: NotebookKernelHandle, name: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted()
    const state = handle as MemoryKernelState
    const value = state.vars.get(name)
    return Promise.resolve(value === undefined
      ? `${name} is not defined`
      : `${name} = ${formatValue(value)}`)
  }

  /** @inheritdoc */
  shutdown(_handle: NotebookKernelHandle, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    return Promise.resolve()
  }
}

function capture(match: RegExpMatchArray, index: number): string {
  const value = match[index]
  if (value === undefined) throw new Error('invalid memory-kernel parser match')
  return value
}

function evaluateExpression(expression: string, vars: Map<string, MemoryValue>): MemoryValue {
  const trimmed = expression.trim()
  if (trimmed.length === 0) throw new Error('empty expression')
  const atom = evaluateAtom(trimmed, vars)
  if (atom.matched) return atom.value
  const binary = trimmed.match(/^(.+?)\s*([+*/-])\s*(.+)$/)
  if (binary === null) throw new Error('unsupported syntax')
  const left = requireAtom(capture(binary, 1), vars)
  const operator = capture(binary, 2)
  const right = requireAtom(capture(binary, 3), vars)
  if (operator === '+' && typeof left === 'string' && typeof right === 'string') {
    return left + right
  }
  if (typeof left !== 'number' || typeof right !== 'number') {
    throw new Error(`operator ${operator} requires two numbers`)
  }
  let value: number
  switch (operator) {
    case '+':
      value = left + right
      break
    case '-':
      value = left - right
      break
    case '*':
      value = left * right
      break
    case '/':
      value = left / right
      break
    default:
      throw new Error('unsupported operator')
  }
  if (!Number.isFinite(value)) throw new Error('numeric result must be finite')
  return value
}

function requireAtom(expression: string, vars: Map<string, MemoryValue>): MemoryValue {
  const atom = evaluateAtom(expression.trim(), vars)
  if (!atom.matched) throw new Error('binary operands must be literals or variables')
  return atom.value
}

function evaluateAtom(expression: string, vars: Map<string, MemoryValue>): AtomResult {
  if (/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(expression)) {
    const value = Number(expression)
    if (!Number.isFinite(value)) throw new Error('numeric literal must be finite')
    return { matched: true, value }
  }
  if (expression === 'true') return { matched: true, value: true }
  if (expression === 'false') return { matched: true, value: false }
  if (expression === 'null') return { matched: true, value: null }
  const first = expression.charAt(0)
  if (first === '"' || first === "'") {
    return { matched: true, value: parseStringLiteral(expression, first) }
  }
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(expression)) {
    const value = vars.get(expression)
    if (value === undefined) throw new Error(`${expression} is not defined`)
    return { matched: true, value }
  }
  return { matched: false }
}

function parseStringLiteral(source: string, quote: '"' | "'"): string {
  if (source.length < 2 || source.at(-1) !== quote) throw new Error('unterminated string literal')
  let value = ''
  for (let index = 1; index < source.length - 1; index += 1) {
    const character = source.charAt(index)
    if (character === quote) throw new Error('unescaped quote in string literal')
    if (character !== '\\') {
      value += character
      continue
    }
    index += 1
    if (index >= source.length - 1) throw new Error('unterminated string escape')
    const escaped = source.charAt(index)
    switch (escaped) {
      case 'n':
        value += '\n'
        break
      case 'r':
        value += '\r'
        break
      case 't':
        value += '\t'
        break
      case '\\':
      case '"':
      case "'":
        value += escaped
        break
      default:
        throw new Error(`unsupported string escape \\${escaped}`)
    }
  }
  return value
}

function formatValue(value: MemoryValue): string {
  return typeof value === 'string' ? value : String(value)
}

export type { MemoryKernelState }
