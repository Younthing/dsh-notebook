/**
 * Browser-safe catalog, opaque identity, and error vocabulary for notebook Python environments.
 * Host-only operation requests and launch paths live outside this pure type face.
 *
 * @module @younthing/dsh-notebook-environment/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Opaque identity of one notebook environment within its workspace. */
export type NotebookEnvironmentId = Branded<'NotebookEnvironmentId'>

/** Stable environment-manager discovery states exposed to UI Consumers. */
export type NotebookEnvironmentManagerStatus = 'ready' | 'missing' | 'broken' | 'unsupported'

/** Browser-safe status of the configured environment manager. */
export interface NotebookEnvironmentManagerCatalog {
  /** Whether the manager can currently provision an environment. */
  readonly status: NotebookEnvironmentManagerStatus
  /** Detected manager version when a runnable manager was found. */
  readonly version?: string
  /** Whether an explicit install operation is available on this platform. */
  readonly canInstall: boolean
}

/** Where a discovered Python interpreter came from. */
export type NotebookPythonSource = 'configured' | 'path' | 'managed'

/** Browser-safe Python interpreter entry. */
export interface NotebookPythonCatalogEntry {
  /** Opaque provider-owned interpreter identity; never an executable path. */
  readonly id: string
  /** Detected Python version without a filesystem location. */
  readonly version: string
  /** How the provider found or installed this interpreter. */
  readonly source: NotebookPythonSource
}

/** Provisioning state of one notebook environment. */
export type NotebookEnvironmentStatus = 'ready' | 'setup-required' | 'provisioning' | 'broken'

/** Browser-safe environment entry. */
export interface NotebookEnvironmentCatalogEntry {
  /** Opaque environment identity. */
  readonly id: NotebookEnvironmentId
  /** Human-readable label that contains no absolute host path. */
  readonly displayName: string
  /** Current environment readiness. */
  readonly status: NotebookEnvironmentStatus
  /** Detected Python version when one can be read safely. */
  readonly pythonVersion?: string
  /** Whether a DSH ownership sidecar authorizes managed updates. */
  readonly managed: boolean
}

/** Complete browser-safe catalog for one workspace. */
export interface NotebookEnvironmentCatalog {
  /** Manager availability and install affordance. */
  readonly manager: NotebookEnvironmentManagerCatalog
  /** Compatible Python interpreters discovered without exposing their paths. */
  readonly pythons: readonly NotebookPythonCatalogEntry[]
  /** Workspace notebook environments. */
  readonly environments: readonly NotebookEnvironmentCatalogEntry[]
}

/** Read-only description of an existing workspace `.venv`. */
export interface NotebookExistingEnvironmentInspection {
  /** Opaque identity matching the catalog entry. */
  readonly environmentId: NotebookEnvironmentId
  /** Existing-directory state. */
  readonly status: 'absent' | 'managed' | 'unmanaged' | 'broken'
  /** Detected Python version when the interpreter starts successfully. */
  readonly pythonVersion?: string
  /** Whether explicit `allowExisting: true` provisioning may attach it. */
  readonly canAttach: boolean
  /** Whether a matching DSH ownership record permits explicit replacement. */
  readonly canRebuild: boolean
  /** Stable user-facing explanation for a non-ready state. */
  readonly message?: string
}

/** Stable machine-readable failures exposed by the environment seam. */
export type NotebookEnvironmentErrorCode =
  | 'NOTEBOOK_ENVIRONMENT_UNKNOWN'
  | 'NOTEBOOK_ENVIRONMENT_MANAGER_REQUIRED'
  | 'NOTEBOOK_ENVIRONMENT_MANAGER_UNSUPPORTED'
  | 'NOTEBOOK_ENVIRONMENT_MANAGER_INTEGRITY'
  | 'NOTEBOOK_ENVIRONMENT_PYTHON_REQUIRED'
  | 'NOTEBOOK_ENVIRONMENT_ATTACH_REQUIRED'
  | 'NOTEBOOK_ENVIRONMENT_REBUILD_REQUIRED'
  | 'NOTEBOOK_ENVIRONMENT_PERMISSION_REQUIRED'
  | 'NOTEBOOK_ENVIRONMENT_BUSY'
  | 'NOTEBOOK_ENVIRONMENT_TIMEOUT'
  | 'NOTEBOOK_ENVIRONMENT_OUTPUT_LIMIT'
  | 'NOTEBOOK_ENVIRONMENT_PROVISION_FAILED'
  | 'NOTEBOOK_ENVIRONMENT_DEPENDENCY_FAILED'
  | 'NOTEBOOK_ENVIRONMENT_KERNELSPEC_MISSING'
  | 'NOTEBOOK_ENVIRONMENT_KERNEL_START_FAILED'
  | 'NOTEBOOK_ENVIRONMENT_BROKEN'

/** Stable high-level failure category for UI recovery choices. */
export type NotebookEnvironmentErrorCategory =
  | 'manager'
  | 'python'
  | 'permission'
  | 'dependency'
  | 'kernelspec'
  | 'kernel-start'
