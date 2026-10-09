"""Replaceable S3 numerical adapter. No enterprise ownership/authority/policy.
JSON on stdio only; no pickle, arbitrary code, network, provider or filesystem
data lookup. Fitting, bootstrap and hull machinery come from mature libraries.
"""
import hashlib
import importlib.metadata
import json
import resource
import sys
import time
import warnings

import numpy as np
import scipy
from scipy.spatial import ConvexHull, QhullError
from scipy.stats import beta, levene
from statsmodels.regression.linear_model import OLS
from statsmodels.stats.diagnostic import acorr_ljungbox
from arch.bootstrap import MovingBlockBootstrap

PINNED = {'numpy': '2.3.3', 'scipy': '1.16.2', 'statsmodels': '0.14.5', 'arch': '8.0.0', 'pandas': '2.3.2'}


def atom(f, rows, i):
    if f['kind'] == 'CONSTANT': return 1.0
    key = 'states' if f['kind'] == 'STATE' else 'exposures'
    return rows[i-f['lag']][key][f['id']]


def feature(f, rows, i):
    if f['kind'] == 'PRODUCT': return atom(f['left'], rows, i) * atom(f['right'], rows, i)
    return atom(f, rows, i)


def fit(payload):
    request, rows = payload['request'], payload['rows']
    cut = payload['trainingPeriods']
    indices = np.arange(3, cut)
    holdout = np.arange(cut, len(rows))
    if len(indices) < 61 or len(holdout) < 20: raise ValueError('INSUFFICIENT_HISTORY')
    results = []
    for mechanism in request['mechanisms']:
        try:
            equations, designs, outcomes, estimates, residuals, refutations = [], [], [], [], [], []
            for equation in mechanism['equations']:
                features = equation['features']; var = equation['variableId']
                x = np.asarray([[feature(f, rows, int(i)) for f in features] for i in indices])
                y = np.asarray([rows[int(i)]['states'][var] for i in indices])
                hx = np.asarray([[feature(f, rows, int(i)) for f in features] for i in holdout])
                hy = np.asarray([rows[int(i)]['states'][var] for i in holdout])
                rank = int(np.linalg.matrix_rank(x)); condition = float(np.linalg.cond(x))
                if rank != len(features) or condition > 1e8: raise ValueError('RANK_OR_CONDITION_FAILURE')
                estimate = OLS(y, x, missing='raise', hasconst=True).fit(method='qr')
                residual = y-estimate.predict(x); hresidual = hy-estimate.predict(hx)
                width = next(v['range'][1]-v['range'][0] for v in request['stateVariables'] if v['id'] == var)
                rmse = float(np.sqrt(np.mean(hresidual**2))); shift = float(np.abs(np.mean(hresidual))/width)
                p = float(acorr_ljungbox(residual, lags=[4], return_df=True)['lb_pvalue'].iloc[0]) if np.var(residual) >= 1e-20 else None
                if np.var(residual) < 1e-20 or np.var(hresidual) < 1e-20:
                    scale_p = 0.0 if np.var(hresidual) > max(100*np.var(residual), 1e-12) else 1.0
                else:
                    scale_p = float(levene(residual, hresidual, center='median').pvalue)
                refutations.extend([
                    {'test': f'{var}:chronological-prediction', 'status': 'FALSIFIED' if rmse/width > .15 else 'NOT_FALSIFIED', 'value': rmse/width, 'threshold': .15, 'reason': 'Registered normalized one-step holdout RMSE; not causal identification'},
                    {'test': f'{var}:residual-shift', 'status': 'FALSIFIED' if shift > .10 else 'NOT_FALSIFIED', 'value': shift, 'threshold': .10, 'reason': 'Registered chronological residual mean shift; not proof of stationarity'},
                    {'test': f'{var}:unmodeled-serial-dependence', 'status': 'UNAVAILABLE' if p is None else 'FALSIFIED' if p < .001 else 'NOT_FALSIFIED', 'value': p, 'threshold': .001, 'reason': 'Ljung-Box diagnostic; zero-variance residuals do not establish stochastic calibration or mechanism truth'},
                    {'test': f'{var}:holdout-error-scale', 'status': 'FALSIFIED' if scale_p < .001 else 'NOT_FALSIFIED', 'value': scale_p, 'threshold': .001, 'reason': 'Brown-Forsythe residual-scale diagnostic under declared weak dependence; not exact sequential test or identification'},
                ])
                equations.append({'variableId': var, 'features': features, 'coefficients': estimate.params.tolist(), 'rank': rank,
                                  'conditionNumber': condition, 'trainingRmse': float(np.sqrt(np.mean(residual**2))),
                                  'holdoutRmse': rmse, 'normalizedHoldoutRmse': rmse/width, 'holdoutMeanResidual': float(np.mean(hresidual))})
                designs.append(x); outcomes.append(y); estimates.append(estimate.params); residuals.append(residual)
            # Whole time rows are resampled together, never each outcome/firm.
            bootstrap = MovingBlockBootstrap(request['numerical']['blockLength'], np.arange(len(indices)), seed=request['numerical']['seed'])
            draws = []
            for positional, _ in bootstrap.bootstrap(request['numerical']['bootstrapDraws']):
                sample = positional[0].astype(int); draw = []
                for x, y in zip(designs, outcomes):
                    if np.linalg.matrix_rank(x[sample]) != x.shape[1]: raise ValueError('BOOTSTRAP_RANK_FAILURE')
                    draw.append(OLS(y[sample], x[sample], missing='raise', hasconst=True).fit(method='qr').params.tolist())
                draws.append(draw)
            joint = np.column_stack(residuals)
            results.append({'mechanismId': mechanism['id'], 'status': 'FITTED', 'reason': None, 'equations': equations,
                            'parameterDraws': draws, 'residuals': joint.tolist(), 'residualCovariance': np.atleast_2d(np.cov(joint.T)).tolist(),
                            'refutations': refutations, 'qualification': 'FITTED_CONDITIONAL_LAW_NOT_CAUSAL_PROOF'})
        except (ValueError, np.linalg.LinAlgError) as error:
            results.append({'mechanismId': mechanism['id'], 'status': 'NUMERICAL_FAILURE', 'reason': str(error), 'equations': [],
                            'parameterDraws': [], 'residuals': [], 'residualCovariance': [], 'refutations': [],
                            'qualification': 'FITTED_CONDITIONAL_LAW_NOT_CAUSAL_PROOF'})
    return {'fits': results}


def support_hull(points):
    x = np.asarray(points); center = x.mean(axis=0)
    _, singular, vt = np.linalg.svd(x-center, full_matrices=False)
    rank = int(np.sum(singular > max(1, singular[0])*1e-10))
    basis = vt[:rank].T
    if rank > 6:
        return {'available': False, 'reason': 'FULL_FEATURE_HULL_COMPLEXITY_UNQUALIFIED', 'rank': rank}
    projected = (x-center)@basis
    if rank == 0: return {'available': True, 'center': center, 'basis': basis, 'rank': 0}
    if rank == 1: return {'available': True, 'center': center, 'basis': basis, 'rank': 1, 'range': [projected.min(), projected.max()]}
    try:
        hull = ConvexHull(projected)
        if len(hull.equations) > 100000: return {'available': False, 'reason': 'SUPPORT_FACET_BUDGET_EXCEEDED', 'rank': rank}
        return {'available': True, 'center': center, 'basis': basis, 'rank': rank, 'halfspaces': hull.equations}
    except QhullError:
        return {'available': False, 'reason': 'SUPPORT_HULL_NUMERICAL_FAILURE', 'rank': rank}


def supported(hull, features):
    if not hull['available']: return np.zeros(len(features), dtype=bool)
    delta = features-hull['center']; projected = delta@hull['basis']
    # Missing affine support and floating-point slack remain explicit limits.
    affine = np.max(np.abs(delta-projected@hull['basis'].T), axis=1) <= 1e-8
    if hull['rank'] == 0: return affine
    if hull['rank'] == 1: return affine & (projected[:, 0] >= hull['range'][0]-1e-8) & (projected[:, 0] <= hull['range'][1]+1e-8)
    half = hull['halfspaces']
    # Chunk facets to bound memory without weakening the full hull check.
    good = affine.copy()
    for i in range(0, len(half), 512):
        good &= np.all(projected@half[i:i+512, :-1].T+half[i:i+512, -1] <= 1e-8, axis=1)
    return good


def simulation(payload):
    model, query = payload['model'], payload['query']
    request = model['request']; count = query['simulations']; horizon = query['horizon']
    ids = [v['id'] for v in request['stateVariables']]; offset = {v: i for i, v in enumerate(ids)}
    responses = []
    rng = np.random.default_rng(query['seed'])
    for fitted in model['fits']:
        if fitted['status'] != 'FITTED': continue
        equations = fitted['equations']; residual = np.asarray(fitted['residuals'])
        boot = fitted['parameterDraws']; parameter_indices = rng.integers(0, len(boot), count)
        coefs = [np.asarray([boot[int(i)][j] for i in parameter_indices]) for j in range(len(equations))]
        # Reconstruct from the committed measured history. Serializing a second
        # full copy of every feature matrix needlessly multiplies artifact size.
        training_indices = range(3, model['history']['trainingPeriods'])
        support = [support_hull([[feature(f, model['history']['rows'], i) for f in e['features']] for i in training_indices]) for e in equations]
        initial = model['history']['rows'][-3:]
        left = [np.tile([r['states'][v] for v in ids], (count, 1)) for r in initial]
        right = [x.copy() for x in left]
        mean_left = [x.copy() for x in left]; mean_right = [x.copy() for x in right]
        exposures_left = [{k: np.full(count, v) for k, v in r['exposures'].items()} for r in initial]
        exposures_right = [{k: v.copy() for k, v in row.items()} for row in exposures_left]
        unsupported = np.zeros(count, dtype=bool); periods = []; checks = 0; failures = 0
        block = request['numerical']['blockLength']; block_starts = None
        for t in range(horizon):
            exposures_left.append({c['exposureId']: np.full(count, c['doses'][t]) for c in query['intervention']['channels']})
            exposures_right.append({c['exposureId']: np.full(count, c['doses'][t]) for c in query['comparator']['channels']})
            if t % block == 0: block_starts = rng.integers(0, max(1, len(residual)-block+1), count)
            # Same residual vector across firms/variables; paired alternatives
            # are a Monte Carlo coupling, not an individual counterfactual.
            shocks = residual[block_starts+t % block]
            next_left = np.zeros((count, len(ids))); next_right = next_left.copy()
            next_mean_left = next_left.copy(); next_mean_right = next_left.copy()
            def values(features, states, exposures):
                def a(f):
                    if f['kind'] == 'CONSTANT': return np.ones(count)
                    if f['kind'] == 'STATE': return states[-f['lag']][:, offset[f['id']]]
                    return exposures[-1-f['lag']][f['id']]
                return np.column_stack([a(f['left'])*a(f['right']) if f['kind'] == 'PRODUCT' else a(f) for f in features])
            for j, e in enumerate(equations):
                k = offset[e['variableId']]
                x = values(e['features'], left, exposures_left); cx = values(e['features'], right, exposures_right)
                mx = values(e['features'], mean_left, exposures_left); mcx = values(e['features'], mean_right, exposures_right)
                valid = supported(support[j], x) & supported(support[j], cx)
                unsupported |= ~valid; failures += int(np.sum(~valid)); checks += count
                next_left[:, k] = np.einsum('ij,ij->i', x, coefs[j])+shocks[:, j]
                next_right[:, k] = np.einsum('ij,ij->i', cx, coefs[j])+shocks[:, j]
                next_mean_left[:, k] = np.einsum('ij,ij->i', mx, coefs[j])
                next_mean_right[:, k] = np.einsum('ij,ij->i', mcx, coefs[j])
            if not np.isfinite(next_left).all() or not np.isfinite(next_right).all(): raise ValueError('ROLLOUT_OVERFLOW')
            for j, variable in enumerate(request['stateVariables']):
                lo, hi = variable['range']
                unsupported |= (next_left[:, j] < lo) | (next_left[:, j] > hi) | (next_right[:, j] < lo) | (next_right[:, j] > hi)
            left.append(next_left); right.append(next_right); mean_left.append(next_mean_left); mean_right.append(next_mean_right)
            failed = int(unsupported.sum()); mass = failed/count
            upper = float(beta.ppf(.95, failed+1, count-failed)) if failed < count else 1.0
            if fitted['mechanismId'] in payload['unresolvedMechanisms']: upper = 1.0
            state_intervals, effect_intervals, means, contrast_means, effects, mean_bounds, effect_bounds = {}, {}, {}, {}, {}, {}, {}
            for j, variable in enumerate(request['stateVariables']):
                v = variable['id']; lo, hi = variable['range']; width = hi-lo
                state_intervals[v] = {}; effect_intervals[v] = {}
                for level in [.5, .8, .9, .95]:
                    q = [(1-level)/2, (1+level)/2]
                    state_intervals[v][str(level)] = np.quantile(next_left[:, j], q).tolist()
                    effect_intervals[v][str(level)] = np.quantile(next_mean_left[:, j]-next_mean_right[:, j], q).tolist()
                means[v] = float(next_left[:, j].mean()); contrast_means[v] = float(next_right[:, j].mean())
                effects[v] = float((next_mean_left[:, j]-next_mean_right[:, j]).mean())
                # Do not silently condition the output on surviving paths.
                good = ~unsupported
                known_mean = float(next_left[good, j].mean()) if good.any() else 0
                known_effect = float((next_left[good, j]-next_right[good, j]).mean()) if good.any() else 0
                mean_bounds[v] = [max(lo, (1-upper)*known_mean+upper*lo), min(hi, (1-upper)*known_mean+upper*hi)]
                effect_bounds[v] = [max(-width, (1-upper)*known_effect-upper*width), min(width, (1-upper)*known_effect+upper*width)]
            periods.append({'period': t, 'stateMean': means, 'comparatorMean': contrast_means, 'effectMean': effects,
                            'stateIntervals': state_intervals, 'effectParameterIntervals': effect_intervals, 'stateCovariance': np.atleast_2d(np.cov(next_left.T)).tolist(),
                            'unsupportedFraction': mass, 'unsupportedMassUpper95': upper, 'meanBounds': mean_bounds, 'effectBounds': effect_bounds})
        responses.append({'mechanismId': fitted['mechanismId'], 'meaning': 'ASSUMPTION_CONDITIONAL_POPULATION_SIMULATION', 'periods': periods,
                          'support': {'basis': 'TRAINING_FEATURE_CONVEX_HULL', 'failures': failures, 'checks': checks, 'monteCarloUncertainty': True,
                                      'equations': [{'variableId': e['variableId'], 'status': 'AVAILABLE' if h['available'] else 'UNAVAILABLE',
                                                     'reason': h.get('reason'), 'affineRank': h['rank']} for e, h in zip(equations, support)]},
                          'numerical': {'arithmetic': 'FLOAT64', 'simulations': count, 'approximation': 'DEPENDENT_BOOTSTRAP_AND_MONTE_CARLO', 'errorCertificate': None, 'compoundingErrorQualified': False}})
    return {'responses': responses}


def control_kernel(payload):
    """S3 joint law extension; fixed synchronized bootstrap paths, not priors.

    Geometry and scenario provenance stay S3-owned. S4 cannot reconstruct a
    transition law from marginal means or intervals. No policy choice is made.
    """
    model, request = payload['model'], payload['request']
    rng = np.random.default_rng(request['seed'])
    output = []
    for fitted in model['fits']:
        if fitted['status'] != 'FITTED': raise ValueError('INCOMPLETE_FITTED_JOINT_LAW')
        equations, residual = fitted['equations'], np.asarray(fitted['residuals'])
        hulls = []
        for equation in equations:
            hull = support_hull([[feature(f, model['history']['rows'], i) for f in equation['features']]
                                 for i in range(3, model['history']['trainingPeriods'])])
            hulls.append({k: v.tolist() if isinstance(v, np.ndarray) else float(v) if isinstance(v, np.floating) else v for k, v in hull.items()})
        scenarios = []
        block = model['request']['numerical']['blockLength']
        for index in range(request['pathsPerMechanism']):
            draw = int(rng.integers(0, len(fitted['parameterDraws'])))
            shocks = []
            for t in range(request['horizon']):
                if t % block == 0: first = int(rng.integers(0, max(1, len(residual)-block+1)))
                shocks.append(residual[first+t % block].tolist())
            scenarios.append({'id': f"{fitted['mechanismId']}:{index}", 'parameterDrawIndex': draw,
                              'coefficients': fitted['parameterDraws'][draw], 'shocks': shocks})
        output.append({'mechanismId': fitted['mechanismId'], 'equations': equations,
                       'support': hulls, 'scenarios': scenarios})
    return {'mechanisms': output, 'meaning': 'FINITE_FIXED_JOINT_BOOTSTRAP_SCENARIOS_NOT_POSTERIOR_OR_COVERAGE_CERTIFICATE'}


def main():
    start = time.perf_counter()
    versions = {p: importlib.metadata.version(p) for p in PINNED}
    if versions != PINNED: raise ValueError('BACKEND_VERSION_MISMATCH')
    raw = sys.stdin.buffer.read(8*1024*1024+1)
    if len(raw) > 8*1024*1024: raise ValueError('INPUT_LIMIT_EXCEEDED')
    payload = json.loads(raw)
    with warnings.catch_warnings():
        warnings.simplefilter('error', RuntimeWarning)
        result = fit(payload) if payload['operation'] == 'fit' else simulation(payload) if payload['operation'] == 'simulate' else control_kernel(payload) if payload['operation'] == 'control-kernel' else None
    if result is None: raise ValueError('UNSUPPORTED_OPERATION')
    usage = resource.getrusage(resource.RUSAGE_SELF)
    result['backend'] = {'versions': versions, 'python': sys.version, 'sourceDigest': hashlib.sha256(open(__file__, 'rb').read()).hexdigest()}
    result['usage'] = {'elapsedMs': (time.perf_counter()-start)*1000, 'childMaxRssBytes': int(usage.ru_maxrss*(1 if sys.platform == 'darwin' else 1024)),
                       'childCpuUserSeconds': usage.ru_utime, 'childCpuSystemSeconds': usage.ru_stime}
    json.dump(result, sys.stdout, allow_nan=False, separators=(',', ':'))


if __name__ == '__main__':
    try: main()
    except Exception as error:
        # No payload/traceback in error transport; typed failure is retained by
        # the caller alongside the admitted input references and actual attempt.
        print(json.dumps({'failure': type(error).__name__, 'reason': str(error)[:200]}), file=sys.stderr)
        sys.exit(1)
