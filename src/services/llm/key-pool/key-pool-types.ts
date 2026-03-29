/**
 * Pooled Multi-Account LLM Key Rotation — Shared Types
 */

// ---------------------------------------------------------------------------
// Key slot health & state
// ---------------------------------------------------------------------------

/**
 * healthy   — slot is available for requests
 * cooling   — temporarily back off (rate-limit or transient error)
 * disabled  — disabled after too many consecutive failures; staff can re-enable
 *             via POST /pool/reset.  Does NOT imply permanent credential loss.
 */
export type KeyHealth = "healthy" | "cooling" | "disabled";

export interface KeySlot {
  /** Stable identifier, e.g. "openai-0", "gemini-1" */
  id: string;
  provider: "openai" | "gemini";
  /** The actual API key string */
  key: string;
  /** Current health state */
  status: KeyHealth;
  /** Epoch ms: when this key's cooldown expires (0 if not cooling) */
  cooldownUntil: number;
  /** Number of failures in the current failure streak */
  consecutiveFailures: number;
  /** Total requests dispatched through this slot */
  totalRequests: number;
  /** Total successful responses from this slot */
  totalSuccesses: number;
  /** Epoch ms of the most recent request (0 = never used) */
  lastUsedAt: number;
  /** Whether the slot is currently executing a request */
  inFlight: boolean;
}

// ---------------------------------------------------------------------------
// Scheduling policies
// ---------------------------------------------------------------------------

/**
 * round-robin       — cycle through healthy keys in order (default-safe)
 * healthy-lru       — pick the healthy key used least recently (great for
 *                     spreading load after cooldown recovery)
 * least-used        — pick healthy key with fewest lifetime requests
 * weighted-random   — random pick weighted inversely to request count
 * lowest-failure-rate — pick healthy key with best success ratio
 */
export type SchedulingPolicy =
  | "round-robin"
  | "healthy-lru"
  | "least-used"
  | "weighted-random"
  | "lowest-failure-rate";

// ---------------------------------------------------------------------------
// Pool configuration
// ---------------------------------------------------------------------------

export interface KeyPoolConfig {
  /** Base cooldown after a rate-limit hit, in ms */
  cooldownMs: number;
  /**
   * Multiplier per consecutive failure for exponential back-off.
   * Effective cooldown = cooldownMs * (backoffMultiplier ^ (consecutiveFailures - 1))
   */
  backoffMultiplier: number;
  /** Maximum cooldown regardless of backoff */
  maxCooldownMs: number;
  /** After this many consecutive errors the slot is marked disabled */
  maxConsecutiveFailures: number;
  /** How often the recovery ticker checks for cooled-down keys, in ms */
  tickIntervalMs: number;
  /** Key selection policy */
  policy: SchedulingPolicy;
  /**
   * How long a queued waiter will wait for a healthy key before its promise
   * rejects with a timeout error.  Set to 0 to disable (wait forever — not
   * recommended for production).
   */
  queueTimeoutMs: number;
}

/**
 * Sensible defaults that work for a single-key pool.
 * The factory applies provider-specific overrides on top of these.
 */
export const DEFAULT_KEY_POOL_CONFIG: KeyPoolConfig = {
  cooldownMs: 60_000,
  backoffMultiplier: 2,
  maxCooldownMs: 600_000,
  maxConsecutiveFailures: 5,
  tickIntervalMs: 1_000,
  policy: "healthy-lru",
  queueTimeoutMs: 30_000,
};

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

export type ReleaseOutcome = "success" | "rate-limit" | "error";

// ---------------------------------------------------------------------------
// Stats snapshot
// ---------------------------------------------------------------------------

export interface KeySlotStats {
  id: string;
  provider: "openai" | "gemini";
  status: KeyHealth;
  /** Seconds remaining in cooldown (0 if healthy/disabled) */
  cooldownSecondsRemaining: number;
  consecutiveFailures: number;
  totalRequests: number;
  totalSuccesses: number;
  successRate: number;
  lastUsedAt: number | null;
  inFlight: boolean;
}

export interface PoolStats {
  provider: "openai" | "gemini";
  policy: SchedulingPolicy;
  totalKeys: number;
  healthyKeys: number;
  coolingKeys: number;
  disabledKeys: number;
  queuedWaiters: number;
  keys: KeySlotStats[];
}
