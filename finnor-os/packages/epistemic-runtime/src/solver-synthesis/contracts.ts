import {createHash} from 'node:crypto';
import {canonical} from '../../../governed-execution/src/protocol';
import type {NativeModule} from '../../../private-equity/src/program-synthesis/contracts';

export const R8_PROFILE='r8-three-optional-projects-integer-v1' as const;
export const INPUT_ORDER=['c1','c2','c3','v1','v2','v3'] as const;
export const INPUT_COUNT=262144;
export const CHUNK_SIZE=4096;
export const hash=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
export const bytesHash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
export type IntegerExpr={op:'int';value:number}|{op:'input';index:number}|{op:'local';name:string}|
 {op:'add'|'sub'|'mul';left:IntegerExpr;right:IntegerExpr}|{op:'if';condition:BooleanExpr;then:IntegerExpr;else:IntegerExpr};
export type BooleanExpr={op:'bool';value:boolean}|{op:'member';mask:IntegerExpr;project:number}|
 {op:'lt'|'lte'|'eq'|'gte'|'gt';left:IntegerExpr;right:IntegerExpr}|
 {op:'and'|'or';left:BooleanExpr;right:BooleanExpr}|{op:'not';value:BooleanExpr};
export type Expr=IntegerExpr|BooleanExpr;
export type Statement={op:'set';name:string;value:IntegerExpr}|{op:'if';condition:BooleanExpr;then:Statement[];else:Statement[]}|
 {op:'for';name:string;from:number;to:number;step:1|-1;body:Statement[]};
export interface IntegerProgram {
 schema:'finnor.r8.integer-program.v1';profile:typeof R8_PROFILE;inputOrder:typeof INPUT_ORDER;
 semantics:'EXACT_INTEGER';body:Statement[];output:string;bounds:{steps:1024;integerAbs:63};
}
export interface Choices {
 enabled:boolean[];costFamily:0|1;netScore:boolean;capacity:6|7|8;inclusiveFeasibility:boolean;
 inclusiveImprovement:boolean;descending:boolean;
}
export interface SourcePin {path:string;sha256:string}
export interface RuntimeIdentity {
 schema:'finnor.r8.scientific-runtime.v1';platform:string;architecture:string;
 racket:{path:string;sha256:string;version:string};rosette:{commit:string;treeDigest:string};
 solver:{path:string;sha256:string;version:string;options:string[]};
 python:{path:string;sha256:string;version:string};node:{path:string;sha256:string;version:string};
 userHome:string;inventoryDigest:string;inventory:Array<{path:string;sha256:string;bytes:number}>;
 licenses:Array<{path:string;sha256:string;name:string}>;
}
export interface Counterexample {
 id:string;input:number[];candidateDigest:string;specificationDigest:string;failure:string[];
 witness:Record<string,unknown>;emittedMask:number;resource:unknown;
}
export interface Trial {
 round:number;choices:Choices;program:IntegerProgram;module:NativeModule;query:unknown;
 status:'REJECTED'|'ACCEPTED'|'INCOMPLETE';counterexamples:Counterexample[];resource:unknown;
}
export interface CoverageChunk {
 schema:'finnor.r8.coverage-chunk.v1';start:number;count:number;pairs:number;programDigest:string;
 moduleDigest:string;emittedDigest:string;checkerDigest:string;specificationDigest:string;
 inputDigest:string;outputDigest:string;optimalSetsDigest:string;steps:number;maximumIntegerAbs:number;
 /** One two-digit hexadecimal byte per input, bit m means subset m is optimal. */
 masks:string;optimalSets:string;status:'PASS';
}
export interface SemanticReceipt {
 schema:'finnor.r8.semantic-receipt.v1';status:'COMPLETE';profile:typeof R8_PROFILE;
 programDigest:string;moduleDigest:string;emittedDigest:string;compilerDigest:string;runtimeDigest:string;
 specificationDigest:string;grammarDigest:string;checkerDigest:string;
 checkedInputs:262144;checkedPairs:2097152;chunkDigest:string;chunks:CoverageChunk[];
 resetDigest:string;resource:unknown;basis:'INDEPENDENT_PYTHON_INTEGER_AST_AND_FULL_ISOLATED_EMITTED_ENUMERATION';
 protectedAdmission:false;
}
export const SPECIFICATION=Object.freeze({
 schema:'finnor.r8.specification.v1',profile:R8_PROFILE,inputOrder:INPUT_ORDER,radix:8,coordinates:6,
 capacity:7,masks:8,inputCount:INPUT_COUNT,pairs:2097152,objective:'SUM_SUPPLIED_UTILITIES_NO_COST_REDEDUCTION',
 tie:'MINIMUM_CANONICAL_MASK',output:'INTEGER_MASK_0_THROUGH_7',arithmetic:'EXACT_INTEGER',gap:0,
});
export const GRAMMAR=Object.freeze({
 schema:'finnor.r8.grammar.v1',nodes:512,depth:24,locals:32,bytes:16384,loops:1,iterations:7,
 steps:1024,integerAbs:63,literalMin:-21,literalMax:21,registers:256,compiledBytes:65536,
 expressionOps:['int','bool','input','local','add','sub','mul','lt','lte','eq','gte','gt','and','or','not','if','member'],
 statementOps:['set','if','for'],semantics:'EXACT_INTEGER_LAZY_BRANCH_SEQUENTIAL_ASSIGNMENT',
});
export function coordinates(value:unknown):number[] {
 if(!Array.isArray(value)||value.length!==6||value.some(v=>!Number.isSafeInteger(v)||v<0||v>7))throw Error('R8_ORIGINAL_DOMAIN_REQUIRED');
 return [...value] as number[];
}
