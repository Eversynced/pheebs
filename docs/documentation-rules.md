# Documentation rules

Where every doc lives, what each one owns, and the rules that apply to all of
them. Doc changes are reviewed against this file.

## Ownership

Each file owns its subject. If you are adding something, find the owner first.

| File | Owns |
| --- | --- |
| [`README.md`](../README.md) | Install, quickstart, what is captured, trust posture, configuration, CLI reference, troubleshooting. The first page a stranger reads. |
| [`AGENTS.md`](../AGENTS.md) | Canonical agent context: invariants, key paths, commands. `CLAUDE.md` is a thin shim that imports it. |
| [`CONTRIBUTING.md`](../CONTRIBUTING.md) | How to work on the code: setup, tests, commit and PR conventions, code and comment rules. |
| [`SECURITY.md`](../SECURITY.md) | Reporting a vulnerability, supported versions. |
| [`PRIVACY.md`](../PRIVACY.md) | What is captured and what is not, field by field, and how that is enforced. |
| [`CODE_OF_CONDUCT.md`](../CODE_OF_CONDUCT.md) | Community standards and enforcement contact. |
| [`CHANGELOG.md`](../CHANGELOG.md) | Releases only. Not a running work log. |
| [`architecture.md`](./architecture.md) | The pipeline, the event envelope, where the contract and a Layer 2 consumer fit. The single source for architecture. |
| [`backend-contract.md`](./backend-contract.md) | What a compliant backend must do, including failure semantics. Pairs with [`openapi.yaml`](../openapi.yaml), which is the normative schema. |
| [`ai-proficiency-model.md`](./ai-proficiency-model.md) | The consumer lens: what captured facts are read as. |
| [`ai-proficiency-model-practice-and-signal-registry.md`](./ai-proficiency-model-practice-and-signal-registry.md) | Per-practice measurability against a stated released version. |
| [`spike-findings-ledger.md`](./spike-findings-ledger.md) | Verified findings about hook payloads and vendor behavior. Append-only. |

## Rules

**Single source of truth. Link, never duplicate.** Architecture lives in
`architecture.md`; README and AGENTS.md link to it. A fact that appears in two
files will disagree with itself within a release.

**Working plans are never committed.** Task breakdowns, migration checklists, and
status notes belong in the tracker, not the repo.

**No current-state ledger docs.** Copied test counts, coverage percentages, local
paths, and "as of today" inventories go stale silently and are wrong the moment
they are committed. Git history and fresh command output are the evidence.

**Dated and point-in-time docs are marked historical.** A doc that describes what
was true at one moment says so at the top and lives under `docs/history/`. It is
never linked as current guidance. The exception is the findings ledger, which is
dated by entry and current as a whole.

**The registry is re-verified before a release.** Every practice row in
[`ai-proficiency-model-practice-and-signal-registry.md`](./ai-proficiency-model-practice-and-signal-registry.md)
is checked against the version about to ship, and the "Version measured" line is bumped. It is
part of the pre-release audit, not a follow-up.

**Verify relative links whenever docs move.** Every relative markdown link must
resolve. A rename is not finished until inbound references are updated.

**No internal-only content.** No company workflow, no tracker or ticket
references, no infrastructure specifics (vendor names, hostnames, account
details). This applies to code comments as much as to docs.

**Write for a first-time reader.** No narration of how the project got here, no
"this used to be X". State what is true now. The exception is the findings
ledger, where a correction is the finding.
