"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { earliestMessageSequence, mergeConversationMessages, type LoadedConversationThread } from "./thread-contract"
import { loadInvestigation } from "./thread-api"
import { usePrivateRequestScope } from "../lib/use-private-request-scope"

export interface InvestigationState {
  forThreadId: string | null
  forScope?: string
  loaded: LoadedConversationThread | null
  status: "idle" | "loading" | "ready" | "error"
  error: string | null
  olderLoading: boolean
  olderError: string | null
  hasOlder: boolean
}

const EMPTY: InvestigationState = { forThreadId: null, loaded: null, status: "idle", error: null, olderLoading: false, olderError: null, hasOlder: false }

/** A failed history fetch is not failure of the already-loaded conversation.
 * Authentication / thread revocation is different: purge previously loaded
 * private turns rather than leaving revoked content visible.
 */
export function olderPageFailureState(
  previous: InvestigationState,
  threadId: string,
  scopeKey: string,
  cause: unknown,
): InvestigationState {
  if (previous.forThreadId !== threadId || previous.forScope !== scopeKey || previous.loaded?.thread.id !== threadId) return previous
  const status = cause && typeof cause === "object" && "status" in cause ? (cause as { status?: unknown }).status : null
  if (status === 401 || status === 403 || status === 404) {
    return { ...EMPTY, forThreadId: threadId, forScope: scopeKey, status: "error", error: "Investigation access is no longer available" }
  }
  return {
    ...previous,
    status: "ready",
    olderLoading: false,
    olderError: cause instanceof Error ? cause.message : "Older turns unavailable",
  }
}

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
      ? { ...previous, forThreadId: threadId, status: "ready", error: null, olderLoading: false, olderError: null }
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
          status: "ready", error: null, olderError: null,
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
    setState((previous) => ({ ...previous, olderLoading: true, olderError: null }))
    try {
      const page = await loadInvestigation(threadId, { limit: 100, beforeSequence: earliest })
      if (request !== generation.current || !scope.isCurrent(scope.key)) return
      setState((previous) => previous.loaded?.thread.id !== threadId ? previous : ({
        ...previous, olderLoading: false, olderError: null,
        loaded: { thread: previous.loaded.thread, messages: mergeConversationMessages(page.messages, previous.loaded.messages) },
        hasOlder: page.messages.length === 100 && earliestMessageSequence(page.messages) !== 1,
      }))
    } catch (cause) {
      if (request !== generation.current || !scope.isCurrent(scope.key)) return
      setState((previous) => olderPageFailureState(previous, threadId, scope.key, cause))
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
