import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PromptBrowserInputGateway } from "../server/browser-input-gateway.js";
import { PromptTerminalStore } from "../server/prompt-terminal.js";

class FakeResponse extends EventEmitter {
  statusCode = 0;
  headers: Record<string, string> = {};
  body = "";
  writableEnded = false;
  writeHead(status: number, headers: Record<string, string> = {}) {
    this.statusCode = status;
    this.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]));
    return this;
  }
  end(value?: string | Buffer) {
    if (value !== undefined) this.body = Buffer.isBuffer(value) ? value.toString("utf8") : value;
    this.writableEnded = true;
    return this;
  }
}

function requestWithBody(ticket: string, body: Record<string, unknown>, path = "/live/prompt/browser-input") {
  const request = new EventEmitter() as EventEmitter & AsyncIterable<Buffer> & { method: string; url: string; headers: Record<string, string> };
  request.method = "POST";
  request.url = path;
  request.headers = { authorization: `Bearer ${ticket}` };
  request[Symbol.asyncIterator] = async function* () {
    yield Buffer.from(JSON.stringify(body));
  };
  return request;
}

test("browser input gateway forwards only prompt-bound normalized human input", async () => {
  const store = new PromptTerminalStore({ streamingEnabled: true });
  const metadata = store.open();
  store.append(metadata.ticket, {
    type: "browser.surface",
    payload: { action: "transfer_lease", session_id: "brs_1", state: "HUMAN_CONTROL", owner: "human", epoch: 10 },
  });
  const seen: Array<{ sessionId: string; input: Record<string, unknown> }> = [];
  const client = {
    sendUserChromeHumanInput: async (sessionId: string, input: Record<string, unknown>) => {
      seen.push({ sessionId, input });
      return { accepted: true, command_id: input.command_id };
    },
  };
  const gateway = new PromptBrowserInputGateway(client as never, store);
  const response = new FakeResponse();
  await gateway.handle(requestWithBody(metadata.ticket, {
    session_id: "brs_1",
    command_id: "human_1",
    expected_epoch: 10,
    input_type: "pointer_move",
    x: 0.25,
    y: 0.75,
    pointer_id: 2,
  }) as never, response as never);

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.sessionId, "brs_1");
  assert.equal(seen[0]?.input.expected_epoch, 10);
  assert.equal(seen[0]?.input.x, 0.25);

  const denied = new FakeResponse();
  await gateway.handle(requestWithBody(metadata.ticket, {
    session_id: "brs_other",
    command_id: "human_2",
    expected_epoch: 10,
    input_type: "click",
    x: 0.5,
    y: 0.5,
  }) as never, denied as never);
  assert.equal(denied.statusCode, 403);
  assert.equal(seen.length, 1);
});

test("return-to-agent publishes the authoritative browser surface epoch back to the prompt", async () => {
  const store = new PromptTerminalStore({ streamingEnabled: true });
  const metadata = store.open();
  store.append(metadata.ticket, {
    type: "browser.surface",
    payload: { action: "transfer_lease", session_id: "brs_1", state: "HUMAN_CONTROL", owner: "human", epoch: 10 },
  });
  const client = {
    returnUserChromeToAgent: async () => ({
      session_id: "brs_1",
      device_id: "bdv_1",
      state: "AGENT_CONTROL",
      owner: "agent",
      epoch: 11,
      hostname: "Heidi Chrome",
    }),
  };
  const gateway = new PromptBrowserInputGateway(client as never, store);
  const response = new FakeResponse();

  await gateway.handle(requestWithBody(metadata.ticket, {
    session_id: "brs_1",
    expected_epoch: 10,
  }, "/live/prompt/browser-return") as never, response as never);

  assert.equal(response.statusCode, 200);
  const replay = store.replay(metadata.ticket, 0)?.events ?? [];
  const latest = replay.at(-1);
  assert.equal(latest?.type, "browser.surface");
  assert.equal(latest?.payload.action, "return_to_agent");
  assert.equal(latest?.payload.owner, "agent");
  assert.equal(latest?.payload.epoch, 11);
  assert.equal(latest?.payload.state, "AGENT_CONTROL");
});
