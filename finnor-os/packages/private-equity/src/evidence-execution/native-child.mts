/** Fixed trusted native entry point. No generated source, eval, SQL, credentials,
 * network tool or user-supplied executable exists in this protocol. */
import {DerivationProgramSchema} from '@finnor/shared-types';
import {runNativeProgram} from './operators';
let text='',bytes=0;
for await(const chunk of process.stdin){bytes+=Buffer.byteLength(chunk);if(bytes>8388608){process.stdout.write(JSON.stringify({ok:false,predicate:'NATIVE_INPUT_BOUND'}));process.exit(0);}text+=chunk;}
try{const request=JSON.parse(text);let data:unknown;
 if(request.mode==='program'){request.payload.program=DerivationProgramSchema.parse(request.payload.program);data=runNativeProgram(request.payload);}
 else if(request.mode==='document')data=await (await import('./documents-parser')).parseDocumentPayload(request.payload);
 else throw Error('UNSUPPORTED_NATIVE_MODE');
 const usage=process.resourceUsage();process.stdout.write(JSON.stringify({ok:true,data,usage:{cpuMicros:usage.userCPUTime+usage.systemCPUTime,peakRSSBytes:usage.maxRSS*1024}}));
}catch(error){const predicate=String((error as Error).message).match(/^[A-Z][A-Z0-9_]{0,159}$/)?.[0]??'NATIVE_INPUT_OR_INTERPRETATION_UNSUPPORTED';process.stdout.write(JSON.stringify({ok:false,predicate,usage:{cpuMicros:process.resourceUsage().userCPUTime+process.resourceUsage().systemCPUTime,peakRSSBytes:process.resourceUsage().maxRSS*1024}}));}
