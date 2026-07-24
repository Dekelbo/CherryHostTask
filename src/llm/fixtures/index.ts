import type { AgentId } from "../../domain/types";
import type { LlmPurpose } from "../client";

import financeHiring from "./analysis.finance.hiring.json";
import financeMargin from "./analysis.finance.margin.json";
import hrCapacity from "./analysis.hr.capacity.json";
import hrHiring from "./analysis.hr.hiring.json";
import coordinationHiring from "./coordination.hiring.json";
import routingAmbiguous from "./routing.ambiguous.json";

/**
 * Fixtures are imported statically rather than read from disk so that offline
 * mode works identically under `tsx`, `vitest` and a compiled `dist/` build.
 */
export interface Fixture {
  id: string;
  purpose: LlmPurpose;
  agent?: AgentId;
  /** Used when no keyword matches, so a demo question never dead-ends. */
  fallback: boolean;
  match: string[];
  response: unknown;
}

export const FIXTURES: readonly Fixture[] = [
  financeMargin,
  financeHiring,
  hrCapacity,
  hrHiring,
  coordinationHiring,
  routingAmbiguous,
] as Fixture[];
