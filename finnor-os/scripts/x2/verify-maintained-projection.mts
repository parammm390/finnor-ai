/** Actual maintained client codec, driven only from an authenticated native API
 * response. This is not a mounted UI proof or another success predicate. */
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const inputPath = process.argv[2];
if (!inputPath || !isAbsolute(inputPath)) throw Error("ABSOLUTE_NATIVE_PROJECTION_INPUT_REQUIRED");
const { projection, expected, exactQuantity } = JSON.parse(await readFile(inputPath, "utf8"));
const source = resolve(import.meta.dirname, "../../../src/components/centropy/canvas/application-semantics-client.ts");
const { parseApplicationProjection } = await import(pathToFileURL(source).href);
const parsed = parseApplicationProjection(projection, expected);
assert.equal(parsed.sessions[0]?.status, "COMPLETED", "CANONICAL_COMPLETED_FRESH_WORK_REQUIRED");
const session = parsed.sessions[0];
assert(session.model && session.composition, "REAL_MODEL_AND_FRESH_COMPOSITION_REQUIRED");
assert.notDeepEqual(session.model.scope.grantRef, session.composition.scope.grantRef, "ACTUAL_CHANGED_CURRENT_GRANT_REQUIRED");
assert.equal(session.composition.goal.reporting.decimal, exactQuantity);
assert.throws(() => parseApplicationProjection({ ...projection, principalId: "another-principal" }, expected));
assert(session.freshAuthority, "CANONICAL_S4_FRESH_AUTHORITY_VIEW_REQUIRED");
const wrongParent = structuredClone(projection);
wrongParent.sessions[0].freshAuthority.originalParentRef = session.model.ref;
assert.throws(() => parseApplicationProjection(wrongParent, expected));
const wrongGrant = structuredClone(projection);
const role = wrongGrant.sessions[0].freshAuthority.bindings.find((binding: { role: string }) => binding.role === session.composition!.scope.role);
assert(role);
role.currentGrantRef = role.originalGrantRef;
assert.throws(() => parseApplicationProjection(wrongGrant, expected));
assert(!JSON.stringify(projection).includes("privateProfileBinding"), "PRIVATE_BINDING_NOT_IN_AUTHENTICATED_PUBLIC_RESPONSE");
console.log(JSON.stringify({ status: "PASS", boundary: "MAINTAINED_CLIENT_CANONICAL_FRESH_WORK_PROJECTION",
  workId: parsed.workId, exactQuantity, mounted: false }));
