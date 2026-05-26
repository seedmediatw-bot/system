/**
 * HR 系統 API 代理 - Cloudflare Worker
 *
 * 環境變數（Settings → Variables）：
 *   HR_TOKEN          Notion Integration Token
 *   HR_ACCESS_KEY     前端呼叫 /api/hr/* 時需攜帶的密鑰
 *   HR_PASSWORD       HR 登入密碼
 *   ADMIN_PASSWORD    管理員設定頁密碼
 *   GEMINI_API_KEY    Google AI Studio API Key
 *   DB_LEAVE / DB_EXPENSE / DB_EMPLOYEES / DB_APPROVALS / DB_CHECKIN / DB_ACCOUNTS
 *   GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY / GOOGLE_DRIVE_FOLDER_ID（收據上傳用）
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

// ── HR 模組 ───────────────────────────────────────────────────

async function handleHR(request, env, pathname, origin) {
  if (!authCheck(request, env.HR_ACCESS_KEY)) {
    return errResponse('Unauthorized Access', origin, 401);
  }
  if (pathname === '/api/hr/drive-upload') {
    return handleDriveUpload(request, env, origin);
  }
  const notionPath = pathname.replace('/api/hr/', '');
  return notionProxy(request, env.HR_TOKEN, notionPath, origin);
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

// ── Google Drive 上傳 ─────────────────────────────────────────

async function handleDriveUpload(request, env, origin) {
  try {
    const clientEmail = env.GOOGLE_CLIENT_EMAIL;
    const privateKey = env.GOOGLE_PRIVATE_KEY;
    const folderId = env.GOOGLE_DRIVE_FOLDER_ID;
    if (!clientEmail || !privateKey || !folderId) {
      return errResponse('Google Drive 環境變數未設定', origin, 500);
    }
    const { base64, mimeType, filename } = await request.json();
    const now = Math.floor(Date.now() / 1000);
    const jwtHeader = btoa(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
    const jwtPayload = btoa(JSON.stringify({
      iss: clientEmail, scope: 'https://www.googleapis.com/auth/drive.file',
      aud: 'https://oauth2.googleapis.com/token', exp: now + 3600, iat: now
    })).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
    const signingInput = `${jwtHeader}.${jwtPayload}`;
    const pemKey = privateKey.replace(/\\n/g,'\n').replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----/g,'').replace(/\s/g,'');
    const keyBuffer = Uint8Array.from(atob(pemKey), c => c.charCodeAt(0));
    const cryptoKey = await crypto.subtle.importKey('pkcs8', keyBuffer, { name:'RSASSA-PKCS1-v1_5', hash:'SHA-256' }, false, ['sign']);
    const sigBuffer = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, new TextEncoder().encode(signingInput));
    const sig = btoa(String.fromCharCode(...new Uint8Array(sigBuffer))).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
    const jwt = `${signingInput}.${sig}`;
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) return errResponse('Google 認證失敗', origin, 500);
    const binary = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const meta = JSON.stringify({ name: filename || 'receipt.jpg', parents: [folderId] });
    const boundary = 'drive_boundary_hr';
    const enc = new TextEncoder();
    const p1 = enc.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`);
    const p2h = enc.encode(`--${boundary}\r\nContent-Type: ${mimeType || 'image/jpeg'}\r\n\r\n`);
    const p2e = enc.encode(`\r\n--${boundary}--`);
    const body = new Uint8Array(p1.length + p2h.length + binary.length + p2e.length);
    let off = 0;
    body.set(p1, off); off += p1.length;
    body.set(p2h, off); off += p2h.length;
    body.set(binary, off); off += binary.length;
    body.set(p2e, off);
    const uploadRes = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${tokenData.access_token}`, 'Content-Type': `multipart/related; boundary="${boundary}"` },
      body
    });
    if (!uploadRes.ok) {
      const errText = await uploadRes.text();
      return errResponse('Drive 上傳失敗: ' + errText.slice(0, 100), origin, 500);
    }
    const fileData = await uploadRes.json();
    await fetch(`https://www.googleapis.com/drive/v3/files/${fileData.id}/permissions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${tokenData.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'reader', type: 'anyone' })
    });
    return okResponse({ url: `https://drive.google.com/uc?export=view&id=${fileData.id}`, id: fileData.id }, origin);
  } catch (e) {
    return errResponse('Drive 上傳錯誤: ' + e.message, origin, 500);
  }
}

// ── 身份驗證 ──────────────────────────────────────────────────

async function handleAuth(request, env, origin) {
  try {
    const { system, password } = await request.json();
    const pwMap = { hr: env.HR_PASSWORD, admin: env.ADMIN_PASSWORD };
    const expected = pwMap[system];
    if (!expected) return errResponse('Password not configured', origin, 500);
    if (password === expected) {
      const dbIds = system === 'hr' ? {
        leave: env.DB_LEAVE, expense: env.DB_EXPENSE,
        employees: env.DB_EMPLOYEES, approvals: env.DB_APPROVALS,
        checkin: env.DB_CHECKIN, interview: env.DB_INTERVIEW,
      } : {};
      return okResponse({ ok: true, accessKey: system === 'hr' ? env.HR_ACCESS_KEY : null, dbIds }, origin);
    }
    return errResponse('密碼錯誤', origin, 401);
  } catch (e) {
    return errResponse('Invalid request', origin, 400);
  }
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
      return okResponse({ ok: true, hr: !!env.HR_TOKEN, gemini: !!env.GEMINI_API_KEY }, origin);
    }

    if (pathname === '/api/auth')         return handleAuth(request, env, origin);
    if (pathname.startsWith('/api/hr/'))  return handleHR(request, env, pathname, origin);
    if (pathname === '/api/gemini')       return handleGemini(request, env, origin);

    return errResponse('Route not found', origin, 404);
  },
};
