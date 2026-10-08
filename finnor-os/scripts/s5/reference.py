"""Independent original-contract oracle and matched robust MILP reference.

Reads canonical actions/resources/joint inputs, never producer rows, choices or
claimed feasibility witnesses. Fraction enumeration proves the tractable region.
The large reference is a separately formulated numerical corroboration only.
"""
import itertools, json, math, sys, time
from fractions import Fraction as Q

START = time.monotonic()
payload = json.load(sys.stdin)
p = payload.get('problem',payload)
proof = payload.get('boundProof')
h = p['mandate']['horizon']['periods']
ids = [v['ref']['id'] for v in p['policies']]
resources = {v['resourceId']: v for v in p['resources']}
base, minimum = {}, {}
for key, r in resources.items():
    base[key] = list(map(Q, r['existingUse']))
    minimum[key] = list(base[key])
for old in p['outstanding']:
    for e in old['envelopes']:
        for t in range(h + 1):
            base[e['resourceId']][t] += Q(e['quantities'][t])
            minimum[e['resourceId']][t] += Q(e['minimumQuantities'][t])

def use(key, raw, t):
    return sum(raw[:t + 1], Q(0)) if resources[key]['kind'] in ('STOCK', 'CUMULATIVE_EXPENDITURE') else raw[t]

demands, mandate_use, human_use = {}, {}, {}
for scenario in p['jointModel']['scenarios']:
    sid = scenario['id']; demands[sid] = {}; mandate_use[sid] = {}; human_use[sid] = {}
    for policy in p['policies']:
        pid = policy['ref']['id']
        nodes = {v['id']: v for v in policy['nodes']}
        actions = {v['id']: v for v in policy['problem']['actions']}
        path = next(v for v in scenario['policyPaths'] if v['policyRef']['id'] == pid)
        funding = next(v for v in p['funding'] if v['policyRef']['id'] == pid)
        raw = {key: [Q(0)] * (h + 1) for key in resources}
        dimensions = {d['id']: {'total': Q(0), 'occupancy': [Q(0)] * (h + 1)} for d in p['mandate']['resources']['dimensions']}
        attention = Q(0)
        for nid in path['nodeIds']:
            node = nodes[nid]; a = actions[node['actionId']]; t = node['period']
            attention += Q(str(a['humanSeconds']))
            for b in p['demandBindings']:
                if b['policyRef']['id'] != pid: continue
                if b['component'] == 'TOTAL': raw[b['resourceId']][t] += Q(str(a['resources'][b['dimensionId']]))
                else:
                    for k in range(t, min(h + 1, t + a['occupationPeriods'])): raw[b['resourceId']][k] += Q(str(a['occupancy'][b['dimensionId']]))
            for f, period, field in [('actionCostResourceId', t, 'cost'), ('humanSecondsResourceId', t, 'humanSeconds'), ('terminalLiabilityResourceId', h, 'tailLiability')]:
                if funding[f]: raw[funding[f]][period] += Q(str(a[field]))
            for key, d in dimensions.items():
                d['total'] += Q(str(a['resources'][key]))
                for k in range(t, min(h + 1, t + a['occupationPeriods'])): d['occupancy'][k] += Q(str(a['occupancy'][key]))
        demands[sid][pid] = raw; mandate_use[sid][pid] = dimensions; human_use[sid][pid] = attention

tail = Q(str(p['mandate']['utility']['tail']['terminalLiability']))
tail_resource = p['funding'][0]['terminalLiabilityResourceId'] if tail else None
covenants = {c['id']: c for r in resources.values() for c in r['covenants']}
committed = {r['id'] for o in p['outstanding'] for r in o['policyRefs']}

def evaluate(selected):
    selected = set(selected); reasons = []; values = []; usages = []
    if selected & committed: reasons.append('ALREADY_COMMITTED')
    for c in p['jointModel']['choiceConstraints']:
        n = len(selected & set(c['policyIds']))
        if not c['minimum'] <= n <= c['maximum']: reasons.append('CHOICE:' + c['id'])
    for s in p['jointModel']['scenarios']:
        sid = s['id']; inc = {key: [Q(0)] * (h + 1) for key in resources}
        if tail_resource: inc[tail_resource][h] += tail
        for pid in selected:
            for key in resources:
                for t in range(h + 1): inc[key][t] += demands[sid][pid][key][t]
        for key, r in resources.items():
            if r['revoked'] or any(a['amount'] is None or a['basis'] != 'REPORTED_AVAILABLE' for a in r['availability']): reasons.append('UNRESOLVED:' + key)
            total = [x + y for x, y in zip(base[key], inc[key])]
            for t in range(h + 1):
                if use(key, total, t) > Q(r['availability'][t]['amount'] or '0') - Q(r['safetyMargin']): reasons.append(f'RESOURCE:{key}:{sid}:{t}')
        for c in covenants.values():
            for t in c['periods']:
                used = Q(0)
                for term in c['terms']:
                    key = term['resourceId']; coefficient = Q(term['coefficient']); fixed = minimum[key] if coefficient < 0 else base[key]
                    used += coefficient * use(key, [x + y for x, y in zip(fixed, inc[key])], t)
                if used > Q(c['maximum']) - Q(c['safetyMargin']): reasons.append(f'COVENANT:{c["id"]}:{sid}:{t}')
        for d in p['mandate']['resources']['dimensions']:
            if sum((mandate_use[sid][pid][d['id']]['total'] for pid in selected), Q(0)) > Q(str(d['totalLimit'])): reasons.append('MANDATE_TOTAL:' + d['id'])
            for t in range(h + 1):
                if sum((mandate_use[sid][pid][d['id']]['occupancy'][t] for pid in selected), Q(0)) > Q(str(d['capacity'])): reasons.append('MANDATE_OCCUPANCY:' + d['id'])
        for c in p['mandate']['resources']['couplings']:
            for t in range(h + 1):
                used = sum((Q(str(weight)) * mandate_use[sid][pid][key]['occupancy'][t] for key, weight in c['weights'].items() for pid in selected), Q(0))
                if used > Q(str(c['maxPerPeriod'])): reasons.append('MANDATE_COUPLING:' + c['id'])
        if sum((human_use[sid][pid] for pid in selected), Q(0)) > Q(str(p['mandate']['search']['maxHumanSeconds'])): reasons.append('HUMAN_BUDGET')
        value = Q(s['baseValue']) + sum((Q(v['value']) for v in s['terms'] if set(v['policyIds']) <= selected), Q(0))
        if value < Q(str(p['mandate']['risk']['minimumUtility'])): reasons.append('RISK:' + sid)
        values.append(value); usages.append(inc)
    envelopes = {}
    for key, r in resources.items():
        highs = [max(use(key, raw[key], t) for raw in usages) for t in range(h + 1)]
        lows = [min(use(key, raw[key], t) for raw in usages) for t in range(h + 1)]
        if r['kind'] in ('STOCK', 'CUMULATIVE_EXPENDITURE'):
            highs = [highs[0], *[b-a for a,b in zip(highs,highs[1:])]]
            lows = [lows[0], *[b-a for a,b in zip(lows,lows[1:])]]
        envelopes[key] = {'maximum': list(map(str, highs)), 'minimum': list(map(str, lows))}
    return {'feasible': not reasons, 'reasons': sorted(set(reasons)), 'value': str(min(values)), 'scenarioValues': list(map(str, values)), 'envelopes': envelopes}

# Independent exact reference region; no backend output or claimed bound read.
result = {'schema':'finnor.s5.independent-reference.v1', 'inputQualification':'SUPPLIED_H1_ONLY', 'exact':None, 'numerical':None}
if len(ids) <= 14:
    best = None; rows = []; exclusions = {key: None for key in ids}
    for bits in itertools.product((False,True), repeat=len(ids)):
        selected = [key for key,bit in zip(ids,bits) if bit]; observed = evaluate(selected); rows.append({'selected':selected, **observed})
        if observed['feasible']:
            value = Q(observed['value'])
            if best is None or value > best['value']: best = {'selected':selected, 'value':value, 'observed':observed}
            for key in set(ids)-set(selected): exclusions[key] = max(exclusions[key],value) if exclusions[key] is not None else value
    result['exact'] = {'subsets':len(rows), 'rows':rows, 'selected':best['selected'] if best else None, 'optimum':str(best['value']) if best else None,
                       'exclusionValues':{k:None if v is None else str(v) for k,v in exclusions.items()}}

# Strong matched MILP comparator compiled separately from canonical meaning.
import numpy as np
from scipy.optimize import milp, Bounds, LinearConstraint
from scipy.sparse import csc_array
products = sorted({tuple(sorted(t['policyIds'])) for s in p['jointModel']['scenarios'] for t in s['terms'] if len(t['policyIds'])>1})
columns = {key:i for i,key in enumerate(ids)}; ys = {key:len(ids)+i for i,key in enumerate(products)}; z = len(ids)+len(products); n = z+1
rows = []; lower = []; upper = []; names = []
def row(name, coeff, hi=None, lo=None):
    names.append(name); rows.append(coeff); lower.append(-np.inf if lo is None else lo); upper.append(np.inf if hi is None else hi)
for group,col in ys.items():
    for pid in group: row('product:'+('|'.join(group))+':'+pid,{col:Q(1),columns[pid]:Q(-1)},Q(0))
    row('product:'+('|'.join(group))+':lower',{col:Q(-1),**{columns[pid]:Q(1) for pid in group}},Q(len(group)-1))
for key in committed & set(ids): row('already-committed:'+key,{columns[key]:Q(1)},Q(0))
for choice in p['jointModel']['choiceConstraints']: row('choice:'+choice['id'],{columns[key]:Q(1) for key in choice['policyIds']},Q(choice['maximum']),Q(choice['minimum']))
for s in p['jointModel']['scenarios']:
    sid = s['id']
    fixed = {key:list(values) for key,values in base.items()}; minimum_fixed = {key:list(values) for key,values in minimum.items()}
    if tail_resource: fixed[tail_resource][h] += tail; minimum_fixed[tail_resource][h] += tail
    for key,r in resources.items():
        for t in range(h+1): row(f'resource:{key}:{sid}:{t}',{columns[pid]:use(key,demands[sid][pid][key],t) for pid in ids},Q(r['availability'][t]['amount'] or '0')-Q(r['safetyMargin'])-use(key,fixed[key],t))
    for covenant in covenants.values():
        for t in covenant['periods']:
            coeff = {columns[pid]:Q(0) for pid in ids}; constant = Q(0)
            for term in covenant['terms']:
                key = term['resourceId']; q = Q(term['coefficient']); constant += q * use(key,(minimum_fixed if q<0 else fixed)[key],t)
                for pid in ids: coeff[columns[pid]] += q*use(key,demands[sid][pid][key],t)
            row(f'covenant:{covenant["id"]}:{sid}:{t}',coeff,Q(covenant['maximum'])-Q(covenant['safetyMargin'])-constant)
    for d in p['mandate']['resources']['dimensions']:
        key = d['id']; row(f'mandate-total:{key}:{sid}',{columns[pid]:mandate_use[sid][pid][key]['total'] for pid in ids},Q(str(d['totalLimit'])))
        for t in range(h+1): row(f'mandate-occupancy:{key}:{sid}:{t}',{columns[pid]:mandate_use[sid][pid][key]['occupancy'][t] for pid in ids},Q(str(d['capacity'])))
    for c in p['mandate']['resources']['couplings']:
        for t in range(h+1): row(f'mandate-coupling:{c["id"]}:{sid}:{t}',{columns[pid]:sum((Q(str(w))*mandate_use[sid][pid][key]['occupancy'][t] for key,w in c['weights'].items()),Q(0)) for pid in ids},Q(str(c['maxPerPeriod'])))
    row('mandate-human:'+sid,{columns[pid]:human_use[sid][pid] for pid in ids},Q(str(p['mandate']['search']['maxHumanSeconds'])))
    payoff = {z:Q(1)}
    for term in s['terms']:
        col = columns[term['policyIds'][0]] if len(term['policyIds'])==1 else ys[tuple(sorted(term['policyIds']))]
        payoff[col] = payoff.get(col,Q(0))-Q(term['value'])
    row('worst-path:'+sid,payoff,Q(s['baseValue'])); row('risk-floor:'+sid,{k:v for k,v in payoff.items() if k!=z},Q(s['baseValue'])-Q(str(p['mandate']['risk']['minimumUtility'])))

# Independent exact canonical Lagrangian proof, before numerical row reduction.
if proof:
    canonical={}
    for name,a,lo,hi in zip(names,rows,lower,upper):
        if math.isfinite(hi): canonical[('upper',name)]=(a,Q(hi))
        if math.isfinite(lo): canonical[('lower',name)]=({k:-v for k,v in a.items()},-Q(lo))
    seen=set();weights={};alpha={}
    for m in proof['proposal']['multipliers']:
        key=(m['side'],m['rowId']);q=Q(m['value'])
        if key in seen or q<0 or key not in canonical: raise ValueError('INVALID_CANONICAL_MULTIPLIER')
        seen.add(key)
        if key[1].startswith('worst-path:'):
            if key[0]!='upper': raise ValueError('INVALID_SCENARIO_WEIGHT')
            weights[key[1][len('worst-path:'):]]=q
        else: alpha[key]=q
    mass=sum(weights.values(),Q(0))
    if mass<=0: raise ValueError('INVALID_SCENARIO_MASS')
    residual={i:Q(0) for i in range(z)};exact_upper=Q(0)
    for scenario in p['jointModel']['scenarios']:
        w=weights.get(scenario['id'],Q(0))/mass;exact_upper+=w*Q(scenario['baseValue'])
        for term in scenario['terms']:
            col=columns[term['policyIds'][0]] if len(term['policyIds'])==1 else ys[tuple(sorted(term['policyIds']))]
            residual[col]+=w*Q(term['value'])
    for key,q in alpha.items():
        a,b=canonical[key];w=q/mass;exact_upper+=w*b
        for col,v in a.items():
            if col==z: raise ValueError('UNSUPPORTED_DUAL_VARIABLE')
            residual[col]-=w*v
    exact_upper+=sum((q for q in residual.values() if q>0),Q(0))
    rounded=Q(math.ceil(exact_upper*10**12),10**12)
    result['dual']={'exactUpper':str(exact_upper),'roundedUpper':str(rounded),'qualification':'INDEPENDENT_FRACTION_ORIGINAL_ACTIONS_CANONICAL_BOUND'}

# Integer lattice reduction is independently applied to binary-only constraints.
for i,coeff in enumerate(rows):
    if z in coeff: continue
    denominators = [q.denominator for q in coeff.values() if q]
    common_denominator = math.lcm(*denominators) if denominators else 1
    integers = [int(q*common_denominator) for q in coeff.values()]
    divisor = math.gcd(*integers) if integers else 1
    scale = Q(common_denominator, divisor or 1)
    if integers and max(abs(q*scale) for q in coeff.values()) <= 10**12:
        rows[i] = {k:q*scale for k,q in coeff.items()}
        # Reconstruct exact bounds from original row for decimals near a margin.
        # Comparator bounds are numerical; exact oracle remains authoritative.
        lower[i] = math.ceil(lower[i]*scale) if math.isfinite(lower[i]) else lower[i]
        upper[i] = math.floor(upper[i]*scale) if math.isfinite(upper[i]) else upper[i]
ri=[];ci=[];data=[]
for i,coeff in enumerate(rows):
    for j,q in coeff.items():
        if q: ri.append(i);ci.append(j);data.append(float(q))
A=csc_array((np.array(data),(np.array(ri,dtype=np.int32),np.array(ci,dtype=np.int32))),shape=(len(rows),n))
c=np.zeros(n);c[z]=-1;lb=np.zeros(n);ub=np.ones(n);lb[z]=-1e12;ub[z]=1e12;integ=np.ones(n);integ[z]=0
solved=milp(c,integrality=integ,bounds=Bounds(lb,ub),constraints=LinearConstraint(A,np.array(lower,dtype=float),np.array(upper,dtype=float)),options={'time_limit':max(.001,30-(time.monotonic()-START)),'mip_rel_gap':0,'node_limit':p['mandate']['search']['maxExpansions']})
selected=[key for key,i in columns.items() if solved.x is not None and solved.x[i]>.5]
dual_bound=getattr(solved,'mip_dual_bound',None)
result['numerical']={'status':int(solved.status),'termination':str(solved.message),'selected':selected,'originalExactCheck':evaluate(selected),
                     'upperEstimate':None if dual_bound is None or not math.isfinite(dual_bound) else -float(dual_bound),'qualification':'SEPARATE_FORMULATION_SAME_HIGHS_NUMERICAL_CORROBORATION_NOT_PROOF'}
result['elapsedMs']=(time.monotonic()-START)*1000
json.dump(result,sys.stdout,allow_nan=False)
