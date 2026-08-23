import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { clientFromEnvironment } from "./client/computer-client.js";
import { createMcpServer } from "./mcp.js";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? "8787");
const mcpPath = "/mcp";
const client = clientFromEnvironment();

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${host}:${port}`}`);
  if (url.pathname === mcpPath && req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept, Mcp-Session-Id",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    }).end();
    return;
  }
  if (url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "ok" }));
    return;
  }
  if (url.pathname !== mcpPath || !req.method || !["GET", "POST", "DELETE"].includes(req.method)) {
    res.writeHead(404).end("Not Found");
    return;
  }

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept, Mcp-Session-Id");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
  const server = createMcpServer(client);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (error) {
    console.error("MCP request failed", error instanceof Error ? error.message : "unknown error");
    if (!res.headersSent) res.writeHead(500).end("Internal server error");
  }
});

httpServer.listen(port, host, () => {
  console.log(`ChatGPT Computer MCP server listening on http://${host}:${port}${mcpPath}`);
});
