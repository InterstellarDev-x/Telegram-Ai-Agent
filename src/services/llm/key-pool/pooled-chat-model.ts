/**
 * PooledChatModel
 *
 * Drop-in replacement for createOpenAIChatModel().
 *
 * Wraps ChatOpenAI (LangChain) so that each invocation acquires a key from
 * the pool, creates a fresh ChatOpenAI bound to that key, runs the call, and
 * releases the slot with the correct outcome.
 *
 * Usage:
 *   const model = createPooledChatModel({ model: "gpt-4.1", temperature: 0 });
 *   // Use like any BaseLanguageModel / ChatOpenAI
 *   const result = await model.withStructuredOutput(schema).invoke(prompt);
 */

import { ChatOpenAI } from "@langchain/openai";
import type { KeyPool } from "./key-pool.js";
import { getKeyPool } from "./key-pool-factory.js";

export interface PooledChatModelConfig {
  model?: string;
  temperature?: number;
  /** Inject a custom pool (useful in tests). Defaults to the global OpenAI pool. */
  pool?: KeyPool;
}

// ---------------------------------------------------------------------------
// PooledChatModel
// ---------------------------------------------------------------------------

/**
 * A thin proxy that behaves like ChatOpenAI but rotates API keys on every
 * call through the OpenAI key pool.
 *
 * It exposes the two methods that are needed downstream:
 *   - invoke(prompt)
 *   - withStructuredOutput(schema) → { invoke(prompt) }
 */
export class PooledChatModel {
  private readonly configPool?: KeyPool;
  private readonly modelName: string;
  private readonly temperature: number;

  constructor(config: PooledChatModelConfig = {}) {
    this.configPool = config.pool;
    this.modelName = config.model ?? process.env.OPENAI_MODEL ?? "gpt-4.1";
    this.temperature = config.temperature ?? 0;
  }

  /** Direct invocation — returns the raw model response. */
  async invoke(prompt: string): Promise<Awaited<ReturnType<ChatOpenAI["invoke"]>>> {
    return this.withPooledKey((model) => model.invoke(prompt));
  }

  /**
   * Structured-output proxy.  Returns an object whose `invoke` method
   * acquires a key, calls withStructuredOutput on a fresh ChatOpenAI, and
   * releases the key.
   */
  withStructuredOutput(
    schema: Parameters<ChatOpenAI["withStructuredOutput"]>[0],
    options?: Parameters<ChatOpenAI["withStructuredOutput"]>[1],
  ): { invoke: (prompt: string) => Promise<unknown> } {
    return {
      invoke: (prompt: string) =>
        this.withPooledKey((model) =>
          model.withStructuredOutput(schema, options).invoke(prompt),
        ),
    };
  }

  // -------------------------------------------------------------------------
  private async withPooledKey<T>(
    fn: (model: ChatOpenAI) => Promise<T>,
  ): Promise<T> {
    const pool = this.configPool ?? await getKeyPool("openai");
    const acquired = await pool.acquire();
    const model = new ChatOpenAI({
      apiKey: acquired.key,
      model: this.modelName,
      temperature: this.temperature,
    });

    try {
      const result = await fn(model);
      pool.release(acquired.slotId, "success");
      return result;
    } catch (err) {
      pool.release(acquired.slotId, classifyLangChainError(err));
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Factory helper (mirrors createOpenAIChatModel)
// ---------------------------------------------------------------------------

export function createPooledChatModel(
  config: PooledChatModelConfig = {},
): PooledChatModel {
  return new PooledChatModel(config);
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

function classifyLangChainError(err: unknown): "rate-limit" | "error" {
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
