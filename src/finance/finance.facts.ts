import type { FactSheet } from "../domain/types";
import { derived, raw, roundTo } from "../grounding/factsheet";
import type { FinanceData, FinanceDerivedMetrics } from "./finance.types";

/**
 * Every finance metric is computed here, in TypeScript, before any prompt is
 * built. The model receives finished numbers and is never asked to divide.
 */
export function computeFinanceMetrics(data: FinanceData): FinanceDerivedMetrics {
  const monthlyOperatingProfit = data.monthlyRevenue - data.monthlyOperatingCosts;
  const availableAnnualHiringBudget =
    data.approvedAnnualHiringBudget - data.committedAnnualHiringBudget;

  return {
    monthlyOperatingProfit,
    operatingMarginPercent: roundTo((monthlyOperatingProfit / data.monthlyRevenue) * 100, 2),
    // Deliberately the zero-revenue stress case; the definition ships with the data.
    cashRunwayMonths: roundTo(data.cashOnHand / data.monthlyOperatingCosts, 2),
    availableAnnualHiringBudget,
    maxAffordableAdditionalHires: Math.floor(
      availableAnnualHiringBudget / data.benchmarkAnnualLoadedCostPerHire,
    ),
  };
}

export function buildFinanceFactSheet(data: FinanceData): FactSheet {
  const metrics = computeFinanceMetrics(data);
  const period = data.reportingPeriod;
  const eur = { unit: "EUR", period };

  return {
    agent: "finance",
    reportingPeriod: period,
    gaps: data.knownGaps,
    entries: {
      reportingPeriod: raw("Reporting period", period),
      monthlyRevenue: raw("Monthly revenue", data.monthlyRevenue, eur),
      monthlyOperatingCosts: raw("Monthly operating costs", data.monthlyOperatingCosts, eur),
      "operatingCostBreakdown.payroll": raw("Payroll cost", data.operatingCostBreakdown.payroll, eur),
      "operatingCostBreakdown.propertyMaintenance": raw(
        "Property maintenance cost",
        data.operatingCostBreakdown.propertyMaintenance,
        eur,
      ),
      "operatingCostBreakdown.marketing": raw(
        "Marketing cost",
        data.operatingCostBreakdown.marketing,
        eur,
      ),
      "operatingCostBreakdown.softwareAndTools": raw(
        "Software and tools cost",
        data.operatingCostBreakdown.softwareAndTools,
        eur,
      ),
      "operatingCostBreakdown.other": raw("Other operating cost", data.operatingCostBreakdown.other, eur),
      cashOnHand: raw("Cash on hand", data.cashOnHand, eur),
      approvedAnnualHiringBudget: raw(
        "Approved annual hiring budget",
        data.approvedAnnualHiringBudget,
        eur,
      ),
      committedAnnualHiringBudget: raw(
        "Already committed hiring budget",
        data.committedAnnualHiringBudget,
        eur,
      ),
      benchmarkAnnualLoadedCostPerHire: raw(
        "Benchmark annual loaded cost per hire",
        data.benchmarkAnnualLoadedCostPerHire,
        { ...eur, note: "Market benchmark and an assumption, not an agreed offer figure." },
      ),
      projectedAnnualGrowthPercent: raw(
        "Projected annual growth",
        data.projectedAnnualGrowthPercent,
        { unit: "percent", period },
      ),
      outstandingReceivables: raw("Outstanding receivables", data.outstandingReceivables, eur),
      runwayDefinition: raw("Runway definition", data.runwayDefinition),

      monthlyOperatingProfit: derived("Monthly operating profit", metrics.monthlyOperatingProfit, eur),
      operatingMarginPercent: derived("Operating margin", metrics.operatingMarginPercent, {
        unit: "percent",
        period,
      }),
      cashRunwayMonths: derived("Cash runway", metrics.cashRunwayMonths, {
        unit: "months",
        period,
        note: data.runwayDefinition,
      }),
      availableAnnualHiringBudget: derived(
        "Available annual hiring budget",
        metrics.availableAnnualHiringBudget,
        eur,
      ),
      maxAffordableAdditionalHires: derived(
        "Maximum affordable additional hires",
        metrics.maxAffordableAdditionalHires,
        {
          unit: "people",
          period,
          note: "availableAnnualHiringBudget divided by benchmarkAnnualLoadedCostPerHire, rounded down.",
        },
      ),
    },
  };
}
