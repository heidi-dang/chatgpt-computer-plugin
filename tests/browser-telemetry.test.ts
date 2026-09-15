import assert from "node:assert/strict";
import test from "node:test";
import { telemetryInputForTool } from "../server/browser-telemetry.js";

test("redacts sensitive paired user Chrome inputs before activity telemetry", () => {
  const sanitized = telemetryInputForTool("cptr_user_chrome", {
    action: "command",
    session_id: "brs-1",
    command_id: "cmd-1",
    pairing_code: "039185",
    expression: "document.cookie + ' top-secret-browser-expression'",
    payload: {
      ref: "ref_1",
      text: "correct horse battery staple",
      expression: "document.cookie + ' top-secret-browser-expression'",
      approval_token: "approval-secret-token",
      value: "selected-secret",
    },
  });
  const json = JSON.stringify(sanitized);
  assert.match(json, /brs-1/);
  assert.match(json, /ref_1/);
  assert.match(json, /REDACTED_BROWSER/);
  assert.match(json, /REDACTED_PAIRING_CODE/);
  assert.equal(json.includes("039185"), false);
  assert.equal(json.includes("top-secret-browser-expression"), false);
  assert.equal(json.includes("approval-secret-token"), false);
  assert.equal(json.includes("correct horse battery staple"), false);
  assert.equal(json.includes("selected-secret"), false);
});

test("redacts approved secret materialization payloads before activity telemetry", () => {
  const sanitized = telemetryInputForTool("cptr_code", {
    action: "materialize_secret",
    payload: {
      workspace_id: "ws-1",
      path: ".env",
      secret: "PASSWORD=synthetic-test-secret",
      workbench_session_id: "wbs_1234567890abcdef",
      user_approval: "allow:secret-write",
    },
  });
  const json = JSON.stringify(sanitized);
  assert.match(json, /materialize_secret/);
  assert.match(json, /ws-1/);
  assert.match(json, /\.env/);
  assert.match(json, /REDACTED_SECRET_INPUT/);
  assert.equal(json.includes("synthetic-test-secret"), false);
});

test("redacts arbitrary command and file mutation bodies from activity telemetry", () => {
  const command = JSON.stringify(telemetryInputForTool("cptr_command", {
    action: "run",
    payload: {
      workspace_id: "ws-1",
      command: "curl -H 'Authorization: Bearer synthetic-command-token' https://example.invalid",
      stdin: "synthetic-stdin-secret",
      cwd: ".",
      wait_seconds: 0,
    },
  }));
  assert.match(command, /ws-1/);
  assert.match(command, /REDACTED_ACTIVITY_INPUT/);
  assert.equal(command.includes("synthetic-command-token"), false);
  assert.equal(command.includes("synthetic-stdin-secret"), false);

  const write = JSON.stringify(telemetryInputForTool("cptr_code", {
    action: "write",
    payload: {
      workspace_id: "ws-1",
      path: "src/config.ts",
      content: "export const token = 'synthetic-file-secret';",
    },
  }));
  assert.match(write, /src\/config\.ts/);
  assert.equal(write.includes("synthetic-file-secret"), false);

  const edit = JSON.stringify(telemetryInputForTool("cptr_code", {
    action: "edit",
    payload: {
      workspace_id: "ws-1",
      path: "src/config.ts",
      target: "old-sensitive-value",
      replacement: "new-sensitive-value",
    },
  }));
  assert.equal(edit.includes("old-sensitive-value"), false);
  assert.equal(edit.includes("new-sensitive-value"), false);
});

test("redacts prompts, queries, goals and browser typed text while retaining routing metadata", () => {
  const cases = [
    ["cptr_memory", { action: "search", workspace_id: "ws-1", query: "private-memory-query" }],
    ["cptr_agent_task", { action: "start", payload: { workspace_id: "ws-1", prompt: "private-delegated-prompt" } }],
    ["cptr_agent_monitor", { action: "start", payload: { workspace_id: "ws-1", goal: "private-monitor-goal" } }],
    ["cptr_chrome_browser", { action: "type", workspace_id: "ws-1", ref: "ref_1", text: "private-browser-text" }],
  ] as const;
  for (const [tool, input] of cases) {
    const json = JSON.stringify(telemetryInputForTool(tool, input));
    assert.match(json, /ws-1/);
    assert.match(json, /REDACTED_ACTIVITY_INPUT/);
    assert.equal(json.includes("private-"), false);
  }
});

test("preserves non-sensitive identifiers and paths while projecting telemetry", () => {
  const input = { workspace_id: "ws-1", path: "README.md", worker_id: "worker-1" };
  assert.deepEqual(telemetryInputForTool("cptr_code_read_file", input), input);
});
