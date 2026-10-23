// 把 public/ 的網頁檔嵌進 src/worker.js，產生可直接貼進 Cloudflare 的 dist/worker.js
const fs = require('node:fs');
const path = require('node:path');

const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8' };
const pub = path.join(__dirname, 'public');
const assets = {};
for (const f of fs.readdirSync(pub)) {
  const type = types[path.extname(f)];
  if (!type) throw new Error('不支援的檔案類型：' + f);
  assets['/' + f] = { type, body: fs.readFileSync(path.join(pub, f), 'utf8').replace(/\r\n/g, '\n') };
}
const src = fs.readFileSync(path.join(__dirname, 'src', 'worker.js'), 'utf8');
const marker = /\/\*ASSETS\*\/\{\}\/\*END_ASSETS\*\//;
if (!marker.test(src)) throw new Error('worker.js 找不到 ASSETS 標記');
const out = src.replace(marker, () => JSON.stringify(assets));
fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'dist', 'worker.js'), out);
console.log('built dist/worker.js', out.length, 'bytes,', Object.keys(assets).length, 'assets');
