/** Build a self-contained, exact Git artifact. No push, donor dependencies,
 * worktree .git pointer, alternates, hardlinked objects or copied node_modules. */
import {strict as assert} from 'node:assert'
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {existsSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs'
import {dirname,isAbsolute,join,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),archive=process.argv[2]
assert(archive&&isAbsolute(archive),'Supply a fresh absolute .tar.gz path')
assert(!existsSync(archive)&&!existsSync(archive+'.json'),'Refusing to overwrite a delivery')
mkdirSync(dirname(archive),{recursive:true})
const run=(command,args,cwd=root)=>{
 const result=spawnSync(command,args,{cwd,encoding:'utf8',timeout:120000,maxBuffer:16*1024*1024})
 assert.equal(result.status,0,JSON.stringify({command,args,status:result.status,signal:result.signal,error:result.error?.message,output:result.stdout+result.stderr}))
 return result.stdout.trim()
}
const git=(...args)=>run('git',['-C',root,...args])
assert.equal(git('status','--porcelain'),'','Commit the task-owned source before packaging')
const started=performance.now(),head=git('rev-parse','HEAD'),tree=git('rev-parse','HEAD^{tree}'),branch=git('branch','--show-current')
assert.equal(branch,'codex/frontier5-x3-enterprise-application-synthesizer')
const staging=mkdtempSync(join(dirname(archive),'x3-source-')),snapshot=join(staging,'source')
run('git',['clone','--no-local','--single-branch','--no-tags','--branch',branch,root,snapshot])
run('git',['-C',snapshot,'remote','set-url','origin','https://github.com/parammm390/finnor-ai.git'])
assert.equal(run('git',['-C',snapshot,'rev-parse','HEAD']),head)
assert.equal(run('git',['-C',snapshot,'rev-parse','HEAD^{tree}']),tree)
assert.equal(run('git',['-C',snapshot,'status','--porcelain']),'')
assert(!existsSync(join(snapshot,'.git/objects/info/alternates'))&&!existsSync(join(snapshot,'node_modules'))&&!existsSync(join(snapshot,'finnor-os/node_modules')))
run('git',['-C',snapshot,'show','4058f5c:scope-x3/acceptance/cases.json'])
const shallow=existsSync(join(snapshot,'.git/shallow'))?readFileSync(join(snapshot,'.git/shallow'),'utf8').trim().split('\n'):[]
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex')
const locks=['package-lock.json','finnor-os/package-lock.json'].map(path=>({path,sha256:sha256(readFileSync(join(snapshot,path)))}))
run('tar',['-czf',archive,'-C',snapshot,'.'])
const manifest={schema:'finnor.x3.self-contained-source.v1',archive:archive.split('/').at(-1),sha256:sha256(readFileSync(archive)),
 branch,head,tree,base:'c12665661c1a536a2350aeb8abc01ac42aa16548',shallowBoundary:shallow,locks,
 sourceManifestSha256:sha256(readFileSync(join(snapshot,'finnor-os/packages/private-equity/src/enterprise-applications/source-manifest.generated.ts'))),
 node:process.version,platform:process.platform,architecture:process.arch,wallMs:performance.now()-started,
 limitations:['DECLARED_SHALLOW_HISTORY_NOT_MISSING_ANCESTOR_RECONSTRUCTION','SOURCE_ARTIFACT_NOT_INSTALLED_PROOF'],
 standaloneGit:true,alternates:false,copiedNodeModules:false,staging}
writeFileSync(archive+'.json',JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600})
console.log(JSON.stringify(manifest))
