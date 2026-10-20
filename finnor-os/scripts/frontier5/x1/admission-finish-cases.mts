import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Independent offline invariants for the six owner-admission repairs, frozen in
// reference/admission-finish-contract.md before any repair. Each observation
// records the actual defective excerpt on failure; runtime proof stays with
// the live owner stage.

const read = (path: string): string => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const admission = read("../../../packages/private-equity/src/institution-program/owner-admission.ts");
const barrel = read("../../../packages/private-equity/src/index.ts");
const authority = read("../../../packages/private-equity/src/institution-program/source-authority.ts");
const installed = read("../../../packages/private-equity/src/institution-program/installed-source.ts");
const migration = read("../../../packages/db/migrations/0172_x1_institution_source_authority.sql");
const sourceLocks=read('../../../packages/private-equity/src/institution-program/source-locks.ts');
const scopedLockMigration=read('../../../packages/db/migrations/0184_x1_scoped_source_authority_locks.sql');
const bundle = read("../../../packages/db/migrations-bundle.ts");
const packet = read("./reference/owner-live-packet.md");

const excerpt = (text: string, needle: string, span = 160): string => {
  const at = text.indexOf(needle);
  return at < 0 ? "<absent>" : text.slice(Math.max(0, at - 40), at + span).replace(/\s+/g, " ").trim();
};
const before = (text: string, marker: string, span: number): string => {
  const at = text.indexOf(marker);
  assert.notEqual(at, -1, `marker ${marker} missing entirely`);
  return text.slice(Math.max(0, at - span), at);
};

const observations: Record<string, string> = {};
const check = (name: string, fn: () => void): void => {
  try {
    fn();
    observations[name] = "HELD";
  } catch (error) {
    observations[name] = `VIOLATED: ${(error as Error).message}`;
  }
};

check("seam-closed", () => {
  const exports = barrel.split("\n").filter((line) =>
    /^\s*export\s/.test(line) && line.includes("admitCheckedInstitutionMappings"));
  assert.deepEqual(exports, [], `barrel still exports the seam: ${exports.join(" | ")}`);
  assert.equal(admission.includes("export async function admitCheckedInstitutionMappings"), false,
    "owner-admission.ts still exports the seam");
});

check("rehydrated-write-inputs", () => {
  const start = admission.indexOf("function admitCheckedInstitutionMappings");
  assert.notEqual(start, -1, "admission function missing");
  const body = admission.slice(start);
  assert.equal(/\bretained\b/.test(body), false,
    `caller retained array still read inside admission: ${excerpt(body, "retained")}`);
  assert.ok(body.includes("rereadSources"), "admission does not rehydrate owner sources");
  assert.ok(body.includes("sources.find("), "write inputs do not resolve from rehydrated sources");
});

check("publication-grant-relock", () => {
  const sql = before(admission, "X1_SOURCE_GRANT_CHANGED_DURING_PUBLICATION", 900);
  if(!sql.includes('FOR SHARE')){
    // PostgreSQL requires UPDATE privilege for direct FOR SHARE. The current
    // app role has no authority-table DML. Trace the scoped SQL owner without
    // weakening the original row-lock, identity or currentness requirements.
    const transaction=admission.slice(admission.indexOf('return peTransaction(ctx, async (db, client) =>'));
    assert.ok(transaction.includes('await lockInstitutionSourceAuthority(ctx,client,original.workId,sources.map(source=>source.grantId))'),
      'publication does not lock its complete rehydrated grant population');
    assert.ok(sourceLocks.includes('SELECT finnor_os.x1_lock_source_authority($1,$2::uuid[])'),
      'scoped TypeScript lock does not reach the actual SQL owner');
    const owner=scopedLockMigration.slice(0,scopedLockMigration.indexOf('REVOKE ALL ON FUNCTION finnor_os.x1_lock_source_authority'));
    assert.ok(owner.includes('SECURITY DEFINER')&&owner.includes('work.created_by=u')&&owner.includes("actor.status='active'"),
      'SQL locking owner lacks current principal/Work scope');
    assert.ok(/FROM finnor_os\.x1_source_grants g\s+WHERE g\.tenant_id=t AND g\.work_id=w AND g\.principal_id=u\s+AND g\.id=ANY\(grant_ids\) FOR SHARE OF g/.test(owner),
      'SQL locking owner lacks exact tenant/principal/Work/grant row locks');
    assert.ok(transaction.indexOf('await lockInstitutionSourceAuthority')<transaction.indexOf('SELECT 1 FROM finnor_os.x1_source_grants'),
      'scoped locks are taken after the final grant predicate');
  }
  assert.ok(/revision=\$\d/.test(sql), `relock lacks revision equality: ${excerpt(sql, "x1_source_grants")}`);
  assert.ok(/original_sha256=\$\d/.test(sql), `relock lacks digest equality: ${excerpt(sql, "x1_source_grants")}`);
  assert.ok(sql.includes("NOT EXISTS"), `relock lacks the not-superseded predicate: ${excerpt(sql, "x1_source_grants")}`);
});

check("owner-knowledge-cut", () => {
  assert.equal(admission.includes("knowledgeCut: new Date().toISOString()"), false,
    `caller-controllable wall-clock cut remains: ${excerpt(admission, "knowledgeCut: new Date()")}`);
  assert.equal(admission.includes("knowledgeCut = original.knowledgeCut"), false,
    `fresh owner read cut is still overwritten by caller input: ${excerpt(admission, "knowledgeCut = original.knowledgeCut")}`);
  assert.ok(admission.includes("retainedAt"), "admission cut does not bind to server-side retention facts");
  assert.ok(authority.includes("retainedAt"), "acquisition does not expose a server-side retention time");
});

check("replay-source-truth-readback", () => {
  const replay = admission.slice(admission.indexOf("X1_ADMISSION_REPLAY_DIGEST_MISMATCH"),
    admission.indexOf("X1_ORIGINAL_OR_CURRENT_OWNER_CUT_MISMATCH"));
  const helperStart=admission.indexOf('export async function assertInstitutionMappingReceiptsCurrent(');
  assert.ok(helperStart>=0,'shared receipt verifier missing');
  const verifier=admission.slice(helperStart,admission.indexOf('async function admitCheckedInstitutionMappings'));
  assert.ok(replay.includes('await assertInstitutionMappingReceiptsCurrent(ctx, current.original.canonical.entities.map(entity => entity.ref), prior.rows[0].receipts)'),
    'replay must await the shared verifier on current owner refs and stored receipts');
  assert.ok(verifier.includes("receipt.sourceTruthLinkId"), "replay never re-reads the Source Truth link");
  assert.ok(verifier.includes("external_refs"), "replay Source Truth check does not read the owner link table");
  assert.ok(verifier.includes("X1_ADMISSION_REPLAY_SOURCE_TRUTH_CHANGED"),
    "replay Source Truth mismatch has no named refusal");
});

check("receipt-write-least-privilege", () => {
  assert.equal(/GRANT SELECT,INSERT ON finnor_os\.x1_source_acquisitions/.test(migration), false,
    `raw acquisition INSERT still granted: ${excerpt(migration, "x1_source_acquisitions TO finnor_app")}`);
  assert.equal(/GRANT SELECT,INSERT ON finnor_os\.x1_mapping_admissions/.test(migration), false,
    `raw admission INSERT still granted: ${excerpt(migration, "x1_mapping_admissions TO finnor_app")}`);
  for (const fn of ["x1_record_source_acquisition", "x1_publish_mapping_admission"]) {
    assert.ok(migration.includes(`CREATE FUNCTION finnor_os.${fn}(`), `${fn} writer function missing`);
    assert.ok(migration.includes(`REVOKE ALL ON FUNCTION finnor_os.${fn}`), `${fn} PUBLIC execute not revoked`);
    assert.ok(migration.includes(`GRANT EXECUTE ON FUNCTION finnor_os.${fn}`), `${fn} not granted to finnor_app`);
  }
  const acquisitionFn = migration.slice(migration.indexOf("x1_record_source_acquisition("));
  assert.ok(acquisitionFn.includes("SECURITY DEFINER"), "acquisition writer is not SECURITY DEFINER");
  assert.ok(acquisitionFn.includes("NOT EXISTS"), "acquisition writer does not reject superseded grants");
  assert.ok(acquisitionFn.includes("original_sha256"), "acquisition writer does not cross-check the grant digest");
  assert.equal(installed.includes("INSERT INTO finnor_os.x1_source_acquisitions"), false,
    "installed retention still performs a raw acquisition INSERT");
  assert.equal(admission.includes("INSERT INTO finnor_os.x1_mapping_admissions"), false,
    "publication still performs a raw admission INSERT");
  assert.ok(bundle.includes("x1_record_source_acquisition") && bundle.includes("x1_publish_mapping_admission"),
    "generated migrations bundle does not carry the writer functions");
});

check("publication-consent-active-subject", () => {
  const sql = before(admission, "X1_SENSITIVE_CONSENT_CHANGED", 1200);
  assert.ok(sql.includes("finnor_os.users"), `consent recheck never joins the user owner: ${excerpt(sql, "x1_subject_consents")}`);
  assert.ok(sql.includes("u.status='active'"), `consent recheck drops the active-subject predicate: ${excerpt(sql, "x1_subject_consents")}`);
});

check("schema-pin-documented", () => {
  assert.ok(packet.includes("X1_AUTHORITY_SCHEMA_NOT_INSTALLED"), "packet omits the fail-closed pin refusal");
  assert.ok(/schema pin/i.test(packet), "packet omits the schema pin update step");
  assert.ok(packet.includes("latest applied migration"), "packet omits the latest-migration condition");
});

console.log(JSON.stringify({ basis: "offline admission-finish contract, development-only", observations }));
for (const [name, observed] of Object.entries(observations)) {
  assert.equal(observed, "HELD", `${name}: ${observed}`);
}
