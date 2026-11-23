import assert from 'node:assert/strict'
import {existsSync,lstatSync,mkdirSync,realpathSync} from 'node:fs'
import {isAbsolute,join} from 'node:path'

/** Prepare the private parent only; the real Auth owner creates the fresh leaf. */
export function prepareNativeStateParent(root,name){
 assert.match(name,/^[a-z0-9-]{1,48}$/,'NATIVE_STATE_NAME_INVALID')
 assert(isAbsolute(root)&&realpathSync(root)===root,'NATIVE_STATE_ROOT_INVALID')
 const parent=join(root,'.centropy-certification')
 if(!existsSync(parent))mkdirSync(parent,{mode:0o700})
 assert(!lstatSync(parent).isSymbolicLink()&&realpathSync(parent)===parent,'NATIVE_STATE_PARENT_SYMLINK')
 assert(lstatSync(parent).isDirectory(),'NATIVE_STATE_PARENT_NOT_DIRECTORY')
 const state=join(parent,name)
 // lstat catches an existing dangling symlink as well as ordinary state data.
 let present=false
 try{lstatSync(state);present=true}catch(error){if(error.code!=='ENOENT')throw error}
 assert(!present,'NATIVE_STATE_ALREADY_EXISTS')
 return state
}
