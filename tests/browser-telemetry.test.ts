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

test("leaves non-sensitive non-user-Chrome tool telemetry unchanged", () => {
  const input = { workspace_id: "ws-1", path: "README.md" };
  assert.equal(telemetryInputForTool("cptr_code_read_file", input), input);
});
