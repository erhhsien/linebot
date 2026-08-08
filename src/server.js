import http from "node:http";
import { completeAction, handleWebhook, listPendingActions, registerInvitation } from "./app.js";

const port = Number(process.env.PORT || 3000);

function json(response, status, value) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

async function readBody(request) {
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error("Payload too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function authorized(request) {
  const token = process.env.AUTOMATION_SECRET;
  return Boolean(token) && request.headers.authorization === `Bearer ${token}`;
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  if (request.method === "GET" && url.pathname === "/health") return json(response, 200, { ok: true });
  try {
    if (request.method === "POST" && url.pathname === "/webhook") {
      const result = await handleWebhook(await readBody(request), request.headers["x-line-signature"]);
      response.writeHead(result.status, { "content-type": "text/plain; charset=utf-8" });
      return response.end(result.body);
    }
    if (url.pathname.startsWith("/internal/") && !authorized(request)) return json(response, 401, { error: "Unauthorized" });
    if (request.method === "POST" && url.pathname === "/internal/invitations") {
      return json(response, 201, await registerInvitation(JSON.parse(await readBody(request))));
    }
    if (request.method === "GET" && url.pathname === "/internal/actions") return json(response, 200, { actions: listPendingActions() });
    const match = url.pathname.match(/^\/internal\/actions\/([^/]+)\/complete$/);
    if (request.method === "POST" && match) {
      const action = completeAction(match[1], JSON.parse((await readBody(request)) || "{}"));
      return action ? json(response, 200, action) : json(response, 404, { error: "Not found" });
    }
    return json(response, 404, { error: "Not found" });
  } catch (error) {
    console.error(error);
    return json(response, error.message === "Payload too large" ? 413 : 500, { error: "Internal server error" });
  }
});

server.listen(port, "0.0.0.0", () => console.log(`LINE webhook listening on port ${port}`));
