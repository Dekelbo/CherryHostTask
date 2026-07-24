import type { AgentAnalysis, RouteDecision } from "../domain/types";
import type { JointOutcome } from "../orchestration/coordinator";

/** Human-readable output. Everything here comes from structured application state. */

const AGENT_TITLES: Record<string, string> = {
  finance: "Finance Agent",
  hr: "HR Agent",
};

function formatValue(value: string | number): string {
  return typeof value === "number" ? value.toLocaleString("en-US") : value;
}

function bullets(items: string[], marker = "  •"): string {
  return items.map((item) => `${marker} ${item}`).join("\n");
}

export function renderRoute(decision: RouteDecision): string {
  const header = `Route: ${decision.target}  (${decision.source}, confidence ${decision.confidence.toFixed(2)})`;
  return `${header}\nReason: ${decision.reason}`;
}

export function renderAnalysis(analysis: AgentAnalysis): string {
  const title = AGENT_TITLES[analysis.agent] ?? analysis.agent;
  const sections: string[] = [`${title}\n${analysis.summary}`];

  if (analysis.facts.length > 0) {
    const width = Math.max(...analysis.facts.map((fact) => fact.label.length));
    const rows = analysis.facts.map((fact) => {
      const verified = analysis.fieldsUsed.includes(fact.sourceField) ? "" : "  (unverified)";
      return `  • ${fact.label.padEnd(width)}  ${formatValue(fact.value)}  [${fact.sourceField}]${verified}`;
    });
    sections.push(`Facts used\n${rows.join("\n")}`);
  }

  if (analysis.concerns.length > 0) sections.push(`Concerns\n${bullets(analysis.concerns)}`);

  sections.push(`Recommendation\n  ${analysis.recommendation}`);

  if (analysis.missingInformation.length > 0) {
    sections.push(`Missing information\n${bullets(analysis.missingInformation)}`);
  }

  sections.push(
    `✓ ${analysis.verification.verifiedFields.length} claim(s) verified against source fields.`,
  );

  return sections.join("\n\n");
}

/**
 * A response that failed verification is never rendered as an answer. The user
 * sees the refusal and the reasons instead — a refused answer beats a wrong one.
 */
export function renderRejection(analysis: AgentAnalysis): string {
  const title = AGENT_TITLES[analysis.agent] ?? analysis.agent;

  return [
    `✗ The ${title}'s response failed verification and was not accepted.`,
    "",
    "Problems found:",
    bullets(analysis.verification.errors),
    "",
    "No answer is shown, because an unverified business figure is worse than no figure.",
  ].join("\n");
}

export function renderJoint(outcome: JointOutcome): string {
  const joint = outcome.recommendation;

  const sections = [
    `Joint Recommendation: ${joint.recommendation}`,
    `${joint.headline}\n\n${joint.summary}`,
    `Finance perspective\n  ${joint.financePerspective}`,
    `HR perspective\n  ${joint.hrPerspective}`,
  ];

  if (joint.conditions.length > 0) sections.push(`Conditions\n${bullets(joint.conditions)}`);
  if (joint.risks.length > 0) sections.push(`Risks\n${bullets(joint.risks)}`);
  if (joint.missingInformation.length > 0) {
    sections.push(`Missing information\n${bullets(joint.missingInformation)}`);
  }

  sections.push(
    `✓ ${joint.supportingFacts.length} supporting fact(s) traced to verified department facts.`,
  );

  return sections.join("\n\n");
}

export function renderJointRejection(outcome: JointOutcome): string {
  return [
    "✗ The joint recommendation failed verification and was not accepted.",
    "",
    "Problems found:",
    bullets(outcome.verification.errors),
  ].join("\n");
}

export function renderClarification(decision: RouteDecision): string {
  return [
    "I could not confidently route that question, so I am not going to guess.",
    "",
    `Why: ${decision.reason}`,
    "",
    "I can answer questions about:",
    "  • Finance — revenue, operating costs, margin, cash runway, hiring budget, growth",
    "  • HR — headcount, department capacity, overtime, open roles, turnover, time to hire",
    "  • Both — staffing decisions with a financial consequence, such as whether to hire",
  ].join("\n");
}

export function renderUnsupported(decision: RouteDecision): string {
  return [
    "That question is outside what this system holds data for.",
    "",
    `Why: ${decision.reason}`,
    "",
    "It answers finance and workforce questions about Cherry Host only.",
  ].join("\n");
}
