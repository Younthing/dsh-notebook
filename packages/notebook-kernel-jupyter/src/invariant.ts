/**
 * Package-owned invariant companion for `@younthing/dsh-notebook-kernel-jupyter`.
 * @module @younthing/dsh-notebook-kernel-jupyter/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@younthing/dsh-notebook-kernel-jupyter'

/** Cordis companion plugin name. */
export const name = 'notebook-kernel-jupyter-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the provider owns only private supervisor handles registered
 * through the notebook backend registry, and durable notebook state lives in the
 * owning session log validated by `@younthing/dsh-notebook-core`.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
