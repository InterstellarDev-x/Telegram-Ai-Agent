/**
 * PooledOpenAIClient
 *
 * Drop-in replacement for createOpenAIClient().
 * Every call to withKey() automatically:
 *   1. Acquires the best available API key from the pool
 *   2. Creates an OpenAI SDK instance scoped to that key
 *   3. Runs the caller's function
 *   4. Classifies the outcome and releases the slot:
 *        HTTP 429 / quota errors  → "rate-limit"  (triggers cooldown)
 *        Other errors             → "error"        (increments failure count)
 *        Clean return             → "success"      (resets failure streak)
 */

import OpenAI from "openai";
import type { KeyPool } from "./key-pool.js";
import { getKeyPool } from "./key-pool-factory.js";

export class PooledOpenAIClient {
  private readonly configPool?: KeyPool;

  constructor(pool?: KeyPool) {
    this.configPool = pool;
  }

  /**
   * Acquire a key slot, build an OpenAI client for that key, call `fn`,
   * then release the slot — regardless of success or failure.
   */
  async withKey<T>(fn: (client: OpenAI) => Promise<T>): Promise<T> {
    const pool = this.configPool ?? await getKeyPool("openai");
    const acquired = await pool.acquire();
    const client = new OpenAI({ apiKey: acquired.key });

    try {
      const result = await fn(client);
      pool.release(acquired.slotId, "success");
      return result;
    } catch (err) {
      pool.release(acquired.slotId, classifyOpenAIError(err));
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton (mirrors the existing createOpenAIClient pattern)
// ---------------------------------------------------------------------------

let _instance: PooledOpenAIClient | null = null;

/** Return the shared PooledOpenAIClient (created on first call). */
export function getPooledOpenAIClient(): PooledOpenAIClient {
  _instance ??= new PooledOpenAIClient();
  return _instance;
}

/** Reset the singleton — useful in tests. */
export function resetPooledOpenAIClient(): void {
  _instance = null;
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

function classifyOpenAIError(err: unknown): "rate-limit" | "error" {
  // OpenAI SDK typed errors
  if (err instanceof OpenAI.RateLimitError) return "rate-limit";
  if (err instanceof OpenAI.APIError && err.status === 429) return "rate-limit";

  // Fallback: inspect message strings (e.g. from wrapped/proxied errors)
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (
      msg.includes("rate limit") ||
      msg.includes("rate_limit") ||
      msg.includes("too many requests") ||
      msg.includes("quota") ||
      msg.includes("429")
    ) {
      return "rate-limit";
    }
  }

  return "error";
}
