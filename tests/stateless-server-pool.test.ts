import assert from "node:assert/strict";
import test from "node:test";
import { StatelessServerPool } from "../server/stateless-server-pool.js";

test("stateless server pool prewarms isolated single-use instances", async () => {
  let nextId = 0;
  const pool = new StatelessServerPool(() => ({ id: ++nextId }), 2);

  assert.deepEqual(pool.snapshot(), {
    target_size: 2,
    available: 2,
    created: 2,
    hits: 0,
    misses: 0,
  });

  const first = pool.take();
  const second = pool.take();
  const burst = pool.take();

  assert.equal(first.pooled, true);
  assert.equal(second.pooled, true);
  assert.equal(burst.pooled, false);
  assert.notEqual(first.value.id, second.value.id);
  assert.notEqual(first.value.id, burst.value.id);
  assert.equal(pool.snapshot().available, 0);
  assert.equal(pool.snapshot().hits, 2);
  assert.equal(pool.snapshot().misses, 1);

  pool.scheduleReplenish();
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  const snapshot = pool.snapshot();
  assert.equal(snapshot.available, 2);
  assert.equal(snapshot.created, 5);

  const replacement = pool.take();
  assert.equal(replacement.pooled, true);
  assert.notEqual(replacement.value.id, first.value.id);
  assert.notEqual(replacement.value.id, second.value.id);
});

test("stateless server pool is bounded and supports disabling prewarm", () => {
  let created = 0;
  const disabled = new StatelessServerPool(() => ++created, 0);
  assert.equal(disabled.snapshot().available, 0);
  assert.equal(disabled.take().pooled, false);
  assert.equal(created, 1);

  const bounded = new StatelessServerPool(() => ++created, 1000);
  assert.equal(bounded.snapshot().target_size, 16);
  assert.equal(bounded.snapshot().available, 16);
});
