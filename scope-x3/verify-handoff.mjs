/** Read-only provenance/compatibility and scoped credential-pattern audit.
 * This is not a business oracle, full secret scanner, or qualification gate. */
import {strict as assert} from 'node:assert'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {readFileSync,readdirSync,statSync,mkdirSync,writeFileSync} from 'node:fs'
import {dirname,isAbsolute,join,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..')
const base='c12665661c1a536a2350aeb8abc01ac42aa16548'
const output=process.argv[2],evidence=process.argv[3]
assert(output&&isAbsolute(output),'Supply an absolute output JSON path')
assert(!evidence||isAbsolute(evidence),'Evidence root must be absolute')
const git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8',maxBuffer:64*1024*1024})
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
const json=path=>JSON.parse(readFileSync(path,'utf8'))
assert.equal(git('rev-parse',base+'^{commit}').trim(),base)
const freeze=json(join(root,'scope-x3/acceptance/spec-digest.json'))
const frozen=[]
for(const [name,expected] of Object.entries(freeze.files).sort(([a],[b])=>a<b?-1:a>b?1:0)){
 const path='scope-x3/acceptance/'+name,actual=hash(readFileSync(join(root,path)))
 assert.equal(actual,expected,path)
 assert.equal(actual,hash(git('show','4058f5c:'+path)),path+': original commit')
 frozen.push(actual+'  '+name+'\n')
}
const frozenDigest=hash(frozen.join(''))
assert.equal(frozenDigest,'f178cecbc327e551c805ce6354cb9e99dc79e6d49ae6c11bb5090ee62d5f31cc')
for(const [name,expected] of [
 ['integration-plan.md','46dbdada82df16cd6f8a7bfc79889d83ca011842f815091cfb560348afe37d0f'],
 ['second-application.json','e0e3adfa8afd6a3aef76fe735157c92838d9cba06a96b82d21b6487a48417ce7'],
])assert.equal(hash(readFileSync(join(root,'scope-x3/acceptance',name))),expected,name)

const stampPath='finnor-os/packages/private-equity/src/enterprise-applications/source-manifest.generated.ts'
const stampText=readFileSync(join(root,stampPath),'utf8')
const stamp=JSON.parse(stampText.slice(stampText.indexOf('{'),stampText.lastIndexOf('}')+1))
assert.equal(stamp.files.length,50)
for(const file of stamp.files)assert.equal(hash(readFileSync(join(root,file.path))),file.sha256,file.path)

const previous=JSON.parse(git('show',base+':finnor-os/openapi.json')),current=json(join(root,'finnor-os/openapi.json'))
const addedPaths=Object.keys(current.paths).filter(path=>!Object.hasOwn(previous.paths,path))
assert.equal(addedPaths.length,15)
assert(addedPaths.every(path=>path.startsWith('/api/company-brain/application-')))
const addedOperations=new Set(addedPaths.map(path=>path.split('/').at(-1))),enumExtensions=[]
let nodes=0
function compatible(oldValue,newValue,path=[],depth=0){
 assert(++nodes<=1000000&&depth<=128,'OpenAPI traversal bound')
 if(JSON.stringify(oldValue)===JSON.stringify(newValue))return
 if(Array.isArray(oldValue)){
  assert(Array.isArray(newValue),path.join('.'))
  if(path.at(-1)==='enum'){
   const extra=newValue.filter(value=>!oldValue.includes(value))
   assert.equal(extra.length,15,path.join('.'))
   assert(extra.every(value=>addedOperations.has(value)),path.join('.'))
   assert.deepEqual(newValue.filter(value=>oldValue.includes(value)),oldValue,path.join('.'))
   enumExtensions.push({path:path.join('.'),added:extra});return
  }
  assert.equal(newValue.length,oldValue.length,path.join('.'))
  oldValue.forEach((value,index)=>compatible(value,newValue[index],[...path,String(index)],depth+1));return
 }
 assert(oldValue&&newValue&&typeof oldValue==='object'&&typeof newValue==='object',path.join('.'))
 for(const [key,value] of Object.entries(oldValue)){
  assert(Object.hasOwn(newValue,key),[...path,key].join('.'))
  compatible(value,newValue[key],[...path,key],depth+1)
 }
}
compatible(previous,current)
for(const [name,schema] of Object.entries(previous.components.schemas??{}))assert.deepEqual(current.components.schemas[name],schema,name)

const rules=[
 ['private-key',/-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g],
 ['aws-access-key',/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
 ['github-token',/\bgh[pousr]_[A-Za-z0-9]{24,}\b/g],
 ['supabase-secret',/\bsb_secret_[A-Za-z0-9_-]{20,}\b/g],
 ['literal-jwt',/\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{16,}\b/g],
 ['credentialed-uri',/\b(?:postgres(?:ql)?|https?):\/\/[A-Za-z0-9_.-]+:[A-Za-z0-9_+.-]{8,}@[A-Za-z0-9_.-]+/g],
],findings=[]
function inspectText(label,text){
 for(const [rule,pattern] of rules)for(const match of text.matchAll(pattern)){
  findings.push({path:label,rule,line:text.slice(0,match.index).split('\n').length})
 }
}
const paths=[...new Set([...git('diff','--name-only',base).trim().split('\n'),...git('ls-files','--others','--exclude-standard').trim().split('\n')])].filter(Boolean).sort()
const sourceFiles=[]
for(const path of paths){
 const absolute=join(root,path);if(resolve(absolute)===resolve(output))continue
 const bytes=readFileSync(absolute);assert(bytes.length<=64*1024*1024)
 inspectText(path,bytes.toString());sourceFiles.push({path,bytes:bytes.length,sha256:hash(bytes)})
}
const commits=git('rev-list',base+'..HEAD').trim().split('\n').filter(Boolean)
for(const commit of commits)inspectText('git:'+commit,git('show','--format=','--no-ext-diff','--unified=0',commit))
const artifacts=[]
function scan(directory,relative=''){
 for(const entry of readdirSync(directory,{withFileTypes:true})){
  const path=join(directory,entry.name),name=relative?relative+'/'+entry.name:entry.name
  if(resolve(path)===resolve(output))continue
  assert(artifacts.length<20000,'Evidence file bound')
  if(entry.isDirectory())scan(path,name)
  else if(entry.isFile()){
   assert(statSync(path).size<=64*1024*1024,'Evidence file size bound')
   const bytes=readFileSync(path);if(/\.(?:jsonl?|log|txt|md|out)$/.test(name))inspectText('evidence:'+name,bytes.toString())
   artifacts.push({path:name,bytes:bytes.length,sha256:hash(bytes)})
  }
 }
}
if(evidence)scan(evidence)
assert.equal(findings.length,0,JSON.stringify(findings))
const result={schema:'finnor.x3.delivery-audit.v1',status:'PASS_SCOPED_AUDIT',base,head:git('rev-parse','HEAD').trim(),
 worktreeStatus:git('status','--porcelain'),frozenAcceptanceDigest:frozenDigest,
 emittedManifestDigest:hash(stampText),emittedFiles:stamp.files,sourceFiles,
 openapi:{previousPaths:Object.keys(previous.paths).length,currentPaths:Object.keys(current.paths).length,addedPaths,enumExtensions,previousNamedSchemaCount:Object.keys(previous.components.schemas??{}).length,existingSchemasUnchanged:true},
 historyCommits:commits,credentialPatternRules:rules.map(([name])=>name),credentialPatternFindings:findings,artifacts,
 limitations:['PATTERN_SCAN_NOT_GITLEAKS_OR_FULL_SECURITY_AUDIT','DEVELOPMENT_EVIDENCE_NOT_PROTECTED_CUSTODY','NO_PRODUCTION_IMAGE_OR_ARM64_QUALIFICATION']}
mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(result,null,2)+'\n')
console.log(JSON.stringify({status:result.status,sourceFiles:sourceFiles.length,emittedFiles:stamp.files.length,historyCommits:commits.length,artifacts:artifacts.length,findings:findings.length}))
