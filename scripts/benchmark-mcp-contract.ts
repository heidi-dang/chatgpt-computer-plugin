import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { ComputerClient } from "../server/client/computer-client.js";
import { createMcpServer } from "../server/mcp.js";

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

const computer = new ComputerClient({
  baseUrl: "http://cptr.test",
  token: "benchmark-token",
  fetchImpl: async () => new Response("{}", { status: 200 }),
});
const server = createMcpServer(computer);
const client = new Client({ name: "contract-byte-benchmark", version: "1" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

await Promise.all([
  server.connect(serverTransport),
  client.connect(clientTransport),
]);

try {
  const listed = await client.listTools();
  const descriptionBytes = listed.tools.reduce(
    (total, tool) => total + Buffer.byteLength(tool.description ?? ""),
    0,
  );
  const inputSchemaBytes = listed.tools.reduce(
    (total, tool) => total + jsonBytes(tool.inputSchema),
    0,
  );
  const outputSchemaBytes = listed.tools.reduce(
    (total, tool) => total + jsonBytes(tool.outputSchema ?? null),
    0,
  );

  console.log(JSON.stringify({
    tools: listed.tools.length,
    total_bytes: jsonBytes(listed),
    description_bytes: descriptionBytes,
    input_schema_bytes: inputSchemaBytes,
    output_schema_bytes: outputSchemaBytes,
  }, null, 2));
} finally {
  await Promise.all([client.close(), server.close()]);
}
