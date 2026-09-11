import { createServer } from "node:http";
import { createServerApplication } from "./application.js";

const port = Number(process.env["SHEET_AGENT_SERVER_PORT"] ?? 4000);
const allowedOrigins = new Set((process.env["SHEET_AGENT_ALLOWED_ORIGINS"] ?? "https://localhost:3000").split(",").map((value) => value.trim()));
const app = createServerApplication(process.env);

createServer(async (incoming, outgoing) => {
  const origin = incoming.headers.origin;
  if (origin && !allowedOrigins.has(origin)) { outgoing.writeHead(403).end("Origin denied"); return; }
  const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
  const request = new Request("http://127.0.0.1:" + port + (incoming.url ?? "/"), { method: incoming.method ?? "GET", headers: incoming.headers as HeadersInit, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) });
  const response = await app(request);
  const headers = Object.fromEntries(response.headers.entries());
  if (origin) { headers["access-control-allow-origin"] = origin; headers["vary"] = "Origin"; }
  outgoing.writeHead(response.status, headers); outgoing.end(Buffer.from(await response.arrayBuffer()));
}).listen(port, "127.0.0.1", () => console.log("Sheet Agent server listening on 127.0.0.1:" + port));

