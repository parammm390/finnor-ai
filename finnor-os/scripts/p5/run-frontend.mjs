import {readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {resolve,join} from 'node:path';
const [environmentFile,port]=process.argv.slice(2);
if(!environmentFile?.startsWith('/')||!/^[0-9]{4,5}$/.test(port??''))throw Error('ABSOLUTE_OWNED_FRONTEND_ENV_AND_PORT_REQUIRED');
const vars=JSON.parse(await readFile(environmentFile,'utf8'));
if(Object.keys(vars).sort().join(',')!=='NEXT_PUBLIC_OS_API_URL,NEXT_PUBLIC_SUPABASE_ANON_KEY,NEXT_PUBLIC_SUPABASE_URL'||
 !/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(vars.NEXT_PUBLIC_OS_API_URL)||!/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(vars.NEXT_PUBLIC_SUPABASE_URL)||
 vars.NEXT_PUBLIC_SUPABASE_ANON_KEY!=='disposable-local-auth')throw Error('OWNED_DISPOSABLE_ENV_REQUIRED');
const root=resolve(import.meta.dirname,'../../..');
const child=spawn(process.execPath,[join(root,'node_modules/next/dist/bin/next'),'dev','--webpack','--hostname','127.0.0.1','--port',port],
 {cwd:root,env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,NODE_ENV:'development',NEXT_TELEMETRY_DISABLED:'1',...vars},stdio:'inherit',detached:true});
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{
 try{process.kill(-child.pid,signal);}catch(error){if(error.code!=='ESRCH')throw error;}
});
child.once('exit',code=>{process.exitCode=code??1;});
