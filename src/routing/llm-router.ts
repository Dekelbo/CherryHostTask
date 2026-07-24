import { RouteClassificationSchema } from "../domain/schemas";
import type { RouteDecision } from "../domain/types";
import type { LlmClient } from "../llm/client";

/**
 * Fallback classifier for questions the deterministic rules cannot place.
 *
 * It receives the question and one-line department descriptions — never any
 * department data. Routing decides what data may be touched, so it must run
 * before, and without, that data.
 */
const ROUTER_SYSTEM_PROMPT = `You route a user's question to the department that can answer it.

Departments:
- finance: money. Revenue, operating costs, profit, margin, cash runway, hiring budget, growth.
- hr: people. Headcount, department capacity, overtime, workload, open roles, turnover, time to hire.

Choose one target:
- "finance" if only financial data is needed.
- "hr" if only workforce data is needed.
- "both" if the question is a staffing decision with a financial consequence.
- "unsupported" if the question is outside both areas, or too vague to place.

Do not answer the question. Do not invent data. If you are unsure, return "unsupported"
with a low confidence rather than guessing a department.`;

export async function classifyQuestion(
  llm: LlmClient,
  question: string,
): Promise<RouteDecision> {
  const result = await llm.generateStructured({
    systemPrompt: ROUTER_SYSTEM_PROMPT,
    userPrompt: question,
    schema: RouteClassificationSchema,
    purpose: "routing",
    maxTokens: 512,
  });

  return {
    target: result.data.target,
    confidence: result.data.confidence,
    reason: result.data.reason,
    intent: result.data.intent,
    source: "llm",
    matchedSignals: [],
  };
}
