import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';

// Source-host adapter uses the installed, pinned workspace loader. Module
// locations come from the owner, never from a certificate or API request.
if (workerData.tsxRuntime) {
  const runtime = await import(pathToFileURL(workerData.tsxRuntime).href);
  (runtime.register ?? runtime.default?.register)();
}
const { verifyAllocationCertificate, certifyAllocationOptimization } = await import(workerData.checkerModule);
parentPort.on('message', ({ id, operation, serialized, deadlineAtEpoch }) => {
  try {
    if (!Number.isSafeInteger(id) || typeof serialized !== 'string' || Buffer.byteLength(serialized) > 8 * 1024 * 1024 || !Number.isFinite(deadlineAtEpoch)) throw Error('Invalid bounded verification request');
    const request = JSON.parse(serialized);
    const remaining = deadlineAtEpoch - Date.now();
    if (remaining <= 0 || remaining > 30000) throw Error('Verification deadline unavailable');
    if (operation === 'VERIFY') {
      verifyAllocationCertificate(request.problem, request.certificate, remaining);
      parentPort.postMessage({ id, ok: true });
    } else if (operation === 'CERTIFY') {
      const result = certifyAllocationOptimization(request.problem, request.selectedPolicyIds, { ...request.options, deadlineAt: performance.now() + remaining });
      const response = JSON.stringify(result);
      if (Buffer.byteLength(response) > 8 * 1024 * 1024) throw Error('Certification output exceeds bound');
      parentPort.postMessage({ id, ok: true, serialized: response });
    } else throw Error('Unsupported pure checker operation');
  } catch (error) {
    parentPort.postMessage({ id, ok: false, error: { name: error?.name, code: error?.code, message: String(error?.message ?? 'Worker proof failed').slice(0, 4096) } });
  }
});
