/** Minimum audited loaded-source closure. Not a production image attestation. */
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { byteDigest, fault, type CapabilityRevisionBody } from './contracts';
const own = ['contracts.ts', 'interface-port.ts', 'interface-consumer.ts', 'journal.ts', 'protected-events.ts', 'protected-method.ts', 'canary.ts', 'reconciliation.ts', 'lifecycle.ts', 'server.mts', 'consumer.ts', 'search.ts', 'search-process.ts', 'search-worker.mts', 'evaluation.ts', 'evaluator.mts', 'experience.ts', 'proposer.ts', 'campaign.mts', 'source-closure.ts'];
const upstream = ['../../governed-execution/src/protocol.ts', '../../governed-execution/src/owner-transport.ts', '../../epistemic-runtime/src/allocation-producer.ts', '../../epistemic-runtime/src/allocation-checker.ts', '../../epistemic-runtime/src/allocation-verifier.ts', '../../epistemic-runtime/src/allocation-verifier-worker.mjs', '../../epistemic-runtime/src/allocation-contracts.ts', '../../epistemic-runtime/src/control-contracts.ts', '../../epistemic-runtime/src/experiment-numerics.ts', '../../epistemic-runtime/src/source-precedence.ts', '../../private-equity/src/enterprise-allocation.ts', '../../private-equity/src/allocation-store.ts', '../../private-equity/src/enterprise-economic-consumers.ts', '../../private-equity/src/economic-store.ts', '../../private-equity/src/enterprise-economic-attribution.ts', '../../private-equity/src/enterprise-economic-assignments.ts', '../../private-equity/src/enterprise-control.ts', '../../private-equity/src/enterprise-obligations.ts', '../../epistemic-runtime/src/economic-attribution.ts', '../../shared-types/src/economic-attribution.ts', '../../../package-lock.json'];
const require = createRequire(import.meta.url), native = require.resolve('fs-ext'), schema = require.resolve('zod');
const interfaceSources=['contracts.ts','compiler.ts','runtime.ts','ui.ts','browser.ts','store.ts','worker.ts','api.ts'].map(path=>'../../private-equity/src/interface-synthesis/'+path)
 .concat(['../../governed-execution/src/executor.ts','../../private-equity/src/evidence-execution/store.ts','../../private-equity/src/program-synthesis/store.ts',
 '../../private-equity/src/program-synthesis/contracts.ts','../../private-equity/src/program-synthesis/interface-contracts.ts',
 '../../shared-types/src/evidence-execution.ts','../../shared-types/src/index.ts']);
export const requiredCapabilitySourcePaths = [...new Set([...own, ...upstream, ...interfaceSources])].map(path => fileURLToPath(new URL(path, import.meta.url))).concat([native, schema, fileURLToPath(new URL('./build/Release/fs_ext.node', pathToFileURL(native)))]);
const loaded = Promise.all(requiredCapabilitySourcePaths.map(async (path) => ({ path, sha256: byteDigest(await readFile(path)) })));
void loaded.catch(() => undefined);
export async function assertCapabilitySourceClosure(pins: CapabilityRevisionBody['dependencies']) {
    if (new Set(pins.map(p => p.path)).size !== pins.length)
        fault('S8_DUPLICATE_DEPENDENCY_PATH');
    const expected = await loaded;
    if (expected.some(source => !pins.some(pin => pin.path === source.path && pin.sha256 === source.sha256)))
        fault('S8_LOADED_DEPENDENCY_CLOSURE_MISSING_OR_CHANGED', 503);
}
