import type { AgentAnalysis, RouteDecision } from "../domain/types";
import type { LlmCallStats } from "../llm/client";
import type { JointConstraints, JointOutcome } from "../orchestration/coordinator";

/**
 * `--explain` output.
 *
 * Every line here is derived from state the application already holds: the
 * RouteDecision, the VerificationResult, the derived constraints and the call
 * counter. No model reasoning is requested, stored or displayed — "explainability"
 * that leaks chain-of-thought is a liability, not a feature.
 */

export interface ExplainInput {
  decision: RouteDecision;
  analyses: AgentAnalysis[];
  joint?: { outcome: JointOutcome; constraints: JointConstraints };
  stats: LlmCallStats;
  model: string;
  tokenBudget: number;
}

function section(title: string, lines: string[]): string {
  return `${title}\n${lines.map((line) => `  ${line}`).join("\n")}`;
}

export function renderExplain(input: ExplainInput): string {
  const { decision, analyses, joint, stats } = input;
  const parts: string[] = [];

  parts.push(
    section("Routing decision", [
      `Target: ${decision.target}`,
      `Source: ${decision.source} (${decision.source === "rules" ? "deterministic, no model call" : "model classifier"})`,
      `Confidence: ${decision.confidence.toFixed(2)}`,
      `Intent: ${decision.intent}`,
      `Matched signals: ${decision.matchedSignals.length > 0 ? decision.matchedSignals.join(", ") : "none"}`,
      `Why: ${decision.reason}`,
    ]),
  );

  for (const analysis of analyses) {
    const issues = analysis.verification.issues;
    parts.push(
      section(`${analysis.agent} fields used`, [
        ...(analysis.fieldsUsed.length > 0
          ? analysis.fieldsUsed.map((field) => `- ${field}`)
          : ["- none verified"]),
        "",
        `Verification: ${analysis.fieldsUsed.length} verified, ${issues.length} issue(s)`,
        `Trusted: ${analysis.trusted ? "yes" : "no"}`,
        ...issues.map((issue) => `! ${issue.code}: ${issue.message}`),
      ]),
    );
  }

  if (joint) {
    const { outcome, constraints } = joint;
    parts.push(
      section("Constraints computed in code", [
        `maxAffordableHires: ${constraints.maxAffordableHires ?? "unknown"}`,
        `departmentsOverCapacity: ${constraints.departmentsOverCapacity}`,
        `fundedOpenRoles: ${constraints.fundedOpenRoles}`,
      ]),
    );

    const conflict = outcome.verification.issues.some((issue) => issue.code === "POLICY_CONFLICT");
    parts.push(
      section("Policy check", [
        `Verdict: ${outcome.recommendation.recommendation}`,
        `Consistent with computed constraints: ${conflict ? "NO — rejected" : "yes"}`,
        `Supporting facts traced upstream: ${outcome.recommendation.supportingFacts.length}`,
        `Trusted: ${outcome.trusted ? "yes" : "no"}`,
      ]),
    );
  }

  const used = stats.inputTokens + stats.outputTokens;
  parts.push(
    section("Model usage", [
      `Provider model: ${input.model}`,
      `Calls: ${stats.calls}`,
      `Tokens in/out: ${stats.inputTokens}/${stats.outputTokens}`,
      `Budget: ${used.toLocaleString("en-US")} of ${input.tokenBudget.toLocaleString("en-US")} tokens used`,
    ]),
  );

  parts.push(
    "Note: this trace is built from application state only. No model chain-of-thought is\nrequested, stored or shown.",
  );

  return parts.join("\n\n");
}
