# 機場接送與桃小巴 LINE Bot 2.3.0 融合版

這是將現有程式、全台行政區、批次異動功能、維護修正與測試整合後的乾淨部署版本。

## 部署檔案

- `index.js`：Bot 主程式
- `regions.json`：全台 22 縣市、368 個鄉鎮市區離線資料
- `package.json`、`package-lock.json`：套件與固定版本
- `test.js`：核心、行政區與批次異動測試
- `unsend.test.js`：LINE 收回後自動更新簡表測試
- `fixes.test.js`：重新派單、補單與地址修正測試
- `placard.test.js`：舉牌扣款、客上自接與司機自接測試
- `operations.test.js`：00～23 補單、正式單取代補單、自接關鍵字、桃小巴與跨群組測試
- `README.md`：完整使用說明與所有指令
- `TESTING-GUIDE.md`：本說明

請將以上十一個檔案放在 GitHub 專案根目錄。不要上傳 `node_modules`，也不要把 Token、Secret、MongoDB 密碼寫進任何檔案。

## Render 必要環境變數

| Key | Value |
|---|---|
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE Messaging API 的長效 Token |
| `LINE_CHANNEL_SECRET` | LINE Developers 的 Channel secret |
| `MONGO_URI` | MongoDB Atlas 連線字串 |
| `TEST_MODE` | 測試期間填 `true`；正式推送前改成 `false` |

Render 設定：

- Build Command：`npm ci`
- Start Command：`npm start`
- Node：20 或 22
- Webhook：`https://order-bot-45x0.onrender.com/webhook`

部署後先開啟 `/health`，應看到：

```json
{
  "status": "ok",
  "version": "2.3.0-fused",
  "lineConfigured": true,
  "databaseReady": true,
  "testMode": true,
  "timeZone": "Asia/Taipei"
}
```

## 群組可用指令

輸入 `指令`、`說明` 或 `help`，Bot 會顯示內建說明。

### 查詢

- `測試`
- `簡表`
- `簡表 10/27`
- `簡表 2026/10/27`
- `群組診斷 10/27`
- `群組診斷 2026/10/27`

### 月結與 Excel

- `月結`
- `月結 10月`
- `月結 2026/10`
- `月結 Excel`
- `月結 10月 Excel`
- `月結 2026/10 Excel`

### 單筆訂單異動

- `ABC12345 取消`
- `ABC12345 收回`
- `ABC12345 拉回`
- `ABC12345 改派`
- `ABC12345 拉回改派`

### 批次訂單異動

可逐行貼任意筆數的訂單編號，最後輸入共同動作：

```text
XJQ798147
ZUF777274
SCC907815

以上取消
```

也可輸入：

```text
取消：XJQ798147、ZUF777274、SCC907815
```

動作支援 `取消`、`收回`、`拉回`、`改派`、`拉回改派`。已異動的編號會建立防復活標記，原單重貼不會重新加入簡表或月結。

## 上線前測試

在專案資料夾執行：

```bash
npm ci
npm run check
npm test
npm audit --omit=dev
```

正確結果應為 228 項測試全部通過、0 項失敗，安全掃描為 0 個已知漏洞。

## 重要行為

- 每個 LINE 群組以自己的 `groupId` 隔離，訂單、簡表、月結與 Excel 不會混到其他司機群組。
- 客收與結算價分開顯示，但兩者都列入業績；只有客收時不顯示待確認。
- 簡表只保留舉牌、安全座椅、增高墊等營運必要備註；禁煙及 LINE ID 不列入簡表。
- 支援 LINE 收回事件、同編號更新、防重、無編號自客單及跨年度查詢。
- LINE 收回事件成功取消後會自動推送最新簡表；最後一筆收回也會顯示零筆及零元。
- 補單整點會固定顯示兩位數 `00`～`23`；正式訂單補入同日、同時間、同方向後會自動取代補單。
- 誤取消或誤拉回後，客服用新的 LINE 訊息重貼可恢復；LINE 舊事件重送不會覆蓋新版。
- 一般舉牌訂單每筆扣100元；舉牌訂單或對原單的回覆只要包含「自接」兩字，即顯示為「舉牌*」且不扣款。
- 簡表、群組診斷、月結及 Excel 均使用「業績＝結算價＋客收－舉牌服務扣款」。
- 桃小巴支援 `1320-1520桃小巴` 與指定日期格式；每3小時業績2000元，時數與業績分開統計，且只出現在收到班次的群組。
- 一次性歷史修復指令已退役，輸入後不會修改資料。
- `TEST_MODE=true` 使用 Reply 回覆並停用排程 Push，適合訊息額度不足時測試。

## 建議驗收順序

1. `/health` 確認版本與三項設定均正常。
2. LINE Developers 按 Verify。
3. 每個測試群組輸入 `測試` 與 `指令`。
4. 各貼一筆一般單、只有客收的自客單及修改版訂單。
5. 執行單筆與批次取消，再重貼原單確認不會復活。
6. 輸入指定日期簡表、群組診斷、月結與月結 Excel。
7. 確認不同司機群組內容完全分開後，再把 `TEST_MODE` 改為 `false`。
