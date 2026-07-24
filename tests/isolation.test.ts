import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { buildFinanceFactSheet } from "../src/finance/finance.facts";
import { createFinanceAgent } from "../src/finance/finance.agent";
import { buildFinanceSystemPrompt } from "../src/finance/finance.prompt";
import financeJson from "../src/finance/finance.data.json";
import type { FinanceData } from "../src/finance/finance.types";
import { buildHrFactSheet } from "../src/hr/hr.facts";
import { createHrAgent } from "../src/hr/hr.agent";
import { buildHrSystemPrompt } from "../src/hr/hr.prompt";
import hrJson from "../src/hr/hr.data.json";
import type { HrData } from "../src/hr/hr.types";
import type { LlmClient, LlmResponse, StructuredRequest } from "../src/llm/client";

/**
 * The headline test file. Agent isolation is claimed by many submissions and
 * enforced by few; everything here checks a mechanism in code rather than a
 * sentence in a prompt.
 */

const financeData = financeJson as FinanceData;
const hrData = hrJson as HrData;

const SRC_ROOT = path.resolve(__dirname, "../src");

interface SourceFile {
  relativePath: string;
  imports: string[];
}

function collectSourceFiles(directory: string = SRC_ROOT): SourceFile[] {
  const files: SourceFile[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(absolute));
      continue;
    }
    if (!entry.name.endsWith(".ts")) continue;

    const content = readFileSync(absolute, "utf8");
    const imports = [...content.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1] ?? "");

    files.push({
      relativePath: path.relative(SRC_ROOT, absolute).split(path.sep).join("/"),
      imports,
    });
  }

  return files;
}

const sourceFiles = collectSourceFiles();

/** A client that returns exactly what a test tells it to — including bad output. */
function scriptedClient(response: unknown): LlmClient {
  return {
    async generateStructured<T>(input: StructuredRequest<T>): Promise<LlmResponse<T>> {
      return {
        data: input.schema.parse(response),
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

describe("module boundaries", () => {
  it("no finance module imports anything from hr", () => {
    const offenders = sourceFiles
      .filter((file) => file.relativePath.startsWith("finance/"))
      .filter((file) => file.imports.some((specifier) => /(^|\/)hr\//.test(specifier)));

    expect(offenders.map((file) => file.relativePath)).toEqual([]);
  });

  it("no hr module imports anything from finance", () => {
    const offenders = sourceFiles
      .filter((file) => file.relativePath.startsWith("hr/"))
      .filter((file) => file.imports.some((specifier) => /(^|\/)finance\//.test(specifier)));

    expect(offenders.map((file) => file.relativePath)).toEqual([]);
  });

  it("only the composition root imports both datasets", () => {
    const importsBoth = sourceFiles.filter(
      (file) =>
        file.imports.some((specifier) => specifier.includes("finance.data.json")) &&
        file.imports.some((specifier) => specifier.includes("hr.data.json")),
    );

    expect(importsBoth.map((file) => file.relativePath)).toEqual(["composition.ts"]);
  });

  it("the composition root only wires, and never reads values out of the datasets", () => {
    const composition = readFileSync(path.join(SRC_ROOT, "composition.ts"), "utf8");

    // Wiring only: no property access on the imported datasets, no merged object.
    expect(composition).not.toMatch(/financeJson\./);
    expect(composition).not.toMatch(/hrJson\./);
    expect(composition).not.toMatch(/\.\.\.(financeJson|hrJson)/);
  });
});

describe("agent encapsulation", () => {
  const llm = scriptedClient(null);

  it("exposes only id and answer, with no route to the data", () => {
    const financeAgent = createFinanceAgent({ llm, data: financeData });
    const hrAgent = createHrAgent({ llm, data: hrData });

    expect(Object.keys(financeAgent).sort()).toEqual(["answer", "id"]);
    expect(Object.keys(hrAgent).sort()).toEqual(["answer", "id"]);
    // The double cast is required precisely because `DepartmentAgent` exposes
    // no index signature — there is no typed way to reach for `.data` at all.
    expect((financeAgent as unknown as Record<string, unknown>)["data"]).toBeUndefined();
  });

  it("leaks no dataset values when serialised", () => {
    const serialised = JSON.stringify(createFinanceAgent({ llm, data: financeData }));

    expect(serialised).not.toContain("412000");
    expect(serialised).not.toContain("52000");
  });
});

describe("prompt content", () => {
  const financePrompt = buildFinanceSystemPrompt(buildFinanceFactSheet(financeData));
  const hrPrompt = buildHrSystemPrompt(buildHrFactSheet(hrData));

  it("the finance prompt contains no HR field name", () => {
    for (const field of [
      "totalEmployees",
      "overtimeHoursLastMonth",
      "voluntaryTurnoverPercent",
      "capacityStatus",
      "departmentsOverCapacity",
      "fundedOpenRoles",
    ]) {
      expect(financePrompt).not.toContain(field);
    }
  });

  it("the finance prompt contains no HR value", () => {
    // Whole-token matching: finance legitimately holds 34,000, which must not
    // be mistaken for HR's headcount of 34.
    expect(financePrompt).not.toMatch(/\b34\b/);
    expect(financePrompt).not.toMatch(/\b310\b/);
    expect(financePrompt).not.toMatch(/\b11\.8\b/);
    expect(financePrompt).not.toContain("over_capacity");
  });

  it("the hr prompt contains no finance field name", () => {
    for (const field of [
      "monthlyRevenue",
      "monthlyOperatingCosts",
      "availableAnnualHiringBudget",
      "cashOnHand",
      "benchmarkAnnualLoadedCostPerHire",
      "operatingMarginPercent",
    ]) {
      expect(hrPrompt).not.toContain(field);
    }
  });

  it("the hr prompt contains no finance value", () => {
    expect(hrPrompt).not.toMatch(/\b412000\b/);
    expect(hrPrompt).not.toMatch(/\b356000\b/);
    expect(hrPrompt).not.toMatch(/\b52000\b/);
    expect(hrPrompt).not.toContain("EUR");
  });
});

describe("hostile model output", () => {
  it("refuses a finance answer that cites an HR field", async () => {
    const llm = scriptedClient({
      agent: "finance",
      summary: "The company employs 34 people, so hiring is affordable.",
      facts: [
        {
          claim: "The company has 34 employees.",
          label: "Total employees",
          value: 34,
          sourceField: "totalEmployees",
        },
      ],
      concerns: [],
      recommendation: "Hire more staff.",
      missingInformation: [],
      confidence: 0.95,
    });

    const analysis = await createFinanceAgent({ llm, data: financeData }).answer(
      "How many employees can we afford?",
    );

    expect(analysis.trusted).toBe(false);
    expect(analysis.verification.issues.map((issue) => issue.code)).toContain(
      "CROSS_DEPARTMENT_FIELD_REFERENCE",
    );
  });

  it("refuses an HR answer that cites a finance field", async () => {
    const llm = scriptedClient({
      agent: "hr",
      summary: "Monthly revenue supports another hire.",
      facts: [
        {
          claim: "Monthly revenue is €412,000.",
          label: "Monthly revenue",
          value: 412000,
          sourceField: "monthlyRevenue",
        },
      ],
      concerns: [],
      recommendation: "Hire another person.",
      missingInformation: [],
      confidence: 0.95,
    });

    const analysis = await createHrAgent({ llm, data: hrData }).answer("Can we afford a hire?");

    expect(analysis.trusted).toBe(false);
    expect(analysis.verification.issues.map((issue) => issue.code)).toContain(
      "CROSS_DEPARTMENT_FIELD_REFERENCE",
    );
  });

  it("refuses an answer whose cited value does not match the dataset", async () => {
    const llm = scriptedClient({
      agent: "finance",
      summary: "The available hiring budget is €90,000.",
      facts: [
        {
          claim: "The available hiring budget is €90,000.",
          label: "Available annual hiring budget",
          value: 90000,
          sourceField: "availableAnnualHiringBudget",
        },
      ],
      concerns: [],
      recommendation: "Hire two people.",
      missingInformation: [],
      confidence: 0.95,
    });

    const analysis = await createFinanceAgent({ llm, data: financeData }).answer(
      "What is our hiring budget?",
    );

    expect(analysis.trusted).toBe(false);
    expect(analysis.verification.issues.map((issue) => issue.code)).toContain("VALUE_MISMATCH");
  });
});

/**
 * Compile-time isolation. This function is never called: its only job is to
 * fail `tsc --noEmit` if the department-scoped parameter types ever stop
 * preventing a cross-department wiring mistake.
 */
function _compileTimeIsolationGuards(llm: LlmClient): void {
  // @ts-expect-error - HrData must never be accepted where FinanceData is required
  createFinanceAgent({ llm, data: hrData });
  // @ts-expect-error - FinanceData must never be accepted where HrData is required
  createHrAgent({ llm, data: financeData });
}
