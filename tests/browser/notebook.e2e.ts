import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import type {
  CellId as NotebookCellId,
  ExecutionId as NotebookExecutionId,
  NotebookFileVersion,
  NotebookId as NotebookDocumentId,
  NotebookEnvironmentId,
} from '@younthing/dsh-notebook/types'
import type {} from '@deepseek-ai/dsh-session-title'
import {
  assertFixtureInventory,
  captureStableAria,
  compareOrRefreshGolden,
  launchWebScaffold,
  seedSession,
  watchConsole,
  webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/notebook', import.meta.url))
const UI_EXPECTED = fileURLToPath(new URL('./snapshots/notebook/ui.expected.md', import.meta.url))
const MODE = webSnapshotMode()
const SEED_ID = 'notebook-web-e2e'
const TITLE = 'Notebook browser scenario'

const NotebookId = (value: string): NotebookDocumentId => value as NotebookDocumentId
const CellId = (value: string): NotebookCellId => value as NotebookCellId
const ExecutionId = (value: string): NotebookExecutionId => value as NotebookExecutionId
const FileVersion = (value: string): NotebookFileVersion => value as NotebookFileVersion
const EnvironmentId = (value: string): NotebookEnvironmentId => value as NotebookEnvironmentId

async function writeWorkspaceNotebook(root: string, path: string, source: string): Promise<void> {
  const target = join(root, ...path.split('/'))
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, `${JSON.stringify({
    cells: [{
      cell_type: 'code',
      execution_count: null,
      id: `cell-${path.replaceAll(/[^a-z0-9]/gi, '-')}`,
      metadata: {},
      outputs: [],
      source: [source],
    }],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5,
  })}\n`)
}

function notebookFixture(): string {
  const session = Session.create(SessionId('notebook-web-source'))
  const notebookId = NotebookId('notebook-browser-1')
  const cellId = CellId('cell-browser-1')
  const executionId = ExecutionId('exec-browser-1')
  session.append('turn/start', { turn: 1 })
  const user = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Show the persisted notebook.' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('session/title', {
    title: TITLE,
    messageSeqs: [user.seq],
    source: { kind: 'fallback' },
  })
  session.append('notebook/open', {
    notebookId,
    path: 'analysis.ipynb',
    fileVersion: FileVersion('browser-file-1'),
    nbformatMinor: 5,
    metadata: {},
  })
  session.append('notebook/kernel', {
    notebookId,
    environmentId: EnvironmentId('browser-environment'),
    backend: 'jupyter',
    kernelName: 'python3',
    generation: 1,
    initiator: 'user',
    fileVersion: FileVersion('browser-file-1'),
  })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  for (let turn = 2; turn <= 52; turn++) {
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `Notebook paging filler ${turn}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  session.append('turn/start', { turn: 53 })
  session.append('notebook/cell', {
    notebookId,
    cellId,
    cellType: 'code',
    source: 'print("browser notebook")',
    index: 0,
    operation: 'create',
    metadata: {},
    attachments: {},
    fileVersion: FileVersion('browser-file-2'),
  })
  session.append('notebook/execute', {
    notebookId,
    cellId,
    executionId,
    initiator: 'user',
  })
  session.append('notebook/output', {
    notebookId,
    cellId,
    executionId,
    mutation: {
      operation: 'append',
      output: { type: 'stream', name: 'stdout', text: 'browser notebook\n' },
    },
  })
  session.append('notebook/output', {
    notebookId,
    cellId,
    executionId,
    mutation: {
      operation: 'append',
      output: {
        type: 'display',
        data: {
          'application/vnd.plotly.v1+json': {
            type: 'json',
            value: { data: [{ x: [1, 2, 3], y: [2, 4, 3], type: 'scatter' }] },
          },
          'text/plain': { type: 'text', text: 'plot fallback' },
        },
        metadata: {},
        displayId: 'browser-display',
      },
    },
  })
  session.append('notebook/execute-end', {
    notebookId,
    cellId,
    executionId,
    status: 'ok',
    executionCount: 1,
    fileVersion: FileVersion('browser-file-3'),
  })
  session.append('turn/end', { turn: 53, reason: { kind: 'completed' } })

  return [
    JSON.stringify({
      type: 'session',
      version: SESSION_FORMAT_VERSION,
      id: '{{sessionId}}',
      createdAt: 0,
    }),
    ...session.events.map(event => JSON.stringify(event)),
    '',
  ].join('\n')
}

describe('web e2e: notebook session projection', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    await seedSession(scaffold, notebookFixture(), SEED_ID)
    const executablePath = process.env.DSH_PLAYWRIGHT_EXECUTABLE_PATH
    browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('renders a durable notebook through the shipped browser composition', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-notebook'))
    const group = page.locator('[role="treeitem"]').first()
    await group.waitFor({ timeout: 15_000 })
    await group.click()
    const session = page.locator('[role="treeitem"]').nth(1)
    await session.waitFor({ timeout: 10_000 })
    await session.click()

    const notebook = page.getByRole('region', { name: 'analysis.ipynb' })
    expect(await notebook.count()).toBe(0)
    const recovery = page.getByRole('button', { name: 'Load earlier notebook history' })
    await recovery.waitFor({ timeout: 15_000 })
    await recovery.click()
    await notebook.waitFor({ timeout: 15_000 })
    await expect.poll(() => notebook.getByRole('textbox', { name: 'Cell source' }).inputValue())
      .toBe('print("browser notebook")')
    await notebook.getByText('browser notebook', { exact: true }).waitFor()
    await notebook.getByRole('button', { name: 'Run', exact: true }).waitFor()
    await notebook.getByRole('button', { name: 'Run all' }).waitFor()
    await notebook.getByRole('button', { name: 'Reload from disk' }).waitFor()
    await notebook.getByRole('button', { name: 'Restart kernel' }).waitFor()
    await notebook.getByRole('img', { name: 'application/vnd.plotly.v1+json' }).waitFor()

    const snapshot = await captureStableAria(page, '[data-testid="notebook-view"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)

    await page.getByRole('button', { name: 'New session' }).last().click()
    await connectFreshWorkspace(page, scaffold.workspaceCwd, 'blank-notebook-workspace')
    const launcher = page.getByTestId('notebook-launcher')
    await launcher.waitFor({ timeout: 15_000 })
    await launcher.getByText('No notebook yet', { exact: true }).waitFor()
    expect(await launcher.getByRole('list', { name: 'Discovered notebooks' }).count()).toBe(0)

    const blankWorkspace = join(scaffold.workspaceCwd, 'blank-notebook-workspace')
    await writeWorkspaceNotebook(blankWorkspace, 'one.ipynb', 'print("one")')
    await launcher.getByRole('button', { name: 'Refresh' }).click()
    const oneCandidate = launcher.getByRole('listitem').filter({ hasText: 'one.ipynb' })
    await oneCandidate.waitFor()
    expect(await page.getByRole('region', { name: 'one.ipynb' }).count()).toBe(0)
    expect(await launcher.getByRole('listitem').count()).toBe(1)
    await oneCandidate.getByRole('button', { name: 'Open' }).click()

    const detached = page.getByRole('region', { name: 'one.ipynb' })
    await detached.waitFor({ timeout: 15_000 })
    await detached.getByRole('heading', { name: 'Notebook runtime required' }).waitFor()
    const detachedEditor = detached.getByRole('textbox', { name: 'Cell source' })
    await detachedEditor.fill('print("edited without a kernel")')
    await detachedEditor.blur()
    await detached.getByText('Saved').waitFor()
    expect(await detached.getByRole('button', { name: 'Run', exact: true }).isDisabled()).toBe(true)

    await writeWorkspaceNotebook(blankWorkspace, 'nested/two.ipynb', 'print("two")')
    await writeWorkspaceNotebook(blankWorkspace, 'three.ipynb', 'print("three")')
    await page.getByRole('button', { name: 'Open or create' }).click()
    const compactLauncher = page.getByTestId('notebook-launcher-compact')
    await compactLauncher.getByRole('button', { name: 'Refresh' }).click()
    const candidates = compactLauncher.getByRole('list', { name: 'Discovered notebooks' })
    await candidates.getByText('nested/two.ipynb', { exact: true }).waitFor()
    await candidates.getByText('three.ipynb', { exact: true }).waitFor()
    expect(await candidates.getByRole('listitem').count()).toBe(2)

    const openPath = compactLauncher.getByRole('textbox', { name: 'Workspace-relative .ipynb path' })
    await compactLauncher.getByText('Open an existing file by path').click()
    await openPath.fill('missing.ipynb')
    await compactLauncher.getByRole('button', { name: 'Open', exact: true }).last().click()
    await compactLauncher.getByRole('alert').filter({ hasText: 'does not exist' }).waitFor()
    expect(await openPath.getAttribute('aria-invalid')).toBe('true')

    const createPath = compactLauncher.getByRole('textbox', { name: 'New notebook path' })
    await createPath.fill('three.ipynb')
    await compactLauncher.getByRole('button', { name: 'Create notebook' }).click()
    await compactLauncher.getByRole('alert').filter({ hasText: 'already exists' }).waitFor()
    expect(await createPath.getAttribute('aria-invalid')).toBe('true')

    const twoCandidate = candidates.getByRole('listitem').filter({ hasText: 'nested/two.ipynb' })
    await twoCandidate.getByRole('button', { name: 'Open' }).click()
    const second = page.getByRole('region', { name: 'nested/two.ipynb' })
    await second.waitFor({ timeout: 15_000 })
    const switcher = page.getByRole('combobox', { name: 'Current notebook' })
    await expect.poll(() => switcher.locator('option').count()).toBe(2)
    expect(await page.locator('[data-testid="notebook-view"] section[aria-label$=".ipynb"]').count()).toBe(1)

    await page.getByRole('button', { name: 'Close Notebook panel' }).click()
    await page.locator('[data-notebook-collapsed="true"]').waitFor()
    const restoreNotebook = page.getByRole('button', { name: 'Toggle Notebook panel' })
    await restoreNotebook.waitFor()
    expect(await restoreNotebook.isVisible()).toBe(true)
    await restoreNotebook.click()
    await expect.poll(() => page.locator('[data-notebook-collapsed="true"]').count()).toBe(0)
    await second.waitFor()

    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['ui.expected.md'])
  }, 60_000)
})
