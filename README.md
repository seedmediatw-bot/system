# HR & CRM 整合自動化系統

公司內部 HR 與 CRM 雙核心系統，支援請假申請、報帳申請（含收據拍照上傳）、員工入職、員工簽到、主管審核，以及 **AI 驅動的客戶關係管理 (CRM)**。資料即時同步至 Notion，無需後端伺服器即可上線。

---

---

## 🏗️ 系統架構

```
使用者（瀏覽器）
    │  輸入密碼後進入
    ↓
GitHub Pages（index.html，靜態網頁）
    │  送出表單 / 查詢資料 / 上傳圖片
    ↓
Cloudflare Worker（API 代理，隱藏 API 金鑰）
    │
    ├─→ Notion API（儲存 HR & CRM 資料）
    └─→ Gemini API（AI 發票辨識、AI 助理、CRM 智慧分析）
```

---

## 📁 檔案說明

| 檔案 | 用途 |
|---|---|
| `index.html` | **核心檔案**，整合 HR 與 CRM 的 UI + 邏輯 |
| `cloudflare-worker.js` | Cloudflare Worker 程式碼（部署到 Cloudflare 後才生效） |
| `README.md` | 本系統說明文件 |
| `.gitignore` | 設定上傳規則 |

---

## 🗄️ Notion 資料庫設定

所有資料儲存於 Notion。設定位於網頁左下角的「Notion 設定」面板。

### HR 相關資料庫

| 資料庫 | 說明 |
|---|---|
| 請假申請 | 員工請假記錄 |
| 報帳申請 | 費用報帳，含收據圖片欄位 |
| 員工資料庫 | 入職資料 |
| 員工簽到記錄 | 每日簽到 |

### CRM 相關資料庫

| 資料庫 | 說明 |
|---|---|
| CRM 客戶總覽 | 客戶主檔，含狀態、優先級、跟進日期 |
| 拜訪記錄 | 每次拜訪的詳細紀錄 |

> 資料庫 ID 請在系統的「Notion 設定」面板中查看與填入，不在此公開紀錄。

---

## ✨ 主要功能

### HR 模組

**請假申請**
- 填寫假別、日期、天數、原因，一鍵同步 Notion

**報帳申請**
- 新增多筆費用明細，自動計算合計
- **一般模式**：即時拍照或從相簿選取收據，縮圖預覽後一起送出
- **AI 辨識模式**：拍照後 Gemini 自動辨識金額、日期、費用類別並填入表單
- Notion 報帳資料庫設有「收據圖片」欄位，可手動附加或待自動上傳功能完成後自動填入

**員工入職**
- 填寫基本資料、緊急聯絡人，自動建立員工頁面

**員工簽到**
- 紀錄上下班時間，同步至 Notion

**儀表板**
- 即時顯示本月請假數、待審報帳、在職員工數、本週簽到數

**審核追蹤**
- 列出所有請假與報帳申請，顯示審核進度時間軸
- 主管可直接點擊「✓ 核准」或「✗ 駁回」，即時更新 Notion 審核狀態
- 可依部門、狀態、類型篩選

### CRM 模組

**客戶總覽**
- 列出所有客戶狀態、優先級、下次跟進日期
- 點擊客戶開啟詳情彈窗，查看歷史拜訪時間軸

**新增 / 更新客戶**
- **圖片上傳 + AI 分析**：上傳名片、LINE 截圖、會議記錄照片，Gemini 自動擷取客戶名稱、金額、狀態、下一步行動等欄位
- 支援文字貼上與圖片同時分析

**拜訪記錄**
- 支援圖片上傳 AI 分析
- 新增記錄後自動回填至客戶主檔

**AI 助理**
- 內嵌 Gemini 對話，協助操作系統、回答問題

---

## 🔑 金鑰管理

| 金鑰 | 存放位置 |
|---|---|
| **Notion Token** | Cloudflare Worker → Settings → Variables → `NOTION_TOKEN` |
| **Gemini API Key** | Cloudflare Worker → Settings → Variables → `GEMINI_API_KEY` |

> ⚠️ **安全性**：GitHub 上不含任何 API 金鑰。所有金鑰均儲存於 Cloudflare 環境變數。

---

## 🚀 部署教學

### 第一次部署

#### 1. Fork / Clone 此 Repo

```bash
git clone https://github.com/seedmediatw-bot/CRM-HR.git
```

#### 2. 開啟 GitHub Pages

1. 進入 GitHub → Settings → Pages
2. Source 選 `Deploy from a branch`
3. Branch 選 `main` / `/ (root)`
4. 儲存，約 1 分鐘後上線

#### 3. 部署 Cloudflare Worker

1. 前往 [workers.cloudflare.com](https://workers.cloudflare.com/) 登入
2. 點「Create a Worker」
3. 把 `cloudflare-worker.js` 的內容全部貼上，取代預設程式碼
4. 點「Save and Deploy」
5. 記下 Worker URL（格式：`https://xxx.workers.dev`）
6. 進入 Worker → Settings → Variables，新增兩個環境變數：
   - `NOTION_TOKEN` = `ntn_xxxx`（Notion Integration Token）
   - `GEMINI_API_KEY` = `AIza...`（[aistudio.google.com](https://aistudio.google.com/apikey) 取得）

#### 4. 設定 Notion Integration

1. 前往 [notion.so/my-integrations](https://www.notion.so/my-integrations) 建立 Integration
2. Capabilities 確認勾選：Read content、Update content、Insert content
3. 複製 Token，填入 Cloudflare Worker 環境變數
4. 在每個 Notion 資料庫頁面點 `...` → `Connect to` → 選擇你的 Integration

#### 5. 在系統內設定

1. 開啟系統網頁，進入「Notion 設定」
2. 填入 Worker URL、Notion Token、各資料庫 ID
3. 點「測試連線」確認正常

---

## 🔧 日常維護

### 更新程式碼

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
| 讀取失敗 / 資料庫 not found | 確認 Notion 資料庫已連接 Integration（點 `...` → Connect to） |
| AI 功能沒反應 | 確認 Cloudflare Worker 的 `GEMINI_API_KEY` 已設定 |
| 審核按鈕點了沒反應 | 確認 Cloudflare Worker 的 CORS 設定包含 `PATCH` 方法 |
| 網頁白畫面 | 確認 GitHub Pages 已啟用，分支設定為 main |
| 設定無法儲存 | 確認瀏覽器未使用無痕模式（LocalStorage 被封鎖） |

---

## 🗺️ 開發計畫

- [ ] 收據圖片自動上傳（Cloudflare R2 串接）
- [ ] LINE Bot / Email 審核通知（送審通知主管、核准駁回通知申請人）
- [ ] CRM 數據視覺化（拜訪頻率與客戶分佈統計圖表）
- [ ] Google Drive 發票同步備份
