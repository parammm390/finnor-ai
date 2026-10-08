import { createHash } from 'node:crypto';
import { hash, fault } from './contracts';

/** Independent BigInt decimal reference, not the producer's Decimal.js runtime.
 * Arithmetic rounds to the registered 34 significant digits, ties to even. */
class Q {
  constructor(readonly n: bigint, readonly d = 1n) { if (d <= 0n) fault('CHECKER_DENOMINATOR_INVALID'); }
  static decimal(value: unknown): Q {
    if (typeof value !== 'string' || value.length > 128) fault('CHECKER_DECIMAL_INVALID');
    const m = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(value);
    if (!m || Math.abs(Number(m[5] ?? 0)) > 100) fault('CHECKER_DECIMAL_INVALID');
    const fractional = m[3] ?? m[4] ?? '', digits = (m[2] ?? '0') + fractional, exponent = Number(m[5] ?? 0) - fractional.length;
    const n = BigInt(digits) * (m[1] === '-' ? -1n : 1n);
    return exponent >= 0 ? new Q(n * 10n ** BigInt(exponent)) : new Q(n, 10n ** BigInt(-exponent));
  }
  compare(b: Q) { const diff = this.n * b.d - b.n * this.d; return diff < 0n ? -1 : diff > 0n ? 1 : 0; }
  add(b: Q) { return new Q(this.n * b.d + b.n * this.d, this.d * b.d).significant(); }
  subtract(b: Q) { return new Q(this.n * b.d - b.n * this.d, this.d * b.d).significant(); }
  multiply(b: Q) { return new Q(this.n * b.n, this.d * b.d).significant(); }
  divide(b: Q) { if (!b.n) fault('CHECKER_DIVIDE_BY_ZERO'); return new Q(this.n * b.d * (b.n < 0n ? -1n : 1n), this.d * (b.n < 0n ? -b.n : b.n)).significant(); }
  negate() { return new Q(-this.n, this.d); }
  quantize(places: number): Q {
    const scale = 10n ** BigInt(Math.abs(places)), a = (this.n < 0n ? -this.n : this.n) * (places >= 0 ? scale : 1n), b = this.d * (places >= 0 ? 1n : scale);
    let integer = a / b; const remainder = a % b;
    if (remainder * 2n > b || remainder * 2n === b && integer % 2n !== 0n) integer++;
    integer *= this.n < 0n ? -1n : 1n;
    return places >= 0 ? new Q(integer, scale) : new Q(integer * scale);
  }
  significant() {
    if (!this.n) return new Q(0n);
    const magnitude = this.n < 0n ? -this.n : this.n;
    let exponent = magnitude.toString().length - this.d.toString().length;
    const below = exponent >= 0 ? magnitude < this.d * 10n ** BigInt(exponent) : magnitude * 10n ** BigInt(-exponent) < this.d;
    if (below) exponent--;
    if (Math.abs(exponent) > 100) fault('CHECKER_DECIMAL_LIMIT');
    return this.quantize(33 - exponent);
  }
  text() {
    if (!this.n) return '0';
    const sign = this.n < 0n ? '-' : '', n = this.n < 0n ? -this.n : this.n, integer = n / this.d;
    let remainder = n % this.d, fractional = '';
    for (let i = 0; remainder && i < 128; i++) { remainder *= 10n; fractional += String(remainder / this.d); remainder %= this.d; }
    if (remainder) fault('CHECKER_NONFINITE_DECIMAL');
    return sign + integer + (fractional ? '.' + fractional.replace(/0+$/, '') : '');
  }
}
type Check = (id: string, passed: boolean) => void;
function ownerCanonical(v: any): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(ownerCanonical).join(',') + ']';
  return '{' + Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ':' + ownerCanonical(v[k])).join(',') + '}';
}
const ownerHash = (v: unknown) => 'sha256:' + createHash('sha256').update(ownerCanonical(v)).digest('hex');

/** The finite acyclic scalar/series IR is registered; specialized circular LBO
 * schedules need a different independent numerical certificate, never a pass. */
export function assertUnderwritingCheckDomain(model: any) {
  if (!model || model.runtime || model.circularBlocks?.length || model.nodes?.length > 256 || model.periodDefinition?.count > 24 || model.nodes?.some((n: any) => n.kind === 'schedule')) fault('UNDERWRITING_INDEPENDENT_ORACLE_DOMAIN_UNSUPPORTED', 424);
}
export function checkUnderwriting(payload: Record<string, any>, output: Record<string, any>, check: Check) {
  const { model, snapshot, scenario } = payload; assertUnderwritingCheckDomain(model);
  const effective = structuredClone(snapshot);
  if (scenario) for (const override of scenario.overrides) {
    const input = effective.values[override.nodeId];
    if (!input) fault('CHECKER_SCENARIO_TARGET_UNKNOWN');
    input.value = override.value; input.truthClass = 'SCENARIO_OVERRIDE'; input.status = 'KNOWN';
    if (override.reason === undefined) delete input.reason; else input.reason = override.reason;
  }
  delete effective.semanticHash;
  check('UNDERWRITING_INPUT_COMMITMENT', output.inputSemanticHash === ownerHash(effective));
  const { schemaVersion, financialConventionVersion, minimumEngineVersion, periodDefinition, nodes, circularBlocks, runtime } = model;
  check('UNDERWRITING_MODEL_COMMITMENT', output.modelSemanticHash === ownerHash({ schemaVersion, financialConventionVersion, minimumEngineVersion, periodDefinition, nodes, circularBlocks, runtime }));
  const { resultSemanticHash, ...body } = output;
  check('UNDERWRITING_RESULT_COMMITMENT', resultSemanticHash === ownerHash(body));
  check('UNDERWRITING_VALID_FINISHED', output.status === 'SUCCEEDED' && output.validity === 'VALID' && output.engineVersion === 'finnor-underwriting-engine/1.0.0');
  const periods = referencePeriods(periodDefinition);
  const values: Record<string, any> = {}, evaluated = new Set<string>(), active = new Set<string>(), expectedChecks: any[] = [];
  const byId = new Map<string, any>(nodes.map((n: any) => [n.id, n]));
  const scalar = (v: any) => v instanceof Q ? v.text() : v;
  const numeric = (v: any) => v instanceof Q ? v : Q.decimal(v);
  const evaluation = (e: any, position?: number): any => {
    switch (e.op) {
      case 'literal': return e.valueType === 'decimal' ? Q.decimal(e.value) : e.value;
      case 'ref':
      case 'lag': {
        const node = byId.get(e.nodeId); if (!node) fault('CHECKER_DEPENDENCY_MISSING');
        const value = evaluateNode(node).value;
        if (node.shape === 'scalar') { if (e.op === 'lag') fault('CHECKER_SCALAR_LAG_INVALID'); return node.valueType === 'decimal' ? Q.decimal(value) : value; }
        const index = (position ?? -1) - (e.op === 'lag' ? e.periods : 0);
        if (!periods[index]) fault('CHECKER_PERIOD_UNAVAILABLE');
        return node.valueType === 'decimal' ? Q.decimal(value[periods[index]!]) : value[periods[index]!];
      }
      case 'negate': return numeric(evaluation(e.arg, position)).negate();
      case 'if': { const condition = evaluation(e.condition, position); if (typeof condition !== 'boolean') fault('CHECKER_CONDITION_INVALID'); return evaluation(condition ? e.then : e.else, position); }
      case 'compare': {
        const a = evaluation(e.left, position), b = evaluation(e.right, position);
        const cmp = a instanceof Q && b instanceof Q ? a.compare(b) : a === b ? 0 : String(a).localeCompare(String(b));
        return ({ eq: cmp === 0, ne: cmp !== 0, lt: cmp < 0, lte: cmp <= 0, gt: cmp > 0, gte: cmp >= 0 } as any)[e.comparison];
      }
      case 'add':
      case 'sum': return e.args.reduce((v: Q, a: any) => v.add(numeric(evaluation(a, position))), new Q(0n));
      case 'subtract': return numeric(evaluation(e.args[0], position)).subtract(numeric(evaluation(e.args[1], position)));
      case 'multiply': return e.args.reduce((v: Q, a: any) => v.multiply(numeric(evaluation(a, position))), new Q(1n));
      case 'divide': return numeric(evaluation(e.args[0], position)).divide(numeric(evaluation(e.args[1], position)));
      case 'min':
      case 'max': return e.args.map((a: any) => numeric(evaluation(a, position))).reduce((a: Q, b: Q) => (e.op === 'min' ? a.compare(b) <= 0 : a.compare(b) >= 0) ? a : b);
      default: return fault('CHECKER_EXPRESSION_UNSUPPORTED');
    }
  };
  function evaluateNode(node: any): any {
    if (evaluated.has(node.id)) return values[node.id];
    if (active.has(node.id)) fault('CHECKER_CYCLE_UNSUPPORTED');
    active.add(node.id); for (const id of node.dependencies) { if (!byId.has(id)) fault('CHECKER_MISSING_ANCESTOR'); evaluateNode(byId.get(id)); }
    let value: any, truthClass = 'DERIVED_VALUE';
    if (node.kind === 'input') {
      const input = effective.values[node.id];
      check('INPUT_METADATA:' + node.id, !!input && input.unit === node.unit && input.currency === node.currency && input.valueType === node.valueType && input.shape === node.shape && input.status === 'KNOWN' && input.value !== null && (!node.allowedTruthClasses || node.allowedTruthClasses.includes(input.truthClass)));
      if (!input || input.value === null) fault('CHECKER_UNKNOWN_INPUT');
      value = input.value; truthClass = input.truthClass;
      if (node.valueType === 'decimal') for (const v of node.shape === 'scalar' ? [value] : Object.values(value)) {
        const q = Q.decimal(v); check('INPUT_RANGE:' + node.id, (!node.minimum || q.compare(Q.decimal(node.minimum)) >= 0) && (!node.maximum || q.compare(Q.decimal(node.maximum)) <= 0));
      }
      if (node.shape === 'series') check('EXACT_INPUT_PERIODS:' + node.id, hash(Object.keys(value).sort()) === hash(periods.slice().sort()));
    } else if (node.kind === 'constant') { value = node.value; truthClass = 'MODEL_PARAMETER'; }
    else if (node.kind === 'expression') value = scalar(evaluation(node.expression));
    else if (node.kind === 'series') value = Object.fromEntries(periods.map((id, i) => [id, scalar(evaluation(node.expression, i))]));
    else if (node.kind === 'aggregate') {
      const series = evaluateNode(byId.get(node.sourceNodeId)).value, all = periods.map(id => series[id]);
      value = node.aggregation === 'first' ? all[0] : node.aggregation === 'last' ? all.at(-1) : scalar(node.aggregation === 'sum' ? all.reduce((v: Q, item) => v.add(Q.decimal(item)), new Q(0n)) : all.map(Q.decimal).reduce((a, b) => (node.aggregation === 'min' ? a.compare(b) <= 0 : a.compare(b) >= 0) ? a : b));
    } else if (node.kind === 'output') value = evaluateNode(byId.get(node.sourceNodeId)).value;
    else if (node.kind === 'check') {
      value = evaluation(node.assertion); check('VALID_ASSERTION:' + node.id, typeof value === 'boolean');
      expectedChecks.push({ nodeId: node.id, passed: value, severity: node.severity, code: node.failureCode, message: value ? 'Check passed' : 'Check failed' });
    } else fault('CHECKER_NODE_UNSUPPORTED');
    if (node.valueType === 'decimal') {
      const normalized = (v: any) => (node.rounding ? Q.decimal(v).quantize(node.rounding.decimalPlaces) : Q.decimal(v)).text();
      value = node.shape === 'scalar' ? normalized(value) : Object.fromEntries(Object.entries(value).map(([id, v]) => [id, normalized(v)]));
    }
    values[node.id] = { nodeId: node.id, value, unit: node.unit, ...(node.currency ? { currency: node.currency } : {}), shape: node.shape, valueType: node.valueType, truthClass, directDependencies: node.dependencies };
    active.delete(node.id); evaluated.add(node.id); return values[node.id];
  }
  for (const node of nodes) evaluateNode(node);
  check('EVERY_MATERIAL_ANCESTOR', hash(Object.keys(output.values ?? {}).sort()) === hash([...evaluated].sort()));
  for (const [id, expected] of Object.entries(values)) {
    const actual = output.values?.[id];
    check('EXACT_VALUE_LINEAGE:' + id, actual && Object.entries(expected).every(([k, v]) => hash(actual[k] ?? null) === hash(v ?? null)));
  }
  const outputIds = nodes.filter((n: any) => n.kind === 'output').map((n: any) => n.id);
  check('EXACT_OUTPUT_MEMBERSHIP', hash(Object.keys(output.outputs ?? {}).sort()) === hash(outputIds.sort()));
  for (const id of outputIds) check('OUTPUT_REFERENCE:' + id, hash(output.outputs[id]) === hash(output.values[id]));
  check('INDEPENDENT_ASSERTIONS', hash((output.checks ?? []).slice().sort((a: any, b: any) => a.nodeId.localeCompare(b.nodeId))) === hash(expectedChecks.sort((a, b) => a.nodeId.localeCompare(b.nodeId))));
  check('NO_SPECIALIZED_DIAGNOSTICS', output.solverDiagnostics?.length === 0 && !output.failure && !output.sponsorCashFlows);
  return { domain: 'ACYCLIC_GENERIC_UNDERWRITING_BIGINT34_TIES_EVEN', complete: true };
}
function referencePeriods(p: any) {
  const [year, month, day] = p.forecastStart.split('-').map(Number), months = p.frequency === 'annual' ? 12 : p.frequency === 'quarterly' ? 3 : 1;
  const at = (index: number) => { const first = new Date(Date.UTC(year, month - 1 + index * months, 1)); const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate(); return new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(day, last))); };
  return Array.from({ length: p.count }, (_, i) => { const end = at(i + 1); end.setUTCDate(end.getUTCDate() - 1); return `P${String(i + 1).padStart(3, '0')}:${at(i).toISOString().slice(0, 10)}:${end.toISOString().slice(0, 10)}`; });
}
