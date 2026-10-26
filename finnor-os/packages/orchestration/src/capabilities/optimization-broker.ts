import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { CapabilityEngineError } from "@finnor/tools/capabilities/python-runner";

/** The optimizer sees a single bounded loopback evaluator, never application
 * credentials. Closing waits for dispatched evaluations before owner cleanup. */
export async function withOptimizationBroker<T>(options: {
  deadlineAt: number;
  handle(path: string, body: unknown, signal: AbortSignal): Promise<unknown>;
  run(connection: { brokerUrl: string; brokerToken: string }): Promise<T>;
}): Promise<T> {
  const token = randomBytes(32).toString("hex"), controller = new AbortController();
  const pending = new Set<Promise<void>>(); let open = true;
  const server = createServer((incoming, outgoing) => {
    const handling = (async () => {
      try {
        const supplied = Buffer.from(incoming.headers.authorization ?? ""), expected = Buffer.from(`Bearer ${token}`);
        if (!open || controller.signal.aborted || supplied.length !== expected.length || !timingSafeEqual(supplied, expected) || incoming.method !== "POST") {
          outgoing.writeHead(403); outgoing.end("{}"); return;
        }
        if (pending.size) { outgoing.writeHead(429); outgoing.end("{}"); return; }
        const chunks: Buffer[] = []; let size = 0;
        for await (const part of incoming) { size += part.length; if (size > 262_144) throw new Error("BODY_LIMIT"); chunks.push(Buffer.from(part)); }
        if (!open || Date.now() >= options.deadlineAt) throw new Error("BROKER_CLOSED");
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const result = await options.handle(incoming.url ?? "", body, controller.signal);
        if (!outgoing.destroyed) { outgoing.writeHead(200, { "content-type": "application/json" }); outgoing.end(JSON.stringify(result)); }
      } catch {
        if (!outgoing.destroyed && !outgoing.headersSent) { outgoing.writeHead(422, { "content-type": "application/json" }); outgoing.end('{"code":"OPTIMIZATION_BROKER_REQUEST_REJECTED"}'); }
      }
    })();
    pending.add(handling); void handling.then(() => pending.delete(handling), () => pending.delete(handling));
  });
  server.requestTimeout = 15_000; server.headersTimeout = 5000;
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const timer = setTimeout(() => controller.abort(), Math.max(1, options.deadlineAt - Date.now()));
  try {
    const address = server.address(); if (!address || typeof address === "string") throw new CapabilityEngineError("OPTIMIZATION_BROKER_BIND_FAILED");
    return await options.run({ brokerUrl: `http://127.0.0.1:${address.port}`, brokerToken: token });
  } finally {
    open = false; controller.abort(); clearTimeout(timer); server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
    await Promise.allSettled([...pending]);
  }
}
