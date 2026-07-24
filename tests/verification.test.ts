import { describe, expect, it } from "vitest";

import financeJson from "../src/finance/finance.data.json";
import hrJson from "../src/hr/hr.data.json";
import { buildFinanceFactSheet } from "../src/finance/finance.facts";
import { buildHrFactSheet } from "../src/hr/hr.facts";
import type { FinanceData } from "../src/finance/finance.types";
import type { HrData } from "../src/hr/hr.types";
import type { GroundedFact } from "../src/domain/types";
import {
  CoordinatorOutputSchema,
  LlmAnalysisSchema,
  RouteClassificationSchema,
} from "../src/domain/schemas";
import { FIXTURES } from "../src/llm/fixtures";
import {
  knownFieldNames,
  normaliseValue,
  scanForUnbackedNumbers,
  verifyAnalysis,
  verifyGroundedFacts,
} from "../src/grounding/verify";

const financeSheet = buildFinanceFactSheet(financeJson as FinanceData);
const hrSheet = buildHrFactSheet(hrJson as HrData);

function fact(overrides: Partial<GroundedFact> = {}): GroundedFact {
  return {
    claim: "The available annual hiring budget is €52,000.",
    label: "Available annual hiring budget",
    value: 52_000,
    sourceField: "availableAnnualHiringBudget",
    ...overrides,
  };
}

describe("value normalisation", () => {
  it("treats currency formatting, separators and plain numbers as equal", () => {
    expect(normaliseValue("€52,000")).toBe(52_000);
    expect(normaliseValue("52000")).toBe(52_000);
    expect(normaliseValue(52_000)).toBe(52_000);
    expect(normaliseValue("52k")).toBe(52_000);
  });

  it("falls back to case-insensitive string comparison for non-numeric values", () => {
    expect(normaliseValue("  Over_Capacity ")).toBe("over_capacity");
  });
});

describe("field verification", () => {
  it("accepts a fact whose source field and value both match", () => {
    const result = verifyGroundedFacts(financeSheet, [fact()]);

    expect(result.valid).toBe(true);
    expect(result.verifiedFields).toEqual(["availableAnnualHiringBudget"]);
    expect(result.errors).toEqual([]);
  });

  it("accepts an equivalent value written with currency formatting", () => {
    expect(verifyGroundedFacts(financeSheet, [fact({ value: "€52,000" })]).valid).toBe(true);
  });

  it("rejects an unknown source field", () => {
    const result = verifyGroundedFacts(financeSheet, [fact({ sourceField: "quarterlyBonusPool" })]);

    expect(result.valid).toBe(false);
    expect(result.issues[0]?.code).toBe("UNKNOWN_FIELD");
  });

  it("rejects a value that does not match the authorised field", () => {
    const result = verifyGroundedFacts(financeSheet, [fact({ value: 52_001 })]);

    expect(result.valid).toBe(false);
    expect(result.issues[0]?.code).toBe("VALUE_MISMATCH");
    expect(result.issues[0]?.expected).toBe(52_000);
    expect(result.issues[0]?.received).toBe(52_001);
  });

  it("rejects a value that is proportionally close but wrong", () => {
    // Regression: a percentage-based tolerance would wave €52,250 through on a
    // €52,000 field. Matching is exact-or-correctly-rounded, never proportional.
    const result = verifyGroundedFacts(financeSheet, [fact({ value: 52_250 })]);

    expect(result.valid).toBe(false);
    expect(result.issues[0]?.code).toBe("VALUE_MISMATCH");
  });

  it("accepts a derived float reported to fewer decimal places", () => {
    const rounded = fact({
      value: 13.6,
      sourceField: "operatingMarginPercent",
      label: "Operating margin",
    });

    expect(verifyGroundedFacts(financeSheet, [rounded]).valid).toBe(true);
  });

  it("flags a finance agent citing an HR field as a cross-department reference", () => {
    const result = verifyGroundedFacts(financeSheet, [
      fact({ sourceField: "totalEmployees", value: 34 }),
    ]);

    expect(result.valid).toBe(false);
    expect(result.issues[0]?.code).toBe("CROSS_DEPARTMENT_FIELD_REFERENCE");
  });

  it("flags an HR agent citing a finance field as a cross-department reference", () => {
    const result = verifyGroundedFacts(hrSheet, [
      fact({ sourceField: "monthlyRevenue", value: 412_000 }),
    ]);

    expect(result.valid).toBe(false);
    expect(result.issues[0]?.code).toBe("CROSS_DEPARTMENT_FIELD_REFERENCE");
  });

  it("keeps the foreign-field registry in step with the real fact sheets", () => {
    // Guards against the registry silently drifting as fields are added.
    for (const field of Object.keys(financeSheet.entries)) {
      const root = field.split(".")[0] ?? field;
      if (root === "reportingPeriod") continue;
      expect(knownFieldNames("finance")).toContain(root);
    }
    for (const field of Object.keys(hrSheet.entries)) {
      const root = field.split(".")[0] ?? field;
      if (root === "reportingPeriod") continue;
      expect(knownFieldNames("hr")).toContain(root);
    }
  });
});

describe("unbacked number scanning", () => {
  const question = "What is our operating margin?";

  it("passes prose whose numbers all trace to authorised fields", () => {
    const issues = scanForUnbackedNumbers({
      sheet: financeSheet,
      facts: [fact()],
      question,
      prose: ["Operating margin is 13.6% on revenue of €412,000 and costs of €356,000."],
    });

    expect(issues).toEqual([]);
  });

  it("catches a number invented in the prose", () => {
    const issues = scanForUnbackedNumbers({
      sheet: financeSheet,
      facts: [fact()],
      question,
      prose: ["That leaves roughly €60,000 of headroom for new hires."],
    });

    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe("UNBACKED_NUMERIC_CLAIM");
    expect(issues[0]?.received).toBe(60_000);
  });

  it("does not trip on a number the user supplied in the question", () => {
    const issues = scanForUnbackedNumbers({
      sheet: financeSheet,
      facts: [fact()],
      question: "Can we afford a role costing €70,000?",
      prose: ["A role at €70,000 exceeds the available hiring budget of €52,000."],
    });

    expect(issues).toEqual([]);
  });

  it("does not read the reporting period as a business number", () => {
    const issues = scanForUnbackedNumbers({
      sheet: financeSheet,
      facts: [fact()],
      question,
      prose: ["For 2026-Q2 the available hiring budget is €52,000."],
    });

    expect(issues).toEqual([]);
  });
});

describe("offline fixtures", () => {
  // Fixtures are the offline demo path, so they must satisfy the same schema
  // and the same verifier as live model output. This is the guard against
  // fixture drift: a hand-edited or stale fixture fails here, not in a demo.
  const schemaFor = (purpose: string) =>
    purpose === "analysis"
      ? LlmAnalysisSchema
      : purpose === "coordination"
        ? CoordinatorOutputSchema
        : RouteClassificationSchema;

  it.each(FIXTURES.map((fixture) => fixture.id))("fixture %s satisfies its schema", (id) => {
    const fixture = FIXTURES.find((candidate) => candidate.id === id);
    expect(fixture).toBeDefined();
    expect(schemaFor(fixture!.purpose).safeParse(fixture!.response).success).toBe(true);
  });

  it.each(
    FIXTURES.filter((fixture) => fixture.purpose === "analysis").map((fixture) => fixture.id),
  )("analysis fixture %s passes claim verification", (id) => {
    const fixture = FIXTURES.find((candidate) => candidate.id === id)!;
    const analysis = LlmAnalysisSchema.parse(fixture.response);
    const sheet = analysis.agent === "finance" ? financeSheet : hrSheet;

    const result = verifyAnalysis({
      sheet,
      agent: analysis.agent,
      facts: analysis.facts,
      question: "demo question",
      unbackedNumberMode: "reject",
      prose: [analysis.summary, analysis.recommendation, ...analysis.concerns],
    });

    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });
});

describe("full analysis verification", () => {
  const baseInput = {
    sheet: financeSheet,
    agent: "finance" as const,
    question: "What is our available hiring budget?",
    unbackedNumberMode: "reject" as const,
  };

  it("passes a fully grounded analysis", () => {
    const result = verifyAnalysis({
      ...baseInput,
      facts: [fact()],
      prose: ["The available annual hiring budget is €52,000."],
    });

    expect(result.valid).toBe(true);
    expect(result.verifiedFields).toEqual(["availableAnnualHiringBudget"]);
  });

  it("rejects an analysis whose prose invents a number, even with valid facts", () => {
    const result = verifyAnalysis({
      ...baseInput,
      facts: [fact()],
      prose: ["The available hiring budget is €52,000, leaving €60,000 spare."],
    });

    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("UNBACKED_NUMERIC_CLAIM");
  });

  it("downgrades unbacked numbers to a warning when configured to warn", () => {
    const result = verifyAnalysis({
      ...baseInput,
      facts: [fact()],
      prose: ["The available hiring budget is €52,000, leaving €60,000 spare."],
      unbackedNumberMode: "warn",
    });

    expect(result.valid).toBe(true);
  });

  it("flags an analysis produced against the wrong department's sheet", () => {
    const result = verifyAnalysis({
      ...baseInput,
      agent: "hr",
      facts: [fact()],
      prose: ["The available annual hiring budget is €52,000."],
    });

    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("POLICY_CONFLICT");
  });
});
