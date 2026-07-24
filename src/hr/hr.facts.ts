import type { FactSheet } from "../domain/types";
import { derived, raw, roundTo } from "../grounding/factsheet";
import type { HrData, HrDerivedMetrics } from "./hr.types";

/**
 * Every HR metric is computed here, in TypeScript, before any prompt is built.
 * `fundedOpenRoles` and `departmentsOverCapacity` matter beyond this module:
 * the coordinator derives its joint constraints from them, via the agent's
 * verified facts rather than from raw HR data.
 */
export function computeHrMetrics(data: HrData): HrDerivedMetrics {
  const headcountFromDepartments = data.departments.reduce(
    (total, department) => total + department.headcount,
    0,
  );

  return {
    headcountFromDepartments,
    overtimeHoursPerEmployee: roundTo(data.overtimeHoursLastMonth / data.totalEmployees, 2),
    weeklyHoursAboveStandard: roundTo(data.averageWeeklyHours - data.standardWeeklyHours, 2),
    departmentsOverCapacity: data.departments
      .filter((department) => department.capacityStatus === "over_capacity")
      .map((department) => department.name),
    fundedOpenRoles: data.openRoles
      .filter((role) => role.status === "approved")
      .map((role) => role.title),
    unfundedOpenRoles: data.openRoles
      .filter((role) => role.status !== "approved")
      .map((role) => role.title),
    longestOpenRoleDays: data.openRoles.reduce((longest, role) => Math.max(longest, role.daysOpen), 0),
  };
}

export function buildHrFactSheet(data: HrData): FactSheet {
  const metrics = computeHrMetrics(data);
  const period = data.reportingPeriod;
  const people = { unit: "people", period };
  const hours = { unit: "hours", period };

  const entries: FactSheet["entries"] = {
    reportingPeriod: raw("Reporting period", period),
    totalEmployees: raw("Total employees", data.totalEmployees, people),
    openRolesCount: raw("Open roles", data.openRolesCount, people),
    averageWeeklyHours: raw("Average weekly hours", data.averageWeeklyHours, {
      unit: "hours per week",
      period,
    }),
    standardWeeklyHours: raw("Standard weekly hours", data.standardWeeklyHours, {
      unit: "hours per week",
    }),
    overtimeHoursLastMonth: raw("Overtime hours last month", data.overtimeHoursLastMonth, hours),
    voluntaryTurnoverPercent: raw("Voluntary turnover", data.voluntaryTurnoverPercent, {
      unit: "percent",
      period,
    }),
    averageTimeToHireDays: raw("Average time to hire", data.averageTimeToHireDays, {
      unit: "days",
      period,
    }),

    headcountFromDepartments: derived(
      "Headcount summed across departments",
      metrics.headcountFromDepartments,
      people,
    ),
    overtimeHoursPerEmployee: derived(
      "Overtime hours per employee",
      metrics.overtimeHoursPerEmployee,
      hours,
    ),
    weeklyHoursAboveStandard: derived(
      "Weekly hours above standard",
      metrics.weeklyHoursAboveStandard,
      { unit: "hours per week", period },
    ),
    departmentsOverCapacity: derived(
      "Departments over capacity",
      metrics.departmentsOverCapacity.join(", "),
      { period },
    ),
    fundedOpenRoles: derived("Open roles with approved budget", metrics.fundedOpenRoles.join(", "), {
      period,
    }),
    unfundedOpenRoles: derived(
      "Open roles awaiting budget",
      metrics.unfundedOpenRoles.join(", "),
      { period },
    ),
    longestOpenRoleDays: derived("Longest open role", metrics.longestOpenRoleDays, {
      unit: "days",
      period,
    }),
  };

  for (const department of data.departments) {
    entries[`departments.${department.name}.headcount`] = raw(
      `${department.name} headcount`,
      department.headcount,
      people,
    );
    entries[`departments.${department.name}.capacityStatus`] = raw(
      `${department.name} capacity status`,
      department.capacityStatus,
      { period },
    );
    const overtime = data.overtimeByDepartment[department.name];
    if (overtime !== undefined) {
      entries[`overtimeByDepartment.${department.name}`] = raw(
        `${department.name} overtime hours last month`,
        overtime,
        hours,
      );
    }
  }

  for (const role of data.openRoles) {
    entries[`openRoles.${role.title}.status`] = raw(`${role.title} budget status`, role.status, {
      period,
    });
    entries[`openRoles.${role.title}.daysOpen`] = raw(`${role.title} days open`, role.daysOpen, {
      unit: "days",
      period,
    });
  }

  return { agent: "hr", reportingPeriod: period, gaps: data.knownGaps, entries };
}
