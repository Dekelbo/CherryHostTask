/**
 * Shared contracts. These types are department-agnostic on purpose: the router,
 * the orchestrator and the CLI are written against them and therefore have no
 * expressible path to any department's raw data.
 */

export type AgentId = "finance" | "hr";

export type RouteTarget = AgentId | "both" | "unsupported";

export type RouteSource = "rules" | "llm";

/** A single claim the model made, tied to the exact field it came from. */
export interface GroundedFact {
  claim: string;
  label: string;
  value: string | number;
  /** Must exist in the citing agent's own FactSheet. Verified, not trusted. */
  sourceField: string;
  reportingPeriod?: string;
}

/** Exactly what the model is allowed to return. Validated by zod. */
export interface LlmAnalysis {
  agent: AgentId;
  summary: string;
  facts: GroundedFact[];
  concerns: string[];
  recommendation: string;
  missingInformation: string[];
  confidence: number;
}

export type VerificationIssueCode =
  | "UNKNOWN_FIELD"
  | "VALUE_MISMATCH"
  | "CROSS_DEPARTMENT_FIELD_REFERENCE"
  | "UNBACKED_NUMERIC_CLAIM"
  | "POLICY_CONFLICT";

export interface VerificationIssue {
  code: VerificationIssueCode;
  message: string;
  sourceField?: string;
  expected?: string | number;
  received?: string | number;
}

export interface VerificationResult {
  valid: boolean;
  /** Flat list, kept for readability in the CLI and the brief's shape. */
  errors: string[];
  /** Structured detail, used by tests and --explain. */
  issues: VerificationIssue[];
  verifiedFields: string[];
}

/**
 * What an agent returns: the model's output plus metadata the *application*
 * added. `trusted` is never something the model can assert about itself.
 */
export interface AgentAnalysis extends LlmAnalysis {
  trusted: boolean;
  verification: VerificationResult;
  fieldsUsed: string[];
}

/**
 * The only handle the router and orchestrator ever hold on an agent.
 * There is deliberately no accessor for the agent's data.
 */
export interface DepartmentAgent {
  id: AgentId;
  answer(question: string): Promise<AgentAnalysis>;
}

export interface RouteDecision {
  target: RouteTarget;
  confidence: number;
  reason: string;
  intent: string;
  source: RouteSource;
  matchedSignals: string[];
}

/** Enum kept identical to the client brief §12. */
export type JointVerdict = "hire" | "do_not_hire" | "hire_conditionally" | "insufficient_data";

/** The coordinator's model output. `question` is supplied by the application. */
export interface CoordinatorOutput {
  recommendation: JointVerdict;
  headline: string;
  summary: string;
  financePerspective: string;
  hrPerspective: string;
  conditions: string[];
  risks: string[];
  missingInformation: string[];
  /** Must be a subset of the verified facts of the two upstream analyses. */
  supportingFacts: GroundedFact[];
  confidence: number;
}

export interface JointRecommendation extends CoordinatorOutput {
  question: string;
}

/**
 * One entry in an agent's FactSheet. The FactSheet is the model's entire
 * universe of facts for a call — raw fields and code-derived metrics alike.
 */
export interface FactEntry {
  value: string | number;
  label: string;
  unit?: string;
  period?: string;
  /** True when the value was computed in TypeScript rather than read from JSON. */
  isDerived: boolean;
  note?: string;
}

export interface FactSheet {
  agent: AgentId;
  reportingPeriod: string;
  /** Flat `fieldPath -> entry`. The allowlist the verifier checks against. */
  entries: Record<string, FactEntry>;
  /** Known gaps, stated up front so the model can say "not available". */
  gaps: string[];
}
