import { ProviderError } from "./errors.js";

export interface RetryPolicy {
  /** HTTP statuses that trigger a retry. Network errors always retry. */
  statuses: number[];
  /** Total attempts, including the first one. */
  maxAttempts: number;
  /** Delay before the 2nd attempt; doubles each time, capped at maxDelayMs. */
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = {
  statuses: [408, 429, 500, 502, 503, 504],
  maxAttempts: 3,
  baseDelayMs: 2_000,
  maxDelayMs: 60_000,
};

export type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Deterministic exponential backoff (no jitter): retries are infrastructure,
 * not experiment randomness, but keeping them deterministic keeps logs
 * comparable between runs.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy,
  sleep: Sleep = realSleep,
): Promise<T> {
  let attempt = 1;
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      const retryable =
        error instanceof ProviderError &&
        (error.retryable || (error.status !== undefined && policy.statuses.includes(error.status)));
      if (!retryable || attempt >= policy.maxAttempts) throw error;
      const delay = Math.min(policy.baseDelayMs * 2 ** (attempt - 1), policy.maxDelayMs);
      await sleep(delay);
      attempt++;
    }
  }
}
