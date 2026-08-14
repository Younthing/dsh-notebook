/** Package-owned invariant companion for `@deepseek-ai/dsh-notebook-environment-uv`. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-notebook-environment-uv'

/** Cordis companion plugin name. */
export const name = 'notebook-environment-uv-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: environment ownership is validated from the versioned sidecar on every
 * catalog, provision, and launch resolution; no independent registry or durable cache exists.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
