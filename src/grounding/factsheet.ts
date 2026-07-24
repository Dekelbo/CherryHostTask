import type { FactEntry, FactSheet } from "../domain/types";

/**
 * FactSheet construction helpers. A FactSheet is the complete set of values an
 * agent is permitted to cite: raw dataset fields plus metrics computed here in
 * TypeScript. The verifier checks every claim against this, so the sheet is
 * simultaneously the prompt's content and the allowlist.
 */

export interface FactEntryOptions {
  unit?: string;
  period?: string;
  note?: string;
}

/** A value read directly from the department's dataset. */
export function raw(
  label: string,
  value: string | number,
  options: FactEntryOptions = {},
): FactEntry {
  return buildEntry(label, value, false, options);
}

/** A value computed in TypeScript. Flagged so `--explain` can show provenance. */
export function derived(
  label: string,
  value: string | number,
  options: FactEntryOptions = {},
): FactEntry {
  return buildEntry(label, value, true, options);
}

function buildEntry(
  label: string,
  value: string | number,
  isDerived: boolean,
  options: FactEntryOptions,
): FactEntry {
  const entry: FactEntry = { value, label, isDerived };
  if (options.unit !== undefined) entry.unit = options.unit;
  if (options.period !== undefined) entry.period = options.period;
  if (options.note !== undefined) entry.note = options.note;
  return entry;
}

/** Round to `places` decimals, avoiding accumulated float noise in derived metrics. */
export function roundTo(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

export function factSheetFieldNames(sheet: FactSheet): string[] {
  return Object.keys(sheet.entries);
}

export function lookupFact(sheet: FactSheet, fieldPath: string): FactEntry | undefined {
  return Object.prototype.hasOwnProperty.call(sheet.entries, fieldPath)
    ? sheet.entries[fieldPath]
    : undefined;
}

/**
 * Render the sheet as a labelled table for the prompt. This is the *only*
 * business data an agent's prompt ever contains — if a value is not here, the
 * model has no legitimate way to state it.
 */
export function renderFactSheet(sheet: FactSheet): string {
  const rows = Object.entries(sheet.entries).map(([fieldPath, entry]) => {
    const unit = entry.unit ? ` ${entry.unit}` : "";
    const origin = entry.isDerived ? " (derived in code)" : "";
    const note = entry.note ? ` — ${entry.note}` : "";
    return `- ${fieldPath}: ${entry.value}${unit} | ${entry.label}${origin}${note}`;
  });

  const gaps =
    sheet.gaps.length > 0
      ? `\n\nKnown gaps in this dataset (state these plainly if asked; never fill them in):\n${sheet.gaps
          .map((gap) => `- ${gap}`)
          .join("\n")}`
      : "";

  return `Reporting period: ${sheet.reportingPeriod}\n\nAuthorised fields:\n${rows.join("\n")}${gaps}`;
}
