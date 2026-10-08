import { fault, hash } from './contracts';
interface Rational { n: bigint; d: bigint }
/** Independent exact rational oracle. Never imports P4's candidate operators. */
const decimal = (text: string) => {
  if (typeof text !== 'string' || text.length > 256) fault('P4_CHECK_DECIMAL_INVALID');
  const m = /^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d{1,3}))?$/.exec(text);
  if (!m || Math.abs(Number(m[4] ?? 0)) > 100) fault('P4_CHECK_DECIMAL_INVALID');
  const exp = Number(m[4] ?? 0) - (m[3]?.length ?? 0), n = BigInt(m[2]! + (m[3] ?? '')) * (m[1] === '-' ? -1n : 1n);
  return exp >= 0 ? { n: n * 10n ** BigInt(exp), d: 1n } : { n, d: 10n ** BigInt(-exp) };
};
const equal = (a: string, b: { n: bigint; d: bigint }) => { const x = decimal(a); return x.n * b.d === b.n * x.d; };
const bounded = (q: Rational) => {
  if (q.n.toString().length > 1024 || q.d.toString().length > 1024) fault('P4_RATIONAL_ORACLE_BOUND_EXCEEDED');
  return q;
};
export function assertP4CheckDomain(payload: any) {
  if (!payload.program || payload.program.nodes.length > 64 || payload.program.outputs.length > 16 ||
    payload.program.nodes.some((n: any) => !['source', 'unique', 'add', 'subtract', 'multiply', 'ratio', 'growth'].includes(n.op)) ||
    Object.values(payload.sources ?? {}).some((r: any) => !Array.isArray(r) || r.length > 1000 ||
      r.some((row: any) => typeof row.value !== 'string' || row.value.length > 256))) fault('P4_INDEPENDENT_ORACLE_DOMAIN_UNSUPPORTED', 424);
}
export function checkP4Native(payload: any, result: any, check: (id: string, passed: boolean) => void) {
  assertP4CheckDomain(payload);
  const expected = new Map<string, { q: Rational; semantics: Record<string, any>; witnessIds: string[] }>(), sourceTables = new Map<string, any[]>();
  for (const node of payload.program.nodes) {
    if (node.op === 'source') {
      const rows = payload.sources[node.inputId];
      sourceTables.set(node.id, rows);
      const actual = result.native.nodes[node.id];
      check('P4_SOURCE_ROWS:' + node.id, hash(actual?.rows ?? []) === hash(rows) && actual?.kind === 'table' &&
        actual.value === null && actual.semantics === null && actual.truthClass === 'DERIVED_VALUE' &&
        hash(actual.qualification) === hash(['EXACT_SELECTED_ROWS']) &&
        hash(actual.witnessIds.slice().sort()) === hash([...new Set<string>(rows.flatMap((r: any) => r.witnessIds))].sort()));
    } else if (node.op === 'unique') {
      const rows = sourceTables.get(node.input) ?? [];
      check('P4_EXACT_UNIQUE_SOURCE:' + node.id, rows.length === 1);
      if (rows.length !== 1) fault('P4_UNIQUE_ORACLE_DOMAIN_UNSUPPORTED');
      const row = rows[0]; expected.set(node.id, { q: decimal(row.value), semantics: row.semantics, witnessIds: row.witnessIds });
    } else {
      const left = expected.get(node.left), right = expected.get(node.right);
      if (!left || !right) fault('P4_CHECK_ANCESTOR_UNAVAILABLE');
      const common = ['entityType', 'entityId', 'frequency', 'calendar', 'currencyCode', 'consolidation', 'instrument'];
      if (node.op !== 'growth') common.push('periodStart', 'periodEnd');
      check('P4_FINANCIAL_DIMENSIONS:' + node.id, common.every(k => left.semantics[k] === right.semantics[k]) &&
        (node.op === 'multiply' || left.semantics.unit === right.semantics.unit) &&
        !(node.op === 'multiply' && left.semantics.unit === 'currency' && right.semantics.unit === 'currency') &&
        [left, right].every(v => v.semantics.scale === '1' && v.semantics.sign === 'AS_RECORDED') &&
        (node.op !== 'growth' || Date.parse(left.semantics.periodStart) > Date.parse(right.semantics.periodStart) &&
          Date.parse(left.semantics.periodEnd) > Date.parse(right.semantics.periodEnd)));
      const a = left.q, b = right.q;
      let q: Rational;
      if (node.op === 'add' || node.op === 'subtract') q = { n: a.n * b.d + (node.op === 'add' ? 1n : -1n) * b.n * a.d, d: a.d * b.d };
      else if (node.op === 'multiply') q = { n: a.n * b.n, d: a.d * b.d };
      else {
        if (!b.n) fault('P4_CHECK_ZERO_DENOMINATOR');
        q = node.op === 'ratio' ? { n: a.n * b.d, d: a.d * b.n } : { n: a.n * b.d - b.n * a.d, d: a.d * b.n };
        if (q.d < 0n) { q.n = -q.n; q.d = -q.d; }
        const scale = 10n ** BigInt(node.decimalPlaces);
        check('P4_TERMINATING_DECLARED_PRECISION:' + node.id, q.n * scale % q.d === 0n);
      }
      expected.set(node.id, { q: bounded(q), semantics: { ...left.semantics, ...(node.op === 'ratio' ? { unit: 'multiple', currencyCode: null } : node.op === 'growth' ? { unit: 'rate', currencyCode: null } : {}) },
        witnessIds: [...new Set([...left.witnessIds, ...right.witnessIds])] });
    }
    const value = expected.get(node.id);
    if (value) {
      const actual = result.native.nodes[node.id];
      check('P4_EXACT_ANCESTOR:' + node.id, actual?.kind === 'scalar' && actual.value !== null && equal(actual.value, value.q) &&
        actual.truthClass === 'DERIVED_VALUE' && hash(actual.qualification) === hash([]) &&
        hash(actual.semantics) === hash(value.semantics) && hash(actual.witnessIds.slice().sort()) === hash(value.witnessIds.slice().sort()));
    }
  }
  check('P4_EXACT_NODE_MEMBERSHIP', hash(Object.keys(result.native.nodes).sort()) === hash(payload.program.nodes.map((n: any) => n.id).sort()));
  check('P4_EXACT_OUTPUT_MEMBERSHIP', hash(Object.keys(result.native.outputs).sort()) === hash(payload.program.outputs.slice().sort()));
  check('P4_ORIGINAL_CHECKED_OUTPUTS', hash(result.native.outputs) === hash(payload.expectedOutputs));
  check('P4_SELECTED_OUTPUT', hash(result.output) === hash(result.native.outputs[payload.output]));
  check('P4_NO_MATERIAL_CONTRADICTIONS', hash(result.native.contradictions) === hash([]));
  return { domain: 'P4_SOURCE_UNIQUE_EXACT_ARITHMETIC_BIGINT_RATIONAL', complete: true };
}
