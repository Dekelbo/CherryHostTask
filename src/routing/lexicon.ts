/**
 * Routing vocabulary. Data only — no logic — so the routing rules can be read,
 * reviewed and extended without touching the scoring code.
 *
 * These are English keyword lists, which is a real limitation: they do not
 * generalise to paraphrase or to other languages. That is the trade-off for a
 * router that is free, instant and deterministic on the common case, and it is
 * why an LLM classifier backs it up for genuinely ambiguous questions.
 */

export interface WeightedTerm {
  term: string;
  weight: number;
}

/** Terms that indicate the question is about money. */
export const FINANCE_TERMS: readonly WeightedTerm[] = [
  { term: "revenue", weight: 1 },
  { term: "profit", weight: 1 },
  { term: "margin", weight: 1 },
  { term: "runway", weight: 1 },
  { term: "cash", weight: 1 },
  { term: "budget", weight: 1 },
  { term: "cost", weight: 0.9 },
  { term: "costs", weight: 0.9 },
  { term: "expense", weight: 0.9 },
  { term: "expenses", weight: 0.9 },
  { term: "spend", weight: 0.8 },
  { term: "spending", weight: 0.8 },
  { term: "afford", weight: 0.9 },
  { term: "affordable", weight: 0.9 },
  { term: "financial", weight: 0.8 },
  { term: "finance", weight: 0.8 },
  { term: "receivables", weight: 1 },
  { term: "growth", weight: 0.6 },
  { term: "payroll", weight: 0.7 },
];

/** Terms that indicate the question is about people. */
export const HR_TERMS: readonly WeightedTerm[] = [
  { term: "employee", weight: 1 },
  { term: "employees", weight: 1 },
  { term: "headcount", weight: 1 },
  { term: "staff", weight: 1 },
  { term: "staffing", weight: 1 },
  { term: "hiring", weight: 0.9 },
  { term: "hire", weight: 0.9 },
  { term: "recruitment", weight: 1 },
  { term: "workload", weight: 1 },
  { term: "overtime", weight: 1 },
  { term: "turnover", weight: 1 },
  { term: "attrition", weight: 1 },
  { term: "capacity", weight: 0.9 },
  { term: "team", weight: 0.8 },
  { term: "teams", weight: 0.8 },
  { term: "department", weight: 0.7 },
  { term: "departments", weight: 0.7 },
  { term: "vacation", weight: 1 },
  { term: "role", weight: 0.7 },
  { term: "roles", weight: 0.7 },
  { term: "people", weight: 0.7 },
];

/**
 * Topics that are plainly outside the platform's scope. Their presence lets the
 * router refuse *confidently* — and so skip the LLM classifier entirely —
 * instead of treating "what is the weather" as merely ambiguous.
 */
export const OUT_OF_DOMAIN_TERMS: readonly string[] = [
  "weather",
  "forecast",
  "temperature",
  "football",
  "recipe",
  "translate",
  "joke",
  "horoscope",
  "bitcoin",
  "stock market",
];

/**
 * Phrases that inherently need both departments: a staffing decision with a
 * money consequence. Matching one of these routes to `both` outright, because
 * either agent alone would give a confidently incomplete answer.
 */
export const JOINT_INTENT_PHRASES: readonly string[] = [
  "hire more",
  "hire another",
  "afford another",
  "afford to hire",
  "can we afford",
  "should we hire",
  "expand the team",
  "grow the team",
  "reduce headcount",
  "cut headcount",
  "lay off",
  "next hire",
  "more people",
  "ready to expand",
  "increase headcount",
];
