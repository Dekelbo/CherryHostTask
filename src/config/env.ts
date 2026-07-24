import "dotenv/config";
import { z } from "zod";
import { ConfigError } from "../domain/errors";

/**
 * Environment schema. The project is keyless by default: `LLM_PROVIDER=mock`
 * needs no secret and serves committed fixtures. A real key is required only
 * when the operator explicitly opts into the live provider.
 */
const EnvSchema = z
  .object({
    LLM_PROVIDER: z.enum(["mock", "anthropic"]).default("mock"),
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    ANTHROPIC_ROUTING_MODEL: z.string().min(1).default("claude-haiku-4-5-20251001"),
    ANTHROPIC_ANALYSIS_MODEL: z.string().min(1).default("claude-sonnet-5"),
    LLM_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
    LLM_MAX_RETRIES: z.coerce.number().int().nonnegative().default(3),
    UNBACKED_NUMBER_MODE: z.enum(["reject", "warn"]).default("reject"),
  })
  .superRefine((value, ctx) => {
    if (value.LLM_PROVIDER === "anthropic" && !value.ANTHROPIC_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ANTHROPIC_API_KEY"],
        message: "ANTHROPIC_API_KEY is required when LLM_PROVIDER=anthropic.",
      });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

/**
 * Parse and validate the process environment, failing fast on the first run.
 * Only field names and validation messages are surfaced — never the values —
 * so a misconfiguration can never print a secret to stdout or a log.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new ConfigError(`Invalid environment configuration:\n${details}`);
  }
  return result.data;
}

// Note: deliberately not evaluated at module load. The CLI calls `loadEnv()`
// inside its own error handling so a misconfiguration prints a readable message
// and a config exit code, rather than throwing during an import.
