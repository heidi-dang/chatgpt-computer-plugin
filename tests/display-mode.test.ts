import assert from "node:assert/strict";
import test from "node:test";
import { requestHostDisplayMode } from "../web/src/display-mode.js";

test("requests Apps SDK display mode with the current object-shaped contract", async () => {
  let received: unknown;
  const granted = await requestHostDisplayMode({
    requestDisplayMode: async (input) => {
      received = input;
      return { mode: "pip" };
    },
  }, "pip");

  assert.deepEqual(received, { mode: "pip" });
  assert.equal(granted, "pip");
});

test("returns null when the host does not expose display-mode control", async () => {
  assert.equal(await requestHostDisplayMode(undefined, "fullscreen"), null);
});
