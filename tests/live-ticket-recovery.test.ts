import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { LiveGateway } from "../server/live-gateway.js";
import { LiveTicketCodec } from "../server/live-ticket-codec.js";
import { LiveTicketStore } from "../server/live-tickets.js";
import { LiveViewerRegistry, liveViewerIdentity } from "../server/live-viewers.js";

const SECRET = "test-live-ticket-secret-that-is-stable-across-restarts";

test("sealed live tickets survive a process restart without exposing target claims", () => {
  let now = 1_000;
  const before = new LiveTicketStore({ ticketSecret: SECRET, ttlMs: 5_000, renewGraceMs: 5_000, now: () => now });
  const issued = before.issue({ targetType: "command", targetId: "cmd-restart", workspaceId: "ws-restart" });

  assert.equal(issued.ticket.includes("cmd-restart"), false);
  assert.equal(issued.ticket.includes("ws-restart"), false);

  const after = new LiveTicketStore({ ticketSecret: SECRET, ttlMs: 5_000, renewGraceMs: 5_000, now: () => now });
  assert.ok(after.validate(issued.ticket, { targetType: "command", targetId: "cmd-restart", workspaceId: "ws-restart" }));

  now = issued.expiresAt + 1;
  const renewed = after.renew(issued.ticket);
  assert.ok(renewed, "a restarted server must be able to renew the still-authorized sealed capability");
  assert.notEqual(renewed?.ticket, issued.ticket);
});

test("live renewal is idempotent for duplicate stale-card requests", () => {
  const store = new LiveTicketStore({ ticketSecret: SECRET, ttlMs: 5_000, renewGraceMs: 5_000 });
  const issued = store.issue({ targetType: "task", targetId: "task-idempotent" });

  const first = store.renew(issued.ticket);
  const duplicate = store.renew(issued.ticket);

  assert.ok(first?.ticket);
  assert.equal(duplicate?.ticket, first?.ticket, "duplicate renewals must converge on one current generation");
});

test("tampered or cross-kind sealed capabilities fail closed", () => {
  const codec = new LiveTicketCodec(SECRET);
  const ticket = codec.seal("live", { targetId: "hidden" });
  const last = ticket.at(-1) ?? "A";
  const tampered = `${ticket.slice(0, -1)}${last === "A" ? "B" : "A"}`;

  assert.deepEqual(codec.open(ticket, "live"), { targetId: "hidden" });
  assert.equal(codec.open(ticket, "prompt"), null);
  assert.equal(codec.open(tampered, "live"), null);
});

test("newest Workbench viewer supersedes older persistent cards and older cards cannot reclaim", () => {
  const registry = new LiveViewerRegistry();
  let oldClosed = 0;
  let newClosed = 0;
  const oldViewer = { id: "old-card", startedAt: 100 };
  const newViewer = { id: "new-card", startedAt: 200 };

  assert.equal(registry.claim("prompt-session", oldViewer, () => { oldClosed += 1; }), "accepted");
  assert.equal(registry.claim("prompt-session", newViewer, () => { newClosed += 1; }), "accepted");
  assert.equal(oldClosed, 1, "mounting a newer Workbench must close the older stream");
  assert.equal(registry.claim("prompt-session", oldViewer, () => { oldClosed += 1; }), "superseded");
  assert.equal(newClosed, 0, "the old card must not evict the newer viewer when it wakes again");
});

test("viewer headers require a bounded id and monotonic mount timestamp", () => {
  const request = {
    headers: {
      "x-cptr-viewer-id": "viewer-123",
      "x-cptr-viewer-started-at": "123456789",
    },
  };
  assert.deepEqual(liveViewerIdentity(request as never), { id: "viewer-123", startedAt: 123456789 });
  assert.equal(liveViewerIdentity({ headers: { "x-cptr-viewer-id": "bad viewer", "x-cptr-viewer-started-at": "1" } } as never), null);
});

test("explicit live revocation cannot be undone by presenting the sealed ticket again", () => {
  const store = new LiveTicketStore({ ticketSecret: SECRET, ttlMs: 5_000, renewGraceMs: 5_000 });
  const issued = store.issue({ targetType: "task", targetId: "task-revoked" });
  store.revoke(issued.ticket);

  assert.equal(store.validate(issued.ticket), null);
  assert.equal(store.renew(issued.ticket), null);
});

test("legacy target snapshot becomes terminal so pre-fix clients stop reconnecting", async () => {
  const gateway = new LiveGateway({} as never, new LiveTicketStore({ ticketSecret: SECRET }));
  const request = Object.assign(new EventEmitter(), {
    method: "GET",
    url: "/live/snapshot?after=23",
    headers: { authorization: "Bearer oldRandomOpaqueTargetTicket" },
  });
  const response = {
    status: 0,
    body: "",
    headers: {} as Record<string, string>,
    writeHead(status: number, headers: Record<string, string>) { this.status = status; this.headers = headers; },
    end(body?: string) { this.body = body ?? ""; },
  };

  await gateway.handleSnapshot(request as never, response as never);

  assert.equal(response.status, 200);
  assert.equal(response.headers["x-cptr-stream-state"], "legacy-retired");
  assert.deepEqual(JSON.parse(response.body), {
    snapshot: { status: "BLOCKED" },
    replay: { events: [], last_sequence: 23 },
  });
});
