import { runGroundedAnalysis } from "../agents/run-analysis";
import type { AgentAnalysis, DepartmentAgent } from "../domain/types";
import type { UnbackedNumberMode } from "../grounding/verify";
import type { LlmClient } from "../llm/client";
import { buildFinanceFactSheet } from "./finance.facts";
import { buildFinanceSystemPrompt } from "./finance.prompt";
import type { FinanceData } from "./finance.types";

/**
 * `data` is captured in this closure and is never exposed on the returned
 * object: there is no `.data`, no getter and no accessor. The only thing a
 * caller can do with a Finance Agent is ask it a question.
 *
 * The parameter type is `FinanceData`, so passing HR data here is a compile
 * error rather than a runtime leak.
 */
export interface FinanceAgentDeps {
  llm: LlmClient;
  data: FinanceData;
  unbackedNumberMode?: UnbackedNumberMode;
}

export function createFinanceAgent(deps: FinanceAgentDeps): DepartmentAgent {
  const sheet = buildFinanceFactSheet(deps.data);
  const systemPrompt = buildFinanceSystemPrompt(sheet);
  const unbackedNumberMode = deps.unbackedNumberMode ?? "reject";

  return {
    id: "finance",
    answer(question: string): Promise<AgentAnalysis> {
      return runGroundedAnalysis({
        llm: deps.llm,
        agent: "finance",
        sheet,
        systemPrompt,
        question,
        unbackedNumberMode,
      });
    },
  };
}
