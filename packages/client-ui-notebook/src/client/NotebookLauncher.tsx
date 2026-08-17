import type { ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import {
  Button, IconCodeOutline16, IconFolderOpenOutline16, IconPlusOutline16, IconRefreshOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import css from './notebook.module.css'

/** One workspace Notebook candidate returned without reading its contents. */
export interface NotebookDiscoveryItem {
  /** Workspace-relative POSIX path. */
  readonly path: string
  /** File size when the provider can report it. */
  readonly size?: number
}

/** Browser discovery state kept outside the durable Notebook projector. */
export interface NotebookDiscoveryState {
  readonly phase: 'discovering' | 'ready' | 'error'
  readonly items: readonly NotebookDiscoveryItem[]
  readonly nextAfter?: string
  readonly partial: boolean
  readonly loadingMore: boolean
  readonly error?: string
}

/** Props for the Notebook start and add-document surface. */
export interface NotebookLauncherProps {
  readonly discovery: NotebookDiscoveryState
  readonly createPath: string
  readonly openPath: string
  readonly pending: boolean
  readonly createInvalid: boolean
  readonly openInvalid: boolean
  readonly compact?: boolean
  readonly notice: ReactNode
  readonly onCreatePathChange: (path: string) => void
  readonly onOpenPathChange: (path: string) => void
  readonly onCreate: () => void
  readonly onOpenPath: () => void
  readonly onOpenCandidate: (path: string) => void
  readonly onRefresh: () => void
  readonly onLoadMore: () => void
  readonly onDismiss?: () => void
  readonly t: PropsLocale<'notebook'>['t']
}

function formattedSize(size: number | undefined): string | undefined {
  if (size === undefined) return undefined
  if (size < 1_024) return `${String(size)} B`
  if (size < 1_048_576) return `${(size / 1_024).toFixed(1)} KB`
  return `${(size / 1_048_576).toFixed(1)} MB`
}

/**
 * Render workspace discovery plus strict create and existing-only open paths.
 * @param props - discovery state, document paths, transitions, and labels.
 * @returns The full empty launcher or compact add-document surface.
 */
export function NotebookLauncher({
  discovery, createPath, openPath, pending, createInvalid, openInvalid, compact = false, notice,
  onCreatePathChange, onOpenPathChange, onCreate, onOpenPath, onOpenCandidate,
  onRefresh, onLoadMore, onDismiss, t,
}: NotebookLauncherProps) {
  const firstLoad = discovery.phase === 'discovering' && discovery.items.length === 0
  const hasCandidates = discovery.items.length > 0
  return (
    <section
      className={compact ? `${css.launcher} ${css.launcherCompact}` : css.launcher}
      aria-labelledby="notebook-launcher-title"
      data-testid={compact ? 'notebook-launcher-compact' : 'notebook-launcher'}
    >
      <header className={css.launcherHeader}>
        <div>
          <h2 id="notebook-launcher-title" className={css.launcherTitle}>
            {t(hasCandidates ? 'launcher.foundTitle' : 'empty.title')}
          </h2>
          <p className={css.launcherBody}>
            {t(hasCandidates ? 'launcher.foundBody' : 'empty.body')}
          </p>
        </div>
        <div className={css.launcherHeaderActions}>
          <Button
            variant="ghost"
            size="sm"
            icon={<IconRefreshOutline16 size={14} />}
            disabled={discovery.phase === 'discovering' || pending}
            onClick={onRefresh}
          >
            {t('launcher.refresh')}
          </Button>
          {onDismiss !== undefined
            ? (
              <Button variant="ghost" size="sm" onClick={onDismiss}>
                {t('launcher.done')}
              </Button>
            )
            : null}
        </div>
      </header>

      {firstLoad
        ? <p className={css.launcherStatus} role="status">{t('launcher.discovering')}</p>
        : null}
      {discovery.phase === 'error'
        ? (
          <div className={css.launcherError} role="alert">
            <span>{t('launcher.discoveryFailed')}</span>
            <span className={css.launcherTechnical}>{discovery.error}</span>
            <Button variant="outline" size="sm" onClick={onRefresh}>
              {t('launcher.retry')}
            </Button>
          </div>
        )
        : null}

      {hasCandidates
        ? (
          <div className={css.candidateRegion}>
            <ul className={css.candidateList} aria-label={t('launcher.candidates')}>
              {discovery.items.map(item => (
                <li key={item.path} className={css.candidateRow}>
                  <button
                    type="button"
                    className={css.candidateSelect}
                    disabled={pending}
                    onClick={() => { onOpenCandidate(item.path) }}
                  >
                    <IconCodeOutline16 size={16} aria-hidden />
                    <span className={css.candidatePath}>{item.path}</span>
                    {formattedSize(item.size) !== undefined
                      ? <span className={css.candidateSize}>{formattedSize(item.size)}</span>
                      : null}
                  </button>
                  <Button
                    variant="outline"
                    size="sm"
                    icon={<IconFolderOpenOutline16 size={14} />}
                    disabled={pending}
                    aria-label={t('launcher.open')}
                    title={t('launcher.open')}
                    onClick={() => { onOpenCandidate(item.path) }}
                  />
                </li>
              ))}
            </ul>
            {discovery.partial
              ? <p className={css.launcherStatus} role="status">{t('launcher.partial')}</p>
              : null}
            {discovery.nextAfter !== undefined
              ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={discovery.loadingMore || pending}
                  onClick={onLoadMore}
                >
                  {t(discovery.loadingMore ? 'launcher.loadingMore' : 'launcher.loadMore')}
                </Button>
              )
              : null}
          </div>
        )
        : null}

      <div className={css.documentForms}>
        <form
          className={css.openForm}
          onSubmit={(event) => {
            event.preventDefault()
            onCreate()
          }}
        >
          <label className={css.pathLabel} htmlFor="notebook-create-path">
            {t('launcher.createPathLabel')}
          </label>
          <input
            id="notebook-create-path"
            className={css.pathInput}
            value={createPath}
            disabled={pending}
            aria-invalid={createInvalid}
            aria-describedby="notebook-create-path-hint"
            onChange={(event) => { onCreatePathChange(event.currentTarget.value) }}
          />
          <span id="notebook-create-path-hint" className={css.pathHint}>
            {t('launcher.createPathHint')}
          </span>
          <Button
            type="submit"
            variant="primary"
            size="sm"
            icon={<IconPlusOutline16 size={14} />}
            disabled={pending}
          >
            {t('launcher.create')}
          </Button>
        </form>

        <section className={css.openExisting}>
          <h3 className={css.openExistingTitle}>{t('launcher.openByPath')}</h3>
          <form
            className={css.openForm}
            onSubmit={(event) => {
              event.preventDefault()
              onOpenPath()
            }}
          >
            <label className={css.pathLabel} htmlFor="notebook-open-path">
              {t('empty.pathLabel')}
            </label>
            <input
              id="notebook-open-path"
              className={css.pathInput}
              value={openPath}
              disabled={pending}
              aria-invalid={openInvalid}
              aria-describedby="notebook-open-path-hint"
              onChange={(event) => { onOpenPathChange(event.currentTarget.value) }}
            />
            <span id="notebook-open-path-hint" className={css.pathHint}>
              {t('empty.pathHint')}
            </span>
            <Button
              type="submit"
              variant="outline"
              size="sm"
              icon={<IconFolderOpenOutline16 size={14} />}
              disabled={pending}
            >
              {t('launcher.open')}
            </Button>
          </form>
        </section>
        {notice}
      </div>
    </section>
  )
}
