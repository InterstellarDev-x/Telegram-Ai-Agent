/**
 * KeyPool — core scheduler for multi-account API key rotation.
 *
 * Responsibilities:
 *  - Select the next key according to the configured scheduling policy
 *  - Track in-flight requests per slot
 *  - Apply cooldown + exponential back-off on rate-limit / transient errors
 *  - Mark persistently-failing slots as "disabled" (soft, resettable)
 *  - Queue callers when every key is cooling/disabled, with a configurable
 *    timeout so no request waits forever
 *  - Run a background ticker to recover cooled-down keys automatically
 */

import type {
  KeyPoolConfig,
  KeySlot,
  KeySlotStats,
  PoolStats,
  ReleaseOutcome,
} from "./key-pool-types.js";
import { DEFAULT_KEY_POOL_CONFIG } from "./key-pool-types.js";

// ---------------------------------------------------------------------------
// Acquired handle returned to callers
// ---------------------------------------------------------------------------

export interface AcquiredKey {
  slotId: string;
  key: string;
}

// ---------------------------------------------------------------------------
// Internal waiter entry (with optional timeout handle)
// ---------------------------------------------------------------------------

interface Waiter {
  resolve: (acquired: AcquiredKey) => void;
  reject: (err: Error) => void;
  timeoutHandle: ReturnType<typeof setTimeout> | null;
}

// ---------------------------------------------------------------------------
// KeyPool
// ---------------------------------------------------------------------------

export class KeyPool {
  private readonly slots: KeySlot[];
  private readonly config: KeyPoolConfig;
  private readonly waitQueue: Waiter[] = [];
  private ticker: ReturnType<typeof setInterval> | null = null;
  /** Round-robin cursor (index into healthy pool, not global slots array) */
  private rrCursor = 0;

  constructor(slots: KeySlot[], config: Partial<KeyPoolConfig> = {}) {
    if (slots.length === 0) {
      throw new Error("KeyPool requires at least one key slot.");
    }
    this.slots = slots.map((s) => ({ ...s })); // defensive copy
    this.config = { ...DEFAULT_KEY_POOL_CONFIG, ...config };
    this.startTicker();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Acquire an available key slot.
   *
   * - Resolves immediately when a healthy key is available.
   * - If all keys are cooling, the caller is queued and the promise resolves
   *   once a key recovers — or rejects after `queueTimeoutMs`.
   * - Rejects immediately when every slot is disabled (no recovery possible
   *   without a reset).
   */
  acquire(): Promise<AcquiredKey> {
    const slot = this.pickSlot();
    if (slot) {
      return Promise.resolve(this.markInFlight(slot));
    }

    // All slots are cooling or disabled
    const provider = this.slots[0]?.provider ?? "openai";
    if (this.slots.every((s) => s.status === "disabled")) {
      return Promise.reject(
        new Error(
          `[KeyPool/${provider}] All key slots are disabled. ` +
            `Call POST /pool/reset (with admin secret) to re-enable them.`,
        ),
      );
    }

    // Some slots are still cooling — queue with a timeout guard
    return new Promise<AcquiredKey>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, timeoutHandle: null };

      if (this.config.queueTimeoutMs > 0) {
        waiter.timeoutHandle = setTimeout(() => {
          // Remove this waiter from the queue
          const idx = this.waitQueue.indexOf(waiter);
          if (idx !== -1) this.waitQueue.splice(idx, 1);
          reject(
            new Error(
              `[KeyPool/${provider}] Queue timeout after ` +
                `${this.config.queueTimeoutMs}ms — no healthy key became available.`,
            ),
          );
        }, this.config.queueTimeoutMs);
      }

      this.waitQueue.push(waiter);
    });
  }

  /**
   * Release a slot after a request completes.
   *
   * @param slotId  the id returned by acquire()
   * @param outcome success | rate-limit | error
   */
  release(slotId: string, outcome: ReleaseOutcome): void {
    const slot = this.findSlot(slotId);
    if (!slot) return;

    slot.inFlight = false;

    switch (outcome) {
      case "success":
        slot.totalSuccesses++;
        slot.consecutiveFailures = 0;
        slot.status = "healthy";
        slot.cooldownUntil = 0;
        this.drainQueue();
        break;

      case "rate-limit":
        slot.consecutiveFailures++;
        this.applyCooldown(slot, /* full cooldown */ 1);
        break;

      case "error":
        slot.consecutiveFailures++;
        if (slot.consecutiveFailures >= this.config.maxConsecutiveFailures) {
          // Soft-disable; staff can re-enable via resetAll()
          slot.status = "disabled";
          slot.cooldownUntil = 0;
        } else {
          // Shorter back-off for transient errors (25 % of the rate-limit window)
          this.applyCooldown(slot, 0.25);
        }
        break;
    }
  }

  /** Snapshot of current pool state for observability. */
  getStats(): PoolStats {
    const now = Date.now();
    const healthy = this.slots.filter((s) => s.status === "healthy").length;
    const cooling = this.slots.filter((s) => s.status === "cooling").length;
    const disabled = this.slots.filter((s) => s.status === "disabled").length;

    return {
      provider: this.slots[0]?.provider ?? "openai",
      policy: this.config.policy,
      totalKeys: this.slots.length,
      healthyKeys: healthy,
      coolingKeys: cooling,
      disabledKeys: disabled,
      queuedWaiters: this.waitQueue.length,
      keys: this.slots.map((s) => this.slotToStats(s, now)),
    };
  }

  /**
   * Admin override: return all cooling/disabled slots to healthy and drain
   * the wait queue.  Intended for use after credential rotation or manual ops.
   */
  resetAll(): void {
    for (const slot of this.slots) {
      slot.status = "healthy";
      slot.cooldownUntil = 0;
      slot.consecutiveFailures = 0;
      slot.inFlight = false;
    }
    this.drainQueue();
  }

  /** Tear down the background ticker.  Call when the process is shutting down. */
  destroy(): void {
    if (this.ticker !== null) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
    for (const waiter of this.waitQueue.splice(0)) {
      if (waiter.timeoutHandle !== null) clearTimeout(waiter.timeoutHandle);
      waiter.reject(new Error("[KeyPool] Pool destroyed."));
    }
  }

  // -------------------------------------------------------------------------
  // Scheduling policies
  // -------------------------------------------------------------------------

  private pickSlot(): KeySlot | null {
    // Only consider idle (not in-flight) healthy keys.
    // If every healthy key is currently serving a request, we return null so
    // the caller is queued — this is intentional backpressure.
    // Handing out an already-busy key would let one credential absorb
    // unlimited concurrent requests, defeating the pool's purpose.
    const idle = this.slots.filter((s) => s.status === "healthy" && !s.inFlight);
    if (idle.length === 0) return null;

    switch (this.config.policy) {
      case "round-robin":         return this.roundRobin(idle);
      case "healthy-lru":         return this.healthyLru(idle);
      case "least-used":          return this.leastUsed(idle);
      case "weighted-random":     return this.weightedRandom(idle);
      case "lowest-failure-rate": return this.lowestFailureRate(idle);
      default:                    return this.healthyLru(idle);
    }
  }

  /** Simple rotating cursor across the healthy subset. */
  private roundRobin(pool: KeySlot[]): KeySlot {
    // pool.length is guaranteed > 0 by pickSlot's guard
    const slot = pool[this.rrCursor % pool.length] as KeySlot;
    this.rrCursor = (this.rrCursor + 1) % pool.length;
    return slot;
  }

  /**
   * Healthy-LRU: pick the slot that has been idle the longest.
   * Newly recovered or never-used slots (lastUsedAt = 0) always go first,
   * naturally absorbing load after a cooldown.
   */
  private healthyLru(pool: KeySlot[]): KeySlot {
    // pool[0] is guaranteed to exist
    return pool.reduce(
      (best, curr) => (curr.lastUsedAt < best.lastUsedAt ? curr : best),
      pool[0] as KeySlot,
    );
  }

  private leastUsed(pool: KeySlot[]): KeySlot {
    return pool.reduce(
      (best, curr) => (curr.totalRequests < best.totalRequests ? curr : best),
      pool[0] as KeySlot,
    );
  }

  private weightedRandom(pool: KeySlot[]): KeySlot {
    const weights = pool.map((s) => 1 / (s.totalRequests + 1));
    const total = weights.reduce((a, b) => a + b, 0);
    let rand = Math.random() * total;
    for (let i = 0; i < pool.length; i++) {
      rand -= weights[i] ?? 0;
      if (rand <= 0) return pool[i] as KeySlot;
    }
    return pool[pool.length - 1] as KeySlot;
  }

  private lowestFailureRate(pool: KeySlot[]): KeySlot {
    const failureRate = (s: KeySlot): number =>
      s.totalRequests === 0
        ? 0
        : (s.totalRequests - s.totalSuccesses) / s.totalRequests;
    return pool.reduce(
      (best, curr) => (failureRate(curr) < failureRate(best) ? curr : best),
      pool[0] as KeySlot,
    );
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private markInFlight(slot: KeySlot): AcquiredKey {
    slot.inFlight = true;
    slot.totalRequests++;
    slot.lastUsedAt = Date.now();
    return { slotId: slot.id, key: slot.key };
  }

  private applyCooldown(slot: KeySlot, fraction: number): void {
    const base = this.config.cooldownMs * fraction;
    const backoffFactor = Math.pow(
      this.config.backoffMultiplier,
      Math.max(0, slot.consecutiveFailures - 1),
    );
    const effective = Math.min(base * backoffFactor, this.config.maxCooldownMs);
    slot.cooldownUntil = Date.now() + effective;
    slot.status = "cooling";
  }

  private startTicker(): void {
    this.ticker = setInterval(() => {
      this.recoverCooledSlots();
    }, this.config.tickIntervalMs);

    // Don't prevent the process from exiting just because the ticker is live
    if (
      typeof this.ticker === "object" &&
      this.ticker !== null &&
      "unref" in this.ticker
    ) {
      (this.ticker as NodeJS.Timeout).unref?.();
    }
  }

  private recoverCooledSlots(): void {
    const now = Date.now();
    let recovered = false;
    for (const slot of this.slots) {
      if (slot.status === "cooling" && slot.cooldownUntil <= now) {
        slot.status = "healthy";
        slot.cooldownUntil = 0;
        recovered = true;
      }
    }
    if (recovered) {
      this.drainQueue();
    }
  }

  private drainQueue(): void {
    while (this.waitQueue.length > 0) {
      const slot = this.pickSlot();
      if (!slot) break; // still no healthy key — stay queued

      const waiter = this.waitQueue.shift();
      if (!waiter) break;

      // Cancel the waiter's timeout before resolving
      if (waiter.timeoutHandle !== null) clearTimeout(waiter.timeoutHandle);
      waiter.resolve(this.markInFlight(slot));
    }
  }

  private findSlot(id: string): KeySlot | undefined {
    return this.slots.find((s) => s.id === id);
  }

  private slotToStats(slot: KeySlot, now: number): KeySlotStats {
    const cooldownSecondsRemaining =
      slot.status === "cooling"
        ? Math.max(0, Math.ceil((slot.cooldownUntil - now) / 1_000))
        : 0;
    const successRate =
      slot.totalRequests === 0
        ? 1
        : slot.totalSuccesses / slot.totalRequests;

    return {
      id: slot.id,
      provider: slot.provider,
      status: slot.status,
      cooldownSecondsRemaining,
      consecutiveFailures: slot.consecutiveFailures,
      totalRequests: slot.totalRequests,
      totalSuccesses: slot.totalSuccesses,
      successRate: Math.round(successRate * 10_000) / 10_000,
      lastUsedAt: slot.lastUsedAt > 0 ? slot.lastUsedAt : null,
      inFlight: slot.inFlight,
    };
  }
}
