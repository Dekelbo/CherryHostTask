import type { Env } from "./config/env";
import type { DepartmentAgent } from "./domain/types";
import { createFinanceAgent } from "./finance/finance.agent";
import financeJson from "./finance/finance.data.json";
import type { FinanceData } from "./finance/finance.types";
import { createHrAgent } from "./hr/hr.agent";
import hrJson from "./hr/hr.data.json";
import type { HrData } from "./hr/hr.types";
import { createAnthropicClient } from "./llm/anthropic-client";
import type { LlmClient } from "./llm/client";
import { createMockLlmClient } from "./llm/mock-client";

/**
 * COMPOSITION ROOT — the only module in the codebase permitted to import both
 * datasets. It wires dependencies and does nothing else: it must never analyse,
 * merge, transform or re-export the data, and must never build a combined
 * company object. `tests/isolation.test.ts` enforces that by scanning imports.
 *
 * Everything downstream receives only wired components, so no other module has
 * a route to more than one department's data.
 */
export interface Application {
  financeAgent: DepartmentAgent;
  hrAgent: DepartmentAgent;
  llm: LlmClient;
}

export function createApplication(env: Env): Application {
  const llm: LlmClient =
    env.LLM_PROVIDER === "anthropic" ? createAnthropicClient(env) : createMockLlmClient();

  return {
    llm,
    financeAgent: createFinanceAgent({
      llm,
      data: financeJson as FinanceData,
      unbackedNumberMode: env.UNBACKED_NUMBER_MODE,
    }),
    hrAgent: createHrAgent({
      llm,
      data: hrJson as HrData,
      unbackedNumberMode: env.UNBACKED_NUMBER_MODE,
    }),
  };
}
