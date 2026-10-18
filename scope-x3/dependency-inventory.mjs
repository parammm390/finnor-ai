/** Lockfile-derived inventory, not a legal opinion or vulnerability scanner. */
import {strict as assert} from 'node:assert'
import {createHash} from 'node:crypto'
import {readFileSync,mkdirSync,writeFileSync,existsSync} from 'node:fs'
import {dirname,isAbsolute,join,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),output=process.argv[2]
assert(output&&isAbsolute(output)&&!existsSync(output),'Supply a fresh absolute receipt path')
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
const locks=['package-lock.json','finnor-os/package-lock.json'].map(path=>{
 const bytes=readFileSync(join(root,path)),lock=JSON.parse(bytes),packages=Object.entries(lock.packages).map(([location,value])=>({
  location,name:value.name??null,version:value.version??null,link:value.link===true,
  integrity:value.integrity??null,resolved:value.resolved??null,license:value.license??'UNKNOWN_NOT_RECORDED_IN_LOCK',
 }))
 return {path,sha256:hash(bytes),lockfileVersion:lock.lockfileVersion,packages,missingRecordedLicense:packages.filter(p=>p.license==='UNKNOWN_NOT_RECORDED_IN_LOCK').length}
})
const result={schema:'finnor.x3.dependency-license-inventory.v1',status:'OBSERVED_LOCK_INVENTORY',locks,
 compilerModels:'NONE_TYPED_COMPILER',newDependenciesForX3:false,
 providerCosts:'UNKNOWN_NOT_METERED',engineeringModelAndHumanCosts:'UNKNOWN_NO_COMPLETE_INDEPENDENT_METER',
 limitations:['LOCK_METADATA_NOT_LEGAL_LICENSE_CLEARANCE','MISSING_LICENSE_IS_UNKNOWN_NOT_PERMISSIVE','NOT_A_VULNERABILITY_OR_FULL_SUPPLY_CHAIN_AUDIT']}
mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600})
console.log(JSON.stringify({status:result.status,locks:locks.map(({path,sha256,packages,missingRecordedLicense})=>({path,sha256,packages:packages.length,missingRecordedLicense}))}))
