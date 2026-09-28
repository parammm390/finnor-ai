"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { earliestMessageSequence, mergeConversationMessages, type LoadedConversationThread } from "./thread-contract"
import { loadInvestigation } from "./thread-api"

interface InvestigationState {
  forThreadId: string | null
  loaded: LoadedConversationThread | null
  status: "idle" | "loading" | "ready" | "error"
  error: string | null
  olderLoading: boolean
  hasOlder: boolean
}

const EMPTY: InvestigationState = { forThreadId: null, loaded: null, status: "idle", error: null, olderLoading: false, hasOlder: false }

/** Browser state is a cache of the authenticated employee thread, never its owner. */
export function useInvestigation(threadId: string | null, enabled: boolean, refreshToken = 0) {
  const [state, setState] = useState<InvestigationState>(EMPTY)
  const generation = useRef(0)

  const refresh = useCallback(async () => {
    if (!threadId || !enabled) return
    const request = ++generation.current
    setState((previous) => previous.loaded?.thread.id === threadId
      ? { ...previous, forThreadId: threadId, status: "ready", error: null }
      : { ...EMPTY, forThreadId: threadId, status: "loading" })
    try {
      const loaded = await loadInvestigation(threadId)
      if (request !== generation.current) return
      setState((previous) => {
        const sameThread = previous.loaded?.thread.id === threadId
        const messages = sameThread ? mergeConversationMessages(previous.loaded!.messages, loaded.messages) : loaded.messages
        const earliest = earliestMessageSequence(messages)
        return {
          ...previous,
          forThreadId: threadId,
          loaded: { thread: loaded.thread, messages },
          status: "ready", error: null,
          // Refreshing the latest page must not forget older pages already loaded.
          hasOlder: earliest !== null && earliest > 1 && (sameThread ? previous.hasOlder : loaded.messages.length === 100),
        }
      })
    } catch (cause) {
      if (request !== generation.current) return
      setState((previous) => ({ ...previous, status: "error", error: cause instanceof Error ? cause.message : "Investigation unavailable" }))
    }
  }, [enabled, threadId])

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
      if (request !== generation.current) return
      setState((previous) => previous.loaded?.thread.id !== threadId ? previous : ({
        ...previous, olderLoading: false,
        loaded: { thread: previous.loaded.thread, messages: mergeConversationMessages(page.messages, previous.loaded.messages) },
        hasOlder: page.messages.length === 100 && earliestMessageSequence(page.messages) !== 1,
      }))
    } catch (cause) {
      if (request !== generation.current) return
      setState((previous) => ({ ...previous, olderLoading: false, error: cause instanceof Error ? cause.message : "Older turns unavailable" }))
    }
  }, [enabled, state.hasOlder, state.loaded, state.olderLoading, threadId])

  // The route can change before its effect starts the next fetch. Never hand a
  // previous thread's messages, Work, or pagination state to the new route.
  const visible = state.forThreadId === threadId ? state : {
    ...EMPTY,
    status: threadId && enabled ? "loading" as const : "idle" as const,
  }
  return { ...visible, refresh, loadOlder }
}
