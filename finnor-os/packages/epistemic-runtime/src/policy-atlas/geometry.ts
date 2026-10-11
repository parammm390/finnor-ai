import type { AtlasAffine, AtlasBuildBudget, AtlasFacet, AtlasGeometry } from '../../../shared-types/src/decision-atlas';
import { AtlasError, affineKey, div, encode, evaluate, holds, mul, negate, O, Q, rational, sign, sub, sum, Z } from './exact';

export class GeometryMeter {
  bases = 0;
  readonly deadline: number;
  constructor(readonly budget: AtlasBuildBudget) { this.deadline = performance.now() + budget.deadlineMs; }
  tick(basis = false): void {
    if (basis && ++this.bases > this.budget.maxTotalBases) throw new AtlasError('TOTAL_BASIS_LIMIT');
    if (performance.now() >= this.deadline) throw new AtlasError('BUILD_DEADLINE');
  }
}
/** Exact independent rows and inconsistency. No floating pivots/tolerances. */
export function rowReduce(input: Q[][], n: number): { rows: Q[][]; pivots: number[]; inconsistent: boolean } {
  const rows = input.map(row => [...row]), pivots: number[] = [];
  for (let column = 0, rank = 0; column < n && rank < rows.length; column++) {
    const next = rows.findIndex((row, i) => i >= rank && row[column]!.n !== 0n);
    if (next < 0) continue;
    [rows[rank], rows[next]] = [rows[next]!, rows[rank]!];
    const factor = rows[rank]![column]!;
    rows[rank] = rows[rank]!.map(v => div(v, factor));
    for (let i = 0; i < rows.length; i++) if (i !== rank && rows[i]![column]!.n) {
      const f = rows[i]![column]!;
      rows[i] = rows[i]!.map((v, j) => sub(v, mul(f, rows[rank]![j]!)));
    }
    pivots.push(column); rank++;
  }
  return { rows: rows.filter(row => row.slice(0, n).some(v => v.n)),
    pivots, inconsistent: rows.some(row => row.slice(0, n).every(v => !v.n) && row[n]!.n !== 0n) };
}
function* subsets(size: number, count: number, prefix: number[] = [], start = 0): Generator<number[]> {
  if (!count) { yield prefix; return; }
  for (let i = start; i <= size - count; i++) yield* subsets(size, count - 1, [...prefix, i], i + 1);
}
function deduplicate(facets: AtlasFacet[]): AtlasFacet[] {
  const rows = new Map<string, AtlasFacet>();
  for (const facet of facets) rows.set(facet.relation + ':' + affineKey(facet.expression), facet);
  return [...rows.values()];
}
function closureVertices(facets: AtlasFacet[], n: number, meter: GeometryMeter): Q[][] {
  meter.tick();
  const f = deduplicate(facets);
  if (f.length > meter.budget.maxFacets + 2) throw new AtlasError('CELL_FACET_LIMIT');
  const equation = (x: AtlasAffine): Q[] => [...x.a.map(v => rational(v)), negate(rational(x.b))];
  const eq = rowReduce(f.filter(f => f.relation === 'EQ').map(f => equation(f.expression)), n);
  if (eq.inconsistent) return [];
  const inequalities = f.filter(f => f.relation !== 'EQ'), vertices = new Map<string, Q[]>(), need = n - eq.pivots.length;
  let local = 0;
  for (const selected of subsets(inequalities.length, need)) {
    meter.tick(true); if (++local > meter.budget.maxBases) throw new AtlasError('CELL_BASIS_LIMIT');
    const reduced = rowReduce([...eq.rows, ...selected.map(i => equation(inequalities[i]!.expression))], n);
    if (reduced.inconsistent || reduced.pivots.length !== n) continue;
    const point: Q[] = Array(n).fill(Z);
    for (let i = 0; i < n; i++) point[reduced.pivots[i]!] = reduced.rows[i]![n]!;
    if (f.every(f => holds(f, point, true))) vertices.set(point.map(encode).join(','), point);
  }
  return [...vertices.values()].sort((a, b) => a.map(encode).join(',').localeCompare(b.map(encode).join(',')));
}
export function geometry(facets: AtlasFacet[], n: number, meter: GeometryMeter): AtlasGeometry | null {
  const vertices = closureVertices(facets, n, meter);
  if (!vertices.length) return null; // Domain coordinate bounds establish boundedness.
  let witness: Q[], slack: Q = O;
  if (facets.some(f => f.relation === 'LT')) {
    const augmented = facets.map(f => ({ relation: f.relation === 'EQ' ? 'EQ' as const : 'LE' as const,
      expression: { a: [...f.expression.a, f.relation === 'LT' ? '1/1' : '0/1'], b: f.expression.b } }));
    augmented.push({ relation: 'LE', expression: { a: [...Array(n).fill('0/1'), '-1/1'], b: '0/1' } },
      { relation: 'LE', expression: { a: [...Array(n).fill('0/1'), '1/1'], b: '-1/1' } });
    const candidates = closureVertices(augmented, n + 1, meter).filter(point => point[n]!.n > 0n);
    if (!candidates.length) return null;
    const average = (i: number) => div(sum(candidates.map(point => point[i]!)), rational(`${candidates.length}/1`));
    witness = Array.from({ length: n }, (_, i) => average(i)); slack = average(n);
  } else {
    const count = rational(`${vertices.length}/1`);
    witness = Array.from({ length: n }, (_, i) => div(sum(vertices.map(point => point[i]!)), count));
  }
  if (!facets.every(f => holds(f, witness))) throw new AtlasError('NONEMPTY_WITNESS_FAILED');
  const differences = vertices.slice(1).map(point => [...point.map((q, i) => sub(q, vertices[0]![i]!)), Z]);
  return { basis: 'COMPLETE_BOUNDED_ACTIVE_BASIS_VERTICES_AND_COMMON_SLACK', vertices: vertices.map(point => point.map(encode)),
    witness: witness.map(encode), slack: encode(slack), affineDimension: rowReduce(differences, n).pivots.length };
}
export type CellSign = -1 | 0 | 1 | 'SPLIT';
export function cellSign(expression: AtlasAffine, facets: AtlasFacet[], cell: AtlasGeometry, meter: GeometryMeter): CellSign {
  meter.tick();
  const values = cell.vertices.map(point => evaluate(expression, point.map(v => rational(v))));
  const low = values.reduce((a, b) => a.compare(b) <= 0 ? a : b), high = values.reduce((a, b) => a.compare(b) >= 0 ? a : b);
  if (!low.n && !high.n) return 0;
  if (low.n > 0n) return 1;
  if (high.n < 0n) return -1;
  if (low.n < 0n && high.n > 0n) return 'SPLIT';
  // Closure validity does not exclude equality on a closed boundary. Prove
  // exact zero intersection empty before making a strict/tie-exclusion claim.
  const zeroIntersection = geometry([...facets, { expression, relation: 'EQ' }], expression.a.length, meter);
  if (zeroIntersection) return 'SPLIT';
  return sign(low.n ? low : high);
}
export function splitFacets(expression: AtlasAffine): [AtlasFacet, AtlasFacet, AtlasFacet] {
  return [{ expression, relation: 'LT' }, { expression, relation: 'EQ' },
    { expression: { a: expression.a.map(v => encode(negate(rational(v)))), b: encode(negate(rational(expression.b))) }, relation: 'LT' }];
}
