import {resolve} from 'node:path';
import {daytonaProtocolFixture} from './daytona-protocol-fixture.mts';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
const evidence=process.env.FINNOR_P1_EVIDENCE_DIR;if(!evidence)throw Error('EXTERNAL_EVIDENCE_DIRECTORY_REQUIRED');
const fixture=await daytonaProtocolFixture(resolve(evidence));
Object.assign(process.env,fixture.environment,{FINNOR_P1_CASE_FILTER:'daytona-source-bound-analysis',FINNOR_P1_RUN_PROFILE:'production_analysis'});
try{await import('./run-program-e2e.mts');}finally{await fixture.close();}
// The importing driver owns provider teardown and the final scored exit.
const result=JSON.parse(await readFile(join(evidence,'results.json'),'utf8'));
process.exit(result.results.some((r:any)=>r.status==='FAIL')?1:0);
