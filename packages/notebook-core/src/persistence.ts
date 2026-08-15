/**
 * Atomic `.ipynb` workspace loading, guarded creation, and versioned replacement.
 * @module @younthing/dsh-notebook-core/persistence
 */

import { FsError } from '@deepseek-ai/dsh-fs'
import type { FileSystem, FsTarget, FsVersion } from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { CellId } from './brand.ts'
import {
  createIpynb,
  IpynbFormatError,
  parseIpynb,
  serializeIpynb,
} from './ipynb.ts'
import type { IpynbDocument, IpynbJsonObject } from './ipynb.ts'
import type { NotebookPersistenceErrorCode } from './types.ts'

/** Failure raised before a notebook file mutation reaches the session log. */
export class NotebookPersistenceError extends Error {
  /** Machine-routable failure category. */
  readonly code: NotebookPersistenceErrorCode

  /**
   * @param message - precise path, limit, or validation failure.
   * @param code - stable failure category.
   * @param options - optional filesystem or codec cause.
   */
  constructor(message: string, code: NotebookPersistenceErrorCode, options?: ErrorOptions) {
    super(message, options)
    this.name = 'NotebookPersistenceError'
    this.code = code
  }
}

/** Inputs for resolving and loading one existing `.ipynb` file. */
export interface OpenIpynbFileRequest {
  /** Filesystem provider for the session execution world. */
  readonly fs: FileSystem
  /** User- or model-selected workspace path. */
  readonly path: string
  /** Optional session working directory for relative path resolution. */
  readonly cwd?: string
  /** Cancellation for resolve, containment, stat, and bounded read. */
  readonly signal: AbortSignal
  /** Inclusive maximum UTF-8 file size. */
  readonly maxDocumentBytes: number
}

/** Inputs for resolving and observing a `.ipynb` without creating an absent path. */
export interface PrepareIpynbFileRequest {
  /** Filesystem provider for the session execution world. */
  readonly fs: FileSystem
  /** User- or model-selected workspace path. */
  readonly path: string
  /** Optional session working directory for relative path resolution. */
  readonly cwd?: string
  /** Cancellation for resolve, stat, and bounded read. */
  readonly signal: AbortSignal
  /** Inclusive maximum UTF-8 file size. */
  readonly maxDocumentBytes: number
}

/** Stable observation used by strict open and guarded create requests. */
export interface PreparedIpynbFile {
  /** Normalized workspace-relative path safe to persist in a session event. */
  readonly path: string
  /** Process-local resolved target; callers must not persist its target key. */
  readonly target: FsTarget
  /** Existing stable file snapshot; absent means guarded creation is still required. */
  readonly existing?: {
    /** Strictly parsed nbformat-v4 document. */
    readonly document: IpynbDocument
    /** File version corresponding to the loaded content. */
    readonly version: FsVersion
    /** Complete encoded file size in bytes. */
    readonly byteLength: number
  }
}

/** Inputs for guarded creation of one previously observed absent target. */
export interface CreateIpynbFileRequest {
  /** Filesystem provider that produced {@link target}. */
  readonly fs: FileSystem
  /** Resolved target observed absent by {@link prepareIpynbFile}. */
  readonly target: FsTarget
  /** Cell identity for the canonical initial code cell. */
  readonly initialCellId: CellId
  /** Resolved policy applied to the guarded creation. */
  readonly sandboxPolicy: SandboxExecutionPolicy
  /** Cancellation before atomic publication. */
  readonly signal: AbortSignal
  /** Inclusive maximum serialized UTF-8 file size. */
  readonly maxDocumentBytes: number
}

/** Stable file snapshot returned by strict open or guarded creation. */
export interface OpenedIpynbFile {
  /** Process-local resolved target; callers must not persist its target key. */
  readonly target: FsTarget
  /** Strictly parsed nbformat-v4 document. */
  readonly document: IpynbDocument
  /** File version corresponding to the loaded or created content. */
  readonly version: FsVersion
  /** Whether this call created the absent path. */
  readonly created: boolean
  /** Complete encoded file size in bytes. */
  readonly byteLength: number
}

/** Inputs for one atomic version-guarded `.ipynb` replacement. */
export interface ReplaceIpynbFileRequest {
  /** Filesystem provider that produced {@link target}. */
  readonly fs: FileSystem
  /** Previously resolved target retained only in process memory. */
  readonly target: FsTarget
  /** Complete mutated document to serialize. */
  readonly document: IpynbDocument
  /** Version returned by the preceding open or replacement. */
  readonly version: FsVersion
  /** Resolved policy applied to the guarded replacement. */
  readonly sandboxPolicy: SandboxExecutionPolicy
  /** Cancellation before atomic publication. */
  readonly signal: AbortSignal
  /** Inclusive maximum serialized UTF-8 file size. */
  readonly maxDocumentBytes: number
}

/** Result of one successful guarded replacement. */
export interface ReplacedIpynbFile {
  /** Version produced by the atomic write. */
  readonly version: FsVersion
  /** Complete encoded file size in bytes. */
  readonly byteLength: number
}

/**
 * Resolve and load one existing workspace `.ipynb`. Absence is a typed refusal;
 * creation is owned by {@link createIpynbFile} after an explicit absent observation.
 * @param request - filesystem, workspace path, cancellation, and byte limit.
 * @returns parsed document, resolved target, and observed version.
 */
export async function openIpynbFile(request: OpenIpynbFileRequest): Promise<OpenedIpynbFile> {
  const prepared = await prepareIpynbFile(request)
  if (prepared.existing === undefined) {
    throw new NotebookPersistenceError(
      `notebook ${JSON.stringify(prepared.path)} does not exist`,
      'NOT_FOUND',
    )
  }
  return { target: prepared.target, ...prepared.existing, created: false }
}

/**
 * Resolve and observe a `.ipynb` without mutating an absent path. Existing
 * content is read behind a stable-version fence and parsed strictly.
 * @param request - filesystem, path, cancellation, and byte limit.
 * @returns resolved target plus an existing snapshot, when present.
 */
export async function prepareIpynbFile(request: PrepareIpynbFileRequest): Promise<PreparedIpynbFile> {
  request.signal.throwIfAborted()
  assertDocumentLimit(request.maxDocumentBytes)
  const path = normalizeWorkspaceNotebookPath(request.path)
  const resolveOptions = {
    ...request.cwd === undefined ? {} : { cwd: request.cwd },
    signal: request.signal,
  }
  const [root, target] = await Promise.all([
    request.fs.resolve('.', resolveOptions),
    request.fs.resolve(path, resolveOptions),
  ])
  if (!request.fs.contains(root, target)) {
    throw new NotebookPersistenceError(
      `notebook path is outside the workspace: ${JSON.stringify(path)}`,
      'OUTSIDE_WORKSPACE',
    )
  }
  const initial = await request.fs.stat(target, request.signal)
  if (initial === undefined) return { path, target }
  if (initial.type !== 'file') {
    throw new NotebookPersistenceError(
      `notebook path ${JSON.stringify(target.displayPath)} is not a regular file`,
      'NOT_REGULAR_FILE',
    )
  }
  if (initial.size !== undefined && initial.size > request.maxDocumentBytes) {
    throw tooLarge(target.displayPath, request.maxDocumentBytes)
  }

  let bytes: Uint8Array
  try {
    bytes = await request.fs.readBytes(target, request.signal, request.maxDocumentBytes)
  } catch (error: unknown) {
    throwTranslatedFsError(error, target.displayPath, request.maxDocumentBytes, 'read')
  }
  request.signal.throwIfAborted()
  const confirmed = await request.fs.stat(target, request.signal)
  if (confirmed === undefined || confirmed.type !== 'file' || confirmed.version !== initial.version) {
    throw new NotebookPersistenceError(
      `notebook ${JSON.stringify(target.displayPath)} changed while it was being read`,
      'WRITE_CONFLICT',
    )
  }
  const text = decodeUtf8(bytes, target.displayPath)
  request.signal.throwIfAborted()
  return {
    path,
    target,
    existing: {
      document: parseDocument(text, target.displayPath),
      version: confirmed.version,
      byteLength: bytes.byteLength,
    },
  }
}

/**
 * Guardedly create the canonical initial notebook after kernel startup. The
 * observed-absent target is never overwritten when another writer wins.
 * @param request - target, initial cell id, policy, cancellation, and byte limit.
 * @returns the created file snapshot.
 */
export async function createIpynbFile(request: CreateIpynbFileRequest): Promise<OpenedIpynbFile> {
  request.signal.throwIfAborted()
  assertDocumentLimit(request.maxDocumentBytes)
  return await createAbsentIpynb(request)
}

/**
 * Serialize and atomically replace one `.ipynb` only when its observed version
 * still matches. A stale or deleted target becomes `WRITE_CONFLICT`; it is
 * never recreated by this operation.
 * @param request - target, document, prior version, policy, cancellation, and byte limit.
 * @returns the new file version and serialized byte length.
 */
export async function replaceIpynbFile(request: ReplaceIpynbFileRequest): Promise<ReplacedIpynbFile> {
  request.signal.throwIfAborted()
  assertDocumentLimit(request.maxDocumentBytes)
  const serialized = serializeIpynb(request.document)
  const byteLength = encodedLength(serialized)
  if (byteLength > request.maxDocumentBytes) {
    throw tooLarge(request.target.displayPath, request.maxDocumentBytes)
  }
  try {
    const outcome = await request.fs.writeText(
      request.target,
      serialized,
      { kind: 'replaceIfVersion', version: request.version },
      request.signal,
      request.sandboxPolicy,
    )
    if (outcome.operation !== 'update') {
      throw new NotebookPersistenceError(
        `notebook ${JSON.stringify(request.target.displayPath)} disappeared before replacement`,
        'WRITE_CONFLICT',
      )
    }
    return { version: outcome.version, byteLength }
  } catch (error: unknown) {
    if (error instanceof NotebookPersistenceError) throw error
    throwTranslatedFsError(error, request.target.displayPath, request.maxDocumentBytes, 'replace')
  }
}

/**
 * Read the kernelspec name from validated notebook metadata. Absence of the
 * complete `kernelspec` object permits provider defaults; a present object must
 * contain a non-empty string name.
 * @param document - parsed nbformat-v4 document.
 * @returns kernelspec name, or `undefined` without kernelspec metadata.
 */
export function notebookKernelName(document: IpynbDocument): string | undefined {
  const kernelspec = document.metadata['kernelspec']
  if (kernelspec === undefined) return undefined
  if (!isJsonObject(kernelspec)) {
    throw new NotebookPersistenceError('notebook metadata.kernelspec must be an object', 'INVALID_DOCUMENT')
  }
  const name = kernelspec['name']
  if (typeof name !== 'string' || name.length === 0) {
    throw new NotebookPersistenceError(
      'notebook metadata.kernelspec.name must be a non-empty string',
      'INVALID_DOCUMENT',
    )
  }
  return name
}

async function createAbsentIpynb(
  request: CreateIpynbFileRequest,
): Promise<OpenedIpynbFile> {
  const { target } = request
  const document = createIpynb(request.initialCellId)
  const serialized = serializeIpynb(document)
  const byteLength = encodedLength(serialized)
  if (byteLength > request.maxDocumentBytes) throw tooLarge(target.displayPath, request.maxDocumentBytes)
  try {
    const outcome = await request.fs.writeText(
      target,
      serialized,
      { kind: 'createIfAbsent' },
      request.signal,
      request.sandboxPolicy,
    )
    if (outcome.operation !== 'create') {
      throw new NotebookPersistenceError(
        `notebook ${JSON.stringify(target.displayPath)} appeared before guarded creation`,
        'ALREADY_EXISTS',
      )
    }
    return {
      target,
      document,
      version: outcome.version,
      created: true,
      byteLength,
    }
  } catch (error: unknown) {
    if (error instanceof NotebookPersistenceError) throw error
    throwTranslatedFsError(error, target.displayPath, request.maxDocumentBytes, 'create')
  }
}

function assertIpynbExtension(path: string): void {
  if (!path.toLowerCase().endsWith('.ipynb')) {
    throw new NotebookPersistenceError(
      `notebook path must end with .ipynb: ${JSON.stringify(path)}`,
      'INVALID_EXTENSION',
    )
  }
}

/**
 * Normalize one portable workspace-relative notebook path before filesystem resolution.
 * @param value - caller-selected path using POSIX or Windows separators.
 * @returns a POSIX path with non-empty ordinary segments and a `.ipynb` suffix.
 */
export function normalizeWorkspaceNotebookPath(value: string): string {
  const path = value.replaceAll('\\', '/')
  if (
    path.length === 0
    || path.startsWith('/')
    || /^[a-z]:/i.test(path)
    || path.includes('\0')
    || path.split('/').some(segment => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new NotebookPersistenceError(
      `notebook path must be workspace-relative without empty, dot, or parent segments: ${JSON.stringify(value)}`,
      'INVALID_PATH',
    )
  }
  assertIpynbExtension(path)
  return path
}

function assertDocumentLimit(maxDocumentBytes: number): void {
  if (!Number.isSafeInteger(maxDocumentBytes) || maxDocumentBytes < 1) {
    throw new NotebookPersistenceError(
      'maxDocumentBytes must be a positive safe integer',
      'INVALID_LIMIT',
    )
  }
}

function encodedLength(text: string): number {
  return new TextEncoder().encode(text).byteLength
}

function decodeUtf8(bytes: Uint8Array, path: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error: unknown) {
    throw new NotebookPersistenceError(
      `notebook ${JSON.stringify(path)} is not valid UTF-8`,
      'INVALID_UTF8',
      { cause: error },
    )
  }
}

function parseDocument(text: string, path: string): IpynbDocument {
  try {
    return parseIpynb(text)
  } catch (error: unknown) {
    if (!(error instanceof IpynbFormatError)) throw error
    throw new NotebookPersistenceError(
      `invalid notebook ${JSON.stringify(path)}: ${error.message}`,
      'INVALID_DOCUMENT',
      { cause: error },
    )
  }
}

function tooLarge(path: string, maxDocumentBytes: number): NotebookPersistenceError {
  return new NotebookPersistenceError(
    `notebook ${JSON.stringify(path)} exceeds maxDocumentBytes (${String(maxDocumentBytes)})`,
    'DOCUMENT_TOO_LARGE',
  )
}

function throwTranslatedFsError(
  error: unknown,
  path: string,
  maxDocumentBytes: number,
  operation: 'create' | 'read' | 'replace',
): never {
  if (!(error instanceof FsError)) throw error
  switch (error.code) {
    case 'FS_TOO_LARGE':
      throw tooLarge(path, maxDocumentBytes)
    case 'FS_NOT_REGULAR_FILE':
      throw new NotebookPersistenceError(
        `notebook path ${JSON.stringify(path)} is not a regular file`,
        'NOT_REGULAR_FILE',
        { cause: error },
      )
    case 'FS_NOT_OBSERVED':
      throw new NotebookPersistenceError(
        `notebook ${JSON.stringify(path)} already exists`,
        'ALREADY_EXISTS',
        { cause: error },
      )
    case 'FS_STALE_VERSION':
      throw new NotebookPersistenceError(
        `notebook ${JSON.stringify(path)} changed before guarded ${operation}`,
        'WRITE_CONFLICT',
        { cause: error },
      )
    case 'FS_NOT_FOUND':
      if (operation === 'read' || operation === 'replace') {
        throw new NotebookPersistenceError(
          `notebook ${JSON.stringify(path)} disappeared before guarded ${operation}`,
          'WRITE_CONFLICT',
          { cause: error },
        )
      }
      throw error
    default:
      throw error
  }
}

function isJsonObject(value: unknown): value is IpynbJsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
