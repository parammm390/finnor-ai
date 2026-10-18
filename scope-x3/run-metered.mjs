/** Linux development observer, not a billing or protected accounting authority. */
import {strict as assert} from 'node:assert'
import {spawn,execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {closeSync,existsSync,mkdirSync,openSync,readFileSync,readdirSync,statSync,writeFileSync,appendFileSync} from 'node:fs'
import {dirname,isAbsolute,join} from 'node:path'

const [output,cwd,separator,command,...args]=process.argv.slice(2)
assert(process.platform==='linux','Linux /proc is required')
assert(output&&cwd&&isAbsolute(output)&&isAbsolute(cwd)&&separator==='--'&&command,'Usage: node run-metered.mjs /absolute/receipt.json /absolute/cwd -- command ...args')
const timeoutMs=Number(process.env.FINNOR_X3_METER_TIMEOUT_MS??900000)
const maxRssBytes=Number(process.env.FINNOR_X3_METER_MAX_RSS_BYTES??6*1024**3)
assert(Number.isSafeInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=3600000)
assert(Number.isSafeInteger(maxRssBytes)&&maxRssBytes>0&&maxRssBytes<=6*1024**3)
mkdirSync(dirname(output),{recursive:true})
for(const path of [output,output+'.log',output+'.samples.jsonl'])assert(!existsSync(path),'Refusing to overwrite an attempt')
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
const root=execFileSync('git',['-C',cwd,'rev-parse','--show-toplevel'],{encoding:'utf8'}).trim()
const git=(...argv)=>execFileSync('git',['-C',root,...argv],{maxBuffer:64*1024*1024})
const source={head:git('rev-parse','HEAD').toString().trim(),tree:git('rev-parse','HEAD^{tree}').toString().trim(),
 dirtyPatchSha256:hash(git('diff','--binary','HEAD')),status:git('status','--porcelain').toString(),
 untracked:git('ls-files','--others','--exclude-standard','-z').toString().split('\0').filter(Boolean).map(path=>{
  const absolute=join(root,path)
  const bytes=readFileSync(absolute);assert(bytes.length<=64*1024*1024);return {path,sha256:hash(bytes)}
 })}
const tickHz=Number(execFileSync('getconf',['CLK_TCK'],{encoding:'utf8'}))
const pageBytes=Number(execFileSync('getconf',['PAGESIZE'],{encoding:'utf8'}))
assert(tickHz>0&&pageBytes>0)
const startedAt=new Date().toISOString(),started=performance.now(),intervalMs=250,tracked=new Map()
const maxLogBytes=16*1024*1024
let samples=0,peakRssBytes=0,peakSwapBytes=0,readMisses=0,swapReadMisses=0,stopReason=null,finished=false,rootStartTicks=null,killTimer
const log=openSync(output+'.log','wx',0o600)
writeFileSync(output+'.samples.jsonl','',{flag:'wx',mode:0o600})
const child=spawn(command,args,{cwd,env:process.env,stdio:['ignore',log,log]})
function processStat(pid){
 try{
  const raw=readFileSync(`/proc/${pid}/stat`,'utf8'),fields=raw.slice(raw.lastIndexOf(')')+2).trim().split(/\s+/)
  const result={pid:Number(pid),parentPid:Number(fields[1]),state:fields[0],startTicks:fields[19],cpuTicks:Number(fields[11])+Number(fields[12]),rssBytes:Number(fields[21])*pageBytes}
  assert(result.startTicks&&Number.isFinite(result.cpuTicks)&&Number.isFinite(result.rssBytes))
  return result
 }catch{readMisses++;return null}
}
function terminate(signal){
 for(const identity of [...tracked.values()].reverse()){
  const current=processStat(identity.pid)
  if(current&&current.startTicks===identity.startTicks)try{process.kill(identity.pid,signal)}catch{}
 }
 try{child.kill(signal)}catch{}
}
function stop(reason){
 if(stopReason)return
 stopReason=reason;terminate('SIGTERM')
 killTimer=setTimeout(()=>terminate('SIGKILL'),3000)
}
function sample(){
 if(finished||!child.pid)return
 const all=readdirSync('/proc').filter(name=>/^[0-9]+$/.test(name)).map(processStat).filter(Boolean),owned=new Set([child.pid])
 const rootProcess=all.find(row=>row.pid===child.pid)
 if(!rootProcess||rootStartTicks&&rootProcess.startTicks!==rootStartTicks)return
 rootStartTicks??=rootProcess.startTicks
 for(const identity of tracked.values())if(all.some(row=>row.pid===identity.pid&&row.startTicks===identity.startTicks))owned.add(identity.pid)
 let changed=true
 while(changed){changed=false;for(const row of all)if(owned.has(row.parentPid)&&!owned.has(row.pid)){owned.add(row.pid);changed=true}}
 const rows=all.filter(row=>owned.has(row.pid))
 let rssBytes=0,swapBytes=0
 for(const row of rows){
  const key=row.pid+':'+row.startTicks,prior=tracked.get(key)
  tracked.set(key,{...row,cpuTicks:Math.max(row.cpuTicks,prior?.cpuTicks??0)})
  rssBytes+=row.rssBytes
  try{const match=readFileSync(`/proc/${row.pid}/status`,'utf8').match(/^VmSwap:\s+(\d+)/m);if(match)swapBytes+=Number(match[1])*1024;else swapReadMisses++}catch{readMisses++;swapReadMisses++}
 }
 if(!rows.length)return
 samples++;peakRssBytes=Math.max(peakRssBytes,rssBytes);peakSwapBytes=Math.max(peakSwapBytes,swapBytes)
 appendFileSync(output+'.samples.jsonl',JSON.stringify({wallMs:performance.now()-started,pids:rows.map(row=>({pid:row.pid,parentPid:row.parentPid,startTicks:row.startTicks})),rssBytes,swapBytes})+'\n')
 if(rssBytes>maxRssBytes)stop('SAMPLED_AGGREGATE_RSS_BOUND')
 if(statSync(output+'.log').size>maxLogBytes)stop('COMMAND_LOG_BOUND')
}
const sampler=setInterval(sample,intervalMs),deadline=setTimeout(()=>stop('COMMAND_WALL_BOUND'),timeoutMs)
const terminal=await new Promise(resolve=>{
 child.once('error',error=>resolve({exitCode:null,signal:null,spawnError:error.code??error.name}))
 child.once('exit',(exitCode,signal)=>resolve({exitCode,signal}))
 sample()
})
finished=true;clearInterval(sampler);clearTimeout(deadline);clearTimeout(killTimer)
if(statSync(output+'.log').size>maxLogBytes)stopReason??='COMMAND_LOG_BOUND'
if(stopReason)terminate('SIGKILL')
closeSync(log)
const alive=[...tracked.values()].filter(row=>{const current=processStat(row.pid);return current?.startTicks===row.startTicks&&current.state!=='Z'})
const result={schema:'finnor.x3.sampled-process-meter.v1',status:terminal.exitCode===0&&!stopReason?(alive.length?'PARTIAL_COMMAND_CLEANUP':'PASS_COMMAND'):'FAIL_COMMAND',
 command:[command,...args],cwd,node:process.execPath,nodeVersion:process.version,source,startedAt,endedAt:new Date().toISOString(),wallMs:performance.now()-started,
 ...terminal,stopReason,bounds:{timeoutMs,maxRssBytes,maxLogBytes,intervalMs},samples,observedProcesses:tracked.size,
 observedCpuSeconds:samples?[...tracked.values()].reduce((sum,row)=>sum+row.cpuTicks,0)/tickHz:null,
 sampledAggregatePeakRssBytes:samples?peakRssBytes:null,sampledAggregatePeakSwapBytes:samples&&!swapReadMisses?peakSwapBytes:null,swapReadMisses,
 processIdentities:[...tracked.values()].map(({pid,parentPid,startTicks})=>({pid,parentPid,startTicks})),aliveObservedDescendants:alive.map(({pid,startTicks})=>({pid,startTicks})),
 procReadMisses:readMisses,logBytes:statSync(output+'.log').size,observerUsage:process.resourceUsage(),
 limitations:['SAMPLED_NOT_ATTESTED_UNSAMPLED_PEAK','RSS_MAY_DOUBLE_COUNT_SHARED_PAGES','SHORT_LIVED_DESCENDANTS_MAY_BE_MISSED','CPU_OBSERVED_LOWER_BOUND','NO_PROVIDER_OR_HUMAN_BILLING_METER']}
writeFileSync(output,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600})
console.log(JSON.stringify({status:result.status,receipt:output,wallMs:result.wallMs,sampledAggregatePeakRssBytes:result.sampledAggregatePeakRssBytes,observedProcesses:result.observedProcesses,exitCode:result.exitCode}))
process.exitCode=result.status==='PASS_COMMAND'?0:1
