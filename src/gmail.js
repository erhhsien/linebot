import { randomUUID } from "node:crypto";
import { getState, setState } from "./db.js";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
let tokenCache = null;
async function accessToken() {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60000) return tokenCache.value;
  const form = new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, refresh_token: process.env.GOOGLE_REFRESH_TOKEN, grant_type: "refresh_token" });
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form });
  if (!r.ok) throw new Error(`Google OAuth ${r.status}: ${await r.text()}`);
  const v = await r.json(); tokenCache = { value: v.access_token, expiresAt: Date.now() + v.expires_in * 1000 }; return v.access_token;
}
async function gmail(path, options = {}) {
  const r = await fetch(`${API}${path}`, { ...options, headers: { Authorization: `Bearer ${await accessToken()}`, "content-type": "application/json", ...(options.headers || {}) } });
  if (!r.ok) throw new Error(`Gmail API ${r.status}: ${await r.text()}`);
  return r.status === 204 ? null : r.json();
}
export async function renewWatch() {
  const result = await gmail("/watch", { method: "POST", body: JSON.stringify({ topicName: process.env.GMAIL_PUBSUB_TOPIC, labelIds: ["INBOX"], labelFilterBehavior: "INCLUDE" }) });
  await setState("gmail_watch", result); await setState("gmail_history_id", { historyId: result.historyId }); return result;
}
const decode = (v = "") => Buffer.from(v.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
const headers = payload => Object.fromEntries((payload.headers || []).map(h => [h.name.toLowerCase(), h.value]));
function textBody(part) { if (part.mimeType === "text/plain" && part.body?.data) return decode(part.body.data); for (const child of part.parts || []) { const found = textBody(child); if (found) return found; } return part.body?.data ? decode(part.body.data) : ""; }
const senderAddress = value => value.match(/<([^>]+)>/)?.[1] || value.trim();
const senderName = value => value.replace(/<[^>]+>/, "").replace(/^"|"$/g, "").trim();
const INCLUDE = ["合作邀約", "品牌合作", "商業合作", "產品體驗", "業配", "報價", "reels", "instagram", "高爾賢", "導演合作"];
const EXCLUDE = ["電子報", "newsletter", "帳單", "驗證碼", "系統通知", "取消訂閱", "unsubscribe"];
export function isInvitation(subject, body) { const text = `${subject}\n${body}`.toLowerCase(); return INCLUDE.some(k => text.includes(k.toLowerCase())) && !EXCLUDE.some(k => text.includes(k.toLowerCase())); }
function firstMatch(text, patterns) { for (const p of patterns) { const m = text.match(p); if (m) return m[1].trim(); } return ""; }
export async function invitationFromMessage(messageId) {
  const m = await gmail(`/messages/${encodeURIComponent(messageId)}?format=full`); const h = headers(m.payload); const plain = textBody(m.payload).slice(0, 30000); const subject = h.subject || "（無主旨）";
  if (!m.labelIds?.includes("INBOX") || !isInvitation(subject, plain)) return null;
  return { id: randomUUID(), gmailThreadId: m.threadId, gmailMessageId: m.id, subject, sender: senderAddress(h.from), contactName: senderName(h.from), brand: firstMatch(plain, [/品牌(?:名稱)?[：:]\s*([^\n]+)/i]), product: firstMatch(plain, [/產品(?:名稱)?[：:]\s*([^\n]+)/i]), deliverables: firstMatch(plain, [/合作(?:內容|形式)[：:]\s*([^\n]+)/i]), publishAt: firstMatch(plain, [/(?:發布|上線|預計)時間[：:]\s*([^\n]+)/i]), usageRights: firstMatch(plain, [/(?:授權|投廣)[^：:\n]*[：:]\s*([^\n]+)/i]) };
}

function base64url(value) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function encodedHeader(value) {
  return `=?UTF-8?B?${Buffer.from(String(value), "utf8").toString("base64")}?=`;
}

export async function sendReply({ gmailThreadId, gmailMessageId, to, subject, body }) {
  const original = await gmail(`/messages/${encodeURIComponent(gmailMessageId)}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=Subject&metadataHeaders=From`);
  if (original.threadId !== gmailThreadId) throw new Error("Gmail thread mismatch");
  const originalHeaders = headers(original.payload);
  const originalMessageId = originalHeaders["message-id"];
  if (!originalMessageId) throw new Error("Original RFC Message-ID is missing");

  const cleanedBody = String(body).replace(/^主旨：[^\r\n]*(?:\r?\n){1,2}/, "");
  const raw = [
    `To: ${to}`,
    `Subject: ${encodedHeader(subject)}`,
    `In-Reply-To: ${originalMessageId}`,
    `References: ${originalMessageId}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(cleanedBody, "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n"),
  ].join("\r\n");
  return gmail("/messages/send", { method: "POST", body: JSON.stringify({ threadId: gmailThreadId, raw: base64url(raw) }) });
}
export async function processHistory(notification, onInvitation) {
  const state = await getState("gmail_history_id"); if (!state?.historyId) { await setState("gmail_history_id", { historyId: notification.historyId }); return { initialized: true, count: 0 }; }
  let pageToken; const ids = new Set(); do { const q = new URLSearchParams({ startHistoryId: String(state.historyId), historyTypes: "messageAdded" }); if (pageToken) q.set("pageToken", pageToken); const result = await gmail(`/history?${q}`); for (const history of result.history || []) for (const added of history.messagesAdded || []) ids.add(added.message.id); pageToken = result.nextPageToken; } while (pageToken);
  let count = 0; for (const id of ids) { const invitation = await invitationFromMessage(id); if (invitation) { await onInvitation(invitation); count++; } }
  await setState("gmail_history_id", { historyId: notification.historyId }); return { count };
}
export function decodePubSub(body) { if (!body?.message?.data) throw new Error("Missing Pub/Sub message data"); const value = JSON.parse(decode(body.message.data)); if (value.emailAddress?.toLowerCase() !== process.env.GMAIL_ACCOUNT?.toLowerCase()) throw new Error("Unexpected Gmail account"); return value; }
