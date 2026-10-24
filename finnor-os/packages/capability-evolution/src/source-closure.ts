/** Minimum audited loaded-source closure. Not a production image attestation. */
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { byteDigest, fault, type CapabilityRevisionBody } from './contracts';
const own = ['institution-port.ts', 'contracts.ts', 'consumer-transport.ts', 'application-port.ts', 'application-consumer.ts', 'learned-policy-port.ts', 'learned-policy-consumer.ts', 'learning-experience.ts', 'interface-port.ts', 'interface-consumer.ts', 'journal.ts', 'protected-events.ts', 'protected-method.ts', 'canary.ts', 'reconciliation.ts', 'lifecycle.ts', 'server.mts', 'consumer.ts', 'search.ts', 'search-process.ts', 'search-worker.mts', 'evaluation.ts', 'evaluator.mts', 'experience.ts', 'proposer.ts', 'campaign.mts', 'source-closure.ts'];
const upstream = ['../../governed-execution/src/protocol.ts', '../../governed-execution/src/owner-transport.ts', '../../epistemic-runtime/src/allocation-producer.ts', '../../epistemic-runtime/src/allocation-checker.ts', '../../epistemic-runtime/src/allocation-verifier.ts', '../../epistemic-runtime/src/allocation-verifier-worker.mjs', '../../epistemic-runtime/src/allocation-contracts.ts', '../../epistemic-runtime/src/control-contracts.ts', '../../epistemic-runtime/src/experiment-numerics.ts', '../../epistemic-runtime/src/source-precedence.ts', '../../private-equity/src/enterprise-allocation.ts', '../../private-equity/src/allocation-store.ts', '../../private-equity/src/enterprise-economic-consumers.ts', '../../private-equity/src/economic-store.ts', '../../private-equity/src/enterprise-economic-attribution.ts', '../../private-equity/src/enterprise-economic-assignments.ts', '../../private-equity/src/enterprise-control.ts', '../../private-equity/src/enterprise-obligations.ts', '../../epistemic-runtime/src/economic-attribution.ts', '../../shared-types/src/economic-attribution.ts', '../../../package-lock.json'];
// Do not shadow Node's require: emitted import.meta source-custody expressions
// must resolve before this native source-relative loader is initialized.
const sourceRequire = createRequire(import.meta.url), native = sourceRequire.resolve('fs-ext'), schema = sourceRequire.resolve('zod');
const interfaceSources=['contracts.ts','compiler.ts','runtime.ts','ui.ts','browser.ts','store.ts','worker.ts','api.ts'].map(path=>'../../private-equity/src/interface-synthesis/'+path)
 .concat(['../../governed-execution/src/executor.ts','../../private-equity/src/evidence-execution/store.ts','../../private-equity/src/program-synthesis/store.ts',
 '../../private-equity/src/program-synthesis/contracts.ts','../../private-equity/src/program-synthesis/interface-contracts.ts',
 '../../shared-types/src/evidence-execution.ts','../../shared-types/src/index.ts']);
const applicationSources=['contracts.ts','exact.ts','compiler.ts','program.ts','checker.ts','source-cut.ts','source-paths.ts','source-manifest.generated.ts','store.ts','service.ts','worker.ts','build-child.mts','api.ts','effects.ts','admission.ts'].map(path=>'../../private-equity/src/enterprise-applications/'+path)
 .concat(['../../shared-types/src/enterprise-applications.ts','../../shared-types/src/primary-diligence.ts','../../authority/src/index.ts','../../db/compute-contract.ts','../../db/compute-governor.ts','../../db/migration-head.ts','../../db/migrations/0189_x3_enterprise_applications.sql']);
const learningSources=['contracts.ts','types.ts','abstraction.ts','controller.ts','core-child.mts','process.ts','source-cut.ts','source-paths.ts','source-manifest.generated.ts','store.ts','service.ts','worker.ts','consumer.ts','evaluation.ts','evaluation-plan.ts','outcome-contract.ts','assignments.ts','admission.ts','api.ts'].map(path=>'../../private-equity/src/policy-learning/'+path)
 .concat(['../../shared-types/src/learned-policy.ts','../../db/migrations/0190_x5_experience_policy.sql']);
const applicationSemanticsSources = [
 './application-semantics-port.ts', './application-semantics-consumer.ts',
 '../../private-equity/src/application-semantics/contracts.ts',
 '../../private-equity/src/application-semantics/checker.ts',
 '../../shared-types/src/application-semantics.ts',
];
export const requiredCapabilitySourcePaths = [...new Set([...own, ...upstream, ...interfaceSources,...applicationSources,...learningSources,...applicationSemanticsSources])].map(path => fileURLToPath(new URL(path, import.meta.url))).concat([native, schema, fileURLToPath(new URL('./build/Release/fs_ext.node', pathToFileURL(native)))]);
/** X2's independently signed consumer/domain closure. Other compiler domains
 * remain pinned by the outer lifecycle; they are not this consumer's payload. */
export const requiredApplicationSemanticsSourcePaths = [...new Set([...own, ...upstream, ...interfaceSources,...applicationSemanticsSources])].map(path => fileURLToPath(new URL(path, import.meta.url))).concat([native, schema, fileURLToPath(new URL('./build/Release/fs_ext.node', pathToFileURL(native)))]);
const loaded = Promise.all(requiredCapabilitySourcePaths.map(async (path) => ({ path, sha256: byteDigest(await readFile(path)) })));
void loaded.catch(() => undefined);
const applicationSemanticsLoaded = Promise.all(requiredApplicationSemanticsSourcePaths.map(async path => ({path,sha256:byteDigest(await readFile(path))})));
void applicationSemanticsLoaded.catch(() => undefined);
export async function assertApplicationSemanticsSourceClosure(pins:CapabilityRevisionBody['dependencies']){
    if(pins.length>128||new Set(pins.map(pin=>pin.path)).size!==pins.length)
        fault('S8_APPLICATION_SOURCE_PIN_BOUND_OR_DUPLICATE');
    const expected=await applicationSemanticsLoaded;
    if(expected.some(source=>!pins.some(pin=>pin.path===source.path&&pin.sha256===source.sha256)))
        fault('S8_LOADED_DEPENDENCY_CLOSURE_MISSING_OR_CHANGED',503);
}
export async function assertCapabilitySourceClosure(pins: CapabilityRevisionBody['dependencies']) {
    if (new Set(pins.map(p => p.path)).size !== pins.length)
        fault('S8_DUPLICATE_DEPENDENCY_PATH');
    const expected = await loaded;
    if (expected.some(source => !pins.some(pin => pin.path === source.path && pin.sha256 === source.sha256)))
        fault('S8_LOADED_DEPENDENCY_CLOSURE_MISSING_OR_CHANGED', 503);
}
/** The scientific sibling has a separate larger closure (cap 256), loaded only
 * when used. Existing allocation revisions retain their exact 128-pin grammar. */
export async function identifiedSystemSourcePaths(){
 const {IDENTIFICATION_SOURCE_PATHS}=await import('../../private-equity/src/system-identification/source-paths');
 return [...new Set([...requiredCapabilitySourcePaths,...IDENTIFICATION_SOURCE_PATHS.map(p=>fileURLToPath(new URL('../../../../'+p,import.meta.url))),
  fileURLToPath(new URL('./identified-system-port.ts',import.meta.url)),fileURLToPath(new URL('./identified-system-consumer.ts',import.meta.url)),
  fileURLToPath(new URL('../../private-equity/src/system-identification/source-manifest.generated.ts',import.meta.url))])];
}
let scientificLoaded:Promise<Array<{path:string;sha256:string}>>|undefined;
export async function assertIdentifiedSystemSourceClosure(pins:Array<{path:string;sha256:string}>){
 await assertCapabilitySourceClosure(pins);
 scientificLoaded??=identifiedSystemSourcePaths().then(paths=>Promise.all(paths.map(async path=>({path,sha256:byteDigest(await readFile(path))}))));
 const expected=await scientificLoaded;
 if(pins.length>256||expected.length>256||expected.some(e=>!pins.some(p=>p.path===e.path&&p.sha256===e.sha256)))fault('S8_IDENTIFIED_SYSTEM_SOURCE_CLOSURE_MISSING_OR_CHANGED',503);
}
export async function confidentialSourcePaths(){
 const native=['contracts.ts','artifact.ts','process.ts','store.ts','service.ts','worker.ts','consumer.ts','owner-consumer.ts',
  'admission.ts','api.ts','plan.ts','operational-query.ts','compiler.py','correspondence.py','secure_runtime.py',
  'participant.py','backend.py','public_driver.py','profile.json','backend-identity.json'];
 return [...new Set([...requiredCapabilitySourcePaths,
  ...native.map(p=>fileURLToPath(new URL('../../private-equity/src/confidential-computation/'+p,import.meta.url))),
  fileURLToPath(new URL('./confidential-port.ts',import.meta.url)),
  fileURLToPath(new URL('./confidential-consumer.ts',import.meta.url)),
  fileURLToPath(new URL('../../db/migrations/postx_y4_confidential_economic_computation.sql',import.meta.url)),
  fileURLToPath(new URL('../../db/migrations/postx_y4_confidential_owner_consumption.sql',import.meta.url)),
  fileURLToPath(new URL('../../db/migrations/postx_y4_runtime_owner_integrity.sql',import.meta.url)),
  fileURLToPath(new URL('../../db/migrations/postx_y4_runtime_recipient_recovery.sql',import.meta.url)),
  fileURLToPath(new URL('../../db/migration-head.ts',import.meta.url))])];
}
let confidentialLoaded:Promise<Array<{path:string;sha256:string}>>|undefined;
export async function assertConfidentialSourceClosure(pins:Array<{path:string;sha256:string}>){
 await assertCapabilitySourceClosure(pins);
 confidentialLoaded??=confidentialSourcePaths().then(paths=>Promise.all(paths.map(async path=>({path,sha256:byteDigest(await readFile(path))}))));
 const expected=await confidentialLoaded;
 if(pins.length>256||expected.length>256||expected.some(e=>!pins.some(p=>p.path===e.path&&p.sha256===e.sha256)))
  fault('S8_CONFIDENTIAL_SOURCE_CLOSURE_MISSING_OR_CHANGED',503);
}
