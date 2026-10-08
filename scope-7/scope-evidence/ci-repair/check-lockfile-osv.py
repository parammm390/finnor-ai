"""Read every registry-resolved lock version from OSV; retain all responses."""
import json,pathlib,urllib.request,urllib.parse,sys
root=pathlib.Path(__file__).resolve().parents[3]
packages={};local=[]
for filename in ['package-lock.json','finnor-os/package-lock.json']:
    for path,p in json.loads((root/filename).read_text())['packages'].items():
        url=p.get('resolved','');v=p.get('version')
        if v and url.startswith('https://registry.npmjs.org/') and '/-/' in url:
            name=urllib.parse.unquote(urllib.parse.urlparse(url).path.split('/-/')[0].lstrip('/'))
            packages.setdefault((name,v),[]).append({'lockfile':filename,'path':path})
        elif path and v:local.append({'lockfile':filename,'path':path,'name':p.get('name'),'version':v,'resolved':url})
queries=[{'package':{'name':name,'ecosystem':'npm'},'version':version} for name,version in packages];results=[]
for start in range(0,len(queries),100):
    request=urllib.request.Request('https://api.osv.dev/v1/querybatch',data=json.dumps({'queries':queries[start:start+100]}).encode(),headers={'Content-Type':'application/json'})
    with urllib.request.urlopen(request,timeout=45) as response:results.extend(json.load(response)['results'])
assert len(results)==len(queries),'Incomplete OSV response'
findings=[{'query':q,'vulns':r['vulns']} for q,r in zip(queries,results) if r.get('vulns')]
pathlib.Path(sys.argv[1]).write_text(json.dumps({'queries':queries,'results':results,'findings':findings,'nonRegistryPackages':local,'qualification':'ACTUAL_CURRENT_OSV_API_FOR_ALL_REGISTRY_LOCK_VERSIONS; LOCAL_FORK_SOURCE_PROOF_AND_REMOTE_SCANNER_SEPARATE'},indent=2)+'\n')
print(json.dumps({'uniqueLockedVersions':len(queries),'findings':len(findings)}))
sys.exit(1 if findings else 0)
