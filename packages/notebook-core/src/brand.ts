/**
 * Notebook id factories owned by `@deepseek-ai/dsh-notebook-core`.
 * @module @deepseek-ai/dsh-notebook-core/brand
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Opaque notebook document identity minted by {@link NotebookService}. */
export type NotebookId = Branded<'NotebookId'>

/** Opaque cell identity unique within one notebook document. */
export type CellId = Branded<'CellId'>

/** Opaque execution identity for one cell run. */
export type ExecutionId = Branded<'ExecutionId'>

/** Opaque filesystem revision recorded after a notebook file commit. */
export type NotebookFileVersion = Branded<'NotebookFileVersion'>

/**
 * Brand a registry-minted string as a {@link NotebookId}.
 * @param value - raw registry-issued id.
 * @returns Same string with the notebook document brand.
 */
export function NotebookId(value: string): NotebookId {
  return value as NotebookId
}

/**
 * Brand a registry-minted string as a {@link CellId}.
 * @param value - raw registry-issued id.
 * @returns Same string with the cell brand.
 */
export function CellId(value: string): CellId {
  return value as CellId
}

/**
 * Brand a registry-minted string as an {@link ExecutionId}.
 * @param value - raw registry-issued id.
 * @returns Same string with the execution brand.
 */
export function ExecutionId(value: string): ExecutionId {
  return value as ExecutionId
}

/**
 * Brand a filesystem revision for durable notebook events.
 * @param value - opaque revision returned by the filesystem capability.
 * @returns Same string with the notebook file-version brand.
 */
export function NotebookFileVersion(value: string): NotebookFileVersion {
  return value as NotebookFileVersion
}
