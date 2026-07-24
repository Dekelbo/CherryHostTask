import { describe, expect, it } from "vitest";

import { EmptyQuestionError } from "../src/domain/errors";
import { RouteClassificationSchema } from "../src/domain/schemas";
import { AMBIGUITY_THRESHOLD, isAmbiguous, routeQuestion } from "../src/routing/router";

describe("finance routing", () => {
  const questions = [
    "What is our monthly revenue?",
    "What is our operating margin?",
    "How much runway do we have left?",
  ];

  it.each(questions)("routes %j to finance", (question) => {
    const decision = routeQuestion(question);

    expect(decision.target).toBe("finance");
    expect(decision.source).toBe("rules");
    expect(decision.confidence).toBeGreaterThanOrEqual(AMBIGUITY_THRESHOLD);
    expect(decision.matchedSignals.length).toBeGreaterThan(0);
  });
});

describe("hr routing", () => {
  const questions = [
    "How many employees do we have?",
    "Which team is over capacity?",
    "What is our voluntary turnover?",
  ];

  it.each(questions)("routes %j to hr", (question) => {
    const decision = routeQuestion(question);

    expect(decision.target).toBe("hr");
    expect(decision.source).toBe("rules");
    expect(decision.confidence).toBeGreaterThanOrEqual(AMBIGUITY_THRESHOLD);
  });
});

describe("joint routing", () => {
  const questions = [
    "Should we hire more people?",
    "Can we afford another operations employee?",
    "Is the company ready to expand the team?",
    "Which department should receive the next hire?",
  ];

  it.each(questions)("routes %j to both", (question) => {
    const decision = routeQuestion(question);

    expect(decision.target).toBe("both");
    expect(decision.confidence).toBeGreaterThanOrEqual(AMBIGUITY_THRESHOLD);
  });

  it("explains why both departments are needed", () => {
    const decision = routeQuestion("Should we hire more people?");

    expect(decision.intent).toBe("cross_department_staffing_decision");
    expect(decision.reason).toMatch(/both|finance|hr/i);
  });
});

describe("unsupported and ambiguous routing", () => {
  it("confidently refuses an out-of-domain question", () => {
    const decision = routeQuestion("What is the weather in Madrid?");

    expect(decision.target).toBe("unsupported");
    expect(decision.intent).toBe("out_of_domain");
    expect(isAmbiguous(decision)).toBe(false);
  });

  it("marks a vague question as ambiguous rather than guessing a department", () => {
    const decision = routeQuestion("How are we doing?");

    expect(decision.target).toBe("unsupported");
    expect(decision.intent).toBe("ambiguous");
    expect(isAmbiguous(decision)).toBe(true);
  });

  it("throws a typed error on an empty question", () => {
    expect(() => routeQuestion("")).toThrow(EmptyQuestionError);
    expect(() => routeQuestion("   ")).toThrow(EmptyQuestionError);
  });
});

describe("routing determinism and validation", () => {
  it("reaches every decision without an LLM call", () => {
    // tests/setup.ts blocks all network access, so any provider call here
    // would throw. Passing proves the deterministic path is genuinely offline.
    const questions = [
      "What is our monthly revenue?",
      "How many employees do we have?",
      "Should we hire more people?",
      "What is the weather in Madrid?",
    ];

    for (const question of questions) {
      expect(routeQuestion(question).source).toBe("rules");
    }
  });

  it("produces a stable decision for the same question", () => {
    expect(routeQuestion("Should we hire more people?")).toEqual(
      routeQuestion("Should we hire more people?"),
    );
  });

  it("rejects an out-of-enum route from the LLM classifier rather than coercing it", () => {
    const result = RouteClassificationSchema.safeParse({
      target: "marketing",
      confidence: 0.9,
      reason: "Looks like a marketing question.",
      intent: "marketing_question",
    });

    expect(result.success).toBe(false);
  });

  it("rejects a classifier confidence outside 0..1", () => {
    const result = RouteClassificationSchema.safeParse({
      target: "finance",
      confidence: 1.4,
      reason: "Very sure.",
      intent: "finance_question",
    });

    expect(result.success).toBe(false);
  });
});
