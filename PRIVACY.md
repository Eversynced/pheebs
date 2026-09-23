# Privacy

Pheebs runs inside your coding agent and watches everything you do with it. That is an
uncomfortable amount of access, so this document says exactly what it records, what it cannot
record, and where it goes — in enough detail that you can check the claims against the source.

Three facts up front, because they determine everything else:

1. **Out of the box, no telemetry leaves your machine.** No backend endpoint ships with the client
   (`DEFAULT_BASE_URL` is the empty string in [`src/backend-config.ts`](./src/backend-config.ts)).
   Until someone sets one, Pheebs writes JSONL to `~/.pheebs/logs/` and sends no event, no prompt,
   and no OpenTelemetry data anywhere.

   Two things do still contact the network, and neither carries telemetry — we would rather name
   them than let you find them:
   - **Identity**: `gh api /user` resolves your GitHub handle, cached 24h
     ([`src/developer-id.ts`](./src/developer-id.ts)). Without `gh` it falls back to a hash of your
     git email and makes no call.
   - **Self-update**: **off by default.** If you opt in with `pheebs config set auto-update on`,
     a session start checks npm for a newer release once a day
     ([`src/auto-update.ts`](./src/auto-update.ts)). Left alone, it never runs — `pheebs doctor`
     tells you when a newer version exists instead.
2. **One feature sends raw text off your machine, and only one:** prompt classification. It is
   gated on consent, disableable, and described in full below. Everything else is derived
   locally and sent as a short tag.
3. **There is a second data channel, and it is not this file's JSONL.** If you let `pheebs init`
   configure OpenTelemetry, your *agent* exports its own traces, metrics, and logs through the
   backend's `/otel` proxy. See [OpenTelemetry](#opentelemetry) below.

## What a row looks like

Every event is one JSON line. This is a row exactly as [`src/logger.ts`](./src/logger.ts) writes it, from a `Bash` tool call
running `npm test`:

```json
{"source":"hook","event":"tool_use_completed","developer":"unknown","codebase":"test/local-only",
 "ai_tool":"claude_code","session_id":"smoke-1","timestamp":"2026-08-25T16:44:00.830Z",
 "version":"0.15.0","tool_name":"Bash","duration_ms":12,"tool_intent":"test_run"}
```

The command was `npm test`. What is recorded is `tool_intent: "test_run"` — the string `npm test`
never appears in the row and never leaves the process.

## The envelope

Present on every event:

| Field | What it is |
|---|---|
| `timestamp` | ISO time |
| `source` | always `hook` |
| `event` | one of 16 event names (see [`src/hooks/types.ts`](./src/hooks/types.ts)) |
| `developer` | your GitHub handle if `gh` is authenticated, otherwise `dev-XXXXXX` (a truncated hash of your git email), otherwise `unknown` |
| `codebase` | `PHEEBS_CODEBASE_ID` if set, else `org/repo` from your git remote, else `local/<folder-name>` (no remote, or started outside a repo), else `unknown` |
| `ai_tool` | `claude_code` \| `cursor` \| `codex` |
| `session_id` | the agent's own session identifier |
| `version` | the Pheebs version that wrote the row |

`developer` is only ever the local label. When a backend is configured, the server stamps identity
from your token and ignores the client-supplied value — the client strips `developer` before
sending ([`src/transports/http.ts`](./src/transports/http.ts)).

## What is never recorded

- **Source code and file contents.** Nothing reads the contents of a file you are editing. (The
  repo scan does parse your *agent config* files — `.claude/settings.json`, `.cursor/hooks.json`,
  `.codex/config.toml` — in-process, to answer "are hooks configured?" as a boolean. Nothing from
  them is persisted.)
- **File paths.** Not the file being edited, not the working directory.
- **Prompt text**, except through classification (below). `prompt_length` — a character count —
  is recorded instead.
- **Command strings.** A shell command is read in-process to derive a tag and then discarded.
- **Tool output.** Codex's `tool_response` is read to determine pass/fail and never persisted.
- **Git history, authorship, or diffs.** The repo scan uses git only to locate the repo root.

The one path-derived value in the whole system is the **name** of your working directory — not
its path — used as a `codebase` label when no git remote resolves. `/home/you/secret-project`
records as `local/secret-project`.

## Derived tags: raw in, small string out

Several fields are computed from something sensitive. The bargain is the same each time: the raw
value is read in-process, a short tag is derived, and only the tag is persisted.

| Tag | Derived from | Possible values |
|---|---|---|
| `tool_intent` | the shell command or tool name | `test_run`, `build`, `typecheck`, `lint`, `vcs`, `read`, `edit`, `other` |
| `vcs_action` | a `vcs` command | `commit`, `push`, `pr_create`, `other` |
| `command_name` | a leading `/command`, or `tool_input.skill` | the command or skill name |
| `mcp_server_name` | the `mcp__<server>__<method>` tool name (Claude Code, Codex), or Cursor's own field | the server name only |
| `role` | the sub-agent's `agent_type` | `review`, `generate` |

`git commit -m "fix the auth bug"` records `tool_intent: "vcs"` and `vcs_action: "commit"`. The
message is not recorded.

## The repo scan

On session start, Pheebs scans the repo for AI-config artifacts and emits one `artifact_found`
event per type found, carrying `artifact_type`, `count`, and `last_modified_bucket` — never paths,
never contents, never who wrote them. It is **project-scoped**: it never reads `~/.claude/` or any
other user-level config. Outside a git repo it does nothing.

## Per-event fields

Beyond the envelope, each event carries fields specific to it. These are copied from the agent's
hook payload by the three extractors in [`src/hooks/handler.ts`](./src/hooks/handler.ts).

**Common:** `tool_name`, `duration_ms`, `prompt_length`, `agent_type`, `agent_id`,
`stop_hook_active`, `trigger_type`, `reason`, `model`, `start_source`, `expansion_type`,
`is_interrupt`.

**Claude Code also:** `permission_mode` and `effort` (on every event), `command_source`,
`background_task_count`, `session_cron_count`, on a mid-session model switch `from_model`,
`to_model` and `switch_source` (two model ids and the vendor's own coarse reason for the switch —
never the surrounding cache or cost estimates the same payload carries), and on background tasks
`task_id`, `task_subject`, `teammate_name`.

**Cursor also:** `conversation_id`, `generation_id`, `composer_mode`, `cursor_version`, `sandbox`,
`status`, `loop_count`, token counts (`input_tokens`, `output_tokens`, `cache_read_tokens`,
`cache_write_tokens`), sub-agent detail (`subagent_model`, `is_parallel_worker`,
`subagent_duration_ms`, `message_count`, `tool_call_count`), `failure_type`, `attachment_count`,
`rule_attachment_count` (how many of those attachments were rules — read off each entry's `type`;
the `file_path` beside it is a real path and is never read), `effort` (the same field Claude Code
fills, here on three events rather than all) and `fast_mode` (the vendor's own `fast` model
setting), `session_duration_ms`, `is_background_agent`, and compaction detail
(`context_usage_percent`, `context_tokens`, `context_window_size`, `messages_to_compact`,
`is_first_compaction`).

**Codex also:** `input_tokens`, `output_tokens`, `permission_type`, `approved`.

> **Two of these are free text.** `task_subject` and `teammate_name` (Claude Code background
> tasks) are recorded **verbatim** — a task subject is a human- or model-written title, e.g.
> `"Set up Biome (lint + format)"`. Everything else above is an identifier, an enum, a boolean, or
> a number. If that is not acceptable for your repo, do not enable Pheebs on it; there is no
> per-field switch today.

Note that `agent_type` is stored as well as being the input to the derived `role` tag — the raw
field ships beside the tag deliberately, so a consumer is not locked into our classification.

## OpenTelemetry

`pheebs init` also configures your **agent's own** OpenTelemetry exporter (Claude Code and Codex)
to send through the backend's `/otel` proxy ([`src/otel.ts`](./src/otel.ts)). This is a separate
channel from everything above: that data is produced by the agent, not by Pheebs, it never appears
in `~/.pheebs/logs/`, and Pheebs does not choose what it contains — the agent's own telemetry
documentation does.

It is written only when both a backend endpoint and a token are set, and clearing either one
strips the exporter config again. To skip it entirely:

```bash
pheebs init --no-otel
```

The proxy exists so no observability credential ships to your machine: the client authenticates
with your Pheebs token and the backend swaps in the real upstream credential.

## Prompt classification — the one exception

On `prompt_submitted`, Pheebs can send your prompt to a backend `/classify-prompt` route, which
returns a single intent label. This is the only feature that sends raw text off your machine.

**It requires all of:** classification enabled (default on), a backend endpoint configured, a
stored token, and that token's tenant carrying `prompt_collection` consent
([`src/classify.ts`](./src/classify.ts)). No prompt text is sent unless every one of them holds.

The two failure shapes differ, and the difference is checkable in your own log:

- **Classification off** — the event carries no `prompt_intent` field at all.
- **On, but missing an endpoint, a token, or consent** — the event records
  `prompt_intent: "unclassified"`, and still no prompt text is sent.

What is stored is the label — `prompt_intent`, plus optional `requests_verification` and
`classifier_version`. **The prompt text itself is never written to your log and never stored by
Pheebs.**

Turn it off completely:

```bash
pheebs config set classify off
```

That is a client-side switch: with classification off, `classifyPrompt` returns before reading
your token or contacting anything.

Be precise about what the guarantee is worth. With consent enabled, the honest sentence is not
"prompt text never leaves the machine" — it is "prompt text leaves the machine, reaches the
backend you configured, is classified into one word, and is not persisted by Pheebs." What the
backend does with it is a property of that backend. If you run your own, that is your call to
make; if you use someone else's, ask them.

## The insights command

`pheebs insights` makes one authenticated `GET /insights` to the backend you configured and
renders the report in your terminal ([`src/insights.ts`](./src/insights.ts)). It is the only
outbound request that reads rather than writes: no event is emitted, no hook path runs, and
nothing is added to `~/.pheebs/logs/`. The response is held in memory for as long as it takes to
print it.

With no backend endpoint set, the command makes no request at all and tells you to set one.

## See it for yourself

The local JSONL is the durable copy and it is plain text. Read it:

```bash
tail -qn 20 "$(ls -t ~/.pheebs/logs/*.jsonl | head -1)"
```

(`-q` suppresses the filename headers `tail` would otherwise print — those headers are absolute
paths, which is exactly what this document says Pheebs does not record. The `ls -t` picks the most
recent log rather than 20 lines from every file you have ever had.)

Nothing is sent through the event transport that is not in those rows, minus `developer`, which
the client strips so the server can stamp identity from your token. (OpenTelemetry is separate —
see below.)
If a row looks wrong, that is a bug worth reporting.

Two checks in the test suite back this up: [`test/no-secrets.test.ts`](./test/no-secrets.test.ts)
fails if a backend credential or a hardcoded backend host is introduced into `src/`, and the
transport tests assert that with no endpoint configured, neither an event nor a prompt
produces a request.

## Reporting a problem

If Pheebs records something this document says it does not, treat it as a security issue and
follow [`SECURITY.md`](./SECURITY.md).
