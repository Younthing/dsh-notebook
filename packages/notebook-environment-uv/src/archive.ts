/** Pinned uv release archives and verified extraction helpers. */

import { createHash, randomBytes } from 'node:crypto'
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { gunzipSync, unzipSync } from 'fflate'

/** Pinned private uv version. */
export const PRIVATE_UV_VERSION = '0.11.32'

/** One supported official release archive. */
export interface UvArchive {
  /** GitHub release asset filename. */
  readonly filename: string
  /** Committed SHA-256 from the official release checksum asset. */
  readonly sha256: string
  /** Archive encoding. */
  readonly format: 'tar.gz' | 'zip'
  /** Executable filename after extraction. */
  readonly executableName: 'uv' | 'uv.exe'
}

const ARCHIVES: Readonly<Record<string, UvArchive>> = {
  'darwin-arm64': {
    filename: 'uv-aarch64-apple-darwin.tar.gz',
    sha256: 'ed336d0ba49db8ef89b2b41fffa372ce63bd032f22a56f001c265891aec32829',
    format: 'tar.gz',
    executableName: 'uv',
  },
  'darwin-x64': {
    filename: 'uv-x86_64-apple-darwin.tar.gz',
    sha256: '77f5ca26c0de20e992a3677a174fe1121ee25c36f9b1434a863f75bf077a05eb',
    format: 'tar.gz',
    executableName: 'uv',
  },
  'win32-arm64': {
    filename: 'uv-aarch64-pc-windows-msvc.zip',
    sha256: 'a7427ea0440bb826b6716d1837ff3d173b8e7d496cb09ee8f456b4e023a2fdcd',
    format: 'zip',
    executableName: 'uv.exe',
  },
  'win32-x64': {
    filename: 'uv-x86_64-pc-windows-msvc.zip',
    sha256: 'acfde570451cfdb8689fa159a138ee805ba4e241c466432750302c86254b0984',
    format: 'zip',
    executableName: 'uv.exe',
  },
  'linux-arm64-gnu': {
    filename: 'uv-aarch64-unknown-linux-gnu.tar.gz',
    sha256: '4d4fa08d95b06642e5800df6a22bd71455f23f988269e18da2847971d8c0bf31',
    format: 'tar.gz',
    executableName: 'uv',
  },
  'linux-x64-gnu': {
    filename: 'uv-x86_64-unknown-linux-gnu.tar.gz',
    sha256: 'aab924fd522efd06f1c5f3b93a243864fc453132c94b2dc49f1371b528a4b967',
    format: 'tar.gz',
    executableName: 'uv',
  },
  'linux-arm64-musl': {
    filename: 'uv-aarch64-unknown-linux-musl.tar.gz',
    sha256: 'd70cdae687feb6aad9a09fe8d686df8c8efaf69a1007fa581379a2025adc10a5',
    format: 'tar.gz',
    executableName: 'uv',
  },
  'linux-x64-musl': {
    filename: 'uv-x86_64-unknown-linux-musl.tar.gz',
    sha256: '1fd052f196108d87e61fc3d98fe06b4ec758c9a1eb1466a6fd1a436fe45885f2',
    format: 'tar.gz',
    executableName: 'uv',
  },
}

const MAX_EXECUTABLE_BYTES = 128 * 1024 * 1024
const RELEASE_BASE = `https://github.com/astral-sh/uv/releases/download/${PRIVATE_UV_VERSION}`

/**
 * Resolve an official archive from explicit platform facts.
 * @param platform - Node platform identifier.
 * @param arch - Node CPU architecture identifier.
 * @param glibcVersionRuntime - glibc version when Linux uses glibc; omitted for musl.
 * @returns the matching pinned release archive, or `undefined` for an unsupported target.
 */
export function uvArchiveForPlatform(
  platform: NodeJS.Platform,
  arch: string,
  glibcVersionRuntime?: string,
): UvArchive | undefined {
  let key = `${platform}-${arch}`
  if (platform === 'linux') {
    const libc = glibcVersionRuntime === undefined ? 'musl' : 'gnu'
    key = `${key}-${libc}`
  }
  return ARCHIVES[key]
}

/**
 * Resolve the official archive for the running platform.
 * @returns the matching pinned release archive, or `undefined` when unsupported.
 */
/* v8 ignore start -- thin OS report binding; uvArchiveForPlatform exercises the complete selection table. */
export function currentUvArchive(): UvArchive | undefined {
  const report = process.platform === 'linux'
    ? process.report.getReport() as { readonly header?: { readonly glibcVersionRuntime?: string } }
    : undefined
  return uvArchiveForPlatform(process.platform, process.arch, report?.header?.glibcVersionRuntime)
}
/* v8 ignore stop */

/**
 * Return the content-addressed private executable location for one archive.
 * @param dshHome - resolved Harness home directory.
 * @param archive - selected pinned archive.
 * @returns absolute private uv executable path.
 */
export function privateUvExecutable(dshHome: string, archive: UvArchive): string {
  return join(dshHome, 'tools', 'uv', PRIVATE_UV_VERSION, archive.sha256, archive.executableName)
}

/**
 * Download one fixed official archive while enforcing the complete byte cap.
 * @param archive - selected pinned archive.
 * @param maxBytes - maximum accepted compressed response bytes.
 * @param signal - cancellation for the complete download.
 * @returns checksum-verified compressed archive bytes.
 */
export async function downloadUvArchive(
  archive: UvArchive,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  signal.throwIfAborted()
  const response = await fetch(`${RELEASE_BASE}/${archive.filename}`, { signal, redirect: 'follow' })
  if (!response.ok || response.body === null) throw new Error(`uv archive download returned HTTP ${response.status}`)
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('uv archive exceeds the configured download limit')
  const chunks: Uint8Array[] = []
  let total = 0
  const reader = response.body.getReader()
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > maxBytes) {
        await reader.cancel('uv archive exceeds the configured download limit')
        throw new Error('uv archive exceeds the configured download limit')
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  if (total === 0) throw new Error('uv archive download was empty')
  const complete = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    complete.set(chunk, offset)
    offset += chunk.byteLength
  }
  const digest = createHash('sha256').update(complete).digest('hex')
  if (digest !== archive.sha256) throw new Error('uv archive SHA-256 did not match the committed release checksum')
  return complete
}

/**
 * Extract only the uv executable from a checksum-verified release archive.
 * @param archive - selected pinned archive and encoding.
 * @param compressed - checksum-verified compressed bytes.
 * @returns extracted uv executable bytes.
 */
export function extractUvExecutable(archive: UvArchive, compressed: Uint8Array): Uint8Array {
  const executable = archive.format === 'zip'
    ? extractZipExecutable(archive, compressed)
    : extractTarExecutable(archive, gunzipSync(compressed))
  /* v8 ignore next -- the zero-size arm is covered; allocating a 128 MiB fixture would make this unit test itself unsafe. */
  if (executable.byteLength === 0 || executable.byteLength > MAX_EXECUTABLE_BYTES) {
    throw new Error('uv executable has an invalid size')
  }
  return executable
}

function extractZipExecutable(archive: UvArchive, compressed: Uint8Array): Uint8Array {
  const entries = unzipSync(compressed)
  const suffix = `/${archive.executableName}`
  const matches = Object.entries(entries).filter(([name]) =>
    !name.includes('\\') && !name.split('/').includes('..') && name.endsWith(suffix))
  if (matches.length !== 1) throw new Error('uv archive does not contain exactly one expected executable')
  const match = matches[0]
  if (match === undefined) throw new Error('uv archive executable disappeared after validation')
  return match[1]
}

function extractTarExecutable(archive: UvArchive, tar: Uint8Array): Uint8Array {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const matches: Uint8Array[] = []
  for (let offset = 0; offset + 512 <= tar.byteLength;) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break
    const name = nulTerminated(decoder, header.subarray(0, 100))
    const sizeText = nulTerminated(decoder, header.subarray(124, 136)).trim()
    if (!/^[0-7]+$/.test(sizeText)) throw new Error('uv tar archive contains an invalid entry size')
    const size = Number.parseInt(sizeText, 8)
    if (size > MAX_EXECUTABLE_BYTES) {
      throw new Error('uv tar archive contains an oversized entry')
    }
    const start = offset + 512
    const end = start + size
    if (end > tar.byteLength) throw new Error('uv tar archive contains a truncated entry')
    if (!name.includes('\\') && !name.split('/').includes('..') && name.endsWith(`/${archive.executableName}`)) {
      matches.push(tar.slice(start, end))
    }
    offset = start + Math.ceil(size / 512) * 512
  }
  if (matches.length !== 1) throw new Error('uv archive does not contain exactly one expected executable')
  const match = matches[0]
  if (match === undefined) throw new Error('uv archive executable disappeared after validation')
  return match
}

function nulTerminated(decoder: TextDecoder, bytes: Uint8Array): string {
  const end = bytes.indexOf(0)
  return decoder.decode(end === -1 ? bytes : bytes.subarray(0, end))
}

/**
 * Publish an executable through a random exclusive sibling and atomic rename.
 * @param target - final content-addressed executable path.
 * @param executable - verified executable bytes.
 */
export async function publishUvExecutable(target: string, executable: Uint8Array): Promise<void> {
  await mkdir(dirname(target), { recursive: true, mode: 0o700 })
  const staging = `${target}.${randomBytes(8).toString('hex')}.tmp`
  try {
    await writeFile(staging, executable, { flag: 'wx', mode: 0o700 })
    /* v8 ignore next -- Windows skips chmod; POSIX build lanes exercise the executable-mode peer. */
    if (process.platform !== 'win32') await chmod(staging, 0o700)
    await rename(staging, target)
  } catch (error) {
    await rm(staging, { force: true })
    throw error
  }
}
