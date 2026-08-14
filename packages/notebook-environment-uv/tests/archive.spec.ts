import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync, zipSync } from 'fflate'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  downloadUvArchive,
  extractUvExecutable,
  privateUvExecutable,
  PRIVATE_UV_VERSION,
  publishUvExecutable,
  type UvArchive,
  uvArchiveForPlatform,
} from '../src/archive.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function fixtureArchive(
  format: UvArchive['format'],
  executableName: UvArchive['executableName'],
  sha256 = '0'.repeat(64),
): UvArchive {
  return { filename: `fixture.${format}`, sha256, format, executableName }
}

function tarFile(name: string, body: Uint8Array): Uint8Array {
  const header = new Uint8Array(512)
  const encoder = new TextEncoder()
  header.set(encoder.encode(name), 0)
  header.set(encoder.encode(`${body.byteLength.toString(8).padStart(11, '0')}\0`), 124)
  header[156] = '0'.charCodeAt(0)
  const result = new Uint8Array(512 + Math.ceil(body.byteLength / 512) * 512 + 1024)
  result.set(header)
  result.set(body, 512)
  return result
}

describe('pinned uv archive handling', () => {
  it('selects every committed platform archive without guessing unsupported targets', () => {
    expect(uvArchiveForPlatform('darwin', 'arm64')?.filename).toBe('uv-aarch64-apple-darwin.tar.gz')
    expect(uvArchiveForPlatform('darwin', 'x64')?.filename).toBe('uv-x86_64-apple-darwin.tar.gz')
    expect(uvArchiveForPlatform('win32', 'arm64')?.filename).toBe('uv-aarch64-pc-windows-msvc.zip')
    expect(uvArchiveForPlatform('win32', 'x64')?.filename).toBe('uv-x86_64-pc-windows-msvc.zip')
    expect(uvArchiveForPlatform('linux', 'arm64', '2.39')?.filename).toBe('uv-aarch64-unknown-linux-gnu.tar.gz')
    expect(uvArchiveForPlatform('linux', 'x64', '2.39')?.filename).toBe('uv-x86_64-unknown-linux-gnu.tar.gz')
    expect(uvArchiveForPlatform('linux', 'arm64')?.filename).toBe('uv-aarch64-unknown-linux-musl.tar.gz')
    expect(uvArchiveForPlatform('linux', 'x64')?.filename).toBe('uv-x86_64-unknown-linux-musl.tar.gz')
    expect(uvArchiveForPlatform('freebsd', 'x64')).toBeUndefined()
  })

  it('extracts the single expected executable from zip and tar.gz archives', () => {
    const windowsUv = new TextEncoder().encode('windows uv')
    const unixUv = new TextEncoder().encode('unix uv')

    expect(extractUvExecutable(
      fixtureArchive('zip', 'uv.exe'),
      zipSync({ 'uv-fixture/uv.exe': windowsUv }),
    )).toEqual(windowsUv)
    expect(extractUvExecutable(
      fixtureArchive('tar.gz', 'uv'),
      gzipSync(tarFile('uv-fixture/uv', unixUv)),
    )).toEqual(unixUv)
  })

  it('rejects traversal and ambiguous executable entries', () => {
    const executable = new TextEncoder().encode('uv')
    expect(() => extractUvExecutable(
      fixtureArchive('zip', 'uv.exe'),
      zipSync({ '../uv.exe': executable }),
    )).toThrow('exactly one expected executable')
    expect(() => extractUvExecutable(
      fixtureArchive('zip', 'uv.exe'),
      zipSync({ 'one/uv.exe': executable, 'two/uv.exe': executable }),
    )).toThrow('exactly one expected executable')
    expect(() => extractUvExecutable(
      fixtureArchive('zip', 'uv.exe'),
      zipSync({ 'folder\\uv.exe': executable }),
    )).toThrow('exactly one expected executable')
    expect(() => extractUvExecutable(
      fixtureArchive('zip', 'uv.exe'),
      zipSync({ 'folder/uv.exe': new Uint8Array() }),
    )).toThrow('invalid size')
  })

  it('rejects malformed tar entries before reading executable bytes', () => {
    const invalidSize = tarFile('uv-fixture/uv', new Uint8Array([1]))
    invalidSize.fill('x'.charCodeAt(0), 124, 136)
    expect(() => extractUvExecutable(
      fixtureArchive('tar.gz', 'uv'),
      gzipSync(invalidSize),
    )).toThrow('invalid entry size')

    const oversized = tarFile('uv-fixture/uv', new Uint8Array())
    oversized.set(new TextEncoder().encode(`${(128 * 1024 * 1024 + 1).toString(8).padStart(11, '0')}\0`), 124)
    expect(() => extractUvExecutable(
      fixtureArchive('tar.gz', 'uv'),
      gzipSync(oversized),
    )).toThrow('oversized entry')

    const truncated = tarFile('uv-fixture/uv', new Uint8Array([1]))
    truncated.set(new TextEncoder().encode('00000002000\0'), 124)
    expect(() => extractUvExecutable(
      fixtureArchive('tar.gz', 'uv'),
      gzipSync(truncated.subarray(0, 1024)),
    )).toThrow('truncated entry')

    for (const name of ['uv-fixture\\uv', '../uv', 'uv-fixture/other', 'x'.repeat(100)]) {
      expect(() => extractUvExecutable(
        fixtureArchive('tar.gz', 'uv'),
        gzipSync(tarFile(name, new Uint8Array([1]))),
      )).toThrow('exactly one expected executable')
    }
  })

  it('verifies the complete download checksum and byte cap', async () => {
    const body = new TextEncoder().encode('verified archive')
    const archive = fixtureArchive(
      'zip',
      'uv.exe',
      createHash('sha256').update(body).digest('hex'),
    )
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, {
      status: 200,
      headers: { 'content-length': String(body.byteLength) },
    })))

    await expect(downloadUvArchive(archive, body.byteLength, new AbortController().signal)).resolves.toEqual(body)
    await expect(downloadUvArchive(archive, body.byteLength - 1, new AbortController().signal))
      .rejects.toThrow('download limit')

    const badArchive = { ...archive, sha256: 'f'.repeat(64) }
    await expect(downloadUvArchive(badArchive, body.byteLength, new AbortController().signal))
      .rejects.toThrow('SHA-256')
  })

  it('rejects HTTP failures, empty bodies, streaming overflow, and prior cancellation', async () => {
    const archive = fixtureArchive('zip', 'uv.exe')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }))
    await expect(downloadUvArchive(archive, 64, new AbortController().signal)).rejects.toThrow('HTTP 503')

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }))
    await expect(downloadUvArchive(archive, 64, new AbortController().signal)).rejects.toThrow('HTTP 200')

    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array(), {
      status: 200,
      headers: { 'content-length': 'invalid' },
    }))
    await expect(downloadUvArchive(archive, 64, new AbortController().signal)).rejects.toThrow('empty')

    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }))
    await expect(downloadUvArchive(archive, 3, new AbortController().signal)).rejects.toThrow('download limit')

    const controller = new AbortController()
    controller.abort(new Error('cancelled before download'))
    await expect(downloadUvArchive(archive, 64, controller.signal)).rejects.toThrow('cancelled before download')
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('publishes only the final content-addressed executable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-notebook-uv-publish-'))
    temporaryDirectories.push(root)
    const archive = fixtureArchive('zip', 'uv.exe', 'a'.repeat(64))
    const target = privateUvExecutable(root, archive)
    const executable = new TextEncoder().encode('private uv')

    await publishUvExecutable(target, executable)

    await expect(readFile(target)).resolves.toEqual(Buffer.from(executable))
    expect(await readdir(join(root, 'tools', 'uv', PRIVATE_UV_VERSION, archive.sha256)))
      .toEqual(['uv.exe'])
  })

  it('removes the exclusive sibling when atomic publication fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-notebook-uv-publish-failure-'))
    temporaryDirectories.push(root)
    const target = join(root, 'occupied')
    await mkdir(target)

    await expect(publishUvExecutable(target, new Uint8Array([1]))).rejects.toThrow()
    expect(await readdir(root)).toEqual(['occupied'])
  })
})
