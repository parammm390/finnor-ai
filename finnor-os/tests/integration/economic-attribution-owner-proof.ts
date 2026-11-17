import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

type ProofFamily = 'statistical' | 'integrated' | 'owner' | 'protected' | 'maturity';

// All proofs use the original process and its private evidence directory.
export function registerEconomicAttributionProof(family: ProofFamily, partition?: 1 | 2 | 3) {
  const label = partition ? `${family}-${partition}-of-3` : family;
  it(`${label} owner proof`, async () => {
    const evidenceRoot = process.env.FINNOR_S7_CI_EVIDENCE_DIR ?? tmpdir();
    await mkdir(evidenceRoot, { recursive: true });
    const evidence = await mkdtemp(join(evidenceRoot, `finnor-s7-ci-${label}-`));
    const log = openSync(join(evidence, 'runner.log'), 'w');
    const args = ['--import=tsx', `scripts/s7/run-${family}-e2e.mts`];
    if (partition) args.push(`--partition=${partition}/3`);
    const child = spawn(process.execPath, args, {
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
      if (partition) expect(report.partition).toEqual({ index: partition, count: 3 });
      expect(cases.every((result: { status: string }) => result.status === 'PASS')).toBe(true);
      expect(report.sourcesUnchanged).toBe(true);
      console.log(JSON.stringify({ family, partition, evidence, cases: cases.length, sourcesUnchanged: true,
        artifactSha256: createHash('sha256').update(bytes).digest('hex'), qualification: report.qualification }));
    } catch (error) {
      const diagnostics = await readFile(join(evidence, 'runner.log'), 'utf8').catch(() => 'Child log unavailable');
      console.error(`Native ${label} failure; full evidence: ${evidence}\n${diagnostics.slice(-12_000)}`);
      throw error;
    } finally {
      clearTimeout(timeout); if (escalation) clearTimeout(escalation);
      stop('SIGTERM');
    }
  }, 630_000);
}
