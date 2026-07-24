import { z } from "zod";
import type { CoordinatorOutput, GroundedFact, LlmAnalysis } from "./types";

/**
 * zod schemas for every structured LLM output. Nothing produced by a model
 * enters the application without passing through one of these.
 */

export const AgentIdSchema = z.enum(["finance", "hr"]);

export const RouteTargetSchema = z.enum(["finance", "hr", "both", "unsupported"]);

export const GroundedFactSchema = z.object({
  claim: z.string().min(1),
  label: z.string().min(1),
  value: z.union([z.string(), z.number()]),
  sourceField: z.string().min(1),
  reportingPeriod: z.string().optional(),
});

export const LlmAnalysisSchema = z.object({
  agent: AgentIdSchema,
  summary: z.string().min(1),
  facts: z.array(GroundedFactSchema),
  concerns: z.array(z.string()),
  recommendation: z.string().min(1),
  missingInformation: z.array(z.string()),
  confidence: z.number().min(0).max(1),
});

/** Output of the optional LLM routing classifier. It never sees department data. */
export const RouteClassificationSchema = z.object({
  target: RouteTargetSchema,
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1),
  intent: z.string().min(1),
});

export const JointVerdictSchema = z.enum([
  "hire",
  "do_not_hire",
  "hire_conditionally",
  "insufficient_data",
]);

export const CoordinatorOutputSchema = z.object({
  recommendation: JointVerdictSchema,
  headline: z.string().min(1),
  summary: z.string().min(1),
  financePerspective: z.string().min(1),
  hrPerspective: z.string().min(1),
  conditions: z.array(z.string()),
  risks: z.array(z.string()),
  missingInformation: z.array(z.string()),
  supportingFacts: z.array(GroundedFactSchema),
  confidence: z.number().min(0).max(1),
});

export type RouteClassification = z.infer<typeof RouteClassificationSchema>;

/**
 * Compile-time guards: if a schema drifts from its interface, `tsc` fails here
 * rather than at runtime in front of a reviewer.
 */
type Expect<T extends true> = T;
type _FactMatches = Expect<z.infer<typeof GroundedFactSchema> extends GroundedFact ? true : false>;
type _AnalysisMatches = Expect<z.infer<typeof LlmAnalysisSchema> extends LlmAnalysis ? true : false>;
type _CoordinatorMatches = Expect<
  z.infer<typeof CoordinatorOutputSchema> extends CoordinatorOutput ? true : false
>;
