import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {createServer} from 'node:net';
import {resolve,join} from 'node:path';
import {native,toolIdentity} from '../../../packages/epistemic-runtime/src/uniform-algorithms/native';
import {hash} from '../../../packages/epistemic-runtime/src/uniform-algorithms/syntax';
const evidence=resolve(process.env.FINNOR_Y5_EVIDENCE_DIR??'../evidence/y5-native-isolation');
await mkdir(evidence,{recursive:true,mode:0o700});
const save=(name:string,value:unknown)=>writeFile(join(evidence,name),JSON.stringify(value,null,2)+'\n',{mode:0o600});
const started=Date.now(),observed:unknown[]=[];
let listener:ReturnType<typeof createServer>|undefined;
try{
 const scratch=join(evidence,'scratch'),outside=join(evidence,'outside-sentinel.txt');
 await mkdir(scratch,{mode:0o700});await writeFile(outside,'Y5_PUBLIC_GENERATED_OUTSIDE_SENTINEL\n',{mode:0o600});
 await writeFile(join(scratch,'inside.txt'),'Y5_OWNED_INSIDE\n',{mode:0o600});
 const source=`import Init
def main : IO UInt32 := do
  let own ← IO.FS.readFile "inside.txt"
  if own != "Y5_OWNED_INSIDE\\n" then return 11
  IO.FS.writeFile "owned-output.txt" "Y5_OWNED_WRITE\\n"
  try
    let _ ← IO.FS.readFile ${JSON.stringify(outside)}
    IO.println "OUTSIDE_READ_ESCAPED"
    return 12
  catch _ => pure ()
  try
    IO.FS.writeFile ${JSON.stringify(outside)} "ESCAPED_WRITE"
    IO.println "OUTSIDE_WRITE_ESCAPED"
    return 13
  catch _ => pure ()
  try
    let r ← IO.Process.output {cmd := "/usr/bin/true"}
    if r.exitCode == 0 then
      IO.println "OTHER_EXEC_ESCAPED"
      return 14
  catch _ => pure ()
  IO.println "OWNED_IO_AND_OUTSIDE_DENIALS_OK"
  return 0
`;
 await writeFile(join(scratch,'Boundary.lean'),source,{mode:0o600});
 const tool=await toolIdentity(),receipt=await native(tool,['lean','-M','2048','-T','200000','--run','Boundary.lean'],
  {scratch,deadlineAt:Date.now()+30000},'os-boundary');
 await save('native-boundary.json',{sourceDigest:hash(source),receipt});observed.push({case:'actual-native-boundary',receipt});
 assert.equal(receipt.exitCode,0,receipt.stdout+receipt.stderr);
 assert.equal(receipt.isolation as string,'DARWIN_SEATBELT_DENY_NETWORK_SCOPED_FILESYSTEM');
 assert.equal(await readFile(outside,'utf8'),'Y5_PUBLIC_GENERATED_OUTSIDE_SENTINEL\n');
 assert.equal(await readFile(join(scratch,'owned-output.txt'),'utf8'),'Y5_OWNED_WRITE\n');
 const policy=resolve(import.meta.dirname,'../../../packages/epistemic-runtime/src/uniform-algorithms/native-sandbox.sb');
 const probeRoot=join(evidence,'probe-tool');await mkdir(probeRoot,{mode:0o700});
 const c=`#include <sys/socket.h>
#include <arpa/inet.h>
#include <unistd.h>
#include <stdlib.h>
#include <stdio.h>
int main(int argc,char **argv) {
  if (argc != 2) return 90;
  int fd=socket(AF_INET,SOCK_STREAM,0);
  if(fd<0) {puts("NETWORK_DENIED");return 0;}
  struct sockaddr_in address={0};address.sin_family=AF_INET;
  address.sin_port=htons((unsigned short)atoi(argv[1]));address.sin_addr.s_addr=htonl(INADDR_LOOPBACK);
  int result=connect(fd,(struct sockaddr*)&address,sizeof(address));close(fd);
  if(result<0) {puts("NETWORK_DENIED");return 0;}
  puts("NETWORK_CONNECTED");return 17;
}
`;
 await writeFile(join(probeRoot,'probe.c'),c,{mode:0o600});
 const binary=join(probeRoot,'probe'),build=spawnSync('/usr/bin/cc',[join(probeRoot,'probe.c'),'-o',binary],{encoding:'utf8',timeout:30000,maxBuffer:1048576});
 await save('probe-build.json',{status:build.status,stdout:build.stdout,stderr:build.stderr,sourceDigest:hash(c)});
 assert.equal(build.status,0,build.stderr);
 listener=createServer(socket=>socket.end());await new Promise<void>((yes,no)=>{listener!.once('error',no);listener!.listen(0,'127.0.0.1',yes);});
 const address=listener.address();assert(address&&typeof address==='object');const port=String(address.port);
 const control=spawnSync(binary,[port],{encoding:'utf8',timeout:5000});assert.equal(control.status,17,control.stdout+control.stderr);
 const sandboxed=spawnSync('/usr/bin/sandbox-exec',['-D','TOOL_ROOT='+probeRoot,'-D','SCRATCH='+scratch,'-D','NATIVE_BINARY='+binary,'-f',policy,binary,port],
  {encoding:'utf8',timeout:5000});
 await save('network-boundary.json',{control:{status:control.status,stdout:control.stdout,stderr:control.stderr},
  sandboxed:{status:sandboxed.status,stdout:sandboxed.stdout,stderr:sandboxed.stderr},policyDigest:hash(await readFile(policy)),
  destination:'OWNED_LOOPBACK_LISTENER_ONLY',probeIsProductionRuntime:false});
 assert.equal(sandboxed.status,0,sandboxed.stderr);assert.equal(sandboxed.stdout.trim(),'NETWORK_DENIED');
 observed.push({case:'owned-loopback-policy-probe',controlStatus:control.status,sandboxedStatus:sandboxed.status});
 await save('results.json',{status:'PASS',wallMs:Date.now()-started,observed,
  scope:'ACTUAL_NATIVE_FILESYSTEM_EXEC_BOUNDARY_AND_SAME_POLICY_NETWORK_DENIAL_NOT_COMPLETE_RESOURCE_QUALIFICATION',
  aggregatePeakBytes:null,completeMoney:null,completeHumanSeconds:null,
  rerun:'FINNOR_Y5_EVIDENCE_DIR=<new-directory> node_modules/.bin/tsx scripts/postx/y5/verify-native-isolation.mts'});
 console.log(JSON.stringify({status:'PASS',evidence,wallMs:Date.now()-started}));
}catch(error){await save('failure.json',{status:'FAIL',error:String(error),stack:(error as Error).stack,receipt:(error as any).receipt??null,observed});throw error;}
finally{if(listener)await new Promise<void>(yes=>listener!.close(()=>yes()));}
