import {createRequire} from 'node:module';
import {resolve,isAbsolute} from 'node:path';
import {writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const [directory,evidence,mode='cjs']=process.argv.slice(2);
assert.ok(isAbsolute(directory)&&isAbsolute(evidence),'absolute package and new evidence paths required');
const require=createRequire(import.meta.url),{z}=mode==='esm'?await import(pathToFileURL(resolve(directory,'v3/index.js'))):require(resolve(directory)),observations=[];
let visited=0;
const el=z.any().superRefine((_value,ctx)=>{visited++;ctx.addIssue({code:'custom',message:'synthetic invalid item'});});
const cases=[['array-max',z.array(el).max(2),Array(128).fill(null)],['array-exact',z.array(el).length(2),Array(128).fill(null)],['set-max',z.set(el).max(2),new Set(Array.from({length:128},(_,i)=>i))],['nested-max',z.object({items:z.array(el).max(2)}),{items:Array(128).fill(null)}]];
let failure;
try{
 for(const [name,schema,input] of cases){
  visited=0;const result=schema.safeParse(input);
  observations.push({name,visited,success:result.success,issues:result.success?0:result.error.issues.length});
  assert.equal(result.success,false);assert.equal(visited,0,name+' traversed oversized input');assert.equal(result.error.issues.length,1);
  assert.equal(result.error.issues[0].code,'too_big');
 }
 visited=0;
 const asyncEl=z.any().superRefine(async(_value,ctx)=>{visited++;ctx.addIssue({code:'custom',message:'synthetic invalid item'});});
 const asyncResult=await z.array(asyncEl).max(2).safeParseAsync(Array(128).fill(null));
 assert.equal(asyncResult.success,false);assert.equal(visited,0);assert.equal(asyncResult.error.issues.length,1);
 observations.push({name:'async-max',visited,issues:asyncResult.error.issues.length});
 assert.deepEqual(z.array(z.string().transform(s=>s.toUpperCase())).max(2).parse(['a','b']),['A','B']);
 assert.equal(z.array(z.string()).min(2).safeParse(['a']).error.issues[0].code,'too_small');
 assert.equal(z.array(z.string()).length(2).safeParse(['a']).error.issues[0].code,'too_small');
 assert.deepEqual([...z.set(z.number()).max(2).parse(new Set([1,2]))],[1,2]);
 assert.ok(z.ZodEffects&&z.ZodLazy&&z.ZodFirstPartyTypeKind);
 observations.push({name:'valid-transform-minimum-exact-class-compatibility',status:'PASS'});
 visited=0;const stress=z.array(el).max(2).safeParse(Array(1000000).fill(null));assert.equal(stress.success,false);assert.equal(visited,0);assert.equal(stress.error.issues.length,1);observations.push({name:'million-element-bounded-refusal',visited,issues:1});
}catch(error){failure=error;}
writeFileSync(evidence,JSON.stringify({status:failure?'FAIL':'PASS',packageDirectory:directory,observations,error:failure?String(failure):null},null,2)+'\n',{flag:'wx'});
if(failure){console.error(String(failure));process.exit(1);}
console.log(JSON.stringify({status:'PASS',cases:observations.length}));
