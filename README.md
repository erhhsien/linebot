# LINE Bot Webhook

單一 LINE Messaging API webhook，可供多位使用者共同使用。任何使用者在與 Bot 的聊天室輸入 `My ID`（不分大小寫、忽略前後空白），Bot 會回覆該次事件的 `source.userId`。

## Endpoint

- Webhook：`https://<worker-domain>/webhook`
- 健康檢查：`https://<worker-domain>/health`

## 必要環境變數

- `LINE_CHANNEL_SECRET`
- `LINE_CHANNEL_ACCESS_TOKEN`

請以部署平台的 secret 管理功能設定，不要寫入程式碼或提交至 Git。

## Render 部署

Repository 內含 `render.yaml`。在 Render 建立 Blueprint 或 Web Service 並連接本 repository，設定兩個 secret 後即可部署。

部署完成後，將 Render 網址加上 `/webhook`，填入 LINE Developers Console 的 Webhook URL，啟用 **Use webhook**，再按 **Verify**。

建議停用 Messaging API 的預設 Greeting message 與 Auto-reply messages，避免同一訊息收到額外回覆。
