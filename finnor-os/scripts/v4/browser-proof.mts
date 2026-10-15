/** Mounted installed UI only. Own loopback data and login, never a saved live
 * account. No intercepted/mocked financing answer or self-issued funding fact. */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { capitalDigest } from "../../packages/private-equity/src/capital-formation/contracts";

export async function runMountedCapitalProof(options: {
  origin: string; positive: any; threadId: string; otherThreadId: string; output: string;
  artifact(name: string, value: unknown): Promise<string>;
  startHolding(): void; held(): number; release(): void; revoke(): Promise<void>;
}) {
  const desktop = Boolean(process.env.FACTORY_DESKTOP_CDP_PORT && process.env.AGENT_BROWSER_CDP);
  const session = process.env.AGENT_BROWSER_SESSION ?? "v4-mounted-" + options.positive.workId;
  const env = { ...process.env, AGENT_BROWSER_SESSION: session };
  const prefix = desktop ? ["--cdp", process.env.AGENT_BROWSER_CDP!, "--pin-tab"] : [];
  const steps: any[] = [];
  const begun = Date.now(), deadline = begun + 180000;
  async function browser(args: string[], input?: string, commandDeadline = deadline) {
    assert(Date.now() < commandDeadline, "Original mounted proof observation deadline");
    return new Promise<string>((yes, no) => {
      const cp = spawn("agent-browser", [...prefix, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
      const stdout: Buffer[] = [], stderr: Buffer[] = [];
      const timer = setTimeout(() => { cp.kill("SIGTERM"); no(Error("Mounted browser command deadline")); }, Math.min(30000, commandDeadline - Date.now()));
      cp.stdout.on("data", b => stdout.push(Buffer.from(b))); cp.stderr.on("data", b => stderr.push(Buffer.from(b)));
      cp.stdin.end(input);
      cp.once("error", error => { clearTimeout(timer); no(error); });
      cp.once("exit", code => {
        clearTimeout(timer); const out = Buffer.concat(stdout).toString(), err = Buffer.concat(stderr).toString();
        steps.push({ command: args[0], status: code, outputDigest: capitalDigest(out), at: new Date().toISOString() });
        code === 0 ? yes(out) : no(Error(`Browser ${args[0]} failed: ${err || out}`));
      });
    });
  }
  const evaluate = (script: string) => browser(["eval", "--stdin"], script);
  const snapshot = async (name: string) => options.artifact("mounted/" + name + ".json", { snapshot: await browser(["snapshot"]), steps });
  const uri = (thread: string, root = options.positive.uiRoot ?? options.positive.root) => options.origin + `/centropy/investigations/${thread}?` + new URLSearchParams({
    root: JSON.stringify(root), capitalFormation: options.positive.mandate.programmeId,
  });
  const packageSelector = 'section[aria-label="Autonomous capital formation"] div[aria-label="Current reconciled financing package"]';
  const waitCurrent = () => browser(["wait", "--fn", `!!document.querySelector(${JSON.stringify(packageSelector)})`]);
  const waitAbsent = () => browser(["wait", "--fn", `!document.querySelector(${JSON.stringify(packageSelector)})`]);
  const openCanvas = async () => { await browser(["wait", "--fn", 'Array.from(document.querySelectorAll("button")).some(b=>b.textContent.trim()==="Canvas")']);
    await evaluate('Array.from(document.querySelectorAll("button")).find(b=>b.textContent.trim()==="Canvas").click()'); };
  try {
    // Factory's endpoint already targets its one embedded pane and deliberately
    // disallows Target.createTarget. Navigate that assigned pane, not a new tab.
    await browser(["open", options.origin + "/centropy/login"]);
    await browser(["wait", "--fn", '!!document.querySelector("#centropy-login-email") && !document.querySelector("button[type=submit]")?.disabled']);
    await evaluate(`(() => {
      const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set;
      for(const [id,value] of [["centropy-login-email",${JSON.stringify(options.positive.email ?? `${options.positive.name}@s5.example.test`)}],
        ["centropy-login-password","v4-disposable-local-login"]]) {
        const input=document.getElementById(id); set.call(input,value); input.dispatchEvent(new Event("input",{bubbles:true}));
      }
      const f=document.querySelector("form"); if (!f?.checkValidity()) throw Error("Native login controls were not populated");
      return {formValid:true, emailLength:document.querySelector("#centropy-login-email").value.length,
        passwordLength:document.querySelector("#centropy-login-password").value.length}; })()`);
    await evaluate('document.querySelector("form").requestSubmit()');
    await browser(["wait", "--url", "**/centropy"]);
    await browser(["open", uri(options.threadId)]); await openCanvas(); await waitCurrent();
    const original = await evaluate(`(() => {
      const section=document.querySelector('section[aria-label="Autonomous capital formation"]');
      return {text:section.innerText, exactRows:Array.from(section.querySelectorAll("dl dt")).map(dt=>[dt.innerText,dt.nextElementSibling?.innerText]),
        rawDisclosurePresent:document.body.innerText.includes("V4_PRIVATE_SYNTHETIC_CANARY_")};
    })()`);
    assert(original.includes("80,000,000")); assert(original.includes("40,000,000")); assert(original.includes("120,000,000"));
    assert(original.includes("incomplete")); assert(original.includes("0.00 USD")); assert(!original.includes('"rawDisclosurePresent": true'));
    await options.artifact("mounted/original-exact-package.json", { original, originalWorkId: options.positive.workId, nativeThreadId: options.threadId });
    await snapshot("original-exact-package-mounted");
    if (!desktop) await browser(["screenshot", join(options.output, "mounted/original-package.png")]);
    else await options.artifact("mounted/capture-limitation.json", {
      screenshot: "UNAVAILABLE_AFTER_RETAINED_EMBEDDED_PANE_CAPTURE_TIMEOUT",
      retainedFailure: "run-2026-10-12T15-04-53.897Z-9228e5b2",
      substitute: "Actual mounted accessibility tree and exact DOM rows, not a synthetic screenshot or a visual-layout qualification",
    });
    options.startHolding();
    await browser(["find", "role", "button", "click", "--name", "Recheck current financing", "--exact"]);
    const heldDeadline = Math.min(deadline, Date.now() + 15000);
    while (options.held() === 0 && Date.now() < heldDeadline) await new Promise(r => setTimeout(r, 100));
    assert(options.held() > 0, "Actual native API response must be held before switching Work");
    await browser(["pushstate", uri(options.otherThreadId)]);
    await waitAbsent(); await snapshot("scope-switched-before-original-reply");
    options.release();
    await browser(["wait", "--fn", `!document.querySelector(${JSON.stringify(packageSelector)}) && document.body.innerText.includes("Separate owned Work scope")`]);
    await snapshot("late-original-reply-not-restored");
    await browser(["open", uri(options.threadId, options.positive.wrongUiRoot)]); await openCanvas();
    await browser(["wait", "--text", "Current financing could not be verified in your access scope. Values cleared."]);
    await waitAbsent(); await snapshot("same-work-wrong-root-not-displayed");
    await browser(["open", uri(options.threadId)]); await openCanvas(); await waitCurrent();
    await options.revoke();
    await waitAbsent(); await snapshot("current-disclosure-authority-loss");
    const refused = await evaluate(`(() => { const s=document.querySelector('section[aria-label="Autonomous capital formation"]');
      return {text:s?.innerText, hasPackage:!!document.querySelector(${JSON.stringify(packageSelector)}),
        rawDisclosurePresent:document.body.innerText.includes("V4_PRIVATE_SYNTHETIC_CANARY_")}; })()`);
    assert(refused.includes('"hasPackage": false')); assert(!refused.includes('"rawDisclosurePresent": true'));
    await evaluate('document.querySelector(\'summary[aria-label="Account menu"]\').click()');
    await browser(["wait", "--fn", '!!document.querySelector("details.ct-account[open]")']);
    await browser(["find", "role", "button", "click", "--name", "Sign out", "--exact"]);
    await waitAbsent(); await snapshot("signed-out-cleared");
    await options.artifact("mounted/steps.json", { steps, desktopOwnedPane: desktop, ownLoopbackLoginOnly: true,
      originalDeadlineUnchanged: true, nativeRepliesDelayedNotSubstituted: true, qualifications: "SELECTED_MOUNTED_ENGINEERING_ONLY" });
    return { nativeCanvas: true, originalWorkId: options.positive.workId, exactConditionalAndIndicativeAmounts: true,
      sameOriginalPackage: true, WorkSwitchAndDelayedReplyCleared: true, sameWorkWrongRootCleared: true,
      disclosureRevisionCleared: true, signOutCleared: true };
  } catch (error) {
    await snapshot("failure-visible-canvas").catch(() => undefined);
    await options.artifact("mounted/failure-visible-errors.json", { errors: await browser(["errors"]).catch(() => "Unavailable") });
    throw error;
  } finally {
    options.release();
    await options.artifact("mounted/steps.json", { steps, observationDeadlineMs: 180000, originalProgrammeDeadlineUnchanged: true });
    if (!desktop) await browser(["close"], undefined, Date.now() + 10000).catch(() => undefined);
  }
}
