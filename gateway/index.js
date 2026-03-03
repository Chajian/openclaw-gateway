// OpenClaw Gateway - placeholder entry point
// TODO: implement Telegram/Feishu/Discord → LLM routing

import { createServer } from "node:http";

const PORT = process.env.PORT || 3000;

const server = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "openclaw-gateway" }));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("OpenClaw Gateway is running. Configure your bot tokens in .env to get started.");
});

server.listen(PORT, () => {
  console.log(`[openclaw-gateway] listening on port ${PORT}`);
});
