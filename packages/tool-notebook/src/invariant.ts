/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-tool-notebook`.
 * @module @deepseek-ai/dsh-tool-notebook/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-tool-notebook'

/** Cordis companion plugin name. */
export const name = 'tool-notebook-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: tool registration is ephemeral registry state and durable
 * notebook facts are validated by `@deepseek-ai/dsh-notebook-core`.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
