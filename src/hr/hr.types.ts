/**
 * HR's data contract. Note the absence of any monetary field: HR structurally
 * cannot answer an affordability question, and says so rather than inventing one.
 */

export type CapacityStatus = "under_capacity" | "balanced" | "over_capacity";

export type OpenRoleStatus = "approved" | "pending_budget" | "on_hold";

export interface HrDepartment {
  name: string;
  headcount: number;
  capacityStatus: CapacityStatus;
}

export interface HrOpenRole {
  title: string;
  department: string;
  status: OpenRoleStatus;
  daysOpen: number;
}

export interface HrData {
  reportingPeriod: string;
  totalEmployees: number;
  departments: HrDepartment[];
  openRolesCount: number;
  openRoles: HrOpenRole[];
  averageWeeklyHours: number;
  standardWeeklyHours: number;
  overtimeHoursLastMonth: number;
  overtimeByDepartment: Record<string, number>;
  voluntaryTurnoverPercent: number;
  averageTimeToHireDays: number;
  knownGaps: string[];
}

/** Metrics computed in TypeScript. The model is never asked to do arithmetic. */
export interface HrDerivedMetrics {
  headcountFromDepartments: number;
  overtimeHoursPerEmployee: number;
  weeklyHoursAboveStandard: number;
  departmentsOverCapacity: string[];
  fundedOpenRoles: string[];
  unfundedOpenRoles: string[];
  longestOpenRoleDays: number;
}
