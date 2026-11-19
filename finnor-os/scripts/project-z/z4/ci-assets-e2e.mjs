import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {mkdtempSync,readFileSync,writeFileSync,cpSync,rmSync,existsSync,chmodSync,unlinkSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {dirname,join,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../../..')
const artifact=process.argv[2],evidence=process.argv[3]
assert(artifact?.startsWith('/')&&evidence?.startsWith('/')&&!existsSync(evidence))
const helper=join(root,'finnor-os/scripts/project-z/z4/ci-native.py')
const native=join(root,'finnor-os/packages/epistemic-runtime/native/z4-execution-proof')
const receipt=JSON.parse(readFileSync(join(artifact,'receipt.json'),'utf8'))
const originals=new Map(['build-identity.json','bin/z4-proof','bin/z4-field-falsifier'].map(path=>[
 path,existsSync(join(native,path))?readFileSync(join(native,path)):null]))
const temporary=mkdtempSync(join(dirname(evidence),'z4-install-controls-'))
const observations=[]
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
const invoke=(directory,sha)=>spawnSync('python3',[helper,'install','--repository',root,'--artifact',directory,'--expected-sha',sha],{encoding:'utf8'})
const installed=()=>['build-identity.json','bin/z4-proof','bin/z4-field-falsifier'].map(p=>hash(readFileSync(join(native,p))))
try{
 const positive=invoke(artifact,receipt.sourceCommit)
 assert.equal(positive.status,0,positive.stderr)
 const before=installed()
 const controls=[
  ['wrong-source',directory=>{},'0'.repeat(40)],
  ['proof-byte-corruption',directory=>{const p=join(directory,'z4-proof'),b=readFileSync(p);b[b.length-1]^=1;chmodSync(p,0o600);writeFileSync(p,b)},receipt.sourceCommit],
  ['falsifier-byte-corruption',directory=>{const p=join(directory,'z4-field-falsifier'),b=readFileSync(p);b[b.length-1]^=1;chmodSync(p,0o600);writeFileSync(p,b)},receipt.sourceCommit],
  ['source-identity-corruption',directory=>{const p=join(directory,'build-identity.json'),r=JSON.parse(readFileSync(p,'utf8'));r.sourceDigest='0'.repeat(64);writeFileSync(p,JSON.stringify(r))},receipt.sourceCommit],
  ['recipe-corruption',directory=>{const p=join(directory,'receipt.json'),r=JSON.parse(readFileSync(p,'utf8'));r.recipeSha256='0'.repeat(64);writeFileSync(p,JSON.stringify(r))},receipt.sourceCommit],
  ['undeclared-member',directory=>writeFileSync(join(directory,'unexpected'),'{"untrusted":true}'),receipt.sourceCommit],
 ]
 for(const [name,change,sha] of controls){
  const directory=join(temporary,name);cpSync(artifact,directory,{recursive:true});change(directory)
  const result=invoke(directory,sha)
  assert.notEqual(result.status,0,name+' must be refused')
  assert.deepEqual(installed(),before,name+' changed installed assets before validation')
  observations.push({name,status:'PASS',exit:result.status})
 }
 const identity=spawnSync(process.execPath,['--import=tsx','--input-type=module','-e',
  "import {nativeIdentity} from './packages/epistemic-runtime/src/project-z/z4-execution-proof/native.ts';console.log(JSON.stringify(await nativeIdentity()))"],
 {cwd:join(root,'finnor-os'),encoding:'utf8'})
 assert.equal(identity.status,0,identity.stderr)
 assert.equal(JSON.parse(identity.stdout).binarySha256,receipt.binarySha256)
 observations.push({name:'actual-native-identity',status:'PASS',binarySha256:receipt.binarySha256})
 writeFileSync(evidence,JSON.stringify({schema:'finnor.z4.ci-assets-e2e.v1',status:'PASS',sourceCommit:receipt.sourceCommit,
  sourceTree:receipt.sourceTree,artifactSha256:hash(readFileSync(join(artifact,'receipt.json'))),observations,
  qualification:'COMPILED_NATIVE_ASSET_INSTALLATION_ONLY_NOT_PHASE_OR_SECURITY_ACCEPTANCE'},null,2)+'\n')
 console.log(JSON.stringify({status:'PASS',observations}))
}finally{
 for(const [path,bytes] of originals){const p=join(native,path);if(bytes===null){if(existsSync(p))unlinkSync(p)}
  else{if(existsSync(p))chmodSync(p,0o600);writeFileSync(p,bytes);chmodSync(p,path.startsWith('bin/')?0o500:0o644)}}
 rmSync(temporary,{recursive:true})
}
