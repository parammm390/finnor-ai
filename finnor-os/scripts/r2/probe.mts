import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {table,caps} from './fixtures.mts';
import {R2NativeSession,loadR2Runtime} from '../../packages/private-equity/src/capital-program/r2-native';
import {inM3Episode} from '../../packages/private-equity/src/capital-program/v2-budget';
import {encodeR2Master,decodeR2Policy} from '../../packages/epistemic-runtime/src/r2-encoding';
const out=resolve(process.argv[2]!);await mkdir(out,{recursive:true,mode:0o700});
await inM3Episode(30000,async()=>{
 const original=table(),session=new R2NativeSession(await loadR2Runtime(),out,Date.now()+28000,caps,async()=>{});
 try{const family=await session.build(original),encoding=encodeR2Master(original,family,['A'],caps);await writeFile(out+'/encoding.json',JSON.stringify(encoding));
 console.log(await session.check(original,'encoding',{encoding}));const solved=await session.solve(encoding,0);console.log(solved);
 console.log(await session.check(original,'proof',{encoding,proofPath:solved.proofPath}));
 console.log(await session.check(original,'policy',{policy:decodeR2Policy(encoding,solved.solution!)}));}
 finally{await session.cancel();await writeFile(out+'/physical.json',JSON.stringify(session.receipts));}
});
