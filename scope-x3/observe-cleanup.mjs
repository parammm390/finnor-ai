/** Separate eventual-cleanup observation. Does not rewrite or rescore a meter. */
import {strict as assert} from 'node:assert'
import {createHash} from 'node:crypto'
import {readFileSync,writeFileSync} from 'node:fs'
import {isAbsolute} from 'node:path'
const path=process.argv[2]
assert(path&&isAbsolute(path),'Supply an absolute original meter receipt')
const bytes=readFileSync(path),meter=JSON.parse(bytes)
assert.equal(meter.schema,'finnor.x3.sampled-process-meter.v1')
const observations=meter.aliveObservedDescendants.map(original=>{
 assert(Number.isSafeInteger(original.pid)&&original.pid>0&&/^[0-9]+$/.test(original.startTicks),'Invalid process identity')
 let current=null
 try{
  const line=readFileSync('/proc/'+original.pid+'/stat','utf8')
  const fields=line.slice(line.lastIndexOf(')')+2).trim().split(/\s+/)
  current={state:fields[0],startTicks:fields[19]}
 }catch(error){assert(['ENOENT','ESRCH'].includes(error.code),'Process state is unknown, not absent')}
 return {original,current,sameLiveIdentity:!!current&&current.startTicks===original.startTicks&&current.state!=='Z'}
})
const result={schema:'finnor.x3.eventual-cleanup-observation.v1',
 status:observations.every(row=>!row.sameLiveIdentity)?'PASS_EVENTUAL_OWNED_CLEANUP':'FAIL_OWNED_DESCENDANTS_REMAIN',
 meterSha256:createHash('sha256').update(bytes).digest('hex'),observedAt:new Date().toISOString(),
 observations,originalMeterStatus:meter.status,originalMeterUnchanged:true,
 limitations:['FOLLOWUP_NOT_ZERO_LATENCY_CLEANUP','UNOBSERVED_INTERVENING_CPU_OR_PEAK_NOT_ATTESTED']}
writeFileSync(path+'.cleanup-followup.json',JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600})
console.log(JSON.stringify(result))
if(result.status.startsWith('FAIL'))process.exitCode=1
