/** Host-only request and launch types for the notebook-environment Service Definition. */

import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { NotebookEnvironmentId } from './types.ts'

/** Common explicit context for every environment operation. */
export interface NotebookEnvironmentOperationRequest {
  /** Absolute workspace root containing the managed `.venv`. */
  readonly workspaceRoot: string
  /** Resolved file-effect permission for this operation. */
  readonly sandboxPolicy: SandboxExecutionPolicy
  /** Required cancellation for discovery, download, and subprocess work. */
  readonly signal: AbortSignal
}

/** Explicit request to install the supported Python runtime. */
export interface NotebookPythonInstallRequest extends NotebookEnvironmentOperationRequest {
  /** The only Python line this provider is permitted to install. */
  readonly version: '3.12'
}

/** Request targeting one opaque workspace environment. */
export interface NotebookEnvironmentTargetRequest extends NotebookEnvironmentOperationRequest {
  /** Environment selected from the catalog for this workspace. */
  readonly environmentId: NotebookEnvironmentId
}

/** Explicit provisioning request. */
export interface NotebookEnvironmentProvisionRequest extends NotebookEnvironmentTargetRequest {
  /**
   * Authorize package installation into an existing unmanaged `.venv`.
   * `false` must fail with `NOTEBOOK_ENVIRONMENT_ATTACH_REQUIRED` instead of
   * mutating or claiming that directory.
   */
  readonly allowExisting: boolean
  /**
   * Authorize replacement of an environment whose matching DSH sidecar proves ownership.
   * This flag never authorizes deletion of an unmanaged, foreign, malformed, or linked path.
   */
  readonly rebuild: boolean
}

/**
 * Same-process launch details resolved from an opaque environment id.
 * This record contains a host path and must never cross the browser RPC API.
 */
export interface NotebookEnvironmentLaunchSpec {
  /** Resolved environment identity. */
  readonly environmentId: NotebookEnvironmentId
  /** Absolute interpreter path inside the selected environment. */
  readonly pythonExecutable: string
  /** Provider-owned default kernelspec name. */
  readonly kernelName: string
}
