import assert from 'node:assert/strict';
import {test} from 'node:test';
import {linuxKernelArchitecture} from '../../packages/governed-execution/src/executor-linux.js';

test('native kernel fields, not a QEMU uname executable, choose the ABI',()=>{
 assert.equal(linuxKernelArchitecture('processor : 0\nvendor_id : GenuineIntel\nflags : fpu sse2\n'),'x64');
 assert.equal(linuxKernelArchitecture('processor : 0\nCPU architecture : 8\nFeatures : fp asimd\n'),'arm64');
 assert.throws(()=>linuxKernelArchitecture('vendor_id : AuthenticAMD\nflags : fpu\nCPU architecture : 8\nFeatures : fp\n'),/ISOLATION_NATIVE_KERNEL_ABI_UNKNOWN/);
 for(const value of ['', 'processor : 0\n', 'CPU architecture : 7\nFeatures : neon\n'])
  assert.throws(()=>linuxKernelArchitecture(value),/ISOLATION_NATIVE_KERNEL_ABI_UNKNOWN/);
});
