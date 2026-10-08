"""Fresh native obligations followed by the authoritative owner transport E2E."""
import datetime, json, os, pathlib, subprocess, sys, urllib.parse

workspace = pathlib.Path(__file__).resolve().parents[2]
output = pathlib.Path(os.environ['FINNOR_S6_EVIDENCE_DIR']).resolve()
output.mkdir(parents=True, exist_ok=False)
native = output / 'native'
owner = output / 'owner'
environment = {key: value for key, value in os.environ.items() if key in
               ('PATH', 'HOME', 'TMPDIR', 'FINNOR_S6_DATABASE_URL',
                'FINNOR_S6_ADMIN_DATABASE_URL', 'FINNOR_S6_DISPATCH_PROOF')}
environment.update(FINNOR_S6_OBLIGATION_EVIDENCE_DIR=str(native), FINNOR_S6_FRESH_DATABASE='1')
manifest = {'schema': 'finnor.s6.native-owner-pipeline.v1',
            'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'commands': [['python3', 'scripts/s6/run-obligation-local.py'],
                         ['node', '--import=tsx', 'scripts/s6/run-owner-transport-e2e.mts']],
            'qualification': 'ACTUAL_NATIVE_OWNERS_AND_RETAINED_LOCAL_DATABASE; DISPOSABLE_TEST_AUTHORITY; NO_PRODUCTION_ADMISSION'}
native_run = subprocess.run(manifest['commands'][0], cwd=workspace, env=environment)
manifest['nativeExitCode'] = native_run.returncode
status = native_run.returncode
if status == 0:
    if environment.get('FINNOR_S6_DISPATCH_PROOF') == '1':
        # The dispatch phase has already signed and settled this fixture under
        # its own authority. Never replace those native origins with new keys.
        native = output / 'owner-native-input'
        environment.pop('FINNOR_S6_DISPATCH_PROOF')
        environment['FINNOR_S6_OBLIGATION_EVIDENCE_DIR'] = str(native)
        owner_input_run = subprocess.run(manifest['commands'][0], cwd=workspace, env=environment)
        manifest['ownerNativeInputExitCode'] = owner_input_run.returncode
        status = owner_input_run.returncode
if status == 0:
    native_manifest = json.loads((native / 'manifest.json').read_text())
    database_name = native_manifest['databaseTarget']['database']
    for source, destination in [('FINNOR_S6_DATABASE_URL', 'DATABASE_URL'),
                                ('FINNOR_S6_ADMIN_DATABASE_URL', 'FINNOR_S6_ADMIN_DATABASE_URL')]:
        url = urllib.parse.urlsplit(environment[source])
        environment[destination] = urllib.parse.urlunsplit(url._replace(path='/' + database_name))
    environment.update(NODE_ENV='test', CI='1', AUTH_DEV_BYPASS='1', LOG_LEVEL='silent',
                       FINNOR_TEST_MANAGED_EXTENSIONS='omit',
                       FINNOR_S3_PYTHON='/tmp/finnor-s3-python/bin/python',
                       FINNOR_S5_PYTHON='/tmp/finnor-s3-python/bin/python',
                       FINNOR_S3_MODEL_STORE=str(native / 'ordinary-models'),
                       FINNOR_S4_POLICY_STORE=str(native / 'ordinary-policies'),
                       FINNOR_S6_NATIVE_OBLIGATION_RESULTS=str(native / 'results.json'),
                       FINNOR_S6_OWNER_EVIDENCE_DIR=str(owner))
    with (output / 'owner-runner.log').open('w') as log:
        owner_run = subprocess.run(manifest['commands'][1], cwd=workspace, env=environment,
                                   stdout=log, stderr=subprocess.STDOUT)
    status = owner_run.returncode
    manifest['ownerExitCode'] = status
    manifest['ownerDatabaseTarget'] = native_manifest['databaseTarget']
manifest.update(finishedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(), exitCode=status)
(output / 'manifest.json').write_text(json.dumps(manifest, indent=2))
print(json.dumps({'output': str(output), 'exitCode': status}))
sys.exit(status)
