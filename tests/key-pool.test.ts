import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { KeyPool } from "../src/services/llm/key-pool/key-pool.js";
import type { KeySlot } from "../src/services/llm/key-pool/key-pool-types.js";

describe("KeyPool", () => {
  let pool: KeyPool;

  const createSlots = (count: number, provider: "openai" | "gemini" = "openai"): KeySlot[] => {
    return Array.from({ length: count }, (_, i) => ({
      id: `${provider}-${i}`,
      provider,
      key: `secret-${i}`,
      status: "healthy",
      cooldownUntil: 0,
      consecutiveFailures: 0,
      totalRequests: 0,
      totalSuccesses: 0,
      lastUsedAt: 0,
      inFlight: false,
    }));
  };

  afterEach(() => {
    if (pool) pool.destroy();
  });

  it("acquires idle keys according to healthy-lru policy", async () => {
    pool = new KeyPool(createSlots(2), { policy: "healthy-lru" });

    // Acquire first (openai-0)
    const k1 = await pool.acquire();
    expect(k1.slotId).toBe("openai-0");
    
    // Acquire second (openai-1 should be picked since openai-0 is in-flight)
    const k2 = await pool.acquire();
    expect(k2.slotId).toBe("openai-1");
  });

  it("queues requests when all keys are in-flight", async () => {
    pool = new KeyPool(createSlots(1));

    // Acquire the only key
    const k1 = await pool.acquire();
    expect(k1.slotId).toBe("openai-0");

    // Second acquire should block (promise won't resolve immediately)
    let k2Resolved = false;
    const p2 = pool.acquire().then((k2) => {
      k2Resolved = true;
      return k2;
    });

    // Let microtasks flush
    await Promise.resolve();
    expect(k2Resolved).toBe(false);

    // Release the first one
    pool.release(k1.slotId, "success");

    // Now second should resolve with the same key
    const k2 = await p2;
    expect(k2.slotId).toBe("openai-0");
    expect(k2Resolved).toBe(true);
  });

  it("applies cooldown on rate-limit and recovers", async () => {
    // A quick ticker and short cooldown for testing
    pool = new KeyPool(createSlots(1), {
      cooldownMs: 50,
      tickIntervalMs: 10,
    });

    const k1 = await pool.acquire();
    pool.release(k1.slotId, "rate-limit");

    const stats = pool.getStats();
    expect(stats.coolingKeys).toBe(1);
    const firstKey = stats.keys[0];
    expect(firstKey).toBeDefined();
    expect(firstKey!.status).toBe("cooling");

    // Acquire should now queue since the only key is cooling
    const pWait = pool.acquire();
    
    // Wait for the simulated cooldown to lapse plus ticker interval
    await Bun.sleep(100);

    const k2 = await pWait;
    expect(k2.slotId).toBe("openai-0");
    
    const statsAfter = pool.getStats();
    expect(statsAfter.healthyKeys).toBe(1);
  });

  it("disables a key after maxConsecutiveFailures is reached", async () => {
    pool = new KeyPool(createSlots(1, "gemini"), {
      maxConsecutiveFailures: 3,
    });

    // 1st error
    let k = await pool.acquire();
    pool.release(k.slotId, "error");

    const internalSlots = (pool as unknown as { slots: KeySlot[] }).slots;
    expect(internalSlots[0]).toBeDefined();

    // Clear cooldown to re-acquire immediately without resetting failure count
    internalSlots[0]!.status = "healthy";
    internalSlots[0]!.cooldownUntil = 0;

    // 2nd error
    k = await pool.acquire();
    pool.release(k.slotId, "error");
    
    internalSlots[0]!.status = "healthy";
    internalSlots[0]!.cooldownUntil = 0;

    // 3rd error -> should become disabled
    k = await pool.acquire();
    pool.release(k.slotId, "error");

    const stats = pool.getStats();
    expect(stats.disabledKeys).toBe(1);
    const firstKey = stats.keys[0];
    expect(firstKey).toBeDefined();
    expect(firstKey!.status).toBe("disabled");

    // Further acquires should reject immediately because all slots are disabled
    await expect(pool.acquire()).rejects.toThrow(/All key slots are disabled/);
  });
});
