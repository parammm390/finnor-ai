"""Registered independent generated-data parameter/dynamics qualification.
Necessary numerical isolation: actual production stdio adapter, no test export.
Never S1 authenticity, prospective field evidence, release or causal admission.
"""
import hashlib
import json
import os
import pathlib
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone

import numpy as np
from scipy.stats import bootstrap
from reference import generate, transition

repo = pathlib.Path(__file__).resolve().parents[3]
source = repo/'finnor-os/packages/epistemic-runtime/src/intervention-numerics.py'
template = json.loads(pathlib.Path(sys.argv[1]).read_text())['request']
directory = repo/'scope-3/scope-evidence'/('numeric-'+datetime.now(timezone.utc).strftime('%Y-%m-%dT%H-%M-%S')+'-'+str(uuid.uuid4())[:8])
directory.mkdir(parents=True)
manifest = {str(p.relative_to(repo)): hashlib.sha256(p.read_bytes()).hexdigest() for p in [source, pathlib.Path(__file__), pathlib.Path(__file__).with_name('reference.py')]}
registration = {'datasets': 40, 'seedStart': 20262003, 'trainingPeriods': 96, 'periods': 128,
                'horizon': 8, 'bootstrapDraws': 128, 'blockLength': 4, 'observed90Coverage': [.82, .98],
                'maximumNormalizedEffectError': .10, 'mean90WidthRangeFraction': .5, 'manifest': manifest,
                'qualification': 'Independent known-generative numerical H1 only; no field/S1/method admission'}
(directory/'registration.json').write_text(json.dumps(registration, indent=2)+'\n')
trials = []
ids = [v['id'] for v in template['stateVariables']]
treatment = [{'price': .15 if t < 4 else -.15, 'disclosure': 0} for t in range(8)]
comparator = [{'price': 0, 'disclosure': 0} for _ in range(8)]


def true_effect(rows):
    left, right = list(rows[-3:]), list(rows[-3:]); effects = []
    for a, b in zip(treatment, comparator):
        yl, yr = transition(left, a, [0]*4), transition(right, b, [0]*4)
        effects.append([yl[v]-yr[v] for v in ids])
        left.append({'states': yl, 'exposures': a}); right.append({'states': yr, 'exposures': b})
    return np.asarray(effects)


def estimated_effect(rows, equations, coefficients):
    left, right = list(rows[-3:]), list(rows[-3:]); effects = []
    def value(f, history, action):
        if f['kind'] == 'CONSTANT': return 1
        if f['kind'] == 'PRODUCT': return value(f['left'], history, action)*value(f['right'], history, action)
        if f['kind'] == 'STATE': return history[-f['lag']]['states'][f['id']]
        return action[f['id']] if f['lag'] == 0 else history[-f['lag']]['exposures'][f['id']]
    for a, b in zip(treatment, comparator):
        yl, yr = {}, {}
        for e, beta in zip(equations, coefficients):
            yl[e['variableId']] = sum(c*value(f, left, a) for c, f in zip(beta, e['features']))
            yr[e['variableId']] = sum(c*value(f, right, b) for c, f in zip(beta, e['features']))
        effects.append([yl[v]-yr[v] for v in ids]); left.append({'states': yl, 'exposures': a}); right.append({'states': yr, 'exposures': b})
    return np.asarray(effects)


def save():
    if not trials: return
    coverages = np.asarray([t['coverage90'] for t in trials if t['status'] == 'PASS'])
    summary = {'completed': len(trials), 'failed': sum(t['status'] != 'PASS' for t in trials)}
    if len(coverages):
        summary['observedCoverage90'] = float(coverages.mean())
        summary['clusterUnit'] = 'Independent generated dataset; all firms/horizons within it remain dependent'
        if len(coverages) >= 2:
            confidence = bootstrap((coverages,), np.mean, confidence_level=.95, n_resamples=2000, method='basic', rng=np.random.default_rng(99173)).confidence_interval
            summary['approximate95DatasetClusterInterval'] = [float(confidence.low), float(confidence.high)]
        summary['meanNormalizedEffectError'] = float(np.mean([t['normalizedMeanError'] for t in trials if t['status'] == 'PASS']))
    status = 'PASS_GENERATED_NUMERICAL' if len(trials) == 40 and not summary['failed'] and .82 <= summary.get('observedCoverage90', 0) <= .98 else 'IN_PROGRESS' if len(trials) < 40 else 'FAIL'
    (directory/'results.json').write_text(json.dumps({'registration': registration, 'status': status, 'summary': summary, 'trials': trials,
        'rerun': '/tmp/finnor-s3-python/bin/python finnor-os/scripts/s3/qualify-numerics.py <S3-run>/preregistered-inputs.json',
        'fieldCoverage': 'UNKNOWN', 'independentMethodAdmission': 'BLOCKED_EXTERNAL'}, indent=2)+'\n')


for trial in range(40):
    seed = registration['seedStart']+trial; rows = generate(seed=seed)
    payload = {'operation': 'fit', 'request': template, 'rows': rows, 'trainingPeriods': 96}
    (directory/f'input-{trial:02}.json').write_text(json.dumps(payload))
    started = time.perf_counter()
    try:
        environment = {'PATH': os.environ.get('PATH', ''), 'OPENBLAS_NUM_THREADS': '1', 'OMP_NUM_THREADS': '1', 'LC_ALL': 'C'}
        completed = subprocess.run([sys.executable, '-I', str(source)], input=json.dumps(payload), capture_output=True, text=True, env=environment, timeout=20)
        if completed.returncode: raise RuntimeError(completed.stderr[:1000])
        result = json.loads(completed.stdout); fitted = result['fits'][0]
        if fitted['status'] != 'FITTED': raise RuntimeError(fitted['reason'])
        actual = true_effect(rows)
        draws = np.asarray([estimated_effect(rows, fitted['equations'], beta) for beta in fitted['parameterDraws']])
        lower, upper = np.quantile(draws, [.05, .95], axis=0)
        coverage = float(np.mean((actual >= lower) & (actual <= upper)))
        estimated = estimated_effect(rows, fitted['equations'], [e['coefficients'] for e in fitted['equations']])
        error = float(np.mean(np.abs(estimated-actual))/12); width = float(np.mean(upper-lower)/12)
        if error > .10 or width > .5: raise RuntimeError('REGISTERED_ERROR_OR_WIDTH_FAILURE')
        (directory/f'fit-{trial:02}.json').write_text(completed.stdout)
        trials.append({'seed': seed, 'status': 'PASS', 'coverage90': coverage, 'normalizedMeanError': error, 'normalizedMean90Width': width,
                       'elapsedMs': (time.perf_counter()-started)*1000, 'usage': result['usage'], 'backend': result['backend'],
                       'trueEffects': actual.tolist(), 'estimatedEffects': estimated.tolist(), 'lower90': lower.tolist(), 'upper90': upper.tolist()})
    except Exception as error:
        trials.append({'seed': seed, 'status': 'FAIL', 'reason': str(error), 'elapsedMs': (time.perf_counter()-started)*1000})
    save()
print(json.dumps({'directory': str(directory), 'completed': len(trials), 'failed': sum(t['status'] != 'PASS' for t in trials)}))
sys.exit(0 if json.loads((directory/'results.json').read_text())['status'] == 'PASS_GENERATED_NUMERICAL' else 1)
