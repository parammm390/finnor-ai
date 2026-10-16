import test from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { spawnSync } from "node:child_process"
import { runAuthenticatedVercel } from "./vercel-auth.mjs"

test("private CLI authentication reaches a separate child and is removed on every return", t => {
  const root = mkdtempSync(join(tmpdir(), "finnor-vercel-auth-e2e-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const bin = join(root, "bin")
  const cwd = join(root, "build")
  mkdirSync(bin); mkdirSync(cwd)
  const token = "fixtureOnlyNotACredential123"
  const cli = join(bin, "vercel")
  writeFileSync(cli, `#!${process.execPath}
import { readFileSync, statSync } from 'node:fs';
const args=process.argv.slice(2);
const path=args[args.indexOf('--global-config')+1];
const auth=JSON.parse(readFileSync(path+'/auth.json','utf8'));
if(auth.token!==${JSON.stringify(token)} || (statSync(path).mode&0o777)!==0o700 || (statSync(path+'/auth.json').mode&0o777)!==0o600) process.exit(91);
if(args.some(a=>a.includes(auth.token)) || ['VERCEL_TOKEN','GH_TOKEN','AWS_SECRET_ACCESS_KEY','ACTIONS_ID_TOKEN_REQUEST_TOKEN','FINNOR_PROTECTED_DATABASE_ENV'].some(k=>process.env[k])) process.exit(92);
console.log(JSON.stringify({path,args,cwd:process.cwd(),org:process.env.VERCEL_ORG_ID,project:process.env.VERCEL_PROJECT_ID}));
console.error(auth.token);
process.exit(args.includes('fixture-failure')?7:0);
`, { mode: 0o755 })
  const env = { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: root, VERCEL_TOKEN: token, VERCEL_ORG_ID: "team_fixture", VERCEL_PROJECT_ID: "prj_fixture", GH_TOKEN: "fixture-private", AWS_SECRET_ACCESS_KEY: "fixture-private", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fixture-private", FINNOR_PROTECTED_DATABASE_ENV: "fixture-private" }
  const observations = []
  for (const args of [["whoami"], ["pull", "--yes", "--environment=production"], ["deploy", "--prebuilt", "--prod", "--yes"], ["fixture-failure"]]) {
    const result = runAuthenticatedVercel(args, { cwd, env })
    assert.equal(result.status, args[0] === "fixture-failure" ? 7 : 0)
    assert.doesNotMatch(result.stderr, new RegExp(token))
    const child = JSON.parse(result.stdout.trim())
    assert.equal(child.org, env.VERCEL_ORG_ID)
    assert.equal(child.project, env.VERCEL_PROJECT_ID)
    assert.equal(child.cwd, realpathSync(cwd))
    assert.ok(!child.path.startsWith(`${cwd}/`))
    assert.equal(existsSync(child.path), false)
    observations.push({ args, status: result.status, privateConfigRemoved: true, tokenRedacted: true })
  }
  assert.throws(() => runAuthenticatedVercel(["whoami"], { cwd, env: { ...env, VERCEL_TOKEN: " " } }), /VERCEL_TOKEN/)
  const missing = runAuthenticatedVercel(["whoami"], { cwd, env: { ...env, PATH: join(root, "missing") } })
  assert.equal(missing.error?.code, "ENOENT")
  const configArg = missing.error.spawnargs.indexOf("--global-config")
  assert.equal(existsSync(missing.error.spawnargs[configArg + 1]), false)
  for (const arg of ["--token", "--token=fixture", "-t", "-tfixture", "--global-config", "--global-config=/tmp/fixture", "-Q", "--"]) {
    assert.throws(() => runAuthenticatedVercel(["whoami", arg], { cwd, env }), /Caller-supplied/)
  }
  const directDeploy = spawnSync(process.execPath, [new URL("./vercel-auth.mjs", import.meta.url).pathname, "deploy", "--prod"], { cwd, env, encoding: "utf8" })
  assert.notEqual(directDeploy.status, 0)
  assert.match(directDeploy.stderr, /read-only/)
  const evidence = join(tmpdir(), "finnor-vercel-auth-e2e-receipt.json")
  writeFileSync(evidence, JSON.stringify({ schema: "finnor.vercel-auth-child-e2e.v1", qualification: "MOCK_PROVIDER_NOT_DEPLOYMENT_PROOF", node: process.version, cases: observations, missingTokenRefused: true, missingExecutable: "ENOENT", standaloneDeployRefused: true, rerun: "node --test scripts/release/vercel-auth.e2e.test.mjs" }, null, 2))
  assert.equal(JSON.parse(readFileSync(evidence, "utf8")).cases.length, 4)
})
