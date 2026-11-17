/** Original mounted predicates through the assigned supported browser client. */
import assert from "node:assert/strict";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createAssignedClient, digest, loopbackOrigin } from "./agent-browser-client.mjs";

const argv = process.argv.slice(2);
if (["--provenance-only", "--observe-provenance"].includes(argv[0])) {
  assert(argv.length === 3 && argv[1] === "--output" && argv[2]?.startsWith("/"));
  const client = await createAssignedClient();
  const proof = argv[0] === "--observe-provenance"
    ? await client.observeProvenance() : await client.provenance();
  await writeFile(argv[2], JSON.stringify(proof, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ status: proof.status, browser: proof.browser,
    rawEndpointRecorded: false, navigationCommandIssued: proof.navigationCommandIssued,
    nativeObservationIssued: proof.nativeObservationIssued,
    nonceTitleWriteAttempted: proof.nonceTitleWriteAttempted,
    nonlaunchingCommandGuaranteed: proof.nonlaunchingCommandGuaranteed }));
  process.exit(proof.status === "PASS" ? 0 : 2);
}
assert(argv.length === 2 && argv[0] === "--fixture" && argv[1]?.startsWith("/"),
  "EXACT_OWNED_PRIVATE_FIXTURE_REQUIRED");
const file = argv[1], mode = await lstat(file);
assert(mode.isFile() && !mode.isSymbolicLink() && (mode.mode & 0o777) === 0o600
  && mode.uid === process.getuid() && mode.size <= 65536);
const fixture = JSON.parse(await readFile(file, "utf8"));
const origin = loopbackOrigin(fixture.frontendOrigin), controlOrigin = loopbackOrigin(fixture.controlOrigin);
if (process.env.FINNOR_W2_FRONTEND_ORIGIN) assert.equal(origin, loopbackOrigin(process.env.FINNOR_W2_FRONTEND_ORIGIN));
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
assert(uuid.test(fixture.workId) && uuid.test(fixture.participant?.workId));
for (const url of [fixture.url, fixture.otherUrl, fixture.participant.url, fixture.alternate.url, fixture.foreign.url]) {
  const actual = new URL(url);
  assert.equal(actual.origin, origin); assert(actual.pathname.startsWith("/centropy/"));
}
assert.equal(fixture.participant.expectedOwnAssignments, 2);
assert(!fixture.participantOnly, "ORIGINAL_COMPLETE_MOUNTED_PROFILE_REQUIRED");
const client = await createAssignedClient(), evidence = fixture.evidence;
assert(evidence?.startsWith("/") && (await lstat(evidence)).isDirectory());
const reportFile = join(evidence, "mounted-browser-report.json");
const report = { schema: "finnor.postz.w2.mounted-browser-evidence.v1", status: "IN_PROGRESS",
  source: "ACTUAL_SUPPORTED_AGENT_BROWSER_ASSIGNED_CDP_DOM", profile: "ORIGINAL_COMPLETE_MOUNTED",
  genuineHumanQualified: false, protectedQualification: false, assertions: [], steps: [],
  credentialsRecorded: false, browser: { headed: "UNKNOWN", separatelyLaunched: "UNKNOWN" } };
const save = () => writeFile(reportFile, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
const record = async (name, observed, assertion = false) => {
  report.steps.push({ name, at: new Date().toISOString(), observed });
  if (assertion) report.assertions.push(name);
  await save();
  console.log(JSON.stringify({ name, status: "PASS" }));
};
const control = async (name, timeout = 25000, roleDeadlineNs) => {
  assert(["state", "completion", "participant-expiry", "delay-next", "release", "revoke-owner", "finish", "abort",
    "role-sdk", "role-demote", "role-restore"].includes(name));
  const response = await fetch(controlOrigin + "/" + name, {
    method: name === "state" ? "GET" : "POST", headers: { authorization: "Bearer " + fixture.controlKey,
      "content-type": "application/json",
      ...(roleDeadlineNs ? { "x-finnor-w2-role-deadline-ns": roleDeadlineNs } : {}) },
    ...(name === "state" ? {} : { body: "{}" }),
    signal: AbortSignal.timeout(Math.max(1, Math.floor(timeout))),
  });
  assert.equal(response.status, 200, "ACTUAL_OWNED_NATIVE_CONTROL_FAILED:" + name);
  return response.json();
};
const waitControl = async predicate => {
  const deadline = performance.now() + 25000;
  while (performance.now() < deadline) {
    const actual = await control("state", deadline - performance.now());
    if (predicate(actual)) return actual;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error("ORIGINAL_BROWSER_25_SECOND_CONTROL_OBSERVATION_BOUND");
};
const screenshot = name => client.run(["screenshot", join(evidence, "mounted-" + name + ".png")]);
const panel = `[data-workforce-work="${fixture.workId}"]`;
const bodyReady = () => client.wait('Boolean(document.querySelector(".ct-app") || document.querySelector("h1"))'
  + ' && !document.body.textContent.includes("Restoring your private workspace")');
const absent = async name => {
  client.wait('![...document.querySelectorAll("[data-workforce-work]")].some(x=>x.textContent.includes("W2_PRIVATE_MOUNTED_TASK"))');
  const actual = client.dom('const panels=[...document.querySelectorAll("[data-workforce-work]")];'
    + 'if(panels.some(x=>x.textContent.includes("W2_PRIVATE_MOUNTED_TASK")))throw Error("STALE_PRIVATE_CONTRACT_VISIBLE");'
    + 'return {actualDOM:true,privateContractVisible:false,workforcePanelCount:panels.length};');
  screenshot(name); await record(name, actual, true);
};
const button = label => client.run(["find", "role", "button", "click", "--name", label, "--exact"]);
const login = async identity => {
  client.login(origin, fixture[identity]);
  await record("ordinary-form-login-" + identity, { actualSupportedAuthForm: true, credentialsRecorded: false });
};
const signOut = () => {
  const actual = client.dom('return {accountMenu:Boolean(document.querySelector(\'[aria-label="Account menu"]\'))};');
  if (actual.accountMenu) client.run(["click", '[aria-label="Account menu"]']);
  button("Sign out");
  client.wait('[...document.querySelectorAll("a")].some(x=>/^Sign in/.test(x.textContent.trim()))');
};
const roleRevalidationBarrier = async () => {
  const role = fixture.roleRevalidation, started = performance.now(), deadline = started + 45000;
  // Same-host kernel time carries this existing deadline, never a new
  // receive-time 45-second window in the fixture.
  const roleDeadlineNs = (process.hrtime.bigint() +
    BigInt(Math.max(0, Math.floor((deadline - performance.now()) * 1000000)))).toString();
  assert(role && uuid.test(role.userId) && uuid.test(role.tenantId), "REAL_SAME_USER_ROLE_FIXTURE_REQUIRED");
  const pendingUrl = new URL(role.pendingUrl), root = JSON.parse(pendingUrl.searchParams.get("root"));
  assert.equal(pendingUrl.origin, origin); assert.equal(pendingUrl.pathname, new URL(fixture.otherUrl).pathname);
  assert.equal(root.entityType, "pe_deal"); assert(uuid.test(root.entityId));
  assert.equal(role.authOrigin, loopbackOrigin(role.authOrigin)); assert.equal(role.anonKey, "disposable-local-auth");
  const key = "__finnor_w2_role_" + digest(fixture.workId).slice(0, 16), encodedKey = JSON.stringify(key);
  const guard = () => assert(performance.now() < deadline, "MOUNTED_ROLE_CASE_45_SECOND_ABSOLUTE_BOUND");
  const dom = source => {
    guard(); const result = client.dom(`const s=window[${encodedKey}];
      if(!s)throw Error("ROLE_ORIGINAL_DOCUMENT_STATE_LOST");
      if(s.failure)throw Error(s.failure);
      s.consume(s.observer.takeRecords());
      if(s.failure)throw Error(s.failure);
      if(s.requests.some(x=>x.phase==="PENDING"||x.phase==="DEMOTED")
        ||s.resources.some(x=>x.phase==="PENDING"||x.phase==="DEMOTED"))
        throw Error("ROLE_OWNER_READ_DURING_UNSETTLED_AUTHORITY");${source}`); guard(); return result;
  };
  const wait = condition => {
    guard(); client.wait(`(()=>{const s=window[${encodedKey}];return !s||s.failure
      ||s.requests.some(x=>x.phase==="PENDING"||x.phase==="DEMOTED")
      ||s.resources.some(x=>x.phase==="PENDING"||x.phase==="DEMOTED")||(${condition});})()`);
    dom("return true;");
  };
  const command = args => {
    guard(); const result = client.run(args, undefined,
      { timeoutMs: Math.max(1, Math.min(25000, Math.floor(deadline - performance.now()))) });
    guard(); return result;
  };
  const nativeControl = async name => {
    guard(); const result = await control(name, deadline - performance.now(), roleDeadlineNs); guard(); return result;
  };
  const requireRoleRestoration = result => {
    assert(result?.restored === true && result.mutationTerminal === true && result.noPendingMutation === true
      && result.ownerReadbackObserved === true && result.canonicalRole === "owner" && result.status === "active"
      && result.samePrincipalAndTenant === true, "ACTUAL_TERMINAL_OWNER_RESTORATION_REQUIRED");
    return result;
  };
  const schema = "finnor.postz.w2.mounted-role-revalidation.v1";
  let installed = false, failure = null, observed = null, sdkIdentity = null;
  report.roleRevalidation = { schema, status: "IN_PROGRESS", source: "ACTUAL_MOUNTED_FETCH_AND_RESOURCE_TIMING" };
  await save();
  try {
    const sdk = await nativeControl("role-sdk"), bytes = Buffer.from(sdk.base64, "base64");
    assert.equal(sdk.schema, "finnor.postz.w2.mounted-role-sdk.v1");
    assert.equal(sdk.version, "2.99.3", "REVIEWED_REAL_SDK_VERSION_REQUIRED");
    assert.equal(sdk.bytes, 166800, "REVIEWED_REAL_SDK_BYTE_COUNT_REQUIRED");
    assert(bytes.length > 0 && bytes.length <= 1048576 && bytes.length === sdk.bytes);
    assert.equal(bytes.toString("base64"), sdk.base64);
    assert.equal(digest(bytes), sdk.sha256);
    assert.equal(sdk.sha256, "588fb53d9380e3cb8688065c48144fa839205c328b416cc68c11331ba01955ee",
      "REVIEWED_UNMODIFIED_SDK_BUNDLE_REQUIRED");
    assert.equal(sdk.compiledAssetInsideInstallation, true, "COMPILED_FRONTEND_OWN_SDK_REQUIRED");
    const manifest = sdk.installationManifest, projectPath = manifest?.tracingLayout?.projectPath;
    assert(manifest && /^[0-9a-f]{64}$/.test(manifest.sha256) && typeof projectPath === "string"
      && !projectPath.includes("\\") && !projectPath.includes("\0")
      && (!projectPath || projectPath.split("/").every(name => name && name !== "." && name !== "..")),
    "ACTUAL_RUNTIME_PROJECT_MANIFEST_REQUIRED");
    const runtimeProject = ["runtime", projectPath].filter(Boolean).join("/");
    assert.equal(manifest.entrypoint, runtimeProject + "/server.js");
    assert(Array.isArray(manifest.files) && manifest.files.length === 4);
    assert(Array.isArray(manifest.sourcePreimages) && manifest.sourcePreimages.length === 2);
    assert(Array.isArray(sdk.custodyAssets) && sdk.custodyAssets.length === 3);
    const publicBytes = [];
    for (const name of ["frontend-package.json", "frontend-package-lock.json", "sdk-package.json", "supabase.js"]) {
      const path = runtimeProject + "/.finnor-w2-sdk-custody/" + name;
      const pins = manifest.files.filter(pin => pin.path === path);
      assert(pins.length === 1 && pins[0].mode === 0o444 && Number.isSafeInteger(pins[0].bytes)
        && pins[0].bytes > 0 && pins[0].bytes <= 1048576 && /^[0-9a-f]{64}$/.test(pins[0].sha256));
      let actual = bytes;
      if (name !== "supabase.js") {
        const values = sdk.custodyAssets.filter(asset => asset.path === path);
        assert(values.length === 1 && typeof values[0].base64 === "string"
          && values[0].base64.length <= 4 * Math.ceil(1048576 / 3));
        actual = Buffer.from(values[0].base64, "base64");
        assert.equal(actual.toString("base64"), values[0].base64);
      }
      assert.equal(actual.length, pins[0].bytes); assert.equal(digest(actual), pins[0].sha256);
      publicBytes.push(actual);
    }
    for (const [i, path] of ["package.json", "package-lock.json"].entries()) {
      const pins = manifest.sourcePreimages.filter(pin => pin.path === path);
      assert(pins.length === 1 && /^[0-9a-f]{64}$/.test(pins[0].sha256));
      assert.equal(digest(publicBytes[i]), pins[0].sha256, "ACTUAL_BUILD_OWN_FRONTEND_METADATA_REQUIRED");
    }
    const frontendPackage = JSON.parse(publicBytes[0].toString("utf8"));
    const lock = JSON.parse(publicBytes[1].toString("utf8")), sdkPackage = JSON.parse(publicBytes[2].toString("utf8"));
    assert.equal(frontendPackage.name, "centropy"); assert.equal(lock.lockfileVersion, 3);
    assert.equal(lock.name, frontendPackage.name); assert.equal(lock.version, frontendPackage.version);
    assert.equal(lock.packages?.[""]?.name, frontendPackage.name);
    assert.equal(lock.packages?.[""]?.version, frontendPackage.version);
    assert.equal(frontendPackage.dependencies?.["@supabase/supabase-js"], "^2.45.1");
    assert.equal(lock.packages?.[""]?.dependencies?.["@supabase/supabase-js"], frontendPackage.dependencies["@supabase/supabase-js"]);
    assert.equal(sdkPackage.name, "@supabase/supabase-js"); assert.equal(sdkPackage.version, sdk.version);
    assert.equal(lock.packages?.["node_modules/@supabase/supabase-js"]?.version, sdk.version);
    assert.equal(sdk.frontendPackageSha256, digest(publicBytes[0]));
    assert.equal(sdk.packageLockSha256, digest(publicBytes[1]));
    const source = bytes.toString("utf8"); assert(Buffer.from(source, "utf8").equals(bytes));
    sdkIdentity = { version: sdk.version, sha256: sdk.sha256, bytes: sdk.bytes,
      frontendPackageSha256: sdk.frontendPackageSha256,
      installationManifest: manifest,
      packageLockSha256: sdk.packageLockSha256, compiledAssetInsideInstallation: sdk.compiledAssetInsideInstallation };
    guard();
    installed = true;
    client.dom(`const key=${encodedKey};
      if(window[key] || !document.querySelector(".ct-app"))throw Error("SETTLED_OWNER_OR_OWNED_TRACE_REQUIRED");
      const original=window.fetch, prefix="/api/centropy/", started=performance.now();
      const s={timeOrigin:performance.timeOrigin,started,failure:null,phase:"BASELINE",marks:[{phase:"BASELINE",at:started}],
        requests:[],resources:[],delegations:[],active:0,rotations:0,sameUser:true,armed:false,
        meRequested:false,meResponseHeld:false,meDelivered:false,ownerResponseObserved:false,closing:false};
      s.fail=code=>{s.failure=s.failure||code;};
      s.phaseAt=at=>[...s.marks].reverse().find(mark=>mark.at<=at)?.phase??"BEFORE_TRACE";
      s.mark=phase=>{s.phase=phase;s.marks.push({phase,at:performance.now()});};
      s.push=(list,value)=>{if(list.length>=256)s.fail("ROLE_NETWORK_AUDIT_OVERFLOW");else list.push(value);};
      s.path=input=>{const url=new URL(typeof input==="string"?input:input?.url??String(input),location.href);
        return url.origin===location.origin&&url.pathname.startsWith(prefix)?url.pathname.slice(prefix.length):null;};
      s.kind=path=>path==="threads"||path.startsWith("threads/")?"INVESTIGATION":
        path.startsWith("works/")||path==="company-brain/projection"||path.startsWith("investment-cases/")
          ||path.startsWith("private-equity/ic/cases/")?"CANVAS":"OTHER_BUSINESS";
      s.requestGate=new Promise(resolve=>{s.releaseRequest=resolve;});
      s.responseGate=new Promise(resolve=>{s.releaseResponse=resolve;});
      const expectedUser=${JSON.stringify(role.userId)},expectedTenant=${JSON.stringify(role.tenantId)};
      s.identity=body=>body.userId===expectedUser&&body.tenantId===expectedTenant;
      const delegate=(input,init,teardown=false)=>{
        const href=new URL(typeof input==="string"?input:input?.url??String(input),location.href).href;
        s.push(s.delegations,{href,at:performance.now(),teardown});
        return original.call(window,input,init);
      };
      s.wrapper=async function(input,init){
        const path=s.path(input);
        if(path===null)return original.call(window,input,init);
        const method=(init?.method??input?.method??"GET").toUpperCase(),me=path==="me"&&method==="GET";
        if(me&&s.armed){
          s.armed=false;s.meRequested=true;s.mark("PENDING");
          await s.requestGate;
          const response=await delegate(input,init);
          if(s.closing)return response;
          const text=await response.clone().text();
          if(response.status!==200||new TextEncoder().encode(text).length>131072)
            throw Error("ACTUAL_ROLE_SERVER_RESPONSE_REQUIRED");
          const body=JSON.parse(text);
          if(!s.identity(body)||body.role!=="participant")throw Error("ACTUAL_SAME_USER_SERVER_DEMOTION_REQUIRED");
          s.meIdentity=true;s.meStatus=response.status;s.meRole=body.role;s.meResponseHeld=true;
          s.responseSha256=[...new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(text)))]
            .map(value=>value.toString(16).padStart(2,"0")).join("");
          await s.responseGate;s.meDelivered=true;return response;
        }
        if(me){
          if(s.phase==="PENDING"||s.phase==="DEMOTED")s.fail("UNEXPECTED_ADDITIONAL_ROLE_REQUEST");
          const response=await delegate(input,init);
          if(s.phase==="RECOVERY"&&!s.closing){
            const body=await response.clone().json();
            if(response.status!==200||!s.identity(body)||body.role!=="owner")throw Error("ACTUAL_OWNER_ROLE_RECOVERY_REQUIRED");
            s.ownerResponseObserved=true;
          }
          return response;
        }
        let teardown=false;
        if(path==="live-controls"&&method==="POST"&&typeof init?.body==="string"){
          try{teardown=JSON.parse(init.body).operation==="end-delivery";}catch{}
        }
        if(teardown)return delegate(input,init,true);
        const phase=s.phase,at=performance.now();
        s.push(s.requests,{phase,at:at-started,kind:s.kind(path),method});s.active++;
        if(phase==="RECOVERY"&&!s.ownerResponseObserved)s.fail("OWNER_READ_BEFORE_GENUINE_ROLE_RECOVERY");
        try{return await delegate(input,init);}finally{s.active--;}
      };
      s.consume=entries=>{for(const entry of entries){
        if(entry.startTime<started)continue;
        const path=s.path(entry.name);
        if(path===null||path==="me")continue;
        const call=[...s.delegations].reverse().find(value=>value.href===entry.name
          &&value.at<=entry.startTime&&entry.startTime-value.at<100);
        if(call?.teardown)continue;
        s.push(s.resources,{phase:s.phaseAt(entry.startTime),at:entry.startTime-started,kind:s.kind(path)});
      }};
      s.observer=new PerformanceObserver(list=>s.consume(list.getEntries()));
      performance.setResourceTimingBufferSize(2048);s.observer.observe({type:"resource"});
      s.count=(list,phase)=>list.filter(value=>value.phase===phase).length;
      s.snapshot=()=>{s.consume(s.observer.takeRecords());return {
        sameOriginalDocument:performance.timeOrigin===s.timeOrigin,sameUser:s.sameUser&&s.meIdentity===true,
        tokenRotations:s.rotations,pendingRouteConsumed:s.pendingRouteConsumed===true,
        transport:{actualRequestHeld:s.meRequested,actualParticipantResponseHeld:s.meResponseHeld,
          actualOwnerResponseObserved:s.ownerResponseObserved,actualResponseUnchanged:s.meDelivered,
          serverStatus:s.meStatus??null,serverRole:s.meRole??null,participantResponseSha256:s.responseSha256??null},
        pending:{ownerRequestStarts:s.count(s.requests,"PENDING"),ownerResourceStarts:s.count(s.resources,"PENDING")},
        demoted:{ownerRequestStarts:s.count(s.requests,"DEMOTED"),ownerResourceStarts:s.count(s.resources,"DEMOTED"),
          observedMs:s.demotedObservedMs??0},
        positive:{baselineRequests:s.count(s.requests,"BASELINE"),recoveryRequests:s.count(s.requests,"RECOVERY"),
          originalClosedWorkRecovered:s.originalClosedWorkRecovered===true},
        prePendingRequestStarts:s.count(s.requests,"PRE_PENDING"),requestAudit:s.requests,resourceAudit:s.resources
      };};
      s.cleanup=()=>{
        s.closing=true;s.armed=false;s.releaseRequest();s.releaseResponse();clearTimeout(s.timer);
        const owned=window.fetch===s.wrapper;if(owned)window.fetch=original;
        const fetchRestored=window.fetch===original&&(owned||s.watchdogCleanup?.fetchRestored===true);
        const frame=s.frame,iframeOwned=!frame||frame.getAttribute("data-w2-role-driver")===key;
        if(frame&&iframeOwned)frame.remove();
        s.observer.disconnect();
        return {fetchRestored,iframeRemoved:iframeOwned&&!frame?.isConnected,transportReleased:true};
      };
      s.timer=setTimeout(()=>{
        s.fail("ROLE_TRANSPORT_ABSOLUTE_WATCHDOG");s.watchdogCleanup=s.cleanup();
      },${Math.max(1, deadline - performance.now() - 5000)});
      window.fetch=s.wrapper;window[key]=s;
      try{
        s.frame=document.createElement("iframe");s.frame.hidden=true;s.frame.setAttribute("data-w2-role-driver",key);
        document.body.append(s.frame);
        if(s.frame.contentWindow.location.href!=="about:blank")throw Error("OWNED_INITIAL_BLANK_REALM_REQUIRED");
        const script=s.frame.contentDocument.createElement("script");script.textContent=${JSON.stringify(source)};
        s.frame.contentDocument.head.append(script);
        const actual=s.frame.contentWindow.supabase;
        if(typeof actual?.createClient!=="function")throw Error("ACTUAL_SDK_BUNDLE_NOT_EXECUTABLE");
        s.sdk=actual.createClient(${JSON.stringify(role.authOrigin)},${JSON.stringify(role.anonKey)},
          {auth:{persistSession:true,autoRefreshToken:false,detectSessionInUrl:false}});
        s.refresh=()=>{
          if(s.refreshing)throw Error("ONE_REAL_SDK_REFRESH_AT_A_TIME");
          s.refreshing=true;
          s.refreshTask=(async()=>{
            const before=await s.sdk.auth.getSession();
            if(before.error||before.data.session?.user.id!==expectedUser)throw Error("ACTUAL_CURRENT_USER_SESSION_REQUIRED");
            // The controlled auth fixture signs at whole-second resolution.
            await new Promise(resolve=>setTimeout(resolve,1100));
            const after=await s.sdk.auth.refreshSession();
            if(after.error||after.data.session?.user.id!==expectedUser
              ||after.data.session.access_token===before.data.session.access_token)throw Error("REAL_SAME_USER_TOKEN_ROTATION_REQUIRED");
            s.rotations++;
          })().catch(()=>s.fail("ACTUAL_SDK_SAME_USER_REFRESH_FAILED")).finally(()=>{s.refreshing=false;});
        };
      }catch{ s.fail("ACTUAL_SDK_DRIVER_SETUP_FAILED"); }
      return {actualDOM:true,actualDelegatedFetchInstalled:true};`);
    dom("return true;");
    button("Refresh current contracts");
    wait('s.requests.some(value=>value.phase==="BASELINE")&&s.active===0');
    // Real settled-owner routes prove both hooks are active, not just a synthetic fetch.
    command(["pushstate", pendingUrl.href]);
    wait('[...document.querySelectorAll("h1")].some(x=>x.textContent.trim()==="W2 separate empty Work scope")&&s.active===0');
    command(["pushstate", fixture.url]);
    wait(`Boolean(document.querySelector(${JSON.stringify(panel)})?.textContent.includes("W2_PRIVATE_MOUNTED_TASK"))&&s.active===0`);
    dom(`if(!s.requests.some(x=>x.phase==="BASELINE"&&x.kind==="INVESTIGATION")
        ||!s.requests.some(x=>x.phase==="BASELINE"&&x.kind==="CANVAS"))throw Error("ACTUAL_OWNER_HOOK_BASELINE_MISSING");
      s.mark("PRE_PENDING");s.armed=true;s.refresh();return {actualSDKRefreshStarted:true};`);
    wait("s.meRequested&&s.rotations===1&&s.active===0");
    dom('if(!document.querySelector(".ct-app")||performance.timeOrigin!==s.timeOrigin)throw Error("ACTUAL_MOUNTED_PENDING_OWNER_REQUIRED");return true;');
    const changed = await nativeControl("role-demote");
    assert.equal(changed.canonicalRole, "participant"); assert.equal(changed.status, "active");
    assert.equal(changed.samePrincipalAndTenant, true);
    dom('s.releaseRequest();return {actualRequestReleasedToServer:true};');
    wait("s.meResponseHeld");
    command(["pushstate", pendingUrl.href]);
    wait(`location.href===${JSON.stringify(pendingUrl.href)}&&Boolean(document.querySelector(".ct-app"))`);
    dom('s.pendingFrames=false;requestAnimationFrame(()=>requestAnimationFrame(()=>{s.pendingFrames=true;}));return true;');
    wait("s.pendingFrames&&s.active===0");
    const pending = dom(`const actual=s.snapshot();
      if(!s.meResponseHeld||s.meDelivered||!document.querySelector(".ct-app")
        ||document.body.textContent.includes("W2_PRIVATE_MOUNTED_TASK")
        ||actual.pending.ownerRequestStarts||actual.pending.ownerResourceStarts)throw Error("ROLE_PENDING_OWNER_READ_OR_PRIVATE_DATA");
      return actual;`);
    assert(pending.sameOriginalDocument && pending.sameUser); screenshot("role-pending");
    dom('s.mark("DEMOTED");s.demotedAt=performance.now();s.releaseResponse();return {actualResponseReleasedUnchanged:true};');
    wait('[...document.querySelectorAll("h1")].some(x=>x.textContent.trim()==="Participant workspace")&&!document.querySelector(".ct-app")');
    dom('s.demotedFrames=false;requestAnimationFrame(()=>requestAnimationFrame(()=>{s.demotedFrames=true;}));return true;');
    wait("s.demotedFrames&&performance.now()-s.demotedAt>=6000");
    const denied = dom(`s.demotedObservedMs=performance.now()-s.demotedAt;const actual=s.snapshot();
      if(document.querySelector(".ct-app")||document.body.textContent.includes("W2_PRIVATE_MOUNTED_TASK")
        ||actual.demoted.ownerRequestStarts||actual.demoted.ownerResourceStarts)throw Error("ROLE_DEMOTED_OWNER_READ_OR_PRIVATE_DATA");
      return actual;`);
    assert(denied.sameOriginalDocument && denied.demoted.observedMs >= 6000); screenshot("role-demoted");
    requireRoleRestoration(await nativeControl("role-restore"));
    dom('s.mark("RECOVERY");s.refresh();return {actualOwnerRecoveryRefreshStarted:true};');
    wait('s.rotations===2&&s.ownerResponseObserved&&[...document.querySelectorAll("h1")].some(x=>x.textContent.trim()==="W2 separate empty Work scope")&&s.active===0');
    dom('s.pendingRouteConsumed=true;return true;');
    command(["pushstate", fixture.url]);
    wait(`Boolean(document.querySelector(${JSON.stringify(panel)})?.textContent.includes("W2_PRIVATE_MOUNTED_TASK")
      &&document.querySelector(${JSON.stringify(panel)})?.textContent.includes("closed"))&&s.active===0`);
    observed = dom('s.originalClosedWorkRecovered=true;return s.snapshot();');
    assert(observed.sameOriginalDocument && observed.sameUser && observed.positive.recoveryRequests > 0);
    screenshot("role-restored");
  } catch (error) {
    failure = error;
  } finally {
    let dbRoleRestored = false, dbMutationTerminal = false, dbOwnerReadbackObserved = false;
    if (sdkIdentity) {
      try {
        const receipt = requireRoleRestoration(await control("role-restore",
          Math.max(1, Math.min(5000, deadline - performance.now())), roleDeadlineNs));
        dbRoleRestored = receipt.restored; dbMutationTerminal = receipt.mutationTerminal;
        dbOwnerReadbackObserved = receipt.ownerReadbackObserved;
      } catch { dbRoleRestored = false; failure ??= Error("CONTROLLED_ROLE_CLEANUP_FAILED"); }
    }
    let cleanup = { fetchRestored: false, iframeRemoved: false, transportReleased: false,
      dbRoleRestored, dbMutationTerminal, dbOwnerReadbackObserved };
    if (installed) {
      try {
        const result = client.dom(`const s=window[${encodedKey}];
          if(!s||performance.timeOrigin!==s.timeOrigin)throw Error("ROLE_CLEANUP_ORIGINAL_DOCUMENT_LOST");
          const actual=s.snapshot(),cleanup=s.cleanup();delete window[${encodedKey}];
          return {actual,cleanup,failure:s.failure};`);
        observed = result.actual; cleanup = { ...cleanup, ...result.cleanup };
        if (result.failure) failure ??= Error(result.failure);
      } catch { failure ??= Error("ROLE_BROWSER_MEASUREMENT_CLEANUP_FAILED"); }
    }
    report.roleRevalidation = { schema, status: failure ? "FAIL" : "PASS", sdk: sdkIdentity,
      ...observed, elapsedMs: performance.now() - started, cleanup };
    if (!failure && (!cleanup.fetchRestored || !cleanup.iframeRemoved || !cleanup.transportReleased || !cleanup.dbRoleRestored))
      failure = Error("ROLE_CASE_CLEANUP_REQUIRED");
    if (!failure && (observed.pending.ownerRequestStarts || observed.pending.ownerResourceStarts
      || observed.demoted.ownerRequestStarts || observed.demoted.ownerResourceStarts))
      failure = Error("ROLE_OWNER_READ_DURING_UNSETTLED_AUTHORITY");
    if (!failure && performance.now() >= deadline) failure = Error("MOUNTED_ROLE_CASE_45_SECOND_ABSOLUTE_BOUND");
    if (failure) report.roleRevalidation.status = "FAIL";
    await save();
    if (performance.now() >= deadline) {
      failure ??= Error("MOUNTED_ROLE_CASE_45_SECOND_ABSOLUTE_BOUND");
      report.roleRevalidation.status = "FAIL";
    }
  }
  if (failure) throw failure;
  await record("same-user-role-revalidation-zero-owner-read-barrier", report.roleRevalidation);
  if (performance.now() >= deadline) {
    report.roleRevalidation.status = "FAIL";
    throw Error("MOUNTED_ROLE_CASE_45_SECOND_ABSOLUTE_BOUND");
  }
};
let offline = false;
try {
  const proof = await client.validateProof(process.env.FINNOR_W2_BROWSER_PROVENANCE,
    process.env.FINNOR_W2_BROWSER_PROVENANCE_SHA256);
  // Fresh native/target facts for this campaign, never a pre-nonce proof.
  report.browserProvenanceValidatedAt = new Date().toISOString();
  report.browserPreStartProofSha256 = process.env.FINNOR_W2_BROWSER_PROVENANCE_SHA256;
  report.browser = proof.browser; report.browserProvenance = proof;
  await save();
  assert.equal(proof.status, "PASS", "ACTUAL_BROWSER_PROVENANCE_UNKNOWN_OR_NOT_ELIGIBLE");
  await login("participant");
  client.run(["open", fixture.participant.url]);
  const participantPanel = `[data-workforce-work="${fixture.participant.workId}"]`;
  client.wait(`Boolean(document.querySelector(${JSON.stringify(participantPanel)})?.textContent.includes("your contracts only"))`);
  const participant = client.dom(`const section=document.querySelector(${JSON.stringify(participantPanel)});
    const heading=[...document.querySelectorAll("h1")].some(x=>x.textContent.trim()==="Your workforce contracts");
    if(!heading || !section || !section.textContent.includes("your contracts only")
      || section.querySelectorAll("tbody tr").length!==${fixture.participant.expectedOwnAssignments}
      || [...document.querySelectorAll("button")].some(x=>x.textContent.trim()==="Compile original workforce outcome")
      || document.querySelector('[aria-label="Account menu"]'))throw Error("EXACT_NONOWNER_OWN_CONTRACTS_BOUNDARY_FAILED");
    return {actualDOM:true,ownAssignmentCount:section.querySelectorAll("tbody tr").length,ownerShellAbsent:true};`);
  screenshot("nonowner-own-contracts");
  await record("nonowner-participant-workspace-exact-own-contracts", participant);
  const purpose = JSON.stringify(fixture.participant.expiryPurpose);
  client.wait(`[...document.querySelectorAll("h3")].some(x=>x.textContent.trim()==="expired: "+${purpose})`
    + ` && [...document.querySelectorAll("h3")].some(x=>x.textContent.trim()==="proposed: "+${purpose})`);
  const enrollment = client.dom(`const section=document.querySelector('section[aria-label="Your external identity enrollments"]');
    if(!section)throw Error("ENROLLMENT_SECTION_MISSING");
    const articles=[...section.querySelectorAll("article")], find=prefix=>articles.find(x=>x.querySelector("h3")?.textContent.trim()===prefix+${purpose});
    const expired=find("expired: "),fresh=find("proposed: ");
    if(!expired || expired.querySelectorAll("button").length || !fresh)throw Error("ACTUAL_EXPIRED_AND_FRESH_BINDINGS_REQUIRED");
    const buttons=[...fresh.querySelectorAll("button")], target=buttons.find(x=>x.textContent.trim()==="Confirm my existing identity binding");
    if(!target)throw Error("FRESH_EXACT_IDENTITY_CONFIRMATION_BUTTON_REQUIRED");
    return {actualDOM:true,expiredTerminalActions:expired.querySelectorAll("button").length,
      selector:'section[aria-label="Your external identity enrollments"] article:nth-of-type('+(articles.indexOf(fresh)+1)+') button:nth-of-type('+(buttons.indexOf(target)+1)+')'};`);
  client.run(["click", enrollment.selector]);
  client.wait(`[...document.querySelectorAll("h3")].some(x=>x.textContent.trim()==="confirmed: "+${purpose})`);
  const expiry = await control("participant-expiry");
  screenshot("participant-natural-expiry-and-fresh-consent");
  await record("participant-natural-expiry-and-fresh-exact-mounted-consent",
    { actualDOM: true, expiredTerminalActions: enrollment.expiredTerminalActions, canonicalReadback: expiry });
  signOut();
  await login("owner");
  client.run(["open", fixture.url]);
  client.wait(`Boolean(document.querySelector(${JSON.stringify(panel)}))`);
  button("Compile original workforce outcome");
  client.wait(`Boolean(document.querySelector(${JSON.stringify(panel)})?.textContent.includes("W2_PRIVATE_MOUNTED_TASK")`
    + ` && document.querySelector(${JSON.stringify(panel)})?.textContent.includes("closed"))`);
  const positive = client.dom(`const section=document.querySelector(${JSON.stringify(panel)});
    if(!section || !section.textContent.includes("W2_PRIVATE_MOUNTED_TASK") || !section.textContent.includes("closed"))
      throw Error("ACTUAL_ORIGINAL_CLOSED_WORK_REQUIRED");
    return {actualDOM:true,originalWorkId:section.getAttribute("data-workforce-work"),closed:true};`);
  const completion = await control("completion");
  screenshot("original-positive");
  await record("mounted-original-compile-and-verified-completion", { ...positive, nativeCompletion: completion }, true);
  await roleRevalidationBarrier();
  client.run(["open", fixture.otherUrl]);
  client.wait('[...document.querySelectorAll("h1")].some(x=>x.textContent.trim()==="W2 separate empty Work scope")');
  await absent("work-switch-withdrawal");
  signOut(); await login("alternate");
  client.run(["open", fixture.alternate.url]); bodyReady();
  await absent("same-tenant-principal-withdrawal");
  signOut(); await login("foreign");
  client.run(["open", fixture.foreign.url]);
  client.wait('[...document.querySelectorAll("h1")].some(x=>x.textContent.trim()==="W2 foreign tenant private context")');
  await absent("foreign-tenant-withdrawal");
  signOut(); await login("owner");
  client.run(["open", fixture.url]);
  client.wait(`Boolean(document.querySelector(${JSON.stringify(panel)})?.textContent.includes("W2_PRIVATE_MOUNTED_TASK"))`);
  client.run(["set", "offline", "on"]); offline = true;
  client.wait("navigator.onLine === false");
  await absent("offline-private-withdrawal");
  client.run(["set", "offline", "off"]); offline = false;
  client.run(["open", fixture.url]);
  client.wait(`Boolean(document.querySelector(${JSON.stringify(panel)})?.textContent.includes("W2_PRIVATE_MOUNTED_TASK"))`);
  const requestPath = "/api/centropy/workforce/execution-programs/" + completion.programId;
  const traceKey = "__finnor_w2_native_resource_" + digest(fixture.workId).slice(0, 16);
  client.dom(`const key=${JSON.stringify(traceKey)}, path=${JSON.stringify(requestPath)};
    const trace={timeOrigin:performance.timeOrigin,startAt:performance.now(),settled:[]};
    performance.setResourceTimingBufferSize(2048);
    trace.observer=new PerformanceObserver(list=>{for(const entry of list.getEntries())
      if(new URL(entry.name,location.href).pathname===path && entry.startTime>=trace.startAt)
        trace.settled.push({startAt:entry.startTime,responseEnd:entry.responseEnd,duration:entry.duration});});
    trace.observer.observe({type:"resource"});window[key]=trace;
    return {actualDOM:true,originalDocumentTraceInstalled:true};`);
  await control("delay-next");
  button("Refresh current contracts");
  await waitControl(value => value.delay.entered === true);
  client.run(["set", "offline", "on"]); offline = true;
  const revoked = await control("revoke-owner");
  await control("release");
  client.run(["set", "offline", "off"]); offline = false;
  const gate = await waitControl(value => value.delay.drained === true);
  client.wait(`Boolean(window[${JSON.stringify(traceKey)}]?.settled.length)`);
  const drain = client.dom(`const trace=window[${JSON.stringify(traceKey)}];
    if(!trace || performance.timeOrigin!==trace.timeOrigin || !trace.settled.length)
      throw Error("ORIGINAL_DELAYED_REQUEST_NOT_SETTLED_IN_ORIGINAL_DOCUMENT");
    trace.observer.disconnect();return {actualDOM:true,originalClientRequestSettled:true,
      sameOriginalDocument:true,observedResourceCompletions:trace.settled.length};`);
  await absent("delayed-revoked-response-withdrawal");
  await record("original-delayed-response-drained-before-any-reload",
    { ...drain, nativeGateDrained: gate.delay.drained, revoked, noReloadUsedForSixthPredicate: true });
  // Independent navigation is supplementary evidence, never the sixth oracle.
  client.run(["open", fixture.url]);
  client.wait('[...document.querySelectorAll("h1")].some(x=>/Workspace unavailable|Your investment context stays private/.test(x.textContent))');
  client.dom('if([...document.querySelectorAll("[data-workforce-work]")].some(x=>x.textContent.includes("W2_PRIVATE_MOUNTED_TASK")))'
    + 'throw Error("REVOKED_CURRENT_AUTH_VISIBLE");return {actualDOM:true,privateContractVisible:false};');
  screenshot("revoked-current-auth-after-independent-reload");
  assert.deepEqual(report.assertions, ["mounted-original-compile-and-verified-completion", "work-switch-withdrawal",
    "same-tenant-principal-withdrawal", "foreign-tenant-withdrawal", "offline-private-withdrawal",
    "delayed-revoked-response-withdrawal"]);
  report.status = "PASS"; await save(); await control("finish");
} catch (error) {
  report.status = "FAIL";
  report.failure = { type: error?.name ?? "Error", lastCompletedStep: report.steps.at(-1)?.name ?? null,
    code: /^[A-Z0-9_:.-]{1,160}$/.test(error?.message ?? "") ? error.message : "ACTUAL_SUPPORTED_MOUNTED_WORKFLOW_FAILED" };
  await save();
  await control("abort").catch(() => {});
  process.exitCode = 1;
} finally {
  if (offline) {
    try { client.run(["set", "offline", "off"]); }
    catch { report.status = "FAIL"; report.cleanupFailure = "ASSIGNED_TAB_OFFLINE_FAULT_NOT_CLEARED"; process.exitCode = 1; }
  }
  report.browserClosed = false; report.userOwnedBrowserPreserved = true;
  await save();
}
