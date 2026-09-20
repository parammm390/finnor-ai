/** Install the same termination-to-drain boundary in production and disposable
 * process certification. The queue owns in-flight completion after abort. */
export function installWorkerDrainSignals(controller: AbortController): () => void {
  const beginDrain = () => controller.abort();
  process.on("SIGTERM", beginDrain);
  process.on("SIGINT", beginDrain);
  return () => {
    process.off("SIGTERM", beginDrain);
    process.off("SIGINT", beginDrain);
  };
}
