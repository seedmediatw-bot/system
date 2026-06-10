/**
 * HR 系統 API 代理 - Cloudflare Worker
 *
 * 環境變數（Settings → Variables）：
 *   HR_TOKEN          Notion Integration Token
 *   HR_ACCESS_KEY     前端呼叫 /api/hr/* 時需攜帶的密鑰
 *   HR_PASSWORD       HR 登入密碼
 *   ADMIN_PASSWORD    管理員設定頁密碼
 *   GEMINI_API_KEY    Google AI Studio API Key
 *   DB_LEAVE / DB_EXPENSE / DB_EMPLOYEES / DB_APPROVALS / DB_CHECKIN / DB_INTERVIEW
 *   GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY / GOOGLE_DRIVE_FOLDER_ID（收據上傳用）
 *   LINE_CHANNEL_TOKEN / LINE_GROUP_ID（LINE 推播與 Webhook 用）
 *   CRM_TOKEN / DB_CRM（LINE CRM 查詢指令用）
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

// ── LINE 推播 ─────────────────────────────────────────────────

async function sendLine(token, groupId, message) {
  if (!token || !groupId) return;
  await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: groupId, messages: [{ type: 'text', text: message }] }),
  });
}

async function replyLine(token, replyToken, message) {
  if (!token || !replyToken) return;
  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ replyToken, messages: [{ type: 'text', text: message }] }),
  });
}

async function searchCandidateByName(name, env) {
  if (!env.DB_INTERVIEW || !env.HR_TOKEN) return null;
  const res = await fetch(`https://api.notion.com/v1/databases/${env.DB_INTERVIEW}/query`, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + env.HR_TOKEN, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
    body: JSON.stringify({ filter: { property: '姓名', title: { contains: name } } }),
  });
  const data = await res.json();
  return data.results && data.results[0] ? data.results[0] : null;
}

async function handleLineWebhook(request, env) {
  try {
    const body = await request.json();
    const events = body.events || [];
    const ratingMap = { 'A': 'A — 馬上可用', 'B': 'B — 考慮中', 'C': 'C — 不考慮' };
    for (const event of events) {
      if (event.type !== 'message' || event.message.type !== 'text') continue;
      const text = event.message.text.trim();
      const replyToken = event.replyToken;
      // 只有直接 @Bot 本身才觸發（isSelf: true）
      const mentionees = event.message.mention?.mentionees || [];
      const botMentioned = mentionees.some(m => m.isSelf === true);
      if (!botMentioned) continue;
      // 移除 @提及 後解析指令
      const cleanText = text.replace(/@\S+/g, '').trim();

      // HR 指令：評分 王小明 A
      const ratingMatch = cleanText.match(/評分\s+(.+?)\s+([ABCabc])$/);
      if (ratingMatch) {
        const name = ratingMatch[1].trim();
        const rating = ratingMap[ratingMatch[2].toUpperCase()];
        if (!rating) { await replyLine(env.LINE_CHANNEL_TOKEN, replyToken, '❌ 評級請輸入 A、B 或 C'); continue; }
        const candidate = await searchCandidateByName(name, env);
        if (!candidate) { await replyLine(env.LINE_CHANNEL_TOKEN, replyToken, `❌ 找不到候選人：${name}`); continue; }
        await fetch(`https://api.notion.com/v1/pages/${candidate.id}`, {
          method: 'PATCH',
          headers: { 'Authorization': 'Bearer ' + env.HR_TOKEN, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
          body: JSON.stringify({ properties: { '評級': { select: { name: rating } } } }),
        });
        await replyLine(env.LINE_CHANNEL_TOKEN, replyToken, `✅ 已更新評分\n${name}：${rating}\n已同步至 Notion`);
        continue;
      }

      // HR 請假查詢指令
      if (cleanText === '今日請假') {
        const msg = await queryTodayLeave(env);
        await replyLine(env.LINE_CHANNEL_TOKEN, replyToken, msg);
        continue;
      }
      const leaveQueryMatch = cleanText.match(/^請假查詢\s+(.+)$/);
      if (leaveQueryMatch) {
        const msg = await queryLeaveByName(leaveQueryMatch[1].trim(), env);
        await replyLine(env.LINE_CHANNEL_TOKEN, replyToken, msg);
        continue;
      }

      // CRM 指令 → 轉發給 CRM Worker
      const crmCommands = ['客戶總覽', '跟進提醒'];
      const clientMatch = cleanText.match(/^客戶\s+(.+)$/);
      if (crmCommands.includes(cleanText) || clientMatch) {
        const args = clientMatch ? clientMatch[1].trim() : '';
        const command = clientMatch ? '客戶' : cleanText;
        const msg = await forwardToCRM(command, args, env);
        await replyLine(env.LINE_CHANNEL_TOKEN, replyToken, msg);
        continue;
      }

      // 未知指令 → 顯示說明
      await replyLine(env.LINE_CHANNEL_TOKEN, replyToken,
        '📋 可用指令：\n' +
        '【HR】\n・評分 姓名 A/B/C\n・今日請假\n・請假查詢 姓名\n' +
        '【CRM】\n・客戶總覽\n・客戶 客戶名稱\n・跟進提醒'
      );
    }
  } catch (e) {
    console.log('[LINE webhook error]', e.message);
  }
  return new Response('OK', { status: 200 });
}

// ── CRM 轉發 ─────────────────────────────────────────────────

async function forwardToCRM(command, args, env) {
  if (!env.CRM_WORKER_URL || !env.CRM_ACCESS_KEY) return '❌ CRM Worker 未設定，請聯絡管理員';
  try {
    const res = await fetch(`${env.CRM_WORKER_URL}/api/crm/line-query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Access-Key': env.CRM_ACCESS_KEY },
      body: JSON.stringify({ command, args }),
    });
    const data = await res.json();
    return data.message || '❌ CRM 回應錯誤';
  } catch (e) {
    return '❌ 無法連線至 CRM：' + e.message;
  }
}

// ── CRM LINE 查詢（舊版直連，已改為方案二轉發，保留備用）─────

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

async function lineCRMOverview(env, replyToken) {
  const clients = await crmNotionQuery(env, null, [{ property: '優先級', direction: 'descending' }]);
  if (!clients) { await replyLine(env.LINE_CHANNEL_TOKEN, replyToken, '❌ CRM 未設定，請聯絡管理員'); return; }
  if (clients.length === 0) { await replyLine(env.LINE_CHANNEL_TOKEN, replyToken, '📊 客戶總覽\n\n目前無客戶資料'); return; }
  const lines = clients.slice(0, 15).map(c => {
    const pr = c.properties;
    const name = pr['客戶名稱']?.title?.[0]?.plain_text || '（未命名）';
    const status = pr['潛在客戶狀態']?.select?.name || '';
    const priority = pr['優先級']?.select?.name || '';
    return `• ${name}${status ? '　' + status : ''}${priority ? '　' + priority : ''}`;
  });
  const total = clients.length;
  await replyLine(env.LINE_CHANNEL_TOKEN, replyToken,
    `📊 客戶總覽（共 ${total} 位）\n\n${lines.join('\n')}${total > 15 ? '\n…（更多請至 CRM 系統查看）' : ''}`
  );
}

async function lineCRMSearch(name, env, replyToken) {
  const clients = await crmNotionQuery(env, { property: '客戶名稱', title: { contains: name } }, null);
  if (!clients) { await replyLine(env.LINE_CHANNEL_TOKEN, replyToken, '❌ CRM 未設定，請聯絡管理員'); return; }
  if (clients.length === 0) { await replyLine(env.LINE_CHANNEL_TOKEN, replyToken, `❌ 找不到客戶：${name}`); return; }
  const pr = clients[0].properties;
  const clientName = pr['客戶名稱']?.title?.[0]?.plain_text || '（未命名）';
  const status = pr['潛在客戶狀態']?.select?.name || '—';
  const priority = pr['優先級']?.select?.name || '—';
  const nextDate = pr['下次跟進日期']?.date?.start || '—';
  const nextAction = pr['下一步行動']?.rich_text?.[0]?.plain_text || '—';
  const amount = pr['專案金額']?.number ? `NT$${pr['專案金額'].number.toLocaleString()}` : '—';
  const contact = pr['聯繫方式']?.rich_text?.[0]?.plain_text || '—';
  await replyLine(env.LINE_CHANNEL_TOKEN, replyToken,
    `👤 ${clientName}\n\n狀態：${status}\n優先級：${priority}\n下次跟進：${nextDate}\n下一步：${nextAction}\n金額：${amount}\n聯繫：${contact}`
  );
}

async function lineCRMFollowUp(env, replyToken) {
  const pad = n => String(n).padStart(2, '0');
  const now = new Date();
  const today = `${now.getUTCFullYear()}-${pad(now.getUTCMonth()+1)}-${pad(now.getUTCDate())}`;
  const nextWeek = new Date(now.getTime() + 7 * 86400000);
  const nextWeekStr = `${nextWeek.getUTCFullYear()}-${pad(nextWeek.getUTCMonth()+1)}-${pad(nextWeek.getUTCDate())}`;
  const clients = await crmNotionQuery(env, {
    and: [
      { property: '下次跟進日期', date: { on_or_after: today } },
      { property: '下次跟進日期', date: { on_or_before: nextWeekStr } },
    ]
  }, [{ property: '下次跟進日期', direction: 'ascending' }]);
  if (!clients) { await replyLine(env.LINE_CHANNEL_TOKEN, replyToken, '❌ CRM 未設定，請聯絡管理員'); return; }
  if (clients.length === 0) { await replyLine(env.LINE_CHANNEL_TOKEN, replyToken, '📅 跟進提醒\n\n本週無待跟進客戶 ✓'); return; }
  const lines = clients.map(c => {
    const pr = c.properties;
    const name = pr['客戶名稱']?.title?.[0]?.plain_text || '（未命名）';
    const date = pr['下次跟進日期']?.date?.start || '';
    const action = pr['下一步行動']?.rich_text?.[0]?.plain_text || '';
    return `• ${name}${date ? '　' + date : ''}${action ? '\n  → ' + action : ''}`;
  });
  await replyLine(env.LINE_CHANNEL_TOKEN, replyToken,
    `📅 本週跟進提醒（共 ${clients.length} 位）\n\n${lines.join('\n')}`
  );
}

async function handleLineNotify(request, env, origin) {
  if (!authCheck(request, env.HR_ACCESS_KEY)) {
    return errResponse('Unauthorized Access', origin, 401);
  }
  try {
    const { message } = await request.json();
    if (!message) return errResponse('message required', origin, 400);
    await sendLine(env.LINE_CHANNEL_TOKEN, env.LINE_GROUP_ID, message);
    return okResponse({ ok: true }, origin);
  } catch (e) {
    return errResponse('LINE notify error: ' + e.message, origin, 500);
  }
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
  if (pathname === '/api/hr/drive-upload') return handleDriveUpload(request, env, origin);
  if (pathname === '/api/hr/line/notify')   return handleLineNotify(request, env, origin);
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
        accounts: env.DB_ACCOUNTS,
      } : {};
      return okResponse({ ok: true, accessKey: system === 'hr' ? env.HR_ACCESS_KEY : null, dbIds }, origin);
    }
    return errResponse('密碼錯誤', origin, 401);
  } catch (e) {
    return errResponse('Invalid request', origin, 400);
  }
}

// ── HR 請假查詢 ───────────────────────────────────────────────

async function queryTodayLeave(env) {
  if (!env.HR_TOKEN || !env.DB_LEAVE) return '❌ 請假資料庫未設定';
  const pad = n => String(n).padStart(2, '0');
  const now = new Date();
  const today = `${now.getUTCFullYear()}-${pad(now.getUTCMonth()+1)}-${pad(now.getUTCDate())}`;
  const res = await fetch(`https://api.notion.com/v1/databases/${env.DB_LEAVE}/query`, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + env.HR_TOKEN, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filter: { and: [
        { property: '開始日期', date: { on_or_before: today } },
        { property: '結束日期', date: { on_or_after: today } },
      ]},
      sorts: [{ property: '開始日期', direction: 'ascending' }],
    }),
  });
  const data = await res.json();
  const records = data.results || [];
  if (records.length === 0) return `📅 今日請假（${today}）\n\n今日無人請假 ✓`;
  const lines = records.map(r => {
    const pr = r.properties;
    const name = pr['姓名']?.rich_text?.[0]?.plain_text || '未知';
    const type = pr['假別']?.select?.name || '';
    const days = pr['請假天數']?.number || '';
    return `• ${name}　${type}${days ? '　' + days + '天' : ''}`;
  });
  return `📅 今日請假（${today}）\n\n${lines.join('\n')}\n\n共 ${records.length} 人`;
}

async function queryLeaveByName(name, env) {
  if (!env.HR_TOKEN || !env.DB_LEAVE) return '❌ 請假資料庫未設定';
  const res = await fetch(`https://api.notion.com/v1/databases/${env.DB_LEAVE}/query`, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + env.HR_TOKEN, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filter: { property: '姓名', rich_text: { contains: name } },
      sorts: [{ property: '開始日期', direction: 'descending' }],
      page_size: 5,
    }),
  });
  const data = await res.json();
  const records = data.results || [];
  if (records.length === 0) return `❌ 找不到 ${name} 的請假記錄`;
  const lines = records.map(r => {
    const pr = r.properties;
    const type = pr['假別']?.select?.name || '';
    const start = pr['開始日期']?.date?.start || '';
    const end = pr['結束日期']?.date?.start || '';
    const days = pr['請假天數']?.number || '';
    const status = pr['審核狀態']?.select?.name || '';
    return `• ${start}${end && end !== start ? ' ～ ' + end : ''}　${type}${days ? ' ' + days + '天' : ''}　${status}`;
  });
  return `📋 ${name} 的請假記錄（最近 ${records.length} 筆）\n\n${lines.join('\n')}`;
}

// ── 每日面試通知 ──────────────────────────────────────────────

async function handleDailyInterview(env) {
  const token = env.LINE_CHANNEL_TOKEN;
  const groupId = env.LINE_GROUP_ID;
  if (!token || !groupId || !env.HR_TOKEN || !env.DB_INTERVIEW) return;

  const pad = n => String(n).padStart(2, '0');
  const now = new Date();
  const today = `${now.getUTCFullYear()}-${pad(now.getUTCMonth()+1)}-${pad(now.getUTCDate())}`;

  const res = await fetch(`https://api.notion.com/v1/databases/${env.DB_INTERVIEW}/query`, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + env.HR_TOKEN, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filter: { property: '面試日期', date: { equals: today } },
      sorts: [{ property: '面試日期', direction: 'ascending' }],
    }),
  });
  const data = await res.json();
  const records = data.results || [];
  if (records.length === 0) return; // 今日無面試，不推播

  const lines = records.map(r => {
    const pr = r.properties;
    const name     = pr['姓名']?.title?.[0]?.plain_text || '未知';
    const position = pr['應徵職務']?.select?.name || '';
    const stage    = pr['面試階段']?.select?.name || '';
    const manager  = pr['負責主管']?.rich_text?.[0]?.plain_text || '';
    return `• ${name}${position ? '（' + position + '）' : ''}　${stage}${manager ? '　@' + manager : ''}`;
  });
  await sendLine(token, groupId,
    `🗓️ 今日面試安排（${today}）\n\n${lines.join('\n')}\n\n共 ${records.length} 位候選人`
  );
}

// ── 每週一面試進度總覽 ────────────────────────────────────────

async function handleWeeklyInterview(env) {
  const token = env.LINE_CHANNEL_TOKEN;
  const groupId = env.LINE_GROUP_ID;
  if (!token || !groupId || !env.HR_TOKEN || !env.DB_INTERVIEW) return;

  const pad = n => String(n).padStart(2, '0');
  const now = new Date();
  const today = `${now.getUTCFullYear()}-${pad(now.getUTCMonth()+1)}-${pad(now.getUTCDate())}`;

  // 查詢尚未完成的候選人（不含「評分完成」）
  const res = await fetch(`https://api.notion.com/v1/databases/${env.DB_INTERVIEW}/query`, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + env.HR_TOKEN, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filter: {
        or: [
          { property: '面試階段', select: { equals: '約面試' } },
          { property: '面試階段', select: { equals: '筆試' } },
          { property: '面試階段', select: { equals: '主管面試' } },
        ]
      },
      sorts: [{ property: '應徵時間', direction: 'ascending' }],
    }),
  });
  const data = await res.json();
  const records = data.results || [];
  if (records.length === 0) {
    await sendLine(token, groupId, `📋 本週面試進度（${today}）\n\n目前無進行中的面試候選人 ✓`);
    return;
  }

  const lines = records.map(r => {
    const pr = r.properties;
    const name     = pr['姓名']?.title?.[0]?.plain_text || '未知';
    const position = pr['應徵職務']?.select?.name || '';
    const stage    = pr['面試階段']?.select?.name || '';
    const date     = pr['面試日期']?.date?.start || '';
    return `• ${name}${position ? '（' + position + '）' : ''}　${stage}${date ? '　' + date : ''}`;
  });
  await sendLine(token, groupId,
    `📋 本週面試進度（${today}）\n共 ${records.length} 位候選人進行中\n\n${lines.join('\n')}`
  );
}

// ── 每日請假通知 ──────────────────────────────────────────────

async function handleDailyLeave(env) {
  const token = env.LINE_CHANNEL_TOKEN;
  const groupId = env.LINE_GROUP_ID;
  const notionToken = env.HR_TOKEN;
  const dbId = env.DB_LEAVE;
  if (!token || !groupId || !notionToken || !dbId) return;

  const pad = n => String(n).padStart(2, '0');
  const now = new Date();
  const today = `${now.getUTCFullYear()}-${pad(now.getUTCMonth()+1)}-${pad(now.getUTCDate())}`;

  const res = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + notionToken,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      filter: {
        and: [
          { property: '開始日期', date: { on_or_before: today } },
          { property: '結束日期', date: { on_or_after: today } },
        ]
      },
      sorts: [{ property: '開始日期', direction: 'ascending' }],
    }),
  });

  const data = await res.json();
  const records = data.results || [];

  let message;
  if (records.length === 0) {
    message = `📅 今日請假通知（${today}）\n\n今日無人請假 ✓`;
  } else {
    const lines = records.map(r => {
      const pr = r.properties;
      const name = pr['姓名']?.rich_text?.[0]?.plain_text || '未知';
      const type = pr['假別']?.select?.name || '';
      const days = pr['請假天數']?.number || '';
      return `• ${name}　${type}${days ? '　' + days + '天' : ''}`;
    });
    message = `📅 今日請假通知（${today}）\n\n${lines.join('\n')}\n\n共 ${records.length} 人請假`;
  }

  await sendLine(token, groupId, message);
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

    if (pathname === '/api/auth')              return handleAuth(request, env, origin);
    if (pathname.startsWith('/api/hr/'))       return handleHR(request, env, pathname, origin);
    if (pathname === '/api/gemini')            return handleGemini(request, env, origin);
    if (pathname === '/api/line/webhook')      return handleLineWebhook(request, env);

    return errResponse('Route not found', origin, 404);
  },

  async scheduled(event, env, ctx) {
    // 轉換成台灣時間 UTC+8 再判斷星期幾（0=週日, 6=週六）
    const taiwanDay = new Date(Date.now() + 8 * 60 * 60 * 1000).getUTCDay();
    if (taiwanDay === 0 || taiwanDay === 6) return;

    // 每天：請假通知 + 今日面試提醒
    ctx.waitUntil(handleDailyLeave(env));
    ctx.waitUntil(handleDailyInterview(env));

    // 每週一：面試進度週報
    if (taiwanDay === 1) {
      ctx.waitUntil(handleWeeklyInterview(env));
    }
  },
};
