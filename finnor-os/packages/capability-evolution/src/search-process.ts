/** Bounded ordinary computation; registered structural limits are not OS quotas. */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { CanonicalAllocationProblem } from '@finnor/shared-types';
import { canonical } from '../../governed-execution/src/protocol';
import { fault, type AllocationMethod } from './contracts';
import type { runAllocationMethod } from './search';
let live = 0;
export async function runAllocationMethodProcess(problem: CanonicalAllocationProblem, payload: AllocationMethod, options: {
    deadlineAt: number;
    maxExpansions: number;
}): Promise<ReturnType<typeof runAllocationMethod>> {
    if (live >= 2)
        fault('S8_SEARCH_CONCURRENCY_BOUND', 429);
    const remaining = Math.floor(options.deadlineAt - performance.now());
    if (remaining < 1 || remaining > 30000)
        fault('S8_SEARCH_WALL_BOUND');
    const input = canonical({ problem, payload, maxExpansions: options.maxExpansions, wallMs: remaining });
    if (Buffer.byteLength(input) > 8 * 1024 * 1024)
        fault('S8_SEARCH_INPUT_BOUND', 413);
    live++;
    return new Promise((ok, fail) => {
        const child = spawn(process.execPath, ['--import=tsx', fileURLToPath(new URL('./search-worker.mts', import.meta.url))], { env: { NODE_ENV: 'production', PATH: process.env.PATH, TMPDIR: process.env.TMPDIR }, stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '', stderr = '', error: Error | null = null, settled = false;
        const abort = (e: Error) => {
            if (error)
                return;
            error = e;
            child.kill('SIGKILL');
        };
        const timer = setTimeout(() => abort(Error('S8_SEARCH_WALL_DEADLINE')), Math.max(1, options.deadlineAt - performance.now()));
        child.stdout!.on('data', b => {
            if (error)
                return;
            stdout += b;
            if (Buffer.byteLength(stdout) > 2 * 1024 * 1024)
                abort(Error('S8_SEARCH_OUTPUT_BOUND'));
        });
        child.stderr!.on('data', b => {
            if (stderr.length < 4096)
                stderr += b.toString().slice(0, 4096 - stderr.length);
        });
        child.once('error', abort);
        child.stdin!.once('error', abort);
        child.once('close', (code, signal) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            live--;
            if (error) {
                fail(error);
                return;
            }
            if (code !== 0 || signal) {
                fail(Error('S8_SEARCH_PROCESS_FAILURE:' + code + ':' + signal));
                return;
            }
            try {
                const result = JSON.parse(stdout);
                if (result.schema !== 'finnor.s8.allocation-search-result.v1')
                    throw Error('S8_SEARCH_RESULT_SCHEMA');
                ok(result);
            }
            catch (e) {
                fail(e);
            }
        });
        child.stdin!.end(input);
    });
}
