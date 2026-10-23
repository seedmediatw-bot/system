# 種子內部系統 v2

取代舊的 HR/CRM 雙 Worker 系統。只有一個使用者（Sam），可代同事填單。

## 功能

| 頁面 | 做什麼 |
|---|---|
| 首頁 | 今天誰請假、本月每人請假天數與報帳金額、最近 10 筆送出 |
| 報帳 | 填明細，記到 Notion，LINE 跳通知。不審核、不收收據 |
| 請假 | 以小時計（一天 8 小時），Notion「請假天數」欄寫「小時÷8」；審核狀態固定寫「已登記」 |
| 簽到 | 記錄、事後可改，每筆顯示最後修改時間；「全月正常出勤」預覽後一次建立整個月（排除週末、國定假日、請假日、已簽到日） |
| 客戶 | 只看。有新動態的排最上面；展開後每件事單獨一則 |

選單圖示：五個圖示各在兩個符號之間循環形變（首頁↔圖表、報帳↔硬幣、請假↔太陽、簽到↔打勾、客戶↔多人），節奏錯開、端點停留比形變久。使用 Morphicons（MIT）與 Lucide（ISC），授權文字在 `public/THIRD-PARTY-LICENSES.txt`；系統設定「減少動態」時固定顯示第一個符號。

不做：面試管理、AI（Gemini）、報帳核准與收據、繳費紀錄、員工入職、客戶新增與修改。

## 結構

- `src/worker.js`：後台程式（網頁、API、LINE）。
- `public/`：網頁檔（HTML、CSS、JS、圖示）。
- `build.cjs`：把 `public/` 嵌進 worker，產出 `dist/worker.js`（貼進 Cloudflare 的就是這個檔）。
- `worker.test.cjs`：測試。以假金鑰與假 Notion 執行，不連正式服務。

```bash
node v2/build.cjs && node v2/worker.test.cjs
```

## 部署：同一個檔案部署兩次

| Worker | 用途 | 前面有 Cloudflare Access？ | 變數 MODE |
|---|---|---|---|
| `seed-hr` | 網站與 API，給 Sam 用 | 有，只放行 Sam 的 Google 信箱 | 不設 |
| `seed-hr-line` | 只收 LINE 通知、發每日 09:00 請假通知 | 沒有（LINE 伺服器無法登入），靠簽章驗證 | `line` |

原因：Access 是整個 Worker 一起擋，無法單獨放行 LINE 的通知網址。

### 環境變數（在 Cloudflare 填，不寫進程式或對話）

| 變數 | seed-hr | seed-hr-line |
|---|---|---|
| ACCESS_TEAM_DOMAIN、ACCESS_AUD、ALLOWED_EMAILS | 要 | 不用 |
| APPLICANTS（可代填的人名，逗號分隔） | 要 | 不用 |
| HR_TOKEN（Notion 整合） | 要 | 要 |
| CRM_TOKEN（只需讀取權限） | 要 | 不用 |
| DB_LEAVE、DB_EXPENSE、DB_CHECKIN、DB_CRM | 要 | DB_LEAVE |
| LINE_CHANNEL_TOKEN、LINE_GROUP_ID | 要 | 要 |
| LINE_CHANNEL_SECRET | 不用 | 要 |
| LINE_ALLOWED_USER_IDS（選填） | 不用 | 選填 |
| MODE | 不設 | `line` |

Cron 觸發器只設在 `seed-hr-line`：`0 1 * * 1-5`（UTC 01:00，台灣平日 09:00）。

## 資安對應（2026-10-23 盤點）

| 項目 | 做法 |
|---|---|
| R3 LINE 簽章 | 先用 channel secret 驗 `x-line-signature`，再核對群組與操作人；指令只查詢，不改資料 |
| R4 長效金鑰與代理過廣 | 無共用金鑰；Access 短期憑證，Worker 驗簽章、AUD、期限與信箱；無通用 Notion 代理，每個動作固定欄位與資料庫 |
| R7 來源與 API 位址 | 網頁與 API 同一個網址，無可改的 API 位址；CSP 只允許自己 |
| R9 發布 | 不從主分支自動發布；由 Sam 手動貼進 Cloudflare |
| 登入節流 | 登入由 Access 負責；寫入每分鐘上限 20 次（單一執行個體內計算，非全球計數） |
| 收據 | 不再收收據，移除 Google Drive 服務帳號用途 |

## 已知限制

- 寫入節流只在單一 Worker 執行個體內計算。要更嚴格需另設 Cloudflare 速率限制規則。
- `LINE_ALLOWED_USER_IDS` 不填時，群組內任何人 @Bot 都可查詢請假（群組本身已核對）。
- Notion 欄位名稱依舊系統原始碼，部署前要對照實際資料庫。
- 請假與報帳的「審核狀態」欄會寫入「已登記」，Notion 若有依此欄位的檢視要留意。
