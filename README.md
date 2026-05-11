# HR & CRM 整合自動化系統

公司內部 HR 與 CRM 雙核心系統，支援請假申請、報帳申請、員工入職、員工簽到、審核追蹤，以及 **AI 驅動的客戶關係管理 (CRM)**。資料即時同步至 Notion，無需後端伺服器即可上線。

---

## 🌐 線上網址

| 服務 | 網址 |
11: | **HR & CRM 系統（整合版）** | https://seedmediatw-bot.github.io/CRM-HR |
12: | **Cloudflare Worker（API 代理）** | https://shy-sun-7610.seedmediatw.workers.dev |
13: | **Worker 健康檢查** | https://shy-sun-7610.seedmediatw.workers.dev/api/status |

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
    ├─→ Notion API（儲存 HR & CRM 資料）
    └─→ Gemini API（AI 辨識、AI 助理、CRM 智慧分析）
```

---

## 📁 檔案說明

| 檔案 | 用途 |
|---|---|
| `index.html` | **核心檔案**，整合 HR 與 CRM 的 UI + 邏輯（主要更新對象） |
| `README.md` | 本系統說明文件 |
| `.gitignore` | 設定僅上傳完成版檔案（目前僅上傳 index.html 與 README.md） |
| `cloudflare-worker.js` | Cloudflare Worker 程式碼備份 |
| `.env` | API 金鑰（本地測試用，不予上傳） |

---

## 🗄️ Notion 資料庫設定

所有資料儲存於 Notion。設定位於網頁左下角的「Notion 設定」面板中，並儲存於瀏覽器 LocalStorage。

### HR 相關資料庫
- **請假申請**
- **報帳申請**
- **員工資料庫**
- **審核記錄**
- **員工簽到記錄**

### CRM 相關資料庫
- **CRM 客戶總覽**：`3568bb31aaa281bcb7b1f4550e01795c`
- **拜訪記錄**：`d68816abcca34320b8e3fcba1029299e`

---

## 🚀 CRM 模組特色

### 1. 一站式客戶詳情彈窗 (Modal)
- **歷史時光機**：自動從 Notion 抓取該客戶的所有歷史拜訪紀錄，並以時間軸方式呈現。
- **快速更新**：在同一個介面即可編輯客戶狀態、優先級與下一步行動。
- **即時同步**：新增拜訪紀錄後，系統會自動回填至客戶主檔並重新整理歷史清單。

### 2. Google Drive 智慧連動 (開發完成，暫時隱藏)
- **自動搜尋**：一鍵開啟該客戶在 Google Drive 的所有相關簡報與文件。
- **零資料輸入**：系統會自動根據客戶名稱發起搜尋請求，無需手動管理連結。
- *(註：目前因簡報整理中，此功能按鈕暫時設為隱藏狀態)*

---

## 🔧 日常維護

### 更新網頁內容
修改 `index.html` 或 `README.md` 後執行：

```bash
git add .
git commit -m "說明本次修改內容"
git push
```

### 部署說明
1. 前往 GitHub **Settings -> Pages**。
2. **Source** 選擇 `Deploy from a branch`。
3. **Branch** 選擇 `main` / `/ (root)`。
4. 儲存後約 1 分鐘即可上線。

---

## 🔑 金鑰管理

| 金鑰 | 存放位置 |
|---|---|
| **Notion Token** | Cloudflare Worker → Variables → `NOTION_TOKEN` |
| **Gemini API Key** | Cloudflare Worker → Variables → `GEMINI_API_KEY` |

> ⚠️ **安全性聲明**：GitHub 上不含任何 API 金鑰。所有金鑰均安全儲存於 Cloudflare 後端環境變數中。

---

## 🆘 常見問題

| 問題 | 解法 |
|---|---|
| 讀取失敗 / 404 | 確認 Notion 頁面已點擊 `...` -> `Connect to` 並選擇對應的 Integration |
| 網頁白畫面 | 確認 GitHub Pages 網址正確且分支已設定為 main |
| 設定無法儲存 | 確認瀏覽器沒有開啟「無痕模式」或阻擋 LocalStorage |

---
