# Written Assessment Answers

Three questions from the Cherry Host / REJ Investment AI Engineer assessment.

---

## Question 1 — How would you ensure each department agent only accesses its own data?

**Isolation is an authorisation problem, and a system prompt is not an authorisation mechanism.**
A prompt saying "you are the Finance Agent, never read HR data" is a behavioural hint that a
sufficiently confused or adversarially prompted model will ignore, and it leaves no trace when it
fails. The enforcement has to sit in application and database code, where it can be tested. In a
real Supabase deployment I would resolve the caller's identity first — user, company/tenant ID and
department — before any data is touched, and treat routing as the authorisation step so it happens
before access rather than alongside it. Each agent would then receive an allowlist of approved
tools or RPCs, such as `getMonthlyFinanceSummary()` or `getDepartmentHeadcount()`, each performing
its own authorisation check; the model would never emit executable SQL and would never hold direct
table access. Row Level Security and restricted views would enforce the same boundary at the
database, so that an application-layer bug still cannot cross departments, and every sensitive call
would be logged with the agent, user and fields returned. Access fails closed: an unrecognised
department or a missing claim denies rather than defaults.

This submission models the same shape at small scale, and proves it rather than asserting it. Data
lives in per-department modules that never import each other; a single composition root is the only
file permitted to load both datasets; each factory takes a department-scoped type so a
cross-department wiring mistake is a compile error; the data is captured in a closure with no
accessor on the returned agent; and every field an agent cites in its output is verified against
its own authorised fact sheet, so an answer citing a foreign field is rejected at runtime.
`tests/isolation.test.ts` checks all of these, including a hostile model response that deliberately
cites another department's field. **The trade-off is that allowlisted tools are far less flexible
than open query access — an agent can only answer what someone has explicitly exposed — and that
rigidity is the point.**

---

## Question 2 — How would you design the "AI agent meeting" so the output is reliable?

**It should be an orchestrated reporting pipeline that looks like a meeting, not a conversation
between models.** A free-form debate between agents is the most appealing version of this idea and
the least trustworthy: each turn is a fresh opportunity to hallucinate, errors compound as agents
cite each other, cost and latency are unbounded, and nothing produced is auditable afterwards. I
would instead run fixed rounds under a central orchestrator. Each department agent first retrieves
verified metrics through its own authorised tools, then returns a structured summary in which every
number carries a source field and a reporting period — never free prose that a later step has to
re-parse. The orchestrator receives only those structured summaries, never the underlying data, and
its job is to synthesise and reconcile, not to compute: it may not introduce a number that no agent
reported. Where two departments disagree on a figure, that triggers re-verification against source
rather than a negotiated compromise, because two agents averaging their way to a wrong number is
the worst possible outcome. Missing data is marked explicitly as missing, so the final report
distinguishes "we checked and it is unavailable" from "nobody mentioned it", and provenance is
preserved end to end so any figure in the summary can be traced back to the field it came from.

This project implements exactly that pipeline for two departments: agents run in parallel, the
coordinator receives only their verified analyses, constraints such as the maximum affordable
number of hires are computed in code and cannot be overridden by the model, and a verdict
contradicting those constraints is rejected outright. During development the coordinator was caught
citing an operating-profit figure that neither agent had reported in that exchange, and the check
refused it — which is the mechanism working as intended. **The trade-off is that this is less
emergent and less impressive-looking than agents talking to one another, in exchange for a result a
finance director can actually act on.**

---

## Question 3 — How would you handle scale and API rate limits for ~15 employees?

**At roughly 30–45 requests per minute the binding constraint is burst shape and cost, not
sustained throughput.** Fifteen employees at two to three requests per minute is a modest average
that no provider tier struggles with; the problems come from everyone arriving at 09:00, from a
single cross-department question fanning out into several parallel calls, and from the monthly
bill. I would put all provider traffic behind one client with bounded concurrency and a per-provider
token bucket, so the fan-out of a multi-agent request is shaped rather than dumped, and retry on
429 and 5xx with exponential backoff plus jitter so parallel agents do not retry in lockstep.
Interactive requests get priority while non-interactive work — scheduled reports, overnight
summaries — goes to a queue and is batch-eligible, which flattens the peaks that actually cause
failures. On cost, model tiering does most of the work: routing and classification run on the
cheapest fast model while only genuine reasoning reaches a stronger one, and prompt caching on the
stable parts of a system prompt plus a short-TTL response cache keyed on the normalised question
and a data-version stamp removes a surprising share of repeat traffic. Long conversations get
summarised rather than replayed in full. I would track tokens, cost, latency and error rate per
agent and per employee, with per-tenant budget caps, and degrade gracefully when limits are reached
— a queued or slightly stale answer beats a failed one.

This submission already contains the shape of that: model tiering by call purpose, bounded
concurrency, jittered retry and token accounting all live in the LLM client rather than in callers,
so the policy is enforced in one place. **The trade-off is that caching and cheap routing models
buy cost and latency at the price of freshness and some classification accuracy, so cache TTLs
should key off data-change events rather than a fixed clock, and the routing tier needs monitoring
for questions it places wrongly.**
