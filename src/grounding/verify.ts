import type {
  AgentId,
  FactSheet,
  FactSheetOwner,
  GroundedFact,
  VerificationIssue,
  VerificationResult,
} from "../domain/types";
import { lookupFact } from "./factsheet";

/**
 * The claim verifier. This is what turns "please don't hallucinate" from a
 * prompt instruction into an enforced system property: every cited field must
 * exist in the citing agent's own FactSheet, every value must match, and every
 * number in the prose must trace back to a verified fact.
 */

export type UnbackedNumberMode = "reject" | "warn";

/**
 * Field-name registry used only to produce a better error when an agent cites a
 * field belonging to another department. It holds *names*, never values, and
 * imports no dataset — so recognising a foreign field never loads foreign data.
 */
const DEPARTMENT_FIELD_NAMES: Record<AgentId, readonly string[]> = {
  finance: [
    "monthlyRevenue",
    "monthlyOperatingCosts",
    "operatingCostBreakdown",
    "cashOnHand",
    "approvedAnnualHiringBudget",
    "committedAnnualHiringBudget",
    "benchmarkAnnualLoadedCostPerHire",
    "projectedAnnualGrowthPercent",
    "outstandingReceivables",
    "runwayDefinition",
    "monthlyOperatingProfit",
    "operatingMarginPercent",
    "cashRunwayMonths",
    "availableAnnualHiringBudget",
    "maxAffordableAdditionalHires",
  ],
  hr: [
    "totalEmployees",
    "departments",
    "openRolesCount",
    "openRoles",
    "averageWeeklyHours",
    "standardWeeklyHours",
    "overtimeHoursLastMonth",
    "overtimeByDepartment",
    "voluntaryTurnoverPercent",
    "averageTimeToHireDays",
    "headcountFromDepartments",
    "overtimeHoursPerEmployee",
    "weeklyHoursAboveStandard",
    "departmentsOverCapacity",
    "fundedOpenRoles",
    "unfundedOpenRoles",
    "longestOpenRoleDays",
  ],
};

/** Numbers permitted in prose without a backing fact. Deliberately tiny. */
const SAFE_BARE_NUMBERS = new Set([0, 1, 2]);

/**
 * Does this field name belong to the other department's vocabulary?
 * The coordinator has no "other department" — it legitimately sees facts from
 * both, so nothing is foreign to it.
 */
function isForeignField(owner: FactSheetOwner, fieldPath: string): boolean {
  if (owner === "coordinator") return false;

  const root = fieldPath.split(".")[0] ?? fieldPath;
  const foreign = DEPARTMENT_FIELD_NAMES[owner === "finance" ? "hr" : "finance"];
  return foreign.some((name) => name === root || name === fieldPath);
}

/**
 * Parse a value into a comparable form. `"€52,000"`, `"52000"`, `52000` and
 * `"52k"` all reduce to the same number; anything non-numeric is compared as a
 * trimmed, case-insensitive string.
 */
export function normaliseValue(value: string | number): number | string {
  if (typeof value === "number") return value;

  const trimmed = value.trim();
  const numeric = parseNumericToken(trimmed);
  return numeric ?? trimmed.toLowerCase();
}

function parseNumericToken(token: string): number | null {
  const cleaned = token
    .replace(/[€$£\s]/g, "")
    .replace(/,/g, "")
    .replace(/%$/, "");

  const match = /^(-?\d+(?:\.\d+)?)([km])?$/i.exec(cleaned);
  if (!match) return null;

  const base = Number(match[1]);
  if (!Number.isFinite(base)) return null;

  const suffix = match[2]?.toLowerCase();
  if (suffix === "k") return base * 1_000;
  if (suffix === "m") return base * 1_000_000;
  return base;
}

/**
 * A reported number matches only if it is the authorised value exactly, or a
 * correctly rounded rendering of it ("13.6" for 13.59). Deliberately *not* a
 * proportional tolerance: on a €52,000 field a 0.5% band would silently accept
 * €52,250, which is exactly the drift this verifier exists to catch.
 */
function numbersMatch(authorised: number, reported: number): boolean {
  const equal = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-9;
  if (equal(authorised, reported)) return true;

  for (let places = 0; places <= 3; places += 1) {
    const factor = 10 ** places;
    if (equal(Math.round(authorised * factor) / factor, reported)) return true;
  }
  return false;
}

function valuesMatch(expected: string | number, received: string | number): boolean {
  const a = normaliseValue(expected);
  const b = normaliseValue(received);

  if (typeof a === "number" && typeof b === "number") return numbersMatch(a, b);
  if (typeof a === "number" || typeof b === "number") return false;
  return a === b;
}

/**
 * Brief-compatible entry point: confirm each cited source field exists in the
 * agent's authorised sheet and that the stated value matches it.
 */
export function verifyGroundedFacts(sheet: FactSheet, facts: GroundedFact[]): VerificationResult {
  const issues: VerificationIssue[] = [];
  const verifiedFields: string[] = [];

  for (const fact of facts) {
    const entry = lookupFact(sheet, fact.sourceField);

    if (!entry) {
      issues.push(
        isForeignField(sheet.agent, fact.sourceField)
          ? {
              code: "CROSS_DEPARTMENT_FIELD_REFERENCE",
              message: `The ${sheet.agent} agent cited "${fact.sourceField}", which belongs to another department and is outside its authorised data.`,
              sourceField: fact.sourceField,
            }
          : {
              code: "UNKNOWN_FIELD",
              message: `"${fact.sourceField}" is not a field in the ${sheet.agent} agent's authorised data.`,
              sourceField: fact.sourceField,
            },
      );
      continue;
    }

    if (!valuesMatch(entry.value, fact.value)) {
      issues.push({
        code: "VALUE_MISMATCH",
        message: `"${fact.sourceField}" was reported as ${fact.value} but the authorised value is ${entry.value}.`,
        sourceField: fact.sourceField,
        expected: entry.value,
        received: fact.value,
      });
      continue;
    }

    verifiedFields.push(fact.sourceField);
  }

  return toResult(issues, verifiedFields);
}

export interface ProseScanInput {
  sheet: FactSheet;
  facts: GroundedFact[];
  /** Free-text fields the model wrote, which may smuggle in unbacked numbers. */
  prose: string[];
  question: string;
}

/**
 * Catch the gap that per-fact verification leaves open: a response whose
 * `facts[]` are cited perfectly but whose prose invents "roughly €60k of
 * headroom". Every number in the prose must resolve to a verified fact, a
 * number the user supplied, or the documented safe list.
 */
export function scanForUnbackedNumbers(input: ProseScanInput): VerificationIssue[] {
  const { sheet, facts, prose, question } = input;

  const backing: number[] = [];
  for (const entry of Object.values(sheet.entries)) {
    const value = normaliseValue(entry.value);
    if (typeof value === "number") backing.push(value);
  }
  for (const fact of facts) {
    const value = normaliseValue(fact.value);
    if (typeof value === "number") backing.push(value);
  }

  const questionNumbers = extractNumbers(question, sheet.reportingPeriod);
  const issues: VerificationIssue[] = [];
  const reported = new Set<number>();

  for (const text of prose) {
    for (const candidate of extractNumbers(text, sheet.reportingPeriod)) {
      if (SAFE_BARE_NUMBERS.has(candidate)) continue;
      if (questionNumbers.some((asked) => numbersMatch(asked, candidate))) continue;
      if (backing.some((value) => numbersMatch(value, candidate))) continue;
      if (reported.has(candidate)) continue;

      reported.add(candidate);
      issues.push({
        code: "UNBACKED_NUMERIC_CLAIM",
        message: `The response states the number ${candidate}, which does not match any authorised ${sheet.agent} field or verified fact.`,
        received: candidate,
      });
    }
  }

  return issues;
}

const NUMBER_PATTERN = /(\d[\d,]*(?:\.\d+)?)([km])?(?=[^a-z0-9]|$)/gi;

function extractNumbers(text: string, reportingPeriod: string): number[] {
  // The reporting period is metadata, not a business claim: "2026-Q2" must not
  // be read as the numbers 2026 and 2.
  const withoutPeriod = text.split(reportingPeriod).join(" ");
  const numbers: number[] = [];

  for (const match of withoutPeriod.matchAll(NUMBER_PATTERN)) {
    const parsed = parseNumericToken(`${match[1]}${match[2] ?? ""}`);
    if (parsed !== null) numbers.push(parsed);
  }

  return numbers;
}

export interface VerifyAnalysisInput extends ProseScanInput {
  agent: FactSheetOwner;
  unbackedNumberMode: UnbackedNumberMode;
}

/** Full verification: field allowlist, value match, and the prose scan. */
export function verifyAnalysis(input: VerifyAnalysisInput): VerificationResult {
  const { sheet, facts, agent, unbackedNumberMode } = input;

  const fieldResult = verifyGroundedFacts(sheet, facts);
  const issues = [...fieldResult.issues];

  if (agent !== sheet.agent) {
    issues.push({
      code: "POLICY_CONFLICT",
      message: `The response claims to be from the ${agent} agent but was produced against the ${sheet.agent} fact sheet.`,
    });
  }

  const unbacked = scanForUnbackedNumbers(input);
  if (unbackedNumberMode === "reject") {
    issues.push(...unbacked);
  }

  return toResult(issues, fieldResult.verifiedFields);
}

function toResult(issues: VerificationIssue[], verifiedFields: string[]): VerificationResult {
  return {
    valid: issues.length === 0,
    errors: issues.map((issue) => issue.message),
    issues,
    verifiedFields,
  };
}

/** Exposed so a test can prove the registry has not drifted from the real sheets. */
export function knownFieldNames(agent: AgentId): readonly string[] {
  return DEPARTMENT_FIELD_NAMES[agent];
}
