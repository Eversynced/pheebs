# AGENTS.md

Canonical agent context for this repository. `CLAUDE.md` imports this file.

## What Pheebs is

Pheebs captures how developers interact with AI coding agents. It registers hooks
in Claude Code, Cursor, and Codex, turns each hook payload into a generic event,
writes it to a local JSONL log, and optionally sends it to a backend the user
configures. It ships local-only: `DEFAULT_BASE_URL` is the empty string, so an
install that is never pointed at a backend sends nothing.

The pipeline, the event envelope, and the contract are described in
[`docs/architecture.md`](./docs/architecture.md). Read it before changing what
gets emitted. Do not restate it here or in the README.

## What mistakes cost

This is a privacy-sensitive tool that runs inside other people's coding sessions.
The failure modes are not equal, and three of them are unrecoverable:

- **Leaking content.** Prompt text, source, or file paths reaching disk or the
  network is a breach of the promise in [`PRIVACY.md`](./PRIVACY.md). It cannot be
  taken back once shipped.
- **Breaking the user's session.** A hook that throws, hangs, or blocks makes the
  user's agent worse. They will uninstall, and they will be right to.
- **Corrupting the measurement.** An event that encodes our interpretation rather
  than a fact poisons every consumer downstream, including consumers that do not
  exist yet. A wrong number is worse than a missing one, because it is trusted.

## Invariants

Binding on any change. If a change cannot hold all of these, it is the wrong
change.

1. **Never persist or transmit prompt or session content anywhere except the
   user-configured sink.** Raw payloads, shell command strings, tool responses,
   diffs, and file paths may be read in-process to derive a small tag or an
   integer, then must be discarded. The single exception is prompt
   classification, and it is gated on the tenant's stored `prompt_collection`
   consent, sends the prompt to the configured backend only, and stores the
   returned label rather than the text.
2. **Hooks never break or slow the user's session.** Remote failures degrade
   silently, never throw into the hook. All hook entries are registered with
   `"async": true`. The local JSONL log is the durable copy; the network send is
   fire-and-forget.
3. **Contract changes require a version bump and a doc update.** A change to
   `openapi.yaml` or to the event envelope lands together with
   [`docs/backend-contract.md`](./docs/backend-contract.md) and a version bump.
   A backend written against the old contract must be able to tell.

## The schema rule

Pheebs is the generic, unbiased event layer. Every model built on top is a
consumer, never a driver of the schema.

- **Never emit goal-shaped metrics.** No `tier_3_detected`, no scores, no
  verdicts. Emit facts and let the consumer compose them. A field that only makes
  sense to one consumer's scoring model does not belong in an event.
- **Prefer the raw component over a pre-judged rollup.** A derived tag such as
  `tool_intent` or `role` is a convenience, allowed only while it stays coarse,
  generic, and privacy-preserving, and only while the field it derives from is
  still emitted. `role` is legitimate because `agent_type` ships beside it.
- **Where measurement is capped by principle, say so.** Never invent a proxy.
  Some things are unmeasurable by design (no prompt text, no paths) and some by a
  vendor's hook surface. Document them as out of scope rather than faking
  coverage.
- **Absent is not zero.** `lines_changed` stays unset on an unrecognized shape and
  `rule_attachment_count` is omitted for a rule-less list, because a `0` would be
  indistinguishable from a surface that does not populate the field.
- **Classification tables are table-only.** `classifyRole` maps known agent types
  through `AGENT_ROLES` with a `generate` default and never infers from a name, so
  a `generate` agent is never falsely credited with a review pass. Extend the
  table; do not add a heuristic.

## Commands

```bash
npm run build                      # wipes dist/, then tsc → dist/
npm run lint                       # Biome
npm run format                     # Biome, writes changes
npm run typecheck                  # tsc --noEmit
npm test                           # Vitest
npm run test:coverage              # Vitest with v8 coverage

pheebs hook <event>                # Claude Code hook, reads JSON from stdin
pheebs hook-cursor <event>         # Cursor hook
pheebs hook-codex <event>          # Codex hook
pheebs init                        # Register Claude Code hooks + OTel
pheebs init --project              # Project-local config (see the Codex trust caveat)
pheebs init --cursor|--codex       # Register for Cursor / Codex
pheebs init --no-otel              # Skip OpenTelemetry configuration
pheebs doctor [--cursor|--codex]   # Verify hooks are registered
pheebs scan [--cursor|--codex]     # Scan repo for AI-config artifacts
pheebs insights [--days N|--json]  # The caller's own report from the backend /insights
pheebs config list|set|unset       # base-url | auto-update | classify | token
```

Biome (`biome.json`) lints and formats; Vitest (`vitest.config.ts`) runs
`test/*.test.ts`. The CLI is tested end to end against the built `dist/cli.js`,
so run `npm run build` before the CLI tests mean anything.

## Key paths

| Path | What it owns |
| --- | --- |
| `src/cli.ts` | Entry point. Dispatches hook commands and `init` / `doctor` / `scan` / `config` / `insights`. |
| `src/hooks/types.ts` | Shared types, `AI_TOOLS`, and the `EVENTS` enumeration of every event name. |
| `src/hooks/definitions.ts` | Aggregates per-tool definitions into `ALL_DEFINITIONS`; `getHookDefinitionsForTool`, `isPheebsEntry`, `buildHooksConfig`. |
| `src/hooks/definitions.{claude,cursor,codex}.ts` | Per-tool hook registrations. `PreModelSwitch` is deliberately unregistered: it fires ahead of a gate that can cancel the switch. |
| `src/hooks/handler.ts` | `handleHookEvent`. Validates the event, reads stdin, runs the per-tool extractor, derives tags, writes the entry. The place where capture decisions live. |
| `src/hooks/intent.ts` | `tool_intent` and the `vcs_action` sub-tag from tool names and shell commands. Ordered keyword table is the single place to extend. |
| `src/hooks/outcome.ts` | `classifyCodexOutcome`. Synthesizes the failure event Codex has no hook for. Returns `undefined` rather than guessing. |
| `src/hooks/role.ts` | `classifyRole` over the `AGENT_ROLES` table. |
| `src/scanner.ts` | Project-scoped scan for AI-config artifacts. Records presence and counts, never paths or contents, never user-level config, never git history. |
| `src/commands/init.ts` | Per-tool hook registration, merging and deduplicating into the tool's settings file. |
| `src/commands/doctor.ts` | Presence check via `isPheebsEntry`. |
| `src/commands/path.ts` | `resolveSettingsPath(tool, project)`, the one place config-file locations are resolved. |
| `src/otel.ts`, `src/otel-resync.ts` | OTLP config pointed at the backend `/otel` proxy. Writes only when endpoint and token are both set, removes config when either is cleared, and resyncs already-written agent config. |
| `src/backend-config.ts` | `~/.pheebs/config.json`. `hasBackend()` is the gate every network path checks. |
| `src/transport.ts`, `src/transports/http.ts` | The one seam for backend calls. Fire-and-forget ingest, bounded blocking classify. |
| `src/token.ts` | Token at `~/.pheebs/.token` (0600), validation, cached identity and `prompt_collection`. |
| `src/classify.ts` | Prompt classification, consent-gated, degrades to `prompt_intent: "unclassified"` sending no text. |
| `src/insights.ts` | `fetchInsights(days)`, the one `GET` in the contract. Redirects are manual, because a followed one would draw a report from a host the developer never configured, and the body is capped at 4 MB, because the 10s abort does not bound a fast link. Every failure returns a printable message. |
| `src/insights-normalize.ts` | The single boundary against an untrusted `/insights` response: shape guards, range checks, own-property lookups, control, ANSI and bidi stripping, bounded rows and string lengths. Also escapes the raw body for `--json`. |
| `src/insights-render.ts` | The report as pure functions over a normalized `Report`, guarding nothing itself. Sparklines, gauges and aligned tables per [`docs/ai-proficiency-model.md`](./docs/ai-proficiency-model.md). An unavailable section prints one reason line, never a zero; a trend under two points gets no chart; block glyphs fall back to ASCII. Emits no colour, so the output is identical piped, in CI, and to a reader who cannot distinguish red from green. |
| `src/commands/insights.ts` | `pheebs insights [--days N] [--json]`. Argument parsing (both `--days` spellings) and render options (terminal width, falling back to 80 off a TTY). Computes nothing: the backend produces the numbers. |
| `src/config.ts` | Codebase id resolution: env override, git remote `org/repo`, then `local/<folder-name>`. Directory name only, never a full path. |
| `src/developer-id.ts` | GitHub handle via `gh api`, falling back to a hashed git email. |

## Project-local config and Codex trust

All three tools read a project-local config, but on Codex that layer is trust
gated twice over: it is dropped unless the project is trusted, and each handler
needs a matching `trusted_hash`. Pheebs writes neither, and should not, because
both are the developer's own security decision about a directory. So `doctor`
reporting a project-scoped Codex install healthy means the file is in place, not
that the hook will fire. Cursor merges the project file with the user-level one
rather than replacing it.

## Before trusting a payload assumption

Vendor hook docs are young and drift, and assumptions about which fields a
payload carries are often wrong.
[`docs/spike-findings-ledger.md`](./docs/spike-findings-ledger.md) is the
append-only record of what has been empirically verified.

- Check the ledger before trusting a doc, or the absence of a field, for any
  payload assumption. If it is not there, verify it, then add an entry.
- After any spike that confirms, contradicts, or refines a payload belief, record
  it using the entry template in that file.
- If the finding changes what a detector can claim, update
  [`docs/ai-proficiency-model-practice-and-signal-registry.md`](./docs/ai-proficiency-model-practice-and-signal-registry.md)
  and cite the ledger.
- The privacy line applies to findings too: describe payload shape, never real
  prompt text, source, or file paths.

## Conventions

- **ESM project.** `"type": "module"`; lifecycle scripts in `scripts/` are CJS
  (`.cjs`) for Node compatibility.
- **Comments explain why, never what.** No ticket IDs or tracker links in source
  or comments, the sole exception being a ticket inside a `TODO`/`FIXME` that
  exists to be removed. [`CONTRIBUTING.md`](./CONTRIBUTING.md) is the binding
  rule, including for generated code. Read it before writing or reviewing here.
- **Docs.** [`docs/documentation-rules.md`](./docs/documentation-rules.md) says
  which file owns what. Link, never duplicate.
- The consumer lens lives in
  [`docs/ai-proficiency-model.md`](./docs/ai-proficiency-model.md) and its
  registry. Read them to know what a detector is for, never as a schema spec.
