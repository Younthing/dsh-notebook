/** Package-owned invariant companion for the static Notebook bundle. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-notebook'

/** Cordis companion plugin name. */
export const name = 'notebook-bundle-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

const install: InvariantInstaller = () => {}

/** Register the static bundle package. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
