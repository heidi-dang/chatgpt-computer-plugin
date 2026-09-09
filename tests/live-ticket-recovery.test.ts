import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  const [version, iv, ciphertext, tag] = ticket.split(".");
  const ciphertextBytes = Buffer.from(ciphertext, "base64url");
  ciphertextBytes[0] ^= 0x01;
  const tampered = [version, iv, ciphertextBytes.toString("base64url"), tag].join(".");

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

  let oldReason: string | undefined;
  assert.equal(registry.claim("prompt-session", oldViewer, (reason) => { oldClosed += 1; oldReason = reason; }), "accepted");
  assert.equal(registry.claim("prompt-session", newViewer, () => { newClosed += 1; }), "replaced");
  assert.equal(oldClosed, 1, "mounting a newer Workbench must close the older stream");
  assert.equal(oldReason, "superseded", "evicted older viewer receives superseded reason");
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

test("live revocation survives restart and is visible to a second store", () => {
  const directory = mkdtempSync(join(tmpdir(), "cptr-live-ticket-state-"));
  const stateDbPath = join(directory, "live-tickets.sqlite");
  let now = 10_000;
  try {
    const before = new LiveTicketStore({
      ticketSecret: SECRET,
      stateDbPath,
      ttlMs: 5_000,
      renewGraceMs: 5_000,
      now: () => now,
    });
    const issued = before.issue({ targetType: "task", targetId: "task-restart-revoked" });
    before.revoke(issued.ticket);
    before.close();

    const restarted = new LiveTicketStore({
      ticketSecret: SECRET,
      stateDbPath,
      ttlMs: 5_000,
      renewGraceMs: 5_000,
      now: () => now,
    });
    const replica = new LiveTicketStore({
      ticketSecret: SECRET,
      stateDbPath,
      ttlMs: 5_000,
      renewGraceMs: 5_000,
      now: () => now,
    });
    assert.equal(restarted.validate(issued.ticket), null);
    assert.equal(restarted.renew(issued.ticket), null);
    assert.equal(replica.validate(issued.ticket), null);
    assert.equal(replica.renew(issued.ticket), null);
    restarted.close();
    replica.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("durable ticket generation prevents stale replay across instances", () => {
  const directory = mkdtempSync(join(tmpdir(), "cptr-live-ticket-generation-"));
  const stateDbPath = join(directory, "live-tickets.sqlite");
  let now = 20_000;
  try {
    const first = new LiveTicketStore({
      ticketSecret: SECRET,
      stateDbPath,
      ttlMs: 5_000,
      renewGraceMs: 5_000,
      now: () => now,
    });
    const second = new LiveTicketStore({
      ticketSecret: SECRET,
      stateDbPath,
      ttlMs: 5_000,
      renewGraceMs: 5_000,
      now: () => now,
    });
    const issued = first.issue({ targetType: "task", targetId: "task-generation" });
    const renewed = first.renew(issued.ticket);
    assert.ok(renewed);
    // A replica that still caches generation 0 must accept the exact durable
    // generation 1 ticket immediately; it must not require an old-ticket probe
    // to evict its stale local cache first.
    assert.ok(second.validate(renewed!.ticket));
    assert.equal(second.validate(issued.ticket), null);
    const converged = second.renew(issued.ticket);
    assert.ok(converged);
    assert.equal(converged!.ticket, renewed!.ticket);
    first.close();
    second.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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
