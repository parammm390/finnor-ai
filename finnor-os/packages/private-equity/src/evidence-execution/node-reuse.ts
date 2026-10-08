import {createHash} from 'node:crypto';
import type {DerivationProgram,EvidenceValue} from '@finnor/shared-types';
/** Pure computation identity. A current owner cut and Work envelope are checked
 * separately; a cached node never restores an invalidated derivation. */
const canonical=(v:unknown):string=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.entries(v).filter(([,x])=>x!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>JSON.stringify(k)+':'+canonical(x)).join(',')+'}';
export const nodeDigest=(v:unknown)=>createHash('sha256').update(canonical(v)).digest('hex');
export interface ReusableNode {value:EvidenceValue;digest:string;originDerivationId:string;originNodeId:string}
export function nodeCacheKeys(program:DerivationProgram,sourceIdentities:Record<string,string>,namespace:string){const keys:Record<string,string>={};for(const node of program.nodes){const parents='input' in node?[node.input]:'left' in node?[node.left,node.right]:[];if(parents.some(p=>!keys[p]))throw Error('FINITE_TOPOLOGICAL_PROGRAM_REQUIRED');keys[node.id]=nodeDigest({namespace,node,parents:parents.map(p=>keys[p]),source:node.op==='source'?sourceIdentities[node.inputId]:null});}return keys;}
