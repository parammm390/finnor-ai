import assert from 'node:assert/strict';
import { availableParallelism } from 'node:os';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { assessEconomicAttribution } from '../../packages/epistemic-runtime/src/economic-attribution';
import { economicFixture } from './economic-fixtures.mjs';

type Trial = { score: number; covered: boolean; positiveCredit: boolean; width: number };
type Batch = { clusters: number; effect: number; draws: Float64Array };

function evaluateBatch({ clusters, effect, draws }: Batch): Trial[] {
  assert(clusters > 0 && draws.length > 0 && draws.length % clusters === 0, 'Invalid trial batch');
  let cursor = 0;
  const random = () => {
    assert(cursor < draws.length, 'Fixture exceeded its assigned draws');
    return draws[cursor++]!;
  };
  const results: Trial[] = [];
  for (let first = 0; first < draws.length; first += clusters) {
    const { input, truth, potential } = economicFixture(clusters, effect, undefined, random);
    assert.equal(cursor, first + clusters, 'Fixture must read one draw per cluster');
    const assessment = assessEconomicAttribution(input);
    const contrast = assessment.contrasts[0]!;
    assert.equal(contrast.identification, 'DESIGN_BASED_CONDITIONAL');
    const oracle = potential.reduce((total, row, index) =>
      total + Number(input.estimand.clusters[index].weight) * (row.assigned === 'finnor' ? row.finnor / .5 : -row.bau / .5), 0);
    const score = (Number(contrast.scoreInterval!.lower) + Number(contrast.scoreInterval!.upper)) / 2;
    assert(Math.abs(score - oracle) < 1e-9, 'Independent assignment-score oracle disagreed');
    assert(contrast.interval, 'Missing statistical interval');
    const lower = Number(contrast.interval.lower);
    const upper = Number(contrast.interval.upper);
    results.push({ score, covered: lower <= truth && upper >= truth, positiveCredit: lower > 0, width: upper - lower });
  }
  return results;
}

function collectWorker(worker: Worker, expected: number): Promise<Trial[]> {
  return new Promise((resolve, reject) => {
    let results: Trial[] | undefined;
    worker.once('message', (value: Trial[]) => { results = value; });
    worker.once('error', reject);
    worker.once('exit', code => {
      if (code === 0 && Array.isArray(results) && results.length === expected) resolve(results);
      else reject(new Error(`Statistical worker exited with code ${code} and ${results?.length ?? 0}/${expected} results`));
    });
  });
}

export async function evaluateTrials(clusters: number, effect: number, trials: number, random: () => number): Promise<Trial[]> {
  const draws = Float64Array.from({ length: clusters * trials }, random);
  if (availableParallelism() < 2 || trials < 2) return evaluateBatch({ clusters, effect, draws });

  const midpoint = Math.ceil(trials / 2) * clusters;
  const workers: Worker[] = [];
  try {
    const parts = await Promise.all([draws.subarray(0, midpoint), draws.subarray(midpoint)].map(part => {
      const worker = new Worker(new URL(import.meta.url), {
        execArgv: ['--import=tsx'],
        workerData: { clusters, effect, draws: part },
      });
      workers.push(worker);
      return collectWorker(worker, part.length / clusters);
    }));
    // Reduction in original trial order preserves the floating-point results.
    return parts.flat();
  } finally {
    await Promise.all(workers.map(worker => worker.terminate()));
  }
}

if (!isMainThread) parentPort!.postMessage(evaluateBatch(workerData));
