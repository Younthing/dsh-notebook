// @vitest-environment jsdom
/**
 * Real tsdown artifact smoke: the built browser plugin must hand off through
 * ModuleLoader, resolve only platform externals, install its registrations,
 * and release them with its Cordis fiber.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ConversationEventRegistry, ConversationViewRegistry, SlotRegistry,
} from '@deepseek-ai/dsh-client-runtime/client'

const PLUGIN_ID = '@younthing/dsh-client-ui-notebook'

interface Handoff {
  readonly id: string
  readonly factory: (require: (specifier: string) => unknown) => Record<string, unknown>
}

type FixtureWindow = Window & {
  __ModuleLoader__?: { load(handoff: Handoff): void }
}

function readBundle(): string | undefined {
  try {
    return readFileSync(resolve('packages/client-ui-notebook/lib/client.cjs'), 'utf8')
  } catch {
    return undefined
  }
}

afterEach(() => {
  delete (window as FixtureWindow).__ModuleLoader__
  document.querySelectorAll('style').forEach((element) => { element.remove() })
})

describe('ui-notebook tsdown client artifact', () => {
  const code = readBundle()

  async function loadArtifact() {
    let handoff: Handoff | undefined
    ;(window as FixtureWindow).__ModuleLoader__ = {
      load: (value) => { handoff = value },
    }
    // The string execution is intentional: this spec verifies the emitted
    // browser handoff exactly as ModuleLoader receives it.
    // oxlint-disable-next-line typescript/no-implied-eval, typescript/no-unsafe-call
    new Function(code!)()
    expect(handoff).toBeDefined()
    const modules = new Map<string, unknown>([
      ['react', await import('react')],
      ['react/jsx-runtime', await import('react/jsx-runtime')],
      ['@deepseek-ai/dsh-client-ui-primitives', await import('@deepseek-ai/dsh-client-ui-primitives')],
    ])
    const exports = handoff!.factory((specifier) => {
      if (!modules.has(specifier)) throw new Error(`unexpected require: ${specifier}`)
      return modules.get(specifier)
    })
    return { exports, handoff: handoff! }
  }

  it.skipIf(code === undefined)('hands off with the package manifest id and inject list', async () => {
    const { exports, handoff } = await loadArtifact()
    expect(handoff.id).toBe(PLUGIN_ID)
    expect(exports.apply).toBeTypeOf('function')
    expect(exports.inject).toEqual([
      'slots', 'conversationEvents', 'conversationViews', 'sessions', 'workspaces', 'layout', 'locale', 'remote',
    ])
  })

  it.skipIf(code === undefined)('registers and disposes its slot and projection definitions', async () => {
    const { exports } = await loadArtifact()
    const ctx = new Context()
    const slots = new SlotRegistry(ctx)
    await ctx.plugin(ConversationEventRegistry).await()
    await ctx.plugin(ConversationViewRegistry).await()
    slots.register({
      name: 'root',
      children: {
        details: { kind: 'single', scope: 'session' },
        'conversation.session.header': { kind: 'single', scope: 'session' },
      },
    } as never, () => null)
    slots.register({
      name: 'conversation.session.header',
      children: { 'conversation.session.header.actions': { kind: 'list', scope: 'session' } },
    } as never, () => null)
    ctx.provide('sessions', { binding: () => undefined })
    ctx.provide('workspaces', { archiveSession: vi.fn(async () => {}) })
    ctx.provide('layout', {
      openDetails: vi.fn(),
      closeDetails: vi.fn(),
    })
    ctx.provide('locale', { register: vi.fn(() => () => {}) })
    ctx.provide('remote', {
      notebooks: {},
      $mount: vi.fn(async () => async () => {}),
      $on: () => () => {},
    })

    const fiber = ctx.plugin(exports as { apply: (context: Context) => void })
    await fiber.await()
    const events = ctx.get('conversationEvents') as ConversationEventRegistry
    const views = ctx.get('conversationViews') as ConversationViewRegistry
    expect(slots.entries('details')).toHaveLength(1)
    expect(events.entries().map(definition => definition.kind)).toContain('notebook-event')
    expect(views.entries().map(definition => definition.target)).toEqual(['notebook'])

    await fiber.dispose()
    expect(slots.entries('details')).toEqual([])
    expect(events.entries()).toEqual([])
    expect(views.entries()).toEqual([])
  })

  it.skipIf(code === undefined)('injects package-owned CSS while the factory loads', async () => {
    await loadArtifact()
    expect(document.querySelectorAll(`style[data-plugin=${JSON.stringify(PLUGIN_ID)}]`).length)
      .toBeGreaterThan(0)
  })
})
