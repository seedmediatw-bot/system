# HR 自動化系統

公司內部 HR 自助系統，支援請假申請、報帳申請、員工入職、員工簽到、審核追蹤。資料即時同步至 Notion，無需後端伺服器即可上線。

---

## 🌐 線上網址

| 服務 | 網址 |
|---|---|
| **HR 系統（前台）** | https://seedmediatw-bot.github.io/HR-SYSTEM |
| **Cloudflare Worker（API 代理）** | https://shy-sun-7610.seedmediatw.workers.dev |
| **Worker 健康檢查** | https://shy-sun-7610.seedmediatw.workers.dev/api/status |

> 登入密碼：8 位數（請洽系統管理員）

---

## 🏗️ 系統架構

```
使用者（瀏覽器）
    │  輸入密碼後進入
    ↓
GitHub Pages（index.html，靜態網頁）
    │  送出表單 / 查詢資料
    ↓
Cloudflare Worker（API 代理，隱藏 API 金鑰）
    │
    ├─→ Notion API（儲存 HR 資料）
    └─→ Claude API（AI 助理，選用）
```

---

## 📁 檔案說明

| 檔案 | 用途 |
|---|---|
| `index.html` | **主要檔案**，整個 HR 系統的 UI + 邏輯（唯一需要更新的前端檔案） |
| `cloudflare-worker.js` | Cloudflare Worker 程式碼（本機備存，更新需手動貼到 Cloudflare） |
| `server.js` | 本機測試用代理伺服器（不會上傳到 GitHub） |
| `.env` | API 金鑰（不可上傳！已列入 .gitignore） |
| `.github/workflows/deploy.yml` | GitHub Actions 自動部署設定 |
| `教學文件.md` | 完整建置步驟與 AI 指令紀錄 |

---

## 🗄️ Notion 資料庫

所有資料儲存於 Notion，Database ID 設定在 `index.html` 的 `nDBs` 物件：

| 資料庫 | ID |
|---|---|
| 📅 請假申請 | `6846115f39e341a69c8c771f5e229c7c` |
| 💰 報帳申請 | `2f1e0e588b6a47c1b89d1392eca5272f` |
| 👥 員工資料庫 | `b1ba6f957a114a828da1b7018949114d` |
| ✅ 審核記錄 | `f3f9a9bcc4a9447fb9623723952e33b2` |
| 🕐 員工簽到記錄 | `2c99853a8c8c477aac90d188ad2362ce` |

---

## 🔧 日常維護

### 更新網頁內容

修改 `index.html` 後執行：

```bash
git add index.html
git commit -m "說明本次修改內容"
git push
```

GitHub Pages 約 1-2 分鐘後自動更新。

---

### 更改登入密碼

1. 開啟 `index.html`
2. 搜尋現有密碼數字
3. 替換成新密碼（8 位數）
4. 存檔後執行上方的 git push

---

### 更新 Cloudflare Worker

1. 前往 [Cloudflare Dashboard](https://dash.cloudflare.com) → Workers & Pages
2. 選擇 `shy-sun-7610` → 點「Edit Code」
3. 貼上 `cloudflare-worker.js` 最新內容
4. 點「Save and Deploy」

---

### 新增 / 修改 Notion 欄位

1. 在 Notion 資料庫新增欄位
2. 在 `index.html` 找到對應的 `build___Props()` 函數，補上新欄位
3. 視需要在表單 HTML 加入對應輸入框
4. git push 更新

---

### 本機測試

```bash
cd "C:\Users\seedm\OneDrive\桌面\HR"
npm install        # 第一次才需要
node server.js     # 啟動於 http://localhost:3000
```

確認 `.env` 已填入：
```
NOTION_TOKEN=ntn_...
CLAUDE_API_KEY=sk-ant-...（選填）
PORT=3000
```

---

## 🔑 金鑰管理

| 金鑰 | 存放位置 |
|---|---|
| Notion Token | Cloudflare Worker → Settings → Variables → `NOTION_TOKEN` |
| Claude API Key | Cloudflare Worker → Settings → Variables → `CLAUDE_API_KEY` |
| 本機測試 | `.env` 檔案（本機，不上傳） |

> ⚠️ **`.env` 已列入 `.gitignore`，絕對不會被上傳到 GitHub。**  
> GitHub 上看到的 `index.html` 不含任何金鑰，金鑰只存在 Cloudflare。

---

## 🆘 常見問題

| 問題 | 解法 |
|---|---|
| 網頁白畫面 / 404 | 確認 GitHub Pages Source 設為「GitHub Actions」|
| Notion 連線失敗 | 確認 Cloudflare Worker 的 `NOTION_TOKEN` 已設定 |
| 按鈕沒有反應 | 重新整理頁面；或確認網頁是透過 https:// 開啟 |
| 審核追蹤沒資料 | 點「↻ 重新整理」，確認 Notion 資料庫已有資料 |
| 推送 GitHub 失敗 | 確認 Git 帳號設定正確，或重新設定 remote |

---

## 📖 完整建置教學

詳見 [`教學文件.md`](./教學文件.md)，包含所有 AI 對話指令與逐步操作說明。
