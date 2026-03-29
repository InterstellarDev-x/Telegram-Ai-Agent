/**
 * KeyPool factory — builds pools from the Prisma Database (ApiCredential).
 *
 * DB Keys: Fetched dynamically per provider ("openai" or "gemini").
 * Env Fallback: OPENAI_API_KEY, OPENAI_API_KEY_2, ... (if ALLOW_ENV_KEY_FALLBACK=true).
 *
 * Provider-specific env overrides:
 *   OPENAI_POOL_COOLDOWN_MS         GEMINI_POOL_COOLDOWN_MS
 *   OPENAI_POOL_MAX_COOLDOWN_MS     GEMINI_POOL_MAX_COOLDOWN_MS
 *   OPENAI_POOL_BACKOFF_MULTIPLIER  GEMINI_POOL_BACKOFF_MULTIPLIER
 *   OPENAI_POOL_MAX_FAILURES        GEMINI_POOL_MAX_FAILURES
 *   OPENAI_POOL_QUEUE_TIMEOUT_MS    GEMINI_POOL_QUEUE_TIMEOUT_MS
 *   OPENAI_POOL_POLICY              GEMINI_POOL_POLICY
 *
 * OpenAI and Gemini have deliberately different default configs because
 * their rate-limit windows and failure semantics differ.
 */

import { KeyPool } from "./key-pool.js";
import { prisma } from "../../storage/prisma.js";
import type { KeyPoolConfig, KeySlot, SchedulingPolicy } from "./key-pool-types.js";

// ---------------------------------------------------------------------------
// Provider-specific sensible defaults
// ---------------------------------------------------------------------------

/**
 * OpenAI: shorter base cooldown (rate limits often reset within a minute),
 * moderate backoff, round-robin by default for simplicity.
 */
const OPENAI_DEFAULTS: KeyPoolConfig = {
  cooldownMs: 60_000,
  backoffMultiplier: 2,
  maxCooldownMs: 300_000,   // 5 min ceiling
  maxConsecutiveFailures: 5,
  tickIntervalMs: 1_000,
  policy: "healthy-lru",
  queueTimeoutMs: 30_000,
};

/**
 * Gemini: longer base cooldown (free-tier limits can be per-minute but also
 * per-day; back off more conservatively) and a stricter failure threshold.
 */
const GEMINI_DEFAULTS: KeyPoolConfig = {
  cooldownMs: 90_000,
  backoffMultiplier: 2.5,
  maxCooldownMs: 600_000,   // 10 min ceiling
  maxConsecutiveFailures: 4,
  tickIntervalMs: 2_000,
  policy: "healthy-lru",
  queueTimeoutMs: 30_000,
};

// ---------------------------------------------------------------------------
// Singleton pools — one per provider, lazily created
// ---------------------------------------------------------------------------

let _openaiPoolPromise: Promise<KeyPool> | null = null;
let _geminiPoolPromise: Promise<KeyPool> | null = null;

export function isPoolInitialized(provider: "openai" | "gemini"): boolean {
  if (provider === "openai") return _openaiPoolPromise !== null;
  return _geminiPoolPromise !== null;
}

/** Check if a provider has active credentials in the DB without fetching/storing a full pool. */
export async function checkProviderHasKeys(provider: "openai" | "gemini"): Promise<boolean> {
  try {
    const count = await prisma.apiCredential.count({
      where: { provider, isActive: true },
    });
    if (count > 0) return true;
  } catch {
    // DB error -> fallback check
  }
  
  if (process.env.ALLOW_ENV_KEY_FALLBACK === "true") {
    return Boolean(process.env[primaryEnvKey(provider)]?.trim());
  }
  
  return false;
}

/**
 * Return the singleton KeyPool for the given provider.
 * On first call the pool is built from the current process.env.
 * Subsequent calls return the same instance (configOverride is ignored).
 */
export function getKeyPool(
  provider: "openai" | "gemini",
  configOverride: Partial<KeyPoolConfig> = {},
): Promise<KeyPool> {
  if (provider === "openai") {
    _openaiPoolPromise ??= buildPool("openai", configOverride);
    return _openaiPoolPromise;
  }
  _geminiPoolPromise ??= buildPool("gemini", configOverride);
  return _geminiPoolPromise;
}

/**
 * Destroy cached singletons.  Useful in tests that need a fresh pool,
 * or when credentials are rotated at runtime.
 */
export async function resetPoolSingletons(): Promise<void> {
  if (_openaiPoolPromise) {
    const pool = await _openaiPoolPromise.catch(() => null);
    pool?.destroy();
  }
  _openaiPoolPromise = null;

  if (_geminiPoolPromise) {
    const pool = await _geminiPoolPromise.catch(() => null);
    pool?.destroy();
  }
  _geminiPoolPromise = null;
}

// ---------------------------------------------------------------------------
// Internal builders
// ---------------------------------------------------------------------------

async function buildPool(
  provider: "openai" | "gemini",
  configOverride: Partial<KeyPoolConfig>,
): Promise<KeyPool> {
  const slots = await collectSlots(provider);
  if (slots.length === 0) {
    const hint = process.env.ALLOW_ENV_KEY_FALLBACK === "true" 
      ? `Add credentials via /admin/api-keys or set ${primaryEnvKey(provider)}.`
      : `Add credentials via POST /admin/api-keys.`;
      
    throw new Error(
      `[KeyPool] No API keys found for provider "${provider}". ${hint}`
    );
  }

  const providerDefaults = provider === "openai" ? OPENAI_DEFAULTS : GEMINI_DEFAULTS;
  const envConfig = readEnvConfig(provider);
  const config: KeyPoolConfig = { ...providerDefaults, ...envConfig, ...configOverride };

  return new KeyPool(slots, config);
}

/** 
 * First reads active credentials from the Database.
 * If the DB returns nothing for this provider (or is completely unavailable),
 * it returns an operational error, UNLESS ALLOW_ENV_KEY_FALLBACK=true.
 */
async function collectSlots(provider: "openai" | "gemini"): Promise<KeySlot[]> {
  const slots: KeySlot[] = [];

  try {
    const records = await prisma.apiCredential.findMany({
      where: { provider, isActive: true },
      orderBy: { createdAt: "asc" },
    });

    if (records.length > 0) {
      for (const record of records) {
        if (!record.apiKey.trim()) continue;
        slots.push({
          id: `${provider}-db-${record.id}`,
          provider,
          key: record.apiKey.trim(),
          status: "healthy",
          cooldownUntil: 0,
          consecutiveFailures: 0,
          totalRequests: 0,
          totalSuccesses: 0,
          lastUsedAt: 0,
          inFlight: false,
        });
      }
      return slots; // Found DB records, skip env vars
    }
    console.warn(`[KeyPoolFactory] DB returned 0 active keys for ${provider}.`);
  } catch (err) {
    console.error(`[KeyPoolFactory] DB connection failed while fetching ${provider} keys:`, err);
  }

  if (process.env.ALLOW_ENV_KEY_FALLBACK !== "true") {
    // We treat DB as the single source of truth by default.
    return [];
  }

  console.warn(`[KeyPoolFactory] DB keys absent/failed. ALLOW_ENV_KEY_FALLBACK=true, scanning env vars...`);

  // --- Env Var Fallback ---
  const primary = primaryEnvKey(provider);
  const primaryValue = process.env[primary]?.trim();
  if (primaryValue) slots.push(makeSlot(provider, 0, primaryValue));

  for (let n = 2; n <= 50; n++) {
    const value = process.env[`${primary}_${n}`]?.trim();
    if (value) slots.push(makeSlot(provider, n - 1, value));
  }

  return slots;
}

function makeSlot(
  provider: "openai" | "gemini",
  index: number,
  key: string,
): KeySlot {
  return {
    id: `${provider}-${index}`,
    provider,
    key,
    status: "healthy",
    cooldownUntil: 0,
    consecutiveFailures: 0,
    totalRequests: 0,
    totalSuccesses: 0,
    lastUsedAt: 0,
    inFlight: false,
  };
}

/** Read provider-namespaced env overrides, e.g. OPENAI_POOL_COOLDOWN_MS */
function readEnvConfig(provider: "openai" | "gemini"): Partial<KeyPoolConfig> {
  const prefix = provider === "openai" ? "OPENAI_POOL" : "GEMINI_POOL";
  const cfg: Partial<KeyPoolConfig> = {};

  const cooldownMs = Number(process.env[`${prefix}_COOLDOWN_MS`]);
  if (Number.isFinite(cooldownMs) && cooldownMs > 0) cfg.cooldownMs = cooldownMs;

  const maxCooldown = Number(process.env[`${prefix}_MAX_COOLDOWN_MS`]);
  if (Number.isFinite(maxCooldown) && maxCooldown > 0) cfg.maxCooldownMs = maxCooldown;

  const backoffMul = Number(process.env[`${prefix}_BACKOFF_MULTIPLIER`]);
  if (Number.isFinite(backoffMul) && backoffMul >= 1) cfg.backoffMultiplier = backoffMul;

  const maxFailures = Number(process.env[`${prefix}_MAX_FAILURES`]);
  if (Number.isInteger(maxFailures) && maxFailures > 0) cfg.maxConsecutiveFailures = maxFailures;

  const queueTimeout = Number(process.env[`${prefix}_QUEUE_TIMEOUT_MS`]);
  if (Number.isFinite(queueTimeout) && queueTimeout >= 0) cfg.queueTimeoutMs = queueTimeout;

  const policy = process.env[`${prefix}_POLICY`] as SchedulingPolicy | undefined;
  const validPolicies: SchedulingPolicy[] = [
    "round-robin",
    "healthy-lru",
    "least-used",
    "weighted-random",
    "lowest-failure-rate",
  ];
  if (policy && validPolicies.includes(policy)) cfg.policy = policy;

  return cfg;
}

function primaryEnvKey(provider: "openai" | "gemini"): string {
  return provider === "openai" ? "OPENAI_API_KEY" : "GEMINI_API_KEY";
}
