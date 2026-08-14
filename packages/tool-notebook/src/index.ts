/**
 * Model-facing notebook document tools and user-execution helper. Environment
 * installation and selection remain explicit UI operations.
 * @module @deepseek-ai/dsh-tool-notebook
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CellId, NotebookError, NotebookId } from '@deepseek-ai/dsh-notebook-core'
import type { NotebookExecuteResult } from '@deepseek-ai/dsh-notebook-core'
import type {
  NotebookJsonObject,
  NotebookJsonValue,
  NotebookMimeBundle,
  NotebookMimeValue,
  NotebookOutput,
} from '@deepseek-ai/dsh-notebook-core/types'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { InferValue, ToolRunContext, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import { notebookImageAttachmentJson } from './mime.ts'
import {
  boundNotebookText,
  renderNotebookDocument,
  renderNotebookExecution,
  renderNotebookJson,
} from './render.ts'

/** Cordis plugin name. */
export const name = 'tool-notebook'
/** Required notebook, tool, prompt, and agent services. */
export const inject = ['notebooks', 'tools', 'systemPrompt', 'agents']

/** Default cap for one complete notebook tool result. */
export const DEFAULT_MAX_RESULT_BYTES = 256 * 1024
/** Default cap for one user-run summary injected into the next model request. */
export const DEFAULT_MAX_INJECTION_BYTES = 64 * 1024
/** Smallest cap that preserves actionable notebook status text. */
export const MIN_NOTEBOOK_RESULT_BYTES = 128

/** Model-facing Notebook Consumer configuration. */
export interface Config {
  /** Maximum UTF-8 bytes in one complete tool result. */
  maxResultBytes?: number
}

/** Schemastery configuration for bounded notebook rendering. */
export const Config: z<Config> = z.object({
  maxResultBytes: z.number().step(1).min(MIN_NOTEBOOK_RESULT_BYTES).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_RESULT_BYTES),
})

const NOTEBOOK_OUTPUT_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        type: { type: 'string', const: 'stream', required: true },
        name: { type: 'string', enum: ['stdout', 'stderr'], required: true },
        text: { type: 'string', required: true },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        type: { type: 'string', const: 'display', required: true },
        data: { type: 'json', required: true },
        metadata: { type: 'json', required: true },
        displayId: { type: 'string' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        type: { type: 'string', const: 'execute-result', required: true },
        data: { type: 'json', required: true },
        metadata: { type: 'json', required: true },
        executionCount: {
          oneOf: [{ type: 'integer' }, { type: 'null' }],
          required: true,
        },
        displayId: { type: 'string' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        type: { type: 'string', const: 'error', required: true },
        name: { type: 'string', required: true },
        value: { type: 'string', required: true },
        traceback: { type: 'array', items: { type: 'string' }, required: true },
      },
    },
  ],
} as const satisfies ValueSchemaSpec

const NOTEBOOK_EXECUTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    executionId: { type: 'string', required: true },
    status: { type: 'string', required: true, enum: ['ok', 'error', 'cancelled'] },
    executionCount: {
      oneOf: [{ type: 'integer' }, { type: 'null' }],
      required: true,
    },
    outputs: { type: 'array', required: true, items: NOTEBOOK_OUTPUT_SCHEMA },
    error: { type: 'string' },
  },
} as const satisfies ValueSchemaSpec

const NOTEBOOK_ENVIRONMENT_REQUIRED_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', const: 'environment-required', required: true },
    code: { type: 'string', const: 'ENVIRONMENT_REQUIRED', required: true },
    message: { type: 'string', required: true },
  },
} as const satisfies ValueSchemaSpec

const NOTEBOOK_EXECUTE_SCHEMA = {
  oneOf: [NOTEBOOK_EXECUTION_SCHEMA, NOTEBOOK_ENVIRONMENT_REQUIRED_SCHEMA],
} as const satisfies ValueSchemaSpec

type NotebookExecutionValue = InferValue<typeof NOTEBOOK_EXECUTION_SCHEMA>
type NotebookEnvironmentRequiredValue = InferValue<typeof NOTEBOOK_ENVIRONMENT_REQUIRED_SCHEMA>
type NotebookOutputValue = InferValue<typeof NOTEBOOK_OUTPUT_SCHEMA>
type ToolJsonValue = InferValue<{ readonly type: 'json' }>

function toolJsonValue(value: NotebookJsonValue): ToolJsonValue {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(toolJsonValue)
  const copied: Record<string, ToolJsonValue> = {}
  for (const [key, item] of Object.entries(value)) copied[key] = toolJsonValue(item)
  return copied
}

function notebookJsonObjectValue(value: NotebookJsonObject): ToolJsonValue {
  const copied: Record<string, ToolJsonValue> = {}
  for (const [key, item] of Object.entries(value)) copied[key] = toolJsonValue(item)
  return copied
}

function notebookMimeValue(value: NotebookMimeValue): ToolJsonValue {
  switch (value.type) {
    case 'text':
      return { type: 'text', text: value.text }
    case 'json':
      return { type: 'json', value: toolJsonValue(value.value) }
    case 'image':
      return {
        type: 'image',
        attachment: notebookImageAttachmentJson(value.attachment),
      }
    case 'base64':
      return { type: 'base64', data: value.data }
    default:
      return assertNever(value)
  }
}

function notebookMimeBundleValue(value: NotebookMimeBundle): ToolJsonValue {
  const copied: Record<string, ToolJsonValue> = {}
  for (const [mimeType, item] of Object.entries(value)) copied[mimeType] = notebookMimeValue(item)
  return copied
}

function notebookOutputValue(output: NotebookOutput): NotebookOutputValue {
  switch (output.type) {
    case 'stream':
      return { type: 'stream', name: output.name, text: output.text }
    case 'display':
      return {
        type: 'display',
        data: notebookMimeBundleValue(output.data),
        metadata: notebookJsonObjectValue(output.metadata),
        ...output.displayId === undefined ? {} : { displayId: output.displayId },
      }
    case 'execute-result':
      return {
        type: 'execute-result',
        data: notebookMimeBundleValue(output.data),
        metadata: notebookJsonObjectValue(output.metadata),
        executionCount: output.executionCount,
        ...output.displayId === undefined ? {} : { displayId: output.displayId },
      }
    case 'error':
      return {
        type: 'error',
        name: output.name,
        value: output.value,
        traceback: [...output.traceback],
      }
    default:
      return assertNever(output)
  }
}

function assertNever(value: never): never {
  throw new Error(`unreachable notebook value ${JSON.stringify(value)}`)
}

function notebookExecutionValue(result: NotebookExecuteResult): NotebookExecutionValue {
  return {
    executionId: result.executionId,
    status: result.status,
    executionCount: result.executionCount,
    outputs: result.outputs.map(notebookOutputValue),
    ...result.error === undefined ? {} : { error: result.error },
  }
}

function notebookEnvironmentRequiredValue(message: string): NotebookEnvironmentRequiredValue {
  return {
    status: 'environment-required',
    code: 'ENVIRONMENT_REQUIRED',
    message,
  }
}

function requireAgent(agent: Agent | undefined): Agent {
  if (agent === undefined) throw new Error('notebook tools require an initiating agent')
  return agent
}

function notebookId(value: string): NotebookId {
  if (value.length === 0) throw new Error('notebookId must be a non-empty string')
  return NotebookId(value)
}

function cellId(value: string): CellId {
  if (value.length === 0) throw new Error('cellId must be a non-empty string')
  return CellId(value)
}

interface NotebookToolTarget {
  readonly agent: Agent
  readonly notebookId: NotebookId
}

function requireNotebookTarget(exec: Pick<ToolRunContext, 'agent'>, value: string): NotebookToolTarget {
  return { agent: requireAgent(exec.agent), notebookId: notebookId(value) }
}

function passthroughTextOutput() {
  return {
    schema: { type: 'string' } as const,
    render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
  }
}

function boundedJsonOutput<const Properties extends Record<string, ValueSchemaSpec>>(
  properties: Properties,
  maxBytes: number,
) {
  return {
    schema: {
      type: 'object' as const,
      additionalProperties: false,
      properties,
    },
    render: (_args: unknown, value: NotebookJsonValue) => [{
      type: 'text' as const,
      text: renderNotebookJson(value, maxBytes),
    }],
  }
}

/**
 * Execute one notebook cell as a user-initiated run and inject a summary message.
 * @param ctx - Cordis context carrying the notebook service.
 * @param agent - initiating agent that receives the injected message.
 * @param notebookIdValue - target notebook identity.
 * @param cellIdValue - target cell identity.
 * @param maxInjectionBytes - complete UTF-8 byte cap for the injected summary.
 * @returns execution result from the notebook service.
 */
export async function executeNotebookCellAsUser(
  ctx: Context,
  agent: Agent,
  notebookIdValue: NotebookId,
  cellIdValue: CellId,
  maxInjectionBytes = DEFAULT_MAX_INJECTION_BYTES,
): Promise<NotebookExecuteResult> {
  const result = await ctx.notebooks.execute(
    agent.session,
    notebookIdValue,
    cellIdValue,
    { initiator: 'user' },
  )
  agent.inject(createUserMessage({
    content: [{ type: 'text', text: renderNotebookExecution(result, maxInjectionBytes) }],
    source: { kind: 'plugin', plugin: 'tool-notebook' },
  }))
  return result
}

/** Register notebook tools and minimal usage guidance. */
export function apply(ctx: Context, config: Config = {}): void {
  const maxResultBytes = config.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES
  if (!Number.isSafeInteger(maxResultBytes) || maxResultBytes < MIN_NOTEBOOK_RESULT_BYTES) {
    throw new Error(`tool-notebook: maxResultBytes must be a safe integer of at least ${String(MIN_NOTEBOOK_RESULT_BYTES)}`)
  }
  ctx.systemPrompt.section({
    name: 'tool:notebook',
    order: 108,
    text: 'Use notebook tools for workspace-backed notebook documents. Open an existing path or explicitly create an absent path, read it to discover cell ids, and insert or edit code, markdown, and raw cells while the document is detached. Execute code cells only when a user-selected environment is attached. If execution reports ENVIRONMENT_REQUIRED, tell the user to select an environment in the notebook UI; do not retry or install dependencies. Restart the kernel only when you intentionally need a fresh runtime state. After a write conflict, reload only when you intentionally accept the complete external file snapshot.',
  })

  const genericPresentation = {
    presentCall: () => ({ card: 'generic' as const, title: 'Notebook', kind: 'execute' as const }),
    presentResult: () => ({ card: 'generic' as const }),
  }

  ctx.tools.register(defineTool({
    name: 'notebook_open',
    description: 'Open one existing workspace-backed notebook for this session.',
    parameters: {
      path: { type: 'string', required: true, description: 'Existing workspace path for the notebook document.' },
    },
    output: boundedJsonOutput({
      notebookId: { type: 'string', required: true },
      path: { type: 'string', required: true },
    }, maxResultBytes),
    async execute(args, exec) {
      const agent = requireAgent(exec.agent)
      const opened = await ctx.notebooks.open(
        agent.session,
        args.path,
        { signal: exec.signal },
      )
      return {
        notebookId: opened.id,
        path: opened.path,
      }
    },
    ...genericPresentation,
  }))

  ctx.tools.register(defineTool({
    name: 'notebook_create',
    description: 'Create one notebook only when its workspace path is absent.',
    parameters: {
      path: { type: 'string', required: true, description: 'Absent workspace path for the new notebook document.' },
    },
    output: boundedJsonOutput({
      notebookId: { type: 'string', required: true },
      path: { type: 'string', required: true },
    }, maxResultBytes),
    async execute(args, exec) {
      const agent = requireAgent(exec.agent)
      const created = await ctx.notebooks.create(
        agent.session,
        args.path,
        { signal: exec.signal },
      )
      return { notebookId: created.id, path: created.path }
    },
    ...genericPresentation,
  }))

  ctx.tools.register(defineTool({
    name: 'notebook_read',
    description: 'Read one session-local notebook document reconstructed from the session log.',
    parameters: {
      notebookId: { type: 'string', required: true, description: 'Notebook id returned by notebook_open or notebook_create.' },
    },
    output: passthroughTextOutput(),
    execute(args, exec) {
      const target = requireNotebookTarget(exec, args.notebookId)
      return Promise.resolve(renderNotebookDocument(
        ctx.notebooks.get(target.agent.session, target.notebookId),
        maxResultBytes,
      ))
    },
    ...genericPresentation,
  }))

  ctx.tools.register(defineTool({
    name: 'notebook_edit_cell',
    description: 'Replace one notebook cell source text.',
    parameters: {
      notebookId: { type: 'string', required: true },
      cellId: { type: 'string', required: true },
      source: { type: 'string', required: true },
    },
    output: passthroughTextOutput(),
    async execute(args, exec) {
      const target = requireNotebookTarget(exec, args.notebookId)
      const updated = await ctx.notebooks.editCell(
        target.agent.session,
        target.notebookId,
        cellId(args.cellId),
        args.source,
        exec.signal,
      )
      return renderNotebookDocument(updated, maxResultBytes)
    },
    ...genericPresentation,
  }))

  ctx.tools.register(defineTool({
    name: 'notebook_insert_cell',
    description: 'Insert one notebook cell at the start or immediately after a stable cell id.',
    parameters: {
      notebookId: { type: 'string', required: true },
      afterCellId: { type: 'string', description: 'Existing cell id to insert after; omit to insert at the start.' },
      cellType: { type: 'string', required: true, enum: ['code', 'markdown', 'raw'] },
      source: { type: 'string' },
    },
    output: passthroughTextOutput(),
    async execute(args, exec) {
      const target = requireNotebookTarget(exec, args.notebookId)
      const updated = await ctx.notebooks.insertCell(
        target.agent.session,
        target.notebookId,
        args.cellType,
        args.afterCellId === undefined ? undefined : cellId(args.afterCellId),
        args.source ?? '',
        exec.signal,
      )
      return renderNotebookDocument(updated, maxResultBytes)
    },
    ...genericPresentation,
  }))

  ctx.tools.register(defineTool({
    name: 'notebook_execute',
    description: 'Execute one code cell and return structured stream, rich MIME, or error outputs.',
    parameters: {
      notebookId: { type: 'string', required: true },
      cellId: { type: 'string', required: true },
    },
    output: {
      schema: NOTEBOOK_EXECUTE_SCHEMA,
      render: (_args, value) => [{
        type: 'text',
        text: renderNotebookJson(value, maxResultBytes),
      }],
    },
    async execute(args, exec) {
      const target = requireNotebookTarget(exec, args.notebookId)
      try {
        const result = await ctx.notebooks.execute(
          target.agent.session,
          target.notebookId,
          cellId(args.cellId),
          { initiator: 'agent', signal: exec.signal },
        )
        return notebookExecutionValue(result)
      } catch (error: unknown) {
        if (!(error instanceof NotebookError) || error.code !== 'ENVIRONMENT_REQUIRED') throw error
        return notebookEnvironmentRequiredValue(error.message)
      }
    },
    ...genericPresentation,
  }))

  ctx.tools.register(defineTool({
    name: 'notebook_restart',
    description: 'Replace the selected notebook environment kernel with a fresh runtime.',
    parameters: {
      notebookId: { type: 'string', required: true },
    },
    output: boundedJsonOutput({
      notebookId: { type: 'string', required: true },
      environmentId: { type: 'string', required: true },
      backend: { type: 'string', required: true },
      kernelName: { type: 'string' },
      generation: { type: 'integer', required: true },
    }, maxResultBytes),
    async execute(args, exec) {
      const target = requireNotebookTarget(exec, args.notebookId)
      const restarted = await ctx.notebooks.restart(
        target.agent.session,
        target.notebookId,
        {
          initiator: 'agent',
          signal: exec.signal,
        },
      )
      const kernel = restarted.kernel
      if (kernel === undefined) throw new Error('notebook restart completed without a selected environment')
      return {
        notebookId: restarted.id,
        environmentId: kernel.environmentId,
        backend: kernel.backend,
        ...kernel.kernelName === undefined ? {} : { kernelName: kernel.kernelName },
        generation: kernel.generation,
      }
    },
    ...genericPresentation,
  }))

  ctx.tools.register(defineTool({
    name: 'notebook_reload',
    description: 'Accept the current external .ipynb revision as the complete notebook snapshot after a write conflict.',
    parameters: {
      notebookId: { type: 'string', required: true },
    },
    output: boundedJsonOutput({
      notebookId: { type: 'string', required: true },
      fileVersion: { type: 'string', required: true },
    }, maxResultBytes),
    async execute(args, exec) {
      const target = requireNotebookTarget(exec, args.notebookId)
      const reloaded = await ctx.notebooks.reload(
        target.agent.session,
        target.notebookId,
        { initiator: 'agent', signal: exec.signal },
      )
      return {
        notebookId: reloaded.id,
        fileVersion: reloaded.fileVersion,
      }
    },
    ...genericPresentation,
  }))

  ctx.tools.register(defineTool({
    name: 'notebook_inspect',
    description: 'Inspect one kernel variable by name.',
    parameters: {
      notebookId: { type: 'string', required: true },
      name: { type: 'string', required: true },
    },
    output: passthroughTextOutput(),
    async execute(args, exec) {
      const target = requireNotebookTarget(exec, args.notebookId)
      return boundNotebookText(
        await ctx.notebooks.inspect(
          target.agent.session,
          target.notebookId,
          args.name,
          { initiator: 'agent', signal: exec.signal },
        ),
        maxResultBytes,
      )
    },
    ...genericPresentation,
  }))
}
