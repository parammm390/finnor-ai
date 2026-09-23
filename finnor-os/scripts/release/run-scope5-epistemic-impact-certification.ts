import EmbeddedPostgres from "embedded-postgres";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { strict as assert } from "node:assert";
import { performance } from "node:perf_hooks";
import { migrate, type MigrationFile } from "../../packages/db/migrate";
import { CURRENT_MIGRATION_HEAD } from "../../packages/db/migration-head";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { closePool } from "@finnor/db";
import { activateDurableEpistemicImpact, baselineDurableEpistemicGraph, compareDurableShadowWithOracle,
  durableDeterministicValueHash, pinCurrentEpistemicRequirements, processDurableEpistemicChange,
  replayDurableEpistemicGraph, scanDueEpistemicFreshness, setEpistemicKillSwitch,
  stageDurableEpistemicGraph } from "@finnor/epistemic-runtime";
import { EPISTEMIC_HEURISTIC_VERSION } from "@finnor/epistemic-runtime";
import { appendEvidenceAndRecompute, appendEvidenceIncrementally, createEpistemicState,
  propositionSemanticFingerprint, type EpistemicState, type EvidenceRecord, type PropositionDefinition } from "@finnor/epistemic-runtime";
import { testEvidence, testDefinition, TEST_NOW, TEST_TENANT } from "../../packages/epistemic-runtime/src/test-support";
import { comparePrivateEquityOutcomeAssessment, prepareTenantPrivateEquityEpistemicGraph,
  satisfyClosingCondition } from "@finnor/private-equity";
import { causalReplayProjection } from "@finnor/read-models";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)),"../..");
const REPORT_JSON = resolve(REPO,"docs/release/scope5-epistemic-impact-certification.json");
const REPORT_MD = resolve(REPO,"docs/release/scope5-epistemic-impact-certification.md");
type Gate = { id: string; status: "PASS_INTEGRATION" | "BLOCKED_EXTERNAL"; evidence: string };
type BenchmarkResult = { scenario:string; propositions:number; fullMedianMs:number; incrementalMedianMs:number;
  fullEvaluations:number; incrementalEvaluations:number; equivalent:boolean };
const gates: Gate[] = [];
const benchmarks: BenchmarkResult[] = [];
function pass(id: string, evidence: string): void { gates.push({ id,status:"PASS_INTEGRATION",evidence }); }

async function migrationFiles(): Promise<MigrationFile[]> {
  const directory = resolve(REPO,"packages/db/migrations");
  return Promise.all((await readdir(directory)).filter((name) => name.endsWith(".sql")).sort()
    .map(async (name) => ({ name,sql:await readFile(join(directory,name),"utf8") })));
}

async function freePort(): Promise<number> {
  return new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("port unavailable"));
      server.close(() => resolvePort(address.port));
    });
  });
}

async function withDatabase<T>(name: string, run: (url: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), `finnor-scope5-${name}-`));
  const port = await freePort();
  const postgres = new EmbeddedPostgres({ databaseDir: directory,user:"finnor",password:"finnor",
    port,persistent:false,onLog:() => undefined });
  process.env.FINNOR_TEST_MANAGED_EXTENSIONS = "omit";
  try {
    await postgres.initialise(); await postgres.start(); await postgres.createDatabase("scope5");
    const url = `postgres://finnor:finnor@127.0.0.1:${port}/scope5`;
    process.env.DATABASE_URL = url;
    return await run(url);
  } finally {
    await closePool().catch(() => undefined);
    await postgres.stop().catch(() => undefined);
    await rm(directory,{recursive:true,force:true});
  }
}

async function populatedUpgrade(): Promise<void> {
  await withDatabase("upgrade",async (url) => {
    const files = await migrationFiles();
    const prior = files.filter((file) => file.name < "0140_scope5_epistemic_impact.sql");
    assert.equal(prior.at(-1)?.name,"0139_scope4_pe_digital_twin.sql");
    await migrate(url,prior);
    const tenantId = randomUUID(); const userId = randomUUID(); const sourceId = randomUUID(); const companyId = randomUUID();
    const client = new pg.Client({ connectionString:url }); await client.connect();
    let before: unknown;
    try {
      await client.query("SET app.test_vertical_mode='explicit'");
      await client.query("INSERT INTO finnor_os.tenants(id,name) VALUES($1,'Scope 5 populated upgrade')",[tenantId]);
      await client.query("SELECT set_config('app.tenant_id',$1,false),set_config('app.user_id',$2,false)",[tenantId,userId]);
      await client.query("SELECT * FROM finnor_os.configure_tenant_vertical($1,'private_equity',0,$2,'certification:scope5',NULL)",[tenantId,userId]);
      await client.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status,display_name) VALUES($1,$2,'scope5-upgrade@test.invalid','owner','active','Upgrade owner')",[userId,tenantId]);
      await client.query("INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind) VALUES($1,$2,'scope5-upgrade-target','Existing target','other')",[companyId,tenantId]);
      await client.query("INSERT INTO finnor_os.evidence_sources(id,scope,tenant_id,source_key,source_type,title) VALUES($1,'tenant',$2,'scope5-upgrade-source','manual','Existing evidence')",[sourceId,tenantId]);
      await client.query("INSERT INTO finnor_os.evidence_source_versions(source_id,scope,tenant_id,version_number,content_hash,content,snapshot,as_of) VALUES($1,'tenant',$2,1,$3,'existing',$4,clock_timestamp())",
        [sourceId,tenantId,"e".repeat(64),{rating:"good"}]);
      before = (await client.query(`SELECT row_to_json(o) organization,
        (SELECT row_to_json(v) FROM finnor_os.evidence_source_versions v WHERE v.source_id=$2) evidence
        FROM finnor_os.external_organizations o WHERE o.id=$1`,[companyId,sourceId])).rows[0];
    } finally { await client.end(); }
    const applied = await migrate(url,files);
    assert.deepEqual(applied,["0140_scope5_epistemic_impact.sql",CURRENT_MIGRATION_HEAD]);
    const verify = new pg.Client({ connectionString:url }); await verify.connect();
    try {
      await verify.query("SELECT set_config('app.tenant_id',$1,false),set_config('app.user_id',$2,false)",[tenantId,userId]);
      const after = (await verify.query(`SELECT row_to_json(o) organization,
        (SELECT row_to_json(v) FROM finnor_os.evidence_source_versions v WHERE v.source_id=$2) evidence
        FROM finnor_os.external_organizations o WHERE o.id=$1`,[companyId,sourceId])).rows[0];
      assert.deepEqual(after,before);
      const noFabrication = await verify.query<{graph_count:number;change_count:number;changeset_count:number;calibration_count:number}>(
        `SELECT (SELECT count(*)::int FROM finnor_os.epistemic_graph_versions) graph_count,
          (SELECT count(*)::int FROM finnor_os.epistemic_changes) change_count,
          (SELECT count(*)::int FROM finnor_os.epistemic_changesets) changeset_count,
          (SELECT count(*)::int FROM finnor_os.epistemic_calibration_assessments) calibration_count`);
      assert.deepEqual(noFabrication.rows[0],{graph_count:0,change_count:0,changeset_count:0,calibration_count:0});
      const propositionId = `upgrade:rating:${sourceId}`;
      const staged = await stageDurableEpistemicGraph({tenantId,ruleVersion:"scope5-materiality-v1",
        heuristicVersion:EPISTEMIC_HEURISTIC_VERSION,
        propositions:[{id:propositionId,subject:{kind:"entity",type:"test",id:sourceId},predicate:{name:"rating"}}],
        dependencies:[],bindings:[{propositionId,sourceKind:"evidence_source",sourceType:"manual",sourceId,
          valuePath:"rating",evidenceKind:"DOCUMENT"}]});
      const replay = await replayDurableEpistemicGraph({tenantId,graphVersionId:staged.graphVersionId,
        validAt:new Date(0).toISOString(),knownAt:new Date(0).toISOString()});
      assert.equal(replay.status,"UNAVAILABLE_BEFORE_BASELINE");
      assert.equal((await baselineDurableEpistemicGraph(tenantId)).complete,true);
      pass("populated-upgrade",`0139→0140→0141 preserved existing canonical/evidence rows; new epistemic tables empty until explicit baseline; pre-baseline replay unavailable`);
    } finally { await verify.end(); }
  });
}

async function calibrationHistory(): Promise<void> {
  await withDatabase("calibration",async (url) => {
    await migrate(url);
    const tenantId=randomUUID(),userId=randomUUID(),companyId=randomUUID(),dealId=randomUUID(),caseId=randomUUID();
    const decisionId=randomUUID(),actionId=randomUUID(),sourceId=randomUUID(),workId=randomUUID(),inputId=randomUUID(),planId=randomUUID();
    const client=new pg.Client({connectionString:url}); await client.connect();
    try {
      await client.query("SET app.test_vertical_mode='explicit'");
      await client.query("INSERT INTO finnor_os.tenants(id,name) VALUES($1,'Scope 5 calibration')",[tenantId]);
      await client.query("SELECT set_config('app.tenant_id',$1,false),set_config('app.user_id',$2,false)",[tenantId,userId]);
      await client.query("SELECT * FROM finnor_os.configure_tenant_vertical($1,'private_equity',0,$2,'certification:scope5',NULL)",[tenantId,userId]);
      await client.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status,display_name) VALUES($1,$2,'scope5-calibration@test.invalid','owner','active','Calibration owner')",[userId,tenantId]);
      await client.query("INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind) VALUES($1,$2,'scope5-calibration-target','Calibration target','other')",[companyId,tenantId]);
      await client.query(`INSERT INTO finnor_os.pe_deals
        (id,tenant_id,target_organization_id,name,deal_lead_employee_id,signed_loi_at,target_closing_at,source_system,external_id,created_by)
        VALUES($1,$2,$3,'Calibration Deal',$4,now(),now()+interval '30 days','certification:scope5','calibration-deal',$5)`,
        [dealId,tenantId,companyId,userId,userId]);
      await client.query(`INSERT INTO finnor_os.pe_investment_cases
        (id,tenant_id,deal_id,title,source_system,external_id,created_by)
        VALUES($1,$2,$3,'Calibration Case','certification:scope5','calibration-case',$4)`,[caseId,tenantId,dealId,userId]);
      await client.query(`INSERT INTO finnor_os.pe_decisions
        (id,tenant_id,deal_id,investment_case_id,decision_type,title,decision,source_system,external_id,created_by)
        VALUES($1,$2,$3,$4,'investment','Proceed','Proceed on assessed facts','certification:scope5',$5,$6)`,
        [decisionId,tenantId,dealId,caseId,actionId,userId]);
      await client.query("INSERT INTO finnor_os.evidence_sources(id,scope,tenant_id,source_key,source_type,title) VALUES($1,'tenant',$2,'calibration-source','manual','Calibration evidence')",[sourceId,tenantId]);
      await client.query("INSERT INTO finnor_os.evidence_source_versions(source_id,scope,tenant_id,version_number,content_hash,content,snapshot,as_of) VALUES($1,'tenant',$2,1,$3,'good',$4,clock_timestamp())",
        [sourceId,tenantId,"1".repeat(64),{rating:"good"}]);
      const propositionId=`calibration:rating:${sourceId}`;
      await stageDurableEpistemicGraph({tenantId,ruleVersion:"scope5-materiality-v1",heuristicVersion:EPISTEMIC_HEURISTIC_VERSION,
        propositions:[{id:propositionId,subject:{kind:"entity",type:"test",id:sourceId},predicate:{name:"rating"}}],
        dependencies:[],bindings:[{propositionId,sourceKind:"evidence_source",sourceType:"manual",sourceId,valuePath:"rating",evidenceKind:"DOCUMENT"}]});
      assert.equal((await baselineDurableEpistemicGraph(tenantId)).complete,true);
      await client.query("INSERT INTO finnor_os.works(id,tenant_id,status,initial_channel,initial_instruction,created_by) VALUES($1,$2,'executing','console','Calibration plan',$3)",[workId,tenantId,userId]);
      await client.query("INSERT INTO finnor_os.work_inputs(id,tenant_id,work_id,instruction_id,channel,instruction_text,created_by) VALUES($1,$2,$3,$4,'console','Calibration plan',$5)",
        [inputId,tenantId,workId,randomUUID(),userId]);
      const planHash=`sha256:${"f".repeat(64)}`;
      const planGraph={version:1,semanticHash:planHash,nodes:[{id:"decision-node",kind:"action",actionType:"record_decision",payload:{}}],edges:[]};
      await client.query(`INSERT INTO finnor_os.work_plan_revisions
        (id,tenant_id,work_id,work_input_id,revision,reason,goal_spec,constraint_set,planning_snapshot,
         candidate_summary,validation,plan_graph,score,goal_hash,constraint_hash,world_snapshot_hash,graph_hash,semantic_hash)
        VALUES($1,$2,$3,$4,1,'initial',$5,$5,$5,'{}',$5,$6,'{}',$7,$7,$7,$7,$7)`,
        [planId,tenantId,workId,inputId,{version:1,semanticHash:planHash},planGraph,planHash]);
      const pin=await pinCurrentEpistemicRequirements({tenantId,planRevisionId:planId,planNodeId:"decision-node",actionType:"record_decision",
        requirements:[{propositionId,expectedValues:["good"],mandatory:true,acceptableStatuses:["KNOWN"],
          minimumAuthority:["DURABLE_EVIDENCE"],minimumConfidence:"MEDIUM"}]});
      assert.equal(pin.pinned.length,1);
      await client.query(`INSERT INTO finnor_os.domain_actions
        (id,tenant_id,action_type,payload,status,summary,work_id,plan_revision_id,plan_node_id,initiated_by)
        VALUES($1,$2,'record_decision','{}','draft','Calibration decision',$3,$4,'decision-node',$5)`,
        [actionId,tenantId,workId,planId,userId]);
      await client.query(`UPDATE finnor_os.pe_decisions SET state='final',decided_by_party_type='employee',
        decided_by_party_id=$3,decided_at=clock_timestamp(),version=version+1 WHERE tenant_id=$1 AND id=$2`,[tenantId,decisionId,userId]);
      const assessment=(await client.query<{id:string;assessment_hash:string;belief_value_hash:string}>(
        "SELECT id,assessment_hash,belief_value_hash FROM finnor_os.epistemic_calibration_assessments WHERE tenant_id=$1 AND decision_id=$2",
        [tenantId,decisionId])).rows;
      assert.equal(assessment.length,1);
      assert.equal(assessment[0]!.belief_value_hash,durableDeterministicValueHash("good"));
      const version2=(await client.query<{id:string}>(
        "INSERT INTO finnor_os.evidence_source_versions(source_id,scope,tenant_id,version_number,content_hash,content,snapshot,as_of) VALUES($1,'tenant',$2,2,$3,'bad',$4,clock_timestamp()) RETURNING id",
        [sourceId,tenantId,"2".repeat(64),{rating:"bad"}])).rows[0]!.id;
      const outcomeId=(await client.query<{id:string}>(`INSERT INTO finnor_os.pe_outcomes
        (tenant_id,subject_type,subject_id,decision_id,outcome_type,description,observed_value,valid_from,
         evidence_source_id,evidence_version_id,source_system,external_id,created_by,observed_at)
        VALUES($1,'external_organization',$2,$3,'rating','Later rating',$4,clock_timestamp(),
         $5,$6,'certification:scope5','calibration-outcome',$7,clock_timestamp()) RETURNING id`,
        [tenantId,companyId,decisionId,{rating:"bad"},sourceId,version2,userId])).rows[0]!.id;
      const comparison=await comparePrivateEquityOutcomeAssessment({auth:{tenantId,userId,role:"owner"}},
        {assessmentId:assessment[0]!.id,outcomeId,valuePath:"rating"});
      assert.equal(comparison.comparison,"CONTRADICTED");
      assert.equal(comparison.idempotent,false);
      const duplicate=await comparePrivateEquityOutcomeAssessment({auth:{tenantId,userId,role:"owner"}},
        {assessmentId:assessment[0]!.id,outcomeId,valuePath:"rating"});
      assert.equal(duplicate.idempotent,true);
      const original=(await client.query<{assessment_hash:string}>(
        "SELECT assessment_hash FROM finnor_os.epistemic_calibration_assessments WHERE tenant_id=$1 AND id=$2",
        [tenantId,assessment[0]!.id])).rows[0]!.assessment_hash;
      assert.equal(original,assessment[0]!.assessment_hash);
      pass("outcome-calibration",`Final PE Decision froze one exact Plan-pinned assessment; later Outcome comparison was contradicted and idempotent without modifying the assessment`);
    } finally { await client.end(); }
  });
}

async function freshnessPropagation(): Promise<void> {
  await withDatabase("freshness",async (url) => {
    await migrate(url);
    const tenantId=randomUUID(),sourceId=randomUUID(),rootId=`fresh:root:${sourceId}`,childId=`fresh:child:${sourceId}`;
    const client=new pg.Client({connectionString:url}); await client.connect();
    try {
      await client.query("INSERT INTO finnor_os.tenants(id,name) VALUES($1,'Scope 5 freshness')",[tenantId]);
      await client.query("INSERT INTO finnor_os.evidence_sources(id,scope,tenant_id,source_key,source_type,title) VALUES($1,'tenant',$2,'freshness-source','manual','Freshness source')",[sourceId,tenantId]);
      await client.query("INSERT INTO finnor_os.evidence_source_versions(source_id,scope,tenant_id,version_number,content_hash,content,snapshot,as_of) VALUES($1,'tenant',$2,1,$3,'fresh',$4,clock_timestamp())",
        [sourceId,tenantId,"6".repeat(64),{rating:"good"}]);
      await stageDurableEpistemicGraph({tenantId,ruleVersion:"scope5-materiality-v1",heuristicVersion:EPISTEMIC_HEURISTIC_VERSION,
        propositions:[
          {id:rootId,subject:{kind:"entity",type:"test",id:sourceId},predicate:{name:"rating"}},
          {id:childId,subject:{kind:"entity",type:"test",id:sourceId},predicate:{name:"fresh.rating.good",derivation:{
            ruleId:"scope5-cert-fresh",version:"v1",owner:"@finnor/epistemic-runtime",
            expression:{op:"require",propositionId:rootId,expectedValueHashes:[durableDeterministicValueHash("good")],
              acceptableStatuses:["KNOWN"]}}},dependencyRefs:[rootId]},
        ],dependencies:[{id:`dep:${childId}`,propositionId:childId,dependsOnPropositionId:rootId,kind:"DERIVED_FROM"}],
        bindings:[{propositionId:rootId,sourceKind:"evidence_source",sourceType:"manual",sourceId,valuePath:"rating",
          evidenceKind:"DOCUMENT",maxAgeMs:2000}]});
      assert.equal((await baselineDurableEpistemicGraph(tenantId)).complete,true);
      const initial=(await client.query<{belief:{status:string};next_freshness_at:Date|null}>(
        "SELECT belief,next_freshness_at FROM finnor_os.epistemic_current WHERE tenant_id=$1 AND proposition_id=$2",
        [tenantId,rootId])).rows[0]!;
      assert.equal(initial.belief.status,"KNOWN");
      assert(initial.next_freshness_at);
      await new Promise((resolveDelay)=>setTimeout(resolveDelay,Math.max(1,initial.next_freshness_at!.getTime()-Date.now()+20)));
      assert.equal(await scanDueEpistemicFreshness(tenantId),1);
      assert.equal(await scanDueEpistemicFreshness(tenantId),0);
      const changeId=(await client.query<{id:string}>(
        "SELECT id FROM finnor_os.epistemic_changes WHERE tenant_id=$1 AND source_kind='freshness'",[tenantId])).rows[0]!.id;
      const result=await processDurableEpistemicChange(tenantId,changeId);
      assert.equal(result.complete,true);
      const delta=(await client.query<{semantic_deltas:Array<{propositionId:string}>}>(
        "SELECT semantic_deltas FROM finnor_os.epistemic_changesets WHERE tenant_id=$1 AND change_id=$2",
        [tenantId,changeId])).rows[0]!.semantic_deltas;
      assert.deepEqual(delta.map((row)=>row.propositionId).sort(),[rootId,childId].sort());
      assert.equal((await client.query<{belief:{status:string}}>(
        "SELECT belief FROM finnor_os.epistemic_current WHERE tenant_id=$1 AND proposition_id=$2",
        [tenantId,rootId])).rows[0]!.belief.status,"STALE");
      assert.equal((await compareDurableShadowWithOracle(tenantId)).equivalent,true);
      pass("durable-freshness",`Indexed due scan accepted one idempotent clock change, propagated root→derived child and matched full oracle`);
    } finally { await client.end(); }
  });
}

function semanticState(state: EpistemicState): string {
  return JSON.stringify({propositions:state.propositions.map(propositionSemanticFingerprint),
    conflicts:state.conflicts,canonicalTruth:state.canonicalTruth,
    unknowns:[...state.unknowns].sort((a,b)=>a.propositionId.localeCompare(b.propositionId)),
    provenance:state.provenance.map((row) => ({...row,evidenceRefs:[...row.evidenceRefs].sort()}))
      .sort((a,b)=>a.propositionId.localeCompare(b.propositionId))});
}

function median(values: number[]): number {
  const ordered=[...values].sort((a,b)=>a-b);
  return Number(ordered[Math.floor(ordered.length/2)]!.toFixed(2));
}

function benchmarkCase(scenario:string,state:EpistemicState,incoming:EvidenceRecord[],at:string,
  expectedMaxEvaluated:number): void {
  const full=appendEvidenceAndRecompute(state,incoming,at);
  const incremental=appendEvidenceIncrementally(state,incoming,at);
  const equivalent=semanticState(full)===semanticState(incremental.state);
  assert.equal(equivalent,true,`${scenario} diverged from full oracle`);
  assert(incremental.evaluatedPropositionIds.length<=expectedMaxEvaluated,
    `${scenario} evaluated ${incremental.evaluatedPropositionIds.length} unrelated propositions`);
  const fullTimes:number[]=[],incrementalTimes:number[]=[];
  for(let i=0;i<4;i+=1) {
    let started=performance.now(); appendEvidenceAndRecompute(state,incoming,at); fullTimes.push(performance.now()-started);
    started=performance.now(); appendEvidenceIncrementally(state,incoming,at); incrementalTimes.push(performance.now()-started);
  }
  benchmarks.push({scenario,propositions:state.propositions.length,fullMedianMs:median(fullTimes),
    incrementalMedianMs:median(incrementalTimes),fullEvaluations:state.propositions.length,
    incrementalEvaluations:incremental.evaluatedPropositionIds.length,equivalent});
}

function performanceCorpus(): void {
  const requireTrue=(id:string):PropositionDefinition["predicate"]=>({name:`requires:${id}`,derivation:{
    ruleId:"scope5-cert-require-true",version:"v1",owner:"@finnor/epistemic-runtime",
    expression:{op:"require",propositionId:id,expectedValueHashes:[durableDeterministicValueHash(true)],
      acceptableStatuses:["KNOWN"]},
  }});
  const definitions:PropositionDefinition[]=[testDefinition("core"),testDefinition("deep:0",
    {kind:"entity",type:"pe_metric_observation",id:"metric:1"})];
  for(let i=0;i<16;i+=1) definitions.push({id:`fan:${i}`,subject:{kind:"entity",type:"test",id:`fan:${i}`},
    predicate:requireTrue("core"),dependencyRefs:["core"]});
  for(let i=1;i<=12;i+=1) definitions.push({id:`deep:${i}`,subject:{kind:"entity",type:"test",id:`deep:${i}`},
    predicate:requireTrue(`deep:${i-1}`),dependencyRefs:[`deep:${i-1}`]});
  for(let i=0;i<300;i+=1) definitions.push(testDefinition(`isolated:${i}`));
  const initial=createEpistemicState({scope:{tenantId:TEST_TENANT,principalId:"cert:performance",decisionId:"cert:performance"},
    asOf:TEST_NOW,propositions:definitions});
  const sourceIds=["core","deep:0",...Array.from({length:300},(_,i)=>`isolated:${i}`)];
  const seed=sourceIds.map((id)=>testEvidence({state:initial,id:`seed:${id}`,propositionId:id,value:true,
    kind:"CANONICAL_DB",...(id==="core" || /^isolated:[0-9]$/.test(id) ? {maxAgeMs:1000}: {})}));
  const established=appendEvidenceAndRecompute(initial,seed,TEST_NOW);
  const at="2026-08-31T00:00:00.002Z";
  const update=(id:string,value:boolean):EvidenceRecord=>testEvidence({state:established,id:`update:${id}`,
    propositionId:id,value,kind:"CANONICAL_DB",observedAt:"2026-08-31T00:00:00.001Z",
    ingestedAt:"2026-08-31T00:00:00.001Z",supersedesEvidenceRefs:[`seed:${id}`]});
  benchmarkCase("single-proposition",established,[update("isolated:0",false)],at,1);
  benchmarkCase("high-fanout",established,[update("core",false)],at,17);
  benchmarkCase("deep-dependency-chain",established,[update("deep:0",false)],at,13);
  benchmarkCase("unrelated-evidence-update",established,[update("isolated:299",false)],at,1);
  benchmarkCase("freshness-expiry-batch",established,[],"2026-08-31T00:00:01.001Z",40);
  benchmarkCase("multiple-simultaneous-changes",established,
    Array.from({length:10},(_,i)=>update(`isolated:${i}`,false)),at,10);
  benchmarkCase("phase4-metric-restatement",established,[update("deep:0",false)],at,13);
  const largeDefinitions=[...definitions,...Array.from({length:700},(_,i)=>testDefinition(`portfolio:${i}`))];
  const largeInitial=createEpistemicState({scope:initial.scope,asOf:TEST_NOW,propositions:largeDefinitions});
  const largeSeed=[...seed,...Array.from({length:700},(_,i)=>testEvidence({state:largeInitial,id:`seed:portfolio:${i}`,
    propositionId:`portfolio:${i}`,value:true,kind:"CANONICAL_DB"}))];
  const large=appendEvidenceAndRecompute(largeInitial,largeSeed,TEST_NOW);
  benchmarkCase("large-deal-portfolio-graph",large,[testEvidence({state:large,id:"update:isolated:0",
    propositionId:"isolated:0",value:false,kind:"CANONICAL_DB",observedAt:"2026-08-31T00:00:00.001Z",
    ingestedAt:"2026-08-31T00:00:00.001Z",supersedesEvidenceRefs:["seed:isolated:0"]})],at,1);
  pass("performance",`${benchmarks.length} corpus scenarios matched full semantics; measured proposition counts and median latencies are in the JSON report`);
}

async function digitalTwinRestatement(): Promise<void> {
  await withDatabase("digital-twin",async (url) => {
    await migrate(url);
    const tenantId=randomUUID(),userId=randomUUID(),companyId=randomUUID(),dealId=randomUUID(),caseId=randomUUID();
    const sourceId=randomUUID(),sourceVersionId=randomUUID(),seriesId=randomUUID(),observationId=randomUUID();
    const modelId=randomUUID(),modelVersionId=randomUUID(),runId=randomUUID();
    const committeeId=randomUUID(),policyId=randomUUID(),policyRevisionId=randomUUID(),configId=randomUUID();
    const configureAuthorityId=randomUUID(),openAuthorityId=randomUUID(),icCaseId=randomUUID();
    const linkedQuestionId=randomUUID(),unlinkedQuestionId=randomUUID(),unlinkedDecisionId=randomUUID();
    const client=new pg.Client({connectionString:url}); await client.connect();
    try {
      await client.query("SET app.test_vertical_mode='explicit'");
      await client.query("INSERT INTO finnor_os.tenants(id,name) VALUES($1,'Scope 5 Digital Twin impact')",[tenantId]);
      await client.query("SELECT set_config('app.tenant_id',$1,false),set_config('app.user_id',$2,false)",[tenantId,userId]);
      await client.query("SELECT * FROM finnor_os.configure_tenant_vertical($1,'private_equity',0,$2,'certification:scope5',NULL)",[tenantId,userId]);
      await client.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status,display_name) VALUES($1,$2,'scope5-twin@test.invalid','owner','active','Twin owner')",[userId,tenantId]);
      await client.query("INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind) VALUES($1,$2,'scope5-twin-target','Twin target','other')",[companyId,tenantId]);
      await client.query(`INSERT INTO finnor_os.pe_deals
        (id,tenant_id,target_organization_id,name,deal_lead_employee_id,signed_loi_at,target_closing_at,source_system,external_id,created_by)
        VALUES($1,$2,$3,'Twin Deal',$4,now(),now()+interval '30 days','certification:scope5','twin-deal',$5)`,
        [dealId,tenantId,companyId,userId,userId]);
      await client.query(`INSERT INTO finnor_os.pe_investment_cases
        (id,tenant_id,deal_id,title,source_system,external_id,created_by)
        VALUES($1,$2,$3,'Twin Investment Case','certification:scope5','twin-case',$4)`,[caseId,tenantId,dealId,userId]);
      await client.query(`UPDATE finnor_os.pe_investment_cases
        SET state='active',activated_at=clock_timestamp(),version=version+1
        WHERE tenant_id=$1 AND id=$2`,[tenantId,caseId]);
      await client.query("INSERT INTO finnor_os.evidence_sources(id,scope,tenant_id,source_key,source_type,title) VALUES($1,'tenant',$2,'twin-revenue','manual','Observed revenue')",[sourceId,tenantId]);
      await client.query(`INSERT INTO finnor_os.evidence_source_versions
        (id,source_id,scope,tenant_id,version_number,content_hash,content,snapshot,as_of)
        VALUES($1,$2,'tenant',$3,1,$4,'observed revenue',$5,clock_timestamp())`,
        [sourceVersionId,sourceId,tenantId,"2".repeat(64),{revenue:"100000000"}]);
      await client.query(`INSERT INTO finnor_os.pe_metric_series
        (id,tenant_id,subject_type,subject_id,metric_key,name,unit,currency_code,frequency,source_system,external_id,created_by)
        VALUES($1,$2,'external_organization',$3,'revenue','Revenue','currency','USD','annual','certification:scope5','twin-series',$4)`,
        [seriesId,tenantId,companyId,userId]);
      await client.query(`INSERT INTO finnor_os.pe_metric_observations
        (id,tenant_id,metric_series_id,period_start,period_end,value_type,value_numeric,
         evidence_source_id,evidence_version_id,source_system,external_id,created_by)
        VALUES($1,$2,$3,'2025-01-01','2025-12-31','number',100000000,$4,$5,'certification:scope5','twin-observation',$6)`,
        [observationId,tenantId,seriesId,sourceId,sourceVersionId,userId]);
      const modelHash=`sha256:${"3".repeat(64)}`, inputHash=`sha256:${"4".repeat(64)}`, resultHash=`sha256:${"5".repeat(64)}`;
      const modelDefinition={schemaVersion:"underwriting-model-ir.v1",modelKey:"twin_revenue",modelVersion:"v1",
        financialConventionVersion:"scope5-convention.v1",minimumEngineVersion:"finnor-underwriting-engine/1.0.0",
        periodDefinition:{frequency:"annual",forecastStart:"2027-01-01",count:1},
        nodes:[{id:"revenue",kind:"input",valueType:"decimal",unit:"money",currency:"USD",shape:"scalar",dependencies:[],required:true},
          {id:"revenue.output",kind:"output",valueType:"decimal",unit:"money",currency:"USD",shape:"scalar",
            dependencies:["revenue"],sourceNodeId:"revenue"}],circularBlocks:[]};
      await client.query("INSERT INTO finnor_os.underwriting_models(id,tenant_id,investment_case_id,model_key,name,created_by) VALUES($1,$2,$3,'twin_revenue','Twin model',$4)",
        [modelId,tenantId,caseId,userId]);
      await client.query(`INSERT INTO finnor_os.underwriting_model_versions
        (id,tenant_id,investment_case_id,model_id,version_key,schema_version,financial_convention_version,
         minimum_engine_version,semantic_hash,model_definition,created_by)
        VALUES($1,$2,$3,$4,'v1','underwriting-model-ir.v1','scope5-convention.v1','finnor-underwriting-engine/1.0.0',$5,$6,$7)`,
        [modelVersionId,tenantId,caseId,modelId,modelHash,modelDefinition,userId]);
      await client.query(`INSERT INTO finnor_os.underwriting_model_input_bindings
        (tenant_id,investment_case_id,model_version_id,input_node_id,source_kind,evidence_version_id,value_path,created_by)
        VALUES($1,$2,$3,'revenue','evidence_version',$4,'revenue',$5)`,[tenantId,caseId,modelVersionId,sourceVersionId,userId]);
      const worldAt=new Date();
      await client.query(`INSERT INTO finnor_os.underwriting_runs
        (id,tenant_id,investment_case_id,model_version_id,world_at,engine_version,model_semantic_hash,
         input_hash,input_snapshot,result_hash,result,status,validity,idempotency_key,created_by)
        VALUES($1,$2,$3,$4,$5,'finnor-underwriting-engine/1.0.0',$6,$7,$8,$9,$10,'SUCCEEDED','VALID','scope5-twin-run',$11)`,
        [runId,tenantId,caseId,modelVersionId,worldAt,modelHash,inputHash,
          {semanticHash:inputHash,investmentCaseId:caseId,worldAt:worldAt.toISOString(),values:{}},resultHash,
          {resultSemanticHash:resultHash,modelSemanticHash:modelHash,inputSemanticHash:inputHash,
            engineVersion:"finnor-underwriting-engine/1.0.0",status:"SUCCEEDED",validity:"VALID",checks:[]},userId]);
      // Build real IC owner rows, including its committee and Authority proofs.
      // The question's exact EvidenceVersion link may be traversed; another
      // question and a Decision in the same Deal must not be inferred as causal.
      const icPolicy={schemaVersion:"pe-ic-policy.v1",quorum:{kind:"MIN_COUNT",count:1},
        threshold:{kind:"SIMPLE_MAJORITY"},allowedPrimaryRunValidities:["VALID"]};
      await client.query("INSERT INTO finnor_os.org_units(id,tenant_id,unit_key,name,kind) VALUES($1,$2,'scope5-ic','Scope 5 IC','team')",
        [committeeId,tenantId]);
      await client.query(`INSERT INTO finnor_os.domain_policies(id,tenant_id,action_type,policy,requires_confirmation)
        VALUES($1,$2,'private_equity:ic_process',$3,false)`,[policyId,tenantId,icPolicy]);
      await client.query(`INSERT INTO finnor_os.domain_policy_revisions
        (id,tenant_id,policy_id,action_type,version,policy,requires_confirmation,effective_from)
        VALUES($1,$2,$3,'private_equity:ic_process',1,$4,false,clock_timestamp())`,
        [policyRevisionId,tenantId,policyId,icPolicy]);
      for (const [id,capability] of [[configureAuthorityId,"ic:configure_committee"],[openAuthorityId,"ic:open_case"]]) {
        await client.query(`INSERT INTO finnor_os.authority_decisions
          (id,tenant_id,employee_id,authority_revision,operation,capability,risk,outcome,reason_code)
          VALUES($1,$2,$3,1,'action',$4,'low','allowed','SCOPE5_CERTIFICATION')`,
          [id,tenantId,userId,capability]);
      }
      const icPolicyHash=(await client.query<{value:string}>(
        "SELECT 'sha256:'||encode(public.digest(convert_to($1::jsonb::text,'UTF8'),'sha256'),'hex') value",
        [icPolicy])).rows[0]!.value;
      await client.query("BEGIN");
      try {
        await client.query(`INSERT INTO finnor_os.pe_ic_committee_config_versions
          (id,tenant_id,committee_org_unit_id,config_version,policy_id,policy_version,policy_revision_id,
           policy_snapshot,policy_hash,created_by,authority_decision_id,idempotency_key)
          VALUES($1,$2,$3,1,$4,1,$5,$6,$7,$8,$9,'scope5-ic-config')`,
          [configId,tenantId,committeeId,policyId,policyRevisionId,icPolicy,icPolicyHash,userId,configureAuthorityId]);
        await client.query(`INSERT INTO finnor_os.pe_ic_committee_membership_versions
          (tenant_id,committee_config_version_id,employee_id,member_role,voting_eligible,chair,effective_from,created_by)
          VALUES($1,$2,$3,'CHAIR',true,true,clock_timestamp(),$3)`,[tenantId,configId,userId]);
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      await client.query(`INSERT INTO finnor_os.pe_ic_cases
        (id,tenant_id,deal_id,investment_case_id,committee_config_version_id,opened_by,
         opened_authority_decision_id,idempotency_key,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,'scope5-ic-case',$8)`,
        [icCaseId,tenantId,dealId,caseId,configId,userId,openAuthorityId,userId]);
      await client.query("UPDATE finnor_os.pe_ic_cases SET state='PREPARING',version=version+1 WHERE tenant_id=$1 AND id=$2",
        [tenantId,icCaseId]);
      for (const [id,key] of [[linkedQuestionId,"linked"],[unlinkedQuestionId,"unlinked"]]) {
        await client.query(`INSERT INTO finnor_os.pe_ic_questions
          (id,tenant_id,deal_id,investment_case_id,ic_case_id,question,raised_by,idempotency_key)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
          [id,tenantId,dealId,caseId,icCaseId,`Revenue evidence ${key}?`,userId,`scope5-ic-question-${key}`]);
      }
      await client.query(`INSERT INTO finnor_os.pe_ic_source_links
        (tenant_id,deal_id,investment_case_id,ic_case_id,owner_kind,owner_id,source_kind,
         evidence_version_id,relationship,idempotency_key,created_by)
        VALUES($1,$2,$3,$4,'QUESTION',$5,'EVIDENCE_VERSION',$6,'SUPPORTS','scope5-ic-evidence-link',$7)`,
        [tenantId,dealId,caseId,icCaseId,linkedQuestionId,sourceVersionId,userId]);
      await client.query(`INSERT INTO finnor_os.pe_decisions
        (id,tenant_id,deal_id,investment_case_id,decision_type,title,decision,source_system,external_id,created_by)
        VALUES($1,$2,$3,$4,'investment','Unlinked Deal decision','Pending','certification:scope5','unlinked-ic-decision',$5)`,
        [unlinkedDecisionId,tenantId,dealId,caseId,userId]);
      const icBefore=(await client.query(`SELECT id,state,version FROM finnor_os.pe_ic_questions
        WHERE tenant_id=$1 AND ic_case_id=$2 ORDER BY id`,[tenantId,icCaseId])).rows;
      const prepared=await prepareTenantPrivateEquityEpistemicGraph({
        ctx:{auth:{tenantId,userId,role:"owner"}},baselineBatchSize:64,baselineBatches:16,
      });
      assert.equal(prepared.status,"BASELINE_COMPLETE");
      const propositionId=`pe:twin:v1:pe_metric_observation:${observationId}:business_fact`;
      const baseline=(await client.query<{belief:{status:string}}>(
        "SELECT belief FROM finnor_os.epistemic_current WHERE tenant_id=$1 AND graph_version_id=$2 AND proposition_id=$3",
        [tenantId,prepared.graphVersionId,propositionId])).rows[0];
      assert.equal(baseline?.belief.status,"KNOWN");
      assert.equal((await compareDurableShadowWithOracle(tenantId)).equivalent,true);
      const releaseSha="b".repeat(40);
      await client.query(`INSERT INTO finnor_os.service_release_heartbeats
        (service,instance_id,release_sha,build_id,version,release_source,migration_head,capabilities,environment)
        VALUES('worker','scope5-twin',$1,'scope5-twin','scope5-twin','certification',$2,ARRAY['epistemic-v2'],'test')`,[releaseSha,CURRENT_MIGRATION_HEAD]);
      await activateDurableEpistemicImpact({tenantId,graphVersionId:prepared.graphVersionId!,releaseSha});
      const replacementId=randomUUID(),replacementVersionId=randomUUID();
      await client.query("BEGIN");
      try {
        await client.query(`INSERT INTO finnor_os.evidence_source_versions
          (id,source_id,scope,tenant_id,version_number,content_hash,content,snapshot,as_of)
          VALUES($1,$2,'tenant',$3,2,$4,'restated revenue',$5,clock_timestamp())`,
          [replacementVersionId,sourceId,tenantId,"6".repeat(64),{revenue:"125000000"}]);
        await client.query("UPDATE finnor_os.pe_metric_observations SET superseded_at=clock_timestamp(),version=version+1 WHERE tenant_id=$1 AND id=$2",
          [tenantId,observationId]);
        await client.query(`INSERT INTO finnor_os.pe_metric_observations
          (id,tenant_id,metric_series_id,period_start,period_end,value_type,value_numeric,revision,
           supersedes_observation_id,evidence_source_id,evidence_version_id,source_system,external_id,created_by)
          VALUES($1,$2,$3,'2025-01-01','2025-12-31','number',125000000,2,$4,$5,$6,'certification:scope5','twin-restatement',$7)`,
          [replacementId,tenantId,seriesId,observationId,sourceId,replacementVersionId,userId]);
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      const accepted=await client.query<{id:string}>(
        "SELECT id FROM finnor_os.epistemic_changes WHERE tenant_id=$1 AND status='pending' ORDER BY ingestion_order",[tenantId]);
      assert(accepted.rows.length>=2);
      for (const row of accepted.rows) assert.equal((await processDurableEpistemicChange(tenantId,row.id)).complete,true);
      const impact=await client.query<{object_kind:string;object_id:string;operational_enabled:boolean;semantic_deltas:unknown[]}>(
        `SELECT i.object_kind,i.object_id,s.operational_enabled,s.semantic_deltas
         FROM finnor_os.epistemic_impact_paths i JOIN finnor_os.epistemic_changesets s
           ON s.tenant_id=i.tenant_id AND s.id=i.changeset_id
         WHERE i.tenant_id=$1 AND i.proposition_id=$2 ORDER BY i.object_kind,i.object_id`,
        [tenantId,propositionId]);
      assert(impact.rows.some((row)=>row.object_kind==="underwriting_model_input"));
      assert(impact.rows.some((row)=>row.object_kind==="underwriting_model_node"));
      assert(impact.rows.some((row)=>row.object_kind==="underwriting_run" && row.object_id===runId));
      assert(impact.rows.some((row)=>row.object_kind==="pe_ic_question" && row.object_id===linkedQuestionId));
      assert(!impact.rows.some((row)=>row.object_kind==="pe_ic_question" && row.object_id===unlinkedQuestionId));
      assert(!impact.rows.some((row)=>row.object_kind==="pe_decision" && row.object_id===unlinkedDecisionId));
      assert(impact.rows.every((row)=>row.operational_enabled===false));
      assert(impact.rows.some((row)=>Array.isArray(row.semantic_deltas) && row.semantic_deltas.length===1));
      const historical=await client.query("SELECT status,validity,result_hash FROM finnor_os.underwriting_runs WHERE tenant_id=$1 AND id=$2",
        [tenantId,runId]);
      assert.deepEqual(historical.rows[0],{status:"SUCCEEDED",validity:"VALID",result_hash:resultHash});
      assert.deepEqual((await client.query(`SELECT id,state,version FROM finnor_os.pe_ic_questions
        WHERE tenant_id=$1 AND ic_case_id=$2 ORDER BY id`,[tenantId,icCaseId])).rows,icBefore);
      assert.equal((await compareDurableShadowWithOracle(tenantId,{recordShadowCheckpoint:false})).equivalent,true);
      pass("digital-twin-restatement",`Phase-4 metric revision generated a redacted canonical proposition delta and exact Underwriting input/node/run/IC Question paths; unlinked same-Deal Question/Decision were unaffected, historic Run/Question stayed immutable and structural epoch fenced activation`);
    } finally { await client.end(); }
  });
}

async function main(): Promise<void> {
await withDatabase("fresh",async (url) => {
  const applied = await migrate(url);
  assert.equal(applied.at(-1),CURRENT_MIGRATION_HEAD);
  pass("fresh-migration",`${applied.length} migrations applied through ${CURRENT_MIGRATION_HEAD}`);
  process.env.DATABASE_URL = url;
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const tenantId = randomUUID(); const sourceId = randomUUID(); const alternateSourceId = randomUUID();
    const unrelatedSourceId = randomUUID();
    const userId = randomUUID(); const companyId = randomUUID();
    const dealId = randomUUID(); const workstreamId = randomUUID(); const conditionId = randomUUID();
    await client.query("INSERT INTO finnor_os.tenants(id,name) VALUES($1,'Scope 5 smoke')", [tenantId]);
    await client.query("SET app.test_vertical_mode='explicit'");
    await client.query("SELECT set_config('app.tenant_id',$1,false),set_config('app.user_id',$2,false)",[tenantId,userId]);
    await client.query("SELECT * FROM finnor_os.configure_tenant_vertical($1,'private_equity',0,$2,'certification:scope5',NULL)",[tenantId,userId]);
    await client.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status,display_name) VALUES($1,$2,'scope5-smoke@test.invalid','owner','active','Scope 5 owner')",[userId,tenantId]);
    await client.query("INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind) VALUES($1,$2,'scope5-target','Scope 5 target','other')",[companyId,tenantId]);
    await client.query(`INSERT INTO finnor_os.pe_deals
      (id,tenant_id,target_organization_id,name,deal_lead_employee_id,signed_loi_at,target_closing_at,source_system,external_id,created_by)
      VALUES($1,$2,$3,'Pinned closing Deal',$4,now(),now()+interval '30 days','certification:scope5','pinned-deal',$5)`,
      [dealId,tenantId,companyId,userId,userId]);
    await client.query(`INSERT INTO finnor_os.pe_workstreams
      (id,tenant_id,deal_id,kind,name,owner_party_type,owner_party_id,source_system,external_id,created_by)
      VALUES($1,$2,$3,'closing','Certification closing','employee',$4,'certification:scope5','pinned-workstream',$5)`,
      [workstreamId,tenantId,dealId,userId,userId]);
    await client.query(`INSERT INTO finnor_os.pe_closing_conditions
      (id,tenant_id,deal_id,workstream_id,condition_text,category,evidence_required,owner_party_type,owner_party_id,
       source_system,external_id,created_by)
      VALUES($1,$2,$3,$4,'Rating remains good','financial',false,'employee',$5,'certification:scope5','pinned-condition',$6)`,
      [conditionId,tenantId,dealId,workstreamId,userId,userId]);
    await client.query("INSERT INTO finnor_os.evidence_sources(id,scope,tenant_id,source_key,source_type,title) VALUES($1,'tenant',$2,'scope5','manual','Smoke')",[sourceId,tenantId]);
    await client.query("INSERT INTO finnor_os.evidence_sources(id,scope,tenant_id,source_key,source_type,title) VALUES($1,'tenant',$2,'scope5-alternate','manual','Alternate')",[alternateSourceId,tenantId]);
    await client.query("INSERT INTO finnor_os.evidence_sources(id,scope,tenant_id,source_key,source_type,title) VALUES($1,'tenant',$2,'scope5-unrelated','manual','Unrelated')",[unrelatedSourceId,tenantId]);
    await client.query("INSERT INTO finnor_os.evidence_source_versions(source_id,scope,tenant_id,version_number,content_hash,content,snapshot,as_of) VALUES($1,'tenant',$2,1,$3,'first',$4,clock_timestamp())",
      [sourceId,tenantId,"a".repeat(64),{ rating: "good" }]);
    await client.query("INSERT INTO finnor_os.evidence_source_versions(source_id,scope,tenant_id,version_number,content_hash,content,snapshot,as_of) VALUES($1,'tenant',$2,1,$3,'unrelated',$4,clock_timestamp())",
      [unrelatedSourceId,tenantId,"c".repeat(64),{ rating:"steady" }]);
    const propId = `smoke:rating:${sourceId}`;
    const childId = `smoke:derived:${sourceId}`;
    const unrelatedId = `smoke:rating:${unrelatedSourceId}`;
    const staged = await stageDurableEpistemicGraph({ tenantId,ruleVersion: "scope5-materiality-v1",heuristicVersion: EPISTEMIC_HEURISTIC_VERSION,
      propositions: [
        { id: propId,subject:{kind:"entity",type:"test",id:sourceId},predicate:{name:"rating"} },
        { id: childId,subject:{kind:"entity",type:"test",id:sourceId},predicate:{name:"rating.good",derivation:{
          ruleId:"scope5-cert-good",version:"v1",owner:"@finnor/epistemic-runtime",
          expression:{op:"require",propositionId:propId,expectedValueHashes:[durableDeterministicValueHash("good")],
            acceptableStatuses:["KNOWN"]},
        }},dependencyRefs:[propId] },
        { id: unrelatedId,subject:{kind:"entity",type:"test",id:unrelatedSourceId},predicate:{name:"rating"} },
      ],
      dependencies: [{id:`dep:${childId}`,propositionId:childId,dependsOnPropositionId:propId,kind:"DERIVED_FROM"}],
      bindings:[
        {propositionId:propId,sourceKind:"evidence_source",sourceType:"manual",sourceId,valuePath:"rating",evidenceKind:"DOCUMENT"},
        {propositionId:propId,sourceKind:"evidence_source",sourceType:"manual",sourceId:alternateSourceId,valuePath:"rating",evidenceKind:"DOCUMENT"},
        {propositionId:unrelatedId,sourceKind:"evidence_source",sourceType:"manual",sourceId:unrelatedSourceId,valuePath:"rating",evidenceKind:"DOCUMENT"},
      ] });
    const otherTenantId=randomUUID();
    await client.query("INSERT INTO finnor_os.tenants(id,name) VALUES($1,'Scope 5 isolation')",[otherTenantId]);
    await assert.rejects(stageDurableEpistemicGraph({tenantId:otherTenantId,ruleVersion:"scope5-materiality-v1",
      heuristicVersion:EPISTEMIC_HEURISTIC_VERSION,
      propositions:[{id:"cross:source",subject:{kind:"entity",type:"test",id:sourceId},predicate:{name:"rating"}}],
      dependencies:[],bindings:[{propositionId:"cross:source",sourceKind:"evidence_source",sourceType:"manual",
        sourceId,valuePath:"rating",evidenceKind:"DOCUMENT"}]}),/tenant|source/i);
    await assert.rejects(replayDurableEpistemicGraph({tenantId:otherTenantId,graphVersionId:staged.graphVersionId,
      validAt:new Date().toISOString(),knownAt:new Date().toISOString()}),/cross-tenant/);
    pass("tenant-isolation",`Cross-tenant source binding and historical graph replay rejected`);
    const baseline = await baselineDurableEpistemicGraph(tenantId,1);
    assert.equal(baseline.complete,false);
    const resumedBaseline = await baselineDurableEpistemicGraph(tenantId,2);
    assert.equal(resumedBaseline.complete,true);
    assert.equal((await client.query("SELECT count(*)::int count FROM finnor_os.epistemic_changesets WHERE tenant_id=$1",[tenantId])).rows[0].count,0);
    pass("bounded-baseline",`Baseline resumed after one-node batch; 3 propositions evaluated without fabricated ChangeSets`);
    const historicalKnownAt=(await client.query<{at:Date}>("SELECT clock_timestamp() at")).rows[0]!.at.toISOString();
    const before = await client.query("SELECT belief FROM finnor_os.epistemic_current WHERE tenant_id=$1",[tenantId]);
    assert.equal(before.rows.length,3);
    const unrelatedBefore = (await client.query<{semantic_hash:string}>(
      "SELECT semantic_hash FROM finnor_os.epistemic_current WHERE tenant_id=$1 AND proposition_id=$2",
      [tenantId,unrelatedId])).rows[0]!.semantic_hash;
    const workId = randomUUID(); const workInputId = randomUUID(); const planId = randomUUID(); const actionId = randomUUID();
    const planHash = `sha256:${"d".repeat(64)}`;
    await client.query(`INSERT INTO finnor_os.works(id,tenant_id,status,initial_channel,initial_instruction,created_by)
      VALUES($1,$2,'executing','console','Scope 5 exact pin proof',$3)`,[workId,tenantId,userId]);
    await client.query(`INSERT INTO finnor_os.work_inputs(id,tenant_id,work_id,instruction_id,channel,instruction_text,created_by)
      VALUES($1,$2,$3,$4,'console','Scope 5 exact pin proof',$5)`,[workInputId,tenantId,workId,randomUUID(),userId]);
    const versioned = {version:1,semanticHash:planHash};
    const planGraph = { ...versioned,nodes:[
      {id:"high-risk-node",kind:"action",actionType:"satisfy_closing_condition",payload:{}},
      {id:"unrelated-node",kind:"action",actionType:"create_request",payload:{}},
    ],edges:[] };
    await client.query(`INSERT INTO finnor_os.work_plan_revisions
      (id,tenant_id,work_id,work_input_id,revision,reason,goal_spec,constraint_set,planning_snapshot,
       candidate_summary,validation,plan_graph,score,goal_hash,constraint_hash,world_snapshot_hash,graph_hash,semantic_hash)
      VALUES($1,$2,$3,$4,1,'initial',$5,$5,$5,'{}',$5,$6,'{}',$7,$7,$7,$7,$7)`,
      [planId,tenantId,workId,workInputId,versioned,planGraph,planHash]);
    const pin = await pinCurrentEpistemicRequirements({tenantId,planRevisionId:planId,
      planNodeId:"high-risk-node",actionType:"satisfy_closing_condition",requirements:[{
        propositionId:propId,expectedValues:["good"],mandatory:true,acceptableStatuses:["KNOWN"],
        minimumAuthority:["DURABLE_EVIDENCE"],minimumConfidence:"MEDIUM",
      }]});
    assert.equal(pin.pinned.length,1);
    await client.query(`INSERT INTO finnor_os.domain_actions
      (id,tenant_id,action_type,payload,status,summary,work_id,plan_revision_id,plan_node_id,initiated_by)
      VALUES($1,$2,'satisfy_closing_condition','{}','draft','Pinned closing condition',$3,$4,'high-risk-node',$5)`,
      [actionId,tenantId,workId,planId,userId]);
    const beforePinGuard = (await client.query<{reasons:string[]}>(
      "SELECT finnor_os.epistemic_execution_block_reasons($1,$2,$3,true) reasons",[tenantId,planId,"high-risk-node"])).rows[0]!.reasons;
    assert.deepEqual(beforePinGuard,[]);
    await client.query("INSERT INTO finnor_os.evidence_source_versions(source_id,scope,tenant_id,version_number,content_hash,content,snapshot,as_of) VALUES($1,'tenant',$2,2,$3,'second',$4,clock_timestamp())",
      [sourceId,tenantId,"b".repeat(64),{ rating: "bad" }]);
    const changes = await client.query<{id:string;status:string}>("SELECT id,status FROM finnor_os.epistemic_changes WHERE tenant_id=$1",[tenantId]);
    assert.equal(changes.rows.length,1);
    assert.equal(changes.rows[0]!.status,"pending");
    const earlierReplay=await replayDurableEpistemicGraph({tenantId,graphVersionId:staged.graphVersionId,
      validAt:historicalKnownAt,knownAt:historicalKnownAt});
    assert.equal(earlierReplay.status,"AVAILABLE");
    if (earlierReplay.status==="AVAILABLE") assert.deepEqual(
      earlierReplay.state.propositions.find((row)=>row.id===propId)?.value,{kind:"DETERMINISTIC",value:"good"});
    const pendingJobs = await client.query("SELECT id FROM finnor_os.jobs WHERE tenant_id=$1 AND type='process_epistemic_change_v2'",[tenantId]);
    assert.equal(pendingJobs.rows.length,1);
    const firstStep = await processDurableEpistemicChange(tenantId,changes.rows[0]!.id,1);
    assert.equal(firstStep.complete,false);
    assert.equal(firstStep.reason,"FRONTIER_REMAINS");
    const pendingGuard = (await client.query<{reasons:string[]}>(
      "SELECT finnor_os.epistemic_execution_block_reasons($1,$2,$3,true) reasons",[tenantId,planId,"high-risk-node"])).rows[0]!.reasons;
    assert.deepEqual(pendingGuard,[]); // shadow is observation-only
    const concurrent = await Promise.all(Array.from({length:2},() => processDurableEpistemicChange(tenantId,changes.rows[0]!.id,1)));
    assert(concurrent.some((row) => row.complete));
    const logical = await client.query<{id:string}>("SELECT id FROM finnor_os.epistemic_changesets WHERE tenant_id=$1 AND change_id=$2",[tenantId,changes.rows[0]!.id]);
    assert.equal(logical.rows.length,1);
    const duplicate = await processDurableEpistemicChange(tenantId,changes.rows[0]!.id);
    assert.equal(duplicate.changesetId,logical.rows[0]!.id);
    const frontier = await client.query<{proposition_id:string}>(
      "SELECT proposition_id FROM finnor_os.epistemic_frontier WHERE tenant_id=$1 AND change_id=$2 ORDER BY proposition_id",
      [tenantId,changes.rows[0]!.id]);
    assert.deepEqual(frontier.rows.map((row) => row.proposition_id),[childId,propId].sort());
    const unrelatedAfter = (await client.query<{semantic_hash:string}>(
      "SELECT semantic_hash FROM finnor_os.epistemic_current WHERE tenant_id=$1 AND proposition_id=$2",
      [tenantId,unrelatedId])).rows[0]!.semantic_hash;
    assert.equal(unrelatedAfter,unrelatedBefore);
    pass("bounded-frontier-retry",`Root and derived child reevaluated across retries; unrelated proposition was not touched; concurrent duplicate delivery produced one ChangeSet`);
    const replay = await causalReplayProjection(tenantId,workId,{userId,role:"owner"});
    const replayNodes = replay?.nodes.filter((node) => node.id.startsWith("epistemic-")) ?? [];
    const replayEdges = replay?.edges.filter((edge) => edge.relation.startsWith("impacted_pinned") || edge.relation.startsWith("caused_epistemic")) ?? [];
    assert.equal(replayNodes.length,3);
    assert.equal(replayEdges.length,2);
    pass("causal-replay",`Existing read-only projection shows exact source, transition, Work impact and two proven edges`);
    const after = await client.query("SELECT semantic_deltas,materiality FROM finnor_os.epistemic_changesets WHERE tenant_id=$1",[tenantId]);
    assert.equal(after.rows.length,1);
    const deltas = after.rows[0]!.semantic_deltas as Array<{propositionId:string;causes:Array<{propositionId:string;kind:string}>}>;
    assert.deepEqual(deltas.map((row) => row.propositionId).sort(),[childId,propId].sort());
    assert.deepEqual(deltas.find((row) => row.propositionId===childId)?.causes,
      [{propositionId:propId,kind:"DERIVED_FROM"}]);
    const oracle = await compareDurableShadowWithOracle(tenantId);
    assert.equal(oracle.equivalent,true);
    assert.equal(oracle.checked,3);
    pass("full-oracle",`All 3 durable beliefs match independent full recomputation after source change`);
    const laterKnownAt=(await client.query<{at:Date}>("SELECT clock_timestamp() at")).rows[0]!.at.toISOString();
    const preservedReplay=await replayDurableEpistemicGraph({tenantId,graphVersionId:staged.graphVersionId,
      validAt:historicalKnownAt,knownAt:historicalKnownAt});
    const laterReplay=await replayDurableEpistemicGraph({tenantId,graphVersionId:staged.graphVersionId,
      validAt:laterKnownAt,knownAt:laterKnownAt});
    assert.equal(preservedReplay.status,"AVAILABLE");
    assert.equal(laterReplay.status,"AVAILABLE");
    if(preservedReplay.status==="AVAILABLE" && laterReplay.status==="AVAILABLE") {
      assert.deepEqual(preservedReplay.state.propositions.find((row)=>row.id===propId)?.value,
        {kind:"DETERMINISTIC",value:"good"});
      assert.deepEqual(laterReplay.state.propositions.find((row)=>row.id===propId)?.value,
        {kind:"DETERMINISTIC",value:"bad"});
    }
    pass("bitemporal-replay",`Earlier knownAt remains good after later evidence changed the current belief to bad`);
    const releaseSha = "a".repeat(40);
    await assert.rejects(activateDurableEpistemicImpact({tenantId,graphVersionId:staged.graphVersionId,releaseSha}),
      /No fresh protocol-2 epistemic worker/);
    await client.query(`INSERT INTO finnor_os.service_release_heartbeats
      (service,instance_id,release_sha,build_id,version,release_source,migration_head,capabilities,environment)
      VALUES('worker','scope5-smoke',$1,'scope5-smoke','scope5-smoke','certification',$2,ARRAY['epistemic-v2'],'test')`,[releaseSha,CURRENT_MIGRATION_HEAD]);
    await activateDurableEpistemicImpact({tenantId,graphVersionId:staged.graphVersionId,releaseSha});
    const postActivationPinGuard = (await client.query<{reasons:string[]}>(
      "SELECT finnor_os.epistemic_execution_block_reasons($1,$2,$3,true) reasons",[tenantId,planId,"high-risk-node"])).rows[0]!.reasons;
    assert(postActivationPinGuard.includes("EPISTEMIC_PIN_STALE"));
    await setEpistemicKillSwitch(tenantId,true);
    assert.deepEqual((await client.query<{reasons:string[]}>(
      "SELECT finnor_os.epistemic_execution_block_reasons($1,$2,$3,true) reasons",
      [tenantId,planId,"high-risk-node"])).rows[0]!.reasons,[]);
    await setEpistemicKillSwitch(tenantId,false);
    assert((await client.query<{reasons:string[]}>(
      "SELECT finnor_os.epistemic_execution_block_reasons($1,$2,$3,true) reasons",
      [tenantId,planId,"high-risk-node"])).rows[0]!.reasons.includes("EPISTEMIC_PIN_STALE"));
    pass("activation-and-disable",`Activation refused absent exact protocol-2 heartbeat; reversible kill switch restored legacy fallback without erasing immutable facts`);
    assert.deepEqual((await client.query<{reasons:string[]}>(
      "SELECT finnor_os.epistemic_execution_block_reasons($1,$2,$3,false) reasons",[tenantId,planId,"unrelated-node"])).rows[0]!.reasons,[]);
    pass("exact-plan-gate",`Activated stale mandatory pin blocks only the dependent PlanNode`);
    const peContext={auth:{tenantId,userId,role:"owner" as const},provenance:{
      sourceSystem:"certification:scope5",externalId:actionId,createdBy:userId}};
    await assert.rejects(satisfyClosingCondition(peContext,{dealId,closingConditionId:conditionId,expectedVersion:1}),
      (error:unknown) => error instanceof Error && /Mandatory epistemic premises changed/.test(error.message));
    assert.equal((await client.query("SELECT state FROM finnor_os.pe_closing_conditions WHERE tenant_id=$1 AND id=$2",
      [tenantId,conditionId])).rows[0].state,"open");
    pass("final-pe-transaction",`PE closing mutation rejected stale pin inside its final owner transaction; canonical condition remained open`);
    const beforeRollback=(await client.query<{count:number}>(
      "SELECT count(*)::int count FROM finnor_os.epistemic_changes WHERE tenant_id=$1",[tenantId])).rows[0]!.count;
    await client.query("BEGIN");
    await client.query("INSERT INTO finnor_os.evidence_source_versions(source_id,scope,tenant_id,version_number,content_hash,content,snapshot,as_of) VALUES($1,'tenant',$2,3,$3,'rolled back',$4,clock_timestamp())",
      [sourceId,tenantId,"3".repeat(64),{rating:"rolled-back"}]);
    await client.query("ROLLBACK");
    assert.equal((await client.query<{count:number}>(
      "SELECT count(*)::int count FROM finnor_os.epistemic_changes WHERE tenant_id=$1",[tenantId])).rows[0]!.count,beforeRollback);
    assert.equal((await client.query<{count:number}>(
      "SELECT count(*)::int count FROM finnor_os.evidence_source_versions WHERE source_id=$1 AND version_number=3",[sourceId])).rows[0]!.count,0);
    pass("atomic-source-rollback",`Rolled-back source version left neither EvidenceChange nor committed source row`);
    const concurrentClients=[new pg.Client({connectionString:url}),new pg.Client({connectionString:url})];
    await Promise.all(concurrentClients.map((connection)=>connection.connect()));
    try {
      await Promise.all([
        concurrentClients[0]!.query("INSERT INTO finnor_os.evidence_source_versions(source_id,scope,tenant_id,version_number,content_hash,content,snapshot,as_of) VALUES($1,'tenant',$2,3,$3,'third',$4,clock_timestamp())",
          [sourceId,tenantId,"4".repeat(64),{rating:"bad"}]),
        concurrentClients[1]!.query("INSERT INTO finnor_os.evidence_source_versions(source_id,scope,tenant_id,version_number,content_hash,content,snapshot,as_of) VALUES($1,'tenant',$2,1,$3,'late old assertion',$4,now()-interval '7 days')",
          [alternateSourceId,tenantId,"5".repeat(64),{rating:"good"}]),
      ]);
    } finally { await Promise.all(concurrentClients.map((connection)=>connection.end())); }
    const concurrentChanges=(await client.query<{id:string;ingestion_order:string}>(
      "SELECT id,ingestion_order::text FROM finnor_os.epistemic_changes WHERE tenant_id=$1 AND status<>'processed' ORDER BY ingestion_order",
      [tenantId])).rows;
    assert.equal(concurrentChanges.length,2);
    const earlyAttempt=await processDurableEpistemicChange(tenantId,concurrentChanges[1]!.id);
    assert.equal(earlyAttempt.reason,"EARLIER_CHANGE_PENDING");
    for (const change of concurrentChanges) {
      let result=await processDurableEpistemicChange(tenantId,change.id,1);
      for (let retry=0;retry<8 && !result.complete;retry+=1) result=await processDurableEpistemicChange(tenantId,change.id,1);
      assert.equal(result.complete,true);
    }
    const concurrentOracle=await compareDurableShadowWithOracle(tenantId,{recordShadowCheckpoint:false});
    assert.equal(concurrentOracle.equivalent,true);
    assert.equal((await client.query<{count:number}>(
      "SELECT count(*)::int count FROM finnor_os.epistemic_changesets WHERE tenant_id=$1 AND change_id=ANY($2::uuid[])",
      [tenantId,concurrentChanges.map((row)=>row.id)])).rows[0]!.count,2);
    pass("concurrent-ordered-sources",`Two concurrently accepted source versions converged in ingestion order; out-of-order delivery deferred and full oracle matched`);
    const beforeStructure = await client.query("SELECT mode,graph_structure_epoch,staged_structure_epoch FROM finnor_os.epistemic_runtime_controls WHERE tenant_id=$1",[tenantId]);
    await client.query(`INSERT INTO finnor_os.pe_deals
      (tenant_id,target_organization_id,name,deal_lead_employee_id,signed_loi_at,target_closing_at,source_system,external_id,created_by)
      VALUES($1,$2,'Scope 5 new Deal',$3,now(),now()+interval '30 days','certification:scope5','new-deal',$4)`,[tenantId,companyId,userId,userId]);
    const afterStructure = await client.query("SELECT mode,graph_structure_epoch,staged_structure_epoch FROM finnor_os.epistemic_runtime_controls WHERE tenant_id=$1",[tenantId]);
    const guard = await client.query("SELECT finnor_os.epistemic_execution_block_reasons($1,NULL,NULL,true) reasons",[tenantId]);
    assert.equal(Number(afterStructure.rows[0].graph_structure_epoch),Number(beforeStructure.rows[0].graph_structure_epoch)+1);
    assert((guard.rows[0].reasons as string[]).includes("EPISTEMIC_GRAPH_REFRESH_REQUIRED"));
    await assert.rejects(satisfyClosingCondition(peContext,{dealId,closingConditionId:conditionId,expectedVersion:1}),
      (error:unknown) => error instanceof Error && /Mandatory epistemic premises changed/.test(error.message));
    const structuralChanges = await client.query<{id:string}>(
      "SELECT id FROM finnor_os.epistemic_changes WHERE tenant_id=$1 AND status='pending' ORDER BY ingestion_order",[tenantId]);
    for (const change of structuralChanges.rows) {
      assert.equal((await processDurableEpistemicChange(tenantId,change.id)).complete,true);
    }
    await setEpistemicKillSwitch(tenantId,true);
    const refreshed = await prepareTenantPrivateEquityEpistemicGraph({
      ctx:{ auth:{ tenantId,userId:"system:scope5-smoke",role:"owner" } },baselineBatchSize:64,baselineBatches:16,
    });
    assert.equal(refreshed.status,"BASELINE_COMPLETE");
    assert(refreshed.graphVersionId);
    assert(refreshed.propositionCount>=3);
    assert.equal((await client.query<{ kill_switch:boolean }>(
      "SELECT kill_switch FROM finnor_os.epistemic_runtime_controls WHERE tenant_id=$1",[tenantId])).rows[0]?.kill_switch,true);
    const refreshOracle = await compareDurableShadowWithOracle(tenantId);
    assert.equal(refreshOracle.equivalent,true);
    assert.equal(refreshOracle.checked,refreshed.propositionCount);
    await assert.rejects(activateDurableEpistemicImpact({tenantId,graphVersionId:refreshed.graphVersionId,releaseSha}),
      /kill switch off/);
    await setEpistemicKillSwitch(tenantId,false);
    await activateDurableEpistemicImpact({tenantId,graphVersionId:refreshed.graphVersionId,releaseSha});
    const reactivated = (await client.query("SELECT mode,graph_structure_epoch,staged_structure_epoch FROM finnor_os.epistemic_runtime_controls WHERE tenant_id=$1",[tenantId])).rows[0];
    assert.equal(reactivated.mode,"active");
    assert.equal(reactivated.graph_structure_epoch,reactivated.staged_structure_epoch);
    const retiredReplay=await replayDurableEpistemicGraph({tenantId,graphVersionId:staged.graphVersionId,
      validAt:new Date().toISOString(),knownAt:new Date().toISOString()});
    assert.equal(retiredReplay.status,"UNAVAILABLE_AFTER_RETIREMENT");
    pass("structural-refresh",`New PE Deal advanced epoch, fenced execution, rebuilt/baselined graph and required explicit reactivation`);
  } finally { await client.end(); }
});
await populatedUpgrade();
await calibrationHistory();
await freshnessPropagation();
await digitalTwinRestatement();
performanceCorpus();
gates.push({id:"staging-and-live",status:"BLOCKED_EXTERNAL",evidence:"No staging/live deployment or exact release worker proof was supplied; local embedded PostgreSQL is not an external environment."});
const report = {schema:"finnor.scope5-epistemic-impact-certification.v1",generatedAt:new Date().toISOString(),
  migrationHead:CURRENT_MIGRATION_HEAD,status:"PASS_INTEGRATION",gates,benchmarks};
await writeFile(REPORT_JSON,JSON.stringify(report,null,2)+"\n");
await writeFile(REPORT_MD,["# Scope 5 Epistemic Intelligence certification","",
  `Generated: ${report.generatedAt}`,
  `Migration head: ${CURRENT_MIGRATION_HEAD}`,
  "",
  "Local result: PASS_INTEGRATION. Staging and live remain BLOCKED_EXTERNAL.",
  "",
  "| Gate | Status | Evidence |","| --- | --- | --- |",
  ...gates.map((gate) => `| ${gate.id} | ${gate.status} | ${gate.evidence} |`),""].join("\n"));
console.log(JSON.stringify({status:report.status,migrationHead:report.migrationHead,passed:gates.filter((gate) => gate.status==="PASS_INTEGRATION").length,
  blockedExternal:gates.filter((gate) => gate.status==="BLOCKED_EXTERNAL").length,report:REPORT_JSON}));
}
main().catch((error) => { console.error(error); process.exit(1); });
