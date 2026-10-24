/** Reconstruct the exact shallow commit from packet bytes, never donor Git
 * objects, copied dependency trees, a source checkout or Git alternates. */
import {strict as assert} from 'node:assert';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve,join,dirname,isAbsolute,basename} from 'node:path';
const [packet,destination,receipt]=process.argv.slice(2);
assert([packet,destination,receipt].every(v=>v&&isAbsolute(v)),'ABSOLUTE_PACKET_DESTINATION_AND_RECEIPT_REQUIRED');
assert(!existsSync(destination),'RECONSTRUCTION_CHECKOUT_MUST_BE_NEW');
const source=JSON.parse(readFileSync(join(packet,'source.json'),'utf8')),
 hash=value=>createHash('sha256').update(value).digest('hex');
assert.equal(source.schema,'finnor.y3.source-preimage.v1');
for(const entry of [source.archive,source.commitObject]){
 assert.equal(basename(entry.path),entry.path);
 const bytes=readFileSync(join(packet,entry.path));assert.equal(bytes.length,entry.bytes);assert.equal(hash(bytes),entry.sha256);
}
const object=readFileSync(join(packet,source.commitObject.path));
assert.equal(createHash('sha1').update(Buffer.concat([Buffer.from('commit '+object.length+'\0'),object])).digest('hex'),source.commit);
assert.equal(/^tree ([0-9a-f]{40})$/m.exec(object.toString())?.[1],source.tree);
const archive=join(packet,source.archive.path),entries=execFileSync('tar',['-tzf',archive],{encoding:'utf8',maxBuffer:16777216}).trim().split('\n');
assert(entries.every(path=>path&&!path.startsWith('/')&&!path.split('/').some(p=>['..','.git','node_modules','.next'].includes(p))));
// This repository's packet format contains regular files and directories only.
// Reject link/device entries before extracting an untrusted packet.
const kinds=execFileSync('tar',['-tvzf',archive],{encoding:'utf8',maxBuffer:16777216}).trim().split('\n');
assert(kinds.every(line=>line.startsWith('-')||line.startsWith('d')),'ONLY_REGULAR_SOURCE_FILES_AND_DIRECTORIES');
mkdirSync(destination,{recursive:true});execFileSync('tar',['-xzf',archive,'-C',destination]);
const git=(...args)=>execFileSync('git',['-C',destination,...args],{encoding:'utf8',maxBuffer:16777216}).trim();
git('init','--quiet','-b','reconstructed-y3');git('add','--force','--all');
assert.equal(git('write-tree'),source.tree,'ARCHIVED_COMPLETE_TREE_PREIMAGE_REQUIRED');
const loaded=execFileSync('git',['-C',destination,'hash-object','-t','commit','-w','--stdin'],{input:object,encoding:'utf8'}).trim();
assert.equal(loaded,source.commit);writeFileSync(join(destination,'.git','shallow'),source.commit+'\n',{flag:'wx'});
git('update-ref','refs/heads/reconstructed-y3',source.commit);
assert.equal(git('status','--porcelain','--untracked-files=all'),'');
assert(!existsSync(join(destination,'.git','objects','info','alternates')));git('fsck','--connectivity-only');
for(const lock of source.locks)assert.equal(hash(readFileSync(join(destination,lock.path))),lock.sha256);
mkdirSync(dirname(receipt),{recursive:true});
writeFileSync(receipt,JSON.stringify({schema:'finnor.y3.source-reconstruction.v1',status:'PASS_SOURCE_PREIMAGE_ONLY',
 commit:source.commit,tree:source.tree,packet:resolve(packet),destination:resolve(destination),sourceArchive:source.archive,
 archiveOnlySource:true,exactOriginalCommitObject:true,shallow:true,noGitAlternates:true,dependencyTreesPresent:false,
 entries:entries.length,installedVerification:false,protectedQualification:false},null,2)+'\n',{flag:'wx'});
console.log('Y3_SOURCE_PREIMAGE_RECONSTRUCTED',source.commit,source.tree);
