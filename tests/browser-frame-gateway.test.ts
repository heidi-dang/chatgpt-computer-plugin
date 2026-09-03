import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PromptBrowserFrameGateway } from "../server/browser-frame-gateway.js";
import { PromptTerminalStore } from "../server/prompt-terminal.js";

class FakeResponse extends EventEmitter {
  statusCode = 0;
  headers: Record<string, string> = {};
  body: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  writableEnded = false;
  destroyed = false;
  writeHead(status: number, headers: Record<string, string> = {}) {
    this.statusCode = status;
    this.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]));
    return this;
  }
  end(value?: string | Buffer) {
    if (value !== undefined) this.body = Buffer.isBuffer(value) ? value : Buffer.from(value);
    this.writableEnded = true;
    return this;
  }
}

test("browser frame gateway proxies only prompt-bound browser sessions", async () => {
  const store = new PromptTerminalStore({ streamingEnabled: true });
  const metadata = store.open();
  store.append(metadata.ticket, {
    type: "browser.surface",
    payload: { action: "open_session", session_id: "brs_1", device_id: "bdv_1", state: "OBSERVING" },
  });
  const seen: Array<{ sessionId: string; after?: string }> = [];
  const client = {
    getUserChromeFrame: async (sessionId: string, after?: string) => {
      seen.push({ sessionId, ...(after ? { after } : {}) });
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: {
          "content-type": "image/jpeg",
          "x-cptr-frame-id": "frm_2",
          "x-cptr-frame-width": "640",
          "x-cptr-frame-height": "480",
        },
      });
    },
  };
  const gateway = new PromptBrowserFrameGateway(client as never, store);
  const response = new FakeResponse();
  const request = {
    method: "GET",
    url: "/live/prompt/browser-frame?session_id=brs_1&after_frame_id=frm_1",
    headers: { authorization: `Bearer ${metadata.ticket}` },
  };

  await gateway.handle(request as never, response as never);

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["content-type"], "image/jpeg");
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers["x-cptr-frame-id"], "frm_2");
  assert.deepEqual([...response.body], [1, 2, 3]);
  assert.deepEqual(seen, [{ sessionId: "brs_1", after: "frm_1" }]);

  const denied = new FakeResponse();
  await gateway.handle({
    method: "GET",
    url: "/live/prompt/browser-frame?session_id=brs_other",
    headers: { authorization: `Bearer ${metadata.ticket}` },
  } as never, denied as never);
  assert.equal(denied.statusCode, 403);
  assert.equal(seen.length, 1);
});
