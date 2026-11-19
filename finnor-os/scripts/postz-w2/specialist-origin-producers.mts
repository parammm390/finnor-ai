/** Qualified root metadata service only. Never starts a business/model episode. */
import { openWorkforceSpecialistPublicationAuthority } from "../../packages/capability-evolution/src/specialist-consumer.ts";
import { createOriginalRootPublicationHooks } from "../../packages/governed-execution/src/specialist-root-collector.ts";
import {
  startOriginalOriginProducerService, type OriginalOriginProducerHooks,
} from "../../packages/governed-execution/src/specialist-origin-service.ts";
import {
  readOriginPublicConfiguration, requireOriginLinuxRoot,
} from "../../packages/governed-execution/src/specialist-origin-custody.ts";

requireOriginLinuxRoot();
const args = process.argv.slice(2);
if (args.some(value => value !== "--history-only") || args.length > 1)
  throw Error("SPECIALIST_ORIGIN_PRODUCER_ARGUMENTS");
const historyOnly = args.includes("--history-only"), stop = new AbortController();
const terminate = () => stop.abort(Error("SPECIALIST_ORIGIN_ROOT_SERVICE_STOP"));
process.once("SIGTERM", terminate); process.once("SIGINT", terminate);
let authority: Awaited<ReturnType<typeof openWorkforceSpecialistPublicationAuthority>> | null = null;
let service: Awaited<ReturnType<typeof startOriginalOriginProducerService>> | null = null;
try {
  authority = await openWorkforceSpecialistPublicationAuthority("reader", historyOnly);
  const config = await readOriginPublicConfiguration();
  let hooks: OriginalOriginProducerHooks;
  let clockPrivateKeyPath: string | undefined;
  if (historyOnly) {
    // This branch cannot issue an attempt, clock, healthy origin seal or final
    // witness. It serves only already closed, fully authenticated originals.
    hooks = {
      async onOriginalStart() { throw Error("SPECIALIST_ORIGIN_HISTORY_HAS_NO_ISSUER"); },
      async onOriginalFinalize() { throw Error("SPECIALIST_ORIGIN_HISTORY_HAS_NO_ISSUER"); },
    };
  } else {
    const guardianOriginId = process.env.FINNOR_SPECIALIST_GUARDIAN_ORIGIN_ID;
    clockPrivateKeyPath = process.env.FINNOR_SPECIALIST_CLOCK_PRIVATE_KEY;
    if (!guardianOriginId || !clockPrivateKeyPath)
      throw Error("SPECIALIST_ORIGIN_EXISTING_ROOT_GUARDIAN_AND_CLOCK_CUSTODY_REQUIRED");
    hooks = await createOriginalRootPublicationHooks({
      authority, guardianOriginId, clockPrivateKeyPath, signal: stop.signal,
    });
  }
  service = await startOriginalOriginProducerService({
    enrollment: authority.enrollment, config, signal: stop.signal, historyOnly, hooks, clockPrivateKeyPath,
  });
  await new Promise<void>(resolve => {
    if (stop.signal.aborted) resolve(); else stop.signal.addEventListener("abort", () => resolve(), { once: true });
  });
} catch {
  process.stderr.write("SPECIALIST_ORIGIN_ROOT_SERVICE_UNAVAILABLE\n");
  process.exitCode = 1;
} finally {
  stop.abort(); await service?.close().catch(() => undefined); await authority?.close().catch(() => undefined);
  process.removeListener("SIGTERM", terminate); process.removeListener("SIGINT", terminate);
}
