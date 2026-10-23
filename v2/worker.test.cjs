// 以假金鑰、假 Notion、假 LINE 驗證 v2 Worker。不連任何正式服務。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const calls = [];
const dbResults = {};
let nextIdToken = null;
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
    calls.push({ url: String(url), method: opts.method || 'GET', body: opts.body, notifyKey: (opts.headers || {})['X-Notify-Key'] });
    url = String(url);
    if (url === 'https://www.googleapis.com/oauth2/v3/certs') return respond({ keys: [jwk] });
    if (url === 'https://oauth2.googleapis.com/token') return nextIdToken ? respond({ id_token: nextIdToken }) : respond({ error: 'invalid_grant' }, 400);
    if (url.startsWith('https://api.line.me/') || url.startsWith('https://line.test/')) return respond({});
    if (url.includes('api.notion.com/v1/databases/') && url.endsWith('/query')) return respond({ results: dbResults[url.split('/databases/')[1].split('/')[0]] || [] });
    if (url.includes('api.notion.com/v1/pages') && (opts.method === 'POST' || opts.method === 'PATCH')) return respond({ id: 'new' });
    if (url.includes('api.notion.com/v1/pages/')) return respond({ id: 'p', parent: { database_id: 'db-checkin' } });
    if (url.includes('/children')) return respond({ results: [] });
    return respond({}, 404);
  };

  const context = vm.createContext({ crypto: webcrypto, TextEncoder, TextDecoder, Uint8Array, Request, Response, Headers, URLSearchParams, URL, console, atob, btoa, fetch: fakeFetch, Date, JSON, Math, Promise });
  vm.runInContext(`globalThis.__fakeNow = null; const _D = Date; globalThis.Date = class extends _D {
    constructor(...a) { if (a.length === 0 && globalThis.__fakeNow !== null) super(globalThis.__fakeNow); else super(...a); }
    static now() { return globalThis.__fakeNow !== null ? globalThis.__fakeNow : _D.now(); }
  };`, context);
  vm.runInContext(fs.readFileSync(__dirname + '/dist/worker.js', 'utf8').replace('export default {', 'globalThis.worker = {'), context);
  const worker = context.worker;

  const env = {
    GOOGLE_CLIENT_ID: 'client-1', GOOGLE_CLIENT_SECRET: 'cs-test', SESSION_SECRET: 'test-session-secret-0123456789-abcdefghijklmnop', ALLOWED_EMAILS: 'sam@example.com,b@example.com,c@example.com', APPLICANTS: '甲,乙',
    HR_TOKEN: 't', CRM_TOKEN: 't2', DB_LEAVE: 'db-leave', DB_EXPENSE: 'db-exp', DB_CHECKIN: 'db-checkin', DB_CRM: 'db-crm',
    LINE_CHANNEL_TOKEN: 'lt', LINE_CHANNEL_SECRET: 'line-secret', LINE_GROUP_ID: 'Cgroup', NOTIFY_KEY: 'nk-123',
    LINE_NOTIFY_URL: 'https://line.test/api/line/notify',
  };
  const ctx = { waitUntil: p => { ctx.pending.push(p); }, pending: [] };
  const now = Math.floor(Date.now() / 1000);
  const origin = 'https://hr.test';
  const req = (path, { jwt, method = 'GET', body, origin: o } = {}) => new Request(origin + path, {
    method, headers: { 'Content-Type': 'application/json', ...(jwt ? { Cookie: jwt } : {}), ...(o ? { Origin: o } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const call = (path, opts) => worker.fetch(req(path, opts), env, ctx);
  const notionCalls = () => calls.filter(c => c.url.includes('api.notion.com')).length;
  let ipCounter = 0;
  const idClaims = (email, nonce, over = {}) => ({ iss: 'https://accounts.google.com', aud: 'client-1', exp: now + 600, email, email_verified: true, nonce, ...over });
  const startLogin = async (ip) => {
    const r = await worker.fetch(new Request(origin + '/auth/login', { headers: { 'CF-Connecting-IP': ip } }), env, ctx);
    return { r, loc: new URL(r.headers.get('location')), oauth: (r.headers.get('set-cookie') || '').split(';')[0] };
  };
  // 走完整的 Google 登入流程（Google 端由假的取代）
  const loginAs = async (email, { claims = {}, key = kp.privateKey, state, noOauth = false } = {}) => {
    const ip = '10.0.0.' + (++ipCounter);
    const { loc, oauth } = await startLogin(ip);
    nextIdToken = await sign(idClaims(email, loc.searchParams.get('nonce'), claims), key);
    const res = await worker.fetch(new Request(origin + '/auth/callback?code=abc&state=' + (state !== undefined ? state : loc.searchParams.get('state')), { headers: { Cookie: noOauth ? '' : oauth, 'CF-Connecting-IP': ip } }), env, ctx);
    const cookie = (res.headers.getSetCookie().find(c => c.startsWith('seed_session=')) || '').split(';')[0];
    return { res, cookie };
  };

  // 登入：沒登入拿不到任何東西；導向 Google 的參數正確（PKCE、state、nonce）
  let before = notionCalls();
  assert.equal((await call('/api/home')).status, 401, '沒登入須 401');
  const toLogin = await call('/');
  assert.equal(toLogin.status, 302, '沒登入看網頁要導向登入');
  assert.equal(toLogin.headers.get('location'), '/auth/login');
  const { r: loginRes, loc } = await startLogin('10.9.9.9');
  assert.equal(loginRes.status, 302);
  assert.equal(loc.origin + loc.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(loc.searchParams.get('client_id'), 'client-1');
  assert.equal(loc.searchParams.get('redirect_uri'), 'https://hr.test/auth/callback');
  assert.equal(loc.searchParams.get('scope'), 'openid email');
  assert.equal(loc.searchParams.get('response_type'), 'code');
  assert.equal(loc.searchParams.get('code_challenge_method'), 'S256');
  for (const k of ['state', 'nonce', 'code_challenge']) assert.ok(loc.searchParams.get(k).length >= 20, k + ' 要夠長');
  assert.match(loginRes.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Lax/);

  // 正確登入
  const okLogin = await loginAs('sam@example.com');
  assert.equal(okLogin.res.status, 302, '正確登入要導回首頁');
  assert.equal(okLogin.res.headers.get('location'), '/');
  assert.ok(okLogin.cookie.length > 40, '要發工作階段 Cookie');
  assert.ok(okLogin.res.headers.getSetCookie().some(c => /^seed_session=.*HttpOnly; Secure; SameSite=Lax/.test(c)), 'Cookie 要 HttpOnly、Secure、SameSite');
  const tokenCall = calls.filter(c => c.url === 'https://oauth2.googleapis.com/token').pop();
  assert.match(String(tokenCall.body), /code_verifier=/, '換 token 要帶 PKCE code_verifier');
  let good = okLogin.cookie;
  assert.equal((await (await call('/api/me', { jwt: good })).json()).email, 'sam@example.com');

  // 各種失敗登入：不得發 Cookie，也不得碰 Notion
  const bads = [
    ['簽章不符', { key: (await webcrypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])).privateKey }],
    ['過期', { claims: { exp: now - 10 } }],
    ['aud 不符', { claims: { aud: 'other-client' } }],
    ['iss 不符', { claims: { iss: 'https://evil.example.com' } }],
    ['nonce 不符', { claims: { nonce: 'wrong' } }],
    ['信箱未驗證', { claims: { email_verified: false } }],
    ['state 不符', { state: 'wrong-state' }],
    ['缺少 oauth cookie', { noOauth: true }],
  ];
  for (const [name, opts] of bads) {
    const r = await loginAs('sam@example.com', opts);
    assert.equal(r.res.status, 400, name + ' 須 400');
    assert.equal(r.cookie, '', name + ' 不得發工作階段');
  }
  const stranger = await loginAs('stranger@example.com');
  assert.equal(stranger.res.status, 403, '不在名單的信箱須 403');
  assert.equal(stranger.cookie, '', '不在名單不得發工作階段');
  assert.equal(notionCalls(), before, '登入失敗不得呼叫 Notion');

  // 工作階段本身：竄改、過期、撤銷、換密鑰
  assert.equal((await call('/api/home', { jwt: good.slice(0, -2) + 'xx' })).status, 401, '竄改簽章須 401');
  assert.equal((await call('/api/home', { jwt: 'seed_session=garbage' })).status, 401, '亂碼須 401');
  context.__fakeNow = (now + 9 * 3600) * 1000;
  assert.equal((await call('/api/home', { jwt: good })).status, 401, '超過 8 小時須 401');
  context.__fakeNow = null;
  const savedEmails = env.ALLOWED_EMAILS;
  env.ALLOWED_EMAILS = 'b@example.com';
  assert.equal((await call('/api/home', { jwt: good })).status, 403, '從名單移除後須立刻失效');
  env.ALLOWED_EMAILS = savedEmails;
  const savedSecret = env.SESSION_SECRET;
  env.SESSION_SECRET = 'another-secret-another-secret-another-secret';
  assert.equal((await call('/api/home', { jwt: good })).status, 401, '換 SESSION_SECRET 後全部登出');
  env.SESSION_SECRET = savedSecret;
  delete env.SESSION_SECRET;
  assert.equal((await call('/api/home', { jwt: good })).status, 503, '沒設定 SESSION_SECRET 須 503');
  env.SESSION_SECRET = savedSecret;
  assert.equal(notionCalls(), before, '失敗的請求不得呼叫 Notion');

  // 登出：要有 Origin，並清掉 Cookie
  assert.equal((await call('/auth/logout', { jwt: good, method: 'POST', body: {} })).status, 403, '登出缺 Origin 須 403');
  const out = await call('/auth/logout', { jwt: good, method: 'POST', body: {}, origin });
  assert.equal(out.status, 200);
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);

  // 登入入口節流
  let tl;
  for (let i = 0; i < 25; i++) tl = await worker.fetch(new Request(origin + '/auth/login', { headers: { 'CF-Connecting-IP': '10.8.8.8' } }), env, ctx);
  assert.equal(tl.status, 429, '同一來源連續登入須被節流');
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
  const lineBefore = calls.filter(c => c.url.startsWith('https://line.test/')).length;
  const ok = await call('/api/leave', { jwt: good, method: 'POST', body: leaveBody, origin });
  assert.equal(ok.status, 200, await ok.clone().text());
  await Promise.all(ctx.pending);
  const created = calls.filter(c => c.method === 'POST' && c.url.endsWith('/v1/pages')).pop();
  assert.ok(created, '請假應建立 Notion 頁面');
  assert.match(created.body, /已登記/);
  assert.equal(calls.filter(c => c.url.startsWith('https://line.test/')).length, lineBefore + 1, '請假送出應轉交 LINE Worker 發一則');
  assert.equal(calls.filter(c => c.url.includes('api.line.me') && c.url.includes('/push')).length, 0, '網站 Worker 不得直接呼叫 LINE');
  const fwd = calls.filter(c => c.url.startsWith('https://line.test/')).pop();
  assert.equal(fwd.notifyKey, 'nk-123', '轉交時要帶共用密鑰');

  // 請假輸入驗證
  for (const bad of [{ ...leaveBody, name: '陌生人' }, { ...leaveBody, type: '亂寫' }, { ...leaveBody, end: '2026-11-01' }, { ...leaveBody, hours: 0 }, { ...leaveBody, hours: 481 }, { ...leaveBody, hours: 3.3 }, { ...leaveBody, start: '2026-11-02', end: '2026-11-02', hours: 9 }, { ...leaveBody, start: '2026-02-31' }]) {
    assert.equal((await call('/api/leave', { jwt: good, method: 'POST', body: bad, origin })).status, 400, '壞資料須 400：' + JSON.stringify(bad));
  }
  // 以小時請假：3 小時 = 0.375 天，LINE 與 Notion 都要對得上
  const hBefore = calls.filter(c => c.method === 'POST' && c.url.endsWith('/v1/pages')).length;
  const lBefore = calls.filter(c => c.url.startsWith('https://line.test/')).length;
  const hr = await call('/api/leave', { jwt: good, method: 'POST', origin, body: { name: '甲', type: '事假', start: '2026-11-04', end: '2026-11-04', hours: 3, reason: '' } });
  assert.equal(hr.status, 200, await hr.clone().text());
  await Promise.all(ctx.pending);
  const hCall = calls.filter(c => c.method === 'POST' && c.url.endsWith('/v1/pages')).pop();
  assert.equal(JSON.parse(hCall.body).properties['請假天數'].number, 0.375, '3 小時應寫成 0.375 天');
  const hPush = calls.filter(c => c.url.startsWith('https://line.test/')).pop();
  assert.match(hPush.body, /3 小時/, 'LINE 要顯示小時');
  assert.equal(calls.filter(c => c.url.startsWith('https://line.test/')).length, lBefore + 1);
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


  good = (await loginAs('b@example.com')).cookie; // 換一個帳號，避開寫入節流
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

  good = (await loginAs('c@example.com')).cookie;
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
  // 一次性設定：LINE_GROUP_ID 沒填時，@Bot「群組編號」會回覆群組編號；填了就失效；簽章不對一律拒絕
  const idEvent = (groupId, text = '@bot 群組編號') => JSON.stringify({ events: [{ type: 'message', replyToken: 'rt2', source: { type: 'group', groupId, userId: 'U1' }, message: { type: 'text', text, mention: { mentionees: [{ isSelf: true }] } } }] });
  const noGroupEnv = { ...lineEnv, LINE_GROUP_ID: undefined, LINE_ALLOWED_USER_IDS: undefined };
  const sendTo = async (e, raw, sig) => worker.fetch(new Request(origin + '/api/line/webhook', { method: 'POST', headers: sig ? { 'x-line-signature': sig } : {}, body: raw }), e, ctx);
  let rr = replies();
  const idRaw = idEvent('Cnew123');
  assert.equal((await sendTo(noGroupEnv, idRaw, 'bad')).status, 401, '簽章不對不得回覆群組編號');
  await Promise.all(ctx.pending);
  assert.equal(replies(), rr, '簽章不對不得回覆');
  assert.equal((await sendTo(noGroupEnv, idRaw, await mac(idRaw))).status, 200);
  await Promise.all(ctx.pending);
  assert.equal(replies(), rr + 1, 'LINE_GROUP_ID 沒填時應回覆群組編號');
  assert.match(calls.filter(c => c.url.includes('/message/reply')).pop().body, /Cnew123/);
  assert.equal((await sendTo({ ...lineEnv, LINE_ALLOWED_USER_IDS: undefined }, idRaw, await mac(idRaw))).status, 200);
  await Promise.all(ctx.pending);
  assert.equal(replies(), rr + 1, 'LINE_GROUP_ID 填了以後，群組編號指令必須失效');
  assert.equal((await worker.fetch(new Request(origin + '/', { method: 'GET' }), lineEnv, ctx)).status, 404, 'LINE 專用 Worker 不提供網頁');
  assert.equal((await worker.fetch(new Request(origin + '/api/home', { method: 'GET' }), lineEnv, ctx)).status, 404, 'LINE 專用 Worker 不提供 API');
  console.log('PASS LINE 簽章、群組、操作人');

  // 替網站發 LINE：沒密鑰或錯密鑰不得發；網站 Worker 不提供這個入口
  const notifyCall = (key, text) => worker.fetch(new Request(origin + '/api/line/notify', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { 'X-Notify-Key': key } : {}) }, body: JSON.stringify({ text }) }), lineEnv, ctx);
  const pushCount = () => calls.filter(c => c.url.includes('api.line.me') && c.url.includes('/push')).length;
  let p1 = pushCount();
  assert.equal((await notifyCall(null, 'x')).status, 401, '沒密鑰須 401');
  assert.equal((await notifyCall('wrong', 'x')).status, 401, '錯密鑰須 401');
  assert.equal(pushCount(), p1, '未授權不得發 LINE');
  assert.equal((await notifyCall('nk-123', '')).status, 400, '空訊息須 400');
  assert.equal((await notifyCall('nk-123', 'a'.repeat(4001))).status, 400, '過長須 400');
  assert.equal((await notifyCall('nk-123', '測試通知')).status, 200);
  assert.equal(pushCount(), p1 + 1, '正確密鑰應發一則');
  assert.equal((await worker.fetch(new Request(origin + '/api/line/notify', { method: 'POST', body: '{}' }), env, ctx)).status, 401, '網站 Worker 不提供 notify（回 401 登入）');
  console.log('PASS 替網站發 LINE');

  // 每日通知只在 LINE Worker 發，而且只在台灣平日發
  context.__fakeNow = Date.parse('2026-10-28T01:00:00Z'); // 週三 09:00（台灣）
  p1 = pushCount();
  await worker.scheduled({}, env, ctx); await Promise.all(ctx.pending);
  assert.equal(pushCount(), p1, '網站 Worker 不發每日通知');
  await worker.scheduled({}, lineEnv, ctx); await Promise.all(ctx.pending);
  assert.equal(pushCount(), p1 + 1, 'LINE Worker 平日發每日通知');
  context.__fakeNow = Date.parse('2026-10-31T01:00:00Z'); // 週六
  await worker.scheduled({}, lineEnv, ctx); await Promise.all(ctx.pending);
  assert.equal(pushCount(), p1 + 1, '週六不發');
  context.__fakeNow = Date.parse('2026-11-01T01:00:00Z'); // 週日
  await worker.scheduled({}, lineEnv, ctx); await Promise.all(ctx.pending);
  assert.equal(pushCount(), p1 + 1, '週日不發');
  context.__fakeNow = null;
  console.log('PASS 每日通知');

  console.log('ALL PASS');
})().catch(e => { console.error(e); process.exitCode = 1; });
