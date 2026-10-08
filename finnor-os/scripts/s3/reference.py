"""Independent hidden-law generator and reference, never imported by the learner.
Known-generative H1 evidence only. JSON coefficients/truth stay with evaluator.
"""
import json
import math
import random
import sys


def transition(history, dose, noise, shifted=False):
    prev, prev2 = history[-1], history[-2]
    y = prev['states']
    a, d = dose['price'], dose['disclosure']
    return {
        'revenue': 0.40 * y['revenue'] + 1.2 * a - 0.60 * prev2['exposures']['price']
                   - 0.55 * y['actor'] + 0.18 * y['inventory'] + 0.2 * a * y['inventory'] + noise[0],
        'inventory': 0.50 * y['inventory'] - 0.25 * prev['exposures']['price']
                     + 0.15 * y['revenue'] + noise[1],
        'actor': 0.45 * y['actor'] + (1.4 if shifted else 0.70) * prev['exposures']['price']
                 + 0.30 * d + 0.20 * prev2['exposures']['price'] + noise[2],
        'peer': 0.35 * y['peer'] - 0.50 * a + 0.40 * y['actor'] + noise[3],
    }


def generate(n=128, seed=20261003, shifted=False):
    rng = random.Random(seed)
    zero = {'states': dict.fromkeys(['revenue', 'inventory', 'actor', 'peer'], 0.0),
            'exposures': {'price': 0.0, 'disclosure': 0.0}}
    rows = [zero, zero]
    for i in range(n):
        price = rng.uniform(-0.65, 0.65) + 0.10 * rows[-1]['states']['inventory']
        dose = {'price': price, 'disclosure': rng.uniform(-0.65, 0.65)}
        common = rng.gauss(0, 0.16)
        noise = [common + rng.gauss(0, 0.10), rng.gauss(0, 0.12),
                 rng.gauss(0, 0.10), common + rng.gauss(0, 0.10)]
        states = transition(rows, dose, noise, shifted and i >= 96)
        rows.append({'period': i, 'states': states, 'exposures': dose})
    return rows[2:]


def trajectories(history, treatment, comparator, draws=1024, seed=88731, shifted=False):
    rng = random.Random(seed)
    paths, differences = [], []
    for _ in range(draws):
        left, right = list(history), list(history)
        path, difference = [], []
        for a, b in zip(treatment, comparator):
            common = rng.gauss(0, 0.16)
            noise = [common + rng.gauss(0, 0.10), rng.gauss(0, 0.12),
                     rng.gauss(0, 0.10), common + rng.gauss(0, 0.10)]
            yl, yr = transition(left, a, noise, shifted), transition(right, b, noise, shifted)
            left.append({'states': yl, 'exposures': a})
            right.append({'states': yr, 'exposures': b})
            path.append(yl); difference.append({k: yl[k] - yr[k] for k in yl})
        paths.append(path); differences.append(difference)
    means, effects, intervals = [], [], []
    for t in range(len(treatment)):
        means.append({k: sum(p[t][k] for p in paths)/draws for k in paths[0][t]})
        effects.append({k: sum(p[t][k] for p in differences)/draws for k in differences[0][t]})
        intervals.append({k: [sorted(p[t][k] for p in paths)[int(.05*draws)],
                              sorted(p[t][k] for p in paths)[int(.95*draws)]] for k in paths[0][t]})
    return {'means': means, 'effects': effects, 'intervals': intervals, 'paths': paths}


def least_squares(rows, equations):
    # Independent SciPy QR/SVD baseline; learner uses statsmodels and block fits.
    import numpy as np
    from scipy.linalg import lstsq
    def feature(f, i):
        if f['kind'] == 'CONSTANT': return 1.0
        if f['kind'] == 'PRODUCT': return feature(f['left'], i) * feature(f['right'], i)
        return rows[i-f['lag']]['states' if f['kind'] == 'STATE' else 'exposures'][f['id']]
    coefficients = {}
    for equation in equations:
        x = np.array([[feature(f, i) for f in equation['features']] for i in range(3, 96)])
        y = np.array([rows[i]['states'][equation['variableId']] for i in range(3, 96)])
        coefficients[equation['variableId']] = lstsq(x, y, lapack_driver='gelsy')[0].tolist()
    return coefficients


if __name__ == '__main__':
    request = json.load(sys.stdin)
    operation = request.get('operation', 'generate')
    if operation == 'generate': result = generate(request.get('n', 128), request.get('seed', 20261003), request.get('shifted', False))
    elif operation == 'reference': result = trajectories(request['history'], request['treatment'], request['comparator'], request.get('draws', 1024))
    elif operation == 'least_squares': result = least_squares(request['rows'], request['equations'])
    elif operation == 'equivalent':
        # Both mechanisms produce A=U, Y=U+e observationally. do(A) distinguishes
        # Y=A+e from Y=U+e. Nondegenerate errors prevent a rank/diagnostic failure
        # from becoming an unrelated reason for passing the ambiguity challenge.
        rng = random.Random(20261004)
        observed = []
        for i in range(128):
            u = rng.uniform(-.65, .65)
            observed.append({'period': i, 'states': {'outcome': u+rng.gauss(0, .1)}, 'exposures': {'price': u}})
        result = {'rows': observed,
                  'causalEffect': 1, 'confoundedEffect': 0}
    else: raise ValueError('unsupported evaluator operation')
    json.dump(result, sys.stdout, allow_nan=False)
