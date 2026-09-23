# Backend contract

Pheebs is backend-agnostic: the client holds a base URL and a per-developer token, nothing else.
Anything that answers the four required routes is a Pheebs backend. A fifth, `/insights`, is
optional and is read by `pheebs insights`.

[`openapi.yaml`](../openapi.yaml) at the repo root is the normative schema, and
[`examples/backend-node/`](../examples/backend-node/) is a working implementation in ~150 lines
with no dependencies. This document covers what a schema cannot express: why each route behaves
the way it does, and the failure semantics a correct implementation has to honor.

Read it before implementing, because three of these are easy to get backwards.

## The routes

| Route | Auth | Blocking? |
|---|---|---|
| `POST /ingest` | `Bearer <token>` | No — fire-and-forget |
| `POST /validate-token` | none | Yes, at token-set time |
| `POST /classify-prompt` | `Bearer <token>` | Yes, ~2.5s budget |
| `POST /otel/v1/{traces,metrics,logs}` | `Bearer <token>` | No |
| `GET /insights` | `Bearer <token>` | Optional, read by `pheebs insights` |

Every route answers `405` on a wrong method rather than `404`. Most frameworks conflate the two
unless told otherwise, which leaves a caller unable to tell an unknown path from a wrong verb.

## `/ingest`

One event envelope per request. Required: `timestamp`, `source`, `event`, `codebase`, `ai_tool`,
`session_id`, `version`; everything else is per-event and open-ended, so store extras generically
rather than pinning a column per field.

**The client strips `developer` and `logPath` before sending.** Identity is stamped server-side
from the token. A backend that trusts a client-supplied `developer` is letting any token claim any
identity — so ignore that field if it ever appears.

**Only two status codes mean anything to the client:**

- `401` / `403` — the token was rejected. The client drops a marker that `pheebs doctor` surfaces
  to tell the developer to re-set their token.
- `422` — unprocessable; the client writes a line to stderr.

Everything else, **including 5xx**, is swallowed (a connection-level failure prints one stderr
line and is otherwise ignored). The client does not retry and does not queue:
the local JSONL is the durable copy, and a hook must never block the agent. Do not design around
client-side retry, because there isn't any.

## `/validate-token`

Unauthenticated — the token being validated travels in the body. Returns `allowed` plus, when
allowed, `id`, `developer`, `tenant`, `opt_out`, `prompt_collection`, and on rejection a `reason`.

`opt_out` is **advisory in the current client**: it only changes a message printed by
`pheebs config set token`. It does not suppress ingest, and it does not gate classification —
`prompt_collection: false` is the only response field that stops prompt text being sent. If you
mean to stop capture for a developer, enforce it server-side.

**A 5xx is not a verdict.** The client treats it as "backend unreachable" and degrades offline,
preserving any identity it had already resolved. A `4xx` is a real rejection and the token is not
stored. Getting these backwards means a transient blip locks developers out of their own identity.

`reason` is read **only from a 2xx body**: `validateToken` maps any non-ok status below 500 to
`{allowed:false, reason:"unknown"}` without reading the body, so a `403 {"reason":"revoked"}` is
discarded and the developer sees the generic rejection. Send `revoked` in a 200 verdict.

One more asymmetry worth knowing: the client does **not** read `allowed` on this route — it
branches on `reason === "revoked"` and on the presence of `id`. A rejection must therefore **omit
`id`**, or the token is stored as valid and its identity used on every event.

`prompt_collection` is the consent gate for the next route. It is cached locally at token-set time
and **never refreshed automatically** — nothing on the hook path revalidates it. So revoking
consent server-side does not reach a machine until its developer re-runs `pheebs config set token`.
**Enforce consent again on every `/classify-prompt` call; that is the only gate that actually
revokes.**

## `/classify-prompt`

Takes `{ "prompt": "..." }`, returns `{ "allowed": bool, "result": { "label", ... } }`.

This is the only route that receives raw developer content, and it carries obligations the others
do not:

- **Answer within 2.5 seconds.** The client aborts at `CLASSIFY_TIMEOUT_MS` and degrades to
  `unclassified`. A slow classifier is not a broken one, but it is a useless one.
- **Enforce consent again, server-side.** The client already checks the token's
  `prompt_collection` before sending, but a client check is not a control. Return
  `allowed: false` and the client records `unclassified`.
- **Do not persist the prompt.** The client stores only the returned label and promises its users
  that Pheebs does not keep the text. A backend that logs prompts breaks that promise on the
  client's behalf.
- Hold the model credential yourself. The client ships none, by design.

Any degraded response — non-2xx, `allowed: false`, a missing `result.label`, a timeout — lands the
same way: `prompt_intent: "unclassified"`, no error surfaced, no blocking.

### `result.task_scope`

Optional, and additive: `mechanical`, `bounded`, `cross_cutting`, `open_ended`, or `n/a`. It sizes
the work a prompt asks for, and only task-shaped and repair-shaped prompts are sized. A backend
that does not size tasks omits the field and stays conformant.

**No released client reads it yet.** `classify()` copies `label`, `requests_verification` and
`classifier_version` and drops the rest, so a `task_scope` returned today goes nowhere. It is
specified now because adding it later would be a contract change for everyone who had already
built against this one. When the client does forward it, it will sit on
the prompt event beside `prompt_intent`, and the client will never derive it locally.

It describes work, not models. Naming a tier here (`use_haiku`) would bake a mapping that changes
with every model release into the label on the prompt, where it cannot be revised. Which model is
enough for which scope belongs in a consumer's table, next to prices that also change.

Absence is not `n/a`. A field missing because the classifier degraded and a field set to `n/a`
because the prompt was not a task are different facts, and a backend that collapses them will
report scope coverage it does not have.

## `/otel`

An OTLP/HTTP passthrough. The client configures the agent's native OpenTelemetry exporter to point
here with the Pheebs token as the bearer, and the proxy swaps in the real upstream credential
before forwarding.

The point is that **no observability credential ships in the client**. Pheebs is installed on
developer machines; an upstream metrics credential sitting in a config file there is a credential
you cannot rotate. [`test/no-secrets.test.ts`](../test/no-secrets.test.ts) enforces this.

## `/insights` (optional)

`GET /insights?days=30` with the developer's token. Answers a map of sections:

```json
{
  "days": 30,
  "sections": {
    "cost": { "enabled": false, "reason": "no_consent" },
    "repertoire": { "enabled": true, "sessions": 62, "coverage_index": { "recurring": 9, "applicable": 23 } },
    "quality_signals": { "enabled": true, "verification_coverage": { "value": 0.62, "team_median": 0.48 } }
  }
}
```

`pheebs insights` reads it and renders whatever arrives. A backend that answers
`{"days": 30, "sections": {}}` forever is conformant: the command then reports that this backend
produces no sections, which is the honest answer rather than an error.

Two things the client does with the response are worth knowing before you implement it. It renders
an unavailable section as a single line, mapping your `reason` code to its own fixed wording (a
code it does not recognise reads as "not available"), so a section you cannot compute
costs the reader one line and never shows a zero. And it draws `trend` as a sparkline only from two points
up: a single-week series gets no chart and is named under the table instead, with the signal's own
`value` shown above. Send the history you have rather than padding it to a fixed length.

**Sections, not one report, and the map is open.** New views get added over time, so a consumer
must ignore a section it does not recognize rather than failing on it. A missing section means
"this backend does not produce it"; a section present with `enabled: false` means "it produces it,
but not for you right now", and says why in `reason`. Anything added later lands as another
section and breaks nobody.

The three defined today are the AI Proficiency Model's own division, not an invention of this
contract: **`repertoire`** is Layer 1, which practices the engineer uses; **`quality_signals`** is
Layer 2, what happens to AI output before it ships; **`cost`** is the third question, could a
cheaper model have done this work.

That division also tells you what each section costs to build, which matters more than the naming
if you are implementing this yourself:

| Section | What it takes | Realistic for a self-hoster |
|---|---|---|
| `repertoire` | Rollups of events you already store | Yes, today, with nothing else |
| `quality_signals` | A prompt classifier, except for `verification_coverage` | Partly. One signal needs no classifier at all |
| `cost` | Per-session token telemetry, a price table, a scope label per prompt | The most work, and `not_implemented` is a fine answer |

So a backend built on nothing but the ingest stream can answer `repertoire` in full and one signal
of `quality_signals`, and say `not_implemented` for the rest without being any less conformant.

**They are gated differently, which is why availability is per section.** `repertoire` needs only a
valid token: it shows a developer their own telemetry back. `quality_signals` needs classifier
labels for three of its four. `cost` needs the tenant's `prompt_collection` consent, because every
figure in it descends from reading prompts. One flag over the whole report would hide views the
caller is entitled to.

`reason` is deliberately specific rather than a bare `false`. `no_consent` is not a secret from the
caller, since `/validate-token` already hands the same client its tenant's `prompt_collection`, and
an unexplained `false` is indistinguishable from a broken backend. `insufficient_data` is the
honest answer for a developer with too few sessions, and must never be rendered as a zero.

**The caller's own data, never anyone else's.** Identity comes from the token, as on
`/validate-token`. No peer comparison, no leaderboard. The one exception is `team_median` on a
quality signal, which answers "is this normal here" without naming anyone.

### The `cost` section

Could a cheaper model have done this work: sessions by recommended class, savings per cheaper
model, an effort-suggestion count, cache behavior, and the distribution of work sizes.

**Every figure carries `basis`, which reads `API list-price equivalent, estimated upper bound`,
and both halves are load-bearing.** *List-price equivalent*: on a seat-based plan the true saving
is zero, so the number is a comparison and not money back. *Estimated upper bound*: the cheaper
model was never run, so nobody knows how many tokens it would have spent, and a weaker model that
needs three more turns can cost more than the estimate claims it saves. Render it next to the
number, not in a footnote. The schema requires it whenever the section is enabled.

A saving can also be negative. Cache-read pricing does not scale with the model tier, so on a
cache-heavy session a cheaper model can cost more. Do not assume the figure is positive. A row
summed over zero sessions is zero, though, never negative.

**Claude Code only, today.** The numbers come from joining per-session token counts to prices, and
only Claude Code emits that telemetry. For a Cursor or Codex developer there is nothing to compute,
and `enabled: false` with `insufficient_data` beats a report of zeros, which reads as "you saved
nothing" rather than "we cannot see this".

### The `repertoire` section

Layer 1: sessions, active weeks, the coverage index as its two parts, the competency profile with
a state per competency, artifact breadth, and how sessions compact.

The coverage index ships as `recurring` over `applicable` rather than a percentage, so the consumer
renders the share and the denominator and the backend does not decide the rounding. A competency
state of `n/a` means the harness cannot do it and it leaves the denominator; `insufficient_data`
means it cannot be judged yet. Collapsing those two overstates coverage for one engineer and
understates it for another.

`artifact_breadth` is a raw count, deliberately. No cutoff has been calibrated, and putting an
arbitrary threshold in a contract makes it permanent.

### The `quality_signals` section

Layer 2: verification coverage, pushback rate, refinement-to-repair, wholesale-accept. Rates and
ratios that move in both directions, with no levels and no ranking.

Each carries `value` and `unit`, and optionally `team_median`, a `trend` of weekly values oldest
first, and `large_changes`, the same signal over large changes only.

**`unit` is required, and it is not decoration.** The four signals do not agree on one: three are
shares and `refinement_to_repair` is a ratio, so a renderer that assumes percentages prints a
healthy `2.1 : 1` as `210%`. `share` renders as a percentage, `ratio` as `2.1 : 1`, `count` as a
whole number, and a unit a consumer does not recognize prints as the raw value rather than a
guess. **`trend` is not decoration**: a rate
printed alone reads as a verdict, and these are meant to be read as direction. A four-week
deployment reports four points rather than a padded series, because padding invents history.

Only `verification_coverage` is classifier-independent. The other three need prompt labels, so a
backend without them omits those fields rather than reporting a zero.

## Building one

Start from [`examples/backend-node/server.js`](../examples/backend-node/server.js) — it implements
all four required routes, answers `/insights` with `enabled: false`, appends to JSONL, and runs
with `node server.js`. Point a client at it:

```bash
pheebs config set base-url http://localhost:8787
pheebs config set token pheebs_local
```

It is a teaching implementation: tokens are not real, storage is a file, and there is no
authentication worth the name. Do not deploy it.
