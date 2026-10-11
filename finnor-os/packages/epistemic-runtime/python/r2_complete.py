#!/usr/bin/env python3
"""Bounded exact weak-linear VIPR completion; final VIPR remains mandatory.

Implements the pinned VIPR 1.1 weak-linear rule using Fraction and named
global/local bound rows, exact single-z primal reconstruction, and unchanged
multi-continuous primal checking. General incomplete derivations refuse. This does not
certify a result: the unchanged native VIPR checker verifies the output anew.
"""
import re
import sys
from fractions import Fraction as F
from pathlib import Path


def require(ok, reason):
    if not ok:
        raise ValueError(reason)


def row(tokens, objective):
    sense, rhs = tokens[1], F(tokens[2])
    require(sense in ('E', 'G', 'L'), 'COMPLETION_ROW_SENSE')
    if tokens[3] == 'OBJ':
        return sense, rhs, dict(objective)
    n = int(tokens[3])
    require(len(tokens) >= 4+2*n, 'COMPLETION_PARTIAL_ROW')
    terms = {int(tokens[4+2*j]): F(tokens[5+2*j]) for j in range(n)}
    require(len(terms) == n, 'COMPLETION_DUPLICATE_TERM')
    return sense, rhs, {k: v for k, v in terms.items() if v}


def weak_combination(rows, sense, wanted, combination, available, reconstruct=False):
    """Certify a linear derivation; reconstruction is only a bounded hint."""
    n = int(combination[0])
    multipliers, combined, side = {}, {}, F(0)
    for j in range(n):
        reference, multiplier = int(combination[1+2*j]), F(combination[2+2*j])
        if reconstruct:
            multiplier = multiplier.limit_denominator(1000000)
        require(0 <= reference < len(rows), 'WEAK_FORWARD_REFERENCE')
        s, b, vector = rows[reference]
        require(s == 'E' or multiplier == 0 or (s == sense) == (multiplier > 0), 'WEAK_MULTIPLIER_DIRECTION')
        multipliers[reference] = multipliers.get(reference, F(0))+multiplier
        side += multiplier*b
        for variable, coefficient in vector.items():
            combined[variable] = combined.get(variable, F(0))+multiplier*coefficient
    for variable in sorted(set(wanted) | set(combined)):
        delta = wanted.get(variable, F(0))-combined.get(variable, F(0))
        if delta:
            s = sense if delta > 0 else ('G' if sense == 'L' else 'L')
            require((variable, s) in available, 'WEAK_MISSING_BOUND')
            reference = available[variable, s]
            multipliers[reference] = multipliers.get(reference, F(0))+delta
            side += delta*rows[reference][1]
    return multipliers, side


def complete(source, target):
    lines = Path(source).read_text().splitlines()
    require(sum(len(x)+1 for x in lines) <= 8388608, 'COMPLETION_BYTE_LIMIT')
    objective, rows, bounds, count, completed = {}, [], {}, 0, 0
    variables, integral, continuous, primal_completed, primal_verified = [], set(), None, 0, 0
    infeasible, derivation_header = False, None
    section = None
    for index, line in enumerate(lines):
        tokens = line.split()
        if not tokens or tokens[0].startswith(('#', '%')):
            continue
        if tokens[0] in ('VER', 'VAR', 'INT', 'OBJ', 'CON', 'RTP', 'SOL', 'DER'):
            section = tokens[0]
            if section == 'CON':
                count = int(tokens[1])
            elif section == 'RTP':
                infeasible = tokens[1] == 'infeas'
            elif section == 'DER':
                derivation_header = index
            continue
        if section == 'VAR':
            variables.extend(tokens)
        elif section == 'INT':
            integral.update(int(x) for x in tokens)
        elif section == 'OBJ':
            n = int(tokens[0])
            objective = {int(tokens[1+2*j]): F(tokens[2+2*j]) for j in range(n)}
        elif section == 'CON':
            parsed = row(tokens, objective)
            rows.append(parsed)
            sense, rhs, vector = parsed
            if len(vector) == 1 and sense in ('G', 'L'):
                v, coefficient = next(iter(vector.items()))
                if coefficient == 1:
                    bounds[v, sense] = len(rows)-1
            if len(rows) == count:
                section = None
        elif section == 'SOL':
            # Reconstruct only the original single-z profile. Other continuous
            # assignments must already satisfy every exact original row/bound;
            # no replacement transfers or financial feasibility are invented.
            if continuous is None:
                free = set(range(len(variables))) - integral
                require(free, 'PRIMAL_CONTINUOUS_DOMAIN')
                if len(free) == 1:
                    continuous = free.pop()
                    require(variables[continuous] in ('z', 't_z'), 'PRIMAL_SINGLE_Z_DOMAIN')
                else:
                    continuous = -1
            n = int(tokens[1])
            require(len(tokens) == 2+2*n, 'PRIMAL_PARTIAL_ASSIGNMENT')
            values = {int(tokens[2+2*j]): F(tokens[3+2*j]) for j in range(n)}
            require(len(values) == n and set(values) <= set(range(len(variables))), 'PRIMAL_VARIABLE_DOMAIN')
            require(all(values.get(i, F(0)).denominator == 1 for i in integral), 'PRIMAL_INTEGRAL_ASSIGNMENT')
            if continuous == -1:
                for sense, rhs, vector in rows:
                    value = sum((coefficient*values.get(i, F(0)) for i, coefficient in vector.items()), F(0))
                    require(value == rhs if sense == 'E' else value <= rhs if sense == 'L' else value >= rhs,
                            'PRIMAL_FULL_CONTINUOUS_CONSTRAINT')
                primal_verified += 1
                continue
            lower, upper = None, None
            for sense, rhs, vector in rows:
                coefficient = vector.get(continuous, F(0))
                residual = rhs-sum(c*values.get(i, F(0)) for i, c in vector.items() if i != continuous)
                if not coefficient:
                    require(residual == 0 if sense == 'E' else residual >= 0 if sense == 'L' else residual <= 0,
                            'PRIMAL_INTEGRAL_CONSTRAINT')
                    continue
                limit = residual/coefficient
                side = sense if coefficient > 0 else ('G' if sense == 'L' else 'L' if sense == 'G' else 'E')
                if side in ('G', 'E'):
                    lower = limit if lower is None else max(lower, limit)
                if side in ('L', 'E'):
                    upper = limit if upper is None else min(upper, limit)
            require(upper is not None and (lower is None or lower <= upper), 'PRIMAL_Z_INTERVAL')
            values[continuous] = upper
            pairs = [(i, v) for i, v in sorted(values.items()) if v]
            lines[index] = tokens[0]+' '+str(len(pairs))+' '+' '.join(str(i)+' '+str(v) for i, v in pairs)
            primal_completed += 1
        elif section == 'DER':
            parsed = row(tokens, objective)
            require('incomplete' not in tokens, 'GENERAL_INCOMPLETE_DERIVATION_UNSUPPORTED')
            match = re.search(r'\{\s*lin\s+weak\s*\{([^{}]*)\}\s*([^{}]*)\}', line)
            if 'weak' in tokens:
                require(match is not None, 'UNSUPPORTED_WEAK_DERIVATION')
                local, combination = match.group(1).split(), match.group(2).split()
                nlocal, n = int(local[0]), int(combination[0])
                require(len(local) == 1+4*nlocal and len(combination) == 1+2*n, 'PARTIAL_WEAK_DERIVATION')
                available = dict(bounds)
                for j in range(nlocal):
                    side, variable, reference, value = local[1+4*j:5+4*j]
                    reference, variable = int(reference), int(variable)
                    require(0 <= reference < len(rows), 'LOCAL_BOUND_REFERENCE')
                    s = 'L' if side == 'U' else 'G' if side == 'L' else None
                    require(rows[reference] == (s, F(value), {variable: F(1)}), 'LOCAL_BOUND_PREIMAGE')
                    available[variable, s] = reference
                sense, rhs, wanted = parsed
                require(sense in ('L', 'G'), 'WEAK_EQUALITY_UNSUPPORTED')
                multipliers, side = weak_combination(rows, sense, wanted, combination, available)
                if not (side <= rhs if sense == 'L' else side >= rhs):
                    # Never round an original row, RHS, assignment or objective.
                    # This candidate is itself proved exactly before rewriting
                    # a derived weak intermediate; native VIPR checks all users.
                    proposed = wanted if tokens[3] == 'OBJ' else {
                        variable: coefficient.limit_denominator(1000000)
                        for variable, coefficient in wanted.items()}
                    proposed = {variable: coefficient for variable, coefficient in proposed.items() if coefficient}
                    candidate, candidate_side = weak_combination(rows, sense, proposed, combination, available, True)
                    require(candidate_side <= rhs if sense == 'L' else candidate_side >= rhs,
                            'WEAK_NOT_EXACTLY_DOMINATED')
                    wanted, multipliers, side = proposed, candidate, candidate_side
                    parsed = sense, rhs, wanted
                    if tokens[3] != 'OBJ':
                        line = tokens[0]+' '+sense+' '+str(rhs)+' '+str(len(wanted))+' '+\
                            ' '.join(str(variable)+' '+str(coefficient) for variable, coefficient in sorted(wanted.items()))+\
                            ' '+line[match.start():]
                        match = re.search(r'\{\s*lin\s+weak\s*\{([^{}]*)\}\s*([^{}]*)\}', line)
                require(side <= rhs if sense == 'L' else side >= rhs, 'WEAK_NOT_EXACTLY_DOMINATED')
                pairs = [(i, v) for i, v in sorted(multipliers.items()) if v]
                replacement = '{ lin '+str(len(pairs))+' '+' '.join(str(i)+' '+str(v) for i, v in pairs)+' }'
                lines[index] = line[:match.start()]+replacement+line[match.end():]
                completed += 1
            rows.append(parsed)
    require(not any(re.search(r'\b(weak|incomplete)\b', x) for x in lines), 'COMPLETION_HOLE_REMAINS')
    if infeasible and derivation_header is not None and rows[-1][2]:
        # VIPR requires an explicit constant contradiction, not an implicit
        # impossible activity interval. Use only already-proved finite bounds.
        sense, rhs, vector = rows[-1]
        require(sense in ('L', 'G'), 'INFEASIBILITY_TERMINAL_SENSE')
        combination = [(len(rows)-1, F(1))]
        constant = rhs
        for variable, coefficient in sorted(vector.items()):
            side = ('G' if coefficient > 0 else 'L') if sense == 'L' else ('L' if coefficient > 0 else 'G')
            require((variable, side) in bounds, 'INFEASIBILITY_FINITE_BOUND_MISSING')
            reference = bounds[variable, side]
            combination.append((reference, -coefficient))
            constant -= coefficient*rows[reference][1]
        require(constant < 0 if sense == 'L' else constant > 0, 'INFEASIBILITY_CONSTANT_NOT_CONTRADICTORY')
        lines[derivation_header] = 'DER '+str(int(lines[derivation_header].split()[1])+1)
        lines.append('ExactBoundContradiction '+sense+' '+str(constant)+' 0 { lin '+str(len(combination))+' '+
                     ' '.join(str(reference)+' '+str(multiplier) for reference, multiplier in combination)+' } -1')
    output = '\n'.join(lines)+'\n'
    require(len(output.encode()) <= 8388608, 'COMPLETION_OUTPUT_LIMIT')
    with Path(target).open('x') as file:
        file.write(output)
    print('EXACT_WEAK_LINEAR_COMPLETION '+str(completed)+' EXACT_SINGLE_Z_PRIMAL_COMPLETION '+str(primal_completed))
    if primal_verified:
        print('EXACT_UNCHANGED_CONTINUOUS_PRIMAL_VERIFIED '+str(primal_verified))


if __name__ == '__main__':
    try:
        complete(sys.argv[1], sys.argv[2])
    except (ValueError, KeyError, IndexError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(2)
