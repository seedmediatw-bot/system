/**
 * HR 系統 API 代理 - Cloudflare Worker
 *
 * 部署步驟：
 * 1. 前往 https://workers.cloudflare.com/ 登入（免費帳號即可）
 * 2. 點「Create a Worker」
 * 3. 把這個檔案的內容全部貼上去，取代原本的程式碼
 * 4. 點「Save and Deploy」
 * 5. 記下你的 Worker URL（格式：https://hr-proxy.你的名稱.workers.dev）
 * 6. 進入 Worker 的「Settings」→「Variables」，新增：
 *      NOTION_TOKEN   = 你的 ntn_xxxx token
 *      GEMINI_API_KEY = 你的 AIza... key（前往 aistudio.google.com/apikey 取得）
 * 7. 在 hr-app.html 的 API_BASE 變數填入你的 Worker URL
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-notion-token, x-gemini-key',
  'Access-Control-Max-Age': '86400',
};

export default {
  async fetch(request, env) {
    // 處理 CORS 預檢請求
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    // ── 狀態查詢 ──────────────────────────────────────────
    if (url.pathname === '/api/status') {
      return Response.json(
        { ok: true, notion: !!env.NOTION_TOKEN, gemini: !!env.GEMINI_API_KEY },
        { headers: corsHeaders }
      );
    }

    // ── Notion API 代理 ────────────────────────────────────
    if (url.pathname.startsWith('/api/notion/')) {
      const notionPath = '/v1/' + url.pathname.replace('/api/notion/', '');
      const token = env.NOTION_TOKEN || request.headers.get('x-notion-token');

      if (!token) {
        return Response.json(
          { error: '請設定 NOTION_TOKEN 環境變數' },
          { status: 401, headers: corsHeaders }
        );
      }

      const notionRes = await fetch('https://api.notion.com' + notionPath, {
        method: request.method,
        headers: {
          'Authorization': 'Bearer ' + token,
          'Notion-Version': '2022-06-28',
          'Content-Type': 'application/json',
        },
        body: request.method !== 'GET' ? request.body : undefined,
      });

      const data = await notionRes.text();
      return new Response(data, {
        status: notionRes.status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ── Notion 圖片上傳 ───────────────────────────────────
    if (url.pathname === '/api/notion-upload') {
      const token = env.NOTION_TOKEN || request.headers.get('x-notion-token');
      if (!token) {
        return Response.json({ error: '請設定 NOTION_TOKEN' }, { status: 401, headers: corsHeaders });
      }
      const { base64, mimeType, filename } = await request.json();

      // Step 1：向 Notion 申請上傳位置
      const createRes = await fetch('https://api.notion.com/v1/files', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + token,
          'Notion-Version': '2022-06-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: filename || 'receipt.jpg', content_type: mimeType || 'image/jpeg' }),
      });
      if (!createRes.ok) {
        const err = await createRes.text();
        return new Response(err, { status: createRes.status, headers: corsHeaders });
      }
      const fileUpload = await createRes.json();

      // Step 2：上傳二進位資料到簽署 URL
      const binary = Uint8Array.from(atob(base64), function(c) { return c.charCodeAt(0); });
      const uploadRes = await fetch(fileUpload.upload_url, {
        method: 'PUT',
        headers: { 'Content-Type': mimeType || 'image/jpeg' },
        body: binary,
      });
      if (!uploadRes.ok) {
        return Response.json({ error: '圖片上傳失敗' }, { status: uploadRes.status, headers: corsHeaders });
      }

      return Response.json({ id: fileUpload.id }, { headers: corsHeaders });
    }

    // ── Gemini API 代理 ───────────────────────────────────
    if (url.pathname === '/api/gemini') {
      try {
        // 支援多種變數名稱命名方式（GEMINI_API_KEY 或 gemini api）
        const apiKey = env.GEMINI_API_KEY || env.gemini_api || env['gemini api'] || request.headers.get('x-gemini-key');
        if (!apiKey) {
          return new Response(JSON.stringify({ error: '找不到金鑰，請確認 Worker 環境變數名稱為 GEMINI_API_KEY' }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        const body = await request.json();
        const model = body.model || 'gemini-2.0-flash';
        
        // 移除 body 中的 model 欄位，避免 Google API 報錯
        if (body.model) delete body.model;

        const geminiRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }
        );

        const data = await geminiRes.text();
        return new Response(data, {
          status: geminiRes.status,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: 'Worker 內部錯誤: ' + err.message }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
    }

    return new Response('Not found', { status: 404, headers: corsHeaders });
  },
};
