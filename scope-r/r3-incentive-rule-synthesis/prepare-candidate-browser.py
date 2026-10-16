"""Extend the primary mounted E2E with exact, retained fixture-only variants."""
import hashlib
import json
import pathlib
import sys

repo = pathlib.Path(__file__).resolve().parents[2]
out = pathlib.Path(sys.argv[1]).resolve()
out.mkdir(parents=True, exist_ok=True)
directory = repo / "finnor-os/scripts/r3"


def replace_once(source, old, new):
    if source.count(old) != 1:
        raise SystemExit("R3_FIXTURE_PREIMAGE_CHANGED: " + old[:80])
    return source.replace(old, new)


original = (directory / "run-owner-e2e.mts").read_text()
owner = replace_once(original, "name === 'positive' ? await publishedProgramTarget",
                     "['positive', 'browser'].includes(name) ? await publishedProgramTarget")
owner = replace_once(owner, "(await import('./browser-tool-proof.mjs')).proveMountedWorkWithTools",
                     "(await import('./.repair-candidate-browser.mts')).proveMountedWorkWithTools")
owner = replace_once(owner, "    await reviewProposedUse(f, item.requestId, 'Mounted existing Work proof, no effect authority');\n", "")
owner = replace_once(owner, "      objective: JSON.stringify(protocol.check.objective),\n", """      objective: JSON.stringify(protocol.check.objective),
      programTarget: item.input.programTarget,
      verifyCandidate: async () => {
        const issued = (await admin.query(`SELECT id,request,problem,status,deadline_at FROM finnor_os.r3_requests
          WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 AND id<>$4`,
          [f.tenant,f.principal,item.work.workId,item.requestId])).rows;
        assert.equal(issued.length,1,'Actual UI must create exactly one new bound request');
        assert.deepEqual(issued[0].request.programTarget,item.input.programTarget);
        assert.deepEqual(issued[0].problem.binding.programTarget,item.input.programTarget);
        candidateOriginalDeadline=issued[0].deadline_at;
        assert(browserWorker!.child.exitCode===null&&browserWorker!.child.signalCode===null,'R3_PHYSICAL_WORKER_NO_LONGER_LIVE');
        try {
          await waitFor(async()=> (await admin.query('SELECT status FROM finnor_os.r3_requests WHERE id=$1',[issued[0].id])).rows[0],
            value=>!['QUEUED','RUNNING'].includes(value.status),
            Math.max(0,Math.min(90,(Date.parse(originalM1.binding.validUntil)-Date.now())/1000,(new Date(issued[0].deadline_at).getTime()-Date.now())/1000)));
          assert.equal((await admin.query('SELECT status FROM finnor_os.r3_requests WHERE id=$1',[issued[0].id])).rows[0].status,'COMPLETE');
        } finally { /* The same live registered worker remains owned by this story. */ }
        const checked = successful(await http.call(f.principal,'elicitation-protocols','read',{requestId:issued[0].id}));
        assert.deepEqual(checked.protocol.problem.binding.programTarget,item.input.programTarget);
        await artifact('browser/candidate-owner-readback.json',{issued,checked,
          programme:item.input.programTarget,originalRequestId:item.requestId,authorityGranted:false});
        const superseded=await readback(item);
        assert.equal(superseded.request.status,'INVALIDATED');
        assert.equal(superseded.request.failure,'R3_NEW_WORK_PROPOSAL_OLD_AGREEMENTS_AND_LIABILITIES_RETAINED');
        assert.deepEqual(superseded.request.deadline_at,row.request.deadline_at);
        await artifact('browser/original-supersession-readback.json',superseded);
        return {requestId:issued[0].id,status:checked.status,programme:item.input.programTarget,rule:checked.protocol.rule,
          originalDeadline:issued[0].deadline_at};
      },
      verifyBeforeRevision:async (requestId:string)=>{
        assert(Date.now()<Date.parse(originalM1.binding.validUntil),'R3_ORIGINAL_M1_VALIDITY_EXHAUSTED_BEFORE_REVISION');
        const current=successful(await http.call(f.principal,'elicitation-protocols','read',{requestId}));
        assert.equal(current.status,'COMPLETE');
        await artifact('browser/current-before-preference-revision.json',current);
      },
      verifyUiReview:async (requestId:string)=>{
        const current=successful(await http.call(f.principal,'elicitation-protocols','read',{requestId}));
        assert.equal(current.status,'COMPLETE');
        const durable=(await admin.query('SELECT deadline_at,use_policy_ref,allocation_ref,schedules_ref FROM finnor_os.r3_requests WHERE id=$1',[requestId])).rows[0];
        assert(durable.use_policy_ref&&durable.allocation_ref&&durable.schedules_ref);
        assert(current.usePolicy&&current.allocation&&current.schedules);
        assert.equal(current.schedules.branches.length,81);
        assert.equal(current.schedules.branches.reduce((n:number,b:any)=>n+b.obligations.length,0),324);
        const stages=http.observed.filter((o:any)=>o.family==='elicitation-protocols'&&['review','reserve','schedules'].includes(o.operation)&&o.boundary==='REAL_HTTP_ROUTE');
        assert.deepEqual(stages.map((o:any)=>[o.operation,o.status]),[['review',200],['reserve',200],['schedules',200]]);
        assert(stages.every((o:any)=>o.elapsedMs<30000));
        assert(candidateOriginalDeadline); assert.deepEqual(durable.deadline_at,candidateOriginalDeadline);
        await artifact('browser/actual-ui-owner-review.json',{requestId,current,durable,stages,originalGrantsExtended:false,executionAuthorityGranted:false});
        return {requestId,status:current.status,branches:81,obligations:324,stages};
      },
      verifyRevision:async (requestId:string)=>{
        const current=successful(await http.call(f.principal,'elicitation-protocols','read',{requestId}));
        assert.equal(current.status,'INVALIDATED');
        const retained=(await admin.query('SELECT id,status,failure,deadline_at,attempts_used FROM finnor_os.r3_requests WHERE id=$1',[requestId])).rows[0];
        assert.notEqual(retained.failure,'R3_NEW_WORK_PROPOSAL_OLD_AGREEMENTS_AND_LIABILITIES_RETAINED');
        const attempts=(await admin.query('SELECT id,phase,status FROM finnor_os.r3_attempts WHERE request_id=$1',[requestId])).rows;
        assert.equal(attempts.length,2);
        await artifact('browser/current-preference-revision-readback.json',{current,retained,attempts});
        return {requestId,status:current.status,failure:retained.failure};
      },
""")

# Compile and authenticate the actual existing Work before the short M1
# witness is published. Never extend an issued M1/M3/R3 validity interval.
owner = replace_once(owner, "    const f = await owner('r3-browser', 64, 2), item = await submit(f, 'browser');",
                     "    const f = await owner('r3-browser', 64, 2);")
owner = replace_once(owner, "    assert.equal((await runJob(item.requestId)).status, 'COMPLETE');\n"
                     "    const row = await readback(item), protocol = successful(await http.call(f.principal,\n"
                     "      'elicitation-protocols', 'read', { requestId: item.requestId })).protocol;\n", "")
owner = replace_once(owner, "    const own = await thread(item.work.workId), alternate = await thread(f.preparedWorks[0].work.workId);",
                     "    const own = await thread(f.preparedWorks[0].work.workId), alternate = await thread(f.preparedWorks[1].work.workId);")
owner = replace_once(owner, "    const browserDriver = process.env.FINNOR_R3_BROWSER_DRIVER === 'tools'", """    const beforePublication = (await admin.query(`SELECT
      (SELECT count(*) FROM finnor_os.m3_queries WHERE tenant_id=$1 AND work_id=$2) m3,
      (SELECT count(*) FROM finnor_os.r3_requests WHERE tenant_id=$1 AND work_id=$2) r3`,
      [f.tenant,f.preparedWorks[0].work.workId])).rows[0];
    assert.deepEqual(beforePublication,{m3:'0',r3:'0'});
    await artifact('browser/preparation-original-publication-counts.json',beforePublication);
    const prepared = await (await import('./browser-tool-proof.mjs')).prepareMountedWorkWithTools({
      repo,output:directory,apiOrigin:http.origin,authOrigin:http.authOrigin,threadId:own.id,
      ownerEmail:await email(f.principal),prepublication:true});
    let browserWorker:Awaited<ReturnType<typeof startWorker>>|undefined;
    let candidateOriginalDeadline:Date|undefined;
    try {
    const item = await submit(f,'browser');
    assert.equal((await runJob(item.requestId)).status,'COMPLETE');
    const row = await readback(item), protocol = successful(await http.call(f.principal,
      'elicitation-protocols','read',{requestId:item.requestId})).protocol;
    const originalProgramme = JSON.parse(await readFile(join(output,'positive/original-m3-publication.json'),'utf8'));
    const originalM1 = await (await import('../../packages/private-equity/src/decision-slice/service'))
      .readCurrentDecisionSlice(f.ctx,originalProgramme.current.program.evidenceSlice);
    await artifact('browser/original-m3-validity.json',{originalM1ValidUntil:originalM1.binding.validUntil,
      originalR3Deadline:row.request.deadline_at,originalProgramme:item.input.programTarget,
      preparationCompletedBeforePublication:true,grantsAndValidityExtended:false});
    browserWorker=await startWorker(120);
    const browserDriver = process.env.FINNOR_R3_BROWSER_DRIVER === 'tools'""")
owner = replace_once(owner, "      repo, output: directory, apiOrigin: http.origin, authOrigin: http.authOrigin,",
                     "      repo, output: directory, apiOrigin: http.origin, authOrigin: http.authOrigin, prepared, m3ValidUntil:originalM1.binding.validUntil,")
owner = replace_once(owner, "      foreignTenantCleared: true, revisionCleared: true, costsAndOriginalDeadlineRetained: true };\n  });",
                     "      foreignTenantCleared: true, revisionCleared: true, costsAndOriginalDeadlineRetained: true };\n    } finally {if(browserWorker)await stopWorker(browserWorker.child);await prepared.close()}\n  });")

owner = replace_once(owner, "      delayRead: () => http.delayRead(item.requestId),", "      delayRead: (requestId?:string) => http.delayRead(requestId??item.requestId),")

browser_original = (directory / "browser-tool-proof.mts").read_text()
browser = replace_once(browser_original, "input: Parameters<typeof proveMountedWork>[0]",
                       "input: Parameters<typeof proveMountedWork>[0] & {programTarget:any;m3ValidUntil:string;verifyCandidate:()=>Promise<any>;verifyUiReview:(requestId:string)=>Promise<any>;verifyBeforeRevision:(requestId:string)=>Promise<void>;verifyRevision:(requestId:string)=>Promise<any>;delayRead:(requestId?:string)=>ReturnType<Parameters<typeof proveMountedWork>[0]['delayRead']>}")
browser = replace_once(browser, "'?elicitationRequest=' + input.requestId;",
                       "'?elicitationRequest=' + input.requestId + '&capitalQuery=' + input.programTarget.queryId;")
browser = replace_once(browser, "      password: 'r3-disposable-local-only', requestId: input.requestId,",
                       "      password: 'r3-disposable-local-only', requestId: input.requestId, programTarget: input.programTarget,")
browser = replace_once(browser, "      if (operation === 'arm-delay')",
                       "      if (operation === 'candidate-bound') { const checked=await input.verifyCandidate(); currentRequestId=checked.requestId; currentRule=checked.rule; await save('candidate-bound',checked) }\n      else if (operation === 'owner-review') { await save('ui-reviewed',await input.verifyUiReview(currentRequestId)); assert(command.snapshot.includes(currentRequestId)); }\n      else if (operation === 'arm-delay')")
browser = replace_once(browser, "['mounted', 'reload', 'work-cleared', 'foreign-cleared', 'revision-cleared']",
                       "['candidate-bound', 'mounted', 'reload', 'work-cleared', 'foreign-cleared', 'revision-cleared']")

browser = replace_once(browser, "deadlineAt: new Date(Date.now() + 600000).toISOString(), pid: web.pid", "deadlineAt: new Date(Math.min(Date.now()+600000,Date.parse(input.m3ValidUntil))).toISOString(), originalM1ValidUntil:input.m3ValidUntil, pid:web.pid")
browser = replace_once(browser, "const until = Date.now() + 600000; let sequence = 0;", "const until = Math.min(Date.now()+600000,Date.parse(input.m3ValidUntil)); let sequence = 0;")

browser = replace_once(browser, "  const observations: any[] = [], started = performance.now();", "  const observations: any[] = [], started = performance.now();\n  let currentRequestId=input.requestId,currentRule=input.rule;")
browser = replace_once(browser, "delayed = input.delayRead()", "delayed = input.delayRead(currentRequestId)")
browser = replace_once(browser, "const row = input.rule.table[i];", "const row = currentRule.table[i];")
browser = replace_once(browser, "        if (operation === 'reload') assert.deepEqual(command.cells, observations.find(o => o.operation === 'mounted').cells);", "        assert(command.snapshot.includes(currentRequestId),'R3_RELOAD_REQUIRES_CURRENT_CHECKED_REQUEST');")
browser = replace_once(browser, "assert(!command.snapshot.includes(input.requestId))", "assert(!command.snapshot.includes(currentRequestId))")
browser = replace_once(browser, "assert(!revision); revision = await input.revise()", "assert(!revision); await input.verifyBeforeRevision(currentRequestId); revision = await input.revise()")
browser = replace_once(browser, "if (operation === 'revision-cleared') { assert(revision); assert(command.snapshot.includes('INVALIDATED')) }", "if (operation === 'revision-cleared') { assert(revision); assert(command.snapshot.includes('INVALIDATED')); await save('current-revision',await input.verifyRevision(currentRequestId)) }")
browser = replace_once(browser, "originalRows: 81, reloadedRows: 81, revision, delayedActualOwnerReply: true,", "originalRows: 81, reloadedRows: 81, revision, currentRequestId, originalRequestId:input.requestId, delayedActualOwnerReply: true,")
if "--complement" not in sys.argv[2:] and "--tail" not in sys.argv[2:]:
    browser = replace_once(browser,
        "commands: ['mounted', 'reload', 'arm-delay', 'await-delay', 'release-delay', 'work-cleared', 'foreign-cleared', 'revise', 'revision-cleared', 'finish']",
        "commands: ['mounted','candidate-bound','reload','owner-review','arm-delay','await-delay','release-delay','work-cleared','foreign-cleared','revise','revision-cleared','finish']")
    browser = replace_once(browser, "for (const required of ['candidate-bound', 'mounted', 'reload', 'work-cleared', 'foreign-cleared', 'revision-cleared'])",
                           "for (const required of ['candidate-bound','owner-review','mounted', 'reload', 'work-cleared', 'foreign-cleared', 'revision-cleared'])")

primary = "--primary" in sys.argv[2:]
if primary:
    owner = replace_once(owner,
        "foreignTenantCleared: true, revisionCleared: true, costsAndOriginalDeadlineRetained: true",
        "verificationScope:'CANDIDATE_OWNER_REVIEW_RELOAD_DELAYED_WORK', foreignTenantCleared:'NOT_IN_THIS_CUT', revisionCleared:'NOT_IN_THIS_CUT', costsAndOriginalDeadlineRetained: true")
    browser = replace_once(browser,
        "commands: ['mounted','candidate-bound','reload','owner-review','arm-delay','await-delay','release-delay','work-cleared','foreign-cleared','revise','revision-cleared','finish']",
        "commands: ['mounted','candidate-bound','reload','owner-review','arm-delay','await-delay','release-delay','work-cleared','finish']")
    browser = replace_once(browser,
        "['candidate-bound','owner-review','mounted', 'reload', 'work-cleared', 'foreign-cleared', 'revision-cleared']",
        "['candidate-bound','owner-review','mounted','reload','work-cleared']")
    browser = replace_once(browser,
        "originalRows: 81, reloadedRows: 81, revision, currentRequestId, originalRequestId:input.requestId, delayedActualOwnerReply: true,",
        "originalRows:81,reloadedRows:81,currentRequestId,originalRequestId:input.requestId,delayedActualOwnerReply:true,verificationScope:'CANDIDATE_OWNER_REVIEW_RELOAD_DELAYED_WORK',precedingFullStoryPromotedToPass:false,")

tail = "--tail" in sys.argv[2:]
complement = "--complement" in sys.argv[2:] or tail
if complement:
    # The preceding immutable cut already proved physical UI dispatch, reload,
    # and delayed Work clearing. This cut completes only its two missing oracles.
    owner = replace_once(owner, "    browserWorker=await startWorker(120);\n", "")
    owner = replace_once(owner,
        "exactRows: 81, durableReload: true, delayedWorkReplyCleared: true,",
        "exactRows: 81, verificationScope: 'FOREIGN_IDENTITY_AND_ORIGINAL_PREFERENCE_REVISION', precedingFullStoryPromotedToPass: false,")
    browser = replace_once(browser,
        "commands: ['mounted', 'reload', 'arm-delay', 'await-delay', 'release-delay', 'work-cleared', 'foreign-cleared', 'revise', 'revision-cleared', 'finish']",
        "commands: ['mounted', 'foreign-cleared', 'revise', 'revision-cleared', 'finish']")
    browser = replace_once(browser,
        "['candidate-bound', 'mounted', 'reload', 'work-cleared', 'foreign-cleared', 'revision-cleared']",
        "['mounted', 'foreign-cleared', 'revision-cleared']")
    browser = replace_once(browser,
        "originalRows: 81, reloadedRows: 81, revision, currentRequestId, originalRequestId:input.requestId, delayedActualOwnerReply: true,",
        "originalRows: 81, revision, currentRequestId, originalRequestId:input.requestId, verificationScope:'FOREIGN_IDENTITY_AND_ORIGINAL_PREFERENCE_REVISION', precedingFullStoryPromotedToPass:false,")

minimal_preparation = tail or "--minimal-preparation" in sys.argv[2:]
if minimal_preparation:
    start = owner.index("  const { resolveDecisionWork } = await import('../../packages/private-equity/src/decision-slice/adapters');", owner.index('async function submit('))
    end = owner.index("  const result = successful(await http.call(f.principal, 'elicitation-protocols', 'submit', input));", start)
    owner = owner[:start] + "  // Scoped mounted proof: actual production submit and worker retain all guards; duplicate diagnostics stay in the installed corpus.\n" + owner[end:]
if tail:
    owner = replace_once(owner,"FOREIGN_IDENTITY_AND_ORIGINAL_PREFERENCE_REVISION","DELAYED_WORK_FOREIGN_IDENTITY_AND_ORIGINAL_PREFERENCE_REVISION")
    browser = replace_once(browser,
        "commands: ['mounted', 'foreign-cleared', 'revise', 'revision-cleared', 'finish']",
        "commands: ['mounted','arm-delay','await-delay','release-delay','work-cleared','foreign-cleared','revise','revision-cleared','finish']")
    browser = replace_once(browser,
        "['mounted', 'foreign-cleared', 'revision-cleared']",
        "['mounted','work-cleared','foreign-cleared','revision-cleared']")
    browser = replace_once(browser,
        "verificationScope:'FOREIGN_IDENTITY_AND_ORIGINAL_PREFERENCE_REVISION', precedingFullStoryPromotedToPass:false,",
        "verificationScope:'DELAYED_WORK_FOREIGN_IDENTITY_AND_ORIGINAL_PREFERENCE_REVISION',delayedActualOwnerReply:true,precedingFullStoryPromotedToPass:false,")

records = []
for name, body in [(".repair-candidate-owner.mts", owner), (".repair-candidate-browser.mts", browser)]:
    target = directory / name
    target.write_text(body)
    (out / name.lstrip(".")).write_text(body)
    records.append({"path": str(target), "sha256": hashlib.sha256(body.encode()).hexdigest(),
                    "bytes": len(body.encode())})
(out / "fixture-variant.json").write_text(json.dumps({
    "schema": "finnor.r3.mounted-candidate-fixture-variant.v1", "files": records,
    "originals": [{"path": str(directory / name), "sha256": hashlib.sha256(body.encode()).hexdigest()}
                  for name, body in [("run-owner-e2e.mts", original), ("browser-tool-proof.mts", browser_original)]],
    "productionSourceModified": False, "ownerResponsesIntercepted": False,
    "complementOnly": complement, "primaryOnly": primary, "tailOnly": tail, "minimalDiagnosticPreparation": minimal_preparation,
    "case": "mounted-work-reload-switch", "browserSeconds": 600,
    "rerun": "python3 scope-r/r3-incentive-rule-synthesis/prepare-candidate-browser.py <new-output>; run the retained owner variant with FINNOR_R3_CASES=mounted-work-reload-switch and FINNOR_R3_BROWSER_DRIVER=tools",
}, indent=2) + "\n")
print(json.dumps({"output": str(out), "files": records}))
