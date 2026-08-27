import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { LiveGateway } from "../server/live-gateway.js";
import { LiveTicketStore } from "../server/live-tickets.js";

test("keeps a default ticket valid beyond one bounded live-stream interval", () => {
  let now = 1_000;
  const store = new LiveTicketStore({ now: () => now });
  const issued = store.issue({ targetType: "task", targetId: "task-1" });
  now += 10 * 60_000 + 1;

  assert.ok(store.validate(issued.ticket, { targetType: "task", targetId: "task-1" }));
  assert.equal(issued.expiresAt - 1_000, 15 * 60_000);
});


test("issues a short-lived ticket bound to one target", () => {
  const store = new LiveTicketStore({ now: () => 1_000, ttlMs: 5_000 });
  const issued = store.issue({ targetType: "task", targetId: "task-1" });

  assert.equal(store.validate(issued.ticket, { targetType: "task", targetId: "task-1" })?.targetId, "task-1");
  assert.equal(store.validate(issued.ticket, { targetType: "task", targetId: "task-2" }), null);
  assert.equal(issued.streamUrl.includes(issued.ticket), false);
});

test("command tickets are bound to both command and workspace identity", () => {
  const store = new LiveTicketStore({ now: () => 1_000, ttlMs: 5_000 });
  const issued = store.issue({ targetType: "command", targetId: "cmd-1", workspaceId: "ws-1" });

  assert.equal(issued.workspaceId, "ws-1");
  assert.ok(store.validate(issued.ticket, { targetType: "command", targetId: "cmd-1", workspaceId: "ws-1" }));
  assert.equal(store.validate(issued.ticket, { targetType: "command", targetId: "cmd-1", workspaceId: "ws-2" }), null);
  assert.equal(store.validate(issued.ticket, { targetType: "command", targetId: "cmd-2", workspaceId: "ws-1" }), null);
});

test("expired tickets are rejected", () => {
  let now = 1_000;
  const store = new LiveTicketStore({ now: () => now, ttlMs: 5_000 });
  const issued = store.issue({ targetType: "monitor", targetId: "mon-1" });
  now = 6_001;
  assert.equal(store.validate(issued.ticket, { targetType: "monitor", targetId: "mon-1" }), null);
});

test("renews the same target without invoking an MCP UI tool", () => {
  let now = 1_000;
  const store = new LiveTicketStore({
    now: () => now,
    ttlMs: 5_000,
    renewGraceMs: 2_000,
    streamUrl: "https://plugin.test/live/stream",
    snapshotUrl: "https://plugin.test/live/snapshot",
    renewUrl: "https://plugin.test/live/renew",
  });
  const issued = store.issue({ targetType: "command", targetId: "cmd-1", workspaceId: "ws-1" });
  now = 6_500;

  const renewed = store.renew(issued.ticket);

  assert.ok(renewed);
  assert.notEqual(renewed?.ticket, issued.ticket);
  assert.equal(renewed?.targetType, "command");
  assert.equal(renewed?.targetId, "cmd-1");
  assert.equal(renewed?.workspaceId, "ws-1");
  assert.equal(renewed?.renewUrl, "https://plugin.test/live/renew");
  assert.equal(store.validate(issued.ticket), null);
  assert.ok(store.validate(renewed!.ticket, { targetType: "command", targetId: "cmd-1", workspaceId: "ws-1" }));
});

test("rejects renewal after the bounded grace window", () => {
  let now = 1_000;
  const store = new LiveTicketStore({ now: () => now, ttlMs: 5_000, renewGraceMs: 2_000 });
  const issued = store.issue({ targetType: "task", targetId: "task-1" });
  now = 8_001;
  assert.equal(store.renew(issued.ticket), null);
});

test("prunes expired tickets and bounds retained ticket state", () => {
  let now = 1_000;
  const store = new LiveTicketStore({ now: () => now, ttlMs: 1_000, maxTickets: 2 });
  store.issue({ targetType: "task", targetId: "task-1" });
  store.issue({ targetType: "task", targetId: "task-2" });
  assert.equal(store.size, 2);
  store.issue({ targetType: "task", targetId: "task-3" });
  assert.equal(store.size, 2);
  now = 2_001;
  assert.equal(store.size, 0);
});

test("forwards a target-bound cursor without exposing the ticket in the URL", async () => {
  const store = new LiveTicketStore({ now: () => 1_000, ttlMs: 5_000 });
  const issued = store.issue({ targetType: "task", targetId: "task-1" });
  let seen: { targetType: string; targetId: string; after: number } | undefined;
  const gateway = new LiveGateway({
    streamLive: async (targetType: "task" | "monitor", targetId: string, after: number) => {
      seen = { targetType, targetId, after };
      return new Response("event: shell.stdout\nid: 8\ndata: {}\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    },
  } as never, store);
  const request = Object.assign(new EventEmitter(), {
    url: "/live/stream?ticket=must-not-be-used",
    headers: { authorization: `Bearer ${issued.ticket}`, "last-event-id": "7" },
  });
  const chunks: Buffer[] = [];
  const response = {
    writeHead(status: number, headers: Record<string, string>) { this.status = status; this.headers = headers; },
    write(chunk: Buffer) { chunks.push(chunk); },
    end() { this.ended = true; },
    status: 0,
    headers: {} as Record<string, string>,
    ended: false,
  };

  await gateway.handle(request as never, response as never);

  assert.deepEqual(seen, { targetType: "task", targetId: "task-1", after: 7 });
  assert.equal(response.status, 200);
  assert.equal(response.ended, true);
  assert.match(Buffer.concat(chunks).toString(), /shell\.stdout/);
});

test("rejects a stream without a bearer ticket", async () => {
  const gateway = new LiveGateway({ streamLive: async () => new Response("unused") } as never, new LiveTicketStore());
  const request = Object.assign(new EventEmitter(), { url: "/live/stream", headers: {} });
  const response = {
    writeHead(status: number) { this.status = status; },
    end() { this.ended = true; },
    status: 0,
    ended: false,
  };
  await gateway.handle(request as never, response as never);
  assert.equal(response.status, 404);
  assert.equal(response.ended, true);
});

test("releases capacity when a backpressured client disconnects", async () => {
  const store = new LiveTicketStore({ ttlMs: 5_000 });
  const issued = store.issue({ targetType: "task", targetId: "task-1" });
  let cancelCount = 0;
  let streamCount = 0;
  const client = {
    streamLive: async () => {
      streamCount += 1;
      if (streamCount > 1) {
        let reads = 0;
        return {
          ok: true,
          body: {
            getReader() {
              return {
                async read() {
                  reads += 1;
                  return reads === 1
                    ? { done: false, value: new TextEncoder().encode("data: x\n\n") }
                    : { done: true, value: undefined };
                },
                async cancel() {},
                releaseLock() {},
              };
            },
          },
        };
      }
      return {
        ok: true,
        body: {
          getReader() {
            return {
              async read() { return { done: false, value: new TextEncoder().encode("data: x\n\n") }; },
              async cancel() { cancelCount += 1; },
              releaseLock() {},
            };
          },
        },
      };
    },
  };
  const gateway = new LiveGateway(
    client as never,
    store,
    { maxConcurrent: 1 },
  );
  const request = Object.assign(new EventEmitter(), {
    url: "/live/stream",
    headers: { authorization: `Bearer ${issued.ticket}` },
    destroyed: false,
  });
  const response = Object.assign(new EventEmitter(), {
    destroyed: false,
    writeHead() {},
    write() { return false; },
    end() {},
    once: EventEmitter.prototype.once,
    removeListener: EventEmitter.prototype.removeListener,
  });
  const running = gateway.handle(request as never, response as never);
  await new Promise((resolve) => setImmediate(resolve));
  request.emit("close");
  await running;
  assert.ok(cancelCount >= 1);

  const secondTicket = store.issue({ targetType: "task", targetId: "task-2" });
  const secondRequest = Object.assign(new EventEmitter(), {
    url: "/live/stream",
    headers: { authorization: `Bearer ${secondTicket.ticket}` },
    destroyed: false,
  });
  const secondResponse = Object.assign(new EventEmitter(), {
    destroyed: false,
    writeHead() {},
    write() { return true; },
    end() {},
    once: EventEmitter.prototype.once,
    removeListener: EventEmitter.prototype.removeListener,
  });
  const second = gateway.handle(secondRequest as never, secondResponse as never);
  await new Promise((resolve) => setImmediate(resolve));
  secondRequest.emit("close");
  await second;
});


test("renews a live session over the data-only HTTP gateway", async () => {
  const store = new LiveTicketStore({
    ttlMs: 5_000,
    renewGraceMs: 5_000,
    renewUrl: "https://plugin.test/live/renew",
  });
  const issued = store.issue({ targetType: "task", targetId: "task-1" });
  const gateway = new LiveGateway({} as never, store);
  const request = Object.assign(new EventEmitter(), {
    method: "POST",
    url: "/live/renew",
    headers: { authorization: `Bearer ${issued.ticket}` },
  });
  const response = {
    status: 0,
    body: "",
    writeHead(status: number) { this.status = status; },
    end(body?: string) { this.body = body ?? ""; },
  };

  await gateway.handleRenew(request as never, response as never);

  assert.equal(response.status, 200);
  const renewed = JSON.parse(response.body) as { ticket?: string; targetType?: string; targetId?: string; renewUrl?: string };
  assert.ok(renewed.ticket);
  assert.notEqual(renewed.ticket, issued.ticket);
  assert.equal(renewed.targetType, "task");
  assert.equal(renewed.targetId, "task-1");
  assert.equal(renewed.renewUrl, "https://plugin.test/live/renew");
});

test("returns a target-bound live snapshot without exposing the ticket", async () => {
  const store = new LiveTicketStore({ ttlMs: 5_000, snapshotUrl: "https://plugin.test/live/snapshot" });
  const issued = store.issue({ targetType: "task", targetId: "task-1" });
  let requestArgs: unknown[] = [];
  const gateway = new LiveGateway({
    getLiveSnapshot: async (...args: unknown[]) => {
      requestArgs = args;
      return { target: "task", snapshot: { status: "RUNNING" }, replay: { last_sequence: 4, events: [] } };
    },
  } as never, store);
  const request = Object.assign(new EventEmitter(), {
    url: "/live/snapshot?after=3",
    headers: { authorization: `Bearer ${issued.ticket}` },
  });
  const response = {
    status: 0,
    body: "",
    writeHead(status: number) { this.status = status; },
    end(body?: string) { this.body = body ?? ""; },
  };

  await gateway.handleSnapshot(request as never, response as never);

  assert.equal(response.status, 200);
  assert.deepEqual(requestArgs, ["task", "task-1", 3]);
  assert.match(response.body, /RUNNING/);
  assert.equal(response.body.includes(issued.ticket), false);
});

test("routes command live snapshots with the ticket-bound workspace identity", async () => {
  const store = new LiveTicketStore({ ttlMs: 5_000, snapshotUrl: "https://plugin.test/live/snapshot" });
  const issued = store.issue({ targetType: "command", targetId: "cmd-1", workspaceId: "ws-1" });
  let requestArgs: unknown[] = [];
  const gateway = new LiveGateway({
    getLiveSnapshot: async (...args: unknown[]) => {
      requestArgs = args;
      return { target: "command", snapshot: { status: "RUNNING" }, replay: { last_sequence: 2, events: [] } };
    },
  } as never, store);
  const request = Object.assign(new EventEmitter(), {
    url: "/live/snapshot?after=1",
    headers: { authorization: `Bearer ${issued.ticket}` },
  });
  const response = {
    status: 0,
    body: "",
    writeHead(status: number) { this.status = status; },
    end(body?: string) { this.body = body ?? ""; },
  };

  await gateway.handleSnapshot(request as never, response as never);

  assert.equal(response.status, 200);
  assert.deepEqual(requestArgs, ["command", "cmd-1", 1, "ws-1"]);
  assert.equal(response.body.includes(issued.ticket), false);
});
