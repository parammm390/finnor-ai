/** Pre-exposure owner state and independent entity ledger. This fixture uses
 * canonical creators, not direct lifecycle row inserts or producer outputs. */
import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { withTenantTransaction } from '@finnor/db';
import { createEvidenceSourceTx,appendEvidenceVersionTx } from '@finnor/memory';
import { createDocument,appendDocumentVersion } from '@finnor/data-platform';
import { createFund,createVehicle,linkFundVehicle,createDebtFacility,createMetricSeries,
  createInvestmentCase,recordDecision,createRequest,createFinding,grantInstitutionSubjectConsent,
  type PeMutationContext } from '@finnor/private-equity';
import type { OwnerSource } from './owner-source-corpus.mts';

export type ExpectedOwnerMapping={sourceId:string;recordId:string;canonicalId:string;nativeType:string;kind:string};
export async function canonicalOwnerSources(input:{ctx:PeMutationContext;admin:Client;institutionId:string;
  workId:string;dealId:string;companyId:string;organizationKey:string;workstreamId:string;
  requestedFromDealPartyId:string;occurredAt:string;availableAt:string}){
  const {ctx,admin,institutionId,workId,dealId,companyId,workstreamId,requestedFromDealPartyId}=input;
  const tenant=ctx.auth.tenantId,actor=ctx.auth.userId;
  const sourceSystem=ctx.provenance?.sourceSystem;
  if(!sourceSystem)throw Error('ORIGINAL_OWNER_PROVENANCE_REQUIRED');
  const validFrom=new Date(input.occurredAt),expiresAt=new Date(Date.now()+3600000);
  const evidence=await withTenantTransaction(tenant,{userId:actor},async db=>{
    const source=await createEvidenceSourceTx(db,tenant,{sourceKey:'x1-owner-identities:'+randomUUID(),
      sourceType:'independent_owner_identity_fixture',title:'Existing canonical owner registration evidence'});
    const version=await appendEvidenceVersionTx(db,tenant,source.id,{content:'Owner fixture identities, not approval or effect authority',
      snapshot:{institutionId,qualification:'DISPOSABLE_OWNER_STATE_BEFORE_EXPOSURE'},asOf:validFrom,retrievedAt:new Date()});
    return {evidenceSourceId:source.id,evidenceVersionId:version.versionId};
  });
  const sourceId='canonical-owner-original',personSourceId='person-owner-original';
  const rows:Array<Record<string,unknown>>=[],expected:ExpectedOwnerMapping[]=[];
  const registration=(prefix:string)=>prefix+'-'+randomUUID();
  const ownerContext=(registrationId:string):PeMutationContext=>({...ctx,provenance:{...ctx.provenance,externalId:registrationId}});
  const add=(recordId:string,kind:string,nativeType:string,registrationId:string,id:string,source=sourceId)=>{
    const record={id:recordId,kind:'entity',entityType:kind,registrationId};
    if(source===sourceId)rows.push(record);
    expected.push({sourceId:source,recordId,canonicalId:id,nativeType,kind});return record;
  };
  const funds=[],vehicles=[];
  for(let i=0;i<2;i++){
    const fundRegistration=registration('FUND'),vehicleRegistration=registration('VEHICLE');
    const fund=await createFund(ownerContext(fundRegistration),{name:'Shared fund name',baseCurrency:'USD',status:'active'});
    const vehicle=await createVehicle(ownerContext(vehicleRegistration),{name:'Shared vehicle name',vehicleType:'main',status:'active'});
    funds.push(String(fund.row.id));vehicles.push(String(vehicle.row.id));
    add('fund-'+i,'fund','pe_fund',fundRegistration,String(fund.row.id));
    add('vehicle-'+i,'vehicle','pe_vehicle',vehicleRegistration,String(vehicle.row.id));
  }
  const relationRegistration=registration('LINK');
  const relation=await linkFundVehicle(ownerContext(relationRegistration),{fundId:funds[0]!,vehicleId:vehicles[0]!,
    relationshipKind:'master',validFrom,evidence});
  add('relationship-A','relationship','pe_fund_vehicle_link',relationRegistration,String(relation.row.id));
  const investmentRegistration=registration('CASE');
  const investment=await createInvestmentCase(ownerContext(investmentRegistration),{dealId,title:'Evidence readiness case'});
  add('investment-A','investment_case','pe_investment_case',investmentRegistration,String(investment.row.id));
  const decisionRegistration=registration('DECISION');
  const decision=await recordDecision(ownerContext(decisionRegistration),{dealId,investmentCaseId:String(investment.row.id),
    decisionType:'readiness_review',title:'Pending readiness review',decision:'Draft record; no approval issued'});
  add('decision-A','decision','pe_decision',decisionRegistration,String(decision.row.id));
  const metricRegistration=registration('METRIC');
  const metric=await createMetricSeries(ownerContext(metricRegistration),{subjectType:'external_organization',subjectId:companyId,
    metricKey:'evidence_progress',name:'Evidence progress',unit:'count',frequency:'event'});
  add('metric-A','metric','pe_metric_series',metricRegistration,String(metric.row.id));
  const facilityRegistration=registration('FACILITY');
  const facility=await createDebtFacility(ownerContext(facilityRegistration),{borrowerCompanyId:companyId,
    facilityKey:facilityRegistration,name:'Transaction diligence facility',facilityType:'term_loan',
    committedAmount:'100.00',currencyCode:'USD',validFrom,evidence});
  add('facility-A','facility','pe_debt_facility',facilityRegistration,String(facility.row.id));
  const existingRequestRegistration=registration('REQUEST');
  const existingRequest=await createRequest(ownerContext(existingRequestRegistration),{dealId,workstreamId,
    requestedFromDealPartyId,owner:{partyType:'employee',partyId:actor},requestText:'Preexisting canonical request; excluded from new effect credit',
    requestedAt:validFrom,requiresAcceptedDeliverable:false});
  add('existing-request-A','request','pe_request',existingRequestRegistration,String(existingRequest.row.id));
  const findingRegistration=registration('FINDING');
  const finding=await createFinding(ownerContext(findingRegistration),{dealId,workstreamId,owner:{partyType:'employee',partyId:actor},
    statement:'Existing evidence gap',severity:'low',materiality:'non_material',requiredForWorkstreamCompletion:false});
  add('finding-A','finding','pe_finding',findingRegistration,String(finding.row.id));
  const documentRegistration=registration('DOCUMENT');
  const document=await withTenantTransaction(tenant,{userId:actor},async db=>{
    const doc=await createDocument(db,{tenantId:tenant,kind:'evidence',title:'Owner retained reference document',
      provenance:{sourceSystem,externalId:documentRegistration,createdBy:actor}});
    await appendDocumentVersion(db,{tenantId:tenant,documentId:doc.documentId,bytes:Buffer.from('Existing owner document identity'),
      mediaType:'text/plain',format:'unknown',origin:'manual_upload',actor,sourceSystem,
      sourceRef:documentRegistration,providerVersionId:'owner-v1'});
    return doc;
  });
  add('document-A','document','document',documentRegistration,document.documentId);
  add('counterparty-A','counterparty','external_organization',input.organizationKey,companyId);
  add('work-A','work','work',workId,workId);
  const personRegistration=registration('EMPLOYEE');
  await admin.query(`INSERT INTO finnor_os.x1_subject_identity_bindings
    (tenant_id,institution_id,source_id,registration_id,subject_user_id,evidence_source_id,evidence_version_id,valid_from,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[tenant,institutionId,personSourceId,personRegistration,actor,
    evidence.evidenceSourceId,evidence.evidenceVersionId,validFrom,expiresAt]);
  await grantInstitutionSubjectConsent(ctx,{institutionId,sourceClass:'personnel_benefits',
    purpose:'standing evidence responsibility',expiresAt});
  const person=add('person-A','person','user',personRegistration,actor,personSourceId);
  const sources:OwnerSource[]=[{id:sourceId,sourceClass:'crm_deals',rows},
    {id:personSourceId,sourceClass:'personnel_benefits',rows:[person]}];
  return {sources,expected,evidence,existingRequestId:String(existingRequest.row.id),funds,vehicles,
    fixturesArePreexistingOwnerState:true};
}
