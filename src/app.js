import { createHmac, timingSafeEqual } from "node:crypto";

const LINE_REPLY_ENDPOINT = "https://api.line.me/v2/bot/message/reply";

export function isMyIdCommand(text) {
  return text.trim().toLowerCase().replaceAll(" ", "") === "myid";
}

export function isValidSignature(rawBody, signature, channelSecret) {
  if (!signature || !channelSecret) return false;
  const expected = createHmac("sha256", channelSecret)
    .update(rawBody)
    .digest("base64");
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

async function reply(replyToken, text, channelAccessToken) {
  const response = await fetch(LINE_REPLY_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${channelAccessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text }],
    }),
  });

  if (!response.ok) {
    throw new Error(`LINE reply failed (${response.status}): ${await response.text()}`);
  }
}

export async function handleWebhook(rawBody, signature, env = process.env) {
  if (!isValidSignature(rawBody, signature, env.LINE_CHANNEL_SECRET)) {
    return { status: 401, body: "Invalid signature" };
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: "Invalid JSON" };
  }

  const jobs = (payload.events ?? [])
    .filter(
      (event) =>
        event.type === "message" &&
        event.message?.type === "text" &&
        isMyIdCommand(event.message.text),
    )
    .map((event) => {
      const userId = event.source?.userId;
      const message = userId
        ? `你的 User ID：\n${userId}`
        : "這次事件沒有提供 User ID。請改在與 Bot 的一對一聊天室傳送 My ID。";
      return reply(event.replyToken, message, env.LINE_CHANNEL_ACCESS_TOKEN);
    });

  await Promise.all(jobs);
  return { status: 200, body: "OK" };
}
