require('dotenv').config();
const express  = require('express');
const https    = require('https');
const path     = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '5mb' }));

// ── 靜態檔案：提供 hr-app.html ─────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── 狀態查詢：前端可確認伺服器是否啟動 ──────────────────
app.get('/api/status', (req, res) => {
  res.json({
    ok: true,
    notion: !!process.env.NOTION_TOKEN,
    claude: !!process.env.CLAUDE_API_KEY,
  });
});

// ── Notion API 代理 ──────────────────────────────────────
//  前端送 x-notion-token header（從 localStorage 讀取），
//  伺服器優先使用 .env 中的 NOTION_TOKEN；若未設定則使用前端傳入的值。
app.all('/api/notion/*', (req, res) => {
  // 取得 token：優先使用 .env，但排除預設的「請填入」文字
  let token = process.env.NOTION_TOKEN;
  if (!token || token.includes('請填入')) {
    token = req.headers['x-notion-token'];
  }
  
  if (!token || token.includes('xxxxxxxx')) {
    return res.status(401).json({ error: '尚未設定金鑰。請在 .env 填寫或在設定頁面輸入。' });
  }

  // 把 /api/notion/xxx 轉成 /v1/xxx
  const notionPath = '/v1' + req.path.replace(/^\/api\/notion/, '');
  const method     = req.method;
  const bodyStr    = Object.keys(req.body || {}).length ? JSON.stringify(req.body) : null;

  const options = {
    hostname : 'api.notion.com',
    port     : 443,
    path     : notionPath,
    method   : method,
    headers  : {
      'Authorization'  : 'Bearer ' + token,
      'Notion-Version' : '2022-06-28',
      'Content-Type'   : 'application/json',
    },
  };
  if (bodyStr) options.headers['Content-Length'] = Buffer.byteLength(bodyStr);

  const proxyReq = https.request(options, (proxyRes) => {
    res.status(proxyRes.statusCode);
    res.setHeader('Content-Type', 'application/json');
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (e) => {
    console.error('[Notion Proxy Error]', e.message);
    res.status(502).json({ error: '無法連線至 Notion API：' + e.message });
  });

  if (bodyStr) proxyReq.write(bodyStr);
  proxyReq.end();
});

// ── Claude API 代理 ──────────────────────────────────────
app.post('/api/claude', (req, res) => {
  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: '請在 .env 設定 CLAUDE_API_KEY。' });
  }

  // 使用已知可用的 model
  const payload = {
    ...req.body,
    model: req.body.model || 'claude-3-5-haiku-20241022',
  };
  const bodyStr = JSON.stringify(payload);

  const options = {
    hostname : 'api.anthropic.com',
    port     : 443,
    path     : '/v1/messages',
    method   : 'POST',
    headers  : {
      'x-api-key'         : apiKey,
      'anthropic-version' : '2023-06-01',
      'Content-Type'      : 'application/json',
      'Content-Length'    : Buffer.byteLength(bodyStr),
    },
  };

  const proxyReq = https.request(options, (proxyRes) => {
    let data = '';
    proxyRes.on('data', (chunk) => (data += chunk));
    proxyRes.on('end', () => {
      try {
        res.status(proxyRes.statusCode).json(JSON.parse(data));
      } catch {
        res.status(proxyRes.statusCode).send(data);
      }
    });
  });

  proxyReq.on('error', (e) => {
    console.error('[Claude Proxy Error]', e.message);
    res.status(502).json({ error: '無法連線至 Claude API：' + e.message });
  });

  proxyReq.write(bodyStr);
  proxyReq.end();
});

// ── 啟動 ─────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════╗');
  console.log('║        HR 系統代理伺服器啟動          ║');
  console.log('╠══════════════════════════════════════╣');
  console.log(`║  開啟瀏覽器前往：                    ║`);
  console.log(`║  http://localhost:${PORT}              ║`);
  console.log('╠══════════════════════════════════════╣');
  console.log(`║  Notion Token : ${process.env.NOTION_TOKEN   ? '✓ 已設定' : '✗ 未設定（請填 .env）'}`);
  console.log(`║  Claude Key   : ${process.env.CLAUDE_API_KEY ? '✓ 已設定' : '✗ 未設定（請填 .env）'}`);
  console.log('╚══════════════════════════════════════╝');
  console.log('');
});
