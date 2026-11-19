"use client"

import { useSyncExternalStore } from "react"

const serverSnapshot = { available: false, epoch: 0 }
let snapshot = serverSnapshot
const listeners = new Set<() => void>()

function update() {
  const available = navigator.onLine && document.visibilityState === "visible"
  if (available === snapshot.available) return
  snapshot = { available, epoch: snapshot.epoch + 1 }
  listeners.forEach(listener => listener())
}

function subscribe(listener: () => void) {
  if (!listeners.size) {
    window.addEventListener("online", update)
    window.addEventListener("offline", update)
    document.addEventListener("visibilitychange", update)
  }
  listeners.add(listener)
  update()
  return () => {
    listeners.delete(listener)
    if (!listeners.size) {
      window.removeEventListener("online", update)
      window.removeEventListener("offline", update)
      document.removeEventListener("visibilitychange", update)
    }
  }
}

export const getPrivateWorkspaceAvailability = () => snapshot
const getServerSnapshot = () => serverSnapshot

export function usePrivateWorkspaceAvailability() {
  return useSyncExternalStore(subscribe, getPrivateWorkspaceAvailability, getServerSnapshot)
}
