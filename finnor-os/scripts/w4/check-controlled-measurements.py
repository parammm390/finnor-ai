"""Independent predeclared W4 fixture oracle. Never imports the producer/learner."""
import hashlib
import json
import random
import sys
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path


def design():
    path = Path(__file__).with_name('controlled-measurement-design.json')
    value = json.loads(path.read_text())
    assert value['profileId'] == 'w4-controlled-commercial-service-v1'
    assert value['operation'] == 'SERVICE_TRANSITION_V1'
    assert value['units'] == {'commercial_unit': ['offeredUnits', 'deliveredUnits'],
                              'minor_USD': ['collectedMinor', 'refundedMinor']}
    assert (value['periods'], value['trainingPeriods'], value['warmupPeriods'], value['horizonPeriods']) == (128, 96, 3, 1)
    assert (value['baselineExposure'], value['nativeTransitionDose'], value['canonicalNumericScale']) == (0, 1, 12)
    assert value['structuralResponse'] == 'Y=actual_record_readback+epsilon'
    assert value['assignment'] == 'FIXED_ALTERNATING_ZERO_ONE_BEFORE_RESPONSES'
    assert value['numerical'] == {'bootstrapDraws': 64, 'blockLength': 4, 'seed': 20261002}
    assert value['exogenous'] == {'seed': 20261004, 'drawOrder': ['latentUniform', 'gaussianMeasurementError'],
                                  'latentUniform': [-0.65, 0.65], 'gaussianMean': 0,
                                  'gaussianStandardDeviation': 0.1,
                                  'jointCoupling': 'SAME_EXOGENOUS_REALIZATION_FOR_QUANTITY_AND_MONEY',
                                  'intervention': 'DO_REPLACES_EXPOSURE_ASSIGNMENT_NOT_RESPONSE_EQUATION_OR_ERROR'}
    return value, hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    declared, design_sha = design()
    train_counts = {str(dose): sum(i % 2 == dose for i in range(3, 96)) for dose in (0, 1)}
    holdout_counts = {str(dose): sum(i % 2 == dose for i in range(96, 128)) for dose in (0, 1)}
    common = {'schema': 'finnor.w4.controlled-measurement-check.v1',
              'profileId': declared['profileId'], 'designSha256': design_sha,
              'trainingSupportCounts': train_counts, 'holdoutSupportCounts': holdout_counts,
              'expectedStructuralDoContrast': 1, 'qualificationCredit': False,
              'fieldValidated': False, 'economicValueEstablished': False}
    if sys.argv[1:] == ['--describe']:
        json.dump({**common, 'status': 'PREDECLARED_EXPECTATIONS_NOT_AN_EXECUTED_EXPERIMENT'}, sys.stdout)
        return
    assert not sys.argv[1:]
    raw = sys.stdin.buffer.read(2*1024*1024+1)
    assert len(raw) <= 2*1024*1024
    packet = json.loads(raw)
    assert packet['schema'] == 'finnor.w4.controlled-measurements.v1'
    producer_path = Path(__file__).with_name('controlled-measurements.py')
    assert packet['producerSha256'] == hashlib.sha256(producer_path.read_bytes()).hexdigest()
    assert packet['design'] == declared and packet['designSha256'] == design_sha
    assert set(packet['channels']) == set(declared['units'])
    assert packet['nativeCalls'] == 0 and packet['externalCalls'] == 0 and packet['realFinancialEffects'] is False
    assert packet['rowSelection'] == 'ALL_128_FIXED_TRIALS_NO_SELECTION'
    rng = random.Random(20261004)
    expected = []
    for period in range(128):
        rng.uniform(-0.65, 0.65)
        noise = rng.gauss(0, 0.1)
        reported = format(Decimal(str(period % 2 + noise)).quantize(Decimal('0.000000000001'), rounding=ROUND_HALF_UP), 'f')
        expected.append(reported)
    summaries = {}
    for unit, fields in declared['units'].items():
        channel = packet['channels'][unit]
        assert channel['unit'] == unit and channel['operation'] == declared['operation']
        rows, trace = channel['rows'], channel['trace']
        assert len(rows) == len(trace) == 128
        for period, (row, event) in enumerate(zip(rows, trace)):
            dose = period % 2
            assert row == {'period': period, 'states': {'outcome': float(expected[period])}, 'exposures': {'price': dose}}
            assert event['period'] == period and event['assignedDose'] == dose and event['unit'] == unit
            assert event['reportedOutcomeDecimal'] == expected[period]
            assert len(event['records']) == 2 and [r['field'] for r in event['records']] == fields
            for record in event['records']:
                field = record['field']
                assert record['before'] == {'version': 'v1', 'fields': {field: 0}}
                assert record['after'] == {'version': 'v2' if dose else 'v1', 'fields': {field: dose}}
                assert record['readback'] == record['after']
                assert record['appliedChanges'] == ({field: 1} if dose else {})
            assert -6 <= row['states']['outcome'] <= 6
        for first in range(3, 96-3):
            assert {r['exposures']['price'] for r in rows[first:first+4]} == {0, 1}
        grouped = [[r['states']['outcome'] for r in rows[3:96] if r['exposures']['price'] == dose] for dose in (0, 1)]
        assert [len(group) for group in grouped] == [46, 47]
        contrast_lower = min(grouped[1])-max(grouped[0])
        assert contrast_lower > 0
        means = [sum(group)/len(group) for group in grouped]
        residual_min = min(r['states']['outcome']-means[r['exposures']['price']] for r in rows[3:96])
        utility_lower = 100*(min(min(grouped[0]), min(grouped[1]))+residual_min)
        assert utility_lower >= -1000
        summaries[unit] = {'trainingSupport': [0, 1], 'holdoutSupport': sorted({r['exposures']['price'] for r in rows[96:]}),
                           'everyLengthFourTrainingBlockFullRank': True,
                           'allFullRankBootstrapContrastsLowerBound': contrast_lower,
                           'nativeActionUtilityGapLowerBound': 100*contrast_lower,
                           'utilityLowerBound': utility_lower}
    assert packet['channels']['commercial_unit']['rows'] == packet['channels']['minor_USD']['rows']
    json.dump({**common, 'status': 'CHECKED_SUPPORTED_CONTROLLED_INPUT',
               'packetSha256': hashlib.sha256(raw).hexdigest(), 'channels': summaries,
               'sourceRole': 'INDEPENDENT_ALGEBRA_AND_DRAW_REPLAY_NOT_PRODUCTION_S3_OR_S4'}, sys.stdout,
              allow_nan=False, separators=(',', ':'))


if __name__ == '__main__':
    main()
