import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,symlinkSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {prepareNativeStateParent} from './native-state.mjs'

const directory=mkdtempSync(join(tmpdir(),'finnor-native-state-')),rows=[]
try{
 const root=join(directory,'checkout');mkdirSync(root)
 const state=prepareNativeStateParent(root,'new-owner')
 assert.equal(state,join(root,'.centropy-certification/new-owner'))
 assert(existsSync(join(root,'.centropy-certification')))
 assert(!existsSync(state),'Auth owner must create its own fresh leaf')
 rows.push({case:'fresh-parent-only',status:'PASS'})
 mkdirSync(state);writeFileSync(join(state,'retained'),'preserve existing user state')
 assert.throws(()=>prepareNativeStateParent(root,'new-owner'),/NATIVE_STATE_ALREADY_EXISTS/)
 assert.equal(readFileSync(join(state,'retained'),'utf8'),'preserve existing user state')
 rows.push({case:'existing-state-preserved-and-refused',status:'PASS'})
 for(const name of ['../escape','/absolute','owner/nested','', 'UPPER','a'.repeat(49)])
  assert.throws(()=>prepareNativeStateParent(root,name),/NATIVE_STATE_NAME_INVALID/)
 rows.push({case:'invalid-names-refused',count:6,status:'PASS'})
 const other=join(directory,'other-checkout'),outside=join(directory,'outside');mkdirSync(other);mkdirSync(outside)
 symlinkSync(outside,join(other,'.centropy-certification'),'dir')
 assert.throws(()=>prepareNativeStateParent(other,'owner'),/NATIVE_STATE_PARENT_SYMLINK/)
 assert(!existsSync(join(outside,'owner')))
 rows.push({case:'symlink-parent-refused-before-write',status:'PASS'})
 const receipt={schema:'finnor.native-state-boundary-e2e.v1',status:'PASS',rows,
  sourceSha256:createHash('sha256').update(readFileSync(new URL('./native-state.mjs',import.meta.url))).digest('hex'),
  qualification:'ACTUAL_PRIVATE_STATE_FILESYSTEM_BOUNDARIES_NOT_AUTH_OR_PHASE_ADMISSION'}
 if(process.argv[2])writeFileSync(process.argv[2],JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600})
 console.log(JSON.stringify(receipt))
}finally{rmSync(directory,{recursive:true})}
