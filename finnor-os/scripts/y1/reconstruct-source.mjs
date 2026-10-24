/** Dependency-free reconstruction from the packet alone, not a worktree copy. */
import {strict as assert} from 'node:assert';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve,join,dirname,isAbsolute,basename} from 'node:path';
const [packet,destination,receipt]=process.argv.slice(2);
assert([packet,destination,receipt].every(v=>v&&isAbsolute(v)),'ABSOLUTE_PACKET_DESTINATION_AND_RECEIPT_REQUIRED');
assert(!existsSync(destination),'RECONSTRUCTION_CHECKOUT_MUST_BE_NEW');
const manifest=JSON.parse(readFileSync(join(packet,'source.json'),'utf8'));
assert.equal(manifest.schema,'finnor.y1.source-preimage.v1');
const sha256=value=>createHash('sha256').update(value).digest('hex');
for(const entry of [manifest.archive,manifest.commitObject]){
 assert.equal(basename(entry.path),entry.path);
 const bytes=readFileSync(join(packet,entry.path));assert.equal(bytes.length,entry.bytes);assert.equal(sha256(bytes),entry.sha256);
}
const object=readFileSync(join(packet,manifest.commitObject.path));
assert.equal(createHash('sha1').update(Buffer.concat([Buffer.from('commit '+object.length+'\0'),object])).digest('hex'),manifest.commit);
assert.equal(/^tree ([0-9a-f]{40})$/m.exec(object.toString())?.[1],manifest.tree);
const archive=join(packet,manifest.archive.path),entries=execFileSync('tar',['-tzf',archive],{encoding:'utf8',maxBuffer:16777216}).trim().split('\n');
assert(entries.every(path=>path&&!path.startsWith('/')&&!path.split('/').some(p=>['..','.git','node_modules','.next'].includes(p))));
mkdirSync(destination,{recursive:true});
execFileSync('tar',['-xzf',archive,'-C',destination]);
const git=(...args)=>execFileSync('git',['-C',destination,...args],{encoding:'utf8',maxBuffer:16777216}).trim();
git('init','--quiet','-b','reconstructed-y1');
git('add','--force','--all');
assert.equal(git('write-tree'),manifest.tree,'ARCHIVED_COMPLETE_TREE_PREIMAGE_REQUIRED');
const loaded=execFileSync('git',['-C',destination,'hash-object','-t','commit','-w','--stdin'],{input:object,encoding:'utf8'}).trim();
assert.equal(loaded,manifest.commit);
writeFileSync(join(destination,'.git','shallow'),manifest.commit+'\n',{flag:'wx'});
git('update-ref','refs/heads/reconstructed-y1',manifest.commit);
assert.equal(git('status','--porcelain','--untracked-files=all'),'');
assert(!existsSync(join(destination,'.git','objects','info','alternates')));
git('fsck','--connectivity-only');
mkdirSync(dirname(receipt),{recursive:true});
writeFileSync(receipt,JSON.stringify({schema:'finnor.y1.source-reconstruction.v1',status:'PASS_SOURCE_PREIMAGE',
 commit:manifest.commit,tree:manifest.tree,packet:resolve(packet),destination:resolve(destination),
 sourceArchive:manifest.archive,archiveOnlySource:true,exactOriginalCommitObject:true,shallow:true,
 noGitAlternates:true,dependencyTreesPresent:false,files:entries.length,protectedQualification:false},null,2)+'\n',{flag:'wx'});
console.log('Y1_SOURCE_PREIMAGE_RECONSTRUCTED',manifest.commit,manifest.tree);
