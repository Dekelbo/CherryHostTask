import { runGroundedAnalysis } from "../agents/run-analysis";
import type { AgentAnalysis, DepartmentAgent } from "../domain/types";
import type { UnbackedNumberMode } from "../grounding/verify";
import type { LlmClient } from "../llm/client";
import { buildHrFactSheet } from "./hr.facts";
import { buildHrSystemPrompt } from "./hr.prompt";
import type { HrData } from "./hr.types";

/**
 * Exact mirror of the Finance Agent: data captured in the closure, `HrData`
 * only, and the same shared verification path. The symmetry is deliberate —
 * neither department gets a privileged code path.
 */
export interface HrAgentDeps {
  llm: LlmClient;
  data: HrData;
  unbackedNumberMode?: UnbackedNumberMode;
}

export function createHrAgent(deps: HrAgentDeps): DepartmentAgent {
  const sheet = buildHrFactSheet(deps.data);
  const systemPrompt = buildHrSystemPrompt(sheet);
  const unbackedNumberMode = deps.unbackedNumberMode ?? "reject";

  return {
    id: "hr",
    answer(question: string): Promise<AgentAnalysis> {
      return runGroundedAnalysis({
        llm: deps.llm,
        agent: "hr",
        sheet,
        systemPrompt,
        question,
        unbackedNumberMode,
      });
    },
  };
}
