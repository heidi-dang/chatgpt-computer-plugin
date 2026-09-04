from pathlib import Path

index = Path("server/index.ts")
source = index.read_text()

replacements = [
    (
        'import { isInitializeRequest } from "@modelcontextprotocol/server";',
        'import { createMcpHandler, isInitializeRequest, isLegacyRequest } from "@modelcontextprotocol/server";',
    ),
    (
        'import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";',
        'import { NodeStreamableHTTPServerTransport, toNodeHandler, toWebRequest } from "@modelcontextprotocol/node";',
    ),
    (
        '"Access-Control-Allow-Headers": "Content-Type, Authorization, Accept, Mcp-Session-Id, MCP-Protocol-Version",',
        '"Access-Control-Allow-Headers": "Content-Type, Authorization, Accept, Mcp-Session-Id, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Param",',
    ),
    (
        'res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept, Mcp-Session-Id, MCP-Protocol-Version");',
        'res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept, Mcp-Session-Id, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Param");',
    ),
    (
        """const statelessServerPool = new StatelessServerPool(
  createSessionServer,
  Number.isFinite(configuredStatelessPoolSize) ? configuredStatelessPoolSize : 2,
);""",
        """const statelessServerPool = new StatelessServerPool(
  createSessionServer,
  Number.isFinite(configuredStatelessPoolSize) ? configuredStatelessPoolSize : 2,
);

// createMcpHandler is the explicit MCP 2026-07-28 serving entry. Legacy 2025
// sessionful traffic remains on the established transport path below.
const modernMcpHandler = createMcpHandler(() => createSessionServer(), {
  legacy: "reject",
  onerror: (error) => {
    console.error("MCP 2026 handler failed", error.message);
  },
});
const modernMcpNodeHandler = toNodeHandler(modernMcpHandler, {
  onerror: (error) => {
    console.error("MCP 2026 Node adapter failed", error.message);
  },
});""",
    ),
    (
        """  try {
    const sessionHeader = Array.isArray(req.headers["mcp-session-id"])""",
        """  try {
    const parsedPostBody = req.method === "POST" ? await readJsonBody(req) : undefined;
    const classificationRequest = await toWebRequest(req, parsedPostBody?.value);
    const legacyRequest = await isLegacyRequest(classificationRequest, parsedPostBody?.value);
    if (!legacyRequest) {
      const trafficClient = trafficClientFromRequest(req, parsedPostBody?.value);
      await handleWithTraffic(
        req,
        res,
        {
          body: parsedPostBody?.value,
          requestBytes: parsedPostBody?.bytes ?? null,
          sessionId: null,
          client: trafficClient,
          requestStartedAt,
        },
        async () => {
          await modernMcpNodeHandler(req, res, parsedPostBody?.value);
        },
      );
      return;
    }

    const sessionHeader = Array.isArray(req.headers["mcp-session-id"])""",
    ),
    (
        """      const parsed = req.method === "POST"
        ? await readJsonBody(req)
        : { value: undefined, bytes: 0 };""",
        """      const parsed = req.method === "POST"
        ? parsedPostBody ?? { value: undefined, bytes: 0 }
        : { value: undefined, bytes: 0 };""",
    ),
    (
        """    if (req.method === "POST") {
      const parsed = await readJsonBody(req);""",
        """    if (req.method === "POST") {
      const parsed = parsedPostBody ?? { value: undefined, bytes: 0 };""",
    ),
    (
        """  await Promise.all([...mcpSessions.keys()].map((sessionId) => closeMcpSession(sessionId)));
  nativeOAuthServer?.close();""",
        """  await Promise.all([...mcpSessions.keys()].map((sessionId) => closeMcpSession(sessionId)));
  await modernMcpHandler.close().catch(() => undefined);
  nativeOAuthServer?.close();""",
    ),
]

for old, new in replacements:
    if old not in source:
        raise SystemExit(f"expected index.ts repair anchor missing: {old[:100]!r}")
    source = source.replace(old, new, 1)

index.write_text(source)

schemas = Path("server/schemas/tools.ts")
schema_source = schemas.read_text()
old = "payload: z.record(z.unknown()).default({}),"
new = "payload: z.record(z.string(), z.unknown()).default({}),"
if old not in schema_source:
    raise SystemExit("expected Zod v4 repair anchor missing")
schemas.write_text(schema_source.replace(old, new, 1))
