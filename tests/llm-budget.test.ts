import { describe, expect, it } from "vitest";

import { TokenBudgetExceededError } from "../src/domain/errors";
import { LlmAnalysisSchema } from "../src/domain/schemas";
import { createBudgetedClient, remainingTokens } from "../src/llm/budget";
import type { LlmCallStats, LlmClient, LlmResponse, StructuredRequest } from "../src/llm/client";
import { FIXTURES } from "../src/llm/fixtures";

const analysisFixture = FIXTURES.find((fixture) => fixture.id === "analysis.finance.hiring")!;

/** A client that reports a caller-controlled token spend per call. */
function meteredClient(tokensPerCall: number): LlmClient {
  const stats: LlmCallStats = { calls: 0, inputTokens: 0, outputTokens: 0 };

  return {
    async generateStructured<T>(input: StructuredRequest<T>): Promise<LlmResponse<T>> {
      stats.calls += 1;
      stats.inputTokens += tokensPerCall;
      return {
        data: input.schema.parse(analysisFixture.response),
        usage: { inputTokens: tokensPerCall, outputTokens: 0 },
        model: "metered",
      };
    },
    async generateText(): Promise<string> {
      stats.calls += 1;
      stats.inputTokens += tokensPerCall;
      return "ok";
    },
    getStats() {
      return { ...stats };
    },
  };
}

function request(): StructuredRequest<unknown> {
  return {
    systemPrompt: "finance agent",
    userPrompt: "What is our hiring budget?",
    schema: LlmAnalysisSchema,
    purpose: "analysis",
  };
}

describe("token budget", () => {
  it("allows calls while the budget has room", async () => {
    const client = createBudgetedClient(meteredClient(100), 1_000);

    await expect(client.generateStructured(request())).resolves.toBeDefined();
    await expect(client.generateStructured(request())).resolves.toBeDefined();
  });

  it("refuses the next call once the budget is reached", async () => {
    const client = createBudgetedClient(meteredClient(400), 1_000);

    await client.generateStructured(request());
    await client.generateStructured(request());
    // 800 of 1,000 spent: still under budget.
    await client.generateStructured(request());
    // 1,200 spent: the ceiling is now crossed, so the next call is refused.
    await expect(client.generateStructured(request())).rejects.toBeInstanceOf(
      TokenBudgetExceededError,
    );
  });

  it("stops spending rather than only reporting it", async () => {
    const inner = meteredClient(600);
    const client = createBudgetedClient(inner, 1_000);

    await client.generateStructured(request());
    await client.generateStructured(request());
    await expect(client.generateStructured(request())).rejects.toThrow(TokenBudgetExceededError);

    // The refused call never reached the provider.
    expect(inner.getStats().calls).toBe(2);
  });

  it("applies the budget to plain text calls too", async () => {
    const client = createBudgetedClient(meteredClient(2_000), 1_000);

    await client.generateText({ systemPrompt: "s", userPrompt: "u", purpose: "routing" });
    await expect(
      client.generateText({ systemPrompt: "s", userPrompt: "u", purpose: "routing" }),
    ).rejects.toBeInstanceOf(TokenBudgetExceededError);
  });

  it("reports the remaining allowance without going negative", async () => {
    const inner = meteredClient(400);
    const client = createBudgetedClient(inner, 1_000);

    expect(remainingTokens(client, 1_000)).toBe(1_000);
    await client.generateStructured(request());
    expect(remainingTokens(client, 1_000)).toBe(600);

    await client.generateStructured(request());
    await client.generateStructured(request());
    expect(remainingTokens(client, 1_000)).toBe(0);
  });

  it("reports usage from the wrapped client unchanged", async () => {
    const client = createBudgetedClient(meteredClient(250), 10_000);
    await client.generateStructured(request());

    expect(client.getStats()).toEqual({ calls: 1, inputTokens: 250, outputTokens: 0 });
  });
});
