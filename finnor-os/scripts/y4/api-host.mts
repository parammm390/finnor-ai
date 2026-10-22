/** Loopback transport for the actual emitted Company Brain route. Not a
 * replacement business handler, hosted auth provider or deployed Next server. */
import {createServer} from 'node:http';
import {POST} from '../../apps/api/app/api/company-brain/[operation]/route';
import {GET as readMe} from '../../apps/api/app/api/me/route';
import {GET as readWork} from '../../apps/api/app/api/works/[id]/route';
import {GET as readUnderwritingRun} from '../../apps/api/app/api/underwriting/runs/[id]/route';
import {POST as liveControl} from '../../apps/api/app/api/live-controls/route';
import {POST as interventions} from '../../apps/api/app/api/interventions/[operation]/route';
import {POST as policies} from '../../apps/api/app/api/policies/[operation]/route';
import {POST as allocations} from '../../apps/api/app/api/allocations/[operation]/route';
import {POST as obligations} from '../../apps/api/app/api/obligations/[operation]/route';
import {closePool} from '@finnor/db';
import {verifyInstallation} from './installation.mts';
const custody=await verifyInstallation();
const server=createServer(async(req,res)=>{
 try{
  const path=new URL(req.url??'/','http://127.0.0.1').pathname,
   match=/^\/api\/company-brain\/([a-z0-9-]+)$/.exec(path),work=/^\/api\/works\/([a-f0-9-]{36})$/.exec(path),
   run=/^\/api\/underwriting\/runs\/([a-f0-9-]{36})$/.exec(path),
   owner=/^\/api\/(interventions|policies|allocations|obligations)\/([a-z0-9-]+)$/.exec(path);
  if(!(req.method==='POST'&&(match||owner||path==='/api/live-controls')||req.method==='GET'&&(path==='/api/me'||work||run))){res.writeHead(404);res.end('{}');return;}
  let bytes=Buffer.alloc(0);
  for await(const chunk of req){if(bytes.length+chunk.length>1048576)throw Error('Y4_TRANSPORT_BOUND');bytes=Buffer.concat([bytes,chunk]);}
  const headers=new Headers();for(const [k,v] of Object.entries(req.headers))if(typeof v==='string'&&k!=='host')headers.set(k,v);
  const request=new Request('http://127.0.0.1'+req.url,{method:req.method,headers,...(req.method==='POST'?{body:bytes}:{})});
  const handlers:Record<string,typeof policies>={interventions,policies,allocations,obligations};
  const response=req.method==='POST'?(owner?await handlers[owner[1]!]!(request,{params:Promise.resolve({operation:owner[2]!})}):
   path==='/api/live-controls'?await liveControl(request):
   await POST(request,{params:Promise.resolve({operation:match![1]!})})):
   work?await readWork(request,{params:Promise.resolve({id:work[1]!})}):
   run?await readUnderwritingRun(request,{params:Promise.resolve({id:run[1]!})}):await readMe(request);
  const output=Buffer.from(await response.arrayBuffer()),out:Record<string,string>={};response.headers.forEach((v,k)=>{out[k]=v;});
  res.writeHead(response.status,out);res.end(output);
 }catch{if(!res.headersSent)res.writeHead(500,{'content-type':'application/json'});res.end('{"error":"INSTALLED_TRANSPORT_REFUSED"}');}
});
await new Promise<void>((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',yes);});
const address=server.address();if(!address||typeof address==='string')throw Error('Y4_LOOPBACK_REQUIRED');
process.send?.({kind:'READY',origin:'http://127.0.0.1:'+address.port,custody,pid:process.pid,actualEmittedRoute:true,deployedNextServer:false});
const close=async()=>{server.closeAllConnections();await new Promise<void>(yes=>server.close(()=>yes()));await closePool();if(process.connected)process.disconnect();};
process.once('message',(value:any)=>{if(value?.operation==='STOP')void close();});
process.once('SIGTERM',()=>void close());
