import type { TestInfo } from "@playwright/test"

/** The real API uses fixed one-minute Postgres counters. Separate authored
 * browser journeys into fresh windows instead of bypassing its security policy. */
export async function awaitFixtureRateWindow(info: TestInfo): Promise<void> {
  if (process.env.CENTROPY_DISPOSABLE_E2E !== "1") return
  const waitMs = 60_000 - Date.now() % 60_000 + 150
  info.annotations.push({ type: "fixture-rate-window", description: `${waitMs}ms until the canonical fixed window rolls over; limits remain unchanged` })
  await new Promise((resolve) => setTimeout(resolve, waitMs))
}
