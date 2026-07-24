/**
 * Finance's data contract. It shares no meaningful field with `HrData`, so
 * passing one where the other is expected is a compile error rather than a
 * runtime data leak. That is mechanism #2 of the isolation design.
 */

export interface FinanceOperatingCostBreakdown {
  payroll: number;
  propertyMaintenance: number;
  marketing: number;
  softwareAndTools: number;
  other: number;
}

export interface FinanceData {
  reportingPeriod: string;
  currency: string;
  monthlyRevenue: number;
  monthlyOperatingCosts: number;
  operatingCostBreakdown: FinanceOperatingCostBreakdown;
  cashOnHand: number;
  approvedAnnualHiringBudget: number;
  committedAnnualHiringBudget: number;
  benchmarkAnnualLoadedCostPerHire: number;
  projectedAnnualGrowthPercent: number;
  outstandingReceivables: number;
  /** Stored in the dataset so the definition travels with the number. */
  runwayDefinition: string;
  assumptions: string[];
  knownGaps: string[];
}

/** Metrics computed in TypeScript. The model is never asked to do arithmetic. */
export interface FinanceDerivedMetrics {
  monthlyOperatingProfit: number;
  operatingMarginPercent: number;
  cashRunwayMonths: number;
  availableAnnualHiringBudget: number;
  maxAffordableAdditionalHires: number;
}
