/**
 * CRM 系統 API 代理 - Cloudflare Worker
 *
 * 環境變數（Settings → Variables）：
 *   CRM_TOKEN         Notion Integration Token
 *   CRM_ACCESS_KEY    前端呼叫 /api/crm/* 時需攜帶的密鑰
 *   CRM_PASSWORD      CRM 登入密碼
 *   ADMIN_PASSWORD    管理員設定頁密碼
 *   GEMINI_API_KEY    Google AI Studio API Key
 *   DB_CRM / DB_CALL
 */

const ALLOWED_ORIGIN = 'https://seedmediatw-bot.github.io';

function corsHeaders(origin) {
  const allow = origin === ALLOWED_ORIGIN ? origin : ALLOWED_ORIGIN;
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Access-Key',
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
  if (!authCheck(request, env.CRM_ACCESS_KEY)) {
    return errResponse('Unauthorized Access', origin, 401);
  }
  const notionPath = pathname.replace('/api/crm/', '');
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
      return okResponse({ ok: true, accessKey: system === 'crm' ? env.CRM_ACCESS_KEY : null, dbIds }, origin);
    }
    return errResponse('密碼錯誤', origin, 401);
  } catch (e) {
    return errResponse('Invalid request', origin, 400);
  }
}

// ── LINE Webhook（暫時用來取得 groupId）─────────────────────────

async function handleLineWebhook(request) {
  try {
    const body = await request.json();
    const events = body.events || [];
    events.forEach(event => {
      const source = event.source || {};
      if (source.type === 'group') {
        console.log('[LINE groupId]', source.groupId);
      }
      if (source.type === 'user') {
        console.log('[LINE userId]', source.userId);
      }
    });
  } catch (e) {
    console.log('[LINE webhook error]', e.message);
  }
  // LINE 要求一定要回 200
  return new Response('OK', { status: 200 });
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
      return okResponse({ ok: true, crm: !!env.CRM_TOKEN, gemini: !!env.GEMINI_API_KEY }, origin);
    }

    if (pathname === '/api/auth')              return handleAuth(request, env, origin);
    if (pathname.startsWith('/api/crm/'))      return handleCRM(request, env, pathname, origin);
    if (pathname === '/api/gemini')            return handleGemini(request, env, origin);
    if (pathname === '/api/line/webhook')      return handleLineWebhook(request);

    return errResponse('Route not found', origin, 404);
  },
};
