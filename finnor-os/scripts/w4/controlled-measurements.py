"""Versioned W4 controlled measurement producer, not field/native evidence.

Run the declared zero/one assignments against isolated simulated records.
The causal response equation and shared exogenous errors are retained; do(A)
replaces the exposure assignment, not the response or its disturbance. No old
observations, learner, fitted coefficients or acceptance result are imported.
"""
import copy
import hashlib
import json
import random
import sys
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path


class ControlledRecord:
    def __init__(self, field):
        self.field = field
        self.record = {'version': 'v1', 'fields': {field: 0}}

    def read(self):
        return copy.deepcopy(self.record)

    def apply_native_unit(self):
        # Same exact-value record assignment as the controlled commercial
        # recipient, not a payment, external request or increment assertion.
        self.record = {'version': 'v2', 'fields': {self.field: 1}}


def main():
    assert len(sys.argv) == 1
    source = Path(__file__)
    design_path = source.with_name('controlled-measurement-design.json')
    design = json.loads(design_path.read_text())
    assert design['profileId'] == 'w4-controlled-commercial-service-v1'
    assert design['periods'] == 128 and design['canonicalNumericScale'] == 12
    assert design['exogenous']['seed'] == 20261004
    assignments = [period % 2 for period in range(128)]
    channels = {unit: {'unit': unit, 'operation': design['operation'], 'rows': [], 'trace': []}
                for unit in design['units']}
    rng = random.Random(20261004)
    for period, assigned in enumerate(assignments):
        # Preserve the reference causal world's exogenous draw order. The
        # controlled assignment overrides A; latent U is never an outcome or
        # row-selection input. One error realization couples both unit worlds.
        rng.uniform(-0.65, 0.65)
        error = rng.gauss(0, 0.1)
        for unit, fields in design['units'].items():
            records, readbacks = [], []
            for field in fields:
                world = ControlledRecord(field)
                before = world.read()
                if assigned:
                    world.apply_native_unit()
                after = world.read()
                readback = world.read()
                records.append({'field': field, 'before': before, 'after': after, 'readback': readback,
                                'appliedChanges': {field: 1} if assigned else {}})
                readbacks.append(readback['fields'][field])
            assert readbacks == [assigned, assigned]
            measured = readbacks[0] + error
            reported = format(Decimal(str(measured)).quantize(Decimal('0.000000000001'), rounding=ROUND_HALF_UP), 'f')
            channels[unit]['rows'].append({'period': period, 'states': {'outcome': float(reported)},
                                            'exposures': {'price': readbacks[0]}})
            channels[unit]['trace'].append({'period': period, 'assignedDose': assigned, 'unit': unit,
                                             'records': records, 'reportedOutcomeDecimal': reported})
    json.dump({'schema': 'finnor.w4.controlled-measurements.v1', 'design': design,
               'designSha256': hashlib.sha256(design_path.read_bytes()).hexdigest(),
               'producerSha256': hashlib.sha256(source.read_bytes()).hexdigest(),
               'channels': channels, 'rowSelection': 'ALL_128_FIXED_TRIALS_NO_SELECTION',
               'timeSemantics': 'SIMULATED_TRIAL_INDEX_NOT_ELAPSED_FIELD_HISTORY',
               'nativeCalls': 0, 'externalCalls': 0, 'realFinancialEffects': False}, sys.stdout,
              allow_nan=False, separators=(',', ':'))
    sys.stdout.write('\n')


if __name__ == '__main__':
    main()
