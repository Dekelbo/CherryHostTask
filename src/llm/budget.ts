import { TokenBudgetExceededError } from "../domain/errors";
import type { LlmCallStats, LlmClient, LlmResponse, StructuredRequest } from "./client";

/**
 * Enforces a cumulative token budget for the process.
 *
 * A budget that is only *reported* is not a budget. This wrapper refuses the
 * next call once the ceiling is reached, so a runaway loop or an unexpectedly
 * expensive fan-out stops rather than quietly spending. It wraps any
 * `LlmClient`, so the policy is provider-agnostic and lives in one place.
 *
 * In production the same wrapper is where a per-tenant or per-employee cap
 * would attach, keyed on the caller rather than the process.
 */
export function createBudgetedClient(inner: LlmClient, maxTokens: number): LlmClient {
  function assertWithinBudget(): void {
    const { inputTokens, outputTokens } = inner.getStats();
    const used = inputTokens + outputTokens;

    if (used >= maxTokens) {
      throw new TokenBudgetExceededError(
        `The token budget for this run has been reached (${used.toLocaleString("en-US")} of ${maxTokens.toLocaleString("en-US")} tokens). Raise LLM_TOKEN_BUDGET or start a new run.`,
      );
    }
  }

  return {
    async generateStructured<T>(input: StructuredRequest<T>): Promise<LlmResponse<T>> {
      assertWithinBudget();
      return inner.generateStructured(input);
    },

    async generateText(input): Promise<string> {
      assertWithinBudget();
      return inner.generateText(input);
    },

    getStats(): LlmCallStats {
      return inner.getStats();
    },
  };
}

/** Tokens still available, for display in `--explain`. */
export function remainingTokens(client: LlmClient, maxTokens: number): number {
  const { inputTokens, outputTokens } = client.getStats();
  return Math.max(0, maxTokens - (inputTokens + outputTokens));
}
