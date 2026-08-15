/** Managed, bounded subprocess execution for the uv environment provider. */

import { Buffer } from 'node:buffer'
import type { Context } from '@deepseek-ai/cordis'
import {
  NotebookEnvironmentError,
  type NotebookEnvironmentErrorCategory,
  type NotebookEnvironmentErrorCode,
} from '@younthing/dsh-notebook-environment'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'

/** One fixed provider command after request-to-spec resolution. */
export interface EnvironmentCommandSpec {
  /** Fixed argv with an already-resolved executable. */
  readonly argv: readonly string[]
  /** Absolute command working directory. */
  readonly cwd: string
  /** Complete per-request confinement policy. */
  readonly sandboxPolicy: SandboxExecutionPolicy
  /** Scrubbed deterministic environment layer. */
  readonly env: NodeJS.ProcessEnv
  /** Caller/provider/deadline cancellation fused by the owner. */
  readonly signal: AbortSignal
  /** Server-log label containing no user-controlled value. */
  readonly label: string
  /** Stable failure code for a nonzero process exit. */
  readonly failureCode: NotebookEnvironmentErrorCode
  /** Stable UI category for process failure and output overflow. */
  readonly category: NotebookEnvironmentErrorCategory
  /** Whether bounded stderr is written to the Host log on nonzero exit. */
  readonly logFailure?: boolean
}

/** Complete successful output retained within the configured aggregate cap. */
export interface EnvironmentCommandResult {
  /** Complete stdout. */
  readonly stdout: string
  /** Complete stderr, retained only on the Host. */
  readonly stderr: string
}

/** Bounded managed-process runner that terminates and joins every aborted child tree. */
export class EnvironmentCommandRunner {
  /**
   * @param ctx - subprocess and sandbox services in one execution world.
   * @param maxOutputBytes - aggregate stdout plus stderr UTF-8 byte cap.
   * @param graceMs - subprocess TERM-to-KILL grace.
   */
  constructor(
    private readonly ctx: Context,
    private readonly maxOutputBytes: number,
    private readonly graceMs: number,
  ) {}

  /**
   * Run one fully resolved command, classifying cancellation, denial, and bounded diagnostics.
   * @param spec - complete command specification.
   * @returns complete successful output.
   */
  async run(spec: EnvironmentCommandSpec): Promise<EnvironmentCommandResult> {
    spec.signal.throwIfAborted()
    let argv: readonly string[] = spec.argv
    let denialSignatures: readonly string[] = []
    if (spec.sandboxPolicy.mode !== 'danger-full-access') {
      try {
        const confined = this.ctx.sandbox.confine(spec.argv, {
          ...spec.sandboxPolicy,
          mode: spec.sandboxPolicy.mode,
        })
        argv = confined.argv
        denialSignatures = confined.denialSignatures
      } catch (cause) {
        throw new NotebookEnvironmentError(
          'The current sandbox cannot run this environment operation.',
          'NOTEBOOK_ENVIRONMENT_PERMISSION_REQUIRED',
          'permission',
          false,
          { cause },
        )
      }
    }

    let child: SubprocessHandle
    try {
      child = this.ctx.subprocess.spawn({
        argv,
        cwd: spec.cwd,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: this.maxOutputBytes },
          stderr: { maxBytes: this.maxOutputBytes },
        },
        graceMs: this.graceMs,
        signal: spec.signal,
        env: spec.env,
      })
    } catch (cause) {
      spec.signal.throwIfAborted()
      throw new NotebookEnvironmentError(
        'The environment process could not be started or joined.',
        spec.failureCode,
        spec.category,
        true,
        { cause },
      )
    }

    let outcome: Awaited<typeof child.done>
    try {
      outcome = await child.done
      const joined = await child.waitForExit(spec.signal)
      if (!joined) throw new Error('environment process tree did not stop')
    } catch (cause) {
      let failure = cause
      let cleanupFailed = false
      try {
        await terminateAndJoin(child)
      } catch (cleanupError) {
        cleanupFailed = true
        failure = new AggregateError([cause, cleanupError], 'environment process failure and cleanup failure')
      }
      if (!cleanupFailed) spec.signal.throwIfAborted()
      throw new NotebookEnvironmentError(
        'The environment process could not be started or joined.',
        spec.failureCode,
        spec.category,
        true,
        { cause: failure },
      )
    }

    const stdoutRead = child.collected.stdout?.readFrom(0)
    const stderrRead = child.collected.stderr?.readFrom(0)
    const stdout = stdoutRead?.text ?? ''
    const stderr = stderrRead?.text ?? ''
    const outputBytes = Buffer.byteLength(stdout) + Buffer.byteLength(stderr)
    if (stdoutRead?.lossy === true || stderrRead?.lossy === true || outputBytes > this.maxOutputBytes) {
      throw new NotebookEnvironmentError(
        'The environment process produced more diagnostic output than allowed.',
        'NOTEBOOK_ENVIRONMENT_OUTPUT_LIMIT',
        spec.category,
        false,
      )
    }
    if (outcome.exitCode !== 0) {
      if (spec.logFailure !== false && stderr.trim() !== '') {
        this.ctx.logger.warn(`${spec.label} failed: ${stderr.trim()}`)
      }
      const lower = stderr.toLowerCase()
      if (denialSignatures.some(signature => lower.includes(signature.toLowerCase()))) {
        throw new NotebookEnvironmentError(
          'The current sandbox denied a required environment file operation.',
          'NOTEBOOK_ENVIRONMENT_PERMISSION_REQUIRED',
          'permission',
          false,
        )
      }
      throw new NotebookEnvironmentError(
        'The environment process failed. See the Host log for bounded diagnostics.',
        spec.failureCode,
        spec.category,
        true,
      )
    }
    return { stdout, stderr }
  }
}

async function terminateAndJoin(child: SubprocessHandle): Promise<void> {
  child.terminate()
  const stopped = await child.waitForExit()
  if (!stopped) throw new Error('environment process tree did not stop after termination')
}
