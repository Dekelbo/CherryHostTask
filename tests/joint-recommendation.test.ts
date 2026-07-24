import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { CoordinatorOutputSchema, LlmAnalysisSchema } from "../src/domain/schemas";
import type { AgentAnalysis, CoordinatorOutput, DepartmentAgent } from "../src/domain/types";
import { createFinanceAgent } from "../src/finance/finance.agent";
import { buildFinanceFactSheet } from "../src/finance/finance.facts";
import financeJson from "../src/finance/finance.data.json";
import type { FinanceData } from "../src/finance/finance.types";
import { createHrAgent } from "../src/hr/hr.agent";
import { buildHrFactSheet } from "../src/hr/hr.facts";
import hrJson from "../src/hr/hr.data.json";
import type { HrData } from "../src/hr/hr.types";
import type { LlmClient, LlmResponse, StructuredRequest } from "../src/llm/client";
import { FIXTURES } from "../src/llm/fixtures";
import { createMockLlmClient } from "../src/llm/mock-client";
import {
  answerJointQuestion,
  deriveJointConstraints,
  runJointRecommendation,
} from "../src/orchestration/coordinator";

const financeData = financeJson as FinanceData;
const hrData = hrJson as HrData;
const QUESTION = "Should we hire more people?";

function fixtureResponse(id: string): unknown {
  const fixture = FIXTURES.find((candidate) => candidate.id === id);
  if (!fixture) throw new Error(`missing fixture ${id}`);
  return fixture.response;
}

/** Builds a verified AgentAnalysis by running an agent against its own fixture. */
async function analysisFor(agent: "finance" | "hr"): Promise<AgentAnalysis> {
  const llm = createMockLlmClient();
  const departmentAgent =
    agent === "finance"
      ? createFinanceAgent({ llm, data: financeData })
      : createHrAgent({ llm, data: hrData });

  return departmentAgent.answer(QUESTION);
}

/** A coordinator client that returns a caller-supplied output. */
function coordinatorClient(output: unknown): LlmClient {
  return {
    async generateStructured<T>(input: StructuredRequest<T>): Promise<LlmResponse<T>> {
      return {
        data: input.schema.parse(output),
        usage: { inputTokens: 0, outputTokens: 0 },
        model: "scripted",
      };
    },
    async generateText(): Promise<string> {
      throw new Error("not used");
    },
    getStats() {
      return { calls: 0, inputTokens: 0, outputTokens: 0 };
    },
  };
}

function baseCoordinatorOutput(): CoordinatorOutput {
  return CoordinatorOutputSchema.parse(fixtureResponse("coordination.hiring"));
}

describe("joint orchestration", () => {
  it("runs both agents and produces a recommendation with both perspectives", async () => {
    const llm = createMockLlmClient();
    const result = await answerJointQuestion({
      llm,
      financeAgent: createFinanceAgent({ llm, data: financeData }),
      hrAgent: createHrAgent({ llm, data: hrData }),
      question: QUESTION,
    });

    expect(result.finance.trusted).toBe(true);
    expect(result.hr.trusted).toBe(true);
    expect(result.outcome.trusted).toBe(true);
    expect(result.outcome.recommendation.financePerspective.length).toBeGreaterThan(0);
    expect(result.outcome.recommendation.hrPerspective.length).toBeGreaterThan(0);
  });

  it("resolves the funded-versus-needed tension conditionally", async () => {
    // HR wants two roles filled; Finance funds exactly one. Neither agent can
    // reach the right answer alone, which is the point of the joint flow.
    const llm = createMockLlmClient();
    const result = await answerJointQuestion({
      llm,
      financeAgent: createFinanceAgent({ llm, data: financeData }),
      hrAgent: createHrAgent({ llm, data: hrData }),
      question: QUESTION,
    });

    expect(result.outcome.recommendation.recommendation).toBe("hire_conditionally");
    expect(result.outcome.recommendation.conditions.join(" ")).toContain("Maintenance Coordinator");
  });

  it.each([
    "Should we hire more people?",
    "Can we afford another operations employee?",
    "Is the company ready to expand the team?",
    "Which department should receive the next hire?",
  ])("produces a trusted joint answer for %j", async (question) => {
    // Regression: offline fixture selection once matched "team" in this question
    // to the HR capacity fixture, so the coordinator cited facts HR had not
    // reported and the whole answer was correctly rejected. Every documented
    // joint question must reach a trusted result.
    const llm = createMockLlmClient();
    const result = await answerJointQuestion({
      llm,
      financeAgent: createFinanceAgent({ llm, data: financeData }),
      hrAgent: createHrAgent({ llm, data: hrData }),
      question,
    });

    expect(result.finance.trusted).toBe(true);
    expect(result.hr.trusted).toBe(true);
    expect(result.outcome.trusted).toBe(true);
  });

  it("derives its constraints from verified facts, not raw data", async () => {
    const constraints = deriveJointConstraints(await analysisFor("finance"), await analysisFor("hr"));

    expect(constraints.maxAffordableHires).toBe(1);
    expect(constraints.departmentsOverCapacity).toBe("operations, maintenance");
    expect(constraints.fundedOpenRoles).toBe("Maintenance Coordinator");
  });

  it("derives constraints from per-role facts when the summary fields are not cited", async () => {
    // Observed live: the HR agent cited openRoles.<title>.status rather than the
    // derived fundedOpenRoles field, so the constraint read "none reported".
    // A constraint must not depend on the agent picking one exact field.
    const hr = await analysisFor("hr");
    const perRoleOnly: AgentAnalysis = {
      ...hr,
      facts: [
        {
          claim: "The Maintenance Coordinator role has approved budget.",
          label: "Maintenance Coordinator budget status",
          value: "approved",
          sourceField: "openRoles.Maintenance Coordinator.status",
        },
        {
          claim: "Operations is over capacity.",
          label: "operations capacity status",
          value: "over_capacity",
          sourceField: "departments.operations.capacityStatus",
        },
      ],
      verification: {
        ...hr.verification,
        verifiedFields: [
          "openRoles.Maintenance Coordinator.status",
          "departments.operations.capacityStatus",
        ],
      },
    };

    const constraints = deriveJointConstraints(await analysisFor("finance"), perRoleOnly);

    expect(constraints.fundedOpenRoles).toBe("Maintenance Coordinator");
    expect(constraints.departmentsOverCapacity).toBe("operations");
  });

  it("keeps supporting facts a subset of the upstream verified facts", async () => {
    const finance = await analysisFor("finance");
    const hr = await analysisFor("hr");
    const outcome = await runJointRecommendation({
      llm: createMockLlmClient(),
      question: QUESTION,
      finance,
      hr,
    });

    const upstream = new Set([...finance.fieldsUsed, ...hr.fieldsUsed]);
    for (const fact of outcome.recommendation.supportingFacts) {
      expect(upstream.has(fact.sourceField)).toBe(true);
    }
  });
});

describe("coordinator guardrails", () => {
  it("rejects a hire verdict when code says zero hires are affordable", async () => {
    const finance = await analysisFor("finance");
    const hr = await analysisFor("hr");

    // Force the code-computed constraint to zero, leaving the model's verdict intact.
    const brokeFinance: AgentAnalysis = {
      ...finance,
      facts: finance.facts.map((fact) =>
        fact.sourceField === "maxAffordableAdditionalHires" ? { ...fact, value: 0 } : fact,
      ),
    };

    const outcome = await runJointRecommendation({
      llm: coordinatorClient(baseCoordinatorOutput()),
      question: QUESTION,
      finance: brokeFinance,
      hr,
    });

    expect(outcome.trusted).toBe(false);
    expect(outcome.verification.issues.map((issue) => issue.code)).toContain("POLICY_CONFLICT");
  });

  it("rejects a coordinator that introduces a number of its own", async () => {
    const output = baseCoordinatorOutput();
    const outcome = await runJointRecommendation({
      llm: coordinatorClient({
        ...output,
        summary: "There is roughly €150,000 of unused headroom to fund three more hires.",
      }),
      question: QUESTION,
      finance: await analysisFor("finance"),
      hr: await analysisFor("hr"),
    });

    expect(outcome.trusted).toBe(false);
    expect(outcome.verification.issues.map((issue) => issue.code)).toContain(
      "UNBACKED_NUMERIC_CLAIM",
    );
  });

  it("rejects a supporting fact that no agent reported", async () => {
    const output = baseCoordinatorOutput();
    const outcome = await runJointRecommendation({
      llm: coordinatorClient({
        ...output,
        supportingFacts: [
          {
            claim: "The severance reserve is €30,000.",
            label: "Severance reserve",
            value: 30000,
            sourceField: "severanceReserve",
          },
        ],
      }),
      question: QUESTION,
      finance: await analysisFor("finance"),
      hr: await analysisFor("hr"),
    });

    expect(outcome.trusted).toBe(false);
    expect(outcome.verification.issues.map((issue) => issue.code)).toContain("UNKNOWN_FIELD");
  });

  it("reports insufficient data when one agent is untrusted, without calling the model", async () => {
    const finance = await analysisFor("finance");
    const hr = await analysisFor("hr");
    const untrustedHr: AgentAnalysis = { ...hr, trusted: false };

    const outcome = await runJointRecommendation({
      llm: coordinatorClient({ never: "used" }),
      question: QUESTION,
      finance,
      hr: untrustedHr,
    });

    expect(outcome.recommendation.recommendation).toBe("insufficient_data");
    expect(outcome.recommendation.missingInformation.join(" ")).toContain("HR Agent");
  });

  it("survives one agent failing outright", async () => {
    const llm = createMockLlmClient();
    const failingHr: DepartmentAgent = {
      id: "hr",
      answer: () => Promise.reject(new Error("provider exploded")),
    };

    const result = await answerJointQuestion({
      llm,
      financeAgent: createFinanceAgent({ llm, data: financeData }),
      hrAgent: failingHr,
      question: QUESTION,
    });

    expect(result.hr.trusted).toBe(false);
    expect(result.outcome.recommendation.recommendation).toBe("insufficient_data");
  });
});

describe("coordinator isolation", () => {
  it("receives summaries only, and its module imports no dataset", () => {
    const source = readFileSync(
      path.resolve(__dirname, "../src/orchestration/coordinator.ts"),
      "utf8",
    );

    // Check import specifiers, not raw text: the coordinator legitimately reads
    // `finance.facts` as a property of an AgentAnalysis it was handed.
    const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1] ?? "");

    for (const specifier of imports) {
      expect(specifier).not.toMatch(/\.data\.json$/);
      expect(specifier).not.toMatch(/(^|\/)(finance|hr)\//);
    }
  });

  it("passes no raw dataset field to the model that the agents did not report", async () => {
    const finance = await analysisFor("finance");
    const hr = await analysisFor("hr");
    let capturedPrompt = "";

    const spy: LlmClient = {
      async generateStructured<T>(input: StructuredRequest<T>): Promise<LlmResponse<T>> {
        capturedPrompt = `${input.systemPrompt}\n${input.userPrompt}`;
        return {
          data: input.schema.parse(baseCoordinatorOutput()),
          usage: { inputTokens: 0, outputTokens: 0 },
          model: "spy",
        };
      },
      async generateText(): Promise<string> {
        throw new Error("not used");
      },
      getStats() {
        return { calls: 0, inputTokens: 0, outputTokens: 0 };
      },
    };

    await runJointRecommendation({ llm: spy, question: QUESTION, finance, hr });

    // Derive the uncited fields rather than hardcoding them: which fields an
    // agent chooses to cite changes as prompts and fixtures evolve, but the
    // invariant does not — anything the agents did not report must not reach
    // the coordinator, because the coordinator never sees raw data.
    const cited = new Set([...finance.fieldsUsed, ...hr.fieldsUsed]);
    const allFields = [
      ...Object.keys(buildFinanceFactSheet(financeData).entries),
      ...Object.keys(buildHrFactSheet(hrData).entries),
    ];
    const uncited = allFields.filter((field) => !cited.has(field));

    expect(uncited.length).toBeGreaterThan(0);
    for (const field of uncited) {
      expect(capturedPrompt).not.toContain(field);
    }
  });
});

describe("analysis schema", () => {
  it("rejects an analysis whose confidence is out of range", () => {
    const valid = LlmAnalysisSchema.parse(fixtureResponse("analysis.finance.hiring"));
    expect(LlmAnalysisSchema.safeParse({ ...valid, confidence: 1.5 }).success).toBe(false);
  });
});
