# Decisions

Each entry: **Decision · Why · Trade-off · Rejected alternative.**

These are the architectural choices behind the submission. They were made by the developer;
AI accelerated the implementation of them.

---

### 1. Composition Root

**Decision.** Exactly one module — `src/composition.ts` — imports both datasets. It wires
dependencies and does nothing else.
**Why.** With eight agents on one shared database, the real risk is a Finance agent answering from
HR rows. Concentrating data access in one auditable file makes "who can see what" a property you
can read in a few lines rather than infer across a codebase.
**Trade-off.** Adding a department means editing a central file, which is mild coupling.
**Rejected.** A shared `AppContext` passed everywhere — that recreates the unrestricted company
object the brief explicitly warns against.

### 2. Shared `DepartmentAgent` interface

**Decision.** The router and orchestrator hold agents only as `{ id, answer }`.
**Why.** They stay department-agnostic, and the interface exposes no path to department data.
**Trade-off.** Callers cannot ask an agent anything specialised.
**Rejected.** A generic `BaseAgent` class with shared data handling — it reintroduces a
cross-department code path and hides the boundary inside inheritance.

### 3. Closure-held data, not instance properties

**Decision.** Each factory captures its dataset in a closure; the returned object has only `id`
and `answer`.
**Why.** Encapsulation becomes testable: `Object.keys(agent)` is asserted in `isolation.test.ts`.
**Trade-off.** Slightly less convenient to debug.
**Rejected.** `agent.data` with a "don't touch" comment — a convention, not a boundary.

### 4. Deterministic routing first, LLM only for ambiguity

**Decision.** Keyword and phrase rules decide the common cases; the model classifier runs only
below a confidence threshold.
**Why.** Free, instant and testable for the questions that actually get asked.
**Trade-off.** Lexicons do not generalise to paraphrase or other languages.
**Rejected.** Pure-LLM routing — a network call and a nondeterministic result for "what is our
revenue?".

### 5. The router receives no department data

**Decision.** Routing sees the question and one-line department descriptions only.
**Why.** Routing is effectively the authorisation step, so it must run before data access and fail
closed.
**Trade-off.** It cannot use data to route more cleverly.
**Rejected.** Giving the router data "to route better" — that inverts the security order.

### 6. Structured outputs with zod validation

**Decision.** Every model output is parsed by a zod schema before use.
**Why.** The results are consumed programmatically; free text would need regex archaeology.
**Trade-off.** Less expressive prose.
**Rejected.** Free text plus extraction.

### 7. Application-level claim verification

**Decision.** Every cited `sourceField` is checked against the agent's own fact sheet, values must
match, and prose is scanned for numbers with no backing fact. One repair retry, then refusal.
**Why.** It turns grounding from a request into an enforced property. This is the difference
between "we asked the model not to hallucinate" and "the model cannot publish an unbacked number".
**Trade-off.** A correct answer can be rejected on formatting; hence the retry and the
`UNBACKED_NUMBER_MODE=warn` escape hatch.
**Rejected.** Prompt-only "do not hallucinate".

### 8. Exact-or-correctly-rounded value matching

**Decision.** A reported number matches only if it equals the authorised value or is a correctly
rounded rendering of it. No proportional tolerance.
**Why.** An early implementation used a 0.5% band, which on a €52,000 field silently accepted
€52,250 — precisely the drift the verifier exists to catch. Caught by a test, now pinned by one.
**Trade-off.** A model that rounds unusually gets rejected and retried.
**Rejected.** Percentage tolerance.

### 9. Metrics computed in TypeScript

**Decision.** Margin, runway, available budget and affordable hires are calculated in code and
handed to the model finished.
**Why.** It removes the largest error class before the prompt is even written.
**Trade-off.** Less flexible than letting the model derive figures on demand.
**Rejected.** Asking the model to calculate.

### 10. Coordinator receives summaries, never raw data

**Decision.** The coordinator's signature accepts two `AgentAnalysis` objects; its module imports
no dataset. Its numeric vocabulary is the union of the two agents' *verified* facts.
**Why.** The information boundary becomes a function signature rather than a promise.
**Trade-off.** It cannot dig deeper than the agents reported — which surfaced immediately: a draft
coordinator response citing operating profit was rejected because neither agent had reported it.
**Rejected.** Giving it both datasets "for accuracy".

### 11. Deterministic constraints beat model judgement

**Decision.** `maxAffordableHires` is computed in code; a verdict that contradicts it is rejected
as `POLICY_CONFLICT`.
**Why.** A persuasive model should not be able to recommend a hire the business cannot fund.
**Trade-off.** The rule is blunt and needs revisiting as the policy grows.
**Rejected.** Trusting the model to respect a constraint stated in the prompt.

### 12. Parallel agent execution for `both`

**Decision.** The two agents run under `Promise.all`.
**Why.** Independence proven by construction, and the honest answer to how this scales to eight
departments.
**Trade-off.** Concurrent calls need a rate-limit story, hence bounded concurrency and jittered
retry in the client.
**Rejected.** Sequential calls that could leak one agent's output into the other's input.

### 13. Offline fixture mode in the MVP

**Decision.** `LLM_PROVIDER=mock` is the default and serves committed fixtures.
**Why.** The entire system — every command and all tests — is evaluable with no API key.
**Trade-off.** Fixtures drift from live behaviour; they are validated against the real schema and
the real verifier by tests to limit that.
**Rejected.** Requiring a key to see anything work.

### 14. No `temperature`, and units tolerated in reported values

**Decision.** The provider client sends no sampling parameters, and the verifier accepts a value
that carries a documented unit (`"412000 EUR"`, `"13.59 percent"`).
**Why.** Both were forced by the live API. Sonnet 5 rejects `temperature` outright
(`400 "temperature is deprecated for this model"`), and the model echoes the unit shown in the fact
sheet — a correct value that the first normaliser rejected, costing a repair round-trip on every
single call. Stripping a known unit is safe because the numeric part must still match exactly.
**Trade-off.** Determinism can no longer be dialled with a sampling knob; it comes from computing
metrics in code and verifying every claim, which is where it belonged anyway.
**Rejected.** Keeping `temperature` behind a model check — it would rot as models change.

### 15. Generous output token ceiling, with truncation named explicitly

**Decision.** `max_tokens` defaults to 16,000 for structured calls, and a `max_tokens` stop reason
raises a distinct error rather than a generic parse failure.
**Why.** At 2,048 the HR agent silently burned both attempts: the JSON was cut mid-write, failed to
parse, and surfaced as "could not return a valid structure" — which sends the reader hunting through
the schema for a problem that was really a budget. `max_tokens` is a ceiling, not a target, so
headroom costs nothing when unused.
**Trade-off.** A runaway response could spend more; the token budget is the backstop.
**Rejected.** Raising the cap without naming the failure — the next person hits the same confusion.

### 16. Constraints derive from whichever verified facts exist

**Decision.** `fundedOpenRoles` and `departmentsOverCapacity` fall back to per-item facts
(`openRoles.<title>.status`, `departments.<name>.capacityStatus`) when the summary field is not cited.
**Why.** The live HR agent cited the per-role fields instead of the derived ones, so the coordinator
reported "none reported" for a role that was in fact funded. A constraint must not depend on the
model picking one exact field name.
**Trade-off.** Two ways to reach the same constraint, so the derivation needs its own test.
**Rejected.** Prompting the agent to always cite the summary field — that is a request, not a
guarantee, which is the whole thesis of this codebase.

### 17. Intentionally excluded

UI, database, authentication, queues, vector store, eight agents, agent framework, streaming,
conversation memory, Docker, CI. Each is judgement, not omission: the assessment asks for a small,
explainable proof of concept, and every one of these would add surface area without demonstrating
anything the current scope does not already show.

---

## Deviations from the original plan

Recorded honestly rather than quietly absorbed.

- **`JointRecommendation` enum.** The plan defaulted to a generic
  `proceed | proceed_conditionally | do_not_proceed`; the developer chose the brief's literal
  `hire | do_not_hire | hire_conditionally | insufficient_data` instead.
- **Build asset copying.** `tsc` does not copy imported JSON into `dist/`, so a built distribution
  would have failed at runtime on both datasets and fixtures. Added `scripts/copy-assets.mjs`.
- **Module system.** The environment has TypeScript 7 and Node 24, where classic `node` module
  resolution has been removed. The project uses `nodenext` resolution and remains CommonJS.
- **Environment loading.** `loadEnv()` is called by the CLI rather than executed at import, so a
  misconfiguration produces a readable message and exit code 3 instead of an import-time throw.
- **Fixtures are recorded, not authored.** `src/llm/fixtures/` was captured from real Anthropic
  responses on 2026-07-24 via `scripts/capture-fixtures.ts`, which refuses to record any response
  that fails verification. Each file carries a `recordedAt` date.
