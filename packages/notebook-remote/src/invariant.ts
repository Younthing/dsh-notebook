/** Package-owned Notebook Remote composition invariant. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type {} from './index.ts'

const PACKAGE_NAME = '@younthing/dsh-notebook-remote'

/** Cordis invariant-companion plugin name. */
export const name = 'notebook-remote-invariant'
/** Service required before registering the package check. */
export const inject = ['invariants']

const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  if (ctx.get('notebookRemote') === undefined) fail('notebook Remote service is not mounted')
}, { inject: ['notebookRemote'] })

/** Register the Notebook Remote composition check. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
