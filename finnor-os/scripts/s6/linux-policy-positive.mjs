import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {pbkdf2} from 'node:crypto';
import {promisify} from 'node:util';
import {Worker} from 'node:worker_threads';

await writeFile('positive-scratch','private');
assert.equal(await readFile('positive-scratch','utf8'),'private');
assert.equal((await promisify(pbkdf2)('synthetic','salt',4,16,'sha256')).length,16);
const worker=new Worker("require('node:worker_threads').parentPort.postMessage(7*6)",{eval:true});
const [value]=await Promise.all([
  new Promise((yes,no)=>{worker.once('message',yes);worker.once('error',no);}),
  new Promise((yes,no)=>{worker.once('exit',code=>code===0?yes():no(Error('Worker exit '+code)));worker.once('error',no);}),
]);
assert.equal(value,42);
console.log(JSON.stringify({value,privateReadWrite:true,asyncCrypto:true,workerThread:true}));
