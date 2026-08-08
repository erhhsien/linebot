import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

const LINE_REPLY_ENDPOINT = "https://api.line.me/v2/bot/message/reply";
const LINE_PUSH_ENDPOINT = "https://api.line.me/v2/bot/message/push";

export const store = {
  invitations: new Map(),
  sessions: new Map(),
  actions: new Map(),
};

export function resetStore() {
  store.invitations.clear();
  store.sessions.clear();
  store.actions.clear();
}

export function isMyIdCommand(text) {
  return text.trim().toLowerCase().replaceAll(" ", "") === "myid";
}

export function isConfirmCommand(text) {
  return ["送出", "確認"].includes(text.trim());
}

export function isValidSignature(rawBody, signature, channelSecret) {
  if (!signature || !channelSecret) return false;
  const expected = createHmac("sha256", channelSecret).update(rawBody).digest("base64");
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function money(value) {
  const digits = String(value ?? "").replace(/[^0-9]/g, "");
  return digits ? Number(digits).toLocaleString("zh-TW") : "";
}

export const QUOTE_SCHEMES = {
  A: {
    name: "IG Reels 影像合作（品牌形象／生活情境整合）",
    amount: "250000",
    items: [
      "IG Reels 1 支（約 45–60 秒）",
      "品牌協作貼文（IG）",
      "Meta 平台同步曝光（IG＋FB）",
      "IG Story 1 則（含連結導流）",
      "廣告主授權 1 週",
    ],
    direction: "以導演第一人稱生活視角切入，結合工作、旅行、戶外探索、拍攝現場等真實情境，自然帶入品牌服務與產品特色。",
  },
  B: {
    name: "IG 圖文貼文合作",
    amount: "70000",
    items: [
      "IG 圖文貼文 1 則",
      "FB 同步曝光",
      "精選照片 5 張（情境照、人物照、產品照搭配）",
    ],
    direction: "以導演日常生活分享方式呈現，透過真實使用情境建立品牌連結。",
  },
  C: {
    name: "IG Reels＋圖文整合合作（推薦方案）",
    amount: "300000",
    items: [
      "IG Reels 1 支（約 45–60 秒）",
      "品牌協作貼文（IG）",
      "Meta 平台同步曝光（IG＋FB）",
      "IG 圖文貼文 1 則",
      "精選照片 5 張（情境照、人物照、產品照搭配）",
      "IG Story 1 則（含連結導流）",
      "廣告主授權 3 週",
    ],
    direction: "以影像與高質感平面照片同步呈現品牌形象及產品資訊，延長內容曝光週期並增加社群互動效益。",
  },
};

export function buildDraft(invitation, amount, schemeKey = null) {
  const contact = invitation.contactName || "聯絡人";
  const brand = invitation.brand || "品牌方";
  const product = invitation.product || "待確認";
  const publishAt = invitation.publishAt || "待確認";
  const scheme = schemeKey ? QUOTE_SCHEMES[schemeKey] : null;
  const content = scheme
    ? `方案 ${schemeKey}｜${scheme.name}\n\n${scheme.items.map((item) => `- ${item}`).join("\n")}\n\n內容方向\n${scheme.direction}`
    : "合作內容\n- 發布平台：Instagram & FB雙平台\n- 合作形式：IG Reels 短影音 1 則\n- IG Stories：一支\n- 品牌協作：包含\n- 投廣授權：待確認\n- 競品排他：不包含";
  return `主旨：Re: ${invitation.subject}\n\nHi ${contact} 您好，\n\n我是阿爾特影視的專案窗口周暐，目前協助高爾賢導演處理品牌合作相關事宜。\n\n謝謝您的來信與邀請，也謝謝 ${brand} 對爾賢導演的認可。我們已經看過這次的合作需求，對合作方向有興趣。\n\n以下先提供本次合作內容與報價供您參考：\n\n合作品牌：${brand}\n合作產品：${product}\n發布時間：${publishAt}\n\n${content}\n\n合作報價\nNT$ ${money(amount)}（未稅）\n\n以上報價以目前信件中提供的合作條件為基準。若後續調整影片支數、發布平台、素材授權、投廣期間、競品排他或其他交付項目，報價將依最終需求另外確認。\n\n實際創意方向可以在收到完整 Brief 後進一步討論。如果以上方向符合品牌規劃，再麻煩您提供完整 Brief、預計時程與授權需求，我們會再協助確認後續執行安排。\n\n謝謝，也期待有機會與 ${brand} 合作！\n\nBest regards\nJoseph｜周暐\n阿爾特娛樂製作有限公司｜Goal Brother Entertainment Studios Co., Ltd.\n0932-051-919\n231新北市新店區中正路26號4樓`;
}

function quoteButtons(invitation) {
  return Object.entries(QUOTE_SCHEMES).map(([key, scheme], index) => {
    return {
      type: "button",
      style: index === 0 ? "primary" : "secondary",
      color: index === 0 ? "#1769E0" : undefined,
      action: {
        type: "postback",
        label: `方案 ${key}`,
        data: `action=scheme&invitation=${invitation.id}&scheme=${key}`,
        displayText: `選擇方案 ${key}：${scheme.name}`,
      },
    };
  });
}

export function parseSchemeCommand(text) {
  const match = text.trim().match(/^(?:選擇)?方案\s*([ABC])(?:[：:].*)?$/i);
  return match ? match[1].toUpperCase() : null;
}

async function replyWithSchemeDraft(userId, replyToken, invitation, schemeKey, env, fetchImpl) {
  const scheme = QUOTE_SCHEMES[schemeKey];
  if (!scheme) return reply(replyToken, "找不到這個報價方案，請重新產生邀約圖卡。", env, fetchImpl);
  const draft = buildDraft(invitation, scheme.amount, schemeKey);
  store.sessions.set(userId, { invitationId: invitation.id, schemeKey, amount: scheme.amount, draft, state: "awaiting_confirmation" });
  return reply(replyToken, `${draft}\n\n——\n請核對後回覆「送出」或「確認」。若要修改，請貼上完整新版文案；修改後仍需再次確認。`, env, fetchImpl);
}

export function buildInvitationFlex(invitation) {
  const rows = [
    ["品牌", invitation.brand], ["產品", invitation.product], ["合作形式", invitation.deliverables],
    ["時程", invitation.publishAt], ["授權", invitation.usageRights], ["寄件人", invitation.sender],
  ].filter(([, value]) => value);
  return {
    type: "flex",
    altText: `新合作邀約：${invitation.brand || invitation.subject}`,
    contents: {
      type: "bubble",
      header: { type: "box", layout: "vertical", backgroundColor: "#1769E0", contents: [
        { type: "text", text: "新合作邀約", color: "#FFFFFF", weight: "bold", size: "lg" },
        { type: "text", text: invitation.subject, color: "#EAF2FF", size: "sm", wrap: true, margin: "sm" },
      ] },
      body: { type: "box", layout: "vertical", spacing: "md", contents: rows.map(([label, value]) => ({
        type: "box", layout: "baseline", contents: [
          { type: "text", text: label, color: "#6B7280", size: "sm", flex: 2 },
          { type: "text", text: String(value), color: "#111827", size: "sm", wrap: true, flex: 5 },
        ],
      })) },
      footer: { type: "box", layout: "vertical", spacing: "sm", contents: quoteButtons(invitation) },
    },
  };
}

async function lineMessage(endpoint, body, token, fetchImpl = fetch) {
  const response = await fetchImpl(endpoint, { method: "POST", headers: {
    Authorization: `Bearer ${token}`, "Content-Type": "application/json",
  }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`LINE API failed (${response.status}): ${await response.text()}`);
}

async function reply(replyToken, messages, env, fetchImpl) {
  const list = Array.isArray(messages) ? messages : [{ type: "text", text: messages }];
  await lineMessage(LINE_REPLY_ENDPOINT, { replyToken, messages: list }, env.LINE_CHANNEL_ACCESS_TOKEN, fetchImpl);
}

export async function registerInvitation(input, env = process.env, fetchImpl = fetch) {
  if (!input?.gmailThreadId || !input?.subject || !input?.sender) throw new Error("gmailThreadId, subject and sender are required");
  const existing = [...store.invitations.values()].find((item) => item.gmailThreadId === input.gmailThreadId);
  if (existing) return { invitation: existing, duplicate: true };
  const invitation = { ...input, id: input.id || randomUUID(), quotes: input.quotes || [], createdAt: new Date().toISOString() };
  store.invitations.set(invitation.id, invitation);
  if (env.LINE_DIRECTOR_USER_ID) {
    await lineMessage(LINE_PUSH_ENDPOINT, { to: env.LINE_DIRECTOR_USER_ID, messages: [buildInvitationFlex(invitation)] }, env.LINE_CHANNEL_ACCESS_TOKEN, fetchImpl);
  }
  return { invitation, duplicate: false };
}

function parsePostback(data = "") { return Object.fromEntries(new URLSearchParams(data)); }

async function handleEvent(event, env, fetchImpl) {
  const userId = event.source?.userId;
  if (!userId) return;
  if (event.type === "postback") {
    const data = parsePostback(event.postback?.data);
    if (data.action !== "scheme") return;
    const invitation = store.invitations.get(data.invitation);
    if (!invitation) return reply(event.replyToken, "找不到這筆邀約，請重新產生邀約圖卡。", env, fetchImpl);
    return replyWithSchemeDraft(userId, event.replyToken, invitation, data.scheme, env, fetchImpl);
  }
  if (event.type !== "message" || event.message?.type !== "text") return;
  const text = event.message.text.trim();
  if (isMyIdCommand(text)) return reply(event.replyToken, `你的 User ID：\n${userId}`, env, fetchImpl);
  const schemeCommand = parseSchemeCommand(text);
  if (schemeCommand) {
    const invitation = [...store.invitations.values()].at(-1);
    if (!invitation) return reply(event.replyToken, "目前沒有可套用的合作邀約，請等待新的邀約圖卡。", env, fetchImpl);
    return replyWithSchemeDraft(userId, event.replyToken, invitation, schemeCommand, env, fetchImpl);
  }
  const session = store.sessions.get(userId);
  if (!session) return;
  const invitation = store.invitations.get(session.invitationId);
  if (session.state === "awaiting_confirmation" && isConfirmCommand(text)) {
    const alreadyQueued = [...store.actions.values()].find((item) => item.invitationId === invitation.id && item.status === "pending");
    if (alreadyQueued) return reply(event.replyToken, "這封信已在待寄佇列中，請勿重複確認。", env, fetchImpl);
    const action = { id: randomUUID(), type: "send_gmail_reply", status: "pending", invitationId: invitation.id,
      gmailThreadId: invitation.gmailThreadId, to: invitation.sender, subject: `Re: ${invitation.subject}`, body: session.draft,
      requestedBy: userId, createdAt: new Date().toISOString() };
    store.actions.set(action.id, action);
    session.state = "queued";
    return reply(event.replyToken, "已確認，信件已進入安全寄送佇列。寄出完成後會再通知你。", env, fetchImpl);
  }
  if (session.state === "awaiting_confirmation") {
    session.draft = text;
    return reply(event.replyToken, `已用你貼上的完整文案更新草稿，尚未寄出。\n\n${text}\n\n——\n請再次回覆「送出」或「確認」才會進入寄送佇列。`, env, fetchImpl);
  }
}

export async function handleWebhook(rawBody, signature, env = process.env, fetchImpl = fetch) {
  if (!isValidSignature(rawBody, signature, env.LINE_CHANNEL_SECRET)) return { status: 401, body: "Invalid signature" };
  let payload;
  try { payload = JSON.parse(rawBody); } catch { return { status: 400, body: "Invalid JSON" }; }
  await Promise.all((payload.events ?? []).map((event) => handleEvent(event, env, fetchImpl)));
  return { status: 200, body: "OK" };
}

export function listPendingActions() { return [...store.actions.values()].filter((item) => item.status === "pending"); }
export function completeAction(id, result = {}) {
  const action = store.actions.get(id);
  if (!action) return null;
  Object.assign(action, result, { status: "completed", completedAt: new Date().toISOString() });
  return action;
}
