# Contributing to pheebs

House rules for code that lands in this repo. They bind humans and agents equally — a rule
an agent breaks is still a rule broken, and reviewing that is part of the job.

[`AGENTS.md`](./AGENTS.md) carries the invariants and the schema rules, and
[`docs/architecture.md`](./docs/architecture.md) carries the pipeline. Read both before
changing what Pheebs emits.

## Getting started

```bash
npm install          # installs deps and registers the git hooks
npm run build        # tsc → dist/
npm test             # vitest
```

The CLI suite runs against the built `dist/cli.js`, so build before testing a CLI change.

## The gate

These four must pass before a change is ready. The first three are exactly what CI runs on
every pull request, so a red one here is a red one there:

```bash
npm run lint         # Biome — errors block, pre-existing warnings do not
npm run typecheck    # tsc --noEmit
npm test             # vitest
npm run build        # tsc → dist/ (the tarball ships dist/, so keep it green)
```

A pre-commit hook runs `biome check --write` on staged `*.ts`/`*.json`, and a pre-push hook runs
the tests. Bypass with `--no-verify` only when you mean to.

## Submitting a change

1. Branch from `main` — `feature/*`, `bugfix/*`, or `refactor/*`.
2. Write [conventional commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `chore:`,
   `docs:`). Releases and the changelog are generated from them by release-please, so the subject
   line is user-facing. Explain the *why* in the body.
3. Run the gate.
4. Open a pull request and fill in the template — including the **privacy impact** section, which
   is the review question this project cannot afford to skip.

Changes to what Pheebs captures carry extra obligations: keep the privacy line
([`PRIVACY.md`](./PRIVACY.md)), respect the invariants and schema rules in
[`AGENTS.md`](./AGENTS.md), and record anything you verified empirically about a vendor's hook
payload in [`docs/spike-findings-ledger.md`](./docs/spike-findings-ledger.md).

Changes to documentation are reviewed against
[`docs/documentation-rules.md`](./docs/documentation-rules.md): it says which file owns what, and
the rules every doc follows.

## High-risk areas

Three areas carry consequences a contributor cannot see from the diff, so a maintainer reviews
every change to them:

- **Capture correctness.** What a hook fires on, what an extractor reads, and what an event
  claims happened. A wrong field does not announce itself. It becomes a number someone trusts
  later.
- **Privacy boundaries.** Anything that widens what is recorded or sent, a new field on an
  existing event included. [`PRIVACY.md`](./PRIVACY.md) is a promise, and a change here either
  keeps it or amends it in the same pull request.
- **Contract changes.** The event envelope, the backend routes, and `openapi.yaml`. Self-hosters
  implement against these, so the change lands on people who are not in the review.

An AI code review is advisory in these three areas, whether it runs on this repository or you
ran it yourself before opening the pull request. It reads a diff well, but none of the three is
decided by what the diff looks like. Post its comments if they help; they do not stand in for a
maintainer's sign-off.

## Code comments

Applies to `src/`, `test/`, and `scripts/` — anything we author, whether a
human or an agent typed it.

### The rule

**A comment explains why the code is the way it is. The code already says what it does.**

Before writing a comment, ask one question:

> Would a competent engineer reading this code already know this?

If yes, delete the comment. If no, the comment is carrying real knowledge — keep it,
and make it explain the reason, constraint, or consequence, not the mechanics.

Comments are not free. Every one of them is a line a reviewer has to read and a future
change has to keep true. A comment that restates the code is worse than no comment,
because it rots silently and trains readers to skip comments entirely.

### Comment these

Things a reader cannot recover from the code alone:

**Non-obvious ordering or timing that looks wrong but isn't.**

```ts
// The throttle is stamped BEFORE spawning so concurrent sessions starting the
// same day never launch parallel `npm install -g` runs.
```

**Deliberate silence — an error we swallow on purpose.** Pheebs degrades gracefully
by design, so a swallowed failure is indistinguishable from a bug without a reason.

```ts
// A spawn that fails asynchronously must not crash the hook process.
```

**Privacy decisions at the capture site.** Why a field is *not* captured, or what is
read in-process and discarded, is the most valuable comment in this codebase.

```ts
// Persist only the prompt's character count, never the text.
```

**Vendor behavior we discovered empirically**, with a pointer to the ledger:

```ts
// Codex gates `metrics_exporter` behind `[analytics] enabled`, which defaults to
// `false` under the app-server, so without this flag the configured OTLP metrics
// endpoint is silently dropped.
```

Anything of this kind that generalizes beyond one call site belongs in
[`docs/spike-findings-ledger.md`](docs/spike-findings-ledger.md), not only in a comment. Put the finding
in the ledger and let the comment be a one-line pointer.

**Fallback chains and precedence**, where the order encodes a decision (see the
`detectCodebaseId` chain in [`src/config.ts`](src/config.ts)).

### Don't comment these

**Restating the signature.** This is the single most common noise in our PRs. If the
doc comment paraphrases the function name and its return type, it adds nothing:

```ts
// ✗ Delete these — the name and types already say it
/** Remove the stored token. Returns whether a file existed. */
/** Returns a 405 response for non-POST requests, or null to continue. */
/** Last 4 characters of a token, for non-sensitive display. */
```

**Narrating the steps.** `// Loop over the events`, `// Now check if the token is
expired`, `// Step 1: …`. The code is the steps.

**Section banners.** A `// ---- helpers ----` divider is decoration. In a file short enough
to read at once it adds nothing; in a long one it papers over a module that wants splitting
— `src/hooks/handler.ts` and `src/scanner.ts` are both past 400 lines, and that is the
problem to fix, not to label.

**History and changelogs.** `// previously we used X`, `// changed to fix the retry bug`.
Git owns history. If the old approach matters, the comment should state the current
constraint that rules it out, not the story.

**Commented-out code.** Delete it. It is in git if we need it.

**Coordinates into other files.** Never cite a line number — `see scanner.ts line 257` is
false the next time anyone edits that file. Describe the concept instead. A bare file path
is fine when the pointer *is* the point ("same model as the HTTP transport, see
`src/transports/http.ts`"), but not as a substitute for saying the thing.

**Anything addressed to the agent or the reviewer** rather than to the next reader:
`// Added per review feedback`, `// As requested`, `// AI-generated`, restated
acceptance criteria, or a summary of what the diff does. That belongs in the PR
description.

### No ticket references in code

Never put a ticket identifier, a tracker link, or a PR URL in source or in a comment.
Ticket identifiers go in three places only: the **commit message**, the **PR
description**, and the **branch name**.

Reason: a ticket is a snapshot of a decision at one moment. Code outlives it, and six
months later the reference sends the reader to a closed ticket instead of telling them
the constraint. Write the constraint.

```ts
// ✗ Table-only classification (see the ticket for scope). Unknown types default to …
// ✓ Table-only classification: unknown agent types default to … so a new
//   vendor agent type never silently lands in a role bucket.
```

**The one exception is deferred work.** A `TODO`/`FIXME` that exists to be removed later
should carry its ticket, because the ticket is what closes it:

```ts
// ✓ TODO(<issue-id>): drop this fallback once every machine is past 0.11.
```

When a comment needs to point outward, point at something durable — a vendor doc, an RFC,
an upstream issue — never a Slack message, a ticket, or a line number.

### Doc comments (`/** … */`)

Use a doc comment on an **exported** function, type, or constant only when it carries a
contract a caller cannot see in the signature: degradation behavior, TTL/caching,
mutation of its argument, ordering guarantees, or a privacy boundary.

```ts
// ✓ carries real contract — what "undefined" means for the caller
/**
 * Resolve a token against the backend. Returns the validation result, or
 * undefined if the backend is unreachable (the caller decides how to degrade).
 */
```

Do not add `@param`/`@returns` that restate types — TypeScript already declares them.
Internal helpers get a `//` line above them if they need anything at all.

### Length

One or two sentences per reason. A comment can be entirely about *why* and still be noise
if it walks through the mechanics at length:

```ts
// ✗ four lines narrating what the code plainly does
// Persist only the prompt's character count. The raw string is read from the payload
// in-process, measured with .length, assigned to the event field, and then discarded
// when the handler returns — it is never written to the log or sent to the transport.

// ✓ one sentence, the constraint only
// Persist only the prompt's character count — the raw text is read in-process and
// never logged or transmitted.
```

If a point genuinely needs a paragraph, the long form belongs in
[`docs/spike-findings-ledger.md`](docs/spike-findings-ledger.md) and the comment is a one-line pointer to it.

A multi-line block is right when it carries **several distinct constraints** — the
`maybeAutoUpdate` block in [`src/auto-update.ts`](src/auto-update.ts) earns its length
because every sentence is a different decision (stamp before spawn, detach and unref,
fail silently, re-invoke by path). It is not right for one constraint told slowly.

### Density and voice

- Match the file you're in. This repo's style is a short `//` block above the thing it
  explains, prose, full sentences. Follow it rather than introducing a new style.
- Prefer one good comment at the top of a module or function over a comment per line.
- Write for the next reader, in the present tense, about the code as it is.
- A suppression carries its reason on the line: `// biome-ignore lint/<rule>: <why>`.
  Never a silent ignore.

### Tests

Put the scenario in the test name, not in a comment above it. If a test needs a comment,
it is usually because it asserts something non-obvious about *vendor* behavior — say
that, and point at the ledger entry.

### Reviewer checklist

A change is ready when, for every comment it adds:

- [ ] It answers *why*, not *what*.
- [ ] A competent reader could not have known it from the code.
- [ ] No ticket ID, PR link, or reviewer/agent aside — except a ticket inside a `TODO`.
- [ ] It is not a paraphrase of the name or the types.
- [ ] One or two sentences per reason; nothing narrates mechanics at length.
- [ ] No line-number coordinates into other files.
- [ ] It is still true after the diff (no stale comment left behind by an edit).
- [ ] Any finding that generalizes is in `docs/spike-findings-ledger.md`, not only inline.
- [ ] No commented-out code, debug logging, or section banner survived.
- [ ] Every `biome-ignore` states its reason.
