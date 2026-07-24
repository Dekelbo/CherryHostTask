import { LlmAnalysisSchema } from "../domain/schemas";
import type { AgentAnalysis, AgentId, FactSheet, LlmAnalysis } from "../domain/types";
import { verifyAnalysis, type UnbackedNumberMode } from "../grounding/verify";
import type { LlmClient } from "../llm/client";

/**
 * The shared call → parse → verify → repair loop. It is generic over the fact
 * sheet and knows nothing about any department: both agents run through the
 * identical path, so neither can have a weaker grounding check than the other.
 */

export interface RunAnalysisInput {
  llm: LlmClient;
  agent: AgentId;
  sheet: FactSheet;
  systemPrompt: string;
  question: string;
  unbackedNumberMode: UnbackedNumberMode;
}

export async function runGroundedAnalysis(input: RunAnalysisInput): Promise<AgentAnalysis> {
  const { llm, agent, sheet, systemPrompt, question, unbackedNumberMode } = input;

  const first = await llm.generateStructured({
    systemPrompt,
    userPrompt: question,
    schema: LlmAnalysisSchema,
    purpose: "analysis",
  });

  const firstCheck = verify(first.data);
  if (firstCheck.valid) return attach(first.data, firstCheck);

  // One repair attempt, with the specific failures fed back as constraints.
  const repaired = await llm.generateStructured({
    systemPrompt,
    userPrompt: question,
    schema: LlmAnalysisSchema,
    purpose: "analysis",
    repairInstructions: [
      "Your previous answer failed verification against the authorised fields:",
      ...firstCheck.errors.map((error) => `- ${error}`),
      "Correct these. Cite only fields listed in the fact sheet, and state no number that is not one of those values.",
    ],
  });

  const secondCheck = verify(repaired.data);
  // Still failing: return it marked untrusted. The caller must not present an
  // unverified answer as a business result — a refusal beats a wrong number.
  return attach(repaired.data, secondCheck);

  function verify(analysis: LlmAnalysis) {
    return verifyAnalysis({
      sheet,
      agent,
      facts: analysis.facts,
      question,
      unbackedNumberMode,
      prose: [analysis.summary, analysis.recommendation, ...analysis.concerns],
    });
  }

  function attach(
    analysis: LlmAnalysis,
    verification: ReturnType<typeof verify>,
  ): AgentAnalysis {
    return {
      ...analysis,
      trusted: verification.valid,
      verification,
      fieldsUsed: verification.verifiedFields,
    };
  }
}
