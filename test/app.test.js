import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  buildDraft,
  completeAction,
  handleWebhook,
  isConfirmCommand,
  isMyIdCommand,
  isValidSignature,
  listPendingActions,
  parseSchemeCommand,
  QUOTE_SCHEMES,
  registerInvitation,
  resetStore,
} from "../src/app.js";

test("accepts myID with any casing or spaces", () => {
  assert.equal(isMyIdCommand("myID"), true);
  assert.equal(isMyIdCommand(" My ID "), true);
  assert.equal(isMyIdCommand("MYID"), true);
});

test("accepts a valid LINE signature", () => {
  const body = '{"events":[]}';
  const secret = "test-secret";
  const signature = createHmac("sha256", secret).update(body).digest("base64");
  assert.equal(isValidSignature(body, signature, secret), true);
});

test("rejects an invalid LINE signature", () => {
  assert.equal(isValidSignature('{"events":[]}', "invalid", "test-secret"), false);
});

test("only accepts explicit send confirmations", () => {
  assert.equal(isConfirmCommand("確認"), true);
  assert.equal(isConfirmCommand("送出"), true);
  assert.equal(isConfirmCommand("好的"), false);
});

test("draft uses provided amount and confirmed template defaults", () => {
  const draft = buildDraft({ subject: "合作邀約", brand: "測試品牌", sender: "client@example.com" }, "250000");
  assert.match(draft, /NT\$ 250,000/);
  assert.match(draft, /Instagram & FB雙平台/);
  assert.match(draft, /IG Stories：一支/);
  assert.match(draft, /投廣授權：待確認/);
});

test("defines the confirmed A, B, and C packages", () => {
  assert.deepEqual(Object.keys(QUOTE_SCHEMES), ["A", "B", "C"]);
  assert.equal(QUOTE_SCHEMES.A.amount, "250000");
  assert.equal(QUOTE_SCHEMES.B.amount, "70000");
  assert.equal(QUOTE_SCHEMES.C.amount, "300000");
  assert.match(QUOTE_SCHEMES.C.name, /推薦方案/);
});

test("Flex buttons display only package names", async () => {
  resetStore();
  const calls = [];
  const fakeFetch = async (_url, options) => { calls.push(JSON.parse(options.body)); return { ok: true }; };
  await registerInvitation(
    { gmailThreadId: "thread-buttons", subject: "合作邀約", sender: "client@example.com", brand: "品牌" },
    { LINE_DIRECTOR_USER_ID: "Udirector", LINE_CHANNEL_ACCESS_TOKEN: "token" },
    fakeFetch,
  );
  const buttons = calls[0].messages[0].contents.footer.contents;
  assert.deepEqual(buttons.map((button) => button.action.label), ["方案 A", "方案 B", "方案 C"]);
});

test("accepts displayed scheme text as a draft command", () => {
  assert.equal(parseSchemeCommand("方案 B"), "B");
  assert.equal(parseSchemeCommand("選擇方案 B：IG 圖文貼文合作"), "B");
  assert.equal(parseSchemeCommand("選擇方案 C: Reels + 圖文"), "C");
  assert.equal(parseSchemeCommand("其他訊息"), null);
});

test("invite registration is idempotent by Gmail thread", async () => {
  resetStore();
  const calls = [];
  const fakeFetch = async (_url, options) => { calls.push(JSON.parse(options.body)); return { ok: true }; };
  const input = { gmailThreadId: "thread-1", subject: "合作邀約", sender: "client@example.com", brand: "品牌" };
  const env = { LINE_DIRECTOR_USER_ID: "Udirector", LINE_CHANNEL_ACCESS_TOKEN: "token" };
  const first = await registerInvitation(input, env, fakeFetch);
  const second = await registerInvitation(input, env, fakeFetch);
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(calls.length, 1);
});

test("scheme selection, draft replacement, and confirmation create one send action", async () => {
  resetStore();
  const sent = [];
  const fakeFetch = async (_url, options) => { sent.push(JSON.parse(options.body)); return { ok: true }; };
  const { invitation } = await registerInvitation({ gmailThreadId: "thread-2", subject: "Reels 合作", sender: "client@example.com", brand: "品牌" }, {}, fakeFetch);
  const env = { LINE_CHANNEL_SECRET: "secret", LINE_CHANNEL_ACCESS_TOKEN: "token" };
  const emit = async (event) => {
    const raw = JSON.stringify({ events: [event] });
    const signature = createHmac("sha256", env.LINE_CHANNEL_SECRET).update(raw).digest("base64");
    await handleWebhook(raw, signature, env, fakeFetch);
  };
  await emit({ type: "postback", replyToken: "r1", source: { userId: "U1" }, postback: { data: `action=scheme&invitation=${invitation.id}&scheme=A` } });
  assert.match(sent.at(-1).messages[0].text, /方案 A/);
  assert.match(sent.at(-1).messages[0].text, /NT\$ 250,000（未稅）/);
  await emit({ type: "message", replyToken: "r3", source: { userId: "U1" }, message: { type: "text", text: "這是完整修改稿" } });
  assert.equal(listPendingActions().length, 0);
  await emit({ type: "message", replyToken: "r4", source: { userId: "U1" }, message: { type: "text", text: "確認" } });
  assert.equal(listPendingActions().length, 1);
  assert.equal(listPendingActions()[0].body, "這是完整修改稿");
  const completed = completeAction(listPendingActions()[0].id, { gmailMessageId: "message-1" });
  assert.equal(completed.status, "completed");
  assert.equal(listPendingActions().length, 0);
});

test("displayed scheme keyword generates a draft", async () => {
  resetStore();
  const sent = [];
  const fakeFetch = async (_url, options) => { sent.push(JSON.parse(options.body)); return { ok: true }; };
  await registerInvitation({ gmailThreadId: "thread-text", subject: "合作邀約", sender: "client@example.com", brand: "品牌" }, {}, fakeFetch);
  const env = { LINE_CHANNEL_SECRET: "secret", LINE_CHANNEL_ACCESS_TOKEN: "token" };
  const raw = JSON.stringify({ events: [{ type: "message", replyToken: "r1", source: { userId: "U1" }, message: { type: "text", text: "選擇方案 B：IG 圖文貼文合作" } }] });
  const signature = createHmac("sha256", env.LINE_CHANNEL_SECRET).update(raw).digest("base64");
  await handleWebhook(raw, signature, env, fakeFetch);
  assert.match(sent.at(-1).messages[0].text, /方案 B/);
  assert.match(sent.at(-1).messages[0].text, /NT\$ 70,000（未稅）/);
});
