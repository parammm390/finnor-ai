"""Independent full-program enumeration, authored before the S4 producer.

The input is sealed finite evaluation data, not controller access to hidden truth.
Enumerate feasible complete schedules separately for each world, then reject
products whose choices disagree at an identical observable history. No production
solver, kernel or hash function is imported. Values include costs/tails and the
same resource envelope. This exponential oracle is only for registered small cells.
"""
import itertools
import json
import sys


def response_cost(world, history, t):
    return sum(r['cashCost'] for r in world.get('responses', [])
               if t >= r['lag'] and history[t-r['lag']] == r['ifPreviousAction'])


def readback(case):
    nodes = case['policy']['nodes']
    values = []
    for world in case['worlds']:
        history, observations, pending, used = [], [], [], set()
        value, spent, stopped = -case.get('tailDebt', 0), 0, False
        occupancy = [case.get('existingOccupancy', 0)] * case['horizon']
        for t in range(case['horizon']):
            for due, instrument, token in pending:
                if due == t:
                    observations.append({'instrumentId': instrument, 'token': token, 'availablePeriod': due})
            matches = [n for n in nodes if n['period'] == t and n['actionHistory'] == history and n['observations'] == observations]
            if len(matches) != 1: raise ValueError('Missing or ambiguous nonanticipative node')
            action = next(a for a in case['actions'] if a['id'] == matches[0]['actionId'])
            if stopped and action['kind'] != 'STOP': raise ValueError('Stop resumed intervention')
            if action['kind'] not in ('WAIT', 'STOP') and (action['id'] in used or t > action.get('lastPeriod', case['horizon']-1)):
                raise ValueError('Repeated or expired commitment')
            if action['kind'] not in ('WAIT', 'STOP'): used.add(action['id'])
            if action['kind'] == 'STOP': stopped = True
            history.append(action['id'])
            spent += action.get('resource', 0)
            if spent > case.get('budget', 100): raise ValueError('Total resource violation')
            for j in range(t, min(case['horizon'], t+action.get('occupationPeriods', 1))):
                occupancy[j] += action.get('occupancy', 0)
                if occupancy[j] > case.get('capacity', 100): raise ValueError('Coupled occupancy violation')
            value -= action['cost'] + action.get('tailLiability', 0)
            value += world['payoffs'][t].get(action['id'], 0)
            value -= response_cost(world, history, t)
            if action['kind'] == 'INQUIRE': pending.append((t+action.get('delay', 1), 'instrument', world['signal']))
            if action.get('reveals'): pending.append((t+1, 'action-signal', world['signal']))
        if value < case.get('utilityFloor', -1000): raise ValueError('Hard risk violation')
        values.append(value)
    return {'robustValue': min(values), 'worldValues': values, 'lawful': True}


def solve(case):
    horizon = case['horizon']
    actions = case['actions']
    programs = []
    for world in case['worlds']:
        feasible = []
        for sequence in itertools.product(range(len(actions)), repeat=horizon):
            used, history, observed, decisions, pending = set(), [], [], {}, []
            value, resource, stopped, good = -case.get('tailDebt', 0), 0, False, True
            occupancy = [case.get('existingOccupancy', 0)] * horizon
            for t, ai in enumerate(sequence):
                action = actions[ai]
                for due, token in pending:
                    if due == t:
                        observed.append(token)
                key = json.dumps([t, history, observed], sort_keys=True)
                if stopped and action['kind'] != 'STOP':
                    good = False; break
                if action['kind'] not in ('WAIT', 'STOP') and (action['id'] in used or t > action.get('lastPeriod', horizon-1)):
                    good = False; break
                decisions[key] = action['id']
                history.append(action['id'])
                value -= action['cost']
                value -= action.get('tailLiability', 0)
                resource += action.get('resource', 0)
                if resource > case.get('budget', 100):
                    good = False; break
                for j in range(t, min(horizon, t+action.get('occupationPeriods', 1))):
                    occupancy[j] += action.get('occupancy', 0)
                    if occupancy[j] > case.get('capacity', 100):
                        good = False
                if not good: break
                if action['kind'] == 'STOP': stopped = True
                if action['kind'] not in ('WAIT', 'STOP'): used.add(action['id'])
                if action['kind'] == 'INQUIRE':
                    token = world['signal']
                    pending.append((t+action.get('delay', 1), token))
                value += world['payoffs'][t].get(action['id'], 0)
                value -= response_cost(world, history, t)
                if action.get('reveals'):
                    pending.append((t+1, world['signal']))
            if good and value >= case.get('utilityFloor', -1000):
                feasible.append((value, decisions, [actions[i]['id'] for i in sequence]))
        programs.append(feasible)
    if any(not p for p in programs): return {'status': 'INFEASIBLE'}
    best, winner = float('-inf'), None
    for combination in itertools.product(*programs):
        choices, lawful = {}, True
        for _, decisions, _ in combination:
            for key, action in decisions.items():
                if key in choices and choices[key] != action:
                    lawful = False; break
                choices[key] = action
            if not lawful: break
        if lawful:
            value = min(p[0] for p in combination)
            if value > best:
                best, winner = value, combination
    if winner is None: return {'status': 'INFEASIBLE'}
    return {'status': 'POLICY_AVAILABLE', 'value': best,
            'schedules': [x[2] for x in winner], 'first': winner[0][2][0]}


if __name__ == '__main__':
    case=json.load(sys.stdin)
    print(json.dumps(readback(case) if 'policy' in case else solve(case)))
