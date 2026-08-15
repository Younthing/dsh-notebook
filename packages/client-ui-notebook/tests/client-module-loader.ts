/**
 * Vitest bridge for Harness client packages whose published `/client` entries
 * are ModuleLoader handoff bundles: the artifact evaluates
 * `window.__ModuleLoader__.load({ id, factory })` and exposes no ESM exports,
 * so Vitest named imports cannot consume it directly. This helper installs
 * the capture point, imports the real bundle file, runs its factory with a
 * module table that shares the same React / Cordis / slot instances as the
 * test process, and returns the factory's exports object.
 * @module @younthing/dsh-client-ui-notebook/tests/client-module-loader
 */

import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

/** One browser plugin handoff as the Web shell's ModuleLoader receives it. */
interface ModuleLoaderHandoff {
  readonly id: string
  readonly factory: (require: (specifier: string) => unknown) => Record<string, unknown>
}

declare global {
  interface Window {
    __ModuleLoader__?: { load(handoff: ModuleLoaderHandoff): void }
  }
}

/** Captured handoffs keyed by plugin id (the package name). */
const captured = new Map<string, ModuleLoaderHandoff>()

/** Install the browser ModuleLoader capture point once per test process. */
export function installModuleLoader(): void {
  if (typeof window !== 'undefined' && window.__ModuleLoader__ === undefined) {
    window.__ModuleLoader__ = { load: handoff => { captured.set(handoff.id, handoff) } }
  }
}

installModuleLoader()

const nativeRequire = createRequire(import.meta.url)

/** Module table handed to a bundle factory: specifier → shared test instance. */
export type ClientBundleModules = Record<string, unknown>

/** Map a package subpath (`@scope/name/sub`) to its plugin id (`@scope/name`). */
function pluginIdOf(specifier: string): string {
  const segments = specifier.split('/')
  return segments.length >= 3 ? `${segments[0]}/${segments[1]}` : specifier
}

/**
 * Load one ModuleLoader bundle and return the exports its factory produces.
 * @param specifier - package subpath whose exports map points at the bundle.
 * @param modules - shared platform modules (react, cordis, slots, runtime)
 * the factory's `require` must resolve to the same instances the test uses.
 * @returns the bundle factory's exports object.
 */
export async function loadClientBundle<T extends Record<string, unknown>>(
  specifier: string,
  modules: ClientBundleModules = {},
): Promise<T> {
  installModuleLoader()
  const resolved = nativeRequire.resolve(specifier)
  await import(pathToFileURL(resolved).href)
  const handoff = captured.get(pluginIdOf(specifier))
  if (handoff === undefined) {
    throw new Error(`client bundle "${specifier}" did not hand off to window.__ModuleLoader__`)
  }
  return handoff.factory(specifier => {
    if (Object.hasOwn(modules, specifier)) return modules[specifier]
    return nativeRequire(specifier)
  }) as T
}
