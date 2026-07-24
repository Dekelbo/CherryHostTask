import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { createApplication } from "../src/composition";
import { loadEnv } from "../src/config/env";
import type { AgentAnalysis, LlmAnalysis } from "../src/domain/types";
import { answerJointQuestion } from "../src/orchestration/coordinator";
import { classifyQuestion } from "../src/routing/llm-router";

/**
 * Records live Anthropic responses into `src/llm/fixtures/`, so offline mode
 * demonstrates real model behaviour rather than authored prose.
 *
 * Run deliberately, with a real key:  npx tsx scripts/capture-fixtures.ts
 * Only the `response` field is rewritten; ids, matching rules and fallback
 * flags are preserved. Every captured analysis must already be `trusted`.
 */
const FIXTURE_DIR = path.resolve(__dirname, "../src/llm/fixtures");

function write(fileName: string, response: unknown): void {
  const file = path.join(FIXTURE_DIR, fileName);
  const fixture = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  fixture["response"] = response;
  fixture["recordedAt"] = new Date().toISOString().slice(0, 10);
  writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
  console.log(`recorded ${fileName}`);
}

/** Strip the application's verification envelope back to the model's own output. */
function toLlmAnalysis(analysis: AgentAnalysis): LlmAnalysis {
  const { trusted: _t, verification: _v, fieldsUsed: _f, ...llm } = analysis;
  return llm;
}

function requireTrusted(label: string, analysis: AgentAnalysis): AgentAnalysis {
  if (!analysis.trusted) {
    throw new Error(
      `Refusing to record ${label}: response failed verification — ${analysis.verification.errors.join("; ")}`,
    );
  }
  return analysis;
}

async function main(): Promise<void> {
  const env = loadEnv();
  if (env.LLM_PROVIDER !== "anthropic") {
    throw new Error("Set LLM_PROVIDER=anthropic to record fixtures from the live API.");
  }

  const app = createApplication(env);

  const margin = requireTrusted(
    "finance margin",
    await app.financeAgent.answer("What is our operating margin?"),
  );
  write("analysis.finance.margin.json", toLlmAnalysis(margin));

  const capacity = requireTrusted(
    "hr capacity",
    await app.hrAgent.answer("Which team is over capacity?"),
  );
  write("analysis.hr.capacity.json", toLlmAnalysis(capacity));

  const joint = await answerJointQuestion({
    llm: app.llm,
    financeAgent: app.financeAgent,
    hrAgent: app.hrAgent,
    question: "Should we hire more people?",
  });

  requireTrusted("finance hiring", joint.finance);
  requireTrusted("hr hiring", joint.hr);
  if (!joint.outcome.trusted) {
    throw new Error(
      `Refusing to record coordination: ${joint.outcome.verification.errors.join("; ")}`,
    );
  }

  write("analysis.finance.hiring.json", toLlmAnalysis(joint.finance));
  write("analysis.hr.hiring.json", toLlmAnalysis(joint.hr));

  const { question: _q, ...coordinatorOutput } = joint.outcome.recommendation;
  write("coordination.hiring.json", coordinatorOutput);

  const routing = await classifyQuestion(app.llm, "How are we doing?");
  write("routing.ambiguous.json", {
    target: routing.target,
    confidence: routing.confidence,
    reason: routing.reason,
    intent: routing.intent,
  });

  console.log(`\ntokens used: ${JSON.stringify(app.llm.getStats())}`);
}

void main();
