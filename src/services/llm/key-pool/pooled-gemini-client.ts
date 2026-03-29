/**
 * PooledGeminiClient
 *
 * Provides the same acquire/release pattern as PooledOpenAIClient, but for
 * the Gemini REST API which is called with a plain API key in the query string
 * rather than an SDK client object.
 *
 * Usage:
 *   const client = getPooledGeminiClient();
 *   const data = await client.withKey(async (apiKey) => {
 *     const res = await fetch(`...?key=${apiKey}`, { ... });
 *     if (!res.ok) throw new GeminiHttpError(res.status, await res.text());
 *     return res.json();
 *   });
 */

import type { KeyPool } from "./key-pool.js";
import { getKeyPool } from "./key-pool-factory.js";

// ---------------------------------------------------------------------------
// Typed error so classify can inspect HTTP status without string-matching
// ---------------------------------------------------------------------------

export class GeminiHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GeminiHttpError";
  }
}

// ---------------------------------------------------------------------------
// PooledGeminiClient
// ---------------------------------------------------------------------------

export class PooledGeminiClient {
  private readonly configPool?: KeyPool;

  constructor(pool?: KeyPool) {
    this.configPool = pool;
  }

  /**
   * Acquire a Gemini API key from the pool, call `fn` with it, then release
   * the slot with the correct outcome.
   *
   * The caller is responsible for throwing a `GeminiHttpError` on non-2xx
   * responses so the pool can classify rate-limit vs transient errors.
   */
  async withKey<T>(fn: (apiKey: string) => Promise<T>): Promise<T> {
    const pool = this.configPool ?? await getKeyPool("gemini");
    const acquired = await pool.acquire();

    try {
      const result = await fn(acquired.key);
      pool.release(acquired.slotId, "success");
      return result;
    } catch (err) {
      pool.release(acquired.slotId, classifyGeminiError(err));
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton
// ---------------------------------------------------------------------------

let _instance: PooledGeminiClient | null = null;

/** Return the shared PooledGeminiClient (created on first call). */
export function getPooledGeminiClient(): PooledGeminiClient {
  _instance ??= new PooledGeminiClient();
  return _instance;
}

/** Reset the singleton — useful in tests.  */
export function resetPooledGeminiClient(): void {
  _instance = null;
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

function classifyGeminiError(err: unknown): "rate-limit" | "error" {
  if (err instanceof GeminiHttpError) {
    // 429 = quota / rate limit
    if (err.status === 429) return "rate-limit";
    // 503 / 502 / 504 are transient infrastructure errors — count as error
    // but not rate-limit (no need for a long cooldown)
    return "error";
  }

  // Fallback: inspect message strings for cases where the caller re-wraps
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (
      msg.includes("429") ||
      msg.includes("rate limit") ||
      msg.includes("quota exceeded") ||
      msg.includes("resource_exhausted")
    ) {
      return "rate-limit";
    }
  }

  return "error";
}
