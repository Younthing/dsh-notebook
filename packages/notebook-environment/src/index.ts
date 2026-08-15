/**
 * Service Definition for discovering, provisioning, and resolving notebook environments.
 * Providers own manager and interpreter mechanics; Consumers own sessions, durable selection,
 * browser transport, and kernel lifecycle.
 *
 * @module @younthing/dsh-notebook-environment
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type {
  NotebookEnvironmentCatalog,
  NotebookEnvironmentCatalogEntry,
  NotebookEnvironmentErrorCategory,
  NotebookEnvironmentErrorCode,
  NotebookEnvironmentId as NotebookEnvironmentIdBrand,
  NotebookExistingEnvironmentInspection,
} from './types.ts'
import type {
  NotebookEnvironmentLaunchSpec,
  NotebookEnvironmentOperationRequest,
  NotebookEnvironmentProvisionRequest,
  NotebookEnvironmentTargetRequest,
  NotebookPythonInstallRequest,
} from './service-types.ts'

export type {
  NotebookEnvironmentCatalog,
  NotebookEnvironmentCatalogEntry,
  NotebookEnvironmentErrorCategory,
  NotebookEnvironmentErrorCode,
  NotebookEnvironmentManagerCatalog,
  NotebookEnvironmentManagerStatus,
  NotebookEnvironmentStatus,
  NotebookExistingEnvironmentInspection,
  NotebookPythonCatalogEntry,
  NotebookPythonSource,
} from './types.ts'
export type {
  NotebookEnvironmentLaunchSpec,
  NotebookEnvironmentOperationRequest,
  NotebookEnvironmentProvisionRequest,
  NotebookEnvironmentTargetRequest,
  NotebookPythonInstallRequest,
} from './service-types.ts'

/** Opaque identity of one notebook environment within its workspace. */
export type NotebookEnvironmentId = NotebookEnvironmentIdBrand

/**
 * Brand a provider-owned string as a notebook environment id.
 * @param value - stable provider-owned identifier.
 * @returns the same value with notebook-environment nominal typing.
 */
export function NotebookEnvironmentId(value: string): NotebookEnvironmentId {
  return value as NotebookEnvironmentId
}

/** Environment failure carrying a stable code across Host transports. */
export class NotebookEnvironmentError extends Error {
  /**
   * @param message - safe user-facing failure detail.
   * @param code - stable environment failure category.
   * @param category - UI recovery family for this failure.
   * @param retryable - whether retrying without a user decision can succeed.
   * @param options - optional causal error retained on the Host only.
   */
  constructor(
    message: string,
    readonly code: NotebookEnvironmentErrorCode,
    readonly category: NotebookEnvironmentErrorCategory,
    readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'NotebookEnvironmentError'
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    notebookEnvironments: NotebookEnvironmentManager
  }
}

/**
 * One environment manager implementation. Every request carries its complete workspace,
 * permission, and cancellation context; the service retains no hidden session selection.
 */
export abstract class NotebookEnvironmentManager extends Service {
  /* v8 ignore next -- concrete providers exercise service construction. */
  constructor(ctx: Context) {
    super(ctx, 'notebookEnvironments')
  }

  /**
   * Discover manager, Python, and workspace environment state without mutation.
   * @param request - explicit workspace, policy, and cancellation context.
   * @returns a browser-safe catalog containing no absolute paths or argv.
   */
  abstract environmentCatalog(request: NotebookEnvironmentOperationRequest): Promise<NotebookEnvironmentCatalog>

  /**
   * Install the provider's pinned private manager after explicit user intent.
   * @param request - explicit workspace, policy, and cancellation context.
   * @returns the refreshed browser-safe catalog.
   */
  abstract installUv(request: NotebookEnvironmentOperationRequest): Promise<NotebookEnvironmentCatalog>

  /**
   * Install the supported Python runtime after an explicit user call.
   * @param request - explicit version, workspace, policy, and cancellation context.
   * @returns the refreshed browser-safe catalog.
   */
  abstract installPython(request: NotebookPythonInstallRequest): Promise<NotebookEnvironmentCatalog>

  /**
   * Inspect the workspace `.venv` without claiming or mutating it.
   * @param request - selected environment and explicit operation context.
   * @returns whether the directory is absent, managed, attachable, or broken.
   */
  abstract inspectExisting(request: NotebookEnvironmentTargetRequest): Promise<NotebookExistingEnvironmentInspection>

  /**
   * Create, explicitly attach, repair, or explicitly rebuild the workspace environment.
   * @param request - selected environment plus independent attach and owned-rebuild authorizations.
   * @returns the ready catalog entry after atomic publication or successful attach.
   */
  abstract provision(request: NotebookEnvironmentProvisionRequest): Promise<NotebookEnvironmentCatalogEntry>

  /**
   * Resolve an opaque ready environment into same-process Jupyter launch details.
   * @param request - selected environment and explicit operation context.
   * @returns absolute Host-only interpreter path and provider default kernelspec.
   */
  abstract resolveLaunch(request: NotebookEnvironmentTargetRequest): Promise<NotebookEnvironmentLaunchSpec>
}

export default NotebookEnvironmentManager
