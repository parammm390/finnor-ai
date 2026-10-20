/** Bounded regular-language membership, never an untrusted backtracking regex. */
type Predicate = (character: string) => boolean;
type Expression =
  | { kind: "character"; test: Predicate }
  | { kind: "start" | "end" }
  | { kind: "sequence" | "choice"; children: Expression[] }
  | { kind: "repeat"; child: Expression; min: number; max: number };
type Instruction =
  | { kind: "character"; test: Predicate; next: number }
  | { kind: "start" | "end"; next: number }
  | { kind: "split"; next: number[] }
  | { kind: "accept" };
type Program = { instructions: Instruction[]; entry: number };
class UnsupportedPattern extends Error {}
const unsupported = (): never => { throw new UnsupportedPattern(); };
const cache = new Map<string, Program | null>();

function compile(pattern: string): Program | null {
  if (!pattern.length || pattern.length > 256) return null;
  const input = Array.from(pattern);
  let position = 0;
  const literal = (character: string) => ({ test: (value: string) => value === character, code: character.codePointAt(0)! });
  const unit = (inClass: boolean): { test: Predicate; code: number | null } => {
    const character = input[position++];
    if (character === undefined) return unsupported();
    if (character !== "\\") return literal(character);
    const escaped = input[position++];
    if (escaped === undefined || /^[1-9]$/.test(escaped)) return unsupported();
    if ("dDsSwW".includes(escaped)) {
      const positive: Predicate = escaped.toLowerCase() === "d" ? value => value >= "0" && value <= "9"
        : escaped.toLowerCase() === "w" ? value => /^[A-Za-z0-9_]$/.test(value)
          : value => /^\s$/u.test(value);
      return { code: null, test: escaped === escaped.toLowerCase() ? positive : value => !positive(value) };
    }
    const control: Record<string, string> = { n: "\n", r: "\r", t: "\t", f: "\f", v: "\v", "0": "\0" };
    if (Object.hasOwn(control, escaped)) {
      if (escaped === "0" && /^[0-9]$/.test(input[position] ?? "")) return unsupported();
      return literal(control[escaped]!);
    }
    if (!"^$\\.*+?()[]{}|/".includes(escaped) && !(inClass && escaped === "-")) return unsupported();
    return literal(escaped);
  };
  const expression = (depth: number): Expression => {
    if (depth > 32) return unsupported();
    const choices: Expression[] = [];
    while (true) {
      const sequence: Expression[] = [];
      while (position < input.length && !["|", ")"].includes(input[position]!)) {
        const token = input[position]!;
        let atom: Expression;
        if (token === "(") {
          position++;
          if (input[position] === "?") return unsupported();
          atom = expression(depth + 1);
          if (input[position++] !== ")") return unsupported();
        } else if (token === "[") {
          position++;
          const negative = input[position] === "^";
          if (negative) position++;
          const members: Predicate[] = [];
          while (position < input.length && input[position] !== "]") {
            const first = unit(true);
            if (input[position] === "-" && input[position + 1] !== "]" && position + 1 < input.length) {
              position++;
              const last = unit(true);
              if (first.code === null || last.code === null || first.code > last.code) return unsupported();
              const minimum = first.code, maximum = last.code;
              members.push(value => value.codePointAt(0)! >= minimum && value.codePointAt(0)! <= maximum);
            } else members.push(first.test);
          }
          if (input[position++] !== "]") return unsupported();
          atom = { kind: "character", test: value => negative !== members.some(member => member(value)) };
        } else if (token === "^" || token === "$") {
          position++; atom = { kind: token === "^" ? "start" : "end" };
        } else if (token === ".") {
          position++; atom = { kind: "character", test: value => !["\n", "\r", "\u2028", "\u2029"].includes(value) };
        } else {
          if ("*+?{}]".includes(token)) return unsupported();
          atom = { kind: "character", test: unit(false).test };
        }
        const quantifier = input[position];
        if (quantifier && "*+?{".includes(quantifier)) {
          if (atom.kind === "start" || atom.kind === "end") return unsupported();
          position++;
          let min = quantifier === "+" ? 1 : 0, max = quantifier === "?" ? 1 : Infinity;
          if (quantifier === "{") {
            const number = () => {
              let digits = "";
              while (/^[0-9]$/.test(input[position] ?? "")) digits += input[position++];
              const value = Number(digits);
              if (!digits || !Number.isSafeInteger(value) || value > 512) return unsupported();
              return value;
            };
            min = number(); max = min;
            if (input[position] === ",") { position++; max = input[position] === "}" ? Infinity : number(); }
            if (input[position++] !== "}" || max < min) return unsupported();
          }
          atom = { kind: "repeat", child: atom, min, max };
          if (input[position] === "?") position++; // Greediness cannot change membership.
        }
        sequence.push(atom);
      }
      choices.push({ kind: "sequence", children: sequence });
      if (input[position] !== "|") break;
      position++;
    }
    return choices.length === 1 ? choices[0]! : { kind: "choice", children: choices };
  };
  try {
    const parsed = expression(0);
    if (position !== input.length) return unsupported();
    const instructions: Instruction[] = [{ kind: "accept" }];
    const add = (instruction: Instruction) => {
      if (instructions.length >= 512) return unsupported();
      instructions.push(instruction); return instructions.length - 1;
    };
    const emit = (node: Expression, next: number): number => {
      if (node.kind === "character") return add({ ...node, next });
      if (node.kind === "start" || node.kind === "end") return add({ kind: node.kind, next });
      if (node.kind === "sequence") {
        let entry = next;
        for (const child of [...node.children].reverse()) entry = emit(child, entry);
        return entry;
      }
      if (node.kind === "choice") return add({ kind: "split", next: node.children.map(child => emit(child, next)) });
      if (node.kind !== "repeat") return unsupported();
      let entry = next;
      if (node.max === Infinity) {
        const split: Instruction & { kind: "split" } = { kind: "split", next: [next] };
        entry = add(split); split.next.push(emit(node.child, entry));
      } else for (let count = node.min; count < node.max; count++)
        entry = add({ kind: "split", next: [entry, emit(node.child, entry)] });
      for (let count = 0; count < node.min; count++) entry = emit(node.child, entry);
      return entry;
    };
    return { instructions, entry: emit(parsed, 0) };
  } catch (error) {
    if (error instanceof UnsupportedPattern) return null;
    throw error;
  }
}

/** null means outside the closed grammar/state bound, not a successful match. */
export function matchesApplicationSchemaPattern(pattern: string, value: string): boolean | null {
  if (!cache.has(pattern)) {
    if (cache.size >= 64) cache.delete(cache.keys().next().value!);
    cache.set(pattern, compile(pattern));
  }
  const program = cache.get(pattern);
  if (!program) return null;
  const characters = Array.from(value), { instructions, entry } = program;
  let incoming: number[] = [];
  for (let position = 0; position <= characters.length; position++) {
    const pending = [...incoming, entry], visited = new Set<number>(), active: number[] = [];
    while (pending.length) {
      const index = pending.pop()!;
      if (visited.has(index)) continue;
      visited.add(index);
      const instruction = instructions[index]!;
      if (instruction.kind === "split") pending.push(...instruction.next);
      else if (instruction.kind === "start") { if (position === 0) pending.push(instruction.next); }
      else if (instruction.kind === "end") { if (position === characters.length) pending.push(instruction.next); }
      else if (instruction.kind === "accept") return true;
      else active.push(index);
    }
    incoming = [];
    if (position === characters.length) break;
    for (const index of active) {
      const instruction = instructions[index]!;
      if (instruction.kind === "character" && instruction.test(characters[position]!)) incoming.push(instruction.next);
    }
  }
  return false;
}
