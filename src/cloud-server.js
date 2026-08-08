import http from "node:http";
import { randomUUID } from "node:crypto";
import { buildDraft, buildInvitationFlex, isConfirmCommand, isMyIdCommand, isValidSignature, parseSchemeCommand, QUOTE_SCHEMES } from "./app.js";
import { claimAction, completeAction, flagActionForReview, getInvitation, getLatestInvitation, getSession, initializeDatabase, listPendingActions, queueAction, saveInvitation, saveSession, updateDraft } from "./db.js";
import { decodePubSub, processHistory, renewWatch, sendReply } from "./gmail.js";

const port = Number(process.env.PORT || 3000);
const REPLY = "https://api.line.me/v2/bot/message/reply";
const PUSH = "https://api.line.me/v2/bot/message/push";

function json(res, status, value) { res.writeHead(status, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(value)); }
async function body(req) { const chunks=[]; let size=0; for await (const c of req) { size += c.length; if(size>1_000_000) throw new Error("Payload too large"); chunks.push(c); } return Buffer.concat(chunks).toString("utf8"); }
function authorized(req) { return Boolean(process.env.AUTOMATION_SECRET) && req.headers.authorization === `Bearer ${process.env.AUTOMATION_SECRET}`; }
async function line(endpoint, payload) { const r=await fetch(endpoint,{method:"POST",headers:{Authorization:`Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,"Content-Type":"application/json"},body:JSON.stringify(payload)}); if(!r.ok) throw new Error(`LINE ${r.status}: ${await r.text()}`); }
async function reply(token, text) { await line(REPLY,{replyToken:token,messages:[{type:"text",text}]}); }

async function schemeDraft(event, invitation, key) {
  const scheme=QUOTE_SCHEMES[key];
  if(!invitation || !scheme) return reply(event.replyToken,"找不到這筆邀約或方案，請重新產生邀約圖卡。");
  const draft=buildDraft(invitation,scheme.amount,key);
  await saveSession(event.source.userId,invitation.id,key,draft);
  await reply(event.replyToken,`${draft}\n\n——\n請核對後回覆「送出」或「確認」。若要修改，請貼上完整新版文案；修改後仍需再次確認。`);
}

async function handleLineEvent(event) {
  const userId=event.source?.userId; if(!userId) return;
  if(event.type==="postback") {
    const data=Object.fromEntries(new URLSearchParams(event.postback?.data || ""));
    if(data.action==="scheme") return schemeDraft(event,await getInvitation(data.invitation),data.scheme);
    return;
  }
  if(event.type!=="message" || event.message?.type!=="text") return;
  const text=event.message.text.trim();
  if(isMyIdCommand(text)) return reply(event.replyToken,`你的 User ID：\n${userId}`);
  const key=parseSchemeCommand(text);
  if(key) return schemeDraft(event,await getLatestInvitation(),key);
  const session=await getSession(userId); if(!session) return;
  const invitation=await getInvitation(session.invitation_id);
  if(session.state==="awaiting_confirmation" && isConfirmCommand(text)) {
    const action=await queueAction({id:randomUUID(),invitationId:invitation.id,userId,recipient:invitation.sender,subject:`Re: ${invitation.subject}`,body:session.draft});
    if(!action) return reply(event.replyToken,"這封信已在寄送或待查核狀態，請勿重複確認。");
    const claimed=await claimAction(action.id);
    if(!claimed) return reply(event.replyToken,"這封信已由其他程序處理，請勿重複確認。");
    try {
      const sent=await sendReply({gmailThreadId:invitation.gmailThreadId,gmailMessageId:invitation.gmailMessageId,to:claimed.recipient,subject:claimed.subject,body:claimed.body});
      await completeAction(claimed.id,sent.id);
      return reply(event.replyToken,"已依照你確認的草稿回覆原 Gmail 對話串。");
    } catch(error) {
      console.error("Gmail send result requires review",error);
      await flagActionForReview(claimed.id);
      return reply(event.replyToken,"Gmail 寄送結果無法明確確認，系統不會自動重試，以免重複寄信。請先到寄件備份人工查核。");
    }
  }
  if(session.state==="awaiting_confirmation") { await updateDraft(userId,text); return reply(event.replyToken,`已用你貼上的完整文案更新草稿，尚未寄出。\n\n${text}\n\n——\n請再次回覆「送出」或「確認」才會寄出。`); }
}

async function register(input) {
  if(!input?.gmailThreadId || !input?.subject || !input?.sender) throw new Error("gmailThreadId, subject and sender are required");
  const invitation=await saveInvitation({...input,id:input.id||randomUUID(),quotes:[]});
  if(invitation.inserted && process.env.LINE_DIRECTOR_USER_ID) await line(PUSH,{to:process.env.LINE_DIRECTOR_USER_ID,messages:[buildInvitationFlex(invitation)]});
  return invitation;
}

await initializeDatabase();
http.createServer(async(req,res)=>{
  const url=new URL(req.url,`http://${req.headers.host||"localhost"}`);
  try {
    if(req.method==="GET"&&url.pathname==="/health") return json(res,200,{ok:true,storage:"postgres"});
    if(req.method==="POST"&&url.pathname==="/webhook") {
      const raw=await body(req); if(!isValidSignature(raw,req.headers["x-line-signature"],process.env.LINE_CHANNEL_SECRET)) return json(res,401,{error:"Invalid signature"});
      const payload=JSON.parse(raw); await Promise.all((payload.events||[]).map(handleLineEvent)); return json(res,200,{ok:true});
    }
    if(req.method==="POST"&&url.pathname==="/gmail/pubsub") {
      if(!process.env.PUBSUB_WEBHOOK_SECRET || url.searchParams.get("token")!==process.env.PUBSUB_WEBHOOK_SECRET) return json(res,401,{error:"Unauthorized"});
      const notification=decodePubSub(JSON.parse(await body(req)));
      return json(res,200,{ok:true,...await processHistory(notification,register)});
    }
    if(req.method==="POST"&&url.pathname==="/jobs/gmail-watch") {
      if(!authorized(req)) return json(res,401,{error:"Unauthorized"});
      return json(res,200,await renewWatch());
    }
    if(url.pathname.startsWith("/internal/")&&!authorized(req)) return json(res,401,{error:"Unauthorized"});
    if(req.method==="POST"&&url.pathname==="/internal/invitations") return json(res,201,await register(JSON.parse(await body(req))));
    if(req.method==="GET"&&url.pathname==="/internal/actions") return json(res,200,{actions:await listPendingActions()});
    return json(res,404,{error:"Not found"});
  } catch(error) { console.error(error); return json(res,error.message==="Payload too large"?413:500,{error:"Internal server error"}); }
}).listen(port,"0.0.0.0",()=>console.log(`Cloud LINE webhook listening on ${port}`));
