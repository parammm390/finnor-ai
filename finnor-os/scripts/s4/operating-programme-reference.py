"""Independent exhaustive E2E reference over original S3 kernel + owner charter.
No FINNOR compiler/search/accounting import. This checks a static full-horizon
programme domain, not field causality, future demand or protected authority.
Finance/threshold inputs remain retained FLOAT64 decimals; comparison is exact
over those decimals. Cross-language trajectory agreement has 1e-6 tolerance.
The parent retains this input, output, source digest and invocation to rerun.
"""
import copy
import itertools
import json
import math
import sys
from fractions import Fraction


def main(x):
    m, p, model, kernel = (x[k] for k in ('mandate', 'problem', 'model', 'kernel'))
    a, s, h = m['utility']['operatingProfit'], p['programmeSpace'], m['horizon']['periods']
    assert not p['obligations'] and not p['observations'] and not p.get('continuation')
    assert 1 <= h <= 24 and m['utility']['discountFactors'] == [1] * (h + 1)
    assert math.prod(len(l['options']) for l in s['levers']) <= 256
    initial = copy.deepcopy(model['history']['rows'][-3:])
    ranges = {v['id']: v['range'] for v in model['request']['stateVariables']}

    def atom(f, history, exposure):
        if f['kind'] == 'CONSTANT':
            return 1.0
        if f['kind'] == 'EXPOSURE' and f['lag'] == 0:
            return exposure[f['id']]
        return history[-f['lag']]['states' if f['kind'] == 'STATE' else 'exposures'][f['id']]

    def feature(f, history, exposure):
        return atom(f['left'], history, exposure) * atom(f['right'], history, exposure) if f['kind'] == 'PRODUCT' else atom(f, history, exposure)

    def in_support(hull, row):
        if not hull['available']:
            return False
        delta = [v - c for v, c in zip(row, hull['center'])]
        projected = [sum(v * hull['basis'][i][j] for i, v in enumerate(delta)) for j in range(hull['rank'])]
        if any(abs(v - sum(projected[j] * hull['basis'][i][j] for j in range(hull['rank']))) > 1e-8 for i, v in enumerate(delta)):
            return False
        if hull['rank'] == 0:
            return True
        if hull['rank'] == 1:
            return hull['range'][0] - 1e-8 <= projected[0] <= hull['range'][1] + 1e-8
        return all(row[-1] + sum(v * row[i] for i, v in enumerate(projected)) <= 1e-8 for row in hull['halfspaces'])

    def advance(history, exposure, mechanism, world, t):
        states, supported = {}, True
        for j, equation in enumerate(mechanism['equations']):
            row = [feature(f, history, exposure) for f in equation['features']]
            value = sum(v * b for v, b in zip(row, world['coefficients'][j])) + world['shocks'][t][j]
            low, high = ranges[equation['variableId']]
            supported &= in_support(mechanism['support'][j], row) and math.isfinite(value) and low <= value <= high
            states[equation['variableId']] = value
        return history + [{'states': states, 'exposures': exposure}], supported

    def read(driver, states):
        v = driver['value'] if driver['kind'] == 'CONSTANT' else states[driver['variableId']]
        assert math.isfinite(v) and 0 <= v <= 1e9
        return v

    def ledger(previous, states, fee):
        r = lambda key: read(a[key], states)
        revenue = sum(read(g['netUnitPrice'], states) * read(g['unitsSold'], states) / float(a['moneyScale']) for g in a['segments'])
        variable = sum(read(g['variableUnitCost'], states) * read(g['unitsSold'], states) / float(a['moneyScale']) for g in a['segments'])
        operating = revenue - variable - r('fixedOperatingCost') - r('depreciationAmortization') - fee
        stock_movements = [read(a[k], states) - read(a[k], previous) for k in ['accountsReceivable', 'inventory']]
        stock_movements.append(read(a['accountsPayable'], previous) - read(a['accountsPayable'], states))
        fcf = operating + r('depreciationAmortization') - r('cashTaxes') - r('capitalExpenditure') - sum(stock_movements)
        n = a['netProfit']
        net = operating - read(n['financingExpense'], states) - read(n['incomeTaxExpense'], states) + read(n['otherIncome'], states) - read(n['otherExpense'], states)
        funding = sum(max(0.0, movement) for movement in stock_movements)
        gross = variable + r('fixedOperatingCost') + fee + r('cashTaxes') + r('capitalExpenditure') + funding + r('nonOperatingCashOutflow')
        return {'netProfit': net, 'freeCashFlow': fcf, 'nonOperatingNetCashFlow': r('nonOperatingCashInflow') - r('nonOperatingCashOutflow'), 'grossCashOutflow': gross}

    def simulate(schedule, fee, liability):
        worlds, feasible, supported = [], True, True
        for mechanism in kernel['mechanisms']:
            for world in mechanism['scenarios']:
                actual, baseline = copy.deepcopy(initial), copy.deepcopy(initial)
                cash, minimum, value, periods = a['openingCash'], a['openingCash'], 0.0, []
                for t in range(h):
                    previous, prior_baseline = actual[-1]['states'], baseline[-1]['states']
                    actual, yes = advance(actual, {k: v[t] for k, v in schedule.items()}, mechanism, world, t)
                    baseline, baseline_yes = advance(baseline, {k: v[t] for k, v in p['baselineExposures'].items()}, mechanism, world, t)
                    supported &= yes and baseline_yes
                    left, right = ledger(previous, actual[-1]['states'], fee if t == 0 else 0), ledger(prior_baseline, baseline[-1]['states'], 0)
                    minimum = min(minimum, cash - (fee if t == 0 else 0))
                    cash = cash + left['freeCashFlow'] + left['nonOperatingNetCashFlow']
                    minimum = min(minimum, cash)
                    value += left['netProfit'] - right['netProfit']
                    periods.append({'actual': left, 'baseline': right})
                value -= liability
                cash -= m['utility']['tail']['terminalLiability'] + liability
                minimum = min(minimum, cash)
                feasible &= minimum >= a['minimumCash'] and value >= m['risk']['minimumUtility']
                worlds.append({'worldId': world['id'], 'value': value, 'closingCash': cash, 'minimumCash': minimum, 'periods': periods})
        return {'worlds': worlds, 'supported': supported, 'feasible': bool(feasible and supported),
                'terminalLiability': m['utility']['tail']['terminalLiability'] + liability, 'worst': min(w['value'] for w in worlds)}

    baseline = simulate(p['baselineExposures'], 0, 0)
    baseline.update(choices=[], cost=0, interactionChargeIds=[])
    candidates, best = [], baseline if baseline['feasible'] else None
    for options in itertools.product(*(l['options'] for l in s['levers'])):
        selected = {l['id']: o['id'] for l, o in zip(s['levers'], options)}
        matches = lambda rule: all(selected[c['leverId']] == c['optionId'] for c in rule['when'])
        if any(matches(rule) for rule in s['exclusions']):
            continue
        charges = [rule for rule in s['interactionCharges'] if matches(rule)]
        components = list(options) + charges
        schedule = copy.deepcopy(p['baselineExposures'])
        for lever, option in zip(s['levers'], options):
            schedule[lever['exposureId']] = option['schedule']
        capacity = all(sum(c['resources'][r['id']] for c in components) <= r['totalLimit'] and sum(c['occupancy'][r['id']] for c in components) <= r['capacity'] for r in m['resources']['dimensions'])
        capacity &= all(sum(weight * sum(c['occupancy'][key] for c in components) for key, weight in coupling['weights'].items()) <= coupling['maxPerPeriod'] for coupling in m['resources']['couplings'])
        capacity &= sum(c['humanSeconds'] for c in components) <= m['search']['maxHumanSeconds']
        fee = sum(c['cost'] for c in components)
        result = simulate(schedule, fee, sum(c['tailLiability'] for c in components))
        result['resourcesFeasible'] = bool(capacity)
        result['feasible'] &= capacity
        result.update(choices=[{'leverId': k, 'optionId': v} for k, v in selected.items()], cost=fee, interactionChargeIds=[c['id'] for c in charges])
        candidates.append(result)
        if result['feasible'] and (best is None or result['worst'] > best['worst']):
            best = result
    target = a['profitTarget']
    required = Fraction(str(target['revenueBaseline']['amount'])) * target['minimumBasisPoints'] / 10000
    return {'schema': 'finnor.s4.independent-operating-programme-reference.v1', 'candidates': candidates, 'best': best,
            'required': {'numerator': str(required.numerator), 'denominator': str(required.denominator)},
            'targetMet': best is not None and Fraction(str(best['worst'])) >= required,
            'completeWithinRegisteredModel': baseline['supported'] and all(not c['resourcesFeasible'] or c['supported'] for c in candidates),
            'qualification': 'EXHAUSTIVE_GENERATED_MODEL_CHECK_NOT_FIELD_VALUE_OR_CAUSAL_IDENTIFICATION'}


if __name__ == '__main__':
    print(json.dumps(main(json.load(sys.stdin)), allow_nan=False))
