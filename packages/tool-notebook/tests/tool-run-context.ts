import { CallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecutionToken, ToolRunContext } from '@deepseek-ai/dsh-tools'

/** Build one complete tool-body context for direct ToolDefinition tests. */
export function toolRunContext(agent: Agent): ToolRunContext {
  const callId = CallId('tool-notebook-test')
  return {
    agent,
    signal: new AbortController().signal,
    token: Symbol('tool-notebook-test') as ToolExecutionToken,
    callId,
    rootCallId: callId,
    name: 'notebook-test',
    arguments: {},
    deferContext() {},
    concludeTurn() {},
  }
}
