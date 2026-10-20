/** Qualification evidence persistence only. This journal grants no business,
 * signing or effect authority. Every exposure is synced before physical work. */
import {createHash,randomUUID,timingSafeEqual} from 'node:crypto';
import {deflateRawSync,inflateRawSync} from 'node:zlib';
import {readFile,open,rename,lstat,link} from 'node:fs/promises';
import {basename,dirname,join} from 'node:path';

type Json=unknown;
type Change=[Array<string|number>,Json] | [Array<string|number>];
type RecordBody={initial?:any;changes?:Change[];externalBytes?:number};
type Codec={dictionary:Buffer;previous:Buffer;sequence:number};
const sha=(b:Buffer|string)=>createHash('sha256').update(b).digest();
const clean=(v:unknown)=>JSON.parse(JSON.stringify(v));
export const newQualificationJournalCodec=():Codec=>({dictionary:Buffer.alloc(0),previous:Buffer.alloc(16),sequence:0});
function advance(codec:Codec,bytes:Buffer,hash:Buffer){
 codec.dictionary=Buffer.concat([codec.dictionary,bytes]).subarray(-32768);
 codec.previous=hash;codec.sequence++;
}
/** Used by the real durable writer and the independently specified storage
 * horizon challenge. Encoding synthetic time never establishes elapsed time. */
export function encodeQualificationJournalRecord(body:RecordBody,codec:Codec){
 const plain=Buffer.from(JSON.stringify(body)),compressed=deflateRawSync(plain,{level:6,dictionary:codec.dictionary});
 const sequence=Buffer.alloc(8);sequence.writeBigUInt64BE(BigInt(codec.sequence));
 const hash=sha(Buffer.concat([codec.previous,sequence,compressed])).subarray(0,16),header=Buffer.alloc(20);
 header.writeUInt32BE(compressed.length,0);hash.copy(header,4);advance(codec,plain,hash);
 return Buffer.concat([header,compressed]);
}
export function decodeQualificationJournalRecord(frame:Buffer,codec:Codec):RecordBody{
 if(frame.length<20||frame.readUInt32BE(0)!==frame.length-20)throw Error('QUALIFICATION_JOURNAL_FRAME_INCOMPLETE');
 const compressed=frame.subarray(20),sequence=Buffer.alloc(8);sequence.writeBigUInt64BE(BigInt(codec.sequence));
 const hash=sha(Buffer.concat([codec.previous,sequence,compressed])).subarray(0,16);
 if(!timingSafeEqual(hash,frame.subarray(4,20)))throw Error('QUALIFICATION_JOURNAL_FRAME_INTEGRITY_CHANGED');
 const plain=inflateRawSync(compressed,{dictionary:codec.dictionary,maxOutputLength:64*1024*1024});
 const body=JSON.parse(plain.toString('utf8'));advance(codec,plain,hash);return body;
}
function apply(state:any,change:Change){
 const [path,value]=change;if(!Array.isArray(path)||!path.length||path.length>32
   ||path.some(p=>!['string','number'].includes(typeof p)||['__proto__','constructor','prototype'].includes(String(p))))
  throw Error('QUALIFICATION_JOURNAL_PATH_INVALID');
 let parent=state;for(const part of path.slice(0,-1)){
  parent=parent?.[part];if(!parent||typeof parent!=='object')throw Error('QUALIFICATION_JOURNAL_PARENT_MISSING');}
 if(change.length===1)delete parent[path.at(-1)!];else parent[path.at(-1)!]=value;
}
type Loaded={codec:Codec;journal:string;metadataBytes:number;legacyOutputBytes:number};
const loaded=new WeakMap<object,Loaded>();
export async function readQualificationCursor(path:string):Promise<any>{
 const bytes=await readFile(path),pointer=JSON.parse(bytes.toString('utf8'));
 if(pointer?.schema!=='finnor.x1.qualification-state-journal.v1')return pointer;
 if(typeof pointer.journal!=='string'||!/^qualification-state-[a-f0-9-]{36}\.journal$/.test(pointer.journal)
   ||typeof pointer.initialDigest!=='string'||!/^[a-f0-9]{64}$/.test(pointer.initialDigest))throw Error('QUALIFICATION_JOURNAL_POINTER_INVALID');
 const journal=join(dirname(path),pointer.journal);
 if((await lstat(journal)).isSymbolicLink())throw Error('QUALIFICATION_JOURNAL_SYMLINK_REFUSED');
 const file=await open(journal,'r'),codec=newQualificationJournalCodec();let state:any,offset=0,legacyOutputBytes=0,charged=bytes.length;
 try{
  const {size}=await file.stat();if(size>64*1024*1024)throw Error('QUALIFICATION_JOURNAL_INPUT_BOUND');
  while(offset<size){
   const header=Buffer.alloc(20);const h=await file.read(header,0,20,offset);
   if(h.bytesRead!==20)throw Error('QUALIFICATION_JOURNAL_FRAME_INCOMPLETE');
   const length=header.readUInt32BE(0);if(length<1||length>64*1024*1024||offset+20+length>size)throw Error('QUALIFICATION_JOURNAL_FRAME_INCOMPLETE');
   const frame=Buffer.alloc(20+length);header.copy(frame);let at=20;
   while(at<frame.length){const r=await file.read(frame,at,frame.length-at,offset+at);if(!r.bytesRead)throw Error('QUALIFICATION_JOURNAL_FRAME_INCOMPLETE');at+=r.bytesRead;}
   const record=decodeQualificationJournalRecord(frame,codec);
   if(codec.sequence===1){
    if(!record.initial||sha(JSON.stringify(record.initial)).toString('hex')!==pointer.initialDigest)
     throw Error('QUALIFICATION_JOURNAL_INITIAL_PREIMAGE_CHANGED');
    state=record.initial;legacyOutputBytes=state.resources.outputBytes;
   }else{
    if(record.initial||!Array.isArray(record.changes))throw Error('QUALIFICATION_JOURNAL_RECORD_INVALID');
    for(const change of record.changes)apply(state,change);
   }
   const external=record.externalBytes??0;if(!Number.isSafeInteger(external)||external<0)throw Error('QUALIFICATION_JOURNAL_EXTERNAL_CHARGE_INVALID');
   charged+=frame.length+external;offset+=frame.length;
  }
 }finally{await file.close();}
 if(!state||!Number.isSafeInteger(legacyOutputBytes)||legacyOutputBytes<0)throw Error('QUALIFICATION_JOURNAL_INITIAL_STATE_MISSING');
 state.resources.outputBytes=legacyOutputBytes+charged;loaded.set(state,{codec,journal,metadataBytes:bytes.length,legacyOutputBytes});
 return state;
}
export async function openQualificationStateJournal<T extends {resources:{outputBytes:number};revision:number}>(original:T,path:string,
 maxOutputBytes:number){
 let descriptor=loaded.get(original),initialFrame:Buffer|undefined,metadata:Buffer|undefined;
 if(!descriptor){
  const journal=join(dirname(path),'qualification-state-'+randomUUID()+'.journal'),codec=newQualificationJournalCodec();
  metadata=Buffer.from(JSON.stringify({schema:'finnor.x1.qualification-state-journal.v1',journal:basename(journal),
   initialDigest:sha(JSON.stringify(original)).toString('hex'),originalCountersRetained:true})+'\n');
  initialFrame=encodeQualificationJournalRecord({initial:original},codec);
  if(original.resources.outputBytes+metadata.length+initialFrame.length+65536>maxOutputBytes)throw Error('ORIGINAL_AGGREGATE_OUTPUT_BOUND');
  descriptor={journal,codec,metadataBytes:metadata.length,legacyOutputBytes:original.resources.outputBytes};
 }
 const file=await open(descriptor.journal,initialFrame?'wx':'a',0o600);
 if(initialFrame&&metadata){
  try{
   await file.writeFile(initialFrame);await file.sync();
   const temporary=path+'.'+randomUUID()+'.tmp',pointer=await open(temporary,'wx',0o600);
   try{await pointer.writeFile(metadata);await pointer.sync();}finally{await pointer.close();}
   try{const old=await readFile(path);await link(path,path+'.legacy-'+sha(old).toString('hex')+'.json');}
   catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
   await rename(temporary,path);const directory=await open(dirname(path),'r');try{await directory.sync();}finally{await directory.close();}
   original.resources.outputBytes+=metadata.length+initialFrame.length;
  }catch(error){await file.close();throw error;}
 }
 const changes:Change[]=[],cache=new WeakMap<object,Map<string,object>>(),raw=new WeakMap<object,object>();
 let internal=false,closed=false;
 const tracked=(target:any,path:Array<string|number>):any=>{
  if(!target||typeof target!=='object')return target;
  const identity=JSON.stringify(path),paths=cache.get(target)??new Map();cache.set(target,paths);
  if(paths.has(identity))return paths.get(identity);
  const proxy=new Proxy(target,{
   get:(object,key)=>typeof key==='symbol'?Reflect.get(object,key):tracked(Reflect.get(object,key),[...path,Array.isArray(object)&&/^\d+$/.test(key)?Number(key):key]),
   set:(object,key,value)=>{
    if(typeof key!=='string'||['__proto__','constructor','prototype'].includes(key))throw Error('QUALIFICATION_JOURNAL_PATH_INVALID');
    const next=[...path,Array.isArray(object)&&/^\d+$/.test(key)?Number(key):key],unwrapped=value&&typeof value==='object'?raw.get(value)??value:value;
    Reflect.set(object,key,unwrapped);
    if(!internal&&JSON.stringify(next)!=='["resources","outputBytes"]'){
     if(value===undefined)changes.push([next]);else changes.push([next,clean(unwrapped)]);
    }return true;
   },
   deleteProperty:(object,key)=>{if(typeof key!=='string')throw Error('QUALIFICATION_JOURNAL_PATH_INVALID');
    Reflect.deleteProperty(object,key);changes.push([[...path,key]]);return true;},
  });paths.set(identity,proxy);raw.set(proxy,target);return proxy;
 };
 const state=tracked(original,[]) as T;
 return {state,
  save:async(externalBytes=0,finalizing=false)=>{
   if(closed)throw Error('QUALIFICATION_JOURNAL_CLOSED');
   const before={...descriptor!.codec},frame=encodeQualificationJournalRecord({changes,externalBytes},descriptor!.codec);
   if(state.resources.outputBytes+externalBytes+frame.length+(finalizing?0:65536)>maxOutputBytes){descriptor!.codec=before;throw Error('ORIGINAL_AGGREGATE_OUTPUT_BOUND');}
   try{await file.writeFile(frame);await file.sync();}catch(error){closed=true;await file.close();throw error;}
   internal=true;state.resources.outputBytes+=externalBytes+frame.length;internal=false;changes.length=0;
  },
  close:async()=>{if(!closed){closed=true;await file.close();}},
  seal:()=>({journal:basename(descriptor!.journal),records:descriptor!.codec.sequence,
   finalChainDigest128:descriptor!.codec.previous.toString('hex'),outputBytes:state.resources.outputBytes}),
 };
}
