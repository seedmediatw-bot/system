const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
let now = Date.now();
let upstreamCalls = [];
const env = { CRM_ACCESS_KEY:'test-service-key', CRM_PASSWORD:'test-password', ADMIN_PASSWORD:'test-admin', CRM_TOKEN:'test-notion', DB_CRM:'test-crm' };
const context = vm.createContext({ crypto:webcrypto, TextEncoder, Uint8Array, Request, Response, URL, console,
  Date:class extends Date { static now() { return now; } },
  fetch:async (url, options) => { upstreamCalls.push({url,options});return Response.json({results:[]}); },
});
vm.runInContext(fs.readFileSync(__dirname+'/crm-worker.js','utf8').replace('export default {','globalThis.worker = {'),context);
const request = (path, key, body) => new Request('https://crm.test'+path,{
  method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(key?{'X-Access-Key':key}:{})},...(body?{body:JSON.stringify(body)}:{}),
});
const call = (path,key,body,settings=env) => context.worker.fetch(request(path,key,body),settings);
(async()=>{
  assert.equal((await call('/api/auth',null,{system:'crm',password:'wrong'})).status,401);
  const login=await call('/api/auth',null,{system:'crm',password:env.CRM_PASSWORD});
  assert.equal(login.headers.get('Cache-Control'),'no-store');
  const session=await login.json();
  assert.match(session.accessKey,/^crm1\./); assert.notEqual(session.accessKey,env.CRM_ACCESS_KEY);
  assert.equal(session.sessionExpiresAt,Math.floor(now/1000)+28800);
  assert.equal((await call('/api/crm/databases/test-crm/query',session.accessKey,{})).status,200);
  assert.equal((await call('/api/crm/blocks/test-client/children?page_size=100',session.accessKey)).status,200);
  assert.ok(upstreamCalls.at(-1).url.endsWith('/blocks/test-client/children?page_size=100'));
  assert.equal((await call('/api/crm/pages',session.accessKey,{properties:{}})).status,200);
  const before=upstreamCalls.length;
  const tampered = session.accessKey.slice(0,-1)+(session.accessKey.endsWith('0')?'1':'0');
  for(const token of ['', 'garbage',tampered,session.accessKey.replace('crm1.','hr1.')]) {
    assert.equal((await call('/api/crm/pages/test',token)).status,401);
  }
  const parts=session.accessKey.split('.');parts[1]=String(Number(parts[1])+1);
  assert.equal((await call('/api/crm/pages/test',parts.join('.'))).status,401);
  assert.equal((await call('/api/crm/pages/test',session.accessKey,null,{...env,CRM_PASSWORD:'changed'})).status,401);
  now=session.sessionExpiresAt*1000;
  assert.equal((await call('/api/crm/pages/test',session.accessKey)).status,401);
  assert.equal(upstreamCalls.length,before,'Rejected tokens must not reach Notion');
  assert.equal((await call('/api/crm/line-query',env.CRM_ACCESS_KEY,{command:'客戶總覽'})).status,200);
  assert.equal((await call('/api/crm/line-query',session.accessKey,{command:'客戶總覽'})).status,401);
  const admin=await (await call('/api/auth',null,{system:'admin',password:env.ADMIN_PASSWORD})).json();
  assert.equal(admin.ok,true);assert.equal(admin.accessKey,null);
  console.log('PASS: login, 8-hour expiry, tampering, scope, password rotation, no-store, Notion query/history/write proxy, LINE service key, admin');
})().catch(e=>{console.error(e);process.exitCode=1;});
