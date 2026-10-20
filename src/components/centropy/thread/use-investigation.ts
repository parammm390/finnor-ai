"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { earliestMessageSequence, mergeConversationMessages, type LoadedConversationThread } from "./thread-contract"
import { loadInvestigation } from "./thread-api"
import { usePrivateRequestScope } from "../lib/use-private-request-scope"

interface InvestigationState {
  forThreadId: string | null
  forScope?: string
  loaded: LoadedConversationThread | null
  status: "idle" | "loading" | "ready" | "error"
  error: string | null
  olderLoading: boolean
  hasOlder: boolean
}

const EMPTY: InvestigationState = { forThreadId: null, loaded: null, status: "idle", error: null, olderLoading: false, hasOlder: false }

/** Browser state is a cache of the authenticated employee thread, never its owner. */
export function useInvestigation(threadId: string | null, enabled: boolean, refreshToken = 0) {
  const scope = usePrivateRequestScope(threadId ?? "none")
  enabled = enabled && scope.allowed
  const [state, setState] = useState<InvestigationState>(EMPTY)
  const generation = useRef(0)

  const refresh = useCallback(async () => {
    if (!threadId || !enabled) return
    const request = ++generation.current
    setState((previous) => previous.forScope === scope.key && previous.loaded?.thread.id === threadId
      ? { ...previous, forThreadId: threadId, status: "ready", error: null }
      : { ...EMPTY, forThreadId: threadId, forScope: scope.key, status: "loading" })
    try {
      const loaded = await loadInvestigation(threadId)
      if (request !== generation.current || !scope.isCurrent(scope.key)) return
      setState((previous) => {
        const sameThread = previous.forScope === scope.key && previous.loaded?.thread.id === threadId
        const messages = sameThread ? mergeConversationMessages(previous.loaded!.messages, loaded.messages) : loaded.messages
        const earliest = earliestMessageSequence(messages)
        return {
          ...previous,
          forThreadId: threadId,
          forScope: scope.key,
          loaded: { thread: loaded.thread, messages },
          status: "ready", error: null,
          // Refreshing the latest page must not forget older pages already loaded.
          hasOlder: earliest !== null && earliest > 1 && (sameThread ? previous.hasOlder : loaded.messages.length === 100),
        }
      })
    } catch (cause) {
      if (request !== generation.current || !scope.isCurrent(scope.key)) return
      setState({ ...EMPTY, forThreadId: threadId, forScope: scope.key, status: "error", error: cause instanceof Error ? cause.message : "Investigation unavailable" })
    }
  }, [enabled, threadId, scope.key, scope.isCurrent])

  useEffect(() => {
    if (!threadId || !enabled) {
      generation.current += 1
      setState(EMPTY)
      return
    }
    void refresh()
    return () => { generation.current += 1 }
  }, [enabled, refresh, refreshToken, threadId])

  const loadOlder = useCallback(async () => {
    if (!threadId || !enabled || state.loaded?.thread.id !== threadId || state.olderLoading || !state.hasOlder) return
    const earliest = earliestMessageSequence(state.loaded.messages)
    if (!earliest) return
    const request = generation.current
    setState((previous) => ({ ...previous, olderLoading: true }))
    try {
      const page = await loadInvestigation(threadId, { limit: 100, beforeSequence: earliest })
      if (request !== generation.current || !scope.isCurrent(scope.key)) return
      setState((previous) => previous.loaded?.thread.id !== threadId ? previous : ({
        ...previous, olderLoading: false,
        loaded: { thread: previous.loaded.thread, messages: mergeConversationMessages(page.messages, previous.loaded.messages) },
        hasOlder: page.messages.length === 100 && earliestMessageSequence(page.messages) !== 1,
      }))
    } catch (cause) {
      if (request !== generation.current || !scope.isCurrent(scope.key)) return
      setState({ ...EMPTY, forThreadId: threadId, forScope: scope.key, status: "error", error: cause instanceof Error ? cause.message : "Older turns unavailable" })
    }
  }, [enabled, state.hasOlder, state.loaded, state.olderLoading, threadId, scope.key, scope.isCurrent])

  // The route can change before its effect starts the next fetch. Never hand a
  // previous thread's messages, Work, or pagination state to the new route.
  const visible = enabled && state.forThreadId === threadId && state.forScope === scope.key ? state : {
    ...EMPTY,
    status: threadId && enabled ? "loading" as const : "idle" as const,
  }
  return { ...visible, refresh, loadOlder }
}
