/** A physical replay barrier, not a simulated failure or a success override. */
import {ipcProcessGroupObserver} from '../../../../epistemic-runtime/src/project-z/z4-execution-proof/process-groups';
export function nativeReplayProcessObserver(sessionId:string){
 if(process.env.FINNOR_Z4_REPLAY_SESSION!==sessionId||!process.env.FINNOR_Z4_REPLAY_NONCE)return undefined;
 if(process.env.NODE_ENV==='production'||process.env.FINNOR_Z4_PROFILE!=='ordinary_disposable'||
  process.env.FINNOR_ENVIRONMENT!=='staging'||
  !/^[a-f0-9]{64}$/.test(process.env.FINNOR_Z4_REPLAY_AUTHORITY_SHA256??''))throw Error('Z4_PHYSICAL_REPLAY_CHANNEL_REQUIRED');
 return ipcProcessGroupObserver(sessionId,process.env.FINNOR_Z4_REPLAY_NONCE);
}
export async function physicalRecoveryBoundary(sessionId:string,stage:'CLAIM'|'CHECKPOINT'|'OWNER_RESULT'|'OWNER_ACK'):Promise<void>{
 if(process.env.FINNOR_Z4_REPLAY_PAUSE_AT!==stage||process.env.FINNOR_Z4_REPLAY_SESSION!==sessionId)return;
 if(process.env.NODE_ENV==='production'||process.env.FINNOR_Z4_PROFILE!=='ordinary_disposable'||
  process.env.FINNOR_ENVIRONMENT!=='staging'||!process.send||
  !/^[a-f0-9]{64}$/.test(process.env.FINNOR_Z4_REPLAY_AUTHORITY_SHA256??'')||
  !/^[a-f0-9]{32}$/.test(process.env.FINNOR_Z4_REPLAY_NONCE??''))throw Error('Z4_PHYSICAL_REPLAY_CHANNEL_REQUIRED');
 const nonce=process.env.FINNOR_Z4_REPLAY_NONCE;
 await new Promise<void>((resolve,reject)=>{
  const timer=setTimeout(()=>{process.off('message',receive);reject(Error('Z4_PHYSICAL_REPLAY_BARRIER_TIMEOUT'));},30000);
  function receive(message:unknown){
   if(message&&typeof message==='object'&&'resume'in message&&message.resume===nonce){
    clearTimeout(timer);process.off('message',receive);resolve();
   }
  }
  process.on('message',receive);
  process.send!({schema:'finnor.z4.physical-boundary.v1',sessionId,stage,nonce,pid:process.pid},error=>{
   if(error){clearTimeout(timer);process.off('message',receive);reject(Error('Z4_PHYSICAL_REPLAY_PARENT_LOST'));}
  });
 });
}
