import {chromium,expect} from '../../../node_modules/@playwright/test/index.mjs';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
const base=resolve(process.env.FINNOR_P1_BROWSER_EVIDENCE??'');
if(!process.env.FINNOR_P1_BROWSER_EVIDENCE)throw Error('EXTERNAL_EVIDENCE_DIRECTORY_REQUIRED');
const fixture=JSON.parse(await readFile(join(base,'fixture.json'),'utf8')),output=join(base,process.env.FINNOR_ACQUISITION_BROWSER_RUN??'acquisition-browser');await mkdir(output,{recursive:true});
const browser=await chromium.launch(),context=await browser.newContext({viewport:{width:1440,height:1100}}),page=await context.newPage(),steps=[],traffic=[],errors=[];
const panel=()=>page.locator('[data-acquisition-decision="'+fixture.acquisition.decisionId+'"]');
page.on('pageerror',e=>errors.push(e.message));page.on('response',r=>{if(r.url().includes('/api/centropy/'))traffic.push({url:r.url(),status:r.status(),method:r.request().method(),bearer:!!r.request().headers().authorization});});
let complete=false;
const selected=new Set((process.env.FINNOR_ACQUISITION_BROWSER_CASE_FILTER??'').split(',').filter(Boolean));
async function open(){await page.goto('http://127.0.0.1:4590/centropy/login');await page.getByLabel('Email',{exact:true}).fill(fixture.email);await page.getByLabel('Password',{exact:true}).fill(fixture.password);await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.waitForURL('**/centropy');await page.goto(fixture.url);await page.getByRole('button',{name:/^\d+ Acquisition decision$/}).click();}
async function step(id,input,fn){if(selected.size&&!selected.has(id)){steps.push({id,input,status:'NOT_RUN'});return;}try{steps.push({id,input,status:'PASS',observed:await fn()});}catch(error){steps.push({id,input,status:'FAIL',message:String(error)});throw error;}finally{await page.screenshot({path:join(output,id+'.png'),fullPage:true}).catch(()=>{});await writeFile(join(output,id+'.dom.txt'),await page.locator('body').ariaSnapshot().catch(()=>''));}}
try{
 if(selected.size&&!selected.has('native-work-financial-decision'))await open();
 await step('native-work-financial-decision',{decisionId:fixture.acquisition.decisionId,workId:fixture.acquisition.workId},async()=>{
  await open();
  await expect(panel()).toBeVisible({timeout:30000});await expect(panel().getByText('No feasible bid in the declared domain.',{exact:true})).toBeVisible({timeout:20000});
  await expect(panel().getByText(/6 candidates checked/)).toBeVisible();
  return {sameWork:await panel().getAttribute('data-acquisition-work'),financialStatus:'NO_FEASIBLE_CANDIDATE'};
 });
 await step('keyboard-source-analysis',{value:'930000'},async()=>{
  const button=panel().getByRole('button',{name:'Inspect financial source analysis',exact:true});await button.focus();await page.keyboard.press('Enter');
  const proof=panel().locator('[data-acquisition-proof]');await expect(proof).toBeVisible();await expect(proof).toBeFocused();await expect(proof).toContainText('930000');await expect(proof).toContainText('POSTGRES_NUMERIC');
  return {keyboardFocus:true,sourceValue:'930000'};
 });
 await step('provider-configuration-visible-before-submit',{provider:'Daytona missing credential'},async()=>{
  assert.equal((await fetch('http://127.0.0.1:4593/executor-unconfigured',{method:'POST'})).status,200);
  const method=page.locator('.ct-program'),construct=()=>method.getByRole('button',{name:'Construct and check method',exact:true});
  await page.reload();await page.getByRole('button',{name:/^\d+ Analytical method$/}).click();
  await expect(method.getByText('Analysis is unavailable. Contact your workspace administrator.',{exact:true})).toBeVisible({timeout:20000});await expect(construct()).toBeDisabled();
  await page.getByRole('button',{name:/^\d+ Evidence calculations$/}).click();
  await expect(page.getByRole('button',{name:'Ask and calculate',exact:true})).toBeEnabled({timeout:20000});
  assert.equal((await fetch('http://127.0.0.1:4593/executor-local',{method:'POST'})).status,200);
  await page.reload();await page.getByRole('button',{name:/^\d+ Analytical method$/}).click();await expect(construct()).toBeEnabled({timeout:20000});
  await page.getByRole('button',{name:/^\d+ Acquisition decision$/}).click();await expect(panel().getByText('No feasible bid in the declared domain.',{exact:true})).toBeVisible({timeout:20000});
  return {unconfiguredMethodDisabled:true,independentSourceCalculationEnabled:true,configuredMethodRestored:true,sameDecisionRetained:true};
 });
 await step('reload-and-mobile',{width:375},async()=>{
  await page.reload();await page.getByRole('button',{name:/^\d+ Acquisition decision$/}).click();await expect(panel().getByText('No feasible bid in the declared domain.',{exact:true})).toBeVisible({timeout:20000});
  await page.setViewportSize({width:375,height:812});await page.getByRole('button',{name:'Canvas',exact:true}).click();await expect(panel()).toBeVisible();
  await page.getByRole('button',{name:/^\d+ Work and verification$/}).click();
  await expect(page.locator('[data-type="work_execution"]').getByRole('region',{name:'Institution responsibility',exact:true})).toBeVisible({timeout:20000});
  await page.getByRole('button',{name:/^\d+ Acquisition decision$/}).click();
  await expect(panel().getByRole('button',{name:'Inspect financial source analysis',exact:true})).toBeInViewport({ratio:1});
  const size=await page.evaluate(()=>({client:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth}));assert(size.scroll<=size.client+1,JSON.stringify(size));return {...size,institutionWithinWork:true,financialSourceControlInViewport:true};
 });
 await step('source-correction-hides-financial-result',{revenue:'900.00'},async()=>{
  const refusal=page.waitForResponse(r=>r.url().endsWith('/api/centropy/company-brain/acquisition-read')&&r.status()===409,{timeout:20000});
  assert.equal((await fetch('http://127.0.0.1:4593/correct',{method:'POST'})).status,200);
  const denied=await refusal;assert(denied.request().headers().authorization);
  await expect(panel().getByText('No feasible bid in the declared domain.',{exact:true})).toHaveCount(0,{timeout:15000});await expect(panel().getByRole('button',{name:'Inspect financial source analysis',exact:true})).toHaveCount(0);return {oldResultAbsent:true,authenticatedOwnerStatus:denied.status()};
 });
 await step('revoked-user-has-no-private-financial-result',{status:'suspended'},async()=>{
  assert.equal((await fetch('http://127.0.0.1:4593/revoke',{method:'POST'})).status,200);
  const refusal=page.waitForResponse(r=>r.url().endsWith('/api/centropy/me')&&[401,403].includes(r.status()),{timeout:20000});await page.reload();const denied=await refusal;assert(denied.request().headers().authorization);
  await expect(page.getByText('No feasible bid in the declared domain.',{exact:true})).toHaveCount(0,{timeout:15000});assert(!await page.locator('body').innerText().then(t=>t.includes('930000')));return {privateValuesAbsent:true,authenticatedIdentityStatus:denied.status()};
 });
 assert.equal(errors.length,0,JSON.stringify(errors));complete=true;
}catch(error){process.exitCode=1;console.error(String(error));}finally{
 await writeFile(join(output,'results.json'),JSON.stringify({schema:'finnor.acquisition-browser-e2e.v1',status:complete?'PASS_LOCAL':'FAIL',fixture,steps,traffic,errors,hostedProductionAuthQualified:false,rerun:'Start the acquisition disposable browser fixture and frontend, then node finnor-os/scripts/acquisition/browser-e2e.mjs'},null,2));
 await browser.close();await fetch('http://127.0.0.1:4593/stop',{method:'POST'}).catch(()=>{});
}
