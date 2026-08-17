import { useState } from 'react'
import type {
  NotebookEnvironmentCatalog,
  NotebookEnvironmentErrorCategory,
  NotebookEnvironmentId,
} from '@younthing/dsh-notebook-environment/types'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './notebook.module.css'

/** Environment recovery operation retained outside the durable projector. */
export interface NotebookEnvironmentFlow {
  readonly phase: 'checking' | 'required' | 'installing-uv' | 'installing-python' | 'provisioning' | 'attaching' | 'failed'
  readonly catalog?: NotebookEnvironmentCatalog
  readonly error?: string
  readonly errorCategory?: NotebookEnvironmentErrorCategory
}

/**
 * Render the in-place environment recovery flow without hiding the document.
 * @param props - current catalog, operation state, and explicit user transitions.
 * @returns The environment card while a kernel is detached.
 */
export function NotebookEnvironmentCard({
  flow, onRefresh, onInstallUv, onInstallPython, onProvision, onAttach, onCancel, t,
}: {
  readonly flow: NotebookEnvironmentFlow
  readonly onRefresh: () => void
  readonly onInstallUv: () => void
  readonly onInstallPython: () => void
  readonly onProvision: (
    environmentId: NotebookEnvironmentId,
    allowExisting: boolean,
    rebuild: boolean,
  ) => void
  readonly onAttach: (environmentId: NotebookEnvironmentId) => void
  readonly onCancel: () => void
  readonly t: PropsLocale<'notebook'>['t']
}) {
  const [confirmPython, setConfirmPython] = useState(false)
  const [confirmRebuild, setConfirmRebuild] = useState(false)
  const busy = flow.phase === 'installing-uv'
    || flow.phase === 'installing-python'
    || flow.phase === 'provisioning'
    || flow.phase === 'attaching'
  const catalog = flow.catalog
  const ready = catalog?.environments.filter(item => item.status === 'ready') ?? []
  const setup = catalog?.environments.find(item => item.status === 'setup-required')
  const broken = catalog?.environments.find(item => item.status === 'broken')

  return (
    <section id="notebook-environment-picker" className={css.environmentCard} aria-labelledby="notebook-environment-title">
      <div className={css.environmentHeading}>
        <StateDot state={flow.phase === 'failed' ? 'error' : busy || flow.phase === 'checking' ? 'ongoing' : 'warning'} />
        <div>
          <h3 id="notebook-environment-title">{t('environment.title')}</h3>
          <p>{t('environment.body')}</p>
        </div>
      </div>

      {flow.phase === 'checking'
        ? <p className={css.environmentStatus} role="status">{t('environment.checking')}</p>
        : null}
      {flow.phase === 'failed'
        ? (
          <div className={css.environmentError} role="alert">
            <span>{flow.errorCategory === 'permission' ? t('environment.permission') : t('environment.failed')}</span>
            <span className={css.launcherTechnical}>{flow.error}</span>
            <Button variant="outline" size="sm" onClick={onRefresh}>{t('launcher.retry')}</Button>
          </div>
        )
        : null}

      {catalog?.manager.status === 'missing'
        ? (
          <div className={css.environmentAction}>
            <p>{t('environment.uvMissing')}</p>
            <Button variant="primary" size="sm" disabled={busy || !catalog.manager.canInstall} onClick={onInstallUv}>
              {t(flow.phase === 'installing-uv' ? 'environment.installingUv' : 'environment.installUv')}
            </Button>
          </div>
        )
        : null}
      {catalog?.manager.status === 'unsupported' || catalog?.manager.status === 'broken'
        ? (
          <div className={css.environmentError} role="alert">
            <span>{t(catalog.manager.status === 'unsupported' ? 'environment.uvUnsupported' : 'environment.uvBroken')}</span>
            <Button variant="outline" size="sm" onClick={onRefresh}>{t('launcher.refresh')}</Button>
          </div>
        )
        : null}

      {catalog?.manager.status === 'ready' && catalog.pythons.length === 0
        ? (
          <div className={css.environmentAction}>
            <p>{t('environment.pythonMissing')}</p>
            {confirmPython
              ? (
                <div className={css.confirmRow} role="group" aria-label={t('environment.pythonConfirmTitle')}>
                  <span>{t('environment.pythonConfirmBody')}</span>
                  <Button variant="primary" size="sm" disabled={busy} onClick={() => {
                    setConfirmPython(false)
                    onInstallPython()
                  }}>
                    {t('environment.pythonConfirm')}
                  </Button>
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setConfirmPython(false) }}>
                    {t('environment.cancel')}
                  </Button>
                </div>
              )
              : (
                <Button variant="primary" size="sm" disabled={busy} onClick={() => { setConfirmPython(true) }}>
                  {t('environment.installPython')}
                </Button>
              )}
          </div>
        )
        : null}

      {ready.length > 0
        ? (
          <div className={css.environmentChoices}>
            <span className={css.environmentStatus}>{t('environment.choose')}</span>
            {ready.map(environment => (
              <Button
                key={environment.id}
                variant="primary"
                size="sm"
                disabled={busy}
                onClick={() => { onAttach(environment.id) }}
              >
                {t('environment.attach').replace('{name}', environment.displayName)}
              </Button>
            ))}
          </div>
        )
        : null}

      {setup !== undefined && catalog?.manager.status === 'ready' && catalog.pythons.length > 0
        ? (
          <div className={css.environmentAction}>
            <p>{t(setup.managed ? 'environment.createBody' : 'environment.enableBody')}</p>
            <Button
              variant="primary"
              size="sm"
              disabled={busy}
              onClick={() => { onProvision(setup.id, !setup.managed, false) }}
            >
              {t(flow.phase === 'provisioning'
                ? 'environment.provisioning'
                : setup.managed ? 'environment.create' : 'environment.enable')}
            </Button>
          </div>
        )
        : null}

      {broken !== undefined && catalog?.manager.status === 'ready'
        ? (
          <div className={css.environmentAction}>
            <p>{t(broken.managed ? 'environment.rebuildBody' : 'environment.brokenExistingBody')}</p>
            {broken.managed && confirmRebuild
              ? (
                <div className={css.confirmRow} role="group" aria-label={t('environment.rebuildConfirmTitle')}>
                  <span>{t('environment.rebuildConfirmBody')}</span>
                  <Button variant="primary" size="sm" disabled={busy} onClick={() => {
                    setConfirmRebuild(false)
                    onProvision(broken.id, false, true)
                  }}>
                    {t('environment.rebuildConfirm')}
                  </Button>
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setConfirmRebuild(false) }}>
                    {t('environment.cancel')}
                  </Button>
                </div>
              )
              : broken.managed
                ? (
                  <Button variant="outline" size="sm" disabled={busy} onClick={() => { setConfirmRebuild(true) }}>
                    {t('environment.rebuild')}
                  </Button>
                )
                : null}
          </div>
        )
        : null}

      {busy
        ? <Button variant="ghost" size="sm" onClick={onCancel}>{t('environment.cancel')}</Button>
        : null}
    </section>
  )
}
