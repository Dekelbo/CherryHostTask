# HANDOFF — Cherry Host / REJ AI Engineer Assessment

**Read this file first. It is self-contained.** It carries the full approved plan from a prior
planning session. You do not need that conversation.

- **Project path:** `C:\Users\dekel\Desktop\cherry\CherryHostTask`
- **Reference doc in repo:** `docs/cherry_host_codex_project_brief.md` (the original client brief —
  authoritative on requirements; this HANDOFF is authoritative on decisions and workflow)
- **Status:** plan approved. Follow the four-stage workflow in §17 exactly.
- **Deadline:** submit within 72h of receiving the assessment. Target ~3.5 focused hours of build.

---

## 0. Three open questions — confirm with the user before Phase 2

Defaults are in place; the user may override.

1. **`AgentAnalysis` shape.** Default = the `LlmAnalysis` / `AgentAnalysis` split in §4 (model output +
   application-added verification metadata). Alternative = keep `AgentAnalysis` byte-identical to the
   client brief and carry verification separately.
2. **`JointRecommendation` enum.** Default = generic `proceed | proceed_conditionally |
   do_not_proceed | insufficient_data`. Alternative = the brief's hiring-specific
   `hire | do_not_hire | hire_conditionally | insufficient_data`.
3. **Offline fixture mode.** Default = in the MVP (`LLM_PROVIDER=mock`).

If the user says "your call," use the defaults.

---

## 1. Context — what is actually being evaluated

Cherry Host (Madrid student rentals) + REJ Investment (Israeli investors buying Madrid property)
share one React/TS codebase and one Supabase DB with ~228 tables. Their roadmap has 8 department
"agents" on that shared database, plus a central Platform Brain and per-employee assistants.

The practical task (two agents, mock JSON, a router) is a proxy for three real questions:

1. **Do you understand that a shared database is a security problem?** With 8 agents on 228 tables,
   the real risk is the Finance agent answering from HR salary rows. A candidate whose isolation
   answer is "I put it in the system prompt" will build them a breach. Highest-signal item.
2. **Do you know that an LLM stating a number is not the same as the number being true?** Their "AI
   Agent Meeting" concept is a hallucination generator by construction.
3. **Can you scope, ship, and explain?** Three written answers at 5–10 sentences each, and a README a
   non-author can follow.

**Therefore the differentiator is not features.** It is that isolation and grounding are mechanically
enforced and proven by tests a reviewer can run — including with no API key.

---

## 2. Architecture

```
                        composition.ts
              (the ONLY module that sees both datasets)
                              |
        +---------------------+---------------------+
        |                     |                     |
  createFinanceAgent    createHrAgent          LlmClient
   (financeData)          (hrData)             (shared)
        |                     |
        +---- closure --------+
     data is captured, never exposed
        |                     |
        v                     v
   DepartmentAgent      DepartmentAgent   <- router & orchestrator see ONLY this
   { id, answer }       { id, answer }


RUNTIME FLOW
CLI question
   |
   v
Router  (deterministic rules -> LLM fallback only if ambiguous)
   |     receives the question only - never any department data
   |
   +- finance -----> financeAgent.answer(q)
   +- hr ----------> hrAgent.answer(q)
   +- both --------> Promise.all([ financeAgent.answer(q), hrAgent.answer(q) ])
   |                        | parallel, isolated; neither sees the other's data or output
   |                        v
   |                  Coordinator - receives the two AgentAnalysis objects only
   |                        v
   |                  JointRecommendation
   |
   +- unsupported -> clarification (no agent runs, no LLM call)


INSIDE agent.answer(question)
  1. build FactSheet from closed-over data (raw + code-derived metrics)
  2. build department prompt from the FactSheet only
  3. LLM call -> structured output
  4. verify every claim against the FactSheet
  5. one repair retry on failure
  6. return AgentAnalysis with { trusted, verification } attached
```

Plain functions and closures throughout. **No base classes, no registry, no plugin system, no
framework.** This is a focused, production-aware POC — not a generic multi-agent platform.

---

## 3. Project structure — 22 source files, 6 test files

```
CherryHostTask/
├── src/
│   ├── index.ts                    CLI entry: args, flags, render, exit codes
│   ├── composition.ts              * COMPOSITION ROOT - wiring only
│   │
│   ├── config/env.ts               zod-validated env, fails fast, never logs keys
│   │
│   ├── domain/
│   │   ├── types.ts                AgentId, RouteTarget, DepartmentAgent, AgentAnalysis, ...
│   │   ├── schemas.ts              zod schemas for every LLM output
│   │   └── errors.ts               typed errors; no provider payloads reach stdout
│   │
│   ├── finance/
│   │   ├── finance.data.json       mock dataset
│   │   ├── finance.types.ts        FinanceData
│   │   ├── finance.facts.ts        derived metrics + FactSheet builder
│   │   ├── finance.prompt.ts       system prompt (input: FactSheet only)
│   │   └── finance.agent.ts        createFinanceAgent(deps) -> DepartmentAgent
│   │
│   ├── hr/                         hr.data.json, hr.types.ts, hr.facts.ts,
│   │                               hr.prompt.ts, hr.agent.ts   (exact mirror)
│   │
│   ├── agents/run-analysis.ts      shared call->parse->verify->retry helper.
│   │                               Generic over FactSheet. Knows no department.
│   │
│   ├── routing/
│   │   ├── lexicon.ts              keyword weights + joint-intent phrases (data only)
│   │   ├── router.ts               deterministic scoring -> RouteDecision
│   │   └── llm-router.ts           ambiguity fallback (question + capability text only)
│   │
│   ├── grounding/
│   │   ├── factsheet.ts            FactSheet type + builder helpers
│   │   └── verify.ts               field allowlist, value match, unbacked-number scan
│   │
│   ├── orchestration/coordinator.ts   joint constraints + coordinator prompt + call
│   │
│   ├── llm/
│   │   ├── client.ts               LlmClient interface
│   │   ├── anthropic-client.ts     real provider: retry, timeout, error mapping
│   │   ├── mock-client.ts          fixture-backed client (tests + offline mode)
│   │   └── fixtures/*.json         recorded responses - COMMITTED, not ignored
│   │
│   └── cli/
│       ├── render.ts               human-readable output
│       └── explain.ts              --explain trace from structured metadata only
│
├── tests/
│   ├── setup.ts                    global guard: any real network call throws
│   ├── router.test.ts
│   ├── isolation.test.ts           * the headline file
│   ├── verification.test.ts
│   ├── data-consistency.test.ts
│   └── joint-recommendation.test.ts
│
├── docs/cherry_host_codex_project_brief.md
├── README.md   DECISIONS.md   ASSESSMENT_ANSWERS.md
├── .env.example   .gitignore
└── package.json   tsconfig.json   vitest.config.ts
```

### composition.ts — the rules

~15 lines. It:
- imports `finance.data.json` and `hr.data.json` — **the only module permitted to import both**
- constructs the `LlmClient` (real or mock, per `LLM_PROVIDER`)
- calls `createFinanceAgent({ llm, data: financeData })`
- calls `createHrAgent({ llm, data: hrData })`
- returns `{ router, financeAgent, hrAgent, coordinator, llm }`

It **must not** analyze, merge, transform, inspect, or re-export the datasets, and must never build a
combined object. `index.ts` receives only wired components and never touches data. Enforced by a test,
not by discipline.

---

## 4. Contracts

```ts
type AgentId = "finance" | "hr";
type RouteTarget = AgentId | "both" | "unsupported";

interface DepartmentAgent {
  id: AgentId;
  answer(question: string): Promise<AgentAnalysis>;
}
```

Router and orchestrator hold agents **only** as `DepartmentAgent`. The interface exposes no path to
department data.

```ts
// what the MODEL returns - validated by zod, matches the client brief's shape
interface LlmAnalysis {
  agent: AgentId;
  summary: string;
  facts: GroundedFact[];
  concerns: string[];
  recommendation: string;
  missingInformation: string[];
  confidence: number;
}

// what the AGENT returns - model output plus application-verified metadata
interface AgentAnalysis extends LlmAnalysis {
  trusted: boolean;                 // false => never presented as a business answer
  verification: VerificationResult;
  fieldsUsed: string[];             // powers --explain
}

interface RouteDecision {
  target: RouteTarget;
  confidence: number;
  reason: string;
  intent: string;
  source: "rules" | "llm";
  matchedSignals: string[];
}

interface GroundedFact {
  claim: string;
  label: string;
  value: string | number;
  sourceField: string;              // must exist in the citing agent's FactSheet
  reportingPeriod?: string;
}

interface VerificationIssue {
  code: "UNKNOWN_FIELD" | "VALUE_MISMATCH" | "CROSS_DEPARTMENT_FIELD_REFERENCE"
      | "UNBACKED_NUMERIC_CLAIM" | "POLICY_CONFLICT";
  message: string;
  sourceField?: string;
  expected?: string | number;
  received?: string | number;
}

interface VerificationResult {
  valid: boolean;
  errors: string[];                 // brief-compatible flat list
  issues: VerificationIssue[];      // structured detail for tests and --explain
  verifiedFields: string[];
}

interface JointRecommendation {
  question: string;
  recommendation: "proceed" | "proceed_conditionally" | "do_not_proceed" | "insufficient_data";
  headline: string;
  summary: string;
  financePerspective: string;
  hrPerspective: string;
  conditions: string[];
  risks: string[];
  missingInformation: string[];
  supportingFacts: GroundedFact[];  // must be a subset of upstream verified facts
  confidence: number;
}

function createFinanceAgent(deps: { llm: LlmClient; data: FinanceData }): DepartmentAgent;
function createHrAgent(deps: { llm: LlmClient; data: HrData }): DepartmentAgent;
```

`data` is captured in the closure. The returned object has exactly `id` and `answer` — nothing else is
reachable from outside.

---

## 5. Data flow

- **Finance-only** (`"What is our operating margin?"`) — rules route to `finance`, no LLM routing call.
  `hrData` is never referenced in this call stack.
- **HR-only** (`"Which team is over capacity?"`) — symmetric. HR has no salary fields, so cost
  questions come back with the gap in `missingInformation`, never an invented number.
- **Both** (`"Should we hire more people?"`) — joint-intent phrase → `both`. Agents run **concurrently
  via `Promise.all`**, isolated: separate data, prompts, verification; neither sees the other's output.
  The coordinator then derives deterministic constraints from the two verified analyses
  (`maxAffordableHires`, `departmentsOverCapacity`, `fundedOpenRoles`), makes one model call, and returns
  a `JointRecommendation` whose numbers all already appear in verified upstream facts.
  *Parallelism is not a perf flourish — it is proof of independence, and the honest 8-agent scaling story.*
- **Unsupported** (`"What is the weather in Madrid?"`) — zero domain signal → `unsupported`
  deterministically, **no LLM call at all**.
- **Ambiguous** (`"How are we doing?"`) — low confidence → LLM classifier (question + one-line department
  descriptions, no data) → still below threshold → clarification listing what each department can answer.
  The system asks; it does not guess.
- **Agent failure inside `both`** — the wrapper catches provider and verification failures and returns
  `trusted: false` rather than throwing; the coordinator then returns `insufficient_data`.

---

## 6. Isolation — four mechanisms, none of them a prompt

1. **Composition Root** — one wiring-only file imports both datasets. Enforced by source-scan test.
2. **Department-scoped parameter types** — `FinanceData` and `HrData` share no fields, so swapping them
   is a compile error. *No branded types — they added nothing here.*
3. **Closure encapsulation** — data is captured in the factory, not a property of the returned object.
   No accessor, no getter, no `.data`.
4. **Output verification** — every cited `sourceField` is checked against that agent's own FactSheet. A
   foreign field returns `CROSS_DEPARTMENT_FIELD_REFERENCE`, checked against a name registry without
   loading the other dataset.

Plus the top boundary: the coordinator's signature accepts `AgentAnalysis` objects only, and its module
imports no data file.

System prompts still say "answer only from the supplied facts" because it improves behaviour. **The
README must state plainly that prompts are guidance, not a security boundary**, and point at the four
mechanisms and the tests that prove them.

**Production mapping (README only, do not build):** fact sheets → authorised Supabase RPCs; field
allowlist → agent tool allowlist; composition root → server-side authorisation on
`(user, company_id, department)`; verification layer unchanged; RLS enforces at the DB so an app bug
cannot cross it; fail closed; audit sensitive calls; the model never emits executable SQL.

---

## 7. Grounding and claim verification

1. **Compute in TypeScript first** — operating profit, margin, runway, available hiring budget, max
   affordable hires, overtime per employee. The model never does arithmetic.
2. **The FactSheet is the model's entire universe** — flat `fieldPath -> { value, label, unit, period,
   isDerived }`, rendered into the prompt as a labelled table.
3. **Schema validation** — structured output parsed with zod.
4. **Field verification** — field exists in *this* agent's sheet; value matches after normalisation
   (`"€52,000"` / `"52000"` / `52000` all equal; floats within 0.01); foreign fields get their own code.
5. **Unbacked-number scan** — every numeric token in `summary`, `recommendation`, `concerns` must resolve
   to a verified fact or sit in a small documented safe list (numbers echoed from the question, small
   ordinals, the reporting period). Closes the gap where `facts[]` is cited perfectly but the prose
   invents "roughly €60k of headroom."
6. **One repair retry**, with the specific errors appended as constraints.
7. **Visible failure** — second failure → `trusted: false`; the CLI prints the rejection and the errors
   instead of the answer. A refused answer beats a wrong one.
8. **Coordinator grounding** — its numeric vocabulary is the union of verified upstream facts; it cannot
   introduce a number. If code computed `maxAffordableHires === 0` and the model returned `proceed`,
   that is `POLICY_CONFLICT` and is rejected.

---

## 8. Mock data — internally consistent by design

Shared `reportingPeriod: "2026-Q2"`, EUR, monthly figures.

**Finance:** revenue 412,000 · operating costs 356,000 (payroll 198,000 + property_maintenance 61,000 +
marketing 34,000 + software_and_tools 18,000 + other 45,000) · cash on hand 2,848,000 · approved annual
hiring budget 96,000 · committed 44,000 · benchmark annual loaded cost per hire 48,000 *(flagged as an
assumption)* · projected annual growth 12% · outstanding receivables 74,000 · `runwayDefinition` stored
**inside the dataset** as `"cashOnHand / monthlyOperatingCosts (zero-revenue stress case)"`.

*Derived in code:* operating profit 56,000 · margin 13.59% · runway 8.0 months · **available hiring
budget 52,000** · **max affordable additional hires 1**.
*Gaps:* no per-department cost allocation; no individual compensation records; no committed new-revenue
pipeline.

**HR:** 34 employees — operations 12 (over_capacity), maintenance 6 (over_capacity), sales 5 (balanced),
marketing 4 (balanced), finance 3 (balanced), admin_hr 4 (under_capacity) · 2 open roles: Maintenance
Coordinator (maintenance, `approved`, 63 days open), Operations Associate (operations, `pending_budget`,
21 days open) · avg weekly hours 41.5 · overtime last month 310 (operations 180, maintenance 96, sales 14,
marketing 8, finance 6, admin_hr 6) · voluntary turnover 11.8% · avg time to hire 38 days.
*Gaps:* no salary/compensation data (Finance-owned); no skills matrix; no headcount forecast.

**Why these numbers:** HR has a clear staffing case; Finance can fund exactly one hire; one of the two
open roles is already funded; 38-day time-to-hire means overtime persists ~2 more months. Correct joint
answer — proceed with the funded maintenance role, defer the operations role, note residual uncertainty
because neither side has cost-per-hire truth — is reachable by **neither agent alone**. That is what
makes the bonus flow demonstrate something.

---

## 9. Tests — 6 files, all offline

`tests/setup.ts` installs a **global guard that throws on any real network call**. No real API calls in
tests, ever.

**`isolation.test.ts` (headline)**
- source scan: nothing under `src/finance/` imports `src/hr/` or `hr.data.json`, and vice versa
- source scan: only `composition.ts` imports both data files
- `Object.keys(financeAgent)` is exactly `["id", "answer"]`
- `JSON.stringify(financeAgent)` leaks no values
- finance prompt contains no HR value (`"34"`, `"310"`, `"11.8"`, `"over_capacity"`) or HR field name; symmetric for HR
- **hostile mock:** finance response citing `totalEmployees` → `CROSS_DEPARTMENT_FIELD_REFERENCE`, `trusted: false`; symmetric for HR citing `monthlyRevenue`
- `// @ts-expect-error` passing `HrData` to `createFinanceAgent`, verified by `tsc --noEmit`
- coordinator module imports no data file; its prompt contains no field absent from the two analyses

**`router.test.ts`** — 3 finance, 3 HR, 4 joint (`should we hire more people`, `can we afford another
operations employee`, `is the company ready to expand the team`, `which department should receive the next
hire`), weather → unsupported, empty string → typed error, out-of-enum LLM output → rejected not coerced,
vague question → clarification. Zero LLM calls on the deterministic path.

**`verification.test.ts`** — valid passes; unknown field fails; wrong value fails with expected/received;
`"€52,000"` and `52000` pass while `52001` fails; derived float within 0.01 passes; unbacked prose number
fails; a number echoed from the question does **not** trip the scanner; twice-failed response returns
`trusted: false` and is not rendered as an answer.

**`data-consistency.test.ts`** — headcounts sum to 34; overtime sums to 310; cost categories sum to
356,000; `96,000 − 44,000 === 52,000`; every `over_capacity` department has ≥12 overtime hours per
employee; `openRoles.length === openRolesCount`; derived metrics match hand-computed values.

**`joint-recommendation.test.ts`** — both perspectives present and non-empty; HR wants two hires while
Finance funds one → `proceed_conditionally` with a condition naming the funded role; `maxAffordableHires
=== 0` but model says `proceed` → `POLICY_CONFLICT`; coordinator introducing a new number → rejected; one
untrusted agent → `insufficient_data`; `supportingFacts` a strict subset of upstream verified facts;
`Promise.all` path returns both analyses.

---

## 10. LLM layer

```ts
interface LlmClient {
  generateStructured<T>(input: {
    systemPrompt: string;
    userPrompt: string;
    schema: ZodSchema<T>;
    purpose: "routing" | "analysis" | "coordination";  // selects model tier
    maxTokens?: number;
  }): Promise<{ data: T; usage: TokenUsage; model: string }>;
  generateText(input: { systemPrompt: string; userPrompt: string }): Promise<string>;
}
```

**Provider: Anthropic / Claude.** Their architecture is Claude-based ("8 specialized Claude-powered AIs",
"One Claude API brain"), the API supports schema-constrained structured outputs natively, and model
tiering makes the Question-3 cost answer concrete rather than hypothetical.

- **Model tiering (config-driven):** routing/classification on the cheapest fast tier (Haiku 4.5);
  analysis and coordination on a mid tier (Sonnet 5). Temperature 0 for routing, low for analysis.
- **Structured outputs:** use the SDK's schema-constrained output with the Zod helper, **wrapped so a
  schema-parse failure falls back to one repair retry**. That wrapper means the code survives any
  parameter-shape difference, and tests never depend on provider behaviour.
- **Hardening lives in the client, not the callers:** request timeout, bounded retries with exponential
  backoff + jitter on 429/5xx, a small concurrency limiter (relevant to the parallel `both` path and
  reused verbatim in the Q3 answer), token/latency capture for `--explain`, error mapping so no raw
  provider payload or key reaches stdout.
- **Offline fixture mode:** `LLM_PROVIDER=mock` serves recorded structured responses from
  `src/llm/fixtures/`. Every command and test runs with no key and no network. Fixtures are captured from
  **real** API responses in Phase 11 and committed; the README states when they were recorded.

---

## 11. CLI

```bash
npm run dev -- "What is our operating margin?"
npm run dev -- "Should we hire more people?" --explain
npm run dev                      # interactive REPL, :exit to quit
```

Flags: `--explain`. Exit codes: `0` ok · `1` unsupported/clarification · `2` verification rejected ·
`3` config/provider error.

**Standard output**

```
Route: finance  (rules, confidence 0.95)
Reason: The question asks about operating margin, a finance metric.

Finance Agent
Operating margin for 2026-Q2 is 13.6%, on monthly revenue of €412,000 and
operating costs of €356,000.

Facts used
  • Monthly revenue            €412,000   [monthlyRevenue]
  • Monthly operating costs    €356,000   [monthlyOperatingCosts]
  • Operating margin           13.59%     [operatingMarginPercent, derived]

Missing information
  • No per-department cost allocation is available.

✓ 3 claims verified against source fields.
```

**`--explain`** adds routing source + matched signals, finance/HR fields used, verification counts, the
policy check, call count and token usage, and the final recommendation.

**Every `--explain` line is derived from `RouteDecision`, `VerificationResult`, and the agent envelope —
application state that already exists. No model reasoning is requested, stored, or displayed.** Say so
in the README; "explainability" that leaks chain-of-thought is a liability.

---

## 12. Internal phase map — for reference inside each stage

These phases map to the four stages in §17. Use them as the internal checklist within each stage.

| # | Phase | Stage | Time |
|---|---|---|---|
| 1 | Scaffold: package.json (**cross-platform — Windows target**), strict tsconfig, vitest, `.env.example`, `.gitignore`, `config/env.ts` | 2 | 15m |
| 2 | Contracts: `domain/types.ts`, `schemas.ts`, `errors.ts` | 2 | 20m |
| 3 | Data + facts: both JSON, both types, both `*.facts.ts`, `data-consistency.test.ts` | 2 | 30m |
| 4 | Grounding: `factsheet.ts`, `verify.ts`, `verification.test.ts` | 3 | 30m |
| 5 | Routing: `lexicon.ts`, `router.ts`, `router.test.ts` | 3 | 25m |
| 6 | LLM layer: `client.ts`, `mock-client.ts` + fixtures, `anthropic-client.ts` | 3 | 25m |
| 7 | Agents: both prompts, both factories, `run-analysis.ts` | 3 | 30m |
| 8 | Composition root + `isolation.test.ts` | 3 | 25m |
| 9 | Orchestration: coordinator + constraints + `joint-recommendation.test.ts` | 3 | 25m |
| 10 | CLI: `index.ts`, `render.ts`, `explain.ts`, LLM router fallback | 4 | 25m |
| 11 | Live run against the real API: tune prompts, capture fixtures, save real transcripts | 4 | 25m |
| 12 | `README.md`, `DECISIONS.md`, `ASSESSMENT_ANSWERS.md` | 4 | 40m |
| 13 | Final: `typecheck` → `test` → `build`, fresh-clone check, confirm no key committed, confirm mock mode | 4 | 15m |

**Phases 1–5 are entirely API-independent** — get them green before the provider exists.
If time runs short, cut in this order: LLM router fallback → unbacked-number scanner downgraded from
reject to warn → interactive REPL. **Never cut Phase 12.**

---

## 13. Deliverable documents

### README.md — 14 sections
Overview (a POC, explicitly not production) · Quick start incl. the keyless path
(`LLM_PROVIDER=mock npm run dev -- "..."`) · Architecture + Mermaid diagram · Agent isolation, leading
with *"System prompts guide model behaviour, but they are not treated as a security boundary."* ·
Grounding and verification with a worked rejected-claim example from the hostile-mock test · Routing ·
Joint orchestration and why open-ended agent conversation was rejected · Mock data, assumptions, and the
runway definition · Example questions with real transcripts including one rejection · Trade-offs ·
Testing, plus **a two-line edit a reviewer can make to watch `isolation.test.ts` fail on purpose** ·
Production evolution (Supabase, RLS, tool allowlists, audit logs, queues, caching, observability, 2→8
agents) · Limitations, stated plainly · AI-assisted development disclosure — unapologetic: AI accelerated
implementation; the architecture, boundaries, data contracts, verification rules, tests, and trade-offs
are the developer's, and the developer can explain and change any of them.

### DECISIONS.md — one entry each: **Decision · Why · Trade-off · Rejected alternative**
1. **Composition Root** — one wiring-only module sees both datasets. *Rejected: a shared `AppContext` passed everywhere* (recreates the unrestricted company object the brief warns against).
2. **Shared `DepartmentAgent` interface** — router/orchestrator stay department-agnostic. *Rejected: a generic `BaseAgent` class with shared data handling* (reintroduces a cross-department code path and hides the boundary).
3. **Closure-held data, not instance properties** — encapsulation is testable. *Rejected: `agent.data` with a "don't touch" comment.*
4. **Deterministic routing first, LLM only for ambiguity** — free, instant, testable for the common case. *Trade-off: lexicons don't generalise to paraphrase or other languages. Rejected: pure-LLM routing* (a network call and a nondeterministic result for "what is our revenue?").
5. **Router receives no department data** — routing is the authorisation step, so it runs before data access and fails closed. *Rejected: giving the router data to "route better."*
6. **Structured outputs with zod validation** — the result is consumed programmatically. *Trade-off: less expressive prose. Rejected: free text + regex extraction.*
7. **Application-level claim verification** — grounding becomes enforceable, not requested. *Trade-off: correct answers can be rejected on formatting; one retry, then visible refusal. Rejected: prompt-only "do not hallucinate."*
8. **Metrics computed in TypeScript** — removes the largest error class before the prompt exists. *Rejected: asking the model to calculate margin.*
9. **Coordinator receives summaries, never raw data** — the information boundary is a function signature. *Trade-off: it cannot dig deeper than the agents reported. Rejected: giving it both datasets "for accuracy."*
10. **Parallel agent execution for `both`** — independence proven by construction; honest 8-agent scaling story. *Trade-off: concurrent calls need a rate-limit story, hence bounded retry in the client.*
11. **Offline fixture mode** — evaluable without an API key. *Trade-off: fixtures drift; regenerated in Phase 11. Rejected: requiring a key to see anything work.*
12. **Intentionally excluded** — UI, database, auth, queue, vector store, 8 agents, agent framework, streaming, conversation memory, Docker. One line each on why each exclusion is judgment, not omission.

### ASSESSMENT_ANSWERS.md — 3 answers, 7–9 sentences each, thesis first, trade-off last
- **Q1 Agent Isolation.** Thesis: *isolation is an authorisation problem, and prompts are not an
  authorisation mechanism.* Identity resolved before data access; agents get allowlisted tools/RPCs, not
  table or SQL access; RLS and restricted views enforce at the DB so an app-layer bug cannot cross; the
  model never emits executable SQL; fail closed; audit sensitive calls; this submission models the same
  shape with per-department modules, scoped types, closures, and output field verification — point at
  `isolation.test.ts`. Trade-off: allowlisted tools are less flexible than open query access, and that
  rigidity is the point.
- **Q2 AI Agent Meeting.** Thesis: *it should be an orchestrated report pipeline that looks like a
  meeting, not a conversation between models.* Fixed rounds; each agent first retrieves verified metrics
  through its own authorised tools; structured summaries where every number carries a source field and
  period; the coordinator synthesises but may not introduce a number; conflicts trigger re-verification
  rather than a negotiated compromise; missing data marked explicitly; provenance preserved end to end.
  Trade-off: less emergent-seeming, far more trustworthy — a free-form debate multiplies hallucination
  risk every turn and produces nothing auditable.
- **Q3 Scale and Rate Limits.** Thesis: *at 30–45 req/min the constraint is burst shape and cost, not
  sustained volume.* Bounded-concurrency pool + per-provider token bucket; interactive prioritised while
  background work queues (batch-eligible); exponential backoff with jitter on 429/5xx; cache stable
  context via prompt caching plus a short-TTL response cache keyed on normalised question + data version;
  cheapest model for routing, stronger reserved for real reasoning; summarise long histories; track
  tokens, cost, latency, error rate per agent and per employee with per-tenant budget caps; degrade
  gracefully rather than dropping requests. Trade-off: caching and cheap routing models trade freshness
  and accuracy for cost and latency, so TTLs key off data-change events.

### .gitignore
```gitignore
# dependencies
node_modules/

# build output
dist/
*.tsbuildinfo

# environment - never commit secrets
.env
.env.*
!.env.example

# test / coverage
coverage/
.vitest/

# logs
*.log
npm-debug.log*
yarn-error.log*
pnpm-debug.log*

# editors
.idea/
.vscode/
*.swp

# OS
.DS_Store
Thumbs.db
desktop.ini

# misc
.cache/
tmp/

# NOTE: src/llm/fixtures/ is intentionally NOT ignored -
# offline mode depends on those files being committed.
```

---

## 14. Hard constraints — do not violate

| Excluded | Rule |
|---|---|
| UI / web frontend | CLI only |
| Database | Two JSON files |
| Authentication | README "production evolution" only |
| Eight implemented agents | Exactly two |
| Generic multi-agent framework | Plain functions and closures. No base class, registry, or plugin system |
| Unnecessary infrastructure | No Docker, queue, Redis, CI, vector store, streaming, memory |
| Prompt-only security | Four code-level mechanisms; README states prompts are not a boundary |
| Open-ended theatrical agent conversation | Fixed sequence, one coordinator call, no agent-to-agent turns |
| Chain-of-thought exposure | `--explain` renders only structured application metadata |
| Real API calls in tests | Global network guard in `tests/setup.ts` |
| Committed secrets | `.gitignore` + `.env.example` + Phase 13 check |
| `any` types | Strict TypeScript; `tsc --noEmit` must pass |

Also: comments only where they explain a non-obvious decision. Small functions. Descriptive names.
Do not claim the solution is production-ready — describe it as a focused architectural proof of concept.

---

## 15. Risks to watch during implementation

1. **The unbacked-number scanner false-positives** and blocks correct answers in the demo. Mitigate with
   strict normalisation, a documented safe list, tuning against real output in Phase 11, and a config
   switch to degrade from reject to warn.
2. **Structured-output plumbing eats time.** Phases 1–5 are API-independent and green first; the client
   wraps schema-constrained output with parse-and-repair; mock mode means the submission is complete even
   if the live path needs tuning.
3. **Fixture drift** — offline output diverging from live behaviour. Fixtures captured from real responses
   in Phase 11; README records when.

---

## 16. Definition of done (applies after Stage 4)

---

## 17. Staged workflow — authoritative; follow exactly

This is the **only** workflow the code session should follow. §12 is the internal phase map;
§17 is when to stop, what to verify, and what approval is required.

---

### Stage 1 — Finalize and Validate the Plan

**Do not write code yet.**

1. Read this HANDOFF.md in full, then `docs/cherry_host_codex_project_brief.md`. HANDOFF is
   authoritative on decisions; the brief is authoritative on requirements.
2. Confirm the plan explicitly includes all of the following:
   - Composition Root pattern (§3, composition.ts rules)
   - Shared `DepartmentAgent` interface (§4)
   - Department-scoped types (`FinanceData`, `HrData` — separate, no cross-import)
   - Separate agent factories (`createFinanceAgent`, `createHrAgent`)
   - Claim verification layer (§7, `grounding/verify.ts`)
   - Offline fixture mode (`LLM_PROVIDER=mock`, §9, §10)
   - Controlled joint orchestration — fixed sequence, one coordinator call (§2, §5)
   - Parallel Finance and HR execution via `Promise.all` for `both` routes (§5)
   - `DECISIONS.md` as a first-class deliverable (§13)
   - Small, production-aware POC scope (§14 hard constraints)
3. Confirm the plan does **not** include:
   - A UI or web frontend
   - A database
   - Authentication
   - Eight implemented agents
   - A generic multi-agent framework, base classes, or plugin system
   - Unnecessary infrastructure (Docker, queue, Redis, CI, vector store, streaming, memory)
   - Prompt-only security (prompts guide behaviour; code enforces the boundary)
   - Open-ended theatrical agent conversations
4. Resolve the three open questions in §0. Recommend the defaults unless you see a problem.
5. Flag any remaining ambiguity or risk.
6. Explain the final architecture in plain language (two short paragraphs).
7. **Stop and wait for the user's approval before writing any code.**

---

### Stage 2 — Build the Project Foundation

**After the user approves Stage 1, create only the foundation. Do not yet implement real prompts,
real API calls, routing logic, joint orchestration, or CLI behaviour.**

Create:
- Initialized TypeScript project with strict settings and cross-platform npm scripts (Windows target)
- Folder structure matching §3
- `domain/types.ts`, `domain/schemas.ts`, `domain/errors.ts` — all contracts from §4
- `finance/finance.data.json` and `hr/hr.data.json` — internally consistent mock data from §8
- `finance/finance.types.ts` and `hr/hr.types.ts`
- `finance/finance.facts.ts` and `hr/hr.facts.ts` — derived metrics only, no LLM
- Shared `DepartmentAgent` interface (in `domain/types.ts`)
- Agent factory signatures (stubs — signatures only, no implementation)
- `composition.ts` — wiring only, ~15 lines, follows the rules in §3
- `llm/client.ts` — `LlmClient` interface only
- `config/env.ts` — zod-validated env, fails fast
- `DECISIONS.md` — initial entries for decisions already made
- `.gitignore` and `.env.example`
- `data-consistency.test.ts` — asserts all numeric invariants in §8
- `tests/setup.ts` — global guard: any real network call throws

**After completing Stage 2:**
1. Run `npm run typecheck` — must pass with zero errors.
2. Run `npm test` — `data-consistency.test.ts` must pass; all others should be stubs or skipped.
3. Inspect the import graph: confirm only `composition.ts` imports both data files.
4. Confirm each factory accepts only its own department type.
5. Explain every created file in one sentence.
6. Summarize the decisions added to `DECISIONS.md`.
7. **Stop and wait for the user's approval before continuing to Stage 3.**

---

### Stage 3 — Implement the Core Logic

**After the user approves Stage 2, implement:**
- Finance Agent — full `createFinanceAgent` with closure-held data and `answer()` method
- HR Agent — full `createHrAgent`, symmetric
- Department-specific prompts (`finance.prompt.ts`, `hr.prompt.ts`) — FactSheet as input only
- Grounded structured outputs — `facts[]` with `sourceField` references
- Claim verification layer — `grounding/verify.ts`: field allowlist, value match, unbacked-number scan, one repair retry, `trusted: false` on second failure
- `agents/run-analysis.ts` — shared call → parse → verify → retry helper
- Deterministic routing — `routing/lexicon.ts` + `routing/router.ts` + `router.test.ts`
- Optional LLM fallback for ambiguous routing — `routing/llm-router.ts`
- Offline fixture mode — `llm/mock-client.ts` + `src/llm/fixtures/*.json`
- Real provider — `llm/anthropic-client.ts` with retry, timeout, error mapping
- Joint Finance and HR orchestration — `orchestration/coordinator.ts`:
  - parallel `Promise.all` execution of both agents
  - deterministic constraint derivation before the coordinator LLM call
  - coordinator receives only the two `AgentAnalysis` objects, never raw data
  - `POLICY_CONFLICT` check: if code says `maxAffordableHires === 0` and model returns `proceed`, reject
- `isolation.test.ts`, `verification.test.ts`, `joint-recommendation.test.ts`

Keep the implementation small and easy to explain. No features not listed above.

**After completing Stage 3:**
1. Run `npm run typecheck` — must pass with zero errors.
2. Run `npm test` — all six test files must pass.
3. Manually test (using the mock client, no real API key required):
   - Finance-only: `LLM_PROVIDER=mock npm run dev -- "What is our operating margin?"`
   - HR-only: `LLM_PROVIDER=mock npm run dev -- "Which team is over capacity?"`
   - Both: `LLM_PROVIDER=mock npm run dev -- "Should we hire more people?"`
   - Unsupported: `LLM_PROVIDER=mock npm run dev -- "What is the weather in Madrid?"`
   - Explain: `LLM_PROVIDER=mock npm run dev -- "Should we hire more people?" --explain`
4. Verify that unsupported numerical claims are rejected (`trusted: false`) and shown as rejections.
5. Verify that no agent receives the other department's data — point at the isolation test results.
6. Explain the full runtime flow in plain language (one short paragraph per route).
7. Summarize any new decisions added to `DECISIONS.md`.
8. **Stop and wait for the user's approval before continuing to Stage 4.**

---

### Stage 4 — Finalize the Submission

**After the user approves Stage 3, complete:**
- CLI polish: `src/index.ts`, `cli/render.ts`, `cli/explain.ts`
- `--explain` mode — renders only structured application metadata; no model chain-of-thought
- Live run against the real Anthropic API: capture real transcripts, populate `src/llm/fixtures/`
- `README.md` — all 14 sections from §13; include real transcript showing a rejected claim
- `ASSESSMENT_ANSWERS.md` — three answers, 7–9 sentences each, thesis-first format from §13
- Final review and completion of `DECISIONS.md`
- Final tests, example commands, setup instructions

**After completing Stage 4:**
1. Run `npm run typecheck` — zero errors.
2. Run `npm test` — all tests pass.
3. Run `npm run build` — clean build.
4. Test the documented commands from the README (both live and mock modes).
5. Confirm no API key or secret is committed (`git status`, `git diff HEAD`).
6. Confirm the project runs completely in offline fixture mode with no API key.
7. Explain the final solution in plain language (two paragraphs).
8. List what was intentionally excluded and why.
9. List the main talking points for the follow-up interview — map them to the questions in
   `docs/cherry_host_codex_project_brief.md` §24.

---

### Cross-stage rules that apply throughout

- Run `npm run typecheck && npm test` at every stage boundary before reporting completion.
- Stop after each stage and wait for explicit approval — do not proceed speculatively.
- Never introduce a feature not listed in the current stage's scope.
- If you discover an ambiguity or a reason to deviate from the plan, surface it and wait for
  the user's decision rather than resolving it silently.
- Keep every file small and focused. If a file is growing large, split it.
- No `any` types. No `console.log` debugging left in production paths. No commented-out code.

The project is complete when `npm run typecheck` · `npm test` · `npm run build` all pass, and:
finance questions route to finance · HR to HR · cross-department to both · unsupported handled ·
Finance cannot access HR data and vice versa (proven by tests) · joint recommendation includes both
perspectives · every numerical claim is grounded with a traceable source field · invalid claims are
rejected and shown as rejected · `--explain` shows routing and evidence metadata · missing data is
acknowledged · no API key committed · README, DECISIONS.md, and ASSESSMENT_ANSWERS.md complete ·
runs on Windows · runs with `LLM_PROVIDER=mock` and no API key.
