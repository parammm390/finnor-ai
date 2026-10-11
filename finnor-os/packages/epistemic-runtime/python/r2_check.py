#!/usr/bin/env python3
"""Independent original-contract interpreter. No producer modules or search imports.

See scope-r/r2-robust-programme-search/independent-semantics.md, authored first.
The executable is used at encoding, full-world, proof binding and consumption.
"""
import copy
import hashlib
import itertools
import json
import re
import sys
from fractions import Fraction

VERSION = 'r2-original-history-rational-v1'
PROFILE = 'S4_8_ACTIONS_8_INSTRUMENTS_24_PERIODS_S5_32_WORLDS_EXACT_FINITE'


def require(ok, reason):
    if not ok:
        raise ValueError(reason)


def q(token):
    require(isinstance(token, str) and len(token) <= 1025 and
            re.fullmatch(r'[-+]?(?:0|[1-9]\d*)(?:\.\d+)?(?:/[1-9]\d*)?', token), 'RATIONAL_SYNTAX')
    require('/' not in token or '.' not in token, 'RATIONAL_SYNTAX')
    value = Fraction(token)
    require(len(str(value.numerator)) <= 512 and len(str(value.denominator)) <= 512, 'RATIONAL_PRECISION')
    return value


def text(value):
    value = Fraction(value)
    require(len(str(value.numerator)) <= 512 and len(str(value.denominator)) <= 512, 'RATIONAL_PRECISION')
    return str(value)


def stable(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def digest(value):
    return hashlib.sha256(stable(value).encode()).hexdigest()


def numeric_paths(value, prefix):
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        yield prefix, value
    elif isinstance(value, list):
        for i, child in enumerate(value):
            yield from numeric_paths(child, prefix + '/' + str(i))
    elif isinstance(value, dict):
        for key, child in value.items():
            yield from numeric_paths(child, prefix + '/' + key.replace('~', '~0').replace('/', '~1'))


class Original:
    def __init__(self, problem, caps):
        self.o, self.s, self.m, self.p = problem, problem['source'], problem['mandate'], problem['problem']
        self.caps, self.h = caps, self.m['horizon']['periods']
        self.start = self.p.get('continuation', {}).get('elapsedPeriods', 0)
        self.dims = [d['id'] for d in self.m['resources']['dimensions']]
        self.exp = self.s['exposureIds']
        require(problem['schema'] == 'finnor.r2.original.v1' and problem['version'] == VERSION and
                problem['profile'] == PROFILE, 'DOMAIN_PROFILE')
        require(self.s['schema'] == 'finnor.s3.exact-control-source.v1' and
                self.s['qualification'] == 'SUPPLIED_EXACT_FINITE_MODEL_UNADMITTED' and
                self.s['completeWorldDeclaration'] == 'ALL_DECLARED_JOINT_WORLDS_NO_PROBABILITIES', 'SOURCE_QUALIFICATION')
        require(set(self.s) == {'schema', 'qualification', 'mandateRef', 'problemDigest', 'modelRef', 'quantities', 'accounting', 'mechanisms', 'stateUnits', 'stateRanges', 'exposureIds', 'worlds', 'completeWorldDeclaration'}, 'UNSUPPORTED_SOURCE_DOMAIN_FIELDS')
        require(all(set(w) == {'id', 'mechanismId', 'initialHistory', 'coefficients', 'shocks', 'inquiryTokens', 'accruedUtility'} for w in self.s['worlds']), 'UNSUPPORTED_RANDOMIZED_OR_PROBABILISTIC_WORLD')
        require(self.s['mandateRef'] == self.m['ref'] and self.s['modelRef'] == self.p['modelRef'], 'OWNER_BINDING')
        require(self.m['ambiguity']['kind'] == 'ROBUST_FIXED_JOINT_SCENARIOS', 'PROBABILISTIC_OR_UNRESOLVED_PROFILE')
        require(1 <= self.h <= 24 and 1 <= len(self.p['actions']) <= 8 and len(self.p['observations']) <= 8,
                'OWNER_CONSTRUCTOR_LIMIT')
        numeric = dict(numeric_paths({'mandate': self.m, 'problem': self.p, 'history': self.o['modelHistory']}, ''))
        require(set(numeric) == set(self.s['quantities']), 'COMPLETE_ORIGINAL_QUANTITY_MAP')
        for path, value in numeric.items():
            require(q(self.s['quantities'][path]) == Fraction(str(value)), 'ORIGINAL_QUANTITY_BINDING:' + path)
        a = self.s['accounting']
        require(a['ref'] == self.m['utility']['accountingConventionRef'] and a['unit'] == self.m['utility']['unit'] and
                a['timeBasis'] == self.m['horizon'] and a['discountConvention'] == 'ORIGINAL_OWNER_FACTORS' and
                q(a['ownerShare']) == 1 and a['valuationDate'] == self.m['horizon']['startAt'] and
                a['currency'] == (a['unit'] if re.fullmatch(r'[A-Z]{3}', a['unit']) else None), 'ACCOUNTING_BINDING')
        require(not self.o['modelRequest'].get('roots') or a['entityRef']['id'] == self.o['modelRequest']['roots'][0]['entityId'], 'ACCOUNTING_ENTITY_BINDING')
        require(q(self.n('/mandate/scoring/normalization')) > 0, 'FIXED_NORMALIZATION')
        expected = [{'id': k['id'], 'equations': k['equations']} for k in self.o['modelRequest']['mechanisms']]
        require(self.s['mechanisms'] == expected, 'ORIGINAL_MECHANISM_FEATURES')
        require(self.s['stateUnits'] == {v['id']: v['unit'] for v in self.o['modelRequest']['stateVariables']} and
                self.exp == [e['id'] for e in self.o['modelRequest']['exposures']], 'STATE_EXPOSURE_UNITS')
        for i, v in enumerate(self.o['modelRequest']['stateVariables']):
            require([q(t) for t in self.s['stateRanges'][v['id']]] == [Fraction(str(t)) for t in v['range']], 'ORIGINAL_STATE_RANGE')
        require(1 <= len(self.s['worlds']) <= 32 and len({w['id'] for w in self.s['worlds']}) == len(self.s['worlds']), 'COMPLETE_WORLD_MEMBERSHIP')
        require(self.o['owner']['outstandingEffects'] == [], 'UNACCOUNTED_DURABLE_EFFECT')
        for ob in self.p['obligations']:
            require(ob['status'] in ('KNOWN_PENDING', 'SETTLED') and ob['terminalLiability'] is not None,
                    'UNKNOWN_OR_PARTIAL_OBLIGATION')
            if ob['status'] == 'KNOWN_PENDING':
                require(all(ob[k] is not None for k in ('resources', 'occupancy', 'exposures', 'lockedExposureIds')), 'PENDING_OBLIGATION_COMPLETENESS')
        if self.start:
            c = self.p['continuation']
            require(len(c['actionHistory']) == self.start and self.start < self.h and
                    c['accruedUtility']['unit'] == self.m['utility']['unit'] and
                    all(v in [a['id'] for a in self.p['actions']] for v in c['actionHistory']), 'CONTINUATION_HISTORY')
            require(all(x['availablePeriod'] <= self.start for x in c['observations']), 'CONTINUATION_FUTURE_OBSERVATION')
        self.variants = self.lower()
        self.courses, self.histories = [], {}
        self.build()

    def n(self, path):
        return self.s['quantities'][path]

    def action(self, original, index):
        out = copy.deepcopy(original)
        root = '/problem/actions/' + str(index)
        for key in ('cost', 'tailLiability', 'humanSeconds'):
            out[key] = text(q(self.n(root + '/' + key)))
        for key in ('resources', 'occupancy'):
            out[key] = {id: text(q(self.n(root + '/' + key + '/' + id))) for id in original[key]}
        out['exposures'] = {id: [text(q(self.n(root + '/exposures/' + id + '/' + str(i)))) for i in range(len(v))]
                            for id, v in original['exposures'].items()}
        return out

    def lower(self):
        base = [self.action(a, i) for i, a in enumerate(self.p['actions'])]
        perm = self.o['permitted']
        require(perm['agreement'] == 'UNILATERAL_PROPOSAL', 'ACCEPTANCE_PRIMITIVE_UNAVAILABLE')
        require(self.o['resourceScopeRoots'], 'CANONICAL_RESOURCE_SCOPE_ABSENT')
        target = next((a for a in base if a['id'] == perm['actionId']), None)
        require(target and target['kind'] == 'INTERVENE' and perm['exposureId'] in target['exposures'] and
                perm['unit'] == next(e['unit'] for e in self.o['modelRequest']['exposures'] if e['id'] == perm['exposureId']), 'ORIGINAL_TERM_BINDING')
        require(perm['resourceRule'] == 'SCALE_REGISTERED_ACTION_LINEAR', 'RESOURCE_RULE')
        variants, seen = [], set()

        def add(actions, structure, term=None, start=None, fraction=None):
            require(1 <= len(actions) <= 8 and len({a['id'] for a in actions}) == len(actions), 'COMPOSED_ACTION_BOUND')
            key = stable(actions)
            if key not in seen:
                seen.add(key)
                variants.append({'id': 'g' + str(len(variants)), 'structure': structure, 'term': term,
                                 'start': start, 'fraction': fraction, 'actions': actions})
        add(base, 'INCUMBENT')
        for structure in perm['structures']:
            require(structure in ('IMMEDIATE', 'STAGED', 'OBSERVABLE_STAGE', 'INQUIRY_OPTION', 'WAIT_STOP'), 'GRAMMAR_PRODUCTION')
            for start in perm['startPeriods']:
                for term in perm['terms']:
                    for fraction in (perm['stageFractions'] if structure in ('STAGED', 'OBSERVABLE_STAGE') else [None]):
                        if structure == 'WAIT_STOP':
                            add([a for a in base if a['kind'] in ('WAIT', 'STOP')], structure, term, start, fraction)
                            continue
                        actions = copy.deepcopy(base)
                        t = next(a for a in actions if a['id'] == target['id'])
                        require(all(len(v) == 1 for v in t['exposures'].values()), 'UNSUPPORTED_ORIGINAL_MULTI_PERIOD_TERM')
                        before = q(t['exposures'][perm['exposureId']][0])
                        require(before != 0 and q(term) / before >= 0 and 0 <= start < self.h, 'TERM_SCALE_OR_PERIOD')
                        ratio = q(term) / before
                        t['earliestPeriod'] = t['lastPeriod'] = start
                        t['exposures'][perm['exposureId']] = [text(q(term))]
                        for key in ('resources', 'occupancy'):
                            t[key] = {k: text(q(v) * ratio) for k, v in t[key].items()}
                        for key in ('cost', 'tailLiability'):
                            t[key] = text(q(t[key]) * ratio)
                        if structure == 'STAGED':
                            require(start + 2 <= self.h and 0 < q(fraction) < 1, 'STAGE_HORIZON')
                            t['exposures'] = {id: [text(q(v[0]) * q(fraction)), text(q(v[0]) * (1-q(fraction)))] for id, v in t['exposures'].items()}
                        elif structure == 'OBSERVABLE_STAGE':
                            milestone = perm.get('milestone')
                            instrument = next((i for i in self.p['observations'] if milestone and i['id'] == milestone['instrumentId']), None)
                            require(instrument and t['id'] in instrument['afterActionIds'] and start + instrument['delayPeriods'] < self.h and
                                    set(milestone['tokens']).issubset({b['category'] for b in instrument['bins']}), 'LAWFUL_OBSERVABLE_STAGE')
                            release = copy.deepcopy(t)
                            release['id'] = 'r2-release-' + str(start) + '-' + term.replace('/', '_') + '-' + fraction.replace('/', '_')
                            release['earliestPeriod'] = release['lastPeriod'] = start + instrument['delayPeriods']
                            release['precondition'] = {'afterActionIds': [t['id']], 'observations': [milestone]}
                            for id, v in t['exposures'].items():
                                release['exposures'][id] = [text(q(v[0])*(1-q(fraction)))]
                                t['exposures'][id] = [text(q(v[0])*q(fraction))]
                            for key in ('resources', 'occupancy'):
                                for id, v in list(t[key].items()):
                                    release[key][id] = text(q(v)*(1-q(fraction)))
                                    t[key][id] = text(q(v)*q(fraction))
                            for key in ('cost', 'tailLiability', 'humanSeconds'):
                                release[key], t[key] = text(q(t[key])*(1-q(fraction))), text(q(t[key])*q(fraction))
                            actions.append(release)
                        elif structure == 'INQUIRY_OPTION':
                            inquiry = next((a for a in actions if a['id'] == perm.get('inquiryActionId') and a['kind'] == 'INQUIRE'), None)
                            protocol = next((p for p in self.o['protocols'] if inquiry and p['ref'] == inquiry['protocolRef']), None)
                            require(protocol and start + inquiry['informationDelayPeriods'] < self.h, 'CURRENT_INQUIRY_OPTION')
                            inquiry['earliestPeriod'] = inquiry['lastPeriod'] = start
                            t['earliestPeriod'] = t['lastPeriod'] = start + inquiry['informationDelayPeriods']
                            t['precondition'] = {'afterActionIds': [inquiry['id']], 'observations': [{'instrumentId': protocol['ref']['id'], 'tokens': sorted(set(itertools.chain.from_iterable(protocol['tokensByMechanism'].values())))}]}
                        add(actions, structure, text(q(term)), start, fraction and text(q(fraction)))
        require(bool(variants), 'EMPTY_GRAMMAR')
        return variants

    def initial(self, world):
        history = copy.deepcopy(world['initialHistory'])
        require(1 <= len(history) <= 3 and all(set(r['states']) == set(self.s['stateUnits']) and set(r['exposures']) == set(self.exp) for r in history), 'EXACT_INITIAL_HISTORY')
        for row in history:
            for v in list(row['states'].values()) + list(row['exposures'].values()):
                q(v)
        require(len(history) == len(self.o['modelHistory']) and all(
            q(value) == q(self.n('/history/'+str(i)+'/'+kind+'/'+id))
            for i, row in enumerate(history) for kind in ('states', 'exposures') for id, value in row[kind].items()), 'ORIGINAL_OBSERVED_HISTORY_BINDING')
        known = self.p.get('continuation', {})
        state = {'history': history, 'actions': known.get('actionHistory', [])[:],
                 'observations': [{k: v for k, v in o.items() if k in ('instrumentId', 'token', 'availablePeriod')} for o in known.get('observations', [])],
                 'pending': [], 'schedule': {id: [q(self.n('/problem/baselineExposures/' + id + '/' + str(t))) for t in range(self.h)] for id in self.exp},
                 'locks': {}, 'utility': q(world['accruedUtility']),
                 'liability': q(self.n('/mandate/utility/tail/terminalLiability')), 'stopped': False,
                 'spent': {id: q(self.n('/problem/continuation/usedResources/' + id)) if self.start else Fraction(0) for id in self.dims},
                 'occupancy': {id: [Fraction(0)]*(self.h+1) for id in self.dims},
                 'human': q(self.n('/problem/continuation/humanSeconds')) if self.start else Fraction(0),
                 'native': {r['resourceId']: [Fraction(0)]*(self.h+1) for r in self.o['resources']['resources']},
                 'decisions': [], 'constraints': [], 'supported': True}
        require(self.start or state['utility'] == 0, 'UNJUSTIFIED_ACCRUED_UTILITY')
        for j, ob in enumerate(self.p['obligations']):
            state['liability'] += q(self.n('/problem/obligations/' + str(j) + '/terminalLiability'))
            if ob['status'] != 'KNOWN_PENDING':
                continue
            for id in self.dims:
                state['spent'][id] += q(self.n('/problem/obligations/' + str(j) + '/resources/' + id))
                for t in range(min(self.h+1, ob['occupationUntilPeriod'])):
                    state['occupancy'][id][t] += q(self.n('/problem/obligations/' + str(j) + '/occupancy/' + id))
                dimension = next(d for d in self.m['resources']['dimensions'] if d['id'] == id)
                for component in ('resources', 'occupancy'):
                    value = q(self.n('/problem/obligations/' + str(j) + '/' + component + '/' + id))
                    if not value:
                        continue
                    resources = [r for r in self.o['resources']['resources'] if r['resourceId'] == id and
                                 r['unit'] == dimension['unit'] and r['resourceClass'] == dimension.get('resourceClass') and
                                 (component == 'occupancy') == (r['kind'] in ('OCCUPANCY', 'EXPOSURE'))]
                    require(len(resources) == 1, 'CANONICAL_PENDING_RESOURCE_BINDING')
                    self.resource_scope(resources[0])
                    for period in (range(self.start, min(self.h+1, ob['occupationUntilPeriod'])) if component == 'occupancy' else [self.start]):
                        state['native'][resources[0]['resourceId']][period] += value
            for id in self.exp:
                schedule = [q(self.n('/problem/obligations/' + str(j) + '/exposures/' + id + '/' + str(t))) for t in range(self.h)]
                if id in ob['lockedExposureIds']:
                    require(id not in state['locks'] or state['schedule'][id] == schedule, 'CONFLICTING_PENDING_EXPOSURES')
                    state['schedule'][id], state['locks'][id] = schedule, ob['occupationUntilPeriod']
                else:
                    require(schedule == state['schedule'][id], 'UNLOCKED_PENDING_EXPOSURE_CHANGE')
        return state

    def legal(self, action, t, state):
        if state['stopped'] and action['kind'] != 'STOP':
            return False
        if not action['earliestPeriod'] <= t <= action['lastPeriod']:
            return False
        if action['atMostOnce'] and (action['id'] in state['actions'] or any(o['actionId'] == action['id'] for o in self.p['obligations'])):
            return False
        if action['kind'] == 'INTERVENE' and (any(t+len(v) > self.h for v in action['exposures'].values()) or any(state['locks'].get(id, 0) > t for id in self.exp)):
            return False
        pre = action.get('precondition', {})
        return all(id in state['actions'] for id in pre.get('afterActionIds', [])) and all(
            any(o['instrumentId'] == c['instrumentId'] and o['token'] in c['tokens'] and o['availablePeriod'] <= t for o in state['observations']) for c in pre.get('observations', []))

    def add_constraint(self, state, id, t, used, limit):
        state['constraints'].append({'id': id, 'period': t, 'used': text(used), 'limit': text(limit)})

    def funding(self, cls, unit):
        match = [r for r in self.o['resources']['resources'] if r['unit'] == unit and r['resourceClass'] == cls and r['kind'] in ('STOCK', 'FLOW', 'CUMULATIVE_EXPENDITURE')]
        require(len(match) == 1, 'EXACT_FUNDING_BINDING:' + cls)
        self.resource_scope(match[0])
        return match[0]['resourceId']

    def resource_scope(self, resource):
        require(resource['tenantId'] == self.o['owner']['tenantId'] and
                all(root in resource['permittedRoots'] for root in self.o['resourceScopeRoots']), 'CANONICAL_RESOURCE_SCOPE')
        require(resource['currency'] == (resource['unit'] if re.fullmatch(r'[A-Z]{3}', resource['unit']) else None), 'CANONICAL_RESOURCE_CURRENCY')

    def advance(self, world, variant, old, action, t):
        state = copy.deepcopy(old)
        for id in self.dims:
            require(id in action['resources'] and id in action['occupancy'], 'COMPLETE_ACTION_RESOURCES')
            state['spent'][id] += q(action['resources'][id])
            for k in range(t, min(self.h+1, t+action['occupationPeriods'])):
                state['occupancy'][id][k] += q(action['occupancy'][id])
        state['human'] += q(action['humanSeconds'])
        if action['kind'] == 'INTERVENE':
            require(set(action['exposures']) == set(self.exp), 'JOINT_ACTION_EXPOSURES')
            for id in self.exp:
                for k, v in enumerate(action['exposures'][id]):
                    state['schedule'][id][t+k] = q(v)
                state['locks'][id] = t+len(action['exposures'][id])
        exposures = {id: state['schedule'][id][t] for id in self.exp}
        mechanism = next((m for m in self.s['mechanisms'] if m['id'] == world['mechanismId']), None)
        require(mechanism and len(world['coefficients']) == len(mechanism['equations']) and len(world['shocks']) == self.h-self.start, 'COMPLETE_WORLD_TRANSITIONS')
        states = {}

        def atom(f):
            require(f['kind'] in ('CONSTANT', 'EXPOSURE', 'STATE'), 'UNSUPPORTED_MECHANISM_FEATURE')
            if f['kind'] == 'CONSTANT':
                return Fraction(1)
            if f['kind'] == 'EXPOSURE' and f['lag'] == 0:
                return exposures[f['id']]
            require(1 <= f['lag'] <= len(state['history']), 'FEATURE_HISTORY_COMPLETENESS')
            return q(state['history'][-f['lag']]['states' if f['kind'] == 'STATE' else 'exposures'][f['id']])
        for j, eq in enumerate(mechanism['equations']):
            require(len(world['coefficients'][j]) == len(eq['features']) and len(world['shocks'][t-self.start]) == len(mechanism['equations']), 'COMPLETE_WORLD_COEFFICIENTS')
            values = [atom(f['left'])*atom(f['right']) if f['kind'] == 'PRODUCT' else atom(f) for f in eq['features']]
            value = sum((v*q(c) for v, c in zip(values, world['coefficients'][j])), Fraction(0)) + q(world['shocks'][t-self.start][j])
            states[eq['variableId']] = text(value)
            bounds = self.s['stateRanges'][eq['variableId']]
            self.add_constraint(state, 'state-upper:' + eq['variableId'], t, value, q(bounds[1]))
            self.add_constraint(state, 'state-lower:' + eq['variableId'], t, -value, -q(bounds[0]))
        state['history'] = state['history'][-2:] + [{'states': states, 'exposures': {id: text(v) for id, v in exposures.items()}}]
        utility = sum((q(states[v['variableId']])*q(self.n('/mandate/utility/periodTerms/' + str(j) + '/coefficient')) for j, v in enumerate(self.m['utility']['periodTerms'])), Fraction(0))
        state['utility'] += q(self.n('/mandate/utility/discountFactors/' + str(t))) * (utility-q(action['cost']))
        state['liability'] += q(action['tailLiability'])
        for i, instrument in enumerate(self.p['observations']):
            if action['id'] not in instrument['afterActionIds']:
                continue
            value = q(states[instrument['variableId']])
            bins = [b['category'] for j, b in enumerate(instrument['bins']) if q(self.n('/problem/observations/' + str(i) + '/bins/' + str(j) + '/lowerInclusive')) <= value < q(self.n('/problem/observations/' + str(i) + '/bins/' + str(j) + '/upperExclusive'))]
            require(len(bins) == 1, 'OBSERVATION_COARSENING_COMPLETE_DISJOINT')
            state['pending'].append({'instrumentId': instrument['id'], 'token': bins[0], 'availablePeriod': t+instrument['delayPeriods']})
        if action['kind'] == 'INQUIRE':
            protocol = next((p for p in self.o['protocols'] if p['ref'] == action['protocolRef']), None)
            require(protocol and protocol['delayPeriods'] == action['informationDelayPeriods'] and q(protocol['completeCost']) <= q(action['cost']), 'CURRENT_COMPLETE_INQUIRY')
            tokens = world['inquiryTokens'].get(protocol['ref']['id'])
            require(tokens and len(tokens) == self.h-self.start and tokens[t-self.start] in protocol['tokensByMechanism'][world['mechanismId']], 'FIXED_COMPLETE_INQUIRY_WORLD')
            state['pending'].append({'instrumentId': protocol['ref']['id'], 'token': tokens[t-self.start], 'availablePeriod': t+protocol['delayPeriods']})
        state['observations'] += [o for o in state['pending'] if o['availablePeriod'] == t+1]
        state['pending'] = [o for o in state['pending'] if o['availablePeriod'] > t+1]
        for i, dim in enumerate(self.m['resources']['dimensions']):
            for component in ('resources', 'occupancy'):
                value = q(action[component][dim['id']])
                if value == 0:
                    continue
                match = [r for r in self.o['resources']['resources'] if r['resourceId'] == dim['id'] and r['unit'] == dim['unit'] and r['resourceClass'] == dim.get('resourceClass') and
                         (component == 'occupancy') == (r['kind'] in ('OCCUPANCY', 'EXPOSURE'))]
                require(len(match) == 1, 'CANONICAL_RESOURCE_BINDING:' + dim['id'] + ':' + component)
                self.resource_scope(match[0])
                raw = state['native'][match[0]['resourceId']]
                for k in (range(t, min(self.h+1, t+action['occupationPeriods'])) if component == 'occupancy' else [t]):
                    raw[k] += value
            self.add_constraint(state, 'mandate-total:' + dim['id'], t, state['spent'][dim['id']], q(self.n('/mandate/resources/dimensions/' + str(i) + '/totalLimit')))
            for k in range(self.h+1):
                self.add_constraint(state, 'mandate-occupancy:' + dim['id'] + ':' + str(k), t, state['occupancy'][dim['id']][k], q(self.n('/mandate/resources/dimensions/' + str(i) + '/capacity')))
        self.add_constraint(state, 'mandate-human', t, state['human'], q(self.n('/mandate/search/maxHumanSeconds')))
        for i, coupling in enumerate(self.m['resources']['couplings']):
            for k in range(self.h+1):
                used = sum((q(self.n('/mandate/resources/couplings/' + str(i) + '/weights/' + id))*state['occupancy'][id][k] for id in coupling['weights']), Fraction(0))
                self.add_constraint(state, 'mandate-coupling:' + coupling['id'] + ':' + str(k), t, used, q(self.n('/mandate/resources/couplings/' + str(i) + '/maxPerPeriod')))
        if q(action['cost']):
            state['native'][self.funding('CASH', self.m['utility']['unit'])][t] += q(action['cost'])
        if q(action['humanSeconds']):
            state['native'][self.funding('HUMAN_ATTENTION', 'seconds')][t] += q(action['humanSeconds'])
        state['actions'].append(action['id'])
        state['stopped'] = state['stopped'] or action['kind'] == 'STOP'
        return state

    def terminal(self, state):
        utility = sum((q(state['history'][-1]['states'][v['variableId']])*q(self.n('/mandate/utility/terminalTerms/' + str(i) + '/coefficient')) for i, v in enumerate(self.m['utility']['terminalTerms'])), Fraction(0))
        value = state['utility'] + q(self.n('/mandate/utility/discountFactors/' + str(self.h))) * (utility-state['liability'])
        self.add_constraint(state, 'worst-path-risk-floor', self.h, -value, -q(self.n('/mandate/risk/minimumUtility')))
        if state['liability']:
            state['native'][self.funding('CASH', self.m['utility']['unit'])][self.h] += state['liability']
        baseline, minimum = {}, {}
        for r in self.o['resources']['resources']:
            require(not r['revoked'] and r['horizon'] == self.m['horizon'] and len(r['availability']) == self.h+1 and len(r['existingUse']) == self.h+1, 'CANONICAL_RESOURCE_CURRENT_COMPLETE')
            baseline[r['resourceId']], minimum[r['resourceId']] = [q(v) for v in r['existingUse']], [q(v) for v in r['existingUse']]
        for ob in self.o['resources']['outstanding']:
            require(not(ob['status'] == 'RESERVED' and ob['effectRefs']), 'RESERVATION_EFFECT_STAGE')
            for envelope in ob['envelopes']:
                r = next((r for r in self.o['resources']['resources'] if r['resourceId'] == envelope['resourceId']), None)
                require(r and r['unit'] == envelope['unit'] and r['kind'] == envelope['kind'] and r['horizon'] == envelope['horizon'] and len(envelope['quantities']) == self.h+1 and len(envelope.get('minimumQuantities', [])) == self.h+1, 'COMPLETE_RESERVATION_ENVELOPE')
                for t in range(self.h+1):
                    baseline[r['resourceId']][t] += q(envelope['quantities'][t])
                    minimum[r['resourceId']][t] += q(envelope['minimumQuantities'][t])

        def usage(r, values, t):
            return sum(values[:t+1], Fraction(0)) if r['kind'] in ('STOCK', 'CUMULATIVE_EXPENDITURE') else values[t]
        for r in self.o['resources']['resources']:
            total = [a+b for a, b in zip(state['native'][r['resourceId']], baseline[r['resourceId']])]
            for t in range(self.h+1):
                availability = r['availability'][t]
                require(availability['basis'] == 'REPORTED_AVAILABLE' and availability['amount'] is not None, 'UNRESOLVED_AVAILABILITY')
                require(usage(r, minimum[r['resourceId']], t) <= usage(r, baseline[r['resourceId']], t), 'RESERVATION_MINIMUM_ENVELOPE')
                self.add_constraint(state, 'resource:' + r['resourceId'], t, usage(r, total, t), q(availability['amount'])-q(r['safetyMargin']))
        covenants = {}
        for r in self.o['resources']['resources']:
            for covenant in r['covenants']:
                require(covenant['id'] not in covenants or covenants[covenant['id']] == covenant, 'COVENANT_IDENTITY')
                covenants[covenant['id']] = covenant
        for c in covenants.values():
            for t in c['periods']:
                used = Fraction(0)
                for term in c['terms']:
                    r = next(r for r in self.o['resources']['resources'] if r['resourceId'] == term['resourceId'])
                    prior = minimum if q(term['coefficient']) < 0 else baseline
                    values = [a+b for a, b in zip(state['native'][r['resourceId']], prior[r['resourceId']])]
                    used += q(term['coefficient'])*usage(r, values, t)
                self.add_constraint(state, 'covenant:' + c['id'], t, used, q(c['maximum'])-q(c['safetyMargin']))
        return text(value)

    def build(self):
        for variant in self.variants:
            for world in self.s['worlds']:
                def visit(state, t):
                    require(len(self.courses) < self.caps['maxPaths'], 'CONSTRUCTION_PATH_CAP_INCOMPLETE')
                    if t == self.h:
                        value = self.terminal(state)
                        self.courses.append({'id': 'p'+str(len(self.courses)), 'worldId': world['id'], 'variantId': variant['id'],
                                             'decisions': state['decisions'], 'utility': value, 'constraints': state['constraints'],
                                             'terminalLiability': text(state['liability']), 'resourceUse': {id: [text(v) for v in values] for id, values in state['native'].items()}, 'supported': True})
                        return
                    available = [a for a in variant['actions'] if self.legal(a, t, state)]
                    key = variant['id']+'|'+stable({'period': t, 'actionHistory': state['actions'], 'observations': state['observations']})
                    require(len(self.histories) < self.caps['maxHistories'] or key in self.histories, 'CONSTRUCTION_HISTORY_CAP_INCOMPLETE')
                    row = {'key': key, 'variantId': variant['id'], 'period': t, 'actionHistory': state['actions'], 'observations': state['observations'], 'actions': [a['id'] for a in available]}
                    # Exposure locks are consequences of the complete action history,
                    # never private world state. A discrepancy is an invalid domain.
                    require(key not in self.histories or self.histories[key] == row, 'HIDDEN_WORLD_ELIGIBILITY')
                    self.histories[key] = row
                    for action in available:
                        decision = {'key': key, 'period': t, 'actionHistory': state['actions'], 'observations': state['observations'], 'actionId': action['id']}
                        next_state = self.advance(world, variant, state, action, t)
                        next_state['decisions'] = state['decisions'] + [decision]
                        visit(next_state, t+1)
                visit(self.initial(world), self.start)

    def encode(self, worlds, original_digest):
        require(worlds and len(set(worlds)) == len(worlds) and set(worlds).issubset({w['id'] for w in self.s['worlds']}), 'RESTRICTED_WORLD_MEMBERSHIP')
        variables = [{'id': 'z', 'kind': 'CONTINUOUS', 'lower': None, 'upper': None}]
        variables += [{'id': 'v'+v['id'], 'kind': 'BINARY', 'lower': '0', 'upper': '1'} for v in self.variants]
        histories = list(self.histories.values())
        choice = {(row['key'], a): 'x'+str(i)+'_'+str(j) for i, row in enumerate(histories) for j, a in enumerate(row['actions'])}
        variables += [{'id': id, 'kind': 'BINARY', 'lower': '0', 'upper': '1'} for id in choice.values()]
        variables += [{'id': c['id'], 'kind': 'BINARY', 'lower': '0', 'upper': '1'} for c in self.courses]
        rows = []

        def add(sense, rhs, terms):
            merged = {}
            for id, coefficient in terms:
                merged[id] = merged.get(id, Fraction(0)) + q(coefficient)
            rows.append({'id': 'c'+str(len(rows)), 'sense': sense, 'rhs': text(q(rhs)),
                         'terms': [[id, text(v)] for id, v in sorted(merged.items()) if v]})
        add('E', '1', [('v'+v['id'], '1') for v in self.variants])
        for row in histories:
            add('E', '0', [(choice[row['key'], a], '1') for a in row['actions']] + [('v'+row['variantId'], '-1')])
        for variant in self.variants:
            for world in self.s['worlds']:
                courses = [c for c in self.courses if c['variantId'] == variant['id'] and c['worldId'] == world['id']]
                add('E', '0', [(c['id'], '1') for c in courses] + [('v'+variant['id'], '-1')])
        for course in self.courses:
            for decision in course['decisions']:
                add('L', '0', [(course['id'], '1'), (choice[decision['key'], decision['actionId']], '-1')])
        for world in worlds:
            courses = [c for c in self.courses if c['worldId'] == world]
            add('L', '0', [('z', '1')] + [(c['id'], text(-q(c['utility']))) for c in courses])
            # Every original hard row is required for each included world.
            # Reject violating whole courses with p<=0; this is an exact finite
            # linearization, not filtering the original policy family in W\Wi.
            for course in courses:
                if any(q(c['used']) > q(c['limit']) for c in course['constraints']):
                    add('L', '0', [(course['id'], '1')])
        require(len(variables) <= self.caps['maxVariables'] and len(rows) <= self.caps['maxRows'], 'ENCODING_CAP_INCOMPLETE')
        return {'variables': variables, 'objective': {'sense': 'min', 'terms': [['z', '-1']]}, 'rows': rows,
                'variants': self.variants, 'courses': self.courses, 'histories': histories,
                'coverage': {'allWorlds': [w['id'] for w in self.s['worlds']], 'allVariants': [v['id'] for v in self.variants], 'fullHistoriesFixed': True, 'bigMUsed': False, 'complete': True}}

    def replay(self, policy):
        variant = next((v for v in self.variants if v['id'] == policy['variant']['id']), None)
        require(variant and variant == policy['variant'], 'ORIGINAL_POLICY_VARIANT')
        decisions = {}
        for decision in policy['decisions']:
            require(decision['key'] not in decisions, 'DUPLICATE_POLICY_HISTORY')
            row = self.histories.get(decision['key'])
            require(row and row['variantId'] == variant['id'] and decision['actionId'] in row['actions'] and
                    all(decision[k] == row[k] for k in ('period', 'actionHistory', 'observations')), 'LAWFUL_ORIGINAL_POLICY_HISTORY')
            decisions[decision['key']] = decision['actionId']
        paths, violations = [], []
        for world in self.s['worlds']:
            matches = [c for c in self.courses if c['worldId'] == world['id'] and c['variantId'] == variant['id'] and
                       all(decisions.get(d['key']) == d['actionId'] for d in c['decisions'])]
            require(len(matches) == 1, 'COMPLETE_UNAMBIGUOUS_ORIGINAL_POLICY')
            course = matches[0]
            paths.append(course)
            for c in course['constraints']:
                if q(c['used']) > q(c['limit']):
                    violations.append({'worldId': world['id'], 'variantId': variant['id'], 'actionHistory': [d['actionId'] for d in course['decisions']],
                                       'period': c['period'], 'constraint': c['id'], 'used': c['used'], 'limit': c['limit']})
        require('worldCourses' not in policy or policy['worldCourses'] == paths, 'ORIGINAL_POLICY_PAYOFF_OR_DEMAND_TAMPER')
        return paths, violations

    def enumerate(self, maximum):
        # Verification-only complete pure policy enumeration, independently
        # specified before the producer. Unreachable choices do not add value.
        best, winner, checked, feasible, unique = None, None, 0, 0, set()
        for variant in self.variants:
            rows = [r for r in self.histories.values() if r['variantId'] == variant['id']]
            candidates = {w['id']: [c for c in self.courses if c['worldId'] == w['id'] and c['variantId'] == variant['id']] for w in self.s['worlds']}

            def assignments(paths, selected):
                # Only a reachable information class is chosen. This avoids
                # an exponential multiplicity of irrelevant off-path choices,
                # while exhaustively enumerating every pure induced policy.
                active = {d['key'] for courses in paths.values() for c in courses for d in c['decisions'] if d['key'] not in selected}
                if not active:
                    require(all(len(cs) == 1 for cs in paths.values()), 'REFERENCE_PATH_AMBIGUITY')
                    yield selected
                    return
                history = min((r for r in rows if r['key'] in active), key=lambda r: (r['period'], rows.index(r)))
                for action in history['actions']:
                    filtered = {w: [c for c in cs if all(d['key'] != history['key'] or d['actionId'] == action for d in c['decisions'])] for w, cs in paths.items()}
                    if all(filtered.values()):
                        yield from assignments(filtered, selected | {history['key']: action})

            for chosen in assignments(candidates, {}):
                decisions = [{k: r[k] for k in ('key', 'period', 'actionHistory', 'observations')} | {'actionId': chosen.get(r['key'], r['actions'][0])} for r in rows if r['actions']]
                paths, violations = self.replay({'variant': variant, 'decisions': decisions})
                signature = tuple(c['id'] for c in paths)
                checked += 1
                require(checked <= maximum, 'REFERENCE_ENUMERATION_CAP_INCOMPLETE')
                if signature in unique:
                    continue
                unique.add(signature)
                if violations:
                    continue
                feasible += 1
                value = min(q(c['utility']) for c in paths)
                # Original S4 deterministic order is action constructor order;
                # source variants retain incumbent first. First exact tie wins.
                tie = (int(variant['id'][1:]), tuple(r['actions'].index(d['actionId']) for r, d in zip(rows, decisions)))
                if best is None or value > best or value == best and tie < winner[0]:
                    best, winner = value, (tie, {'variant': variant, 'decisions': decisions, 'worldCourses': paths})
        return {'value': None if best is None else text(best), 'policy': None if winner is None else winner[1],
                'complete': True, 'assignments': checked, 'purePolicies': len(unique), 'feasiblePolicies': feasible}


def parse_vipr_model(path):
    lines = [line.strip() for line in open(path, encoding='utf8') if line.strip() and not line.lstrip().startswith(('%', '#'))]
    cursor = 0

    def take():
        nonlocal cursor
        require(cursor < len(lines), 'PARTIAL_VIPR')
        value = lines[cursor]
        cursor += 1
        return value
    require(take() in ('VER 1.0', 'VER 1.1'), 'VIPR_VERSION')
    header = take().split()
    require(header[0] == 'VAR' and len(header) == 2, 'VIPR_VAR')
    variables = []
    while len(variables) < int(header[1]):
        variables += take().split()
    require(len(variables) == int(header[1]), 'VIPR_VARIABLE_COUNT')
    header = take().split()
    require(header[0] == 'INT', 'VIPR_INT')
    integer = []
    while len(integer) < int(header[1]):
        integer += [int(x) for x in take().split()]
    require(len(integer) == int(header[1]), 'VIPR_INTEGER_COUNT')
    header = take().split()
    require(header[0] == 'OBJ' and header[1] == 'min', 'VIPR_OBJECTIVE_SENSE')

    def vector(tokens):
        require(tokens and len(tokens) == 1+2*int(tokens[0]), 'VIPR_SPARSE_VECTOR')
        out = {}
        for j in range(int(tokens[0])):
            i, value = int(tokens[1+2*j]), q(tokens[2+2*j])
            require(0 <= i < len(variables) and i not in out, 'VIPR_VARIABLE_INDEX')
            out[variables[i]] = value
        return {id: v for id, v in out.items() if v}
    objective = vector(header[2:] or take().split())
    header = take().split()
    require(header[0] == 'CON', 'VIPR_CON')
    constraints = []
    for _ in range(int(header[1])):
        tokens = take().split()
        require(tokens[1] in ('E', 'L', 'G'), 'VIPR_CONSTRAINT_SENSE')
        constraints.append((tokens[0], tokens[1], q(tokens[2]), vector(tokens[3:])))
    header = take().split()
    require(header[0] == 'RTP', 'VIPR_RTP')
    if header[1] == 'infeas':
        result = {'infeasible': True, 'bound': None}
    else:
        require(header[1] == 'range' and len(header) == 4 and header[2] not in ('-inf', 'inf'), 'VIPR_FINITE_LOWER_BOUND')
        result = {'infeasible': False, 'bound': text(q(header[2]))}
    # Reject completion-needed holes even if an unrelated text/log says success.
    require(not any(re.search(r'\{\s*(weak|incomplete)\b', line) for line in lines[cursor:]), 'INCOMPLETE_CUT_CERTIFICATE')
    return variables, integer, objective, constraints, result


def bind_proof(encoding, path):
    variables, integer, objective, constraints, result = parse_vipr_model(path)
    # SCIP names the unchanged transformed columns t_<original>. Accept that
    # bijection only after checking every original column/integer/objective/row.
    expected_variables = {v['id'] for v in encoding['variables']}
    if set(variables) == {'t_'+v for v in expected_variables}:
        rename = {v: v[2:] for v in variables}
        variables = [rename[v] for v in variables]
        objective = {rename[v]: c for v, c in objective.items()}
        constraints = [(name, sense, rhs, {rename[v]: c for v, c in terms.items()}) for name, sense, rhs, terms in constraints]
    require(set(variables) == {v['id'] for v in encoding['variables']} and len(variables) == len(encoding['variables']), 'PROOF_ORIGINAL_VARIABLES')
    require({variables[i] for i in integer} == {v['id'] for v in encoding['variables'] if v['kind'] == 'BINARY'}, 'PROOF_ORIGINAL_INTEGRALITY')
    require(objective == dict((id, q(v)) for id, v in encoding['objective']['terms']), 'PROOF_ORIGINAL_OBJECTIVE')
    expected = {row['id']: (row['sense'], q(row['rhs']), {id: q(v) for id, v in row['terms']}) for row in encoding['rows']}
    bounds = [(v['id']+'_lb', 'G', q(v['lower']), {v['id']: Fraction(1)}) for v in encoding['variables'] if v['lower'] is not None]
    bounds += [(v['id']+'_ub', 'L', q(v['upper']), {v['id']: Fraction(1)}) for v in encoding['variables'] if v['upper'] is not None]
    remaining = [(sense, rhs, terms) for _, sense, rhs, terms in constraints]
    for sense, rhs, terms in list(expected.values()) + [(s, r, t) for _, s, r, t in bounds]:
        matched = None
        for i, (ps, pr, pt) in enumerate(remaining):
            if ps != sense or set(pt) != set(terms):
                continue
            scale = next((pt[id]/v for id, v in terms.items() if v), None)
            if scale is None:
                scale = pr/rhs if rhs else Fraction(1)
            if scale > 0 and pr == scale*rhs and all(pt[id] == scale*v for id, v in terms.items()):
                matched = i
                break
        require(matched is not None, 'PROOF_ORIGINAL_ROW_OR_BOUND')
        remaining.pop(matched)
    require(not remaining, 'UNVERIFIED_PRESOLVE_OR_TRANSFORMATION')
    return result


def run(request):
    original = Original(request['original'], request['caps'])
    operation = request['operation']
    base = {'checkerVersion': VERSION, 'disposition': 'ACCEPTED', 'claims': ['ORIGINAL_EXACT_DOMAIN'],
            'coverage': {'worlds': len(original.s['worlds']), 'variants': len(original.variants), 'histories': len(original.histories), 'courses': len(original.courses)},
            'worldValues': [], 'feasible': None, 'violations': [], 'lower': None, 'upper': None, 'reason': None}
    if operation == 'enumerate':
        return base | {'reference': original.enumerate(request['maximumAssignments'])}
    if operation in ('encoding', 'proof'):
        encoding = request['encoding']
        canonical = request['canonical']
        for name, value in [('original', original.o), ('problem', original.p), ('worlds', original.s['worlds']),
                            ('grammar', {'permitted': original.o['permitted'], 'variants': original.variants})]:
            require(json.loads(canonical[name]) == value, 'CANONICAL_ORIGINAL_PREIMAGE:'+name)
        require(encoding['originalDigest'] == hashlib.sha256(canonical['original'].encode()).hexdigest() and
                encoding['grammarDigest'] == hashlib.sha256(canonical['grammar'].encode()).hexdigest() and
                encoding['worldDigest'] == hashlib.sha256(canonical['worlds'].encode()).hexdigest() and
                original.s['problemDigest'] == hashlib.sha256(canonical['problem'].encode()).hexdigest(), 'ENCODING_ORIGINAL_DIGESTS')
        rebuilt = original.encode(encoding['restrictedWorlds'], encoding['originalDigest'])
        if 'tieBreak' in encoding:
            tie = encoding['tieBreak']
            require(tie['basis'] == 'ORIGINAL_VARIANT_THEN_FIXED_INFORMATION_HISTORY_ACTION_ORDER' and
                    encoding['restrictedWorlds'] == rebuilt['coverage']['allWorlds'], 'TIE_FULL_ORIGINAL_WORLD_BASIS')
            active = [(i, r) for i, r in enumerate(rebuilt['histories']) if len(r['actions']) > 1]
            scale = 9**len(active)
            require(len(str(scale)) <= 512, 'TIE_PRECISION_CAP_INCOMPLETE')
            terms = [('v'+v['id'], str(i*scale)) for i, v in enumerate(original.variants) if i]
            for rank, (i, row) in enumerate(active):
                terms += [('x'+str(i)+'_'+str(j), str(j*9**(len(active)-rank-1))) for j in range(1, len(row['actions']))]
            rebuilt['objective'] = {'sense': 'min', 'terms': [list(t) for t in terms]}
            rebuilt['rows'].append({'id': 'c'+str(len(rebuilt['rows'])), 'sense': 'G', 'rhs': text(q(tie['minimumValue'])), 'terms': [['z', '1']]})
        require(all(encoding[k] == v for k, v in rebuilt.items()), 'ENCODING_ORIGINAL_CORRESPONDENCE')
        base['claims'] += ['FULL_POLICY_FAMILY_BOTH_DIRECTIONS', 'FIXED_FULL_WORLD_HISTORIES', 'EXACT_ORIGINAL_ROWS_NO_BIG_M']
        if operation == 'proof':
            result = bind_proof(encoding, request['proofPath'])
            base['claims'] += ['PROOF_ORIGINAL_MODEL_BINDING']
            base['upper'] = None if result['bound'] is None or 'tieBreak' in encoding else text(-q(result['bound']))
            base['infeasibleProof'] = result['infeasible']
            base['minimizationLower'] = result['bound']
    if operation in ('policy', 's5'):
        courses, violations = original.replay(request['policy'])
        base.update({'worldValues': [{'worldId': c['worldId'], 'value': c['utility']} for c in courses],
                     'feasible': not violations, 'violations': violations,
                     'lower': min((q(c['utility']) for c in courses), default=None)})
        base['lower'] = text(base['lower']) if not violations else None
        base['claims'] += ['COMPLETE_ORIGINAL_FULL_WORLD_POLICY', 'EXACT_ORIGINAL_RESOURCES_AND_LIABILITIES']
    return base


if __name__ == '__main__':
    try:
        payload = json.load(sys.stdin)
        print(json.dumps(run(payload), separators=(',', ':')))
    except (ValueError, KeyError, IndexError, TypeError, StopIteration, ZeroDivisionError) as error:
        print(json.dumps({'checkerVersion': VERSION, 'disposition': 'REJECTED', 'reason': str(error), 'claims': [],
                          'worldValues': [], 'feasible': None, 'violations': [], 'coverage': {'worlds': 0, 'variants': 0, 'histories': 0, 'courses': 0},
                          'lower': None, 'upper': None}, separators=(',', ':')))
        sys.exit(2)
