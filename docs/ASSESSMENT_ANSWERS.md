# Written Assessment Answers

Three questions from the Cherry Host / REJ Investment AI Engineer assessment.

---

## Question 1 — How would you ensure each department agent only accesses its own data?

**Isolation is an authorisation problem, and a system prompt is not an authorisation mechanism.**
A prompt saying "you are the Finance Agent, never read HR data" is a behavioural hint that a
confused or adversarially prompted model will ignore, and it leaves no trace when it fails. The
enforcement has to sit in application and database code, where it can be tested. In a real Supabase
deployment I would resolve the caller's identity first — user, company or tenant ID, and department
— before any data is touched, and treat routing as the authorisation step so it runs before access
rather than alongside it. Each agent would then receive an allowlist of approved tools or RPCs such
as `getMonthlyFinanceSummary()` or `getDepartmentHeadcount()`, each performing its own check, and
the model would never emit executable SQL or hold direct table access. Row Level Security and
restricted views would enforce the same boundary at the database, so an application-layer bug still
cannot cross departments, and every sensitive call would be logged with the agent, the user and the
fields returned. Access fails closed: an unrecognised department or a missing claim denies rather
than defaults.

This submission models the same shape at small scale, and proves it rather than asserting it. Data
lives in per-department modules that never import each other, a single composition root is the only
file permitted to load both datasets, and each factory takes a department-scoped type so a
cross-department wiring mistake is a compile error rather than a leak. The data is captured in a
closure with no accessor on the returned agent, and every field an agent cites is verified against
its own authorised fact sheet, so an answer citing a foreign field is rejected at runtime.
`tests/isolation.test.ts` checks all of this, including a hostile model response that deliberately
cites another department's field — and I confirmed the test genuinely fails by introducing a
cross-department import on purpose and watching it break. **The trade-off is that allowlisted tools
are far less flexible than open query access, and that rigidity is the point.**

---

## Question 2 — How would you design the "AI agent meeting" so the output is reliable?

**It should be an orchestrated reporting pipeline that looks like a meeting, not a conversation
between models.** A free-form debate is the most appealing version of this idea and the least
trustworthy: every turn is a fresh chance to hallucinate, errors compound as agents begin citing
each other, and nothing produced afterwards is auditable. I would run fixed rounds under a central
orchestrator instead, where each department agent first retrieves verified metrics through its own
authorised tools and returns a structured summary in which every number carries a source field and
a reporting period. The orchestrator sees only those summaries, never the underlying data, and its
job is to synthesise rather than compute — it may not introduce a number no agent reported.
Disagreement between departments triggers re-verification against source rather than a negotiated
compromise, because two agents averaging their way to a wrong figure is the worst available
outcome. Missing data is marked explicitly, so the report separates "we checked and it is
unavailable" from "nobody mentioned it".

This project implements that pipeline for two departments, and the mechanism proved itself during
development: the coordinator was caught citing an operating-profit figure that neither agent had
reported in that exchange, and the grounding check refused it. **The trade-off is that this is less
emergent and less impressive-looking than agents talking to one another, in exchange for a result a
finance director can act on.**

---

## Question 3 — How would you handle scale and API rate limits for ~15 employees?

**At roughly 30–45 requests per minute the binding constraint is burst shape and cost, not
sustained throughput.** Fifteen employees at two to three requests each per minute is an average no
provider tier struggles with; the failures come from everyone arriving at 09:00, from one
cross-department question fanning out into several parallel calls, and from the monthly bill. I
would put all provider traffic behind a single client with bounded concurrency and a token bucket,
so a multi-agent fan-out is shaped rather than dumped, and retry on 429 and 5xx with exponential
backoff plus jitter so parallel agents do not retry in lockstep. Interactive requests take priority
while scheduled work queues and becomes batch-eligible, which flattens the peaks that actually
break things. On cost, model tiering does most of the work — cheap models for routing and
classification, stronger ones reserved for real reasoning — alongside prompt caching, a short-TTL
response cache keyed on the normalised question and a data-version stamp, and hard token budgets
that stop runaway spend rather than merely reporting it. I would track tokens, cost, latency and
error rate per agent and per employee, and degrade gracefully when limits are hit, because a queued
or slightly stale answer beats a failed one.

This submission already carries that shape: model tiering by call purpose, bounded concurrency,
jittered retry, token accounting and an enforced project token budget all live in the LLM client
rather than in callers. **The trade-off is that caching and cheap routing models buy cost and
latency at the price of freshness and some classification accuracy, so cache TTLs should key off
data-change events rather than a fixed clock.**
