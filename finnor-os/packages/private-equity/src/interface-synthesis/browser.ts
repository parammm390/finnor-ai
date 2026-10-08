/** Ordinary no-credential browser boundary, not protected S6 dispatch authority. */
import type {Page,Route} from 'playwright';
import {canonical,hash,type Operation} from './contracts';
import type {PracticePort} from './runtime';
export interface UiWireBinding {url:string;body:string;revision:string;operationId:string}
export interface UiGuard {
 violations:Array<{code:string;requestDigest:string}>;
 arm:(binding:UiWireBinding)=>void;
 disarm:()=>void;
 dispose:()=>Promise<void>;
}
const guards=new WeakMap<Page,UiGuard>();
export function existingUiGuard(page:Page){return guards.get(page);}
export async function guardUiPage(page:Page,port:PracticePort,operation:Operation,navigationPath:string,onRefused:(body:unknown)=>Promise<void>):Promise<UiGuard>{
 const existing=guards.get(page);if(existing)return existing;
 let binding:UiWireBinding|null=null,sent=false,reads=0;
 const violations:UiGuard['violations']=[];
 const refuse=async(route:Route,code:string)=>{
  const request=route.request(),event={code,requestDigest:hash({method:request.method(),url:request.url(),body:request.postData()})};
  violations.push(event);
  try{await onRefused(event);}finally{
   // A local rejection response crosses no network boundary. It also lets a
   // page report refusal without manufacturing a transport-loss outcome.
   if(new URL(request.url()).origin===port.origin)await route.fulfill({status:403,contentType:'application/json',body:'{"code":"P5_UI_EGRESS_REFUSED"}'});
   else await route.abort('blockedbyclient');
  }
 };
 const handler=async(route:Route)=>{
  const request=route.request(),url=new URL(request.url());
  if(url.origin!==port.origin||url.username||url.password||url.search||!await port.authorize())return refuse(route,'P5_UI_ORIGIN_OR_CURRENT_ACCESS_REFUSED');
  const headers=request.headers();
  if(headers.authorization||headers.cookie)return refuse(route,'P5_UI_CREDENTIAL_INPUT_REFUSED');
  if(request.method()==='GET'){
   if(++reads>16||url.pathname!==navigationPath)return refuse(route,'P5_UI_DISCOVERY_RESOURCE_REFUSED');
   return route.continue();
  }
  if(request.method()!=='PATCH'||!binding||sent)return refuse(route,'P5_UI_UNRECORDED_OR_DUPLICATE_MUTATION_REFUSED');
  let actual:unknown,expected:unknown;
  try{actual=JSON.parse(request.postData()??'');expected=JSON.parse(binding.body);}catch{return refuse(route,'P5_UI_REQUEST_JSON_REFUSED');}
  if(url.toString()!==binding.url||canonical(actual)!==canonical(expected)||headers['if-match']!==binding.revision||headers['x-operation-id']!==binding.operationId||
   binding.operationId!==operation.operationId||!headers['content-type']?.startsWith('application/json'))return refuse(route,'P5_UI_EXACT_REQUEST_SUBSTITUTION_REFUSED');
  // Set before allowing the route so concurrent requests cannot share the grant.
  sent=true;return route.continue();
 };
 await page.context().route('**/*',handler);
 await page.context().routeWebSocket('**/*',socket=>socket.close());
 const guard:UiGuard={violations,arm:value=>{binding=value;},disarm:()=>{binding=null;},
  dispose:async()=>{binding=null;await page.context().unroute('**/*',handler);guards.delete(page);}};
 guards.set(page,guard);return guard;
}
