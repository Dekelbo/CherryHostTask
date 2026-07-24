import { EmptyQuestionError } from "../domain/errors";
import type { RouteDecision } from "../domain/types";
import {
  FINANCE_TERMS,
  HR_TERMS,
  JOINT_INTENT_PHRASES,
  OUT_OF_DOMAIN_TERMS,
  type WeightedTerm,
} from "./lexicon";

/**
 * Deterministic router. It receives the user's question and nothing else — no
 * department data ever reaches it. Routing is effectively the authorisation
 * step, so it runs *before* any data access and fails closed.
 *
 * Below this confidence a question is treated as genuinely ambiguous and may be
 * escalated to the LLM classifier; the system asks rather than guesses.
 */
export const AMBIGUITY_THRESHOLD = 0.5;

interface TermMatch {
  score: number;
  matched: string[];
}

function matchTerms(question: string, terms: readonly WeightedTerm[]): TermMatch {
  let score = 0;
  const matched: string[] = [];

  for (const { term, weight } of terms) {
    const pattern = new RegExp(`\\b${term}\\b`, "i");
    if (pattern.test(question)) {
      score += weight;
      matched.push(term);
    }
  }

  return { score, matched };
}

function matchPhrases(question: string, phrases: readonly string[]): string[] {
  return phrases.filter((phrase) => question.includes(phrase));
}

export function routeQuestion(rawQuestion: string): RouteDecision {
  const question = rawQuestion.trim();
  if (question.length === 0) {
    throw new EmptyQuestionError();
  }

  const normalised = question.toLowerCase();

  const jointPhrases = matchPhrases(normalised, JOINT_INTENT_PHRASES);
  if (jointPhrases.length > 0) {
    return {
      target: "both",
      confidence: 0.95,
      reason:
        "The question asks about a staffing decision with a direct financial consequence, so it needs both the HR capacity picture and the Finance affordability picture.",
      intent: "cross_department_staffing_decision",
      source: "rules",
      matchedSignals: jointPhrases,
    };
  }

  const finance = matchTerms(normalised, FINANCE_TERMS);
  const hr = matchTerms(normalised, HR_TERMS);

  if (finance.score > 0 && hr.score > 0) {
    return {
      target: "both",
      confidence: Math.min(finance.score, hr.score) >= 1 ? 0.9 : 0.75,
      reason:
        "The question contains both financial and workforce signals, so each department contributes part of the answer.",
      intent: "cross_department_question",
      source: "rules",
      matchedSignals: [...finance.matched, ...hr.matched],
    };
  }

  if (finance.score > 0) {
    return {
      target: "finance",
      confidence: finance.score >= 1 ? 0.92 : 0.65,
      reason: `The question asks about ${finance.matched.join(", ")}, which is finance data.`,
      intent: "finance_question",
      source: "rules",
      matchedSignals: finance.matched,
    };
  }

  if (hr.score > 0) {
    return {
      target: "hr",
      confidence: hr.score >= 1 ? 0.92 : 0.65,
      reason: `The question asks about ${hr.matched.join(", ")}, which is workforce data.`,
      intent: "hr_question",
      source: "rules",
      matchedSignals: hr.matched,
    };
  }

  const outOfDomain = matchPhrases(normalised, OUT_OF_DOMAIN_TERMS);
  if (outOfDomain.length > 0) {
    return {
      target: "unsupported",
      confidence: 0.95,
      reason:
        "The question is about a topic this system holds no data for. It answers only finance and workforce questions.",
      intent: "out_of_domain",
      source: "rules",
      matchedSignals: outOfDomain,
    };
  }

  // No signal either way. Reported with low confidence so the caller can decide
  // to escalate to the LLM classifier rather than guessing a department.
  return {
    target: "unsupported",
    confidence: 0.2,
    reason:
      "The question does not clearly match finance or workforce data, so it cannot be routed with confidence.",
    intent: "ambiguous",
    source: "rules",
    matchedSignals: [],
  };
}

/** True when the deterministic result is too weak to act on unaided. */
export function isAmbiguous(decision: RouteDecision): boolean {
  return decision.confidence < AMBIGUITY_THRESHOLD;
}
