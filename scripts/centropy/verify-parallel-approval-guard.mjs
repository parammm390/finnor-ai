import { createRequire } from "node:module"
import { createHash } from "node:crypto"
import { readFileSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

// Database-boundary proof only: every status update is rolled back. This never
// grants human authority, calls a provider, or certifies an executed effect.
const root = resolve(import.meta.dirname, "../..")
const { Client } = createRequire(`${root}/finnor-os/package.json`)("pg")
const url = process.env.DATABASE_URL
if (!url || !["127.0.0.1", "localhost"].includes(new URL(url).hostname)) throw new Error("Use the disposable localhost database")
const actionId = process.argv[2]
const output = process.argv[3]
if (!/^[a-f0-9-]{36}$/.test(actionId ?? "") || !output) throw new Error("Provide the actual pending action UUID and proof path")
const hash = (value) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex")
const db = new Client({ connectionString: url })
await db.connect()
const snapshot = async () => (await db.query(`SELECT a.id,a.status,a.business_effect_id,a.plan_revision_id,a.plan_node_id,
  s.id AS step_id,s.objective_loop_id,s.objective_revision,s.execution_state,s.iteration_outcome,s.completed_at,
  l.revision,l.state AS loop_state,w.id AS work_id,w.status AS work_status,p.status AS plan_status
  FROM finnor_os.domain_actions a JOIN finnor_os.work_objective_steps s ON s.id=a.objective_step_id
  JOIN finnor_os.work_objective_loops l ON l.id=s.objective_loop_id
  JOIN finnor_os.works w ON w.id=a.work_id JOIN finnor_os.work_plan_revisions p ON p.id=a.plan_revision_id
  WHERE a.id=$1`, [actionId])).rows[0]
const before = await snapshot()
if (!before || before.status !== "pending" || before.plan_status !== "active" || before.iteration_outcome !== "awaiting_approval") throw new Error("Proof requires the actual active pending specialist approval wait")
const cases = [
  ...["continue", "waiting", "awaiting_approval"].map((state) => ({ name: `exact wait with Objective ${state}`, accepted: true, sql: "UPDATE finnor_os.work_objective_loops SET state=$1 WHERE id=$2", params: [state, before.objective_loop_id] })),
  ...["blocked", "failed", "cancelled"].map((state) => ({ name: `inactive Objective ${state}`, accepted: false, sql: "UPDATE finnor_os.work_objective_loops SET state=$1 WHERE id=$2", params: [state, before.objective_loop_id] })),
  { name: "changed Objective generation", accepted: false, sql: "UPDATE finnor_os.work_objective_loops SET revision=revision+1 WHERE id=$1", params: [before.objective_loop_id] },
  { name: "superseded PlanRevision", accepted: false, sql: "UPDATE finnor_os.work_plan_revisions SET status='superseded' WHERE id=$1", params: [before.plan_revision_id] },
  { name: "terminal Work", accepted: false, sql: "UPDATE finnor_os.works SET status='failed' WHERE id=$1", params: [before.work_id] },
  { name: "failed specialist", accepted: false, sql: "UPDATE finnor_os.work_objective_steps SET execution_state='failed' WHERE id=$1", params: [before.step_id] },
  { name: "finished ordinary step", accepted: false, sql: "UPDATE finnor_os.work_objective_steps SET execution_state='completed',iteration_outcome='continue' WHERE id=$1", params: [before.step_id] },
]
const observed = []
try {
  for (const item of cases) {
    await db.query("BEGIN")
    let accepted = false
    let rejection = null
    try {
      await db.query("SELECT id FROM finnor_os.works WHERE id=$1 FOR UPDATE", [before.work_id])
      await db.query(item.sql, item.params)
      await db.query("UPDATE finnor_os.domain_actions SET status='executing' WHERE id=$1", [actionId])
      accepted = true
    } catch (error) { rejection = error.message }
    finally { await db.query("ROLLBACK") }
    observed.push({ name: item.name, expectedAccepted: item.accepted, accepted, rejection, change: { sql: item.sql, parameters: item.params }, rolledBack: true })
    if (accepted !== item.accepted || (!accepted && !rejection?.startsWith("objective action execution refused"))) throw new Error(`Unexpected boundary result: ${item.name}: ${rejection}`)
  }
  const after = await snapshot()
  if (hash(before) !== hash(after)) throw new Error("Canonical rows changed during rollback-only proof")
  const proof = { schema: "centropy.parallel-approval-guard-proof/v1", status: "PASS_DATABASE_BOUNDARY", completedAt: new Date().toISOString(),
    scope: "Rollback-only trigger checks on a real pending specialist action; no approval or provider execution claimed", input: before,
    migration: { name: "0149_parallel_objective_approval_guard.sql", sha256: hash(readFileSync(`${root}/finnor-os/packages/db/migrations/0149_parallel_objective_approval_guard.sql`, "utf8")) },
    cases: observed, unchanged: { beforeSha256: hash(before), afterSha256: hash(after) },
    reproduce: { command: `DATABASE_URL=<disposable-local-admin-url> node scripts/centropy/verify-parallel-approval-guard.mjs ${actionId} ${output}`, precondition: "Same action remains pending in its active specialist approval wait" } }
  mkdirSync(resolve(output, ".."), { recursive: true })
  writeFileSync(output, JSON.stringify(proof, null, 2) + "\n")
  console.log(JSON.stringify({ status: proof.status, cases: observed.length, unchanged: true, output }))
} finally { await db.end() }
