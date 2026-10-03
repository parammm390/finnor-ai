import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Reuse the native proofs and retain their full rerunnable evidence. No estimator
// or owner implementation is duplicated here; generated runs remain non-field.
describe('S7 native economic attribution proofs', () => {
  for (const family of ['statistical', 'integrated', 'owner', 'protected', 'maturity']) {
    it(`${family} owner proof`, async () => {
      const evidence = await mkdtemp(join(tmpdir(), `finnor-s7-ci-${family}-`));
      const log = openSync(join(evidence, 'runner.log'), 'w');
      const child = spawn(process.execPath, ['--import=tsx', `scripts/s7/run-${family}-e2e.mts`], {
        cwd: process.cwd(), env: { ...process.env, FINNOR_S7_EVIDENCE_DIR: evidence },
        detached: process.platform !== 'win32', stdio: ['ignore', log, log],
      });
      closeSync(log);
      const stop = (signal: NodeJS.Signals) => {
        if (!child.pid) return;
        try { if (process.platform === 'win32') child.kill(signal); else process.kill(-child.pid, signal); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      };
      let timedOut = false;
      let escalation: ReturnType<typeof setTimeout> | undefined;
      const timeout = setTimeout(() => {
        timedOut = true; stop('SIGTERM');
        escalation = setTimeout(() => stop('SIGKILL'), 2000); escalation.unref();
      }, 600_000);
      try {
        const exitCode = await new Promise<number | null>((resolve, reject) => {
          child.once('error', reject); child.once('close', resolve);
        });
        expect(timedOut, `Timed out; evidence: ${evidence}`).toBe(false);
        expect(exitCode, `Native proof failed; evidence: ${evidence}`).toBe(0);
        const bytes = await readFile(join(evidence, 'results.json'));
        const report = JSON.parse(bytes.toString());
        const cases = report.results ?? [report];
        expect(cases.length).toBeGreaterThan(0);
        expect(cases.every((result: { status: string }) => result.status === 'PASS')).toBe(true);
        expect(report.sourcesUnchanged).toBe(true);
        console.log(JSON.stringify({ family, evidence, cases: cases.length, sourcesUnchanged: true,
          artifactSha256: createHash('sha256').update(bytes).digest('hex'), qualification: report.qualification }));
      } finally {
        clearTimeout(timeout); if (escalation) clearTimeout(escalation);
        stop('SIGTERM');
      }
    }, 630_000);
  }
});
