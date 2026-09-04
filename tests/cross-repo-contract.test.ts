import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { ComputerApiError, ComputerClient } from "../server/client/computer-client.js";

const toolsSource = readFileSync(new URL("../server/schemas/tools.ts", import.meta.url), "utf8");
const clientSource = readFileSync(new URL("../server/client/computer-client.ts", import.meta.url), "utf8");
const stateSource = readFileSync(new URL("../web/src/state.ts", import.meta.url), "utf8");
const indexSource = readFileSync(new URL("../server/index.ts", import.meta.url), "utf8");

test("paired Chrome contract removes pairing codes and uses an explicit browser action enum", () => {
  assert.doesNotMatch(toolsSource, /pairing_code/);
  assert.doesNotMatch(clientSource, /pairing_code/);
  assert.match(toolsSource, /import \{ BROWSER_ACTIONS \} from "\.\.\/browser-contract\.js"/);
  assert.match(toolsSource, /browser_action:\s*z\.enum\(BROWSER_ACTIONS\)\.optional\(\)/);
});

test("mutating paired Chrome commands are rejected before dispatch when expected_epoch is absent", async () => {
  let fetchCalls = 0;
  const client = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "token",
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({ accepted: true }), { status: 200 });
    },
  });

  await assert.rejects(
    client.controlUserChrome({
      action: "command",
      session_id: "brs-1",
      command_id: "cmd-1",
      browser_action: "click",
    }),
    /requires expected_epoch/,
  );
  assert.equal(fetchCalls, 0);
});

test("browser-device structured errors retain normalized code, retryability, field, and message", async () => {
  const client = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "token",
    fetchImpl: async () => new Response(JSON.stringify({
      detail: {
        code: "MEMORY_REQUIRED",
        message: "required CPTR memory context is unavailable",
        retriable: true,
        field: "memory",
      },
    }), { status: 503 }),
  });

  await assert.rejects(
    client.controlUserChrome({ action: "list_devices" }),
    (error: unknown) => error instanceof ComputerApiError
      && error.status === 503
      && error.code === "memory_required"
      && error.retriable === true
      && error.field === "memory"
      && /memory context is unavailable/.test(error.message),
  );
});

test("server and Workbench share one terminal status contract that includes BLOCKED", () => {
  assert.match(clientSource, /TERMINAL_TASK_STATUSES.*shared\/task-status/s);
  assert.match(stateSource, /TERMINAL_TASK_STATUSES.*shared\/task-status/s);
});

test("generic JSON responses do not inject wildcard CORS", () => {
  const writeJson = indexSource.match(/function writeJson[\s\S]*?\n}\n/)?.[0] ?? "";
  assert.doesNotMatch(writeJson, /Access-Control-Allow-Origin[^\n]*\*/);
});
