/**
 * Snapshot fixture plugin registering MemoryKernelBackend for notebook overlay scenarios.
 * @module test-notebook-memory-backend
 */

import type { Context } from '@deepseek-ai/cordis'
import { MemoryKernelBackend } from '@younthing/dsh-notebook'

/** Cordis plugin name. */
export const name = 'test-notebook-memory-backend'
/** Notebook registry required before backend registration. */
export const inject = ['notebooks']

/** Register the in-process memory kernel for ACP snapshot compositions. */
export function apply(ctx: Context): void {
  ctx.notebooks.registerBackend(new MemoryKernelBackend())
}
