export type StatelessPoolSnapshot = {
  target_size: number;
  available: number;
  created: number;
  hits: number;
  misses: number;
};

/**
 * Bounded pool for unconnected, single-use MCP servers.
 *
 * A server is never returned to the pool after it has been connected to a
 * transport. This preserves per-request transport isolation while moving the
 * expensive tool/resource registration work off the stateless request path.
 */
export class StatelessServerPool<T> {
  private readonly factory: () => T;
  private readonly targetSize: number;
  private readonly available: T[] = [];
  private created = 0;
  private hits = 0;
  private misses = 0;

  constructor(factory: () => T, targetSize: number) {
    this.factory = factory;
    this.targetSize = Math.max(0, Math.min(16, Math.floor(targetSize)));
    this.replenish();
  }

  take(): { value: T; pooled: boolean } {
    const pooled = this.available.pop();
    if (pooled !== undefined) {
      this.hits += 1;
      return { value: pooled, pooled: true };
    }
    this.misses += 1;
    return { value: this.create(), pooled: false };
  }

  replenish(): void {
    while (this.available.length < this.targetSize) {
      this.available.push(this.create());
    }
  }

  scheduleReplenish(): void {
    queueMicrotask(() => this.replenish());
  }

  snapshot(): StatelessPoolSnapshot {
    return {
      target_size: this.targetSize,
      available: this.available.length,
      created: this.created,
      hits: this.hits,
      misses: this.misses,
    };
  }

  private create(): T {
    this.created += 1;
    return this.factory();
  }
}
