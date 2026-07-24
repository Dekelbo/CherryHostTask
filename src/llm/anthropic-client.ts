import Anthropic from "@anthropic-ai/sdk";
import { z, type ZodType } from "zod";

import type { Env } from "../config/env";
import {
  ConfigError,
  LlmProviderError,
  LlmTimeoutError,
  SchemaValidationError,
  describeProviderFailure,
} from "../domain/errors";
import type {
  LlmCallStats,
  LlmClient,
  LlmPurpose,
  LlmResponse,
  StructuredRequest,
} from "./client";

/**
 * Anthropic provider. All hardening lives here rather than in callers: timeout,
 * bounded retry with jittered backoff, a concurrency limit, and error mapping
 * that guarantees no raw provider payload or key reaches stdout.
 */

const TOOL_NAME = "submit_analysis";

/** Bounds the parallel `both` route and models the real rate-limit strategy. */
const MAX_CONCURRENT_REQUESTS = 4;

export function createAnthropicClient(env: Env): LlmClient {
  if (!env.ANTHROPIC_API_KEY) {
    throw new ConfigError("ANTHROPIC_API_KEY is required when LLM_PROVIDER=anthropic.");
  }

  const client = new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    // Retries are handled here so backoff and jitter are explicit and testable.
    maxRetries: 0,
    timeout: env.LLM_REQUEST_TIMEOUT_MS,
  });

  const stats: LlmCallStats = { calls: 0, inputTokens: 0, outputTokens: 0 };
  const limit = createLimiter(MAX_CONCURRENT_REQUESTS);

  function record(usage: { input_tokens: number; output_tokens: number }): void {
    stats.calls += 1;
    stats.inputTokens += usage.input_tokens;
    stats.outputTokens += usage.output_tokens;
  }

  async function callStructured<T>(
    input: StructuredRequest<T>,
    extraInstructions: string[],
  ): Promise<{ raw: unknown; usage: Anthropic.Usage; model: string }> {
    const model = modelFor(input.purpose, env);
    const userPrompt = appendInstructions(input.userPrompt, [
      ...(input.repairInstructions ?? []),
      ...extraInstructions,
    ]);

    const message = await limit(() =>
      withRetries(
        () =>
          client.messages.create({
            model,
            max_tokens: input.maxTokens ?? 2048,
            temperature: temperatureFor(input.purpose),
            system: input.systemPrompt,
            messages: [{ role: "user", content: userPrompt }],
            tools: [
              {
                name: TOOL_NAME,
                description: "Return the structured result. Every field is required.",
                input_schema: toToolSchema(input.schema),
              },
            ],
            tool_choice: { type: "tool", name: TOOL_NAME },
          }),
        env.LLM_MAX_RETRIES,
      ),
    );

    const toolUse = message.content.find((block) => block.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") {
      throw new SchemaValidationError("The model did not return a structured result.");
    }

    return { raw: toolUse.input, usage: message.usage, model };
  }

  return {
    async generateStructured<T>(input: StructuredRequest<T>): Promise<LlmResponse<T>> {
      try {
        const first = await callStructured(input, []);
        record(first.usage);

        const parsed = input.schema.safeParse(first.raw);
        if (parsed.success) {
          return { data: parsed.data, usage: toUsage(first.usage), model: first.model };
        }

        // One repair attempt: the schema errors are fed back as explicit constraints.
        const repair = await callStructured(input, [
          "Your previous response did not satisfy the required schema.",
          ...parsed.error.issues.map(
            (issue) => `- ${issue.path.join(".") || "(root)"}: ${issue.message}`,
          ),
          "Return a corrected result that satisfies every field.",
        ]);
        record(repair.usage);

        const repaired = input.schema.safeParse(repair.raw);
        if (!repaired.success) {
          throw new SchemaValidationError(
            "The model could not return a response matching the required structure.",
          );
        }

        return { data: repaired.data, usage: toUsage(repair.usage), model: repair.model };
      } catch (error) {
        throw mapProviderError(error);
      }
    },

    async generateText(input): Promise<string> {
      try {
        const message = await limit(() =>
          withRetries(
            () =>
              client.messages.create({
                model: modelFor(input.purpose, env),
                max_tokens: 1024,
                temperature: temperatureFor(input.purpose),
                system: input.systemPrompt,
                messages: [{ role: "user", content: input.userPrompt }],
              }),
            env.LLM_MAX_RETRIES,
          ),
        );
        record(message.usage);

        return message.content
          .filter((block) => block.type === "text")
          .map((block) => (block.type === "text" ? block.text : ""))
          .join("\n");
      } catch (error) {
        throw mapProviderError(error);
      }
    },

    getStats(): LlmCallStats {
      return { ...stats };
    },
  };
}

function modelFor(purpose: LlmPurpose, env: Env): string {
  // Routing is a cheap classification; reasoning work gets the stronger tier.
  return purpose === "routing" ? env.ANTHROPIC_ROUTING_MODEL : env.ANTHROPIC_ANALYSIS_MODEL;
}

function temperatureFor(purpose: LlmPurpose): number {
  return purpose === "routing" ? 0 : 0.2;
}

function toUsage(usage: Anthropic.Usage): { inputTokens: number; outputTokens: number } {
  return { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens };
}

function appendInstructions(userPrompt: string, instructions: string[]): string {
  if (instructions.length === 0) return userPrompt;
  return `${userPrompt}\n\nAdditional constraints:\n${instructions.join("\n")}`;
}

function toToolSchema(schema: ZodType<unknown>): Anthropic.Tool.InputSchema {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  delete json["$schema"];
  return json as Anthropic.Tool.InputSchema;
}

/** 429 and 5xx are transient; everything else fails immediately. */
function isRetryable(error: unknown): boolean {
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" && (status === 429 || status >= 500);
}

async function withRetries<T>(task: () => Promise<T>, maxRetries: number): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === maxRetries) break;

      // Exponential backoff with jitter, so parallel agents do not retry in lockstep.
      const base = 500 * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, base + Math.random() * base * 0.25));
    }
  }

  throw lastError;
}

function createLimiter(maxConcurrent: number) {
  let active = 0;
  const waiting: Array<() => void> = [];

  return async function limit<T>(task: () => Promise<T>): Promise<T> {
    if (active >= maxConcurrent) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}

function mapProviderError(error: unknown): Error {
  if (error instanceof SchemaValidationError || error instanceof ConfigError) return error;

  if (error instanceof Error && (error.name === "AbortError" || /timeout/i.test(error.message))) {
    return new LlmTimeoutError("The language model provider did not respond in time.");
  }

  return new LlmProviderError(describeProviderFailure(error));
}
