/** Run the type and bundle watchers as one development process. */

import { spawn, type ChildProcess } from 'node:child_process'
import { resolve } from 'node:path'

const pnpmCli = process.env.npm_execpath
if (pnpmCli === undefined) {
  throw new Error('pnpm run dev must be started through pnpm')
}

const children = new Set<ChildProcess>()
let stopping = false

function stop(exitCode: number): void {
  if (stopping) return
  stopping = true
  process.exitCode = exitCode
  for (const child of children) child.kill('SIGTERM')
}

function start(label: string, args: readonly string[], cwd = process.cwd()): void {
  const child = spawn(process.execPath, [pnpmCli, ...args], {
    cwd,
    env: process.env,
    stdio: 'inherit',
  })
  children.add(child)
  child.once('error', error => {
    process.stderr.write(`${label}: ${error.message}\n`)
    stop(1)
  })
  child.once('exit', (code, signal) => {
    children.delete(child)
    if (!stopping) {
      const detail = signal === null ? `exit code ${String(code)}` : `signal ${signal}`
      process.stderr.write(`${label} stopped unexpectedly (${detail})\n`)
      stop(code ?? 1)
    }
  })
}

process.once('SIGINT', () => stop(130))
process.once('SIGTERM', () => stop(143))

start('watch:types', ['run', 'watch:types'])
start('watch:bundles', ['run', 'watch:bundles'])

const harnessFlag = process.argv.indexOf('--harness')
if (harnessFlag !== -1) {
  const harnessRoot = process.argv[harnessFlag + 1]
  if (harnessRoot === undefined) throw new Error('--harness requires a checkout path')
  start('dsh web', ['dsh', 'web'], resolve(harnessRoot))
}
