import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, lstatSync, realpathSync, readlinkSync, openSync, readSync, fstatSync, closeSync, constants } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Copied into the installed package beside its fixed manifest. No environment
// variable or builder CWD can select another frontend's bytes or custody root.
const root=realpathSync(dirname(fileURLToPath(import.meta.url))),manifestPath=join(root,'x1-frontend-installation.json');
const manifestStat=lstatSync(manifestPath);
if(!manifestStat.isFile()||(manifestStat.mode&0o7777)!==0o444)throw Error('X1_FRONTEND_MANIFEST_CUSTODY_REFUSED');
const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
if(manifest.schema!=='finnor.x1.frontend-installation.v1'||manifest.mode!=='DEVELOPMENT_ONLY'
  ||manifest.productionActive!==false||manifest.executionAuthorityGranted!==false
  ||manifest.runtime.node!==process.version||manifest.runtime.platform!==process.platform||manifest.runtime.arch!==process.arch)
  throw Error('X1_FRONTEND_INSTALLATION_CONTRACT_REFUSED');
const args=process.argv.slice(2);
if(args.length!==4||args[0]!=='--api-origin'||args[2]!=='--auth-origin')throw Error('X1_FRONTEND_LOCAL_OWNER_ORIGINS_REQUIRED');
function loopback(value){const url=new URL(value);
  if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||url.pathname!=='/'||url.search||url.hash||url.username||url.password)
    throw Error('X1_FRONTEND_LOCAL_OWNER_ORIGINS_REQUIRED');return url.origin;
}
const apiOrigin=loopback(args[1]),authOrigin=loopback(args[3]),frontendOrigin=loopback(manifest.frontendOrigin);
const measured=new Map(),buffer=Buffer.allocUnsafe(1024*1024);
const metadata=s=>[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs,s.mode].join(':');
function hash(path){const s=lstatSync(path,{bigint:true});if(!s.isFile())throw Error('X1_FRONTEND_FILE_CUSTODY_REFUSED');
  const key=metadata(s),prior=measured.get(path);if(prior?.metadata===key)return prior.sha256;
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW),h=createHash('sha256');let bytes=0n,count;
  try{if(metadata(fstatSync(fd,{bigint:true}))!==key)throw Error('X1_FRONTEND_FILE_RACED');
    while((count=readSync(fd,buffer,0,buffer.length,null))){h.update(buffer.subarray(0,count));bytes+=BigInt(count);}
    if(bytes!==s.size||metadata(fstatSync(fd,{bigint:true}))!==key)throw Error('X1_FRONTEND_FILE_RACED');
  }finally{closeSync(fd);}const sha256=h.digest('hex');measured.set(path,{metadata:key,sha256});return sha256;
}
const manifestDigest=hash(manifestPath);
function pathInRoot(relative){
  if(typeof relative!=='string'||relative.startsWith('/')||relative.includes('\\')||relative.split('/').some(p=>!p||p==='.'||p==='..'))
    throw Error('X1_FRONTEND_PATH_REFUSED');return join(root,relative);
}
function verify(){
  const s=lstatSync(manifestPath);if(!s.isFile()||(s.mode&0o7777)!==0o444||hash(manifestPath)!==manifestDigest)
    throw Error('X1_FRONTEND_MANIFEST_CHANGED');
  if(hash(realpathSync(process.execPath))!==manifest.runtime.nodeBinarySha256)throw Error('X1_FRONTEND_NODE_CHANGED');
  const directories=new Set();
  for(const pin of manifest.files){let parent=dirname(pathInRoot(pin.path));while(parent!==root){directories.add(parent);parent=dirname(parent);}}
  for(const path of directories)if(!lstatSync(path).isDirectory())throw Error('X1_FRONTEND_DIRECTORY_CHANGED');
  for(const link of manifest.links){const path=pathInRoot(link.path);
    if(!lstatSync(path).isSymbolicLink()||readlinkSync(path)!==link.target||!realpathSync(path).startsWith(root+sep))
      throw Error('X1_FRONTEND_LINK_CHANGED');}
  for(const pin of manifest.files){const path=pathInRoot(pin.path),s=lstatSync(path);
    if(!s.isFile()||s.size!==pin.bytes||(s.mode&0o7777)!==pin.mode||hash(path)!==pin.sha256)
      throw Error('X1_FRONTEND_BYTE_OR_MODE_CHANGED:'+pin.path);}
}
verify();
const nextPort=await new Promise((yes,no)=>{const s=createServer();s.once('error',no);
  s.listen(0,'127.0.0.1',()=>{const address=s.address();s.close(()=>yes(address.port));});});
const child=spawn(process.execPath,['--max-old-space-size=1536',pathInRoot(manifest.entrypoint)],{
  cwd:dirname(pathInRoot(manifest.entrypoint)),stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH,
    NODE_ENV:'production',NODE_OPTIONS:'',HOSTNAME:'127.0.0.1',PORT:String(nextPort),NEXT_TELEMETRY_DISABLED:'1',
    FINNOR_OS_API_URL:apiOrigin,CENTROPY_TEST_MODE:'0',NEXT_PUBLIC_CENTROPY_TEST_MODE:'0'}});
child.stdout.on('data',bytes=>process.stderr.write(bytes));child.stderr.on('data',bytes=>process.stderr.write(bytes));
let ready=false;for(let i=0;i<100;i++){
  if(child.exitCode!==null||child.signalCode!==null)throw Error('X1_FRONTEND_NEXT_STARTUP_FAILED');
  try{const response=await fetch('http://127.0.0.1:'+nextPort+'/centropy',{redirect:'manual'});
    await response.arrayBuffer();if(response.status<500){ready=true;break;}}
  catch{/* Actual compiled server is still starting. */}
  await new Promise(yes=>setTimeout(yes,100));
}
if(!ready){child.kill('SIGTERM');throw Error('X1_FRONTEND_NEXT_STARTUP_BOUND');}
const server=createServer(async(req,res)=>{
  try{verify();const url=new URL(req.url,frontendOrigin),auth=url.pathname.startsWith('/auth/v1/');
    let body='';for await(const bytes of req){body+=bytes;if(Buffer.byteLength(body)>8388608)throw Error('X1_FRONTEND_BODY_BOUND');}
    const headers=new Headers();for(const [name,value]of Object.entries(req.headers))
      if(typeof value==='string'&&!['host','connection','content-length','accept-encoding'].includes(name))headers.set(name,value);
    const target=(auth?authOrigin:'http://127.0.0.1:'+nextPort)+url.pathname+url.search;
    const response=await fetch(target,{method:req.method,headers,redirect:'manual',
      ...(!['GET','HEAD'].includes(req.method)?{body}:{}),signal:AbortSignal.timeout(30000)});
    const out={};response.headers.forEach((value,key)=>{if(!['content-encoding','content-length','transfer-encoding','connection'].includes(key))out[key]=value;});
    res.writeHead(response.status,out);res.end(Buffer.from(await response.arrayBuffer()));
  }catch(error){console.error(JSON.stringify({event:'X1_FRONTEND_REFUSAL',predicate:error.message}));
    res.writeHead(503,{'content-type':'application/json','cache-control':'no-store'});res.end('{"error":"frontend_unavailable"}');}
});
await new Promise((yes,no)=>{server.once('error',no);server.listen(Number(new URL(frontendOrigin).port),'127.0.0.1',yes);});
console.log(JSON.stringify({event:'X1_FRONTEND_READY',frontendOrigin,compiled:true,nextPid:child.pid,
  manifestDigest,source:manifest.source,authBypass:false,productionActive:false}));
let stopping=false;
function stop(){if(stopping)return;stopping=true;server.closeAllConnections();server.close();child.kill('SIGTERM');
  setTimeout(()=>{if(child.exitCode===null)child.kill('SIGKILL');process.exit(0);},5000).unref();}
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,stop);
child.once('exit',()=>{server.close();if(!stopping)process.exit(1);});
