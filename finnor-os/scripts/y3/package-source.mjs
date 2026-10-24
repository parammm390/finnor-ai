/** Complete committed source preimages only. No dependencies, credentials,
 * deployment, Git transport or qualification authority are included. */
import {strict as assert} from 'node:assert';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,existsSync,statSync} from 'node:fs';
import {resolve,join,isAbsolute} from 'node:path';
const repo=resolve(import.meta.dirname,'../../..'),output=process.argv[2];
assert(output&&isAbsolute(output),'ABSOLUTE_NEW_SOURCE_PACKET_DIRECTORY_REQUIRED');
const git=(...args)=>execFileSync('git',['-C',repo,...args],{maxBuffer:33554432});
assert.equal(git('status','--porcelain','--untracked-files=all').toString(),'','COMMITTED_CLEAN_SOURCE_REQUIRED');
assert(!existsSync(output),'SOURCE_PACKET_MUST_BE_NEW');
const commit=git('rev-parse','HEAD').toString().trim(),tree=git('rev-parse','HEAD^{tree}').toString().trim(),
 object=git('cat-file','commit',commit),hash=value=>createHash('sha256').update(value).digest('hex');
mkdirSync(output,{recursive:true});
git('archive','--format=tar.gz','--output='+join(output,'source.tar.gz'),commit);
writeFileSync(join(output,'source.commit'),object,{flag:'wx'});
const archive=readFileSync(join(output,'source.tar.gz'));
assert(archive.length<=134217728,'SOURCE_PACKET_BYTE_BOUND');
const manifest={schema:'finnor.y3.source-preimage.v1',commit,tree,branch:git('branch','--show-current').toString().trim(),
 archive:{path:'source.tar.gz',bytes:statSync(join(output,'source.tar.gz')).size,sha256:hash(archive)},
 commitObject:{path:'source.commit',bytes:object.length,sha256:hash(object)},
 locks:['package-lock.json','finnor-os/package-lock.json'].map(path=>({path,sha256:hash(readFileSync(join(repo,path)))})),
 history:'EXACT_COMMIT_AND_COMPLETE_TREE; PARENTS_NOT_INCLUDED; RECONSTRUCT_AS_SHALLOW',
 dependencies:'NOT_INCLUDED; FRESH_LOCKFILE_INSTALL_REQUIRED',sourceParity:'UNKNOWN',
 protectedQualification:false,productionActivated:false,realEconomicEffects:0};
writeFileSync(join(output,'source.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(manifest));
