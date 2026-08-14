import type { NotebookId } from '@deepseek-ai/dsh-notebook-core/types'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import {
  Button, IconCloseOutline16, IconPlusOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import css from './notebook.module.css'

/** One entry displayed by the active Notebook selector. */
export interface NotebookSwitcherItem {
  readonly id: NotebookId
  readonly path: string
}

/**
 * Render the single-canvas document selector and panel controls.
 * @param props - open documents, selection, and panel transitions.
 * @returns The Notebook workspace bar.
 */
export function NotebookDocumentSwitcher({
  notebooks, activeId, newDocumentCount, launcherOpen, onSelect, onToggleLauncher,
  onClosePanel, t,
}: {
  readonly notebooks: readonly NotebookSwitcherItem[]
  readonly activeId: NotebookId
  readonly newDocumentCount: number
  readonly launcherOpen: boolean
  readonly onSelect: (id: NotebookId) => void
  readonly onToggleLauncher: () => void
  readonly onClosePanel: () => void
  readonly t: PropsLocale<'notebook'>['t']
}) {
  return (
    <div className={css.workspaceBar}>
      <label className={css.srOnly} htmlFor="notebook-document-switcher">
        {t('switcher.label')}
      </label>
      <select
        id="notebook-document-switcher"
        className={css.documentSelect}
        value={String(activeId)}
        onChange={(event) => {
          const selected = notebooks.find(item => String(item.id) === event.currentTarget.value)
          if (selected !== undefined) onSelect(selected.id)
        }}
      >
        {notebooks.map(item => <option key={item.id} value={String(item.id)}>{item.path}</option>)}
      </select>
      {newDocumentCount > 0
        ? (
          <span className={css.newDocumentNotice} role="status">
            {t('switcher.newDocuments').replace('{count}', String(newDocumentCount))}
          </span>
        )
        : null}
      <Button
        variant={launcherOpen ? 'outline' : 'ghost'}
        size="sm"
        icon={<IconPlusOutline16 size={14} />}
        aria-expanded={launcherOpen}
        onClick={onToggleLauncher}
      >
        {t('switcher.add')}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        icon={<IconCloseOutline16 size={14} />}
        aria-label={t('panel.close')}
        title={t('panel.close')}
        onClick={onClosePanel}
      />
    </div>
  )
}
