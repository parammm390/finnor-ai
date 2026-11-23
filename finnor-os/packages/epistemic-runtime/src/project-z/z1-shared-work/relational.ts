import {
  requireZ1, stable, type Columns, type Expression, type Node, type OriginalWork,
  type Predicate, type Relation, type Row, type Scalar, type Source, type TypedValue, type ValueType,
} from './contracts.js';

export interface Rational { n: bigint; d: bigint }
const abs = (n: bigint): bigint => n < 0n ? -n : n;
function rational(n: bigint, d: bigint): Rational {
  requireZ1(d !== 0n, 'ZERO_DENOMINATOR', 'COUNTEREXAMPLE');
  if (d < 0n) { n = -n; d = -d; }
  let a = abs(n), b = d;
  while (b) { const rest = a % b; a = b; b = rest; }
  n /= a; d /= a;
  requireZ1(abs(n).toString(2).length <= 512 && d.toString(2).length <= 512, 'RATIONAL_COMPONENT_BOUND', 'INCOMPLETE');
  return { n, d };
}
export function quantity(value: string): Rational {
  requireZ1(typeof value === 'string' && value.length <= 312 && /^-?(?:0|[1-9][0-9]*)(?:\/[1-9][0-9]*)?$/.test(value), 'EXACT_RATIONAL_TEXT_REQUIRED');
  const parts = value.split('/');
  return rational(BigInt(parts[0]!), BigInt(parts[1] ?? '1'));
}
export const qtext = (q: Rational): string => q.d === 1n ? String(q.n) : `${q.n}/${q.d}`;
export const qadd = (a: Rational, b: Rational): Rational => rational(a.n * b.d + b.n * a.d, a.d * b.d);
export const qneg = (a: Rational): Rational => ({ n: -a.n, d: a.d });
export const qsub = (a: Rational, b: Rational): Rational => qadd(a, qneg(b));
export const qmul = (a: Rational, b: Rational): Rational => rational(a.n * b.n, a.d * b.d);
export const qdiv = (a: Rational, b: Rational): Rational => rational(a.n * b.d, a.d * b.n);
export function qcmp(a: Rational, b: Rational): number {
  const difference = a.n * b.d - b.n * a.d;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}
const zero = (): Rational => ({ n: 0n, d: 1n });
export const numeric = (type: ValueType): type is Extract<ValueType, { kind: 'integer' | 'rational' }> =>
  type.kind === 'integer' || type.kind === 'rational';
export const sameType = (a: ValueType, b: ValueType): boolean => stable(a) === stable(b);
export function normalizeScalar(value: Scalar, type: ValueType): Scalar {
  if (numeric(type)) {
    requireZ1(typeof value === 'string', 'EXACT_NUMERIC_TEXT_REQUIRED');
    const q = quantity(value);
    requireZ1(type.kind !== 'integer' || q.d === 1n, 'INTEGER_TYPE_MISMATCH');
    requireZ1(type.unit === 'money' ? type.currency !== null : type.currency === null, 'CURRENCY_UNIT_MISMATCH');
    return qtext(q);
  }
  requireZ1(typeof value === (type.kind === 'text' ? 'string' : 'boolean'), 'SCALAR_TYPE_MISMATCH');
  return value;
}
export function normalizeRow(row: Row, columns: Columns): Row {
  requireZ1(stable(Object.keys(row).sort()) === stable(Object.keys(columns).sort()), 'EXACT_ROW_SCHEMA_REQUIRED');
  const result: Row = {};
  for (const [name, type] of Object.entries(columns)) result[name] = normalizeScalar(row[name]!, type);
  return result;
}
const getType = (columns: Columns, name: string): ValueType => {
  const type = columns[name]; requireZ1(type, 'ORIGINAL_FIELD_UNAVAILABLE'); return type;
};
export function expressionType(expression: Expression, columns: Columns, parameters: OriginalWork['parameters']): ValueType {
  switch (expression.op) {
    case 'field': return getType(columns, expression.name);
    case 'param': {
      const parameter = parameters[expression.name]; requireZ1(parameter, 'ORIGINAL_PARAMETER_UNAVAILABLE');
      normalizeScalar(parameter.value, parameter.type); return parameter.type;
    }
    case 'literal': normalizeScalar(expression.value, expression.type); return expression.type;
    case 'round': {
      const type = expressionType(expression.value, columns, parameters);
      requireZ1(numeric(type), 'ROUND_NUMERIC_REQUIRED'); return { ...type, kind: 'rational' };
    }
    default: {
      const left = expressionType(expression.left, columns, parameters), right = expressionType(expression.right, columns, parameters);
      requireZ1(numeric(left) && numeric(right), 'ARITHMETIC_NUMERIC_REQUIRED');
      const kind = expression.op !== 'div' && left.kind === 'integer' && right.kind === 'integer' ? 'integer' : 'rational';
      if (expression.op === 'add' || expression.op === 'sub') {
        requireZ1(left.unit === right.unit && left.currency === right.currency, 'ARITHMETIC_UNIT_MISMATCH');
        return { ...left, kind };
      }
      const dimensionless = (t: typeof left) => t.unit === '1' && t.currency === null;
      if (expression.op === 'mul') {
        requireZ1(dimensionless(left) || dimensionless(right), 'UNDECLARED_PRODUCT_UNIT');
        return { ...(dimensionless(left) ? right : left), kind };
      }
      requireZ1(dimensionless(right) || (left.unit === right.unit && left.currency === right.currency), 'UNDECLARED_DIVISION_UNIT');
      return dimensionless(right) ? { ...left, kind } : { kind, unit: '1', currency: null };
    }
  }
}
export function checkPredicate(predicate: Predicate, columns: Columns, parameters: OriginalWork['parameters']): void {
  if ('args' in predicate) {
    predicate.args.forEach(p => checkPredicate(p, columns, parameters)); return;
  }
  if (predicate.op === 'not') { checkPredicate(predicate.arg, columns, parameters); return; }
  const a = expressionType(predicate.left, columns, parameters), b = expressionType(predicate.right, columns, parameters);
  requireZ1(sameType(a, b), 'COMPARISON_TYPE_UNIT_MISMATCH');
  requireZ1(a.kind !== 'boolean' || predicate.op === 'eq' || predicate.op === 'ne', 'BOOLEAN_ORDER_UNSUPPORTED');
}
function round(q: Rational, places: number, mode: Extract<Expression, { op: 'round' }>['mode']): Rational {
  const scale = 10n ** BigInt(places), top = q.n * scale;
  let integer = top / q.d;
  const remainder = top % q.d, sign = top < 0n ? -1n : 1n;
  if (remainder) {
    if (mode === 'FLOOR' && sign < 0n) integer--;
    else if (mode === 'CEILING' && sign > 0n) integer++;
    else if (mode === 'HALF_EVEN' || mode === 'HALF_AWAY') {
      const difference = 2n * abs(remainder) - q.d;
      if (difference > 0n || difference === 0n && (mode === 'HALF_AWAY' || abs(integer) % 2n === 1n)) integer += sign;
    }
  }
  return rational(integer, scale);
}
export function evaluate(expression: Expression, row: Row, parameters: OriginalWork['parameters']): Scalar {
  if (expression.op === 'field') { const value = row[expression.name]; requireZ1(value !== undefined, 'ORIGINAL_FIELD_UNAVAILABLE'); return value; }
  if (expression.op === 'literal') return normalizeScalar(expression.value, expression.type);
  if (expression.op === 'param') {
    const p = parameters[expression.name]; requireZ1(p, 'ORIGINAL_PARAMETER_UNAVAILABLE'); return normalizeScalar(p.value, p.type);
  }
  if (expression.op === 'round') return qtext(round(quantity(evaluate(expression.value, row, parameters) as string), expression.places, expression.mode));
  const a = quantity(evaluate(expression.left, row, parameters) as string), b = quantity(evaluate(expression.right, row, parameters) as string);
  return qtext(({ add: qadd, sub: qsub, mul: qmul, div: qdiv })[expression.op](a, b));
}
export function compare(a: Scalar, b: Scalar, type: ValueType): number {
  if (numeric(type)) return qcmp(quantity(a as string), quantity(b as string));
  return a < b ? -1 : a > b ? 1 : 0;
}
function test(predicate: Predicate, row: Row, columns: Columns, parameters: OriginalWork['parameters']): boolean {
  if ('args' in predicate) return predicate.op === 'and'
    ? predicate.args.every(p => test(p, row, columns, parameters))
    : predicate.args.some(p => test(p, row, columns, parameters));
  if (predicate.op === 'not') return !test(predicate.arg, row, columns, parameters);
  const result = compare(evaluate(predicate.left, row, parameters), evaluate(predicate.right, row, parameters),
    expressionType(predicate.left, columns, parameters));
  return ({ eq: result === 0, ne: result !== 0, lt: result < 0, le: result <= 0, gt: result > 0, ge: result >= 0 })[predicate.op];
}
export function infer(node: Node, inputs: Relation[], parameters: OriginalWork['parameters'], source?: Source): Columns {
  const first = inputs[0]?.columns ?? {};
  switch (node.op) {
    case 'source': requireZ1(source, 'ORIGINAL_SOURCE_UNAVAILABLE'); return source.columns;
    case 'filter': checkPredicate(node.predicate, first, parameters); return first;
    case 'project': {
      requireZ1(Object.keys(node.fields).length > 0 && Object.keys(node.fields).length <= 128, 'PROJECTION_COLUMN_BOUND');
      return Object.fromEntries(Object.entries(node.fields).map(([name, value]) => [name, expressionType(value, first, parameters)]));
    }
    case 'join': {
      const right = inputs[1]!.columns, columns = { ...first };
      for (const key of node.on) requireZ1(sameType(getType(first, key.left), getType(right, key.right)), 'JOIN_TYPE_UNIT_MISMATCH');
      for (const [key, type] of Object.entries(right)) {
        requireZ1(!Object.hasOwn(columns, node.rightPrefix + key) && node.rightPrefix.length + key.length <= 128, 'JOIN_ALIAS_COLLISION');
        columns[node.rightPrefix + key] = type;
      }
      requireZ1(Object.keys(columns).length <= 128, 'JOIN_COLUMN_BOUND'); return columns;
    }
    case 'union':
      requireZ1(inputs.every(value => stable(value.columns) === stable(first)), 'UNION_SCHEMA_UNIT_MISMATCH'); return first;
    case 'sum': {
      requireZ1(new Set(node.keys).size === node.keys.length && Object.keys(node.values).length > 0, 'GROUP_SCHEMA_INVALID');
      const columns: Columns = Object.fromEntries(node.keys.map(key => [key, getType(first, key)]));
      for (const [name, expr] of Object.entries(node.values)) {
        const type = expressionType(expr, first, parameters);
        requireZ1(!Object.hasOwn(columns, name) && numeric(type), 'GROUP_TYPE_OR_ALIAS_MISMATCH'); columns[name] = type;
      }
      requireZ1(Object.keys(columns).length <= 128, 'DERIVED_COLUMN_BOUND');
      return columns;
    }
    case 'select': node.order.forEach(o => getType(first, o.field)); return first;
  }
}
export function canonicalRelation(relation: Relation, set = false): Relation {
  let rows = relation.rows;
  if (set) rows = [...new Map(rows.map(row => [stable(row), row])).values()];
  if (!relation.ordered || set) rows = rows.map(row => ({ row, key: stable(row) }))
    .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0).map(entry => entry.row);
  return { columns: relation.columns, rows, ordered: set ? false : relation.ordered };
}
export interface OperatorMeter { tick(count?: number): void; row(row: Row, derived: boolean): void }
export function execute(node: Node, inputs: Relation[], parameters: OriginalWork['parameters'], meter: OperatorMeter, source?: Source): Relation {
  const columns = infer(node, inputs, parameters, source), rows: Row[] = [];
  const first = inputs[0];
  const emit = (row: Row) => { meter.row(row, node.op !== 'source'); rows.push(row); };
  switch (node.op) {
    case 'source':
      for (const row of source!.rows) { meter.tick(); emit(normalizeRow(row, columns)); }
      return canonicalRelation({ columns, rows, ordered: false });
    case 'filter':
      for (const row of first!.rows) { meter.tick(); if (test(node.predicate, row, first!.columns, parameters)) emit(row); }
      return { columns, rows, ordered: first!.ordered };
    case 'project':
      for (const row of first!.rows) {
        meter.tick(); emit(Object.fromEntries(Object.entries(node.fields).map(([key, expression]) => [key, evaluate(expression, row, parameters)])));
      }
      return canonicalRelation({ columns, rows, ordered: first!.ordered }, node.semantics === 'set');
    case 'join': {
      const index = new Map<string, Row[]>();
      for (const row of inputs[1]!.rows) {
        meter.tick(); const key = stable(node.on.map(o => row[o.right]));
        const values = index.get(key) ?? []; values.push(row); index.set(key, values);
      }
      for (const row of first!.rows) {
        meter.tick(); const key = stable(node.on.map(o => row[o.left]));
        for (const right of index.get(key) ?? []) {
          meter.tick(); emit({ ...row, ...Object.fromEntries(Object.entries(right).map(([k, v]) => [node.rightPrefix + k, v])) });
        }
      }
      return canonicalRelation({ columns, rows, ordered: false });
    }
    case 'union':
      for (const input of inputs) for (const row of input.rows) { meter.tick(); emit(row); }
      return canonicalRelation({ columns, rows, ordered: false }, node.semantics === 'set');
    case 'sum': {
      const groups = new Map<string, { keys: Row; values: Record<string, Rational> }>();
      const empty = (row: Row) => ({ keys: Object.fromEntries(node.keys.map(key => [key, row[key]!])),
        values: Object.fromEntries(Object.keys(node.values).map(key => [key, zero()])) });
      if (!node.keys.length) groups.set('[]', empty({}));
      for (const row of first!.rows) {
        meter.tick(); const key = stable(node.keys.map(k => row[k])), group = groups.get(key) ?? empty(row);
        for (const [name, expression] of Object.entries(node.values)) {
          meter.tick(); group.values[name] = qadd(group.values[name]!, quantity(evaluate(expression, row, parameters) as string));
        }
        groups.set(key, group);
      }
      for (const group of groups.values()) emit({ ...group.keys, ...Object.fromEntries(Object.entries(group.values).map(([k, q]) => [k, qtext(q)])) });
      return canonicalRelation({ columns, rows, ordered: false });
    }
    case 'select': {
      const keyed = first!.rows.map(row => { meter.tick(); return { row, key: stable(row) }; });
      keyed.sort((a, b) => {
        meter.tick();
        for (const order of node.order) {
          const result = compare(a.row[order.field]!, b.row[order.field]!, columns[order.field]!);
          if (result) return order.direction === 'asc' ? result : -result;
        }
        return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
      });
      for (const entry of keyed.slice(0, node.limit)) emit(entry.row);
      return { columns, rows, ordered: true };
    }
  }
}
