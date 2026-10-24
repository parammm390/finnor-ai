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
mkdirSync(output,{recursive:true});
const commit=git('rev-parse','HEAD').toString().trim(),tree=git('rev-parse','HEAD^{tree}').toString().trim(),
 object=git('cat-file','commit',commit),archive=join(output,'source.tar.gz');
git('archive','--format=tar.gz','--output='+archive,commit);
const sha256=value=>createHash('sha256').update(value).digest('hex');
writeFileSync(join(output,'source.commit'),object,{flag:'wx'});
const manifest={schema:'finnor.y1.source-preimage.v1',commit,tree,branch:git('branch','--show-current').toString().trim(),
 archive:{path:'source.tar.gz',sha256:sha256(readFileSync(archive)),bytes:statSync(archive).size},
 commitObject:{path:'source.commit',sha256:sha256(object),bytes:object.length},
 history:'EXACT_COMMIT_AND_COMPLETE_TREE; PARENTS_NOT_INCLUDED; RECONSTRUCT_AS_SHALLOW',
 dependencies:'NOT_INCLUDED; FRESH_LOCKFILE_INSTALL_REQUIRED',protectedQualification:false};
writeFileSync(join(output,'source.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(manifest));
