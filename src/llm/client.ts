import type { ZodType } from "zod";

/**
 * The provider abstraction. Business logic depends on this interface and never
 * on a vendor SDK, which is what makes the offline fixture client a drop-in
 * substitute rather than a test-only hack.
 */

/** Selects the model tier. Routing is cheap and frequent; analysis is not. */
export type LlmPurpose = "routing" | "analysis" | "coordination";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface StructuredRequest<T> {
  systemPrompt: string;
  userPrompt: string;
  schema: ZodType<T>;
  purpose: LlmPurpose;
  maxTokens?: number;
  /** Constraints appended on a repair retry after a failed verification. */
  repairInstructions?: string[];
}

export interface LlmResponse<T> {
  data: T;
  usage: TokenUsage;
  model: string;
}

/** Cumulative call accounting, surfaced by `--explain`. */
export interface LlmCallStats {
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

export interface LlmClient {
  generateStructured<T>(input: StructuredRequest<T>): Promise<LlmResponse<T>>;
  generateText(input: {
    systemPrompt: string;
    userPrompt: string;
    purpose: LlmPurpose;
  }): Promise<string>;
  getStats(): LlmCallStats;
}
