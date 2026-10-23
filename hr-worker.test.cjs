const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
let upstreamCalls = [];
const env = { HR_ACCESS_KEY:'test-hr-key', HR_TOKEN:'test-notion', GEMINI_API_KEY:'test-gemini', CRM_ACCESS_KEY:'test-crm-key' };
const context = vm.createContext({ crypto:webcrypto, TextEncoder, TextDecoder, Uint8Array, Request, Response, URL, console, atob, btoa,
  fetch:async (url, options) => { upstreamCalls.push({url,options}); return Response.json({ candidates: [], results: [] }); },
});
vm.runInContext(fs.readFileSync(__dirname+'/hr-worker.js','utf8').replace('export default {','globalThis.worker = {'),context);
const request = (path, key, body) => new Request('https://hr.test'+path,{
  method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(key?{'X-Access-Key':key}:{})},...(body?{body:JSON.stringify(body)}:{}),
});
const call = (path,key,body) => context.worker.fetch(request(path,key,body),env);
(async()=>{
  // R2: HR Gemini AI 端點需驗證
  const gBefore=upstreamCalls.length;
  assert.equal((await call('/api/gemini',null,{contents:[]})).status,401,'HR Gemini 無金鑰須 401');
  assert.equal((await call('/api/gemini','wrong',{contents:[]})).status,401,'HR Gemini 錯金鑰須 401');
  assert.equal(upstreamCalls.length,gBefore,'未授權的 HR Gemini 不得呼叫上游');
  assert.equal((await call('/api/gemini',env.HR_ACCESS_KEY,{contents:[]})).status,200,'正確 HR 金鑰可用 Gemini');
  // 既有 HR Notion 代理仍須金鑰（確保未鬆動原有驗證）
  const nBefore=upstreamCalls.length;
  assert.equal((await call('/api/hr/databases/x/query',null,{})).status,401,'HR Notion 代理無金鑰須 401');
  assert.equal(upstreamCalls.length,nBefore,'未授權的 HR 代理不得呼叫上游');
  assert.equal((await call('/api/hr/databases/x/query',env.HR_ACCESS_KEY,{})).status,200,'HR Notion 代理有金鑰 200');
  console.log('PASS: HR Gemini 驗證門（無金鑰/錯金鑰 401 且不呼叫上游、正確金鑰 200）、HR Notion 代理驗證未鬆動');
})().catch(e=>{console.error(e);process.exitCode=1;});
