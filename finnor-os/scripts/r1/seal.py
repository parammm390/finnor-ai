"""Seal the owned clean commit and independently reconstruct its Git artifacts.

Consumes retained real proof receipts. This does not issue scientific admission,
release authority or an economic qualification. No network or peer mutation.
"""
import argparse, hashlib, json, pathlib, subprocess
from datetime import datetime, timezone

repo = pathlib.Path(__file__).resolve().parents[3]
parser = argparse.ArgumentParser()
parser.add_argument('--evidence-root', required=True)
parser.add_argument('--output', required=True)
parser.add_argument('--parent', default='713226e4c37ad83d1fe9745cbb032962a333c841')
args = parser.parse_args()
evidence = pathlib.Path(args.evidence_root).resolve(strict=True)
out = pathlib.Path(args.output).resolve()
if out.exists(): raise SystemExit('Immutable seal output already exists')
out.mkdir(parents=True)

def sha(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for b in iter(lambda: f.read(1024*1024), b''): h.update(b)
    return h.hexdigest()

def git(*args, cwd=repo, binary=False):
    return subprocess.check_output(['git', *args], cwd=cwd, text=not binary, timeout=120)

head = git('rev-parse', 'HEAD').strip()
tree = git('rev-parse', 'HEAD^{tree}').strip()
if git('status', '--porcelain').strip(): raise SystemExit('Seal requires the exact owned clean commit')
if git('branch', '--show-current').strip() != 'codex/r1-certified-state-reduction': raise SystemExit('Wrong owned branch')
git('merge-base', '--is-ancestor', args.parent, head)
ordered_commits = git('rev-list','--reverse',args.parent+'..'+head).splitlines()
if not ordered_commits: raise SystemExit('Missing owned integration commit')

registry_path = repo/'scope-r/r1-certified-state-reduction/handoff/local-verification.json'
registry = json.loads(registry_path.read_text())
receipts = []
required_release = set(json.loads((repo/'scope-r/r1-certified-state-reduction/verification-plan.json').read_text())['checks'][-2]['selectedCommands'])
selected_release = [c for item in registry['checks'] if item.get('boundary') == 'release-static' for c in item.get('requiredCaseIds', [])]
if len(selected_release) != len(set(selected_release)) or set(selected_release) != required_release: raise SystemExit('Required release selection is incomplete or duplicated')
for item in registry['checks']:
    directory = evidence/item['run']
    receipt_path = directory/'driver-receipt.json'
    if sha(receipt_path) != item['driverReceiptSha256']: raise SystemExit('Selected receipt identity changed: '+item['id'])
    receipt = json.loads(receipt_path.read_text())
    if 'requiredCaseIds' in item:
        results_path = directory/'results.json'
        results = json.loads(results_path.read_text())['results']
        selected = [r for r in results if r['id'] in item['requiredCaseIds']]
        if set(r['id'] for r in selected) != set(item['requiredCaseIds']) or any(r['status'] != 'PASS' for r in selected): raise SystemExit('Required selected release cases did not pass: '+item['id'])
        # Failed initial cases remain FAIL; their repair must have a separate
        # selected after receipt. Unaffected passed cases are not rerun.
    else:
        if receipt['status'] != 'PASS_LOCAL' or receipt.get('exitCode') != 0: raise SystemExit('Required proof did not pass: '+item['id'])
        if receipt['counts']['FAIL'] or receipt['counts']['NOT_RUN'] or receipt['counts']['PASS'] != item['requiredDriverCases']: raise SystemExit('Incomplete required selection: '+item['id'])
    freeze_path = directory/'pre-run-freeze.json'
    if sha(freeze_path) != item['sourceFreezeSha256']: raise SystemExit('Selected source freeze identity changed: '+item['id'])
    freeze = json.loads(freeze_path.read_text())
    source = freeze.get('source', {})
    # Unchanged inherited owners and the release wrapper retain a complete
    # preimage overlay. R1 owner/math/runtime/mounted proofs retain its source cut.
    for file in source.get('files', []):
        path = repo/file['path']
        if not path.is_file() or sha(path) != file['sha256']: raise SystemExit('Relevant proof source changed: '+item['id']+':'+file['path'])
    for file in item.get('unchangedInheritedOwnerPins', []):
        path = repo/file['path']
        if not path.is_file() or sha(path) != file['sha256']: raise SystemExit('Inherited owner proof source changed: '+file['path'])
    receipts.append({'id':item['id'], 'run':item['run'], 'driverReceiptSha256':sha(receipt_path), 'freezeSha256':sha(freeze_path), 'counts':receipt['counts'], 'requiredCaseIds':item.get('requiredCaseIds'), 'originalDriverStatus':receipt['status'], 'sourceCodeDigest':source.get('codeDigest'), 'qualification':receipt['qualification']})

patch = out/'0001-r1.patch'
patch.write_bytes(git('format-patch', '--stdout', '--binary', args.parent+'..'+head, binary=True))
bundle = out/'r1.bundle'
git('bundle', 'create', str(bundle), args.parent+'..'+head)
reconstructed = out/'reconstructed.git'
subprocess.check_call(['git','init','--bare',str(reconstructed)], stdout=subprocess.DEVNULL)
# Copy the exact prerequisite from the local source repository into an
# independent object store; do not use alternates or the worktree's index.
git('fetch','--no-tags','--depth=1',str(repo),args.parent,cwd=reconstructed)
git('bundle','verify',str(bundle),cwd=reconstructed)
git('fetch','--no-tags',str(bundle),head,cwd=reconstructed)
rebuilt = git('rev-parse','FETCH_HEAD^{tree}',cwd=reconstructed).strip()
if rebuilt != tree: raise SystemExit('Independent reconstruction tree mismatch')

changed = [p for p in git('diff','--name-only',args.parent,head).splitlines() if (repo/p).is_file()]
files = [{'path':p,'bytes':(repo/p).stat().st_size,'sha256':sha(repo/p)} for p in changed]
deleted = [p for p in git('diff','--name-only','--diff-filter=D',args.parent,head).splitlines()]
manifest = {'schema':'finnor.r1.sealed-source.v1','head':head,'tree':tree,'parent':args.parent,'orderedCommits':ordered_commits,'changedFiles':files,'deletedFiles':deleted,'gitBundle':{'path':bundle.name,'sha256':sha(bundle),'prerequisite':args.parent},'orderedPatch':{'path':patch.name,'sha256':sha(patch),'preimage':args.parent},'reconstruction':{'independentObjectStore':str(reconstructed),'actualTree':rebuilt,'alternatesUsed':False}}
(out/'source-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
result = {'schema':'finnor.r1.sealed-local-handoff.v1','at':datetime.now(timezone.utc).isoformat(),'status':'PASS_LOCAL','head':head,'tree':tree,'parent':args.parent,'proofs':receipts,'sourceManifestSha256':sha(out/'source-manifest.json'),'functionalBasis':'Finite supplied-model ordinary development profile only','independentAdmission':'UNQUALIFIED','protectedActivation':'NOT_RUN','protectedPostXGain':'NOT_RUN','economicRelease':'UNQUALIFIED','H2':'UNKNOWN','publication':'Separate verified push/draft-PR receipt; this script performs no publication'}
(out/'seal.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({'status':result['status'],'head':head,'tree':tree,'output':str(out)}))
