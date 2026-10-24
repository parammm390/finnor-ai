// The native constructor runs off the queue's event loop. Only bounded data crosses.
import { parentPort, workerData } from 'node:worker_threads';
import { construct } from './constructor.generated.mjs';
const remaining = workerData.deadlineAt - Date.now();
if (remaining <= 0) throw Error('Y1_ORIGINAL_DEADLINE_EXPIRED');
const result = construct(JSON.parse(workerData.request), performance.now() + remaining);
const output = JSON.stringify(result);
if (Buffer.byteLength(output) > workerData.maxOutputBytes) throw Error('Y1_CONSTRUCTOR_OUTPUT_BOUND');
parentPort.postMessage(output);
