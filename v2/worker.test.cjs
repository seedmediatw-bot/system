// 以假金鑰、假 Notion、假 LINE 驗證 v2 Worker。不連任何正式服務。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const calls = [];
const dbResults = {};
const respond = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

(async () => {
  const kp = await webcrypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = { ...(await webcrypto.subtle.exportKey('jwk', kp.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const b64u = b => Buffer.from(b).toString('base64url');
  const sign = async (payload, key = kp.privateKey, kid = 'k1') => {
    const head = b64u(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' }));
    const body = b64u(JSON.stringify(payload));
    const sig = await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(head + '.' + body));
    return head + '.' + body + '.' + b64u(sig);
  };

  const fakeFetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET', body: opts.body });
    url = String(url);
    if (url.endsWith('/cdn-cgi/access/certs')) return respond({ keys: [jwk] });
    if (url.startsWith('https://api.line.me/')) return respond({});
    if (url.includes('api.notion.com/v1/databases/') && url.endsWith('/query')) return respond({ results: dbResults[url.split('/databases/')[1].split('/')[0]] || [] });
    if (url.includes('api.notion.com/v1/pages') && (opts.method === 'POST' || opts.method === 'PATCH')) return respond({ id: 'new' });
    if (url.includes('api.notion.com/v1/pages/')) return respond({ id: 'p', parent: { database_id: 'db-checkin' } });
    if (url.includes('/children')) return respond({ results: [] });
    return respond({}, 404);
  };

  const context = vm.createContext({ crypto: webcrypto, TextEncoder, TextDecoder, Uint8Array, Request, Response, URL, console, atob, btoa, fetch: fakeFetch, Date, JSON, Math, Promise });
  vm.runInContext(fs.readFileSync(__dirname + '/dist/worker.js', 'utf8').replace('export default {', 'globalThis.worker = {'), context);
  const worker = context.worker;

  const env = {
    ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', ACCESS_AUD: 'aud-1', ALLOWED_EMAILS: 'sam@example.com,b@example.com,c@example.com', APPLICANTS: '甲,乙',
    HR_TOKEN: 't', CRM_TOKEN: 't2', DB_LEAVE: 'db-leave', DB_EXPENSE: 'db-exp', DB_CHECKIN: 'db-checkin', DB_CRM: 'db-crm',
    LINE_CHANNEL_TOKEN: 'lt', LINE_CHANNEL_SECRET: 'line-secret', LINE_GROUP_ID: 'Cgroup',
  };
  const ctx = { waitUntil: p => { ctx.pending.push(p); }, pending: [] };
  const now = Math.floor(Date.now() / 1000);
  const goodClaims = { aud: ['aud-1'], iss: 'https://team.cloudflareaccess.com', exp: now + 600, email: 'sam@example.com' };
  let good = await sign(goodClaims);
  const origin = 'https://hr.test';
  const req = (path, { jwt, method = 'GET', body, origin: o } = {}) => new Request(origin + path, {
    method, headers: { 'Content-Type': 'application/json', ...(jwt ? { 'Cf-Access-Jwt-Assertion': jwt } : {}), ...(o ? { Origin: o } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const call = (path, opts) => worker.fetch(req(path, opts), env, ctx);
  const notionCalls = () => calls.filter(c => c.url.includes('api.notion.com')).length;

  // 登入：沒憑證、壞簽章、過期、錯 AUD、非允許信箱都不能碰 Notion
  let before = notionCalls();
  assert.equal((await call('/api/home')).status, 401, '沒有憑證須 401');
  const other = await webcrypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  assert.equal((await call('/api/home', { jwt: await sign(goodClaims, other.privateKey) })).status, 401, '簽章不符須 401');
  assert.equal((await call('/api/home', { jwt: await sign({ ...goodClaims, exp: now - 10 }) })).status, 401, '過期須 401');
  assert.equal((await call('/api/home', { jwt: await sign({ ...goodClaims, aud: ['other'] }) })).status, 401, 'AUD 不符須 401');
  assert.equal((await call('/api/home', { jwt: await sign({ ...goodClaims, iss: 'https://evil.example.com' }) })).status, 401, 'ISS 不符須 401');
  assert.equal((await call('/api/home', { jwt: await sign({ ...goodClaims, email: 'stranger@example.com' }) })).status, 403, '非允許信箱須 403');
  assert.equal(notionCalls(), before, '未通過登入不得呼叫 Notion');
  assert.equal((await call('/')).status, 401, '沒登入拿不到網頁');
  console.log('PASS 登入驗證');

  // 網頁與安全標頭
  const page = await call('/', { jwt: good });
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal((await call('/app.js', { jwt: good })).status, 200);
  console.log('PASS 網頁與安全標頭');

  // 設定
  const cfg = await (await call('/api/config', { jwt: good })).json();
  assert.deepEqual(cfg.applicants, ['甲', '乙']);

  // 寫入：缺 Origin、錯 Origin 被擋
  const leaveBody = { name: '甲', type: '特休', start: '2026-11-02', end: '2026-11-03', hours: 16, reason: '測試' };
  before = notionCalls();
  assert.equal((await call('/api/leave', { jwt: good, method: 'POST', body: leaveBody })).status, 403, '缺 Origin 須 403');
  assert.equal((await call('/api/leave', { jwt: good, method: 'POST', body: leaveBody, origin: 'https://evil.example.com' })).status, 403, '錯 Origin 須 403');
  assert.equal(notionCalls(), before, 'Origin 不符不得寫入');

  // 請假：成功寫入 + LINE 通知
  const lineBefore = calls.filter(c => c.url.includes('line.me')).length;
  const ok = await call('/api/leave', { jwt: good, method: 'POST', body: leaveBody, origin });
  assert.equal(ok.status, 200, await ok.clone().text());
  await Promise.all(ctx.pending);
  const created = calls.filter(c => c.method === 'POST' && c.url.endsWith('/v1/pages')).pop();
  assert.ok(created, '請假應建立 Notion 頁面');
  assert.match(created.body, /已登記/);
  assert.equal(calls.filter(c => c.url.includes('line.me')).length, lineBefore + 1, '請假送出應推一則 LINE');

  // 請假輸入驗證
  for (const bad of [{ ...leaveBody, name: '陌生人' }, { ...leaveBody, type: '亂寫' }, { ...leaveBody, end: '2026-11-01' }, { ...leaveBody, hours: 0 }, { ...leaveBody, hours: 481 }, { ...leaveBody, hours: 3.3 }, { ...leaveBody, start: '2026-11-02', end: '2026-11-02', hours: 9 }, { ...leaveBody, start: '2026-02-31' }]) {
    assert.equal((await call('/api/leave', { jwt: good, method: 'POST', body: bad, origin })).status, 400, '壞資料須 400：' + JSON.stringify(bad));
  }
  // 以小時請假：3 小時 = 0.375 天，LINE 與 Notion 都要對得上
  const hBefore = calls.filter(c => c.method === 'POST' && c.url.endsWith('/v1/pages')).length;
  const lBefore = calls.filter(c => c.url.includes('/message/push')).length;
  const hr = await call('/api/leave', { jwt: good, method: 'POST', origin, body: { name: '甲', type: '事假', start: '2026-11-04', end: '2026-11-04', hours: 3, reason: '' } });
  assert.equal(hr.status, 200, await hr.clone().text());
  await Promise.all(ctx.pending);
  const hCall = calls.filter(c => c.method === 'POST' && c.url.endsWith('/v1/pages')).pop();
  assert.equal(JSON.parse(hCall.body).properties['請假天數'].number, 0.375, '3 小時應寫成 0.375 天');
  const hPush = calls.filter(c => c.url.includes('/message/push')).pop();
  assert.match(hPush.body, /3 小時/, 'LINE 要顯示小時');
  assert.equal(calls.filter(c => c.url.includes('/message/push')).length, lBefore + 1);
  assert.equal(calls.filter(c => c.method === 'POST' && c.url.endsWith('/v1/pages')).length, hBefore + 1);
  console.log('PASS 請假');

  // 報帳：總額由伺服器算，並通知
  before = calls.filter(c => c.method === 'POST' && c.url.endsWith('/v1/pages')).length;
  const exp = await call('/api/expenses', { jwt: good, method: 'POST', origin, body: { name: '乙', project: 'P', items: [{ desc: 'a', cat: '餐費', amount: 100 }, { desc: 'b', cat: '交通費', amount: 50 }], total: 999999 } });
  assert.equal(exp.status, 200);
  const expCall = calls.filter(c => c.method === 'POST' && c.url.endsWith('/v1/pages')).pop();
  assert.equal(JSON.parse(expCall.body).properties['合計金額'].number, 150, '總額必須由伺服器計算');
  assert.equal((await call('/api/expenses', { jwt: good, method: 'POST', origin, body: { name: '乙', items: [] } })).status, 400);
  assert.equal((await call('/api/expenses', { jwt: good, method: 'POST', origin, body: { name: '乙', items: [{ desc: 'a', cat: '亂', amount: 1 }] } })).status, 400);
  console.log('PASS 報帳');

  // 簽到修改：只允許簽到資料庫的頁面
  const patch = await call('/api/checkin/12345678123412341234123456789012', { jwt: good, method: 'PATCH', origin, body: { date: '2026-11-02', clockIn: '09:00', clockOut: '18:00' } });
  assert.equal(patch.status, 200, await patch.clone().text());
  assert.equal((await call('/api/checkin/not-a-uuid', { jwt: good, method: 'PATCH', origin, body: { date: '2026-11-02', clockIn: '09:00' } })).status, 404, '不是編號的路徑不處理');
  assert.equal((await call('/api/checkin/12345678123412341234123456789012', { jwt: good, method: 'PATCH', origin, body: { date: '2026-11-02', clockIn: '25:99' } })).status, 400);
  console.log('PASS 簽到');


  good = await sign({ ...goodClaims, email: 'b@example.com' }); // 換一個帳號，避開寫入節流
  // 全月正常出勤：週末、國定假日、請假日、已簽到日都不預設勾選
  dbResults['db-leave'] = [{ properties: { '開始日期': { date: { start: '2026-10-14' } }, '結束日期': { date: { start: '2026-10-15' } } } }];
  dbResults['db-checkin'] = [{ properties: { '日期': { date: { start: '2026-10-05' } } } }];
  const plan = await (await call('/api/checkin/plan?name=' + encodeURIComponent('甲') + '&month=2026-10', { jwt: good })).json();
  const byDate = Object.fromEntries(plan.days.map(d => [d.date, d]));
  assert.equal(plan.hasHolidayData, true);
  assert.equal(byDate['2026-10-03'], undefined, '週六不列入');
  assert.equal(byDate['2026-10-09'].status, 'holiday', '10/9 補假');
  assert.equal(byDate['2026-10-09'].checked, false);
  assert.equal(byDate['2026-10-14'].status, 'leave');
  assert.equal(byDate['2026-10-15'].checked, false);
  assert.equal(byDate['2026-10-05'].status, 'done');
  assert.equal(byDate['2026-10-06'].checked, true);
  assert.equal(plan.days.filter(d => d.checked).length, 17, '10 月 22 個平日扣 2 天補假、2 天請假、1 天已簽到 = 17');
  const plan2 = await (await call('/api/checkin/plan?name=' + encodeURIComponent('甲') + '&month=2027-01', { jwt: good })).json();
  assert.equal(plan2.hasHolidayData, false, '沒有資料的年份要提醒');
  const pagesBefore = calls.filter(c => c.method === 'POST' && c.url.endsWith('/v1/pages')).length;
  const bulk = await call('/api/checkin/month', { jwt: good, method: 'POST', origin, body: { name: '甲', month: '2026-10', clockIn: '09:00', clockOut: '18:00', dates: ['2026-10-05', '2026-10-06', '2026-10-07'] } });
  assert.equal(bulk.status, 200, await bulk.clone().text());
  const bulkJson = await bulk.json();
  assert.equal(bulkJson.created, 2, '已有簽到的日子要略過');
  assert.deepEqual(bulkJson.skipped, ['2026-10-05']);
  assert.equal(calls.filter(c => c.method === 'POST' && c.url.endsWith('/v1/pages')).length, pagesBefore + 2);
  for (const bad of [{ dates: ['2026-11-02'] }, { dates: [] }, { clockIn: '' }, { name: '陌生人' }, { month: '2026-13' }]) {
    const r = await call('/api/checkin/month', { jwt: good, method: 'POST', origin, body: { name: '甲', month: '2026-10', clockIn: '09:00', clockOut: '18:00', dates: ['2026-10-06'], ...bad } });
    assert.equal(r.status, 400, '壞資料須 400：' + JSON.stringify(bad));
  }
  dbResults['db-leave'] = []; dbResults['db-checkin'] = [];
  console.log('PASS 全月正常出勤');

  good = await sign({ ...goodClaims, email: 'c@example.com' });
  // 寫入節流
  let last;
  for (let i = 0; i < 25; i++) last = await call('/api/checkin/12345678123412341234123456789012', { jwt: good, method: 'PATCH', origin, body: { date: '2026-11-02', clockIn: '09:00' } });
  assert.equal(last.status, 429, '連續寫入須被節流');
  console.log('PASS 節流');

  // 不存在的路由
  assert.equal((await call('/api/gemini', { jwt: good })).status, 404);
  assert.equal((await call('/api/hr/databases/x/query', { jwt: good })).status, 404, '不得再有通用 Notion 代理');

  // LINE 專用 Worker
  const lineEnv = { ...env, MODE: 'line' };
  const lineCall = async (rawBody, sig) => worker.fetch(new Request(origin + '/api/line/webhook', { method: 'POST', headers: sig ? { 'x-line-signature': sig } : {}, body: rawBody }), lineEnv, ctx);
  const mac = raw => webcrypto.subtle.importKey('raw', new TextEncoder().encode('line-secret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    .then(k => webcrypto.subtle.sign('HMAC', k, new TextEncoder().encode(raw))).then(b => Buffer.from(b).toString('base64'));
  const event = (groupId, mention = true) => JSON.stringify({ events: [{ type: 'message', replyToken: 'rt', source: { type: 'group', groupId, userId: 'U1' }, message: { type: 'text', text: '@bot 今日請假', mention: { mentionees: mention ? [{ isSelf: true }] : [] } } }] });
  const replies = () => calls.filter(c => c.url.includes('/message/reply')).length;

  let r0 = replies(), n0 = notionCalls();
  assert.equal((await lineCall(event('Cgroup'))).status, 401, '沒簽章須 401');
  assert.equal((await lineCall(event('Cgroup'), 'AAAA')).status, 401, '錯簽章須 401');
  assert.equal(replies(), r0); assert.equal(notionCalls(), n0, '未簽章事件不得觸發任何動作');
  const raw1 = event('Cgroup');
  assert.equal((await lineCall(raw1, await mac(raw1))).status, 200);
  await Promise.all(ctx.pending);
  assert.equal(replies(), r0 + 1, '正確簽章與群組應回覆');
  const raw2 = event('Cother');
  assert.equal((await lineCall(raw2, await mac(raw2))).status, 200);
  await Promise.all(ctx.pending);
  assert.equal(replies(), r0 + 1, '簽章正確但群組不符不得回覆');
  const raw3 = event('Cgroup', false);
  await lineCall(raw3, await mac(raw3)); await Promise.all(ctx.pending);
  assert.equal(replies(), r0 + 1, '沒有 @Bot 不得回覆');
  lineEnv.LINE_ALLOWED_USER_IDS = 'U9';
  await lineCall(raw1, await mac(raw1)); await Promise.all(ctx.pending);
  assert.equal(replies(), r0 + 1, '操作人不在名單不得回覆');
  assert.equal((await worker.fetch(new Request(origin + '/', { method: 'GET' }), lineEnv, ctx)).status, 404, 'LINE 專用 Worker 不提供網頁');
  assert.equal((await worker.fetch(new Request(origin + '/api/home', { method: 'GET' }), lineEnv, ctx)).status, 404, 'LINE 專用 Worker 不提供 API');
  console.log('PASS LINE 簽章、群組、操作人');

  // 每日通知只在 LINE Worker 發
  const p0 = calls.filter(c => c.url.includes('/message/push')).length;
  await worker.scheduled({}, env, ctx); await Promise.all(ctx.pending);
  assert.equal(calls.filter(c => c.url.includes('/message/push')).length, p0, '員工用 Worker 不發每日通知');
  await worker.scheduled({}, lineEnv, ctx); await Promise.all(ctx.pending);
  assert.equal(calls.filter(c => c.url.includes('/message/push')).length, p0 + 1, 'LINE Worker 發每日通知');
  console.log('PASS 每日通知');

  console.log('ALL PASS');
})().catch(e => { console.error(e); process.exitCode = 1; });
