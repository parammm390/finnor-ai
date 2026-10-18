/** Execute normal lockfile installations and complete installed parity in a
 * fresh archive extraction. Registry access is allowed; donor modules are not. */
import {strict as assert} from 'node:assert'
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs'
import {basename,dirname,isAbsolute,join} from 'node:path'
const [archive,workspace,evidence]=process.argv.slice(2)
assert([archive,workspace,evidence].every(path=>path&&isAbsolute(path)),'Supply absolute archive, fresh workspace and evidence paths')
assert(!existsSync(workspace)&&!existsSync(evidence),'Refusing to overwrite a reconstruction attempt')
mkdirSync(workspace);mkdirSync(evidence,{recursive:true})
const manifest=JSON.parse(readFileSync(archive+'.json','utf8')),hash=bytes=>createHash('sha256').update(bytes).digest('hex')
assert.equal(hash(readFileSync(archive)),manifest.sha256,'Archive identity')
const environment={PATH:dirname(process.execPath)+':'+process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,CI:'1',
 NODE_OPTIONS:'--max-old-space-size=4096',NEXT_TELEMETRY_DISABLED:'1',FINNOR_X3_BUILT_API:'1',
 npm_config_cache:join(dirname(workspace),basename(workspace)+'-npm-cache')}
assert(!existsSync(environment.npm_config_cache),'Refusing an existing reconstruction dependency cache')
const phases=[],started=performance.now()
const run=(command,args,cwd=workspace,timeout=120000)=>{
 const result=spawnSync(command,args,{cwd,env:environment,encoding:'utf8',timeout,maxBuffer:16*1024*1024})
 assert.equal(result.status,0,JSON.stringify({command,args,status:result.status,signal:result.signal,error:result.error?.message,output:result.stdout+result.stderr}))
 return result.stdout.trim()
}
const git=(...args)=>run('git',['-C',workspace,...args])
const identity=()=>{
 assert.equal(git('rev-parse','HEAD'),manifest.head);assert.equal(git('rev-parse','HEAD^{tree}'),manifest.tree)
 assert.equal(git('status','--porcelain'),'')
 assert(!existsSync(join(workspace,'.git/objects/info/alternates')))
 for(const lock of manifest.locks)assert.equal(hash(readFileSync(join(workspace,lock.path))),lock.sha256,lock.path)
 assert.equal(hash(readFileSync(join(workspace,'finnor-os/packages/private-equity/src/enterprise-applications/source-manifest.generated.ts'))),manifest.sourceManifestSha256)
}
try{
 const paths=run('tar',['-tzf',archive])
 assert(paths.split('\n').every(path=>path&&!path.startsWith('/')&&!path.split('/').includes('..')),'Archive path escape')
 run('tar',['-xzf',archive,'-C',workspace]);identity()
 assert(!existsSync(join(workspace,'node_modules'))&&!existsSync(join(workspace,'finnor-os/node_modules')))
 assert.equal(Number(process.versions.node.split('.')[0]),22,'Declared Node 22 runtime')
 function phase(name,cwd,command,args,extra={}){
  Object.assign(environment,extra)
  const receipt=join(evidence,name+'.json'),result=spawnSync(process.execPath,[join(workspace,'scope-x3/run-metered.mjs'),receipt,cwd,'--',command,...args],
   {cwd,env:environment,encoding:'utf8',timeout:930000,maxBuffer:1024*1024})
  const meter=existsSync(receipt)?JSON.parse(readFileSync(receipt,'utf8')):null
  phases.push({name,status:result.status,signal:result.signal,receipt,meterStatus:meter?.status,output:result.stdout+result.stderr})
  writeFileSync(join(evidence,'progress.json'),JSON.stringify({manifest,workspace,phases},null,2)+'\n')
  assert.equal(result.status,0,JSON.stringify(phases.at(-1)));assert.equal(meter.status,'PASS_COMMAND');identity()
 }
 phase('root-npm-ci',workspace,'npm',['ci','--no-audit','--no-fund'])
 phase('os-npm-ci',join(workspace,'finnor-os'),'npm',['ci','--no-audit','--no-fund'])
 phase('api-build',join(workspace,'finnor-os'),'npm',['run','build','--workspace','@finnor/api'])
 phase('complete-installed',join(workspace,'finnor-os'),process.execPath,['--import=tsx','scripts/x3/run-installed.mts'],{FINNOR_X3_EVIDENCE_DIR:join(evidence,'installed')})
 run(process.execPath,[join(workspace,'scope-x3/verify-handoff.mjs'),join(evidence,'source-audit.json'),join(evidence,'installed')])
 const installed=JSON.parse(readFileSync(join(evidence,'installed/installed-summary.json'),'utf8'))
 assert.equal(installed.status,'INSTALLED_DEVELOPMENT_CHECKS_PASS');assert.equal(installed.verificationProfile,'COMPLETE')
 const result={schema:'finnor.x3.standalone-reconstruction.v1',status:'PASS_COMPLETE_INSTALLED_RECONSTRUCTION',manifest,workspace,phases,
  node:process.execPath,nodeVersion:process.version,platform:process.platform,architecture:process.arch,wallMs:performance.now()-started,
  parity:'EXACT_SOURCE_TREE_LOCKS_STAMP_AND_COMPLETE_INDEPENDENT_INSTALLED_BUSINESS_CAMPAIGN; FRESH_DISPOSABLE_TENANT_RECORD_RELEASE_AND_SESSION_IDENTITIES',
  donorNodeModules:false,gitAlternates:false,oldBusinessGrantsRenewed:false,
  limitations:['NOT_A_RESTORE_OF_AN_EXPIRED_PRIOR_APPLICATION_INSTANCE','NOT_A_CONTAINER_ARM64_HOSTED_OR_PRODUCTION_PROOF','PROVIDER_HUMAN_AND_FULL_FINANCIAL_COSTS_UNMETERED']}
 writeFileSync(join(evidence,'result.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify({status:result.status,head:manifest.head,tree:manifest.tree,workspace,evidence}))
}catch(error){
 writeFileSync(join(evidence,'failure.json'),JSON.stringify({status:'FAIL_RECONSTRUCTION',error:String(error),stack:error.stack,manifest,workspace,phases,wallMs:performance.now()-started},null,2)+'\n',{flag:'wx',mode:0o600})
 throw error
}
