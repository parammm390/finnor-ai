import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { ApplicationError, authenticate, binding, publicContext, requestReadback } from "../../x2/fixtures/application.mjs";
import { hash, now, requirePrivateDir, transaction } from "../../x2/fixtures/store.mjs";
import { openApi } from "../../x2/fixtures/views.mjs";

const directory = process.argv[2];
await requirePrivateDir(directory);
const input = JSON.parse(await readFile(join(directory, "workstream-demo.private.json"), "utf8"));
const initialName = "Draft evidence scope";
const alternateName = "Additional evidence scope";
const fields = ["dealId", "workstreamId", "kind", "name", "owner"];
const nameChoices = [initialName, alternateName, input.name];
const recordTemplate = "/api/accounts/{accountId}/records/{recordId}";
const keys = (value, expected) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
if (!keys(input, fields) || !keys(input.owner, ["partyType", "partyId"])
  || [...Object.values(input).filter(value => value !== input.owner), ...Object.values(input.owner)]
    .some(value => typeof value !== "string" || !value.length || value.length > 256)
  || new Set(nameChoices).size !== nameChoices.length) throw Error("Z0_WORKSTREAM_PROVIDER_INPUT_INVALID");

const text = { type: "string" };
const named = { type: "string", enum: nameChoices };
const object = properties => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const ref = name => ({ $ref: "#/components/schemas/" + name });
const responses = schema => ({ 200: { description: "OK", content: { "application/json": { schema } } } });

function document(config) {
  const shared = openApi(config).components.schemas;
  const context = shared.Context.properties;
  const { principalId, grantId, grantRevision, ...recordContext } = context;
  return {
    openapi: "3.1.0",
    info: { title: "Disposable workstream scope", version: config.applicationVersion },
    components: { schemas: { Context: shared.Context, RequestIdentity: shared.RequestIdentity,
      Record: object({ ...recordContext, version: { type: "integer" }, dealId: text, workstreamId: text,
        kind: text, name: named, owner: object({ partyType: text, partyId: text }),
        observation: shared.Observation }) } },
    paths: {
      [recordTemplate]: { get: { responses: responses(ref("Record")) } },
      [recordTemplate + "/draft"]: { post: { operationId: "setWorkstreamName", summary: "Set workstream name",
        requestBody: { required: true, content: { "application/json": { schema: object({
          context: ref("Context"), request: ref("RequestIdentity"), expectedVersion: { type: "integer" }, name: named,
        }) } } }, responses: responses(ref("Record")) } },
    },
  };
}

function view(state, auth) {
  const { principalId, grantId, grantRevision, ...record } = binding(state, auth);
  return { ...record, ...input, version: auth.record.version, name: auth.record.workstreamDraftName ?? initialName,
    observation: { available: fields, unavailable: [] } };
}
const reject = (status, code) => { throw new ApplicationError(status, code); };
async function readJson(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 32768) reject(413, "PAYLOAD_BOUND");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { reject(400, "INVALID_JSON"); }
}

function update(state, events, auth, body) {
  const current = binding(state, auth);
  const identityFields = ["requestId", "effectId", "obligationId", "idempotencyKey", "parentId"];
  if (!keys(body, ["context", "request", "expectedVersion", "name"])
    || !keys(body.context, Object.keys(current)) || !keys(body.request, [...identityFields, "deadline"])
    || identityFields.some(key => typeof body.request[key] !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(body.request[key]))
    || !nameChoices.includes(body.name)) reject(400, "WORKSTREAM_REQUEST_INVALID");
  if (Object.keys(current).some(key => current[key] !== body.context[key])) reject(409, "CONTEXT_MISMATCH");
  const deadline = Date.parse(body.request.deadline);
  if (!Number.isFinite(deadline) || deadline <= Date.now() || deadline > Date.parse(auth.grant.expiresAt))
    reject(403, "DEADLINE_DENIED");
  const fingerprint = hash([Object.values(current), identityFields.map(key => body.request[key]),
    body.request.deadline, body.expectedVersion, body.name]);
  const prior = Object.values(state.requests).find(row =>
    identityFields.some(key => key !== "parentId" && row.request[key] === body.request[key]));
  if (prior) {
    if (prior.fingerprint !== fingerprint) reject(409, "REQUEST_IDENTITY_CONFLICT");
    return { requestId: prior.request.requestId, record: view(state, auth) };
  }
  if (!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion !== auth.record.version)
    reject(409, "RECORD_VERSION_MISMATCH");
  if (Object.keys(state.requests).length >= 128) reject(503, "REQUEST_CAPACITY_EXCEEDED");
  auth.record.workstreamDraftName = body.name;
  auth.record.version++;
  state.requests[body.request.requestId] = {
    request: body.request, context: body.context, operation: "draft", accountId: current.accountId,
    recordId: current.recordId, fingerprint, acceptedAt: now(), status: "RECORDED", reporting: null,
  };
  events.push({ type: "dispatch.accepted", operation: "draft", requestId: body.request.requestId,
    recordId: current.recordId, name: body.name, version: auth.record.version });
  return { requestId: body.request.requestId, record: view(state, auth) };
}

const server = createServer(async (request, response) => {
  const identity = {
    bearer: request.headers.authorization?.match(/^Bearer (.+)$/)?.[1],
    grantId: request.headers["x-portal-grant"],
  };
  let status = 200, result;
  try {
    const pathname = new URL(request.url, "http://127.0.0.1").pathname;
    const record = pathname.match(/^\/api\/accounts\/([A-Za-z0-9_-]+)\/records\/([A-Za-z0-9_-]+)(\/draft)?$/);
    const readback = pathname.match(/^\/api\/requests\/([A-Za-z0-9_-]+)$/);
    if (readback && request.method === "GET") {
      result = await requestReadback(directory, identity, readback[1]);
    } else if (request.method === "GET") {
      result = await transaction(directory, state => {
        const auth = authenticate(state, identity, "record.read", record?.[1], record?.[2]);
        if (pathname === "/openapi.json") return document(state.config);
        if (pathname === "/api/context") {
          const context = publicContext(state, auth);
          return { ...context, entities: context.entities.filter(entity => entity.currency === "USD") };
        }
        if (record && !record[3]) return view(state, auth);
        reject(404, "ROUTE_NOT_FOUND");
      });
    } else if (request.method === "POST" && record?.[3]) {
      const body = await readJson(request);
      result = await transaction(directory, (state, events) => {
        const auth = authenticate(state, identity, "draft.write", record[1], record[2]);
        return update(state, events, auth, body);
      });
    } else reject(404, "ROUTE_NOT_FOUND");
  } catch (error) {
    status = error instanceof ApplicationError ? error.status : 500;
    result = { error: error instanceof ApplicationError ? error.code : "WORKSTREAM_PORTAL_FAILED" };
  }
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(result));
});
server.listen(0, "127.0.0.1", () => console.log(JSON.stringify({ origin: "http://127.0.0.1:" + server.address().port })));
process.once("SIGTERM", () => { server.close(); server.closeAllConnections(); });
