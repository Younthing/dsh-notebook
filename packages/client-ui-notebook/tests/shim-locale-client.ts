/**
 * ESM facade over the published `@deepseek-ai/dsh-client-locale/client`
 * ModuleLoader bundle: the bundle requires the runtime client bundle, so this
 * facade reuses the runtime shim's exports to keep one instance set.
 * @module @younthing/dsh-client-ui-notebook/tests/shim-locale-client
 */

import { loadClientBundle } from './client-module-loader.ts'
import { mod as runtimeMod } from './shim-runtime-client.ts'

const react = await import('react')
const jsxRuntime = await import('react/jsx-runtime')
const primitives = await import('@deepseek-ai/dsh-client-ui-primitives')

interface LocaleClientBundle {
  readonly apply: (context: unknown) => void
  readonly inject: readonly string[]
}

/** The locale client bundle's factory exports. */
export const mod = await loadClientBundle<LocaleClientBundle>(
  '@deepseek-ai/dsh-client-locale/client',
  {
    react,
    'react/jsx-runtime': jsxRuntime,
    '@deepseek-ai/dsh-client-ui-primitives': primitives,
    '@deepseek-ai/dsh-client-runtime/client': runtimeMod,
  },
)

export const apply = mod.apply
export const inject = mod.inject
