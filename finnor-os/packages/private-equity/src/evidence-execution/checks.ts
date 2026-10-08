import type {DerivationProgram,EvidenceHandle,FinancialRow,IndependentCheck} from '@finnor/shared-types';
import type {PeMutationContext} from '../types';
import type {NativeExecution} from './operators';
import type {LoadedSource} from './sources';
import {tx,stable,sha,currentDerivation} from './store';
const cleanDecimal=(s:string)=>{const parts=s.split('.');const f=(parts[1]??'').replace(/0+$/,'');const v=parts[0]+(f?'.'+f:'');return /^-?0$/.test(v)?'0':v;};
/** An independently interpreted PostgreSQL numeric path starts at source fields.
 * Neither the native operation trace nor a native output supplies expectations. */
export async function independentChecks(ctx:PeMutationContext,program:DerivationProgram,inputs:Array<{handle:EvidenceHandle;loaded:LoadedSource}>,native:NativeExecution):Promise<IndependentCheck[]>{return tx(ctx,async c=>{
 const checks:IndependentCheck[]=[],tables=new Map<string,FinancialRow[]>(),scalars=new Map<string,{value:string;semantics:FinancialRow['semantics'];witnessIds:string[]}>(),raw=new Map<string,FinancialRow[]>();
 for(const {handle,loaded} of inputs){let expectedRows=loaded.rows;
  if(handle.source.kind==='metric'){const s=handle.source;const reference=(await c.query<{id:string;value:string}>(`WITH latest AS(
   SELECT DISTINCT ON(entity_type,entity_id) entity_type,entity_id,snapshot FROM finnor_os.canonical_entity_versions
   WHERE tenant_id=$1 AND entity_type IN('pe_metric_series','pe_metric_observation') AND recorded_at<=$2 AND pg_xact_commit_timestamp(xmin)<=$2
   ORDER BY entity_type,entity_id,recorded_at DESC,entity_version DESC
  ),series AS(SELECT entity_id FROM latest WHERE entity_type='pe_metric_series' AND snapshot->>'subject_type'=$3 AND snapshot->>'subject_id'=$4 AND ($5='*' OR snapshot->>'metric_key'=$5)
    AND snapshot->>'unit'=$6 AND snapshot->>'currency_code' IS NOT DISTINCT FROM $7::text AND snapshot->>'frequency'=$8)
   SELECT o.entity_id::text id,o.snapshot->>'value_numeric' value FROM latest o JOIN series s ON s.entity_id::text=o.snapshot->>'metric_series_id'
   WHERE o.entity_type='pe_metric_observation' AND o.snapshot->>'superseded_at' IS NULL AND o.snapshot->>'value_type'='number'
    AND (o.snapshot->>'period_start')::timestamptz=$9 AND (o.snapshot->>'period_end')::timestamptz=$10 ORDER BY o.entity_id`,[ctx.auth.tenantId,handle.knowledgeAt,s.subject.entityType,s.subject.entityId,s.metricKey,s.unit,s.currencyCode,s.frequency,s.periodStart,s.periodEnd])).rows;
   const byId=new Map(loaded.rows.map(r=>[r.recordId,r]));const count=reference.length===loaded.rows.length&&reference.every(r=>byId.has(r.id));checks.push({id:'count:'+handle.inputId,method:'SQL_SOURCE_COUNT',status:count?'PASS':'FAIL',expected:String(reference.length),actual:String(loaded.rows.length),predicate:'full-resolution committed canonical membership equals selected source IDs',witnessIds:loaded.rows.flatMap(r=>r.witnessIds)});
   expectedRows=reference.flatMap(r=>{const original=byId.get(r.id);return original?[{...original,value:cleanDecimal(r.value),fields:{...original.fields,value:cleanDecimal(r.value)}}]:[];});
  }else if(handle.source.kind==='derivation'){
   const parent=await currentDerivation(ctx,handle.source.derivationId),value=parent.result?.outputs[handle.source.output];if(!value||value.kind!=='scalar'||value.value===null)throw Error('PRIOR_MATERIAL_DERIVATION_OUTPUT_UNAVAILABLE');
   const exact=(await c.query<{value:string}>('SELECT $1::numeric::text value',[value.value])).rows[0]!.value;expectedRows=loaded.rows.map(row=>({...row,value:cleanDecimal(exact),fields:{...row.fields,value:cleanDecimal(exact)}}));
  }else if(handle.source.kind==='model'){
   const s=handle.source;const persisted=(await c.query<{value:string}>("SELECT (result#>>$4::text[])::numeric::text value FROM finnor_os.underwriting_runs WHERE tenant_id=$1 AND id=$2 AND model_version_id=$3 AND computed_at<=$5 AND pg_xact_commit_timestamp(xmin)<=$5",[ctx.auth.tenantId,s.runId,s.modelVersionId,['outputs',s.output,'value'],handle.knowledgeAt])).rows[0];if(!persisted)throw Error('MODEL_INDEPENDENT_SOURCE_OUTPUT_UNAVAILABLE');expectedRows=loaded.rows.map(row=>({...row,value:cleanDecimal(persisted.value),fields:{...row.fields,value:cleanDecimal(persisted.value)}}));
  }else{
   expectedRows=[];for(const row of loaded.rows){const material=loaded.witnesses.find(w=>row.witnessIds.includes(w.id));if(!material)continue;const scaled=(await c.query<{value:string}>('SELECT ($1::numeric*$2::numeric*$3::numeric)::text value',[material.rawValue,material.semantics.scale,material.semantics.sign==='NEGATE'?'-1':'1'])).rows[0]!.value;expectedRows.push({...row,value:cleanDecimal(scaled),fields:{...row.fields,value:cleanDecimal(scaled)}});}
  }
  const originalMatch=sha(expectedRows.map(r=>({id:r.recordId,value:r.value})))===sha(loaded.rows.map(r=>({id:r.recordId,value:r.value})));checks.push({id:'raw-fields:'+handle.inputId,method:'POSTGRES_NUMERIC',status:originalMatch?'PASS':'FAIL',expected:sha(expectedRows.map(r=>({id:r.recordId,value:r.value}))),actual:sha(loaded.rows.map(r=>({id:r.recordId,value:r.value}))),predicate:'numeric inputs equal independently read source field/anchor and exact scale/sign',witnessIds:loaded.witnesses.map(w=>w.id)});
  raw.set(handle.inputId,expectedRows);checks.push({id:'coverage:'+handle.inputId,method:'COVERAGE',status:handle.coverage.status==='COMPLETE'&&loaded.coverage.status==='COMPLETE'?'PASS':'FAIL',expected:'COMPLETE',actual:loaded.coverage.status,predicate:'complete declared selected universe; no global enterprise absence certificate',witnessIds:[]});
 }
 for(const node of program.nodes){
  if(node.op==='source'){const sourceRows=raw.get(node.inputId)??[];tables.set(node.id,sourceRows);const normalize=(rows:FinancialRow[])=>rows.map(r=>({...r,witnessIds:[...r.witnessIds].sort()})).sort((a,b)=>stable(a).localeCompare(stable(b)));const expected=sha(normalize(sourceRows)),actual=sha(normalize(native.nodes[node.id]?.rows??[]));checks.push({id:'source-table:'+node.id,method:'SQL_SOURCE_COUNT',status:expected===actual?'PASS':'FAIL',expected,actual,predicate:'independent material source-table rows, dimensions and complete witness union',witnessIds:sourceRows.flatMap(r=>r.witnessIds)});continue;}
  if(node.op==='reconcile'||node.op==='unique'){
   const source=tables.get(node.input)??[];const grouped=(await c.query<{row:FinancialRow;value:string;count:string;witnesses:string[]}>(`SELECT (jsonb_agg(r ORDER BY r->>'recordId')->0) row,min((r->>'value')::numeric)::text value,
     count(DISTINCT (r->>'value')::numeric)::text count,array_agg(DISTINCT w) witnesses
     FROM jsonb_array_elements($1::jsonb) r LEFT JOIN LATERAL jsonb_array_elements_text(r->'witnessIds') w ON true GROUP BY r->>'metricKey',r->'semantics'`,[stable(source)])).rows;
   const rows=grouped.filter(r=>r.count==='1').map(r=>({...r.row,value:cleanDecimal(r.value),witnessIds:r.witnesses,fields:{...r.row.fields,value:cleanDecimal(r.value)}}));
   if(node.op==='reconcile')tables.set(node.id,rows);else if(grouped.length===1&&rows.length===1)scalars.set(node.id,{value:rows[0]!.value,semantics:rows[0]!.semantics,witnessIds:rows[0]!.witnessIds});else checks.push({id:'unique:'+node.id,method:'SEMANTIC_EDGE',status:'FAIL',expected:'ONE_NONCONFLICTING_LOGICAL_VALUE',actual:String(grouped.length),predicate:'unique independently grouped entity/metric/financial semantics',witnessIds:source.flatMap(r=>r.witnessIds)});
  }else if(node.op==='filter'){
   const op={eq:'=',neq:'<>',lt:'<',lte:'<=',gt:'>',gte:'>='}[node.predicate];const expression=node.field==='value'?'(r->\'fields\'->>$2)::numeric':'r->\'fields\'->>$2';const param=node.field==='value'?'$3::numeric':'$3::text';const selected=(await c.query<{row:FinancialRow}>(`SELECT r row FROM jsonb_array_elements($1::jsonb) r WHERE ${expression} ${op} ${param}`,[stable(tables.get(node.input)??[]),node.field,node.value])).rows;tables.set(node.id,selected.map(r=>r.row));
  }else if(node.op==='project')tables.set(node.id,(tables.get(node.input)??[]).map(r=>({...r,fields:Object.fromEntries(node.fields.map(f=>[f,r.fields[f]??null]))})));
  else if(node.op==='join'){
   const selected=(await c.query<{l:FinancialRow;r:FinancialRow;compatible:boolean}>(`SELECT l,r,l->'semantics'=r->'semantics' compatible FROM jsonb_array_elements($1::jsonb) l CROSS JOIN jsonb_array_elements($2::jsonb) r
     WHERE NOT EXISTS(SELECT 1 FROM unnest($3::text[]) f WHERE (l->'fields'->>f) IS DISTINCT FROM (r->'fields'->>f))`,[stable(tables.get(node.left)??[]),stable(tables.get(node.right)??[]),node.on])).rows;
   checks.push({id:'join-semantics:'+node.id,method:'SEMANTIC_EDGE',status:selected.every(r=>r.compatible)?'PASS':'FAIL',expected:'COMPATIBLE_REGISTERED_FINANCIAL_SCOPE',actual:selected.every(r=>r.compatible)?'COMPATIBLE':'MISMATCH',predicate:'independent SQL equality of joined entity/period/unit/currency/consolidation/instrument semantics',witnessIds:selected.flatMap(({l,r})=>[...l.witnessIds,...r.witnessIds])});
   tables.set(node.id,selected.map(({l,r})=>({...l,witnessIds:[...new Set([...l.witnessIds,...r.witnessIds])],fields:{...l.fields,...Object.fromEntries(Object.entries(r.fields).map(([k,v])=>['right_'+k,v]))}})));
  }else if(node.op==='aggregate'){
   const source=tables.get(node.input)??[];const dedup=(await c.query<{row:FinancialRow}>(`SELECT (jsonb_agg(r ORDER BY r->>'recordId')->0) row FROM jsonb_array_elements($1::jsonb) r GROUP BY r->>'metricKey',r->'semantics' HAVING count(DISTINCT(r->>'value')::numeric)=1`,[stable(source)])).rows.map(r=>r.row);
   const method={sum:'sum',count:'count',min:'min',max:'max'}[node.method];const groups=(await c.query<{key:unknown[];row:FinancialRow;value:string;witnesses:string[];semantic_count:string}>(`WITH tagged AS(SELECT r,(SELECT jsonb_agg(r->'fields'->f ORDER BY ordinal) FROM unnest($2::text[]) WITH ORDINALITY k(f,ordinal)) key FROM jsonb_array_elements($1::jsonb) r)
    SELECT coalesce(key,'[]'::jsonb) key,(jsonb_agg(r ORDER BY r->>'recordId')->0) row,${method}(${node.method==='count'?'*':"(r->>'value')::numeric"})::text value,count(DISTINCT r->'semantics')::text semantic_count,
      ARRAY(SELECT DISTINCT jsonb_array_elements_text(x->'witnessIds') FROM jsonb_array_elements(jsonb_agg(r)) x) witnesses FROM tagged GROUP BY key`,[stable(dedup),node.groupBy])).rows;
   checks.push({id:'aggregate-semantics:'+node.id,method:'SEMANTIC_EDGE',status:groups.every(g=>g.semantic_count==='1')?'PASS':'FAIL',expected:'ONE_FINANCIAL_SCOPE_PER_GROUP',actual:groups.every(g=>g.semantic_count==='1')?'COMPATIBLE':'MISMATCH',predicate:'independent SQL financial semantic-group count',witnessIds:groups.flatMap(g=>g.witnesses)});
   tables.set(node.id,groups.map(g=>({...g.row,recordId:'group:'+JSON.stringify(g.key),metricKey:node.method,value:cleanDecimal(g.value),semantics:{...g.row.semantics,...(node.method==='count'?{unit:'count' as const,currencyCode:null}:{})},witnessIds:g.witnesses,fields:{...g.row.fields,value:cleanDecimal(g.value),unit:node.method==='count'?'count':g.row.semantics.unit,currencyCode:node.method==='count'?null:g.row.semantics.currencyCode,metricKey:node.method,recordId:'group:'+JSON.stringify(g.key)}})));
  }else{
   const l=scalars.get(node.left),r=scalars.get(node.right);if(!l||!r){checks.push({id:'numeric:'+node.id,method:'POSTGRES_NUMERIC',status:'FAIL',expected:'INDEPENDENT_OPERANDS',actual:null,predicate:'material scalar operands exist independently',witnessIds:[]});continue;}
   const dims:Array<keyof FinancialRow['semantics']>=['entityType','entityId','frequency','calendar','consolidation','instrument','currencyCode'];if(node.op!=='growth')dims.push('periodStart','periodEnd');const compatible=dims.every(k=>l.semantics[k]===r.semantics[k])&&(node.op==='multiply'||l.semantics.unit===r.semantics.unit);
   checks.push({id:'semantics:'+node.id,method:'SEMANTIC_EDGE',status:compatible?'PASS':'FAIL',expected:'COMPATIBLE_REGISTERED_ENTITY_PERIOD_UNIT_CURRENCY_SCOPE_INSTRUMENT',actual:compatible?'COMPATIBLE':'MISMATCH',predicate:'independent dimensional and period contract',witnessIds:[...l.witnessIds,...r.witnessIds]});
   const expression=node.op==='add'?'$1::numeric+$2::numeric':node.op==='subtract'?'$1::numeric-$2::numeric':node.op==='multiply'?'$1::numeric*$2::numeric':node.op==='growth'?'($1::numeric-$2::numeric)/NULLIF($2::numeric,0)':'$1::numeric/NULLIF($2::numeric,0)';
   const value=(await c.query<{value:string|null}>('SELECT ('+expression+')::text value',[l.value,r.value])).rows[0]!.value;if(value===null){checks.push({id:'zero:'+node.id,method:'POSTGRES_NUMERIC',status:'FAIL',expected:'NONZERO_DENOMINATOR',actual:'0',predicate:'defined numeric operation',witnessIds:r.witnessIds});continue;}
   scalars.set(node.id,{value:cleanDecimal(value),semantics:{...l.semantics,...(node.op==='ratio'?{unit:'multiple' as const,currencyCode:null}:node.op==='growth'?{unit:'rate' as const,currencyCode:null}:{})},witnessIds:[...new Set([...l.witnessIds,...r.witnessIds])]});
  }
  const expected=scalars.get(node.id),actual=native.nodes[node.id];if(expected){const match=actual?.kind==='scalar'&&actual.value!==null&&(await c.query<{equal:boolean}>('SELECT $1::numeric=$2::numeric equal',[expected.value,actual.value])).rows[0]!.equal;
   checks.push({id:'output-semantics:'+node.id,method:'SEMANTIC_EDGE',status:stable(expected.semantics)===stable(actual?.semantics)&&stable([...new Set(expected.witnessIds)].sort())===stable([...(actual?.witnessIds??[])].sort())?'PASS':'FAIL',expected:stable(expected.semantics),actual:stable(actual?.semantics??null),predicate:'independent output dimensions and complete input witness union',witnessIds:expected.witnessIds});
   checks.push({id:'numeric:'+node.id,method:'POSTGRES_NUMERIC',status:match?'PASS':'FAIL',expected:expected.value,actual:actual?.value??null,predicate:'independent original-operand PostgreSQL numeric equals native output',witnessIds:expected.witnessIds});
  }else if(tables.has(node.id)){
   const expectedRows=tables.get(node.id)!,actualRows=actual?.rows??[];const normalize=(rows:FinancialRow[])=>rows.map(r=>({recordId:r.recordId,metricKey:r.metricKey,value:cleanDecimal(r.value),semantics:r.semantics,fields:r.fields,witnessIds:[...r.witnessIds].sort()})).sort((a,b)=>stable(a).localeCompare(stable(b)));
   const expectedDigest=sha(normalize(expectedRows)),actualDigest=sha(normalize(actualRows));checks.push({id:'table:'+node.id,method:'SQL_SOURCE_COUNT',status:expectedDigest===actualDigest?'PASS':'FAIL',expected:expectedDigest,actual:actualDigest,predicate:'independently executed relational result rows and witnesses match',witnessIds:actualRows.flatMap(r=>r.witnessIds)});
  }
 }
 return checks;
},true);}
