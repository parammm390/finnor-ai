/** Presentation order only: current canonical blocks remain the source of truth. */
export function reconcileCanvasOrder(preferred: string[] | null, current: string[]): string[] {
  const available = new Set(current)
  const seen = new Set<string>()
  const result: string[] = []
  for (const id of [...(preferred ?? []), ...current]) {
    if (!available.has(id) || seen.has(id)) continue
    seen.add(id)
    result.push(id)
  }
  return result
}

export function moveCanvasBlock(order: string[], id: string, direction: -1 | 1): string[] {
  const index = order.indexOf(id)
  const target = index + direction
  if (index < 0 || target < 0 || target >= order.length) return order
  const next = [...order]
  ;[next[index], next[target]] = [next[target], next[index]]
  return next
}
