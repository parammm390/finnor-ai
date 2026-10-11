import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
const child=spawn(process.execPath,['--import=tsx',fileURLToPath(new URL('./run-owner.mts',import.meta.url)),'--browser'],{
  cwd:root,env:{...process.env,FINNOR_R7_CASE_FILTER:'mounted-capital-work'},stdio:'inherit',
});
const timer=setTimeout(()=>child.kill('SIGTERM'),1200000);
child.once('exit',(code,signal)=>{clearTimeout(timer);process.exitCode=signal?1:code??1;});
