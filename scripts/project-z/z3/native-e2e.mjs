// Failure-first actual mounted owner/recovery procedure. It never provisions
// DB/Auth, runs migrations, starts listeners, creates signers or dispatches effects.
import { createRequire } from "node:module"
import { existsSync } from "node:fs"
import { readFile, mkdir, writeFile } from "node:fs/promises"
import { resolve, isAbsolute, join } from "node:path"
import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import { once } from "node:events"

const args = Object.fromEntries(process.argv.slice(2).map(x => { const i=x.indexOf("="); return [x.slice(0,i),x.slice(i+1)] }))
const output = args["--output"]
if (!output || !isAbsolute(output)) throw Error("Absolute immutable --output is required")
await mkdir(output, { recursive:false })
const report = { schema:"finnor.z3.native-e2e.v1", status:"NOT_RUN", steps:[], failures:[],
  nativePositive:false, physicalRecovery:[], mountedReload:false, installed:false,
  protectedAdmission:"NOT_RUN", financialQualification:"NOT_RUN", money:null, unknownCostsAreNotZero:true }
let browser, worker
try {
  // An environment flag does not confer permission. The coordinator must supply
  // an explicit current-source-bound authorization for an EXISTING disposable target.
  if (!args["--authorization"] || !isAbsolute(args["--authorization"])) {
    report.failures.push("EXPLICIT_EXISTING_DB_AUTH_OWNED_WORKER_AUTHORIZATION_NOT_DELIVERED")
    process.exitCode=78
  } else {
    const permission = JSON.parse(await readFile(args["--authorization"],"utf8"))
    if (permission.schema!=="finnor.z3.existing-disposable-authorization.v1"
      || permission.coordinatorAuthorized!==true || permission.provisioningAllowed!==false
      || permission.effectsAllowed!==false || permission.workerTerminationAllowed!==true
      || permission.listenersAlreadyOwned!==true || !Array.isArray(permission.cases)
      || permission.cases.length!==3 || !isAbsolute(permission.workerEntry)
      || !existsSync(join(permission.repository,"finnor-os/node_modules/.bin/tsx"))
      || !isAbsolute(permission.producerBundle) || !isAbsolute(permission.checkerSource)
      || !isAbsolute(permission.repository) || !permission.sourceDigest)
      throw Error("EXACT_COORDINATOR_AUTHORIZATION_REQUIRED")
    if (process.env.AUTH_DEV_BYPASS || process.env.NODE_ENV==="production"
      || process.env.FINNOR_ENVIRONMENT!=="staging" || !process.env.TEST_OWNER_EMAIL || !process.env.TEST_OWNER_PASSWORD)
      throw Error("REAL_DISPOSABLE_AUTH_NO_BYPASS_REQUIRED")
    const target = new URL(permission.frontend)
    if (!["127.0.0.1","localhost"].includes(target.hostname) || target.protocol!=="http:"
      || target.username || target.password || target.pathname!=="/") throw Error("OWNED_LOOPBACK_FRONTEND_REQUIRED")
    const require = createRequire(join(permission.repository,"package.json"))
    const {chromium} = require("@playwright/test")
    browser = await chromium.launch({headless:true})
    const context = await browser.newContext({baseURL:target.origin})
    const page = await context.newPage()
    await page.goto("/centropy/login")
    await page.getByLabel("Email").fill(process.env.TEST_OWNER_EMAIL)
    await page.getByLabel("Password").fill(process.env.TEST_OWNER_PASSWORD)
    await page.getByRole("button",{name:"Sign in",exact:true}).click()
    await page.getByRole("heading",{name:"What needs to move forward?"}).waitFor()
    const me = await context.request.get("/api/centropy/me")
    if (me.status()!==200 || (await me.json()).role!=="owner") throw Error("REAL_OWNER_AUTH_REQUIRED")
    const post = async (op,body) => {
      const r=await context.request.post("/api/centropy/company-brain/"+op,{data:body})
      if (!r.ok()) throw Error("NATIVE_OPERATION_"+op+"_HTTP_"+r.status())
      return r.json()
    }
    // The proof worker runs through the repo's own tsx runtime, exactly like the
    // production worker app ("start": "tsx src/index.ts"). Plain node cannot load the
    // TypeScript workspace graph, and single-file bundling was rejected because it
    // breaks the runtime's source self-binding (economic-attribution digests its own
    // files through import.meta.url).
    const startWorker = (point) => {
      const child=spawn(join(permission.repository,"finnor-os/node_modules/.bin/tsx"),[permission.workerEntry],
        {cwd:join(permission.repository,"finnor-os"),stdio:["ignore","ignore","ignore","ipc"],
        env:{...process.env,PORT:"",FINNOR_Z3_DISPOSABLE_RECOVERY:"1",FINNOR_Z3_FAULT_POINT:point??"",
          FINNOR_Z3_AUTHORIZED_SOURCE:permission.sourceDigest,
          FINNOR_Z3_PRODUCER_BUNDLE:permission.producerBundle,FINNOR_Z3_CHECKER_SOURCE:permission.checkerSource}})
      return child
    }
    const timeout = (ms) => new Promise((_,reject)=>{const t=setTimeout(()=>reject(Error("FINITE_NATIVE_DEADLINE")),ms);t.unref()})
    for (const [i,point] of ["CLAIM","STRATEGY","OBSERVATION"].entries()) {
      const input=permission.cases[i]
      if (!input.workId || input.sourceDigest!==permission.sourceDigest) throw Error("ORIGINAL_REAL_WORK_AND_SOURCE_REQUIRED")
      const before=await post("viability-read",{sessionId:input.sessionId,root:input.root})
      const identity=JSON.stringify([before.workId,before.originalParentId,before.reservationRef,before.deadlineAt,before.obligationRefs])
      worker=startWorker(point)
      const interrupted=new Promise((resolve,reject)=>{
        worker.on("message",m=>{if(m?.kind==="Z3_DURABLE_BOUNDARY" && m.point===point && m.sessionId===input.sessionId)resolve(m)})
        worker.once("error",reject)
      })
      await post("viability-recover",{sessionId:input.sessionId,root:input.root,idempotencyKey:"native-proof-"+point})
      const boundary=await Promise.race([interrupted,timeout(90000)])
      worker.kill("SIGKILL")
      const [code,signal]=await once(worker,"exit")
      if (signal!=="SIGKILL") throw Error("PHYSICAL_INTERRUPTION_NOT_OBSERVED")
      report.physicalRecovery.push({point,code,signal,claimFence:boundary.claimFence})
      worker=startWorker()
      // A killed reconcilable job still counts as live until its durable lease
      // expires. Repost the same idempotent recovery until a fresh recovery job
      // is actually enqueued (or the session reached a terminal state).
      let recovery=null
      const recoverDeadline=Date.now()+90000
      do {
        recovery=await post("viability-recover",{sessionId:input.sessionId,root:input.root,idempotencyKey:"native-restart-"+point})
        if (recovery.recovery==="ENQUEUED"||recovery.recovery==="NOT_REQUIRED_TERMINAL") break
        await page.waitForTimeout(500)
      } while(Date.now()<recoverDeadline)
      if (!recovery||(recovery.recovery!=="ENQUEUED"&&recovery.recovery!=="NOT_REQUIRED_TERMINAL")) throw Error("RECOVERY_NEVER_ENQUEUED")
      let after
      const end=Date.now()+90000
      do {
        after=await post("viability-read",{sessionId:input.sessionId,root:input.root})
        if (after.pendingJobs===0) break
        await page.waitForTimeout(250)
      } while(Date.now()<end)
      if (after.pendingJobs!==0 || JSON.stringify([after.workId,after.originalParentId,after.reservationRef,after.deadlineAt,after.obligationRefs])!==identity
        || after.remainingBudget>before.remainingBudget || after.claimFence<=boundary.claimFence
        || after.costs.attempts<before.costs.attempts || after.stalePublications!==0
        || after.unknownClearedWithoutS6!==false) throw Error("ORIGINAL_IDENTITY_BUDGET_OBLIGATION_OR_FENCE_NOT_PRESERVED")
      report.steps.push({point,workId:after.workId,status:after.status,sourceDigest:after.sourceDigest,
        sameIdentity:true,costs:after.costs,remainingBudget:after.remainingBudget})
      worker.kill("SIGTERM");await once(worker,"exit");worker=null
    }
    const positive=permission.cases[0]
    const result=await post("viability-read",{sessionId:positive.sessionId,root:positive.root})
    if (result.status!=="VIABLE" || result.check?.status!=="VIABLE" || !result.s4Consumed
      || !result.s5Current || !result.s7CostRef || result.nativeTransitions<2) throw Error("USEFUL_NATIVE_RECURRING_POSITIVE_REQUIRED")
    report.nativePositive=true
    await page.goto(permission.mountedWorkPath)
    await page.getByRole("heading",{name:"Recurring strategy"}).waitFor()
    await page.reload()
    await page.getByText("Conditional recurrence is not a per-request deadline.").waitFor()
    report.mountedReload=true
    const screenshot=await page.screenshot({animations:"disabled"})
    await writeFile(resolve(output,"mounted-work.png"),screenshot,{flag:"wx",mode:0o600})
    report.screenshotDigest=createHash("sha256").update(screenshot).digest("hex")
    report.status="PASS"
  }
} catch(error) {
  report.status="FAIL";report.failures.push(error instanceof Error?error.message:"NATIVE_PROOF_FAILED");process.exitCode=1
} finally {
  if(worker){worker.kill("SIGTERM");await once(worker,"exit").catch(()=>undefined)}
  await browser?.close()
  await writeFile(resolve(output,"report.json"),JSON.stringify(report,null,2)+"\n",{flag:"wx",mode:0o600})
  console.log(JSON.stringify({status:report.status,failures:report.failures,nativePositive:report.nativePositive}))
}
