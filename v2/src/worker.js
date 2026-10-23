/**
 * 種子 HR 系統 v2：單一 Cloudflare Worker（網頁 + API + LINE）
 *
 * 同一個檔案部署成兩個 Worker：
 *   seed-house    網站與 API，給 Sam 用。用 Google 登入，只有 ALLOWED_EMAILS 內的信箱進得來。
 *   hr-system123  （沿用舊名）只負責 LINE：收通知並驗簽章、替網站發 LINE 訊息、每日通知。
 *                 環境變數 MODE=line；其他路徑一律 404。LINE 金鑰與群組編號只放在這一個 Worker。
 *
 * seed-house 的環境變數：
 *   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET   Google Cloud 的 OAuth 用戶端
 *   SESSION_SECRET      至少 32 字元的隨機字串，用來簽登入 Cookie；換掉它就是全部登出
 *   ALLOWED_EMAILS      逗號分隔，允許使用網站的 Google 信箱；每次請求都會核對
 *   APPLICANTS          逗號分隔，可代填的人名
 *   HR_TOKEN / CRM_TOKEN   Notion 整合金鑰（CRM 那把只需讀取權限）
 *   DB_LEAVE DB_EXPENSE DB_CHECKIN DB_CRM
 *   LINE_NOTIFY_URL     LINE Worker 的 /api/line/notify 完整網址
 *   NOTIFY_KEY          與 LINE Worker 相同的共用密鑰
 *
 * LINE Worker（MODE=line）的環境變數：
 *   MODE=line  LINE_CHANNEL_TOKEN  LINE_CHANNEL_SECRET  LINE_GROUP_ID  NOTIFY_KEY
 *   HR_TOKEN  DB_LEAVE（今日請假查詢用）
 *   LINE_ALLOWED_USER_IDS（選填，逗號分隔；有填就只接受這些人的指令）
 *
 * Cron（只設在 LINE Worker）：UTC 01:00 週一到週五，即台灣 09:00 → 每日請假通知
 */

const ASSETS = /*ASSETS*/{}/*END_ASSETS*/;

const NOTION_BASE = 'https://api.notion.com/v1/';
const LEAVE_TYPES = ['特休', '病假', '事假', '公假', '其他'];
const EXPENSE_CATS = ['交通費', '餐費', '住宿費', '材料費', '軟體訂閱', '培訓費', '其他'];
const WRITE_LIMIT_PER_MIN = 20;

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function json(data, status = 200) {
  return Response.json(data, { status, headers: { ...SECURITY_HEADERS, 'Cache-Control': 'no-store' } });
}
const csv = value => String(value || '').split(',').map(s => s.trim()).filter(Boolean);

// ── 登入：Google 登入（OpenID Connect + PKCE）＋簽章 Cookie 工作階段 ──────
// 流程：/auth/login 導向 Google → /auth/callback 換取並驗證 id_token → 只有 ALLOWED_EMAILS 內的信箱
// 拿得到 8 小時的工作階段 Cookie。每次請求都會重新核對信箱名單，所以從名單移除信箱即刻失效；
// 換掉 SESSION_SECRET 則所有人的登入立刻全部失效。

const SESSION_COOKIE = 'seed_session';
const OAUTH_COOKIE = 'seed_oauth';
const SESSION_TTL_SECONDS = 8 * 3600;
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
const GOOGLE_CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

const b64uToBytes = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const b64uToJson = s => JSON.parse(new TextDecoder().decode(b64uToBytes(s)));
const bytesToB64u = bytes => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const strToB64u = s => bytesToB64u(new TextEncoder().encode(s));
const randomB64u = n => bytesToB64u(crypto.getRandomValues(new Uint8Array(n)));
const nowSec = () => Math.floor(Date.now() / 1000);

function authConfigured(env) {
  return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && String(env.SESSION_SECRET || '').length >= 32 && csv(env.ALLOWED_EMAILS).length);
}

async function hmacB64u(env, data) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return bytesToB64u(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))));
}
async function signToken(env, obj) {
  const payload = strToB64u(JSON.stringify(obj));
  return payload + '.' + await hmacB64u(env, payload);
}
async function readToken(env, token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  if (!safeEqual(await hmacB64u(env, parts[0]), parts[1])) return null;
  try {
    const obj = b64uToJson(parts[0]);
    return obj && obj.exp > nowSec() ? obj : null;
  } catch (_) { return null; }
}

function getCookie(request, name) {
  for (const part of (request.headers.get('Cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}
const setCookie = (name, value, maxAge, path) => `${name}=${value}; Max-Age=${maxAge}; Path=${path}; HttpOnly; Secure; SameSite=Lax`;
function redirect(location, cookies = []) {
  const headers = new Headers({ ...SECURITY_HEADERS, 'Cache-Control': 'no-store', 'Location': location });
  for (const c of cookies) headers.append('Set-Cookie', c);
  return new Response(null, { status: 302, headers });
}
function messagePage(status, title, text) {
  const body = `<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body><h1>${title}</h1><p>${text}</p><p><a href="/auth/login">用其他 Google 帳號登入</a></p></body></html>`;
  return new Response(body, { status, headers: { ...SECURITY_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

async function authenticate(request, env) {
  if (!authConfigured(env)) throw new HttpError(503, '登入尚未設定');
  const session = await readToken(env, getCookie(request, SESSION_COOKIE));
  if (!session || !session.email) throw new HttpError(401, '請先登入');
  const email = String(session.email).toLowerCase();
  if (!csv(env.ALLOWED_EMAILS).map(s => s.toLowerCase()).includes(email)) throw new HttpError(403, '這個帳號沒有使用權限');
  return email;
}

let googleKeys = { at: 0, keys: null };
async function loadGoogleKeys() {
  if (googleKeys.keys && Date.now() - googleKeys.at < 3600e3) return googleKeys.keys;
  const res = await fetch(GOOGLE_CERTS_URL);
  if (!res.ok) throw new HttpError(503, 'Google 登入服務暫時無法驗證');
  googleKeys = { at: Date.now(), keys: (await res.json()).keys || [] };
  return googleKeys.keys;
}

async function verifyGoogleIdToken(idToken, env, nonce) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new Error('format');
  const header = b64uToJson(parts[0]);
  const payload = b64uToJson(parts[1]);
  if (header.alg !== 'RS256') throw new Error('alg');
  const jwk = (await loadGoogleKeys()).find(k => k.kid === header.kid);
  if (!jwk) throw new Error('kid');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64uToBytes(parts[2]), new TextEncoder().encode(parts[0] + '.' + parts[1]));
  const now = nowSec();
  if (!ok || !GOOGLE_ISSUERS.includes(payload.iss) || payload.aud !== env.GOOGLE_CLIENT_ID || !(payload.exp > now)
    || payload.nonce !== nonce || payload.email_verified !== true || !payload.email) throw new Error('claims');
  return String(payload.email).toLowerCase();
}

async function handleAuthLogin(request, env, url) {
  if (!authConfigured(env)) throw new HttpError(503, '登入尚未設定');
  throttle('login:' + (request.headers.get('CF-Connecting-IP') || 'unknown'), 20);
  const state = randomB64u(16), nonce = randomB64u(16), verifier = randomB64u(32);
  const challenge = bytesToB64u(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const oauth = await signToken(env, { state, nonce, verifier, exp: nowSec() + 600 });
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID, redirect_uri: url.origin + '/auth/callback', response_type: 'code',
    scope: 'openid email', state, nonce, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account',
  });
  return redirect('https://accounts.google.com/o/oauth2/v2/auth?' + params, [setCookie(OAUTH_COOKIE, oauth, 600, '/auth')]);
}

async function handleAuthCallback(request, env, url) {
  if (!authConfigured(env)) throw new HttpError(503, '登入尚未設定');
  throttle('login:' + (request.headers.get('CF-Connecting-IP') || 'unknown'), 20);
  const clearOauth = setCookie(OAUTH_COOKIE, '', 0, '/auth');
  const saved = await readToken(env, getCookie(request, OAUTH_COOKIE));
  const code = url.searchParams.get('code') || '', state = url.searchParams.get('state') || '';
  if (!saved || !code || !safeEqual(saved.state, state)) return messagePage(400, '登入失敗', '登入逾時或來源不正確，請重新登入。');
  let email;
  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: url.origin + '/auth/callback', grant_type: 'authorization_code', code_verifier: saved.verifier }),
    });
    if (!res.ok) throw new Error('token');
    email = await verifyGoogleIdToken((await res.json()).id_token, env, saved.nonce);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    return messagePage(400, '登入失敗', 'Google 驗證沒有通過，請重新登入。');
  }
  if (!csv(env.ALLOWED_EMAILS).map(s => s.toLowerCase()).includes(email)) {
    const page = messagePage(403, '沒有使用權限', '這個 Google 帳號不在允許名單內。');
    page.headers.append('Set-Cookie', clearOauth);
    return page;
  }
  const session = await signToken(env, { email, exp: nowSec() + SESSION_TTL_SECONDS });
  return redirect('/', [setCookie(SESSION_COOKIE, session, SESSION_TTL_SECONDS, '/'), clearOauth]);
}

const writeLog = new Map();
function throttle(key, limit) {
  const now = Date.now();
  const recent = (writeLog.get(key) || []).filter(t => now - t < 60e3);
  if (recent.length >= limit) throw new HttpError(429, '操作太頻繁，請稍後再試');
  recent.push(now);
  writeLog.set(key, recent);
}
const throttleWrites = key => throttle(key, WRITE_LIMIT_PER_MIN);

// ── Notion ───────────────────────────────────────────────────

async function notion(token, method, path, body) {
  if (!token) throw new HttpError(500, 'Notion 金鑰未設定');
  const res = await fetch(NOTION_BASE + path, {
    method,
    headers: { 'Authorization': 'Bearer ' + token, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(502, 'Notion 回應錯誤（' + res.status + '）');
  return data;
}
const queryDb = (token, dbId, body) => notion(token, 'POST', `databases/${dbId}/query`, body).then(d => d.results || []);
const rt = v => [{ text: { content: String(v == null ? '' : v).slice(0, 1900) } }];
const plain = arr => (arr || []).map(t => t.plain_text || '').join('');
const getText = (pr, k) => plain(pr[k] && (pr[k].rich_text || pr[k].title));
const getSel = (pr, k) => (pr[k] && pr[k].select && pr[k].select.name) || '';
const getNum = (pr, k) => (pr[k] && pr[k].number != null ? pr[k].number : null);
const getDate = (pr, k) => (pr[k] && pr[k].date && pr[k].date.start) || '';
// CRM 的長文字欄位用 <br /> 表示換行，轉成真正的換行再顯示
const brText = t => String(t || '').replace(/<br\s*\/?>/gi, '\n');
const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
const sameId = (a, b) => String(a || '').replace(/-/g, '') === String(b || '').replace(/-/g, '');

async function loadPageIn(token, dbId, pageId) {
  if (!UUID.test(pageId)) throw new HttpError(400, '編號不正確');
  const page = await notion(token, 'GET', 'pages/' + pageId);
  if (!page.parent || !sameId(page.parent.database_id, dbId)) throw new HttpError(404, '找不到資料');
  return page;
}

// ── 輸入驗證 ─────────────────────────────────────────────────

function isDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}
const isTime = s => s === '' || (typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s));
function str(v, max, required, label) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (required && !s) throw new HttpError(400, `請填寫${label}`);
  if (s.length > max) throw new HttpError(400, `${label}太長`);
  return s;
}
function oneOf(v, list, label) {
  if (!list.includes(v)) throw new HttpError(400, `${label}不正確`);
  return v;
}
function num(v, min, max, label) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `${label}不正確`);
  return n;
}
const twToday = (offsetDays = 0) => new Date(Date.now() + 8 * 3600e3 + offsetDays * 86400e3).toISOString().slice(0, 10);
const newCode = prefix => prefix + '-' + twToday().replace(/-/g, '').slice(2) + '-' + String(Math.floor(Math.random() * 10000)).padStart(4, '0');
const applicant = (v, env) => oneOf(typeof v === 'string' ? v.trim() : '', csv(env.APPLICANTS), '申請人');

// ── LINE ─────────────────────────────────────────────────────

// 只有 LINE Worker（MODE=line）持有 LINE 金鑰與群組編號。網站 Worker 要通知時，
// 帶共用密鑰呼叫 LINE Worker 的 /api/line/notify，由它發出；訊息內容由網站 Worker 自己組，瀏覽器無法指定。
async function linePushDirect(env, text) {
  if (!env.LINE_CHANNEL_TOKEN || !env.LINE_GROUP_ID) return;
  await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + env.LINE_CHANNEL_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: env.LINE_GROUP_ID, messages: [{ type: 'text', text: text.slice(0, 4900) }] }),
  });
}
async function linePush(env, text) {
  try {
    if (env.MODE === 'line') return await linePushDirect(env, text);
    if (!env.LINE_NOTIFY_URL || !env.NOTIFY_KEY) return;
    await fetch(env.LINE_NOTIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Notify-Key': env.NOTIFY_KEY },
      body: JSON.stringify({ text: text.slice(0, 4000) }),
    });
  } catch (_) { /* 通知失敗不影響記錄 */ }
}
function safeEqual(a, b) {
  a = String(a || ''); b = String(b || '');
  if (!a || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
async function handleLineNotify(request, env) {
  if (!safeEqual(request.headers.get('X-Notify-Key'), env.NOTIFY_KEY)) throw new HttpError(401, '密鑰不正確');
  const body = await request.json().catch(() => ({}));
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text || text.length > 4000) throw new HttpError(400, '訊息內容不正確');
  await linePushDirect(env, text);
  return json({ ok: true });
}
async function lineReply(env, replyToken, text) {
  if (!env.LINE_CHANNEL_TOKEN || !replyToken) return;
  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + env.LINE_CHANNEL_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ replyToken, messages: [{ type: 'text', text: text.slice(0, 4900) }] }),
  });
}

async function verifyLineSignature(rawBody, signature, secret) {
  if (!secret || !signature) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody)));
  let expected = '';
  for (const b of mac) expected += String.fromCharCode(b);
  expected = btoa(expected);
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

async function leaveOn(env, date) {
  const rows = await queryDb(env.HR_TOKEN, env.DB_LEAVE, {
    filter: { and: [{ property: '開始日期', date: { on_or_before: date } }, { property: '結束日期', date: { on_or_after: date } }] },
    sorts: [{ property: '開始日期', direction: 'ascending' }],
  });
  return rows.map(r => ({ name: getText(r.properties, '姓名') || '未知', type: getSel(r.properties, '假別'), days: getNum(r.properties, '請假天數') }));
}
// 請假以小時為單位；Notion 的「請假天數」欄存「小時 ÷ 8」，顯示時換回「N 天 M 小時」
const fmtLeave = days => {
  const hours = Math.round(Number(days || 0) * 16) / 2;
  const d = Math.floor(hours / 8), r = hours - d * 8;
  return [d ? d + ' 天' : '', r ? r + ' 小時' : ''].filter(Boolean).join(' ') || '0 小時';
};
const leaveLines = list => list.map(x => `• ${x.name}　${x.type}${x.days ? '　' + fmtLeave(x.days) : ''}`).join('\n');

async function dailyNotice(env) {
  const today = twToday();
  const list = await leaveOn(env, today);
  await linePush(env, `📅 今日請假（${today}）\n` + (list.length ? leaveLines(list) + `\n共 ${list.length} 人` : '今日無人請假'));
}

async function handleLineEvent(event, env) {
  if (event.type !== 'message' || !event.message || event.message.type !== 'text') return;
  if (!event.source || event.source.type !== 'group' || !env.LINE_GROUP_ID || event.source.groupId !== env.LINE_GROUP_ID) return;
  const allowed = csv(env.LINE_ALLOWED_USER_IDS);
  if (allowed.length && !allowed.includes(String(event.source.userId || ''))) return;
  if (!((event.message.mention || {}).mentionees || []).some(m => m.isSelf === true)) return;
  const text = String(event.message.text || '').replace(/@\S+/g, '').trim().slice(0, 100);
  const reply = msg => lineReply(env, event.replyToken, msg);

  if (text === '今日請假') {
    const today = twToday();
    const list = await leaveOn(env, today);
    return reply(`📅 今日請假（${today}）\n` + (list.length ? leaveLines(list) : '今日無人請假'));
  }
  const m = text.match(/^請假查詢\s+(\S{1,30})$/);
  if (m) {
    const rows = await queryDb(env.HR_TOKEN, env.DB_LEAVE, { filter: { property: '姓名', rich_text: { contains: m[1] } }, sorts: [{ property: '開始日期', direction: 'descending' }], page_size: 5 });
    if (!rows.length) return reply(`找不到 ${m[1]} 的請假記錄`);
    return reply(`📋 ${m[1]} 最近請假\n` + rows.map(r => `• ${getDate(r.properties, '開始日期')}～${getDate(r.properties, '結束日期')}　${getSel(r.properties, '假別')}`).join('\n'));
  }
  return reply('📋 可用指令（先 @我）：\n・今日請假\n・請假查詢 姓名');
}

async function handleLineWebhook(request, env, ctx) {
  const raw = await request.text();
  if (!await verifyLineSignature(raw, request.headers.get('x-line-signature'), env.LINE_CHANNEL_SECRET)) {
    return new Response('Invalid signature', { status: 401, headers: SECURITY_HEADERS });
  }
  let events = [];
  try { events = JSON.parse(raw).events || []; } catch (_) { /* 簽章正確但內容壞掉，當作沒事件 */ }
  const work = Promise.allSettled(events.slice(0, 20).map(e => handleLineEvent(e, env)));
  if (ctx && ctx.waitUntil) ctx.waitUntil(work); else await work;
  return new Response('OK', { status: 200, headers: SECURITY_HEADERS });
}

// ── CRM 歷史日誌（客戶頁面內容，依日期分組，每件事單獨一則）─────

const LOG_NOTE = /^(日期說明|說明|注意|須知|備註|提醒|重要)[：:]/;
function parseClientLog(blocks) {
  const days = [];
  let day = null;
  for (const b of blocks) {
    const body = b[b.type];
    if (!body || !Array.isArray(body.rich_text)) continue;
    const text = plain(body.rich_text).replace(/<br\s*\/?>/gi, '\n').trim();
    const links = body.rich_text.filter(t => t.href && t.plain_text.trim()).map(t => ({ text: t.plain_text.trim(), href: t.href }))
      .filter(l => /^https:\/\//.test(l.href));
    if (!text) continue;
    if (/^heading_/.test(b.type)) {
      if (text.includes('歷史日誌')) continue;
      day = { date: text, entries: [] };
      days.push(day);
      continue;
    }
    if (!day || LOG_NOTE.test(text)) continue;
    day.entries.push({ text: text.replace(/^[•・-]\s*/, ''), links });
  }
  return days.filter(d => d.entries.length);
}

// ── API ──────────────────────────────────────────────────────

const monthRange = month => {
  const [y, mo] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return { start: `${month}-01`, end: `${month}-${String(last).padStart(2, '0')}` };
};


// 國定假日（只列平日放假與補假；週末一律不排班）。資料來源：ruyut/TaiwanCalendar 2026.json，
// 使用前請以行政院人事行政總處公告為準。2026 年沒有週末補班日；其他年份沒有資料時預覽會提醒。
const HOLIDAYS = {
  '2026-01-01': '開國紀念日', '2026-02-16': '農曆除夕', '2026-02-17': '春節', '2026-02-18': '春節', '2026-02-19': '春節',
  '2026-02-20': '補假', '2026-02-27': '補假', '2026-04-03': '補假', '2026-04-06': '補假', '2026-05-01': '勞動節',
  '2026-06-19': '端午節', '2026-09-25': '中秋節', '2026-09-28': '教師節', '2026-10-09': '補假', '2026-10-26': '補假',
  '2026-12-25': '行憲紀念日',
};
const MAKEUP_WORKDAYS = {};
const HOLIDAY_YEARS = ['2026'];
const WEEKDAY_NAMES = ['日', '一', '二', '三', '四', '五', '六'];
const validMonth = v => {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(v || '')) throw new HttpError(400, '月份不正確');
  return v;
};

async function checkinPlan(env, name, month) {
  const { start, end } = monthRange(month);
  const [existing, leaves] = await Promise.all([
    queryDb(env.HR_TOKEN, env.DB_CHECKIN, { filter: { and: [{ property: '姓名', title: { equals: name } }, { property: '日期', date: { on_or_after: start } }, { property: '日期', date: { on_or_before: end } }] }, page_size: 100 }),
    queryDb(env.HR_TOKEN, env.DB_LEAVE, { filter: { and: [{ property: '姓名', rich_text: { equals: name } }, { property: '開始日期', date: { on_or_before: end } }, { property: '結束日期', date: { on_or_after: start } }] }, page_size: 100 }),
  ]);
  const done = new Set(existing.map(r => getDate(r.properties, '日期').slice(0, 10)));
  const leaveDays = new Set();
  for (const r of leaves) {
    const a = getDate(r.properties, '開始日期').slice(0, 10), b = getDate(r.properties, '結束日期').slice(0, 10) || a;
    for (let d = new Date(a + 'T00:00:00Z'); d <= new Date(b + 'T00:00:00Z'); d = new Date(d.getTime() + 86400e3)) leaveDays.add(d.toISOString().slice(0, 10));
  }
  const days = [];
  const last = Number(end.slice(8));
  for (let i = 1; i <= last; i++) {
    const date = `${month}-${String(i).padStart(2, '0')}`;
    const dow = new Date(date + 'T00:00:00Z').getUTCDay();
    const weekend = (dow === 0 || dow === 6) && !MAKEUP_WORKDAYS[date];
    if (weekend) continue;
    let status = 'work', label = '';
    if (HOLIDAYS[date]) { status = 'holiday'; label = HOLIDAYS[date]; }
    else if (leaveDays.has(date)) { status = 'leave'; label = '請假'; }
    else if (done.has(date)) { status = 'done'; label = '已有簽到'; }
    days.push({ date, dow: WEEKDAY_NAMES[dow], status, label, checked: status === 'work' });
  }
  return { month, hasHolidayData: HOLIDAY_YEARS.includes(month.slice(0, 4)), days };
}

async function api(request, env, ctx, url) {
  const email = await authenticate(request, env);
  const method = request.method;
  const path = url.pathname;
  if (method !== 'GET') {
    if (request.headers.get('Origin') !== url.origin) throw new HttpError(403, '來源不被允許');
    throttleWrites(email);
  }
  const body = (method === 'GET' || method === 'HEAD') ? {} : await request.json().catch(() => { throw new HttpError(400, '資料格式錯誤'); });
  let m;

  if (method === 'GET' && path === '/api/me') return json({ email });

  if (method === 'GET' && path === '/api/config') {
    return json({ applicants: csv(env.APPLICANTS), leaveTypes: LEAVE_TYPES, expenseCats: EXPENSE_CATS });
  }

  if (method === 'GET' && path === '/api/home') {
    const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(url.searchParams.get('month') || '') ? url.searchParams.get('month') : twToday().slice(0, 7);
    const { start, end } = monthRange(month);
    const [today, leaves, expenses] = await Promise.all([
      leaveOn(env, twToday()),
      queryDb(env.HR_TOKEN, env.DB_LEAVE, { filter: { and: [{ property: '開始日期', date: { on_or_after: start } }, { property: '開始日期', date: { on_or_before: end } }] }, sorts: [{ property: '開始日期', direction: 'descending' }], page_size: 100 }),
      queryDb(env.HR_TOKEN, env.DB_EXPENSE, { filter: { and: [{ timestamp: 'created_time', created_time: { on_or_after: start } }, { timestamp: 'created_time', created_time: { on_or_before: end + 'T23:59:59+08:00' } }] }, sorts: [{ timestamp: 'created_time', direction: 'descending' }], page_size: 100 }),
    ]);
    const leaveBy = {}, expBy = {};
    const entries = [];
    for (const r of leaves) {
      const n = getText(r.properties, '姓名') || '未知', d = getNum(r.properties, '請假天數') || 0;
      (leaveBy[n] = leaveBy[n] || { name: n, days: 0, count: 0 }).days += d; leaveBy[n].count++;
      entries.push({ kind: '請假', name: n, text: `${getSel(r.properties, '假別')} ${fmtLeave(d)}`, date: getDate(r.properties, '開始日期'), at: r.created_time });
    }
    for (const r of expenses) {
      const n = getText(r.properties, '姓名') || '未知', t = getNum(r.properties, '合計金額') || 0;
      (expBy[n] = expBy[n] || { name: n, total: 0, count: 0 }).total += t; expBy[n].count++;
      entries.push({ kind: '報帳', name: n, text: `NT$${t.toLocaleString('en-US')}　${getText(r.properties, '專案用途')}`.trim(), date: (r.created_time || '').slice(0, 10), at: r.created_time });
    }
    entries.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    return json({ month, today: twToday(), todayLeaves: today, leaveByPerson: Object.values(leaveBy), expenseByPerson: Object.values(expBy), recent: entries.slice(0, 10) });
  }

  if (path === '/api/leave') {
    if (method === 'GET') {
      const rows = await queryDb(env.HR_TOKEN, env.DB_LEAVE, { sorts: [{ property: '開始日期', direction: 'descending' }], page_size: 30 });
      return json({ items: rows.map(r => ({ id: r.id, name: getText(r.properties, '姓名'), type: getSel(r.properties, '假別'), start: getDate(r.properties, '開始日期'), end: getDate(r.properties, '結束日期'), days: getNum(r.properties, '請假天數'), reason: getText(r.properties, '請假原因') })) });
    }
    if (method === 'POST') {
      const name = applicant(body.name, env);
      const type = oneOf(body.type, LEAVE_TYPES, '假別');
      if (!isDate(body.start) || !isDate(body.end) || body.end < body.start) throw new HttpError(400, '日期不正確');
      const hours = num(body.hours, 0.5, 480, '請假時數');
      if (hours * 2 !== Math.round(hours * 2)) throw new HttpError(400, '請假時數最小單位是 0.5 小時');
      const spanDays = Math.round((new Date(body.end + 'T00:00:00Z') - new Date(body.start + 'T00:00:00Z')) / 86400e3) + 1;
      if (hours > spanDays * 8) throw new HttpError(400, '請假時數超過日期範圍（每天最多 8 小時）');
      const days = Math.round(hours / 8 * 1000) / 1000;
      const reason = str(body.reason, 500, false, '原因');
      await notion(env.HR_TOKEN, 'POST', 'pages', { parent: { database_id: env.DB_LEAVE }, properties: {
        '申請編號': { title: rt(newCode('REQ')) }, '姓名': { rich_text: rt(name) }, '假別': { select: { name: type } },
        '開始日期': { date: { start: body.start } }, '結束日期': { date: { start: body.end } },
        '請假天數': { number: days }, '請假原因': { rich_text: rt(reason) }, '審核狀態': { select: { name: '已登記' } },
      } });
      ctx.waitUntil(linePush(env, `📋 新請假\n${name}　${type}\n${body.start} ～ ${body.end}（${fmtLeave(days)}）${reason ? '\n原因：' + reason : ''}`));
      return json({ ok: true });
    }
  }

  if (path === '/api/expenses') {
    if (method === 'GET') {
      const rows = await queryDb(env.HR_TOKEN, env.DB_EXPENSE, { sorts: [{ timestamp: 'created_time', direction: 'descending' }], page_size: 30 });
      return json({ items: rows.map(r => ({ id: r.id, name: getText(r.properties, '姓名'), total: getNum(r.properties, '合計金額'), detail: getText(r.properties, '費用明細'), project: getText(r.properties, '專案用途'), created: (r.created_time || '').slice(0, 10) })) });
    }
    if (method === 'POST') {
      const name = applicant(body.name, env);
      const items = Array.isArray(body.items) ? body.items : [];
      if (!items.length || items.length > 20) throw new HttpError(400, '請填寫 1 到 20 筆費用明細');
      const clean = items.map(i => ({ desc: str(i.desc, 100, true, '費用說明'), cat: oneOf(i.cat, EXPENSE_CATS, '費用類別'), amount: num(i.amount, 0, 10000000, '金額') }));
      const total = clean.reduce((s, i) => s + i.amount, 0);
      const project = str(body.project, 200, false, '專案用途');
      const note = str(body.note, 500, false, '備註');
      await notion(env.HR_TOKEN, 'POST', 'pages', { parent: { database_id: env.DB_EXPENSE }, properties: {
        '申請編號': { title: rt(newCode('EXP')) }, '姓名': { rich_text: rt(name) }, '合計金額': { number: total },
        '費用明細': { rich_text: rt(clean.map(i => `${i.desc}（${i.cat}）NT$${i.amount}`).join('、')) },
        '專案用途': { rich_text: rt(project) }, '備註': { rich_text: rt(note) }, '審核狀態': { select: { name: '已登記' } },
      } });
      ctx.waitUntil(linePush(env, `💰 新報帳\n${name}　NT$${Math.round(total).toLocaleString('en-US')}\n項目：${[...new Set(clean.map(i => i.cat))].join('、')}${project ? '\n專案：' + project : ''}`));
      return json({ ok: true });
    }
  }

  if (path === '/api/checkin') {
    if (method === 'GET') {
      const rows = await queryDb(env.HR_TOKEN, env.DB_CHECKIN, { sorts: [{ property: '日期', direction: 'descending' }], page_size: 40 });
      return json({ items: rows.map(r => ({ id: r.id, name: getText(r.properties, '姓名'), date: getDate(r.properties, '日期'), clockIn: getText(r.properties, '上班時間'), clockOut: getText(r.properties, '下班時間'), note: getText(r.properties, '備註'), edited: r.last_edited_time || '' })) });
    }
    if (method === 'POST') {
      const name = applicant(body.name, env);
      if (!isDate(body.date) || !isTime(body.clockIn || '') || !isTime(body.clockOut || '') || !(body.clockIn || body.clockOut)) throw new HttpError(400, '日期或時間不正確');
      await notion(env.HR_TOKEN, 'POST', 'pages', { parent: { database_id: env.DB_CHECKIN }, properties: {
        '姓名': { title: rt(name) }, '日期': { date: { start: body.date } }, '上班時間': { rich_text: rt(body.clockIn || '') },
        '下班時間': { rich_text: rt(body.clockOut || '') }, '備註': { rich_text: rt(str(body.note, 300, false, '備註')) },
      } });
      return json({ ok: true });
    }
  }
  if ((m = path.match(/^\/api\/checkin\/([0-9a-fA-F-]{32,36})$/)) && method === 'PATCH') {
    const page = await loadPageIn(env.HR_TOKEN, env.DB_CHECKIN, m[1]);
    if (!isDate(body.date) || !isTime(body.clockIn || '') || !isTime(body.clockOut || '') || !(body.clockIn || body.clockOut)) throw new HttpError(400, '日期或時間不正確');
    await notion(env.HR_TOKEN, 'PATCH', 'pages/' + page.id, { properties: {
      '日期': { date: { start: body.date } }, '上班時間': { rich_text: rt(body.clockIn || '') },
      '下班時間': { rich_text: rt(body.clockOut || '') }, '備註': { rich_text: rt(str(body.note, 300, false, '備註')) },
    } });
    return json({ ok: true });
  }

  if (method === 'GET' && path === '/api/checkin/plan') {
    return json(await checkinPlan(env, applicant(url.searchParams.get('name'), env), validMonth(url.searchParams.get('month'))));
  }
  if (method === 'POST' && path === '/api/checkin/month') {
    const name = applicant(body.name, env);
    const month = validMonth(body.month);
    if (!isTime(body.clockIn || '') || !isTime(body.clockOut || '') || !body.clockIn || !body.clockOut) throw new HttpError(400, '請填上班與下班時間');
    const dates = Array.isArray(body.dates) ? [...new Set(body.dates)] : [];
    if (!dates.length || dates.length > 31 || !dates.every(d => isDate(d) && d.startsWith(month + '-'))) throw new HttpError(400, '日期不正確');
    const plan = await checkinPlan(env, name, month);
    const already = new Set(plan.days.filter(d => d.status === 'done').map(d => d.date));
    let created = 0;
    const skipped = [];
    for (const date of dates.sort()) {
      if (already.has(date)) { skipped.push(date); continue; }
      await notion(env.HR_TOKEN, 'POST', 'pages', { parent: { database_id: env.DB_CHECKIN }, properties: {
        '姓名': { title: rt(name) }, '日期': { date: { start: date } }, '上班時間': { rich_text: rt(body.clockIn) },
        '下班時間': { rich_text: rt(body.clockOut) }, '備註': { rich_text: rt('全月正常出勤') },
      } });
      created++;
    }
    return json({ ok: true, created, skipped });
  }

  if (path === '/api/clients' && method === 'GET') {
    const rows = await queryDb(env.CRM_TOKEN, env.DB_CRM, { sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }], page_size: 100 });
    return json({ items: rows.map(r => ({ id: r.id, name: getText(r.properties, '客戶名稱'), status: getSel(r.properties, '潛在客戶狀態'), priority: getSel(r.properties, '優先級'), action: brText(getText(r.properties, '下一步行動')), commitment: brText(getText(r.properties, '承諾事項')), notes: brText(getText(r.properties, '詳細現況備註')), amount: getNum(r.properties, '專案金額'), updated: (r.last_edited_time || '').slice(0, 10) })) });
  }
  if ((m = path.match(/^\/api\/clients\/([0-9a-fA-F-]{32,36})\/log$/)) && method === 'GET') {
    const page = await loadPageIn(env.CRM_TOKEN, env.DB_CRM, m[1]);
    const blocks = (await notion(env.CRM_TOKEN, 'GET', `blocks/${page.id}/children?page_size=100`)).results || [];
    return json({ days: parseClientLog(blocks) });
  }

  throw new HttpError(404, '找不到這個功能');
}

// ── 靜態頁面與進入點 ─────────────────────────────────────────

function serveAsset(path) {
  const a = ASSETS[path === '/' ? '/index.html' : path];
  if (!a) return null;
  return new Response(a.body, { status: 200, headers: { ...SECURITY_HEADERS, 'Content-Type': a.type, 'Cache-Control': 'no-cache' } });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (env.MODE === 'line') {
        if (url.pathname === '/api/line/webhook' && request.method === 'POST') return await handleLineWebhook(request, env, ctx);
        if (url.pathname === '/api/line/notify' && request.method === 'POST') return await handleLineNotify(request, env);
        return new Response('Not found', { status: 404, headers: SECURITY_HEADERS });
      }
      if (url.pathname === '/auth/login' && request.method === 'GET') return await handleAuthLogin(request, env, url);
      if (url.pathname === '/auth/callback' && request.method === 'GET') return await handleAuthCallback(request, env, url);
      if (url.pathname === '/auth/logout' && request.method === 'POST') {
        if (request.headers.get('Origin') !== url.origin) throw new HttpError(403, '來源不被允許');
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { ...SECURITY_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Set-Cookie': setCookie(SESSION_COOKIE, '', 0, '/') } });
      }
      if (url.pathname.startsWith('/api/')) return await api(request, env, ctx, url);
      if (request.method === 'GET') {
        try { await authenticate(request, env); } catch (e) {
          if (e instanceof HttpError && e.status === 401) return redirect('/auth/login');
          throw e;
        }
        const asset = serveAsset(url.pathname);
        if (asset) return asset;
      }
      return new Response('Not found', { status: 404, headers: SECURITY_HEADERS });
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.log('[error]', e && e.message);
      return json({ error: '系統忙碌，請稍後再試' }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    if (env.MODE !== 'line') return;
    const dow = new Date(Date.now() + 8 * 3600e3).getUTCDay();
    if (dow === 0 || dow === 6) return;
    ctx.waitUntil(dailyNotice(env));
  },
};
