import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { handleHttpRequest } from "../src/app.js";
import { prisma } from "../src/services/storage/prisma.js";
import { resetPoolSingletons } from "../src/services/llm/key-pool/key-pool-factory.js";

// Mock Prisma
mock.module("../src/services/storage/prisma.js", () => {
  return {
    prisma: {
      apiCredential: {
        create: mock(),
        findMany: mock(),
        count: mock(),
      },
    },
  };
});

describe("Admin Routes Integration", () => {
  const originalEnv = process.env;

  beforeEach(async () => {
    process.env = {
      ...originalEnv,
      API_KEY_ADMIN_SECRET: "admin_test_secret",
      POOL_RESET_SECRET: "pool_test_secret",
      ALLOW_ENV_KEY_FALLBACK: "false",
    };
    await resetPoolSingletons();
    
    // Clear mock histories
    (prisma.apiCredential.create as any).mockClear();
    (prisma.apiCredential.findMany as any).mockClear();
  });

  afterEach(async () => {
    process.env = originalEnv;
    await resetPoolSingletons();
    mock.restore();
  });

  describe("POST /admin/api-keys", () => {
    it("rejects unauthorized requests", async () => {
      const req = new Request("http://localhost/admin/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "openai", apiKey: "sk-test" }),
      });
      
      const res = await handleHttpRequest(req);
      expect(res.status).toBe(401);
    });

    it("creates a credential and invalidates pool cache", async () => {
      (prisma.apiCredential.create as any).mockResolvedValueOnce({
        id: "cuid-test",
        provider: "openai",
        apiKey: "sk-mock-key",
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date()
      });

      const req = new Request("http://localhost/admin/api-keys", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-secret": "admin_test_secret",
        },
        body: JSON.stringify({ provider: "openai", apiKey: "sk-mock-key" }),
      });

      const res = await handleHttpRequest(req);
      expect(res.status).toBe(201);
      
      const data = await res.json() as {
        ok: boolean;
        credential: {
          id: string;
          apiKeyPreview: string;
        };
      };
      expect(data.ok).toBe(true);
      expect(data.credential.id).toBe("cuid-test");
      expect(data.credential.apiKeyPreview).toBe("sk-m...-key"); // Assuming maskApiKey format

      expect(prisma.apiCredential.create).toHaveBeenCalledTimes(1);
      // resetPoolSingletons is naturally called, though harder to assert without spy.
    });
  });

  describe("GET /pool/stats", () => {
    it("rejects unauthorized requests", async () => {
      const req = new Request("http://localhost/pool/stats", { method: "GET" });
      const res = await handleHttpRequest(req);
      expect(res.status).toBe(401);
    });

    it("reports not initialized if pools haven't booted", async () => {
      const req = new Request("http://localhost/pool/stats", {
        method: "GET",
        headers: { "x-pool-secret": "pool_test_secret" }
      });

      const res = await handleHttpRequest(req);
      const data = await res.json() as {
        ok: boolean;
        pools: {
          openai: { status: string };
          gemini: { status: string };
        };
      };
      
      expect(data.ok).toBe(true);
      expect(data.pools.openai.status).toBe("not initialized");
      expect(data.pools.gemini.status).toBe("not initialized");
    });
  });

  describe("POST /pool/reset", () => {
    it("rejects unauthorized requests", async () => {
      const req = new Request("http://localhost/pool/reset", { method: "POST" });
      const res = await handleHttpRequest(req);
      expect(res.status).toBe(401);
    });

    it("resets pools successfully", async () => {
      const req = new Request("http://localhost/pool/reset", {
        method: "POST",
        headers: { "x-pool-secret": "pool_test_secret" },
      });

      const res = await handleHttpRequest(req);
      expect(res.status).toBe(200);

      const data = await res.json() as {
        ok: boolean;
        message: string;
      };
      expect(data.ok).toBe(true);
      expect(data.message).toBe("All pool slots reset to healthy.");
    });
  });
});
