/**
 * Test-only Cordis plugin registering MemoryKernelBackend.
 * @module test-notebook-memory-backend
 */

import type { Context } from '@deepseek-ai/cordis'
import { MemoryKernelBackend } from '@deepseek-ai/dsh-notebook-core'

/** Cordis plugin name. */
export const name = 'test-notebook-memory-backend'
/** Notebook registry required before backend registration. */
export const inject = ['notebooks']

/** Register the in-process memory kernel for loader compositions. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.notebooks.registerBackend(new MemoryKernelBackend()))
}
