import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { getKeyPool, resetPoolSingletons, isPoolInitialized } from "../src/services/llm/key-pool/key-pool-factory.js";
import { prisma } from "../src/services/storage/prisma.js";

// Mock the prisma dependency globally for this file
mock.module("../src/services/storage/prisma.js", () => {
  return {
    prisma: {
      apiCredential: {
        findMany: mock(),
        count: mock(),
      },
    },
  };
});

describe("KeyPoolFactory Database Integration", () => {
  const originalEnv = process.env;

  beforeEach(async () => {
    // Prevent strict fallback warnings messing up test env values
    process.env = { ...originalEnv, ALLOW_ENV_KEY_FALLBACK: "false" };
    await resetPoolSingletons();
  });

  afterEach(async () => {
    process.env = originalEnv;
    await resetPoolSingletons();
    (prisma.apiCredential.findMany as any).mockClear();
  });

  it("builds a pool asynchronously from the database", async () => {
    // Setup a mock DB response
    (prisma.apiCredential.findMany as any).mockResolvedValueOnce([
      { id: "mock-1", provider: "openai", apiKey: "sk-mock-db-key-1", isActive: true },
      { id: "mock-2", provider: "openai", apiKey: "sk-mock-db-key-2", isActive: true },
    ]);

    expect(isPoolInitialized("openai")).toBe(false);

    const pool = await getKeyPool("openai");
    const stats = pool.getStats();

    expect(isPoolInitialized("openai")).toBe(true);
    expect(stats.totalKeys).toBe(2);
    expect(stats.keys[0]!.id).toBe("openai-db-mock-1");
    expect(stats.keys[1]!.id).toBe("openai-db-mock-2");
    
    // Ensure findMany was called
    expect(prisma.apiCredential.findMany).toHaveBeenCalledTimes(1);
  });

  it("caches the returned promise so concurrent calls only query Prisma once", async () => {
    // DB takes 50ms to resolve
    (prisma.apiCredential.findMany as any).mockImplementationOnce(async () => {
      await Bun.sleep(50);
      return [
        { id: "mock-3", provider: "gemini", apiKey: "gemini-db-1", isActive: true },
      ];
    });

    // Call it simultaneously twice
    const [pool1, pool2] = await Promise.all([
      getKeyPool("gemini"),
      getKeyPool("gemini"),
    ]);

    // The two pools should be the EXACT same instance
    expect(pool1).toBe(pool2);
    expect(pool1.getStats().totalKeys).toBe(1);

    // findMany should strictly only have been executed a single time due to promise caching
    expect(prisma.apiCredential.findMany).toHaveBeenCalledTimes(1);
  });

  it("invalidates the promise cache on resetPoolSingletons", async () => {
    (prisma.apiCredential.findMany as any).mockResolvedValue([
      { id: "k1", provider: "openai", apiKey: "key1", isActive: true },
    ]);

    const pool1 = await getKeyPool("openai");
    expect(pool1.getStats().totalKeys).toBe(1);

    // Call reset
    await resetPoolSingletons();

    // Now if we get the pool again, it should trigger another DB call 
    // and return a completely unassociated pool instance.
    const pool2 = await getKeyPool("openai");
    
    expect(pool2).not.toBe(pool1);
    expect(prisma.apiCredential.findMany).toHaveBeenCalledTimes(2);
  });
});
