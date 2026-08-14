import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, IconCodeOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'

/** Injected Notebook panel transition. */
export interface NotebookPanelActionInjected {
  /** Toggle the rendered Notebook panel for the current Session. */
  toggleNotebookPanel: () => void
}

/** Session-header Notebook panel action props. */
export type NotebookPanelActionProps =
  PropsRuntime<'conversation.session.header.actions'>
  & PropsLocale<'notebook'>
  & NotebookPanelActionInjected

/**
 * Render the always-reachable Notebook panel switch.
 * @param props - localized label and layout transition.
 * @returns The session-header action.
 */
export function NotebookPanelAction({ toggleNotebookPanel, t }: NotebookPanelActionProps) {
  return (
    <Button
      variant="ghost"
      size="sm"
      icon={<IconCodeOutline16 size={14} />}
      aria-label={t('panel.toggle')}
      aria-controls="dsh-notebook-panel"
      title={t('panel.toggle')}
      onClick={toggleNotebookPanel}
    >
      {t('panel.label')}
    </Button>
  )
}
