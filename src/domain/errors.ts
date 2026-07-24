/**
 * Typed errors with fixed process exit codes. Provider payloads and secrets
 * never reach these messages — see `describeProviderFailure`.
 */

export const ExitCode = {
  Ok: 0,
  Unsupported: 1,
  VerificationRejected: 2,
  ConfigOrProvider: 3,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

export abstract class AppError extends Error {
  abstract readonly code: string;
  abstract readonly exitCode: ExitCodeValue;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class ConfigError extends AppError {
  readonly code = "CONFIG_ERROR";
  readonly exitCode = ExitCode.ConfigOrProvider;
}

export class EmptyQuestionError extends AppError {
  readonly code = "EMPTY_QUESTION";
  readonly exitCode = ExitCode.Unsupported;

  constructor(message = "A question is required. Provide one as an argument or at the prompt.") {
    super(message);
  }
}

export class UnsupportedQuestionError extends AppError {
  readonly code = "UNSUPPORTED_QUESTION";
  readonly exitCode = ExitCode.Unsupported;
}

/** Any provider-side failure, already stripped of raw payloads. */
export class LlmProviderError extends AppError {
  readonly code = "LLM_PROVIDER_ERROR";
  readonly exitCode = ExitCode.ConfigOrProvider;
}

export class LlmTimeoutError extends AppError {
  readonly code = "LLM_TIMEOUT";
  readonly exitCode = ExitCode.ConfigOrProvider;
}

/** The model returned something that did not satisfy its output schema. */
export class SchemaValidationError extends AppError {
  readonly code = "SCHEMA_VALIDATION_FAILED";
  readonly exitCode = ExitCode.ConfigOrProvider;
}

/** A response was produced but failed claim verification twice. Never shown as an answer. */
export class VerificationRejectedError extends AppError {
  readonly code = "VERIFICATION_REJECTED";
  readonly exitCode = ExitCode.VerificationRejected;
}

export class OrchestrationError extends AppError {
  readonly code = "ORCHESTRATION_FAILED";
  readonly exitCode = ExitCode.ConfigOrProvider;
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/**
 * Reduce an unknown provider failure to a safe, human-readable summary.
 * Deliberately drops response bodies, headers and anything key-shaped: a raw
 * provider payload printed to stdout is how keys and customer data leak.
 */
export function describeProviderFailure(error: unknown): string {
  if (error instanceof Error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number") {
      return `The language model provider returned HTTP ${status}.`;
    }
    if (error.name === "AbortError") {
      return "The language model provider did not respond in time.";
    }
  }
  return "The language model provider could not be reached.";
}

/** Exit code for any error, including ones we did not type. */
export function exitCodeFor(error: unknown): ExitCodeValue {
  return isAppError(error) ? error.exitCode : ExitCode.ConfigOrProvider;
}

/** User-facing message for any error, guaranteed free of provider internals. */
export function userFacingMessage(error: unknown): string {
  return isAppError(error) ? error.message : describeProviderFailure(error);
}
