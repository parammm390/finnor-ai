/** Replaceable ordinary compiler. Interface documents never receive tool authority. */
import {z} from 'zod';
import {bounded,fail,fieldName,hash,moduleFor,parseOperation,type Operation,type HttpModule,type GeneratedInterface} from './contracts';
function object(v:unknown):Record<string,any>{if(!v||typeof v!=='object'||Array.isArray(v))fail('P5_SCHEMA_SHAPE');return v as Record<string,any>;}
function resolveSchema(doc:Record<string,any>,v:unknown,seen=new Set<string>()):Record<string,any>{
 const schema=object(v);
 if(!Object.hasOwn(schema,'$ref'))return schema;
 const ref=schema.$ref;
 if(typeof ref!=='string'||Object.keys(schema).length!==1||!/^#\/components\/schemas\/[A-Za-z0-9_-]{1,64}$/.test(ref)||seen.has(ref)||seen.size>=8)fail('P5_SCHEMA_REF_UNPERMITTED');
 seen.add(ref);return resolveSchema(doc,doc.components?.schemas?.[ref.split('/').at(-1)!],seen);
}
export function wireValue(value:string|null,places:number,encoding:'minor_integer'|'major_decimal_string'):number|string|null{
 if(value===null)return null;
 if(!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value))fail('P5_DECIMAL_AMBIGUOUS');
 const negative=value.startsWith('-'),[integer,fraction='']=value.replace(/^-/,'').split('.');
 if(integer===undefined)fail('P5_DECIMAL_AMBIGUOUS');
 if(fraction.length>places)fail('P5_DECIMAL_PRECISION_LOSS');
 const minor=BigInt(integer)*10n**BigInt(places)+BigInt(fraction.padEnd(places,'0')||'0');
 if(minor>BigInt(Number.MAX_SAFE_INTEGER))fail('P5_DECIMAL_RANGE');
 if(encoding==='major_decimal_string')return (negative&&minor!==0n?'-':'')+BigInt(integer).toString()+(places?'.'+fraction.padEnd(places,'0'):'');
 return Number(negative?-minor:minor);
}
function pathParameters(route:Record<string,any>,path:string){
 if(!Array.isArray(route.parameters)||route.parameters.length!==2)fail('P5_SCHEMA_PATH_PARAMETERS');
 const fields:Record<string,string>={};
 for(const raw of route.parameters){
  const p=object(raw),role=p['x-finnor-role'];
  if(!['account','entity'].includes(role)||fields[role]||p.in!=='path'||p.required!==true||p.schema?.type!=='string'||!fieldName.safeParse(p.name).success)fail('P5_SCHEMA_PATH_PARAMETERS');
  fields[role]=p.name;
 }
 const placeholders=[...path.matchAll(/\{([^}]+)\}/g)].map(m=>{if(m[1]===undefined)fail('P5_SCHEMA_PATH_PARAMETERS');return m[1];});
 if(placeholders.length!==2||placeholders.some(p=>!Object.values(fields).includes(p)))fail('P5_SCHEMA_PATH_PARAMETERS');
 return {account:fields.account!,entity:fields.entity!};
}
function valueProperty(doc:Record<string,any>,request:unknown){
 const schema=resolveSchema(doc,request),properties=object(schema.properties);
 if(schema.type!=='object'||schema.additionalProperties!==false||!Array.isArray(schema.required)||schema.required.length!==1||Object.keys(properties).length!==1)fail('P5_SCHEMA_EXACT_WRITE_FIELDS');
 const [name,p]=Object.entries(properties)[0]!,property=resolveSchema(doc,p);
 if(!fieldName.safeParse(name).success||schema.required[0]!==name||property['x-finnor-role']!=='value')fail('P5_SCHEMA_EXACT_WRITE_FIELDS');
 return {name,property};
}
function readProperties(doc:Record<string,any>,response:unknown,operation:Operation){
 const schema=resolveSchema(doc,response),properties=object(schema.properties),fields:Record<string,string>={};
 if(schema.type!=='object'||schema.additionalProperties!==false||!Array.isArray(schema.required)||schema.required.length!==7||Object.keys(properties).length!==7)fail('P5_SCHEMA_EXACT_OBSERVER_FIELDS');
 for(const [name,raw] of Object.entries(properties)){
  const property=resolveSchema(doc,raw),role=property['x-finnor-role'];
  if(!['account','entity','value','revision','operationId','unit','currency'].includes(role)||fields[role]||!fieldName.safeParse(name).success||!schema.required.includes(name))fail('P5_SCHEMA_OBSERVER_AMBIGUOUS');
  if(role==='unit'&&property.const!==operation.unit||role==='currency'&&property.const!==operation.currency)fail('P5_UNIT_OR_CURRENCY_UNSUPPORTED');
  fields[role]=name;
 }
 return fields as HttpModule['readFields'];
}
export function synthesizeApi(source:unknown,requested:unknown):GeneratedInterface{
 bounded(source);const operation=parseOperation(requested),doc=object(source);
 if(doc.openapi!=='3.1.1')fail('P5_SCHEMA_DIALECT_UNSUPPORTED');
 const candidates=Object.entries(object(doc.paths)).filter(([,r])=>object(r).patch?.['x-finnor-operation']?.meaning===operation.meaning&&object(r).patch?.['x-finnor-operation']?.field===operation.field);
 if(candidates.length!==1)fail('P5_OPERATION_AMBIGUOUS_OR_UNAVAILABLE');
 const [path,raw]=candidates[0]!,route=object(raw),write=object(route.patch),read=object(route.get);
 const descriptor=z.object({meaning:z.literal('set-record-field'),field:fieldName,unit:z.literal('currency'),currency:z.string().regex(/^[A-Z]{3}$/),encoding:z.enum(['minor_integer','major_decimal_string']),decimalPlaces:z.number().int().min(0).max(6),nullable:z.boolean()}).strict().safeParse(write['x-finnor-operation']);
 if(!descriptor.success)fail('P5_UNIT_OR_REFINEMENT_UNSUPPORTED');
 const semantics=descriptor.data;
 if(semantics.unit!==operation.unit||semantics.currency!==operation.currency)fail('P5_UNIT_OR_CURRENCY_UNSUPPORTED');
 const parameters=pathParameters(route,path),value=valueProperty(doc,write.requestBody?.content?.['application/json']?.schema);
 const nullable=Array.isArray(value.property.type)&&value.property.type.length===2&&value.property.type.includes('null');
 const baseType=semantics.encoding==='minor_integer'?'integer':'string';
 if(!(value.property.type===baseType||nullable&&value.property.type.includes(baseType))||nullable!==semantics.nullable||operation.value===null&&!nullable)fail('P5_SCHEMA_VALUE_TYPE_UNSUPPORTED');
 wireValue(operation.value,semantics.decimalPlaces,semantics.encoding);
 if(!Array.isArray(write.parameters)||write.parameters.length!==2||!write.parameters.some((p:any)=>p.name==='If-Match'&&p.in==='header'&&p.required===true&&p['x-finnor-role']==='revision')||!write.parameters.some((p:any)=>p.name==='X-Operation-Id'&&p.in==='header'&&p.required===true&&p['x-finnor-role']==='operationId'))fail('P5_CONDITIONAL_IDENTITY_UNSUPPORTED');
 const readFields=readProperties(doc,read.responses?.['200']?.content?.['application/json']?.schema,operation);
 const history=doc['x-finnor-effect-history']??null;
 if(history!==null&&(!history.path?.includes('{'+history.accountParameter+'}')||!history.path?.includes('{'+history.operationParameter+'}')))fail('P5_EFFECT_HISTORY_UNSUPPORTED');
 const common={schema:'finnor.p5.http-module.v1' as const,path,parameters,valueField:value.name,readFields,...descriptor.data,
  revisionHeader:'If-Match' as const,operationHeader:'X-Operation-Id' as const,history,imports:[] as [],entrypoint:'bind' as const,runtime:'S6_LOCAL_SEATBELT_PURE_IR' as const,maxResponseBytes:65536 as const,maxWallMs:3000 as const};
 return {schema:'finnor.p5.generated-interface.v1',substrate:'API',sourceDigest:hash(source),bindingDigest:hash(operation),
  semanticDigest:hash({meaning:operation.meaning,field:operation.field,unit:operation.unit,currency:operation.currency,encoding:semantics.encoding,decimalPlaces:semantics.decimalPlaces,nullable}),
  adapterModule:moduleFor({...common,kind:'ADAPTER',method:'PATCH'}),observerModule:moduleFor({...common,kind:'OBSERVER',method:'GET'}),
  interfaceVersion:String(doc.info?.version??''),qualification:'PERMITTED_TYPED_DOCUMENT_BINDING_NOT_INDEPENDENT_INTERFACE_ADMISSION'};
}
export function semanticCompatible(generated:GeneratedInterface,request:Operation){
 const module=JSON.parse(generated.observerModule.bytes) as HttpModule;
 return module.meaning===request.meaning&&module.field===request.field&&module.unit===request.unit&&module.currency===request.currency;
}
