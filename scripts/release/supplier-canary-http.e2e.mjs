import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {randomBytes} from 'node:crypto'
import handler from '../../finnor-os/apps/supplier-canary/api/index.mjs'

const names=['PORTAL_ROLE','CANARY_SIGNING_KEY','APP_ORIGIN','AUTH_ORIGIN','CANARY_USERNAME','CANARY_PASSWORD']
const original=Object.fromEntries(names.map(name=>[name,process.env[name]]))
const servers=[]
const rows=[]
const common={CANARY_SIGNING_KEY:randomBytes(32).toString('hex'),CANARY_USERNAME:'canary@verification.invalid',CANARY_PASSWORD:randomBytes(24).toString('hex')}
let appOrigin,authOrigin
async function server(role){
  const service=createServer(async(req,res)=>{
    const chunks=[]; for await(const chunk of req)chunks.push(chunk)
    req.body=Buffer.concat(chunks).toString('utf8')
    const previous=Object.fromEntries(names.map(name=>[name,process.env[name]]))
    Object.assign(process.env,common,{PORTAL_ROLE:role,APP_ORIGIN:appOrigin,AUTH_ORIGIN:authOrigin})
    try{handler(req,res)}finally{
      for(const name of names)if(previous[name]===undefined)delete process.env[name];else process.env[name]=previous[name]
    }
  })
  await new Promise((yes,no)=>{service.once('error',no);service.listen(0,'127.0.0.1',yes)})
  servers.push(service)
  return 'http://127.0.0.1:'+service.address().port
}
try{
  appOrigin=await server('app');authOrigin=await server('auth')
  const request=(url,options={})=>fetch(url,{...options,redirect:'manual',signal:AbortSignal.timeout(4000)})
  const unauth=await request(appOrigin+'/records/DD-48')
  assert.equal(unauth.status,200)
  assert(!(await unauth.text()).includes('data-testid="diligence-evidence"'))
  rows.push({case:'unauthenticated-record-is-masked',status:'PASS'})
  const bad=await request(authOrigin+'/login',{method:'POST',body:new URLSearchParams({username:common.CANARY_USERNAME,password:'incorrect'})})
  assert.equal(bad.status,401);await bad.arrayBuffer()
  rows.push({case:'wrong-credential-refused',status:'PASS'})
  const login=await request(authOrigin+'/login',{method:'POST',body:new URLSearchParams({username:common.CANARY_USERNAME,password:common.CANARY_PASSWORD})})
  assert.equal(login.status,303);await login.arrayBuffer()
  const callback=await request(login.headers.get('location'))
  assert.equal(callback.status,303);await callback.arrayBuffer()
  const cookie=callback.headers.get('set-cookie')
  assert(cookie.includes('HttpOnly')&&cookie.includes('Secure')&&cookie.includes('SameSite=Lax'))
  const record=await request(appOrigin+'/records/DD-48',{headers:{cookie:cookie.split(';')[0]}})
  assert.equal(record.status,200)
  const html=await record.text()
  assert(html.includes('data-testid="diligence-evidence"'))
  assert(html.includes('SYNTHETIC-REFERENCE-001'))
  assert(html.includes('no third-party diligence evidence'))
  assert(html.includes('no business or closing-risk conclusion'))
  for(const field of ['Status','Evidence as of','External reference','Finding','Closing risk'])assert(html.includes(field))
  rows.push({case:'authenticated-synthetic-extraction-and-secure-cookie',status:'PASS'})
  const forged=await request(appOrigin+'/callback?access=invalid.invalid')
  assert.equal(forged.status,401);await forged.arrayBuffer()
  rows.push({case:'forged-callback-refused',status:'PASS'})
  console.log(JSON.stringify({schema:'finnor.canary-http-e2e.v1',status:'PASS',rows,qualification:'ACTUAL_LOOPBACK_HTTP_SYNTHETIC_CANARY_ONLY'}))
}finally{
  for(const service of servers){service.closeAllConnections();await new Promise(done=>service.close(done))}
  for(const name of names)if(original[name]===undefined)delete process.env[name];else process.env[name]=original[name]
}
