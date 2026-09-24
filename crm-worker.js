/**
 * CRM 系統 API 代理 - Cloudflare Worker（v6・2026-09-23）
 * v6：瀏覽器改用 8 小時簽章憑證；長效密鑰僅供既有服務互連。
 *
 * v5 變更（相對 v4）：
 *   - /api/crm/talks 改為連同每位客戶「頁面內文的歷史日誌」一起回傳（log 陣列）
 *     ＝時間軸展開卡直接顯示歷史日誌，不再依賴已刪除的「詳細現況備註」欄位
 *   - note 欄位改回傳日誌最新一條（相容舊前端）
 *   - CRM 主表欄位現況（2026-07-17）：客戶名稱／下一步行動／最近聯繫日期／優先級（裝狀態）／專案金額／承諾事項
 *
 * 環境變數（Settings → Variables）：
 *   CRM_TOKEN         Notion Integration Token
 *   CRM_ACCESS_KEY    前端呼叫 /api/crm/* 時需攜帶的密鑰
 *   CRM_PASSWORD      CRM 登入密碼
 *   ADMIN_PASSWORD    管理員設定頁密碼
 *   GEMINI_API_KEY    Google AI Studio API Key
 *   DB_CRM / DB_CALL
 *   LINE_CHANNEL_TOKEN / LINE_GROUP_ID（LINE 推播通知用）
 *
 * Cron Trigger：每週一 UTC 02:00（台灣時間 10:00）→ 跟進提醒
 */

const ALLOWED_ORIGIN = 'https://seedmediatw-bot.github.io';

function corsHeaders(origin) {
  const allow = origin === ALLOWED_ORIGIN ? origin : ALLOWED_ORIGIN;
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Access-Key, X-Memo-Key',
    'Access-Control-Max-Age': '86400',
  };
}

function okResponse(data, origin, status = 200) {
  return Response.json(data, { status, headers: corsHeaders(origin) });
}

function errResponse(message, origin, status = 400) {
  return Response.json({ status: 'error', message }, { status, headers: corsHeaders(origin) });
}

function authCheck(request, expectedKey) {
  if (!expectedKey) return false;
  return request.headers.get('X-Access-Key') === expectedKey;
}

const SESSION_TTL_SECONDS = 8 * 60 * 60;
const sessionEncoder = new TextEncoder();

async function sessionSigningKey(env) {
  if (!env.CRM_ACCESS_KEY || !env.CRM_PASSWORD) throw new Error('Session signing not configured');
  return crypto.subtle.importKey('raw',
    sessionEncoder.encode('seed-crm-session:v1:' + env.CRM_ACCESS_KEY + '\u0000' + env.CRM_PASSWORD),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function createCrmSession(env) {
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const payload = 'crm1.' + expiresAt + '.' + crypto.randomUUID();
  const signature = await crypto.subtle.sign('HMAC', await sessionSigningKey(env), sessionEncoder.encode(payload));
  const hex = Array.from(new Uint8Array(signature), b => b.toString(16).padStart(2, '0')).join('');
  return { accessKey: payload + '.' + hex, sessionExpiresAt: expiresAt };
}

async function validCrmSession(request, env) {
  const token = request.headers.get('X-Access-Key') || '';
  if (token.length > 256) return false;
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== 'crm1' || !/^\d{10}$/.test(parts[1])
    || !/^[0-9a-f-]{36}$/.test(parts[2]) || !/^[0-9a-f]{64}$/.test(parts[3])) return false;
  const expiresAt = Number(parts[1]);
  const now = Math.floor(Date.now() / 1000);
  if (expiresAt <= now || expiresAt > now + SESSION_TTL_SECONDS) return false;
  try {
    const signature = Uint8Array.from(parts[3].match(/../g), h => parseInt(h, 16));
    return await crypto.subtle.verify('HMAC', await sessionSigningKey(env), signature,
      sessionEncoder.encode(parts.slice(0, 3).join('.')));
  } catch (_) { return false; }
}

// ── Notion 代理 ───────────────────────────────────────────────

async function notionProxy(request, token, notionPath, origin) {
  if (!token) return errResponse('Notion token not configured', origin, 500);
  const res = await fetch('https://api.notion.com/v1/' + notionPath, {
    method: request.method,
    headers: {
      'Authorization': 'Bearer ' + token,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: request.method !== 'GET' ? request.body : undefined,
  });
  const data = await res.text();
  return new Response(data, {
    status: res.status,
    headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
  });
}

// ── CRM 模組 ──────────────────────────────────────────────────

async function handleCRM(request, env, pathname, origin) {
  if (!authCheck(request, env.CRM_ACCESS_KEY) && !await validCrmSession(request, env)) {
    return errResponse('Unauthorized Access', origin, 401);
  }
  const url = new URL(request.url);
  const notionPath = pathname.replace('/api/crm/', '') + url.search;
  return notionProxy(request, env.CRM_TOKEN, notionPath, origin);
}

// ── Gemini 模組 ───────────────────────────────────────────────

async function handleGemini(request, env, origin) {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) return errResponse('Gemini API key not configured', origin, 500);
  try {
    const body = await request.json();
    const model = body.model || 'gemini-2.5-flash';
    delete body.model;
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    );
    const data = await res.text();
    return new Response(data, {
      status: res.status,
      headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return errResponse('Gemini error: ' + e.message, origin, 500);
  }
}

// ── 身份驗證 ──────────────────────────────────────────────────

async function handleAuth(request, env, origin) {
  try {
    const { system, password } = await request.json();
    const pwMap = { crm: env.CRM_PASSWORD, admin: env.ADMIN_PASSWORD };
    const expected = pwMap[system];
    if (!expected) return errResponse('Password not configured', origin, 500);
    if (password === expected) {
      const dbIds = system === 'crm' ? { crm: env.DB_CRM, call: env.DB_CALL } : {};
      const session = system === 'crm' ? await createCrmSession(env) : { accessKey: null };
      return Response.json({ ok: true, ...session, dbIds }, {
        headers: { ...corsHeaders(origin), 'Cache-Control': 'no-store' },
      });
    }
    return errResponse('密碼錯誤', origin, 401);
  } catch (e) {
    return errResponse('Invalid request', origin, 400);
  }
}

// ── LINE 推播 ─────────────────────────────────────────────────

async function sendLine(token, groupId, message) {
  if (!token || !groupId) return;
  await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: groupId, messages: [{ type: 'text', text: message }] }),
  });
}

// ── LINE CRM 查詢（供 HR Worker 轉發呼叫）────────────────────

async function crmNotionQuery(env, filter, sorts) {
  if (!env.CRM_TOKEN || !env.DB_CRM) return null;
  const body = {};
  if (filter) body.filter = filter;
  if (sorts) body.sorts = sorts;
  const res = await fetch(`https://api.notion.com/v1/databases/${env.DB_CRM}/query`, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + env.CRM_TOKEN, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return data.results || [];
}

async function handleLineCRMQuery(request, env, origin) {
  if (!authCheck(request, env.CRM_ACCESS_KEY)) return errResponse('Unauthorized', origin, 401);
  try {
    const { command, args } = await request.json();
    const pad = n => String(n).padStart(2, '0');
    const now = new Date();
    const today = `${now.getUTCFullYear()}-${pad(now.getUTCMonth()+1)}-${pad(now.getUTCDate())}`;

    if (command === '客戶總覽') {
      const clients = await crmNotionQuery(env, null, [{ property: '優先級', direction: 'descending' }]);
      if (!clients) return okResponse({ message: '❌ CRM 未設定' }, origin);
      if (clients.length === 0) return okResponse({ message: '📊 客戶總覽\n\n目前無客戶資料' }, origin);
      const lines = clients.slice(0, 15).map(c => {
        const pr = c.properties;
        const name = pr['客戶名稱']?.title?.[0]?.plain_text || '（未命名）';
        const status = pr['優先級']?.select?.name || '';
        return `• ${name}${status ? '　' + status : ''}`;
      });
      const total = clients.length;
      return okResponse({ message: `📊 客戶總覽（共 ${total} 位）\n\n${lines.join('\n')}${total > 15 ? '\n…（更多請至 CRM 系統查看）' : ''}` }, origin);
    }

    if (command === '客戶' && args) {
      const clients = await crmNotionQuery(env, { property: '客戶名稱', title: { contains: args } }, null);
      if (!clients) return okResponse({ message: '❌ CRM 未設定' }, origin);
      if (clients.length === 0) return okResponse({ message: `❌ 找不到客戶：${args}` }, origin);
      const pr = clients[0].properties;
      const name = pr['客戶名稱']?.title?.[0]?.plain_text || '（未命名）';
      const status = pr['優先級']?.select?.name || '—';
      const nextAction = pr['下一步行動']?.rich_text?.[0]?.plain_text || '—';
      const amount = pr['專案金額']?.number ? `NT$${pr['專案金額'].number.toLocaleString()}` : '—';
      const last = pr['最近聯繫日期']?.date?.start || '—';
      return okResponse({ message: `👤 ${name}\n\n狀態：${status}\n最近聯繫：${last}\n下一步：${nextAction}\n金額：${amount}` }, origin);
    }

    if (command === '跟進提醒') {
      return okResponse({ message: '📅 跟進提醒功能已停用（CRM 已移除「下次跟進日期」欄位）' }, origin);
    }

    return okResponse({ message: '❌ 未知指令' }, origin);
  } catch (e) {
    return errResponse('line-query error: ' + e.message, origin, 500);
  }
}

// ── 客戶頁面內文：抓「歷史日誌」───────────────────────────────

async function fetchClientLog(env, pageId) {
  try {
    const res = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children?page_size=100`, {
      headers: { 'Authorization': 'Bearer ' + env.CRM_TOKEN, 'Notion-Version': '2022-06-28' },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.results || [])
      .map(b => {
        const seg = (b.paragraph || b.heading_1 || b.heading_2 || b.heading_3 || b.bulleted_list_item || {}).rich_text || [];
        return seg.map(t => t.plain_text || '').join('').trim();
      })
      .filter(line => line && !line.includes('歷史日誌'));
  } catch (e) {
    return [];
  }
}

// ── 時間軸洽談中資料（供 HR Worker 轉發呼叫）────────────────

async function handleTalksData(request, env, origin) {
  if (!authCheck(request, env.CRM_ACCESS_KEY)) return errResponse('Unauthorized', origin, 401);
  if (!env.CRM_TOKEN || !env.DB_CRM) return errResponse('CRM not configured', origin, 500);
  try {
    const clients = await crmNotionQuery(env, null, [{ property: '優先級', direction: 'descending' }]);
    if (!clients) return errResponse('CRM query failed', origin, 500);
    const txt = arr => (arr || []).map(t => t.plain_text || '').join('');

    // v5：逐頁抓歷史日誌（每批 3 頁，避免撞 Notion 速率限制）
    const logs = [];
    for (let i = 0; i < clients.length; i += 3) {
      const chunk = clients.slice(i, i + 3);
      const results = await Promise.all(chunk.map(p => fetchClientLog(env, p.id)));
      logs.push(...results);
    }

    const talks = clients.map((p, idx) => {
      const pr = p.properties || {};
      return {
        name: txt(pr['客戶名稱']?.title),
        status: pr['優先級']?.select?.name || '',
        priority: pr['優先級']?.select?.name || '',
        last: pr['最近聯繫日期']?.date?.start || '',
        next: '',
        action: txt(pr['下一步行動']?.rich_text),
        log: logs[idx] || [],
        note: (logs[idx] && logs[idx][0]) || '',
        promise: txt(pr['承諾事項']?.rich_text),
      };
    });
    return okResponse({ talks }, origin);
  } catch (e) {
    return errResponse('talks error: ' + e.message, origin, 500);
  }
}

// ── LINE Webhook ──────────────────────────────────────────────

async function handleLineWebhook(request) {
  try {
    const body = await request.json();
    console.log('[LINE webhook]', JSON.stringify(body.events?.[0]?.source));
  } catch (e) {
    console.log('[LINE webhook error]', e.message);
  }
  return new Response('OK', { status: 200 });
}

// ── Cron：每週一跟進提醒（已停用實質查詢：跟進日期欄位已移除）──

async function handleWeeklyCRM(env) {
  // CRM 已簡化欄位（移除下次跟進日期），每週提醒暫停發送。
  // 若日後要恢復：在 Notion 加回日期欄位，並還原 v4 版本的此函式。
  return;
}

// ── 主路由 ────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const { pathname } = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(origin) });
    }

    if (pathname === '/api/status') {
      return okResponse({ ok: true, crm: !!env.CRM_TOKEN, gemini: !!env.GEMINI_API_KEY, sessionAuth: 'v1', sessionHours: 8 }, origin);
    }

    if (pathname === '/api/auth')              return handleAuth(request, env, origin);
    if (pathname === '/api/crm/line-query')    return handleLineCRMQuery(request, env, origin);
    if (pathname === '/api/crm/talks')         return handleTalksData(request, env, origin);
    if (pathname.startsWith('/api/crm/'))      return handleCRM(request, env, pathname, origin);
    if (pathname === '/api/gemini')            return handleGemini(request, env, origin);
    if (pathname === '/api/line/webhook')      return handleLineWebhook(request);

    return errResponse('Route not found', origin, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleWeeklyCRM(env));
  },
};
