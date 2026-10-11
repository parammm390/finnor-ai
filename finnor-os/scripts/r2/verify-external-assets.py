"""Preflight a custodian-supplied protected packet; never issue admission/effects.

Asset readiness is distinct from scientific/economic acceptance. Independent
owners must supply the authenticated gate receipts, evaluator and sealed assets.
"""
import argparse
import hashlib
import json
from pathlib import Path
import sys
p=argparse.ArgumentParser()
p.add_argument('--custody', required=True, help='Custodian manifest, with immutable paths/digests/owners')
p.add_argument('--output', required=True)
a=p.parse_args()
x=json.loads(Path(a.custody).read_text())
required=['completedXManifest','independentEvaluator','frozenGenerator','frozenScoring','preregistration','actorPreparationLedger','pricebook','sealedSeedCommitments','domainAdmission']
observed=[]
for name in required:
 item=x.get(name)
 if not isinstance(item,dict) or not all(item.get(k) for k in ['path','sha256','owner','immutableRef']):
  observed.append({'asset':name,'status':'MISSING','owner':'Custodian must resolve governing owner'});continue
 path=Path(item['path'])
 if not path.is_file():observed.append({'asset':name,'status':'MISSING','path':str(path)});continue
 h=hashlib.sha256()
 with path.open('rb') as f:
  for b in iter(lambda:f.read(1048576),b''):h.update(b)
 observed.append({'asset':name,'status':'BYTES_MATCH' if h.hexdigest()==item['sha256'] else 'DIGEST_MISMATCH','owner':item['owner'],'immutableRef':item['immutableRef'],'observedSha256':h.hexdigest()})
ready=all(v['status']=='BYTES_MATCH' for v in observed)
r={'schema':'finnor.r2.protected-asset-preflight.v1','status':'ASSET_BYTES_READY_AWAITING_INDEPENDENT_AUTHORITY' if ready else 'INCOMPLETE','assets':observed,'admission':'NOT_ESTABLISHED_BY_PREFLIGHT','postXGain':'NOT_RUN','economicRelease':'NOT_RUN','effectAuthorityGranted':False,'next':'Independent S8/evaluator must authenticate custody and execute the frozen protocol; source hashes alone are not scientific qualification'}
Path(a.output).write_text(json.dumps(r,indent=2)+'\n')
print(json.dumps({'status':r['status'],'output':a.output}))
sys.exit(0 if ready else 2)
