# 種子創意 · 內部系統

公司內部 HR 與 CRM 雙核心系統，支援請假申請、報帳申請（含 AI 發票辨識）、員工入職、員工簽到、主管審核，以及 **AI 驅動的客戶關係管理 (CRM)**。資料即時同步至 Notion，無需後端伺服器即可上線。

---

## 🏗️ 系統架構

```
使用者（瀏覽器）
    │  選擇系統（HR / CRM）→ 輸入密碼
    ↓
GitHub Pages（index.html，靜態網頁）
    │
    ├─→ HR API 請求（附 X-Access-Key）
    │       ↓
    │   HR Worker（shy-sun-7610）
    │       ├─→ /api/auth     密碼驗證，回傳 HR Access Key + DB IDs
    │       ├─→ /api/hr/*     HR 系統 Notion 代理
    │       └─→ /api/gemini   Gemini AI 代理
    │
    └─→ CRM API 請求（附 X-Access-Key）
            ↓
        CRM Worker（round-brook-f2a3）
            ├─→ /api/auth     密碼驗證，回傳 CRM Access Key + DB IDs
            ├─→ /api/crm/*    CRM 系統 Notion 代理
            └─→ /api/gemini   Gemini AI 代理
```

---

## 📁 檔案說明

| 檔案 | 用途 |
|---|---|
| `index.html` | **核心檔案**，整合 HR 與 CRM 的 UI + 邏輯 |
| `hr-worker.js` | HR 系統 Cloudflare Worker（部署到 Cloudflare 後才生效） |
| `crm-worker.js` | CRM 系統 Cloudflare Worker（部署到 Cloudflare 後才生效） |
| `README.md` | 本系統說明文件 |
| `.gitignore` | 設定上傳規則 |

---

## 🔐 登入流程

```
首頁（系統選擇）
    ├─→ HR 自動化系統  → 輸入 HR 密碼  → 進入 HR
    └─→ 客戶關係管理   → 輸入 CRM 密碼 → 進入 CRM
```

- 密碼儲存於 Cloudflare Worker 環境變數，不在前端程式碼中
- 登入成功後，Worker 自動回傳對應 Access Key，無需使用者手動設定
- 管理員設定頁：側邊欄右下角小圖示 → 輸入管理員密碼 → 進入

---

## 🗄️ Notion 資料庫

### HR 相關

| 資料庫 | 說明 |
|---|---|
| 請假申請 | 員工請假記錄 |
| 報帳申請 | 費用報帳，含 AI 發票辨識 |
| 員工資料庫 | 入職資料 |
| 員工簽到記錄 | 每日簽到 |

### CRM 相關

| 資料庫 | 說明 |
|---|---|
| CRM 客戶總覽 | 客戶主檔，含狀態、優先級、跟進日期 |
| 拜訪記錄 | 每次拜訪的詳細紀錄 |

> 資料庫 ID 請在管理員設定面板中填入，不在此公開紀錄。

---

## ✨ 主要功能

### HR 模組

**請假申請** — 填寫假別、日期、天數、原因，一鍵同步 Notion

**報帳申請**
- 新增多筆費用明細，自動計算合計
- **一般模式**：即時拍照或從相簿選取收據，縮圖預覽後一起送出
- **AI 辨識模式**：Gemini 自動辨識金額、日期、費用類別並填入；支援台灣統一發票（QR Code 解讀）

**員工入職** — 填寫基本資料、緊急聯絡人，自動建立員工頁面

**員工簽到** — 紀錄上下班時間，同步至 Notion

**儀表板** — 即時顯示本月請假數、待審報帳、在職員工數、本週簽到數

**審核追蹤** — 主管可直接核准或駁回，即時更新 Notion 審核狀態

### CRM 模組

**客戶總覽** — 列出所有客戶狀態、優先級、下次跟進日期，點擊客戶開啟詳情彈窗

**新增 / 更新客戶** — 上傳名片或會議記錄照片，Gemini 自動擷取客戶資訊

**拜訪記錄** — 支援圖片上傳 AI 分析，新增後自動回填至客戶主檔

**AI 助理** — 內嵌 Gemini 對話，協助操作系統、回答問題

---

## 🔑 Cloudflare Worker 環境變數

### HR Worker（hr-worker.js）

| 變數 | 用途 |
|---|---|
| `HR_PASSWORD` | HR 系統登入密碼 |
| `ADMIN_PASSWORD` | 管理員設定頁密碼 |
| `HR_ACCESS_KEY` | HR API 呼叫驗證密鑰 |
| `HR_TOKEN` | Notion Integration Token |
| `GEMINI_API_KEY` | Google AI Studio API Key |
| `DB_LEAVE` | 請假申請資料庫 ID |
| `DB_EXPENSE` | 報帳申請資料庫 ID |
| `DB_EMPLOYEES` | 員工資料庫 ID |
| `DB_APPROVALS` | 審核記錄資料庫 ID |
| `DB_CHECKIN` | 員工簽到記錄資料庫 ID |
| `DB_ACCOUNTS` | 帳號管理資料庫 ID |

### CRM Worker（crm-worker.js）

| 變數 | 用途 |
|---|---|
| `CRM_PASSWORD` | CRM 系統登入密碼 |
| `ADMIN_PASSWORD` | 管理員設定頁密碼 |
| `CRM_ACCESS_KEY` | CRM API 呼叫驗證密鑰 |
| `CRM_TOKEN` | Notion Integration Token |
| `GEMINI_API_KEY` | Google AI Studio API Key |
| `DB_CRM` | CRM 客戶資料庫 ID |
| `DB_CALL` | 拜訪記錄資料庫 ID |

> ⚠️ **安全性**：GitHub 上不含任何密碼或金鑰，所有敏感資訊均儲存於 Cloudflare 環境變數。

---

## 🚀 部署教學

### 1. Fork / Clone 此 Repo

```bash
git clone https://github.com/seedmediatw-bot/system.git
```

### 2. 開啟 GitHub Pages

1. 進入 GitHub → Settings → Pages
2. Source 選 `Deploy from a branch`
3. Branch 選 `main` / `/ (root)`
4. 儲存，約 1 分鐘後上線

### 3. 部署 Cloudflare Worker（需部署兩個）

**HR Worker**
1. 前往 [workers.cloudflare.com](https://workers.cloudflare.com/) 登入
2. 點「Create a Worker」→「Start with Hello World!」，命名為 `hr-worker`
3. 進入 Edit code，把 `hr-worker.js` 內容全部貼上，Deploy
4. 進入 Settings → Variables，新增 HR Worker 所需的所有環境變數

**CRM Worker**
1. 同上步驟，命名為 `crm-worker`
2. 進入 Edit code，把 `crm-worker.js` 內容全部貼上，Deploy
3. 進入 Settings → Variables，新增 CRM Worker 所需的所有環境變數

### 4. 設定 Notion Integration

1. 前往 [notion.so/my-integrations](https://www.notion.so/my-integrations) 建立 Integration
2. Capabilities 確認勾選：Read content、Update content、Insert content
3. 複製 Token，填入 `HR_TOKEN` 與 `CRM_TOKEN`
4. 在每個 Notion 資料庫頁面點 `...` → `Connect to` → 選擇你的 Integration

### 5. 管理員初次設定

1. 開啟系統網頁
2. 點側邊欄右下角小齒輪圖示，輸入管理員密碼
3. 填入 Worker URL 與各資料庫 ID，儲存

---

## 🔧 日常維護

```bash
git add index.html README.md
git commit -m "說明本次修改內容"
git push
```

> `index.html` 推上去後 GitHub Pages 會自動更新（約 1 分鐘）。
> `cloudflare-worker.js` 需手動貼到 Cloudflare Workers 後台才生效。

---

## 🆘 常見問題

| 問題 | 解法 |
|---|---|
| 登入後顯示「無法連線」 | 確認已部署最新 Worker 程式碼，且環境變數已設定 |
| 讀取失敗 / 資料庫 not found | 確認 Notion 資料庫已連接 Integration（點 `...` → Connect to）|
| AI 功能沒反應 | 確認 `GEMINI_API_KEY` 已設定（需從 AI Studio 取得，非 Google Cloud）|
| 審核按鈕點了沒反應 | 確認 Worker 的 CORS 設定包含 `PATCH` 方法 |
| 網頁白畫面 | 確認 GitHub Pages 已啟用，分支設定為 main |

---

## 🗺️ 開發計畫

- [ ] 收據圖片自動上傳（Cloudflare R2 串接）
- [ ] LINE Bot / Email 審核通知
- [ ] CRM 數據視覺化（拜訪頻率與客戶分佈統計圖表）
