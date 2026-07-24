import { LlmProviderError, SchemaValidationError } from "../domain/errors";
import type { LlmCallStats, LlmClient, LlmResponse, StructuredRequest } from "./client";
import { FIXTURES, type Fixture } from "./fixtures";

/**
 * Fixture-backed client. It exists so the whole system — every CLI command and
 * every test — runs with no API key and no network. Reviewers can evaluate the
 * architecture without credentials, and tests never depend on model behaviour.
 *
 * Fixture responses are validated against the same zod schema as live output,
 * so a stale fixture fails loudly rather than quietly serving the wrong shape.
 */
export function createMockLlmClient(fixtures: readonly Fixture[] = FIXTURES): LlmClient {
  const stats: LlmCallStats = { calls: 0, inputTokens: 0, outputTokens: 0 };

  function selectFixture(input: StructuredRequest<unknown>): Fixture {
    // Keyword scoring looks at the question only. The system prompt carries the
    // whole fact sheet, whose field names would otherwise swamp the signal.
    const question = input.userPrompt.toLowerCase();
    const role = input.systemPrompt.toLowerCase();

    const candidates = fixtures.filter((fixture) => {
      if (fixture.purpose !== input.purpose) return false;
      // The agent marker lives in the department prompt, so a finance request
      // can never be served an HR fixture.
      return fixture.agent === undefined || role.includes(`${fixture.agent} agent`);
    });

    if (candidates.length === 0) {
      throw new LlmProviderError(
        `Offline mode has no ${input.purpose} fixture for this request. Record one, or run with LLM_PROVIDER=anthropic.`,
      );
    }

    const scored = candidates.map((fixture) => ({
      fixture,
      score: fixture.match.filter((term) => question.includes(term)).length,
    }));

    const best = scored.reduce((leader, entry) => (entry.score > leader.score ? entry : leader));
    if (best.score > 0) return best.fixture;

    const fallback = candidates.find((fixture) => fixture.fallback);
    if (fallback) return fallback;

    throw new LlmProviderError(
      `Offline mode has no matching ${input.purpose} fixture for this question.`,
    );
  }

  return {
    async generateStructured<T>(input: StructuredRequest<T>): Promise<LlmResponse<T>> {
      const fixture = selectFixture(input as StructuredRequest<unknown>);
      const parsed = input.schema.safeParse(fixture.response);

      if (!parsed.success) {
        throw new SchemaValidationError(
          `Fixture "${fixture.id}" no longer satisfies its output schema. Re-record it.`,
        );
      }

      stats.calls += 1;
      return { data: parsed.data, usage: { inputTokens: 0, outputTokens: 0 }, model: "mock" };
    },

    async generateText(): Promise<string> {
      throw new LlmProviderError("Offline mode serves structured fixtures only.");
    },

    getStats(): LlmCallStats {
      return { ...stats };
    },
  };
}
