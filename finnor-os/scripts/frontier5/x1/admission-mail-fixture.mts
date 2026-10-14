/** Original mail transport fixture. It supplies raw MIME, never a mapping,
 * checker receipt, business outcome or protected Microsoft/AWS authority. */
import {createServer} from 'node:http';
import {randomUUID,createHash,randomBytes} from 'node:crypto';
import {applicationAccounts,authProfiles,tenantIntegrations,integrationSourceScopes,withTenant} from '@finnor/db';
import {setMicrosoftIdentityTestOverrides,clearMicrosoftGraphTokenCache} from '@finnor/provider-microsoft365';
import type pg from 'pg';
import type {PeMutationContext} from '../../../packages/private-equity/src/types';
export async function admissionMailFixture(input:{ctx:PeMutationContext;admin:pg.Client;workId:string;institutionId:string;
 registrationA:string;occurredAt:string;save:(name:string,value:unknown)=>Promise<unknown>}){
 const {ctx,admin}=input,tenant=ctx.auth.tenantId,integrationId=randomUUID(),applicationAccountId=randomUUID(),authProfileId=randomUUID();
 const mailbox='x1-local-mailbox',folder='x1-local-folder',externalId='x1-original-message',scope='mail:x1-local-mailbox:x1-local-folder';
 const bytes=Buffer.from(`Message-ID: <mail-A@test.invalid>\r\nFrom: analyst@test.invalid\r\nTo: desk@test.invalid\r\nDate: ${new Date(input.occurredAt).toUTCString()}\r\nSubject: Original registration assertion\r\nX-Institution-Entity-Type: deal\r\nX-Institution-Registration-ID: ${input.registrationA}\r\n\r\nThis is evidence about registration ${input.registrationA}; it grants no approval or action authority.\r\n`);
 const token=randomBytes(24).toString('hex'),calls:any[]=[];
 const server=createServer((request,response)=>{
  const url=new URL(request.url!,'http://fixture.invalid');calls.push({at:new Date().toISOString(),method:request.method,path:url.pathname});
  if(url.pathname==='/token'){response.setHeader('content-type','application/json');response.end(JSON.stringify({access_token:token,expires_in:3600}));return;}
  if(request.headers.authorization!=='Bearer '+token){response.writeHead(401).end();return;}
  if(url.pathname===`/v1.0/users/${mailbox}/messages/${externalId}/$value`){response.setHeader('content-type','message/rfc822');response.end(bytes);return;}
  if(url.pathname===`/v1.0/users/${mailbox}/messages/${externalId}`){response.setHeader('content-type','application/json');response.end(JSON.stringify({id:externalId,parentFolderId:folder,changeKey:'r1'}));return;}
  response.writeHead(404).end();
 });
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 const address=server.address();if(!address||typeof address==='string')throw Error('LOCAL_SOURCE_PORT_REQUIRED');
 const origin='http://127.0.0.1:'+address.port,fetchOriginal=globalThis.fetch;
 try{
  await withTenant(tenant,async db=>{
   await db.insert(applicationAccounts).values({id:applicationAccountId,tenantId:tenant,accountKey:'x1-local-original-mail',application:'microsoft365',provider:'microsoft_graph',displayName:'Development original-mail transport only',providerAccountRef:randomUUID(),capabilities:['private_equity_source'],metadata:{directoryTenantId:randomUUID(),applicationClientId:randomUUID(),cloud:'global'}});
   await db.insert(authProfiles).values({id:authProfileId,tenantId:tenant,authProfileRef:'x1-local-original-mail',principalType:'tenant',principalId:tenant,applicationAccountId,purpose:'private-equity-source',scope:{awsRegion:process.env.AWS_REGION??process.env.AWS_DEFAULT_REGION??'local-transport-fixture-only',federationAudience:'api://AzureADTokenExchange',federationConfigId:'local-transport-no-external-authority',signingAlgorithm:'ES384',identityTokenDurationSeconds:300},credentialProvider:'aws-iam-federated',authMethod:'workload_identity',connectionStatus:'active',requiredScopes:['Mail.Read'],grantedScopes:['Mail.Read'],restrictions:{exchangeApplicationRbac:true}});
   await db.insert(tenantIntegrations).values({id:integrationId,tenantId:tenant,capability:'private_equity_source',binding:'microsoft_graph',mode:'real',applicationAccountId,authProfileId,config:{developmentTransportFixture:true,externalProviderAuthority:false}});
   await db.insert(integrationSourceScopes).values({id:randomUUID(),tenantId:tenant,integrationId,provider:'microsoft_graph',sourceKind:'outlook_mail_folder',providerScopeType:'mail_folder',providerResourceId:mailbox+'/'+folder,scopeKey:scope,syncStrategy:'delta',recoveryStrategy:'EXACT_DELTA',permissionMode:'SCOPED',requiredPermissions:['Mail.Read'],effectivePermissions:['Mail.Read'],providerRestrictionMethod:'Local fixture original bytes only',permissionVerifiedAt:new Date(),coveragePolicy:{mailboxId:mailbox,folderId:folder},freshnessPolicy:{recoveryCadenceMinutes:15,maxAgeSeconds:900},configuration:{mailboxId:mailbox,folderId:folder},configuredBy:ctx.auth.userId});
  });
  await admin.query(`INSERT INTO finnor_os.compute_resource_policies(resource_key,capacity,per_tenant_capacity,interactive_reserve,lease_seconds,source)
   VALUES('provider:microsoft-graph',1,1,0,60,'Local original-source transport fixture; no external authority or effect') ON CONFLICT DO NOTHING`);
  const grantId=randomUUID();
  await admin.query(`INSERT INTO finnor_os.x1_source_grants(id,tenant_id,principal_id,work_id,institution_id,source_id,source_class,purpose,
   acquisition_kind,integration_id,provider,adapter_scope,external_object_type,external_id,protocol,revision,original_sha256,expected_object_ids,valid_from,expires_at)
   VALUES($1,$2,$3,$4,$5,'mail-original','email','standing evidence responsibility','installed_adapter',$6,'microsoft_graph',$7,'message',$8,'rfc822','r1',$9,'["mail-A"]'::jsonb,clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 hour')`,
   [grantId,tenant,ctx.auth.userId,input.workId,input.institutionId,integrationId,scope,externalId,createHash('sha256').update(bytes).digest('hex')]);
  globalThis.fetch=((request,options)=>{const url=new URL(request instanceof Request?request.url:String(request));return fetchOriginal(url.hostname==='graph.microsoft.com'?origin+url.pathname+url.search:request,options);}) as typeof fetch;
  setMicrosoftIdentityTestOverrides({stsSender:async()=> 'LOCAL_TRANSPORT_FIXTURE_NO_EXTERNAL_IDENTITY',fetch:async()=>fetchOriginal(origin+'/token')});
  await input.save('admission-mail-original-input.json',{grantId,integrationId,rawUtf8:bytes.toString('utf8'),originalSha256:createHash('sha256').update(bytes).digest('hex'),
   boundary:'LOCAL_STATEFUL_AUTHENTICATED_HTTP_ORIGINAL_BYTE_TRANSPORT_THROUGH_EXISTING_TEST_IDENTITY_SEAM',externalMicrosoftOrAwsAuthority:false,canonicalMappingSupplied:false,businessOutcomeSupplied:false});
  return {grantId,close:async()=>{globalThis.fetch=fetchOriginal;setMicrosoftIdentityTestOverrides({stsSender:null,fetch:null});clearMicrosoftGraphTokenCache();await input.save('admission-mail-physical-transport.json',{calls,externalProviderQualification:false});await new Promise<void>(resolve=>server.close(()=>resolve()));}};
 }catch(error){globalThis.fetch=fetchOriginal;setMicrosoftIdentityTestOverrides({stsSender:null,fetch:null});await new Promise<void>(resolve=>server.close(()=>resolve()));throw error;}
}
