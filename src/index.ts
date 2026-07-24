import { createInterface } from "node:readline/promises";

import { renderExplain } from "./cli/explain";
import {
  renderAnalysis,
  renderClarification,
  renderJoint,
  renderJointRejection,
  renderRejection,
  renderRoute,
  renderUnsupported,
} from "./cli/render";
import { loadEnv, type Env } from "./config/env";
import { ExitCode, exitCodeFor, userFacingMessage, type ExitCodeValue } from "./domain/errors";
import type { AgentAnalysis, RouteDecision } from "./domain/types";
import {
  answerJointQuestion,
  deriveJointConstraints,
  type JointConstraints,
  type JointOutcome,
} from "./orchestration/coordinator";
import { classifyQuestion } from "./routing/llm-router";
import { isAmbiguous, routeQuestion } from "./routing/router";
import { createApplication, type Application } from "./composition";

/**
 * CLI entry point. Parses arguments, routes the question, dispatches to the
 * right agents and renders the result. It receives only wired components from
 * the composition root and never touches a dataset itself.
 */

interface CliOptions {
  question: string;
  explain: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const args = argv.slice(2);
  const explain = args.includes("--explain");
  const question = args.filter((arg) => !arg.startsWith("--")).join(" ").trim();

  return { question, explain };
}

async function resolveRoute(app: Application, question: string): Promise<RouteDecision> {
  const decision = routeQuestion(question);
  // Only genuinely ambiguous questions cost a model call; the common path is free.
  if (!isAmbiguous(decision)) return decision;

  try {
    const classified = await classifyQuestion(app.llm, question);
    return isAmbiguous(classified) ? classified : classified;
  } catch {
    // If the classifier is unavailable, fail closed on the deterministic result.
    return decision;
  }
}

async function answerQuestion(
  app: Application,
  options: CliOptions,
): Promise<{ output: string; exitCode: ExitCodeValue }> {
  const decision = await resolveRoute(app, options.question);
  const blocks: string[] = [renderRoute(decision)];

  const analyses: AgentAnalysis[] = [];
  let joint: { outcome: JointOutcome; constraints: JointConstraints } | undefined;
  let exitCode: ExitCodeValue = ExitCode.Ok;

  if (decision.target === "unsupported") {
    blocks.push(isAmbiguous(decision) ? renderClarification(decision) : renderUnsupported(decision));
    exitCode = ExitCode.Unsupported;
  } else if (decision.target === "both") {
    const result = await answerJointQuestion({
      llm: app.llm,
      financeAgent: app.financeAgent,
      hrAgent: app.hrAgent,
      question: options.question,
    });

    analyses.push(result.finance, result.hr);
    joint = {
      outcome: result.outcome,
      constraints: deriveJointConstraints(result.finance, result.hr),
    };

    for (const analysis of analyses) {
      blocks.push(analysis.trusted ? renderAnalysis(analysis) : renderRejection(analysis));
    }

    blocks.push(
      result.outcome.trusted ? renderJoint(result.outcome) : renderJointRejection(result.outcome),
    );

    if (!result.outcome.trusted || analyses.some((analysis) => !analysis.trusted)) {
      exitCode = ExitCode.VerificationRejected;
    }
  } else {
    const agent = decision.target === "finance" ? app.financeAgent : app.hrAgent;
    const analysis = await agent.answer(options.question);
    analyses.push(analysis);

    blocks.push(analysis.trusted ? renderAnalysis(analysis) : renderRejection(analysis));
    if (!analysis.trusted) exitCode = ExitCode.VerificationRejected;
  }

  if (options.explain) {
    blocks.push(
      renderExplain({
        decision,
        analyses,
        ...(joint ? { joint } : {}),
        stats: app.llm.getStats(),
        model: process.env["LLM_PROVIDER"] === "anthropic" ? "anthropic" : "mock",
      }),
    );
  }

  return { output: blocks.join("\n\n"), exitCode };
}

async function runInteractive(app: Application, explain: boolean): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log("Cherry Host AI — ask a finance or workforce question. Type :exit to quit.\n");

  try {
    for (;;) {
      const question = (await rl.question("> ")).trim();
      if (question === ":exit" || question === ":quit") break;
      if (question.length === 0) continue;

      try {
        const { output } = await answerQuestion(app, { question, explain });
        console.log(`\n${output}\n`);
      } catch (error) {
        console.error(`\n${userFacingMessage(error)}\n`);
      }
    }
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  let env: Env;
  try {
    env = loadEnv();
  } catch (error) {
    console.error(userFacingMessage(error));
    process.exitCode = exitCodeFor(error);
    return;
  }

  const app = createApplication(env);
  const options = parseArgs(process.argv);

  if (options.question.length === 0) {
    await runInteractive(app, options.explain);
    return;
  }

  try {
    const { output, exitCode } = await answerQuestion(app, options);
    console.log(output);
    process.exitCode = exitCode;
  } catch (error) {
    console.error(userFacingMessage(error));
    process.exitCode = exitCodeFor(error);
  }
}

void main();
