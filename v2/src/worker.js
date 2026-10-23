/**
 * 種子 HR 系統 v2：單一 Cloudflare Worker（網頁 + API + LINE）
 *
 * 部署同一個檔案兩次：
 *   seed-hr       給 Sam 用。前面由 Cloudflare Access 擋住，只放行 Sam 的 Google 信箱。
 *   seed-hr-line  只收 LINE 通知、發每日通知。環境變數 MODE=line；其他路徑一律 404。
 *
 * 環境變數（皆在 Cloudflare 控制台填，不寫進程式）：
 *   ACCESS_TEAM_DOMAIN  例如 xxx.cloudflareaccess.com
 *   ACCESS_AUD          Access 應用程式的 AUD 標籤
 *   ALLOWED_EMAILS      逗號分隔，允許使用網站的 Google 信箱（即使 Access 設錯也會再擋一次）
 *   APPLICANTS          逗號分隔，可代為填單的人名，例如「甲,乙」
 *   HR_TOKEN / CRM_TOKEN   Notion 整合金鑰（CRM 那把只需讀取權限）
 *   DB_LEAVE DB_EXPENSE DB_CHECKIN DB_CRM
 *   LINE_CHANNEL_TOKEN LINE_CHANNEL_SECRET LINE_GROUP_ID
 *   LINE_ALLOWED_USER_IDS（選填，逗號分隔；有填就只接受這些人的指令）
 *
 * Cron（只設在 seed-hr-line）：UTC 01:00 週一到週五，即台灣 09:00 → 每日請假通知
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

// ── Cloudflare Access 憑證驗證 ────────────────────────────────

const b64uToBytes = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const b64uToJson = s => JSON.parse(new TextDecoder().decode(b64uToBytes(s)));
let jwksCache = { at: 0, keys: null, team: '' };

async function loadJwks(env) {
  const now = Date.now();
  if (jwksCache.keys && jwksCache.team === env.ACCESS_TEAM_DOMAIN && now - jwksCache.at < 3600e3) return jwksCache.keys;
  const res = await fetch(`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`);
  if (!res.ok) throw new HttpError(503, '登入服務暫時無法驗證');
  const data = await res.json();
  jwksCache = { at: now, keys: data.keys || [], team: env.ACCESS_TEAM_DOMAIN };
  return jwksCache.keys;
}

async function authenticate(request, env) {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD || !csv(env.ALLOWED_EMAILS).length) throw new HttpError(503, '登入尚未設定');
  const parts = (request.headers.get('Cf-Access-Jwt-Assertion') || '').split('.');
  if (parts.length !== 3) throw new HttpError(401, '請先登入');
  let email;
  try {
    const header = b64uToJson(parts[0]);
    const payload = b64uToJson(parts[1]);
    if (header.alg !== 'RS256') throw new Error('alg');
    const jwk = (await loadJwks(env)).find(k => k.kid === header.kid);
    if (!jwk) throw new Error('kid');
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64uToBytes(parts[2]), new TextEncoder().encode(parts[0] + '.' + parts[1]));
    const now = Math.floor(Date.now() / 1000);
    if (!ok || ![].concat(payload.aud || []).includes(env.ACCESS_AUD) || payload.iss !== 'https://' + env.ACCESS_TEAM_DOMAIN
      || !(payload.exp > now) || (payload.nbf && payload.nbf > now + 60) || !payload.email) throw new Error('claims');
    email = String(payload.email).toLowerCase();
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(401, '登入無效或已過期');
  }
  if (!csv(env.ALLOWED_EMAILS).map(s => s.toLowerCase()).includes(email)) throw new HttpError(403, '這個帳號沒有使用權限');
  return email;
}

const writeLog = new Map();
function throttleWrites(key) {
  const now = Date.now();
  const recent = (writeLog.get(key) || []).filter(t => now - t < 60e3);
  if (recent.length >= WRITE_LIMIT_PER_MIN) throw new HttpError(429, '操作太頻繁，請稍後再試');
  recent.push(now);
  writeLog.set(key, recent);
}

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

async function linePush(env, text) {
  if (!env.LINE_CHANNEL_TOKEN || !env.LINE_GROUP_ID) return;
  try {
    await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + env.LINE_CHANNEL_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: env.LINE_GROUP_ID, messages: [{ type: 'text', text: text.slice(0, 4900) }] }),
    });
  } catch (_) { /* 通知失敗不影響記錄 */ }
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
const leaveLines = list => list.map(x => `• ${x.name}　${x.type}${x.days ? '　' + x.days + '天' : ''}`).join('\n');

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
      entries.push({ kind: '請假', name: n, text: `${getSel(r.properties, '假別')} ${d} 天`, date: getDate(r.properties, '開始日期'), at: r.created_time });
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
      const days = num(body.days, 0.5, 60, '天數');
      const reason = str(body.reason, 500, false, '原因');
      await notion(env.HR_TOKEN, 'POST', 'pages', { parent: { database_id: env.DB_LEAVE }, properties: {
        '申請編號': { title: rt(newCode('REQ')) }, '姓名': { rich_text: rt(name) }, '假別': { select: { name: type } },
        '開始日期': { date: { start: body.start } }, '結束日期': { date: { start: body.end } },
        '請假天數': { number: days }, '請假原因': { rich_text: rt(reason) }, '審核狀態': { select: { name: '已登記' } },
      } });
      ctx.waitUntil(linePush(env, `📋 新請假\n${name}　${type}\n${body.start} ～ ${body.end}（${days} 天）${reason ? '\n原因：' + reason : ''}`));
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

  if (path === '/api/clients' && method === 'GET') {
    const rows = await queryDb(env.CRM_TOKEN, env.DB_CRM, { sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }], page_size: 100 });
    return json({ items: rows.map(r => ({ id: r.id, name: getText(r.properties, '客戶名稱'), status: getSel(r.properties, '潛在客戶狀態'), priority: getSel(r.properties, '優先級'), action: getText(r.properties, '下一步行動'), commitment: getText(r.properties, '承諾事項'), notes: getText(r.properties, '詳細現況備註'), amount: getNum(r.properties, '專案金額'), updated: (r.last_edited_time || '').slice(0, 10) })) });
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
        return new Response('Not found', { status: 404, headers: SECURITY_HEADERS });
      }
      if (url.pathname.startsWith('/api/')) return await api(request, env, ctx, url);
      if (request.method === 'GET') {
        await authenticate(request, env);
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
    ctx.waitUntil(dailyNotice(env));
  },
};
