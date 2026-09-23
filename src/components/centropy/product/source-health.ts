export const PRODUCT_TRUTH_STATES = [
  "KNOWN",
  "KNOWN_EMPTY",
  "UNKNOWN",
  "PARTIAL",
  "STALE",
  "CONFLICTING",
  "UNAVAILABLE",
  "DENIED",
] as const

export type ProductTruthState = (typeof PRODUCT_TRUTH_STATES)[number]

export interface SourceHealthSnapshot {
  key: string
  label: string
  state: ProductTruthState
  detail: string
  lastConfirmedAt: string | null
}

export function unavailableState(error: unknown, retained: boolean): ProductTruthState {
  if (retained) return "STALE"
  const status = error && typeof error === "object" && "status" in error ? Number(error.status) : 0
  return status === 401 || status === 403 ? "DENIED" : "UNAVAILABLE"
}

export function sourceStateRank(state: ProductTruthState): number {
  return ({
    DENIED: 0,
    UNAVAILABLE: 1,
    CONFLICTING: 2,
    STALE: 3,
    PARTIAL: 4,
    UNKNOWN: 5,
    KNOWN_EMPTY: 6,
    KNOWN: 7,
  } satisfies Record<ProductTruthState, number>)[state]
}

export function aggregateSourceState(sources: readonly SourceHealthSnapshot[]): ProductTruthState {
  if (sources.length === 0) return "UNKNOWN"
  return [...sources].sort((left, right) => sourceStateRank(left.state) - sourceStateRank(right.state))[0]!.state
}

export function truthStateLabel(state: ProductTruthState): string {
  return state === "KNOWN_EMPTY" ? "KNOWN EMPTY" : state
}
