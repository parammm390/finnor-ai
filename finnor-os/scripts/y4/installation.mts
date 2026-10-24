/** Installed engineering host custody, not an independent attestation. */
import {readFile,lstat,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
export async function verifyInstallation(){
 const directory=process.env.FINNOR_Y4_INSTALLATION,expected=process.env.FINNOR_Y4_INSTALLATION_DIGEST;
 if(!directory?.startsWith('/')||!expected?.match(/^[a-f0-9]{64}$/))throw Error('Y4_INSTALLED_CUSTODY_REQUIRED');
 const root=await realpath(directory),body=await readFile(join(root,'installation.json'));
 if(hash(body)!==expected)throw Error('Y4_INSTALLED_MANIFEST_CHANGED');
 const manifest=JSON.parse(body.toString());
 if(manifest.schema!=='finnor.y4.installed-runtime.v1'||!Array.isArray(manifest.files))throw Error('Y4_INSTALLED_MANIFEST_REQUIRED');
 for(const file of manifest.files){
  const path=resolve(root,file.path);
  if(!path.startsWith(root+'/')||await realpath(path)!==path||(await lstat(path)).isSymbolicLink()
   ||hash(await readFile(path))!==file.sha256)throw Error('Y4_INSTALLED_BYTE_CUSTODY_FAILED');
 }
 return {manifestDigest:expected,files:manifest.files.length,protectedAdmission:false};
}
