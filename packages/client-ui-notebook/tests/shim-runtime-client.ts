/**
 * ESM facade over the published `@deepseek-ai/dsh-client-runtime/client`
 * ModuleLoader bundle, so Vitest named imports work against the real artifact
 * while sharing the test process's Cordis and slot-registry instances.
 * @module @younthing/dsh-client-ui-notebook/tests/shim-runtime-client
 */

import { loadClientBundle } from './client-module-loader.ts'

const cordis = await import('@deepseek-ai/cordis')
const uiSlots = await import('@deepseek-ai/dsh-client-ui-slots')

/** The runtime client bundle's full factory exports. */
export const mod = await loadClientBundle<Record<string, unknown>>(
  '@deepseek-ai/dsh-client-runtime/client',
  {
    '@deepseek-ai/cordis': cordis,
    '@deepseek-ai/dsh-client-ui-slots': uiSlots,
  },
)

export const SlotRegistry = mod.SlotRegistry
export const ConversationEventRegistry = mod.ConversationEventRegistry
export const ConversationViewRegistry = mod.ConversationViewRegistry
export const ConversationNodeAssembler = mod.ConversationNodeAssembler
export const ConversationLocationIndex = mod.ConversationLocationIndex
export const conversationContextKey = mod.conversationContextKey
export const createSnapshotStore = mod.createSnapshotStore
export const defineStore = mod.defineStore
export const shallowEqual = mod.shallowEqual
export const EMPTY_CHAT_SNAPSHOT = mod.EMPTY_CHAT_SNAPSHOT
export const EMPTY_CONVERSATION_VIEWS = mod.EMPTY_CONVERSATION_VIEWS
export const SessionProvideChannel = mod.SessionProvideChannel
export const createScope = mod.createScope
export const scopeOf = mod.scopeOf
export const SessionRuntime = mod.SessionRuntime
export const SessionCreateError = mod.SessionCreateError
export const displayFailureMessage = mod.displayFailureMessage
