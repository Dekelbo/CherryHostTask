import { CoordinatorOutputSchema } from "../domain/schemas";
import type {
  AgentAnalysis,
  CoordinatorOutput,
  DepartmentAgent,
  FactSheet,
  GroundedFact,
  JointRecommendation,
  VerificationIssue,
  VerificationResult,
} from "../domain/types";
import { verifyGroundedFacts, scanForUnbackedNumbers } from "../grounding/verify";
import type { LlmClient } from "../llm/client";

/**
 * Controlled orchestration. The two agents have already run — independently and
 * in parallel — and the coordinator receives ONLY their finished analyses. This
 * module imports no dataset, and its function signature accepts no raw data, so
 * the information boundary is enforced by the type system rather than by care.
 *
 * There is deliberately no agent-to-agent conversation: a fixed sequence with a
 * single coordinator call is auditable, cheap and reproducible, where a
 * free-form debate would multiply hallucination risk every turn.
 */

export interface JointConstraints {
  maxAffordableHires: number | null;
  departmentsOverCapacity: string;
  fundedOpenRoles: string;
}

export interface JointOutcome {
  recommendation: JointRecommendation;
  verification: VerificationResult;
  trusted: boolean;
}

/**
 * Constraints are computed in code from the agents' *verified* facts, before
 * the model is asked anything. The model cannot argue with them.
 */
export function deriveJointConstraints(
  finance: AgentAnalysis,
  hr: AgentAnalysis,
): JointConstraints {
  return {
    maxAffordableHires: numericFact(finance, "maxAffordableAdditionalHires"),
    departmentsOverCapacity: stringFact(hr, "departmentsOverCapacity") ?? "not reported",
    fundedOpenRoles: stringFact(hr, "fundedOpenRoles") ?? "none reported",
  };
}

function findVerifiedFact(analysis: AgentAnalysis, sourceField: string): GroundedFact | undefined {
  if (!analysis.verification.verifiedFields.includes(sourceField)) return undefined;
  return analysis.facts.find((fact) => fact.sourceField === sourceField);
}

function numericFact(analysis: AgentAnalysis, sourceField: string): number | null {
  const value = findVerifiedFact(analysis, sourceField)?.value;
  return typeof value === "number" ? value : null;
}

function stringFact(analysis: AgentAnalysis, sourceField: string): string | undefined {
  const value = findVerifiedFact(analysis, sourceField)?.value;
  return value === undefined ? undefined : String(value);
}

/** The coordinator's entire numeric vocabulary: the union of verified upstream facts. */
function buildCoordinatorSheet(finance: AgentAnalysis, hr: AgentAnalysis): FactSheet {
  const entries: FactSheet["entries"] = {};

  for (const analysis of [finance, hr]) {
    for (const fact of analysis.facts) {
      if (!analysis.verification.verifiedFields.includes(fact.sourceField)) continue;
      entries[fact.sourceField] = {
        value: fact.value,
        label: fact.label,
        isDerived: false,
        ...(fact.reportingPeriod ? { period: fact.reportingPeriod } : {}),
      };
    }
  }

  return {
    agent: "coordinator",
    reportingPeriod: finance.facts[0]?.reportingPeriod ?? hr.facts[0]?.reportingPeriod ?? "",
    entries,
    gaps: [...finance.missingInformation, ...hr.missingInformation],
  };
}

function buildCoordinatorPrompt(constraints: JointConstraints): string {
  const affordable =
    constraints.maxAffordableHires === null
      ? "Finance did not report a verified affordable-hire count, so affordability is unknown."
      : `Finance can fund at most ${constraints.maxAffordableHires} additional hire(s). This number was calculated in code and is not negotiable.`;

  return `You are the Coordinator for Cherry Host. You reconcile the Finance Agent's and the HR Agent's analyses into one decision.

You receive only those two analyses. You have no access to either department's raw data.

Rules:
- Use only facts stated in the two analyses. Never introduce a number that does not appear in them.
- Do not perform arithmetic or estimate new figures.
- ${affordable}
- If the affordable-hire count is 0, you may not recommend "hire" or "hire_conditionally".
- If either analysis is missing information needed to decide, prefer "insufficient_data" or set
  clear conditions rather than assuming.
- Reconcile disagreement explicitly: say what each side supports and what the deciding factor is.
- "supportingFacts" must be copied from the analyses, with the same sourceField and value.

Verified constraints, computed in code:
- Maximum affordable additional hires: ${constraints.maxAffordableHires ?? "unknown"}
- Departments over capacity: ${constraints.departmentsOverCapacity}
- Open roles with approved budget: ${constraints.fundedOpenRoles}`;
}

function buildCoordinatorQuestion(
  question: string,
  finance: AgentAnalysis,
  hr: AgentAnalysis,
): string {
  return `Question: ${question}

FINANCE AGENT ANALYSIS
${summarise(finance)}

HR AGENT ANALYSIS
${summarise(hr)}`;
}

function summarise(analysis: AgentAnalysis): string {
  const facts = analysis.facts
    .filter((fact) => analysis.verification.verifiedFields.includes(fact.sourceField))
    .map((fact) => `- ${fact.label}: ${fact.value} [${fact.sourceField}]`)
    .join("\n");

  return `Summary: ${analysis.summary}
Recommendation: ${analysis.recommendation}
Verified facts:
${facts}
Concerns:
${analysis.concerns.map((concern) => `- ${concern}`).join("\n") || "- none stated"}
Missing information:
${analysis.missingInformation.map((item) => `- ${item}`).join("\n") || "- none stated"}`;
}

/**
 * A verdict that contradicts a code-computed constraint is rejected outright.
 * This is the check that stops a persuasive model from recommending a hire the
 * business demonstrably cannot fund.
 */
function checkPolicy(
  output: CoordinatorOutput,
  constraints: JointConstraints,
): VerificationIssue[] {
  const recommendsHiring =
    output.recommendation === "hire" || output.recommendation === "hire_conditionally";

  if (constraints.maxAffordableHires === 0 && recommendsHiring) {
    return [
      {
        code: "POLICY_CONFLICT",
        message: `The recommendation is "${output.recommendation}" but Finance can fund 0 additional hires.`,
        expected: 0,
        received: output.recommendation,
      },
    ];
  }

  return [];
}

export interface JointRunResult {
  finance: AgentAnalysis;
  hr: AgentAnalysis;
  outcome: JointOutcome;
}

/**
 * Runs both agents concurrently, then coordinates. The parallelism is the point:
 * the two calls cannot influence one another, which is what makes their
 * independence structural rather than asserted — and it is the honest answer to
 * how this scales past two departments.
 */
export async function answerJointQuestion(input: {
  llm: LlmClient;
  financeAgent: DepartmentAgent;
  hrAgent: DepartmentAgent;
  question: string;
}): Promise<JointRunResult> {
  const [finance, hr] = await Promise.all([
    safeAnswer(input.financeAgent, input.question),
    safeAnswer(input.hrAgent, input.question),
  ]);

  const outcome = await runJointRecommendation({
    llm: input.llm,
    question: input.question,
    finance,
    hr,
  });

  return { finance, hr, outcome };
}

/**
 * One department failing must not abort the other. A provider error becomes an
 * untrusted analysis, which the coordinator then reports as insufficient data.
 */
async function safeAnswer(agent: DepartmentAgent, question: string): Promise<AgentAnalysis> {
  try {
    return await agent.answer(question);
  } catch {
    const verification: VerificationResult = {
      valid: false,
      errors: [`The ${agent.id} agent could not produce a verified analysis.`],
      issues: [],
      verifiedFields: [],
    };

    return {
      agent: agent.id,
      summary: `The ${agent.id} agent could not produce a verified analysis.`,
      facts: [],
      concerns: [],
      recommendation: "No recommendation is available from this department.",
      missingInformation: [`The ${agent.id} analysis is unavailable.`],
      confidence: 0,
      trusted: false,
      verification,
      fieldsUsed: [],
    };
  }
}

export interface RunJointInput {
  llm: LlmClient;
  question: string;
  finance: AgentAnalysis;
  hr: AgentAnalysis;
}

export async function runJointRecommendation(input: RunJointInput): Promise<JointOutcome> {
  const { llm, question, finance, hr } = input;

  // An unverified analysis is not evidence. Rather than let the coordinator
  // reason over it, the system reports that it cannot decide.
  if (!finance.trusted || !hr.trusted) {
    return insufficientData(question, finance, hr);
  }

  const constraints = deriveJointConstraints(finance, hr);
  const sheet = buildCoordinatorSheet(finance, hr);
  const systemPrompt = buildCoordinatorPrompt(constraints);
  const userPrompt = buildCoordinatorQuestion(question, finance, hr);

  const first = await llm.generateStructured({
    systemPrompt,
    userPrompt,
    schema: CoordinatorOutputSchema,
    purpose: "coordination",
  });

  const firstCheck = verifyCoordinatorOutput(first.data, sheet, constraints, question);
  if (firstCheck.valid) return finalise(question, first.data, firstCheck, true);

  const repaired = await llm.generateStructured({
    systemPrompt,
    userPrompt,
    schema: CoordinatorOutputSchema,
    purpose: "coordination",
    repairInstructions: [
      "Your previous answer failed verification:",
      ...firstCheck.errors.map((error) => `- ${error}`),
      "Correct these using only facts stated in the two analyses.",
    ],
  });

  const secondCheck = verifyCoordinatorOutput(repaired.data, sheet, constraints, question);
  return finalise(question, repaired.data, secondCheck, secondCheck.valid);
}

export function verifyCoordinatorOutput(
  output: CoordinatorOutput,
  sheet: FactSheet,
  constraints: JointConstraints,
  question: string,
): VerificationResult {
  const factResult = verifyGroundedFacts(sheet, output.supportingFacts);

  const unbacked = scanForUnbackedNumbers({
    sheet,
    facts: output.supportingFacts,
    question,
    prose: [
      output.headline,
      output.summary,
      output.financePerspective,
      output.hrPerspective,
      ...output.conditions,
      ...output.risks,
    ],
  });

  const issues = [...factResult.issues, ...unbacked, ...checkPolicy(output, constraints)];

  return {
    valid: issues.length === 0,
    errors: issues.map((issue) => issue.message),
    issues,
    verifiedFields: factResult.verifiedFields,
  };
}

function finalise(
  question: string,
  output: CoordinatorOutput,
  verification: VerificationResult,
  trusted: boolean,
): JointOutcome {
  return { recommendation: { question, ...output }, verification, trusted };
}

function insufficientData(
  question: string,
  finance: AgentAnalysis,
  hr: AgentAnalysis,
): JointOutcome {
  const untrusted = [
    ...(finance.trusted ? [] : ["The Finance Agent's analysis failed verification."]),
    ...(hr.trusted ? [] : ["The HR Agent's analysis failed verification."]),
  ];

  return {
    trusted: true,
    verification: { valid: true, errors: [], issues: [], verifiedFields: [] },
    recommendation: {
      question,
      recommendation: "insufficient_data",
      headline: "Not enough verified information to make a recommendation.",
      summary:
        "At least one department's analysis could not be verified against its authorised data, so a joint recommendation would not be trustworthy.",
      financePerspective: finance.trusted ? finance.summary : "Not available: analysis unverified.",
      hrPerspective: hr.trusted ? hr.summary : "Not available: analysis unverified.",
      conditions: [],
      risks: [],
      missingInformation: untrusted,
      supportingFacts: [],
      confidence: 0,
    },
  };
}
