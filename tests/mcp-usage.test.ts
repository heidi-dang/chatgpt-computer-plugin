import assert from "node:assert/strict";
import test from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { ComputerClient } from "../server/client/computer-client.js";
import { McpActivityEmitter } from "../server/mcp-activity.js";
import { McpDiagnosticsEmitter } from "../server/mcp-diagnostics.js";
import { mcpRequestContext, normalizeMcpClient } from "../server/mcp-traffic.js";
import { createMcpServer } from "../server/mcp.js";

const usageModule = await import("../server/mcp-usage.js").catch(() => ({} as Record<string, unknown>));

function mockReadResult() {
  return {
    workspace_id: "workspace-1",
    path: "README.md",
    content: "hello",
    start_line: 1,
    end_line: 1,
    total_lines: 1,
    size: 5,
    content_sha256: "a".repeat(64),
  };
}

test("MCP server asks ChatGPT to report the current model on every CPTR call", async () => {
  const computer = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "test-token",
    fetchImpl: async () => new Response(JSON.stringify({}), { status: 200 }),
  });
  const server = createMcpServer(computer);
  const client = new Client({ name: "ChatGPT", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const instructions = client.getInstructions() ?? "";
  assert.match(instructions, /current model/i);
  assert.match(instructions, /every CPTR/i);
  assert.match(instructions, /client_model/);
  assert.match(instructions, /omit .* rather than guessing/i);

  const listed = await client.listTools();
  assert.ok(listed.tools.length > 0);
  for (const tool of listed.tools) {
    const schema = tool.inputSchema as {
      properties?: Record<string, { type?: string; maxLength?: number }>;
      required?: string[];
    };
    assert.equal(schema.properties?.client_model?.type, "string", `${tool.name} must expose client_model`);
    assert.equal(schema.properties?.client_model?.maxLength, 120, `${tool.name} client_model bound`);
    assert.equal(schema.required?.includes("client_model") ?? false, false, `${tool.name} keeps client_model optional`);
    assert.match(tool.description ?? "", /client_model/);
  }

  await client.close();
  await server.close();
});

test("client_model is consumed by the MCP wrapper and never reaches existing handlers", async () => {
  let captured: unknown = null;
  const computer = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "test-token",
    fetchImpl: async () => new Response(JSON.stringify({}), { status: 200 }),
  });
  (computer as unknown as { readCodingFile: (input: unknown) => Promise<ReturnType<typeof mockReadResult>> }).readCodingFile = async (input) => {
    captured = structuredClone(input);
    return mockReadResult();
  };

  const server = createMcpServer(computer);
  const client = new Client({ name: "ChatGPT", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const result = await client.callTool({
    name: "cptr_code_read_file",
    arguments: {
      workspace_id: "workspace-1",
      path: "README.md",
      client_model: "GPT-5.6 Sol",
    },
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(captured, {
    workspace_id: "workspace-1",
    path: "README.md",
    start_line: 0,
    end_line: 0,
  });

  await client.close();
  await server.close();
});

test("reported model normalization is exact and never fuzzy-prices unknown names", () => {
  assert.equal(typeof usageModule.normalizeReportedModel, "function");
  const normalize = usageModule.normalizeReportedModel as (value: unknown) => {
    reported: string | null;
    canonical: string | null;
  };
  assert.deepEqual(normalize("GPT-5.6 Sol"), {
    reported: "GPT-5.6 Sol",
    canonical: "gpt-5.6-sol",
  });
  assert.equal(normalize("gpt-5.6").canonical, "gpt-5.6-sol");
  assert.equal(normalize("GPT-5.6 Sol Pro").canonical, "gpt-5.6-sol-pro");
  assert.equal(normalize("GPT-5.6 Terra").canonical, "gpt-5.6-terra");
  assert.equal(normalize("GPT-5.6 Luna").canonical, "gpt-5.6-luna");
  assert.equal(normalize("mystery-gpt-5.6-special").canonical, null);
  assert.equal(normalize(null).reported, null);
});

test("MCP-visible token estimation is deterministic and discloses byte fallback", () => {
  assert.equal(typeof usageModule.estimateModelTokens, "function");
  assert.equal(typeof usageModule.canonicalToolCallEnvelope, "function");
  const estimate = usageModule.estimateModelTokens as (
    modelId: string | null,
    text: string,
  ) => { tokens: number; method: string; exact_for_model: boolean };
  const envelope = (usageModule.canonicalToolCallEnvelope as (name: string, args: unknown) => string)(
    "cptr_code_read_file",
    { client_model: "GPT-5.6 Sol", path: "README.md", workspace_id: "workspace-1" },
  );
  const first = estimate("gpt-5.6-sol", envelope);
  const second = estimate("gpt-5.6-sol", envelope);
  assert.deepEqual(first, second);
  assert.ok(first.tokens > 0);
  assert.equal(first.exact_for_model, false);

  const oversized = estimate("gpt-5.6-sol", "x".repeat(600_000));
  assert.ok(oversized.tokens > 0);
  assert.equal(oversized.method, "utf8-byte-fallback");
  assert.equal(oversized.exact_for_model, false);
});

test("one terminal Usage event counts original tool arguments but Activity stays metadata-free", async () => {
  const diagnostics: Array<Record<string, unknown>> = [];
  const activity: Array<Record<string, unknown>> = [];
  const diagnosticEmitter = new McpDiagnosticsEmitter({
    batchSize: 10,
    flushMs: 10_000,
    maxQueue: 20,
    deliver: async (events) => {
      diagnostics.push(...events as Array<Record<string, unknown>>);
    },
  });
  const activityEmitter = new McpActivityEmitter({
    batchSize: 10,
    flushMs: 10_000,
    maxQueue: 20,
    deliver: async (events) => {
      activity.push(...events as Array<Record<string, unknown>>);
    },
  });
  const computer = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "test-token",
    fetchImpl: async () => new Response(JSON.stringify({}), { status: 200 }),
  });
  (computer as unknown as { readCodingFile: (input: unknown) => Promise<ReturnType<typeof mockReadResult>> }).readCodingFile = async () => mockReadResult();

  const server = createMcpServer(computer, {
    diagnostics: diagnosticEmitter,
    activityTelemetry: activityEmitter,
  });
  const client = new Client({ name: "ChatGPT", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const originalArguments = {
    workspace_id: "workspace-1",
    path: "README.md",
    client_model: "GPT-5.6 Sol",
  };
  const callResult = await mcpRequestContext.run({
    requestId: "request-usage",
    correlationId: "corr-request-usage",
    sessionId: "session-usage",
    client: normalizeMcpClient({ name: "ChatGPT", version: "1.0.0" }),
    method: "tools/call",
    startedAt: Date.now(),
    requestBytes: 64,
    rawToolArguments: originalArguments,
    outcome: { failed: false, errorCode: null },
  }, () => client.callTool({
    name: "cptr_code_read_file",
    arguments: originalArguments,
  }));
  await Promise.all([diagnosticEmitter.flush(), activityEmitter.flush()]);

  const usage = diagnostics.filter((event) => event.kind === "usage");
  assert.equal(usage.length, 1);
  assert.equal(usage[0].model_reported, "GPT-5.6 Sol");
  assert.equal(usage[0].model_canonical, "gpt-5.6-sol");
  const estimate = usageModule.estimateModelTokens as (
    modelId: string | null,
    text: string,
  ) => { tokens: number; method: string; exact_for_model: boolean };
  const callEnvelope = usageModule.canonicalToolCallEnvelope as (name: string, args: unknown) => string;
  const resultEnvelope = usageModule.canonicalMcpResultEnvelope as (value: unknown) => string;
  const expectedOutput = estimate(
    "gpt-5.6-sol",
    callEnvelope("cptr_code_read_file", originalArguments),
  );
  const expectedInput = estimate("gpt-5.6-sol", resultEnvelope(callResult));
  assert.equal(
    usage[0].input_tokens_estimated,
    expectedInput.tokens,
    "the MCP tool result returned to ChatGPT must count as model input",
  );
  assert.equal(
    usage[0].output_tokens_estimated,
    expectedOutput.tokens,
    "the tool-call envelope must count as model output",
  );
  assert.match(String(usage[0].estimator_method), /^input=.*;output=/);
  assert.equal(usage[0].cached_input_tokens_estimated, null);
  assert.equal(usage[0].status, "complete");
  assert.equal(JSON.stringify(activity).includes("client_model"), false);
  assert.equal(JSON.stringify(diagnostics).includes("README.md"), false);

  await client.close();
  await server.close();
  await Promise.all([diagnosticEmitter.close(), activityEmitter.close()]);
});
