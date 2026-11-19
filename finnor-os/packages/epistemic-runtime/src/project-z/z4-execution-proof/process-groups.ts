/** Linux identities for cleanup of explicitly owned native process groups. */
import {readFileSync} from 'node:fs';
import type {ChildProcess} from 'node:child_process';
export interface OwnedProcessGroup {pid:number;parentPid:number;groupId:number;startTicks:string}
export interface ProcessGroupNotice {stage:'START'|'CLOSE';group:OwnedProcessGroup}
const validPid=(pid:number)=>Number.isSafeInteger(pid)&&pid>1&&pid<2147483648;
export function observeProcessGroup(pid:number,parentPid?:number,leader=true):OwnedProcessGroup{
 if(process.platform!=='linux'||!validPid(pid))throw Error('Z4_OWNED_PROCESS_IDENTITY_REQUIRED');
 const body=readFileSync('/proc/'+pid+'/stat','utf8'),fields=body.slice(body.lastIndexOf(')')+2).trim().split(/\s+/);
 const ppid=Number(fields[1]),groupId=Number(fields[2]),startTicks=fields[19]!;
 const uid=/^Uid:\s+(\d+)/m.exec(readFileSync('/proc/'+pid+'/status','utf8'));
 if(!uid||Number(uid[1])!==process.getuid?.()||!validPid(groupId)||!/^[0-9]{1,24}$/.test(startTicks)||
  parentPid!==undefined&&ppid!==parentPid||leader&&groupId!==pid)throw Error('Z4_OWNED_PROCESS_IDENTITY_REQUIRED');
 return {pid,parentPid:ppid,groupId,startTicks};
}
export function stopProcessGroup(group:OwnedProcessGroup):boolean{
 try{
  const current=observeProcessGroup(group.pid);
  if(current.startTicks!==group.startTicks||current.groupId!==group.groupId)throw Error('Z4_OWNED_PROCESS_IDENTITY_CHANGED');
  process.kill(-group.pid,'SIGKILL');return true;
 }catch(error){
  if(['ENOENT','ESRCH'].includes((error as NodeJS.ErrnoException).code??''))return false;
  throw error;
 }
}
export function ipcProcessGroupObserver(channelId:string,nonce:string){
 if(!process.send||!/^[a-f0-9]{32}$/.test(nonce))throw Error('Z4_OWNED_PROCESS_CHANNEL_REQUIRED');
 const active=new Map<number,OwnedProcessGroup>();
 const disconnected=()=>{
  for(const group of active.values())try{stopProcessGroup(group);}catch{}
  process.kill(process.pid,'SIGTERM');
 };
 return async(notice:ProcessGroupNotice)=>{
  const {group,stage}=notice;
  if(stage==='CLOSE'){
   active.delete(group.pid);
   if(!active.size)process.off('disconnect',disconnected);
   if(process.connected)process.send!({schema:'finnor.z4.owned-process-group.v1',channelId,nonce,...notice});
   return;
  }
  if(!process.connected)throw Error('Z4_OWNED_PROCESS_PARENT_LOST');
  if(!active.size)process.once('disconnect',disconnected);
  active.set(group.pid,group);
  await new Promise<void>((resolve,reject)=>{
   const finish=(error?:Error)=>{
    clearTimeout(timer);process.off('message',receive);
    if(error)reject(error);else resolve();
   };
   const receive=(value:unknown)=>{
    const m=value as {schema?:string;channelId?:string;nonce?:string;pid?:number;startTicks?:string};
    if(m?.schema==='finnor.z4.owned-process-recorded.v1'&&m.channelId===channelId&&m.nonce===nonce&&
     m.pid===group.pid&&m.startTicks===group.startTicks)finish();
   };
   const timer=setTimeout(()=>finish(Error('Z4_OWNED_PROCESS_ACK_TIMEOUT')),5000);
   process.on('message',receive);
   process.send!({schema:'finnor.z4.owned-process-group.v1',channelId,nonce,...notice},
    error=>{if(error)finish(Error('Z4_OWNED_PROCESS_PARENT_LOST'));});
  });
 };
}
export class OwnedNativeGroups {
 readonly active=new Map<number,OwnedProcessGroup>();
 readonly receipts:Array<Record<string,unknown>>=[];
 constructor(private readonly child:ChildProcess,private readonly channelId:string,private readonly nonce:string){}
 accept(value:unknown):boolean{
  const m=value as {schema?:string;channelId?:string;nonce?:string;stage?:string;group?:OwnedProcessGroup};
  if(m?.schema!=='finnor.z4.owned-process-group.v1')return false;
  if(m.channelId!==this.channelId||m.nonce!==this.nonce||!m.group||m.group.parentPid!==this.child.pid||
   !validPid(m.group.pid)||!/^[0-9]{1,24}$/.test(m.group.startTicks))throw Error('Z4_OWNED_PROCESS_CHANNEL_MISMATCH');
  const group=m.group;
  if(m.stage==='START'){
   const fresh=observeProcessGroup(group.pid,this.child.pid);
   if(fresh.startTicks!==group.startTicks||fresh.groupId!==group.groupId||this.active.has(group.pid))
    throw Error('Z4_OWNED_PROCESS_IDENTITY_CHANGED');
   this.active.set(group.pid,fresh);this.receipts.push({stage:'START',group:fresh});
   this.child.send({schema:'finnor.z4.owned-process-recorded.v1',channelId:this.channelId,nonce:this.nonce,
    pid:group.pid,startTicks:group.startTicks},error=>{if(error)this.stop();});
  }else if(m.stage==='CLOSE'){
   const saved=this.active.get(group.pid);
   if(!saved||saved.startTicks!==group.startTicks)throw Error('Z4_OWNED_PROCESS_UNKNOWN_CLOSE');
   this.active.delete(group.pid);this.receipts.push({stage:'CLOSE',group:saved});
  }else throw Error('Z4_OWNED_PROCESS_STAGE');
  return true;
 }
 stop(){
  for(const group of this.active.values()){
   const signalled=stopProcessGroup(group);
   this.receipts.push({stage:'CLEANUP_SIGKILL',group,signalled});
  }
 }
}
