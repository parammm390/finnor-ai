/** Controlled loopback protocol fixture for the existing AWS SDK secret reader.
 * Never contacts AWS, supplies live credentials, or claims managed-cloud proof. */
import {createServer} from 'node:http';
import {strict as assert} from 'node:assert';

export async function localManagedSecrets(values:Record<string,string>){
 const observed:string[]=[];
 const server=createServer(async(req,res)=>{
  res.setHeader('content-type','application/x-amz-json-1.1');
  try{
   assert.equal(req.method,'POST');assert.equal(req.headers['x-amz-target'],'secretsmanager.GetSecretValue');
   assert(String(req.headers.authorization).startsWith('AWS4-HMAC-SHA256 Credential=disposable-fixture-key/'));
   let body='';for await(const chunk of req){body+=chunk;assert(body.length<4096);}
   const input=JSON.parse(body),name=String(input.SecretId??'').replace(/^fixture\//,'');
   assert(input.SecretId==='fixture/'+name&&Object.hasOwn(values,name));
   observed.push(name);
   res.end(JSON.stringify({Name:input.SecretId,VersionId:'00000000-0000-4000-8000-000000000001',SecretString:JSON.stringify({[name]:values[name]}),VersionStages:['AWSCURRENT']}));
  }catch{res.writeHead(403);res.end('{"__type":"AccessDeniedException","message":"Controlled fixture scope denied"}');}
 });
 await new Promise<void>((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',yes);});
 const address=server.address();assert(address&&typeof address!=='string');
 return {
  environment:{SECRETS_PROVIDER:'aws-secrets-manager',FINNOR_SECRET_IDS:JSON.stringify(Object.fromEntries(Object.keys(values).map(name=>[name,'fixture/'+name]))),
   AWS_ENDPOINT_URL_SECRETS_MANAGER:'http://127.0.0.1:'+address.port,AWS_ACCESS_KEY_ID:'disposable-fixture-key',AWS_SECRET_ACCESS_KEY:'disposable-fixture-signing-only',
   AWS_REGION:'us-east-1',AWS_EC2_METADATA_DISABLED:'true'},
  observed,
  qualification:'ACTUAL_SDK_CONTROLLED_LOOPBACK_PROTOCOL_NOT_AWS_HOSTED_SECRETS_OR_SELECTED_REGION_PROOF',
  close:async()=>{server.closeAllConnections();await new Promise<void>(yes=>server.close(()=>yes()));},
 };
}
