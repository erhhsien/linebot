import http from "node:http";
import { handleWebhook } from "./app.js";

const port = Number(process.env.PORT || 3000);

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);

  if (request.method === "GET" && url.pathname === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
    return;
  }

  if (request.method !== "POST" || url.pathname !== "/webhook") {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) {
      response.writeHead(413);
      response.end("Payload too large");
      return;
    }
    chunks.push(chunk);
  }

  try {
    const result = await handleWebhook(
      Buffer.concat(chunks).toString("utf8"),
      request.headers["x-line-signature"],
    );
    response.writeHead(result.status, { "content-type": "text/plain; charset=utf-8" });
    response.end(result.body);
  } catch (error) {
    console.error(error);
    response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    response.end("Internal server error");
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`LINE webhook listening on port ${port}`);
});
