import { describe, expect, it } from "vitest";

import financeJson from "../src/finance/finance.data.json";
import hrJson from "../src/hr/hr.data.json";
import { buildFinanceFactSheet, computeFinanceMetrics } from "../src/finance/finance.facts";
import { buildHrFactSheet, computeHrMetrics } from "../src/hr/hr.facts";
import type { FinanceData } from "../src/finance/finance.types";
import type { HrData } from "../src/hr/hr.types";

const financeData = financeJson as FinanceData;
const hrData = hrJson as HrData;

/**
 * Serialise only the data-bearing fields, dropping the documentation arrays.
 * `knownGaps` and `assumptions` describe what a dataset deliberately lacks, so
 * scanning them for forbidden terms would flag the very disclosure we want.
 */
function serialiseDataFields(data: object): string {
  const {
    knownGaps: _gaps,
    assumptions: _assumptions,
    ...dataFields
  } = data as Record<string, unknown>;
  return JSON.stringify(dataFields);
}

/**
 * The mock data is only useful if it is internally consistent — a dataset that
 * contradicts itself would make every downstream grounding claim meaningless.
 * These assertions pin the invariants described in the plan's data section.
 */
describe("finance dataset", () => {
  it("operating cost categories sum to the stated total", () => {
    const breakdown = financeData.operatingCostBreakdown;
    const sum =
      breakdown.payroll +
      breakdown.propertyMaintenance +
      breakdown.marketing +
      breakdown.softwareAndTools +
      breakdown.other;

    expect(sum).toBe(financeData.monthlyOperatingCosts);
    expect(sum).toBe(356_000);
  });

  it("derived metrics match hand-computed values", () => {
    const metrics = computeFinanceMetrics(financeData);

    expect(metrics.monthlyOperatingProfit).toBe(56_000);
    expect(metrics.operatingMarginPercent).toBe(13.59);
    expect(metrics.cashRunwayMonths).toBe(8);
    expect(metrics.availableAnnualHiringBudget).toBe(52_000);
    expect(metrics.maxAffordableAdditionalHires).toBe(1);
  });

  it("available hiring budget is approved minus committed", () => {
    expect(
      financeData.approvedAnnualHiringBudget - financeData.committedAnnualHiringBudget,
    ).toBe(52_000);
  });

  it("holds no compensation data, which belongs to HR's scope", () => {
    // Only data-bearing fields are scanned: `knownGaps` and `assumptions` are
    // prose that deliberately names what is absent.
    const serialised = serialiseDataFields(financeData).toLowerCase();
    expect(serialised).not.toContain("salary");
    expect(serialised).not.toContain("compensation");
    expect(serialised).not.toContain("headcount");
  });

  it("exposes the metrics the coordinator depends on", () => {
    const sheet = buildFinanceFactSheet(financeData);
    expect(sheet.entries["maxAffordableAdditionalHires"]?.value).toBe(1);
    expect(sheet.entries["availableAnnualHiringBudget"]?.value).toBe(52_000);
  });
});

describe("hr dataset", () => {
  it("department headcounts sum to the stated total", () => {
    const sum = hrData.departments.reduce((total, d) => total + d.headcount, 0);

    expect(sum).toBe(hrData.totalEmployees);
    expect(sum).toBe(34);
  });

  it("departmental overtime sums to the stated total", () => {
    const sum = Object.values(hrData.overtimeByDepartment).reduce((total, h) => total + h, 0);

    expect(sum).toBe(hrData.overtimeHoursLastMonth);
    expect(sum).toBe(310);
  });

  it("open role list matches the open role count", () => {
    expect(hrData.openRoles.length).toBe(hrData.openRolesCount);
    expect(hrData.openRoles.length).toBe(2);
  });

  it("every over-capacity department carries at least 12 overtime hours per employee", () => {
    const overCapacity = hrData.departments.filter((d) => d.capacityStatus === "over_capacity");
    expect(overCapacity.length).toBeGreaterThan(0);

    for (const department of overCapacity) {
      const overtime = hrData.overtimeByDepartment[department.name] ?? 0;
      expect(overtime / department.headcount).toBeGreaterThanOrEqual(12);
    }
  });

  it("derived metrics match hand-computed values", () => {
    const metrics = computeHrMetrics(hrData);

    expect(metrics.headcountFromDepartments).toBe(34);
    expect(metrics.overtimeHoursPerEmployee).toBe(9.12);
    expect(metrics.weeklyHoursAboveStandard).toBe(1.5);
    expect(metrics.departmentsOverCapacity).toEqual(["operations", "maintenance"]);
    expect(metrics.fundedOpenRoles).toEqual(["Maintenance Coordinator"]);
    expect(metrics.unfundedOpenRoles).toEqual(["Operations Associate"]);
    expect(metrics.longestOpenRoleDays).toBe(63);
  });

  it("holds no monetary data, which belongs to Finance's scope", () => {
    const serialised = serialiseDataFields(hrData).toLowerCase();
    expect(serialised).not.toContain("salary");
    expect(serialised).not.toContain("compensation");
    expect(serialised).not.toContain("revenue");
    expect(serialised).not.toContain("eur");
  });

  it("exposes the metrics the coordinator depends on", () => {
    const sheet = buildHrFactSheet(hrData);
    expect(sheet.entries["fundedOpenRoles"]?.value).toBe("Maintenance Coordinator");
    expect(sheet.entries["departmentsOverCapacity"]?.value).toBe("operations, maintenance");
  });
});

describe("cross-dataset consistency", () => {
  it("both datasets describe the same reporting period", () => {
    expect(financeData.reportingPeriod).toBe(hrData.reportingPeriod);
    expect(financeData.reportingPeriod).toBe("2026-Q2");
  });

  it("the two datasets share no field names beyond the reporting period", () => {
    const financeFields = new Set(Object.keys(financeData));
    const shared = Object.keys(hrData).filter((key) => financeFields.has(key));

    expect(shared).toEqual(["reportingPeriod", "knownGaps"]);
  });

  it("finance funds exactly one hire while HR has two open roles", () => {
    // This tension is the point of the joint flow: neither agent can resolve it alone.
    expect(computeFinanceMetrics(financeData).maxAffordableAdditionalHires).toBe(1);
    expect(hrData.openRoles.length).toBe(2);
  });
});
