/**
 * Snapshot-only local filesystem whose opaque versions are content-derived.
 * Real local I/O, sandbox checks, and atomic guarded writes remain in the
 * production provider; deterministic versions keep the cross-platform ACP
 * fixture independent of inode and timestamp encodings.
 * @module notebook-snapshot-fs
 */

import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { FsError, FsVersion } from '@deepseek-ai/dsh-fs'
import type {
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsTarget,
  FsVersion as FsVersionType,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'

/** Cordis plugin name. */
export const name = 'notebook-snapshot-fs'
/** Sandbox policy required by the production filesystem implementation. */
export const inject = ['sandboxPolicy']

const MAX_SNAPSHOT_FILE_BYTES = 256 * 1024 * 1024

class NotebookSnapshotFileSystem extends SandboxedFileSystem {
  private readonly nativeVersions = new Map<string, FsVersionType>()

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    const info = await super.stat(target, signal)
    if (info === undefined || info.type !== 'file') return info
    const bytes = await super.readBytes(target, signal, MAX_SNAPSHOT_FILE_BYTES)
    const version = contentVersion(bytes)
    this.nativeVersions.set(versionKey(target, version), info.version)
    return { ...info, version }
  }

  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome> {
    const nativeExpected = await this.nativeWriteIntent(target, expected, signal)
    const outcome = await super.writeText(target, content, nativeExpected, signal, sandboxPolicy)
    const version = contentVersion(new TextEncoder().encode(content))
    this.nativeVersions.set(versionKey(target, version), outcome.version)
    return { ...outcome, version }
  }

  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersionType },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsEditOutcome> {
    const native = expected === undefined
      ? undefined
      : { version: await this.nativeVersion(target, expected.version, signal) }
    const outcome = await super.editText(target, edit, native, signal, sandboxPolicy)
    const version = contentVersion(new TextEncoder().encode(outcome.after))
    this.nativeVersions.set(versionKey(target, version), outcome.version)
    return { ...outcome, version }
  }

  private async nativeWriteIntent(
    target: FsTarget,
    expected: FsWriteIntent | undefined,
    signal: AbortSignal | undefined,
  ): Promise<FsWriteIntent | undefined> {
    if (expected?.kind !== 'replaceIfVersion') return expected
    return {
      kind: 'replaceIfVersion',
      version: await this.nativeVersion(target, expected.version, signal),
    }
  }

  private async nativeVersion(
    target: FsTarget,
    version: FsVersionType,
    signal: AbortSignal | undefined,
  ): Promise<FsVersionType> {
    await this.stat(target, signal)
    const native = this.nativeVersions.get(versionKey(target, version))
    if (native === undefined) {
      throw new FsError(`cannot mutate "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
    }
    return native
  }
}

/** Register the deterministic-version sandbox filesystem for one snapshot app. */
export function apply(ctx: Context): void {
  new NotebookSnapshotFileSystem(ctx, {
    cwd: process.cwd(),
    diffBasisMaxBytes: 10 * 1024 * 1024,
  })
}

function contentVersion(bytes: Uint8Array): FsVersionType {
  return FsVersion(`sha256:${createHash('sha256').update(bytes).digest('hex')}`)
}

function versionKey(target: FsTarget, version: FsVersionType): string {
  return `${String(target.targetKey)}\0${String(version)}`
}
