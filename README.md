# Cherry Host — Finance & HR AI Agents

A small proof of concept for the Cherry Host / REJ Investment AI Engineer assessment.

Ask a business question. The system decides which department should answer, asks that department's
agent, **checks every number in the answer against the source data**, and refuses the answer if
anything doesn't check out. For questions that need both departments, it asks both and reconciles
them into one recommendation.

It is deliberately small and deliberately not production-ready. What it tries to demonstrate is the
part that actually matters: **agent isolation and grounding are enforced by code and proven by
tests, not requested in a prompt.**

---

## Quick start

You do **not** need an API key to run or evaluate this.

```bash
npm install
npm run dev:mock -- "Should we hire more people?"
```

That's it. `dev:mock` replays real Anthropic responses that were recorded and committed, so the
whole system works offline. Every command below works the same way with `dev:mock`.

To run against the live Anthropic API instead:

```bash
cp .env.example .env
```

Then edit `.env`: set `ANTHROPIC_API_KEY=sk-ant-...` and change `LLM_PROVIDER` to `anthropic`.
Now use `npm run dev` instead of `npm run dev:mock`. `.env` is git-ignored — never commit it.

**Windows note:** every script is cross-platform. Use `npm run dev:mock -- "your question"` in
PowerShell, cmd, or bash — the `LLM_PROVIDER=mock` prefix style you may see elsewhere does not work
in PowerShell, which is exactly why there's a dedicated script.

---

## Try it — the questions it answers

All of these work offline. Copy any line.

**Finance questions** → answered by the Finance Agent alone

```bash
npm run dev:mock -- "What is our operating margin?"
npm run dev:mock -- "What is our monthly revenue?"
npm run dev:mock -- "How much runway do we have left?"
```

**HR questions** → answered by the HR Agent alone

```bash
npm run dev:mock -- "Which team is over capacity?"
npm run dev:mock -- "How many employees do we have?"
npm run dev:mock -- "What is our voluntary turnover?"
```

**Questions needing both** → both agents run, then a coordinator reconciles them

```bash
npm run dev:mock -- "Should we hire more people?"
npm run dev:mock -- "Can we afford another operations employee?"
npm run dev:mock -- "Is the company ready to expand the team?"
npm run dev:mock -- "Which department should receive the next hire?"
```

**Questions it refuses** → no data, or too vague to guess

```bash
npm run dev:mock -- "What is the weather in Madrid?"
npm run dev:mock -- "How are we doing?"
```

**Interactive mode** — run with no question, then type. `:exit` to quit.

```bash
npm run dev:mock
```

> **Offline vs live.** Offline mode picks the closest recorded answer by keyword, so the twelve
> questions above always fit well. Ask something unusual offline and you'll get the nearest recorded
> answer, which may not match. Live mode handles any question in any wording.

---

## What the output looks like

```
Route: finance  (rules, confidence 0.92)
Reason: The question asks about margin, which is finance data.

Finance Agent
For 2026-Q2, Cherry Host's operating margin is 13.59%, derived from monthly revenue of
412000 and monthly operating costs of 356000, yielding a monthly operating profit of 56000.

Facts used
  • Operating margin          13.59    [operatingMarginPercent]
  • Monthly revenue           412,000  [monthlyRevenue]
  • Monthly operating costs   356,000  [monthlyOperatingCosts]
  • Monthly operating profit  56,000   [monthlyOperatingProfit]

✓ 4 claim(s) verified against source fields.
```

Every number is tagged with the exact field it came from, and the tick line means each one was
checked against the dataset — not just stated.

### When a claim doesn't check out

This is the important behaviour. Below is a **real run** where a value was deliberately corrupted:

```
Route: finance  (rules, confidence 0.92)
Reason: The question asks about margin, which is finance data.

✗ The Finance Agent's response failed verification and was not accepted.

Problems found:
  • "monthlyRevenue" was reported as 450000 but the authorised value is 412000.

No answer is shown, because an unverified business figure is worse than no figure.
```

The system gets one repair attempt first. If the answer still doesn't verify, **you get the refusal
rather than the answer**. Exit code `2`.

---

## The `--explain` flag

Add `--explain` to see how the decision was made:

```bash
npm run dev:mock -- "Should we hire more people?" --explain
```

You get: the routing decision and what triggered it, the exact fields each agent used, verification
counts, the constraints that were computed in code, whether the final verdict is consistent with
them, and token usage against the budget.

```
Constraints computed in code
  maxAffordableHires: 1
  departmentsOverCapacity: operations, maintenance
  fundedOpenRoles: Maintenance Coordinator

Policy check
  Verdict: hire_conditionally
  Consistent with computed constraints: yes
  Supporting facts traced upstream: 8
  Trusted: yes

Model usage
  Provider model: anthropic
  Calls: 3
  Tokens in/out: 8487/6306
  Budget: 14,793 of 200,000 tokens used
```

**Every line comes from data the application already holds.** No hidden model reasoning is
requested, stored, or shown. "Explainability" that leaks a model's private chain-of-thought is a
liability, not a feature.

---

## Testing

```bash
npm test          # 100 tests
npm run typecheck # strict TypeScript, zero errors
npm run build     # compiles to dist/
```

**No test touches the network.** `tests/setup.ts` installs a guard that makes any outbound request
throw, so a test can never quietly hit the real API.

| Test file | What it proves |
|---|---|
| `isolation.test.ts` | Finance genuinely cannot see HR data, and vice versa |
| `verification.test.ts` | Bad numbers are caught; good ones aren't falsely rejected |
| `joint-recommendation.test.ts` | The two-department flow and its guardrails |
| `data-consistency.test.ts` | The mock data doesn't contradict itself |
| `router.test.ts` | Questions reach the right department |
| `llm-budget.test.ts` | The token cap actually stops spending |

### See the isolation test fail on purpose

A test that can't fail proves nothing. Add this one line to `src/finance/finance.facts.ts`:

```ts
import type { HrData } from "../hr/hr.types";
```

Run `npm test`. It fails immediately:

```
× no finance module imports anything from hr
```

Delete the line and it passes again. I ran this exact check while building.

---

## How it works

```mermaid
flowchart TD
    U[User question] --> R[Router<br/>keywords first, model only if unclear]
    R -->|finance| F[Finance Agent]
    R -->|hr| H[HR Agent]
    R -->|both| F
    R -->|both| H
    R -->|unsupported| X[Refuse or ask what you meant]
    F --> V1[Verify every claim]
    H --> V2[Verify every claim]
    V1 --> C[Coordinator<br/>sees only the two analyses]
    V2 --> C
    C --> V3[Verify + policy check]
    V3 --> J[Joint recommendation]
```

**Inside an agent:** build a fact sheet from its own data (raw fields plus metrics computed in
TypeScript) → build a prompt from that fact sheet only → ask the model → verify every claim → one
repair attempt if needed → return the answer marked trusted or not.

### Agent isolation — four mechanisms, none of them a prompt

> **System prompts guide model behaviour, but they are not treated as a security boundary.**

The prompts do say "use only the supplied facts," because it improves behaviour. But none of the
isolation depends on the model cooperating:

1. **One wiring file.** Only `src/composition.ts` is allowed to import both datasets. A test scans
   the source to enforce it.
2. **Separate types.** `FinanceData` and `HrData` share no fields, so handing HR data to the Finance
   agent is a **compile error**, not a runtime leak.
3. **Closures.** Each agent captures its data privately. The returned object has exactly `id` and
   `answer` — there is no `.data` to reach for.
4. **Output checking.** If an agent cites a field belonging to the other department, the answer is
   rejected as `CROSS_DEPARTMENT_FIELD_REFERENCE`.

Mechanism 4 is tested with a **hostile model** — a fake client that deliberately returns a Finance
answer citing HR's `totalEmployees`. It gets refused.

### How hallucinated numbers are prevented

1. Metrics like margin, runway and affordable hires are **calculated in TypeScript**, never by the
   model. The model receives finished numbers.
2. The fact sheet is the model's entire universe. If a value isn't in it, there is no legitimate way
   to state it.
3. Every cited field must exist in **that agent's own** data, and the value must match.
4. Matching is exact-or-correctly-rounded. `13.6` passes for `13.59`; `52,001` does not pass for
   `52,000`.
5. The prose is scanned too — a response whose `facts` are perfect but whose summary invents
   "roughly €60,000 of headroom" is caught.
6. One repair attempt, then a visible refusal.

---

## The joint flow, and why it isn't a conversation

For "Should we hire more people?", both agents run **at the same time**, independently. Neither sees
the other's data or output. A coordinator then receives **only their two finished analyses** — never
raw data — and produces one recommendation.

The mock data is built so neither agent can answer alone:

- **HR** sees two departments over capacity and two open roles.
- **Finance** can fund **exactly one** hire (€52,000 available ÷ €48,000 per hire).
- Only one of the two open roles already has budget approved.

The correct answer — fill the funded maintenance role, hold the operations one — needs both sides.

**There is deliberately no agent-to-agent chat.** A free-form debate between two models is the most
impressive-looking version of this and the least trustworthy: every turn is another chance to
hallucinate, errors compound as agents cite each other, and nothing produced is auditable. Instead:
fixed sequence, one coordinator call, everything traceable.

The coordinator also can't overrule arithmetic. `maxAffordableHires` is computed in code; if the
model returns "hire" when that number is `0`, the answer is rejected as `POLICY_CONFLICT`.

---

## The data

Mock data only, in two JSON files. Shared period `2026-Q2`, EUR, monthly figures.

**Finance** — revenue €412,000 · operating costs €356,000 · cash €2,848,000 · hiring budget
€96,000 approved less €44,000 committed · benchmark €48,000 per hire.
*Computed in code:* profit €56,000 · margin 13.59% · runway 8.0 months · **available budget
€52,000** · **affordable hires: 1**.

**HR** — 34 employees across 6 departments · operations (12) and maintenance (6) over capacity ·
310 overtime hours last month · 2 open roles (Maintenance Coordinator approved, 63 days open;
Operations Associate awaiting budget, 21 days) · turnover 11.8% · average time to hire 38 days.

**Assumptions, stated plainly.** The €48,000 cost per hire is a market benchmark, not an agreed
offer — the agents flag this themselves. Runway is deliberately a zero-revenue stress case, and that
definition is stored *inside* the dataset so it travels with the number.

**Deliberate gaps.** Finance holds no salary data; HR holds no money data. That's not an oversight —
it's what forces each agent to say "I can't answer that" instead of guessing. `data-consistency.test.ts`
checks every total adds up.

---

## Key decisions and trade-offs

Full reasoning in [DECISIONS.md](DECISIONS.md). The ones worth knowing:

| Decision | Trade-off I accepted |
|---|---|
| **One wiring file sees both datasets** | Adding a department means editing a central file. Worth it — "who can see what" is readable in 15 lines. |
| **Keyword routing first, model only when unclear** | Keywords don't handle paraphrase or other languages. But routing is free, instant and testable for the questions people actually ask. |
| **Router never sees department data** | It can't route more cleverly. Correct anyway: routing decides what data may be touched, so it must run before that data is loaded. |
| **Verify claims in the app, not the prompt** | A correctly-worded answer can occasionally be rejected on formatting. Mitigated with one retry and a `warn` mode. A refused answer beats a wrong one. |
| **Compute metrics in code** | Less flexible than letting the model derive figures. Removes the largest error class before the prompt exists. |
| **Coordinator gets summaries, not data** | It can't dig deeper than the agents reported. That's the boundary working — it caught me during development. |
| **Both agents run in parallel** | Needs a rate-limit story, hence bounded concurrency and jittered retry. Proves independence by construction. |
| **Offline fixture mode** | Recorded answers drift from live behaviour. Guarded by tests that run fixtures through the real verifier. Worth it so this is evaluable with no key. |
| **Structured output, not free text** | Less expressive prose, but the result is consumed by code. |

### Three things the live API taught me

Offline testing could not have found these:

1. **`temperature` is rejected by current models.** Sonnet 5 returns *"temperature is deprecated for
   this model"* — every analysis call was failing with HTTP 400. Removed.
2. **The model echoes units.** It reports `"412000 EUR"` because that's how the fact sheet displays
   it. The value was right, but my checker rejected it — wasting a repair call **every single time**.
   Now units are tolerated, while a genuinely wrong number with a valid unit is still rejected.
3. **A too-small token cap fails silently.** At 2,048 the HR agent's JSON was cut off mid-write and
   surfaced as a confusing "schema" error. Raised to 16,000, and truncation now says so by name.

---

## Configuration

Everything is optional except the API key in live mode. See [.env.example](.env.example).

| Setting | Default | What it does |
|---|---|---|
| `LLM_PROVIDER` | `mock` | `mock` (offline, no key) or `anthropic` (live) |
| `ANTHROPIC_API_KEY` | — | Required only when live |
| `ANTHROPIC_ROUTING_MODEL` | Haiku 4.5 | Cheap model for classification |
| `ANTHROPIC_ANALYSIS_MODEL` | Sonnet 5 | Stronger model for real reasoning |
| `LLM_TOKEN_BUDGET` | `200000` | Hard cap per run — **refuses** further calls, doesn't just log |
| `UNBACKED_NUMBER_MODE` | `reject` | `warn` downgrades the prose scanner if it's too strict |
| `LLM_REQUEST_TIMEOUT_MS` | `30000` | Per-request timeout |
| `LLM_MAX_RETRIES` | `3` | Retries on 429/5xx, with backoff and jitter |

**Exit codes:** `0` fine · `1` can't answer · `2` failed verification · `3` config or provider error.

---

## Project layout

```
src/
  composition.ts        the ONLY file that sees both datasets
  index.ts              CLI
  config/env.ts         validated settings, fails fast, never logs the key
  domain/               shared types, schemas, typed errors
  finance/              data, types, computed metrics, prompt, agent
  hr/                   same shape, completely separate
  agents/               shared ask → check → repair loop
  grounding/            fact sheets and the claim verifier
  routing/              keyword rules, then model fallback
  orchestration/        the coordinator
  llm/                  provider interface, live client, offline client, fixtures
tests/                  100 tests, all offline
scripts/                asset copying, fixture recording
```

---

## If this went to production

The shapes here map onto real Supabase infrastructure:

| This proof of concept | Production |
|---|---|
| Fact sheets | Authorised Supabase RPCs |
| Field allowlist | Per-agent tool allowlist |
| Composition root | Server-side auth on (user, company, department) |
| Separate JSON files | Row Level Security + restricted views |
| Verification layer | Unchanged — it's already the right idea |

Plus: audit logging on sensitive calls, a queue for background work, response caching, per-tenant
budget caps, and observability on tokens, cost and latency per agent. The model would never generate
executable SQL. Access fails closed.

---

## Limitations — stated plainly

- **Mock data only.** No database, no real records.
- **Two agents, not eight.** Scaling to eight is described, not built.
- **No authentication.** Identity and permissions are discussed, not implemented.
- **No memory.** Each question is independent; there's no conversation history.
- **Offline answers are recordings.** Real, captured from the live API on 2026-07-24 — but they
  don't adapt to new question wording the way live mode does.
- **Keyword routing is English-only** and won't handle unusual phrasing without the model fallback.
- **The prose number scanner can be strict.** It may occasionally reject a well-formed answer; hence
  the retry and the `warn` switch.
- **This is not production-ready**, and isn't meant to be. It's a focused architectural proof of
  concept.

---

## A note on AI-assisted development

I used AI-assisted development to accelerate implementation. The architecture, security boundaries,
data contracts, verification rules, tests and trade-offs are mine — I defined them, reviewed the
output, and can explain or change any part of this system.

Two examples of that review mattering: an early version of the value checker used a percentage
tolerance, which would have silently accepted €52,250 as €52,000 — I caught it and replaced it with
exact-or-correctly-rounded matching, pinned by a regression test. And the coordinator was caught
citing a figure neither agent had reported, which is the grounding boundary doing its job on my own
code.

---

## Documents

- **[DECISIONS.md](DECISIONS.md)** — every decision with its rationale, trade-off, and the
  alternative I rejected
- **[docs/ASSESSMENT_ANSWERS.md](docs/ASSESSMENT_ANSWERS.md)** — the three written architecture
  answers
