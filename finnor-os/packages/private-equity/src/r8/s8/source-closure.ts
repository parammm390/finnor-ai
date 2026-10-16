/** Exclusive review closure. Shared S8 dispatch/policy must still be integrated. */
import {fileURLToPath} from 'node:url';
import {readFile} from 'node:fs/promises';
import {R8_SOURCE_PATHS} from '../../../../epistemic-runtime/src/solver-synthesis/runtime';
import type {SourcePin} from '../../../../epistemic-runtime/src/solver-synthesis/contracts';
import {byteDigest,fault} from '../../../../capability-evolution/src/contracts';

export const requiredSolverReviewSourcePaths=[...new Set([
 ...R8_SOURCE_PATHS,
 ...['contracts.ts','consumer.ts','port.ts','source-closure.ts','../capsule.ts','../projection.ts',
  '../../../../shared-types/src/solver-capsule.ts'].map(path=>fileURLToPath(new URL(path,import.meta.url))),
])].sort();
/** Core and review closures overlap. Preserve both identities without permitting
 * one signer-owned source hash to silently shadow the other. */
export function solverReviewDependencies(core:readonly SourcePin[],review:readonly SourcePin[]){
 const pins=new Map<string,SourcePin>();
 for(const pin of [...core,...review]){
  const prior=pins.get(pin.path);
  if(prior&&prior.sha256!==pin.sha256)fault('S8_SOLVER_CONFLICTING_REVIEW_SOURCE',503);
  if(!prior)pins.set(pin.path,pin);
 }
 return [...pins.values()];
}
export async function assertSolverReviewSourceClosure(pins:readonly SourcePin[]){
 if(new Set(pins.map(pin=>pin.path)).size!==pins.length)fault('S8_SOLVER_DUPLICATE_REVIEW_SOURCE');
 for(const path of requiredSolverReviewSourcePaths){
  const sha256=byteDigest(await readFile(path));
  if(!pins.some(pin=>pin.path===path&&pin.sha256===sha256))fault('S8_SOLVER_REVIEW_SOURCE_CLOSURE_MISSING',503);
 }
}
