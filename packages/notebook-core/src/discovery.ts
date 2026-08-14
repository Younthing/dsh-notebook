/** Bounded `.ipynb` discovery over the filesystem capability. */

import { FsError } from '@deepseek-ai/dsh-fs'
import type { FileSystem, FsDirEntry, FsTarget } from '@deepseek-ai/dsh-fs'
import type {
  NotebookDiscoveryEntry,
  NotebookDiscoveryOptions,
  NotebookDiscoveryPage,
} from './types.ts'

/** Validated discovery limits owned by {@link NotebookService}. */
export interface NotebookDiscoveryConfig {
  /** Maximum files returned by one page. */
  readonly pageSize: number
  /** Maximum directory depth below the workspace root. */
  readonly maxDepth: number
  /** Maximum directory entries examined by one request. */
  readonly maxEntries: number
  /** Directory basenames pruned at every depth. */
  readonly excludeDirectoryNames: ReadonlySet<string>
}

/** Internal discovery refusal translated to the public Notebook error taxonomy. */
export class NotebookDiscoveryError extends Error {
  /**
   * @param message - actionable discovery failure.
   * @param code - stable service error category.
   */
  constructor(
    message: string,
    readonly code: 'DISCOVERY_CURSOR_STALE' | 'DISCOVERY_UNAVAILABLE',
  ) {
    super(message)
    this.name = 'NotebookDiscoveryError'
  }
}

/**
 * Discover one stable traversal page without opening or decoding file content.
 * Canonical targets outside `cwd` are skipped, while canonical aliases and
 * directory cycles contribute at most once.
 * @param fs - filesystem provider used for root resolution and metadata listing.
 * @param cwd - workspace root; omission uses the provider's configured cwd.
 * @param config - validated page, depth, and prune limits.
 * @param options - continuation path and cancellation.
 * @returns one bounded page in deterministic depth-first name order.
 */
export async function discoverNotebookFiles(
  fs: FileSystem,
  cwd: string | undefined,
  config: NotebookDiscoveryConfig,
  options: NotebookDiscoveryOptions = {},
): Promise<NotebookDiscoveryPage> {
  const signal = options.signal
  signal?.throwIfAborted()
  let root: FsTarget
  try {
    root = await fs.resolve('.', { ...cwd === undefined ? {} : { cwd }, ...signal === undefined ? {} : { signal } })
    const info = await fs.stat(root, signal)
    if (info === undefined || info.type !== 'directory') {
      throw new NotebookDiscoveryError('notebook discovery root is not an existing directory', 'DISCOVERY_UNAVAILABLE')
    }
  } catch (error: unknown) {
    if (signal?.aborted === true) throw error
    if (error instanceof NotebookDiscoveryError) throw error
    throw new NotebookDiscoveryError(`notebook discovery root is unavailable: ${errorText(error)}`, 'DISCOVERY_UNAVAILABLE')
  }

  const seenDirectories = new Set<string>([String(root.targetKey)])
  const seenFiles = new Set<string>()
  const collected: NotebookDiscoveryEntry[] = []
  let afterSeen = options.after === undefined
  let partial = false
  let stopped = false
  let entriesSeen = 0

  const visit = async (directory: FsTarget, prefix: string, depth: number): Promise<void> => {
    signal?.throwIfAborted()
    let entries: readonly FsDirEntry[]
    try {
      entries = [...await fs.listDir(directory, signal)]
        .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
    } catch (error: unknown) {
      if (signal?.aborted === true) throw error
      if (depth === 0 || !(error instanceof FsError)) {
        throw new NotebookDiscoveryError(
          `notebook discovery cannot list ${JSON.stringify(prefix || '.')}: ${errorText(error)}`,
          'DISCOVERY_UNAVAILABLE',
        )
      }
      partial = true
      return
    }

    for (const entry of entries) {
      if (stopped) return
      signal?.throwIfAborted()
      entriesSeen += 1
      if (entriesSeen > config.maxEntries) {
        partial = true
        stopped = true
        return
      }
      if (!portableSegment(entry.name)) {
        partial = true
        continue
      }
      if (!fs.contains(root, entry.target)) continue
      const path = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`
      if (entry.type === 'directory') {
        if (config.excludeDirectoryNames.has(entry.name.toLowerCase())) continue
        const key = String(entry.target.targetKey)
        if (seenDirectories.has(key)) continue
        seenDirectories.add(key)
        if (depth >= config.maxDepth) {
          partial = true
          continue
        }
        await visit(entry.target, path, depth + 1)
        continue
      }
      if (entry.type !== 'file' || !path.toLowerCase().endsWith('.ipynb')) continue
      const key = String(entry.target.targetKey)
      if (seenFiles.has(key)) continue
      seenFiles.add(key)
      if (!afterSeen) {
        if (path === options.after) afterSeen = true
        continue
      }
      collected.push({ path, ...entry.size === undefined ? {} : { size: entry.size } })
      if (collected.length > config.pageSize) stopped = true
    }
  }

  await visit(root, '', 0)
  if (!afterSeen) {
    throw new NotebookDiscoveryError(
      `notebook discovery continuation ${JSON.stringify(options.after)} is stale`,
      'DISCOVERY_CURSOR_STALE',
    )
  }
  const hasMore = collected.length > config.pageSize
  const items = collected.slice(0, config.pageSize)
  const nextAfter = hasMore ? items.at(-1)?.path : undefined
  return {
    items,
    ...(nextAfter === undefined ? {} : { nextAfter }),
    partial,
  }
}

function portableSegment(value: string): boolean {
  return value.length > 0 && value !== '.' && value !== '..' && !value.includes('/') && !value.includes('\\')
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : String(error)
}
