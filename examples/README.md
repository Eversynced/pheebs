# Examples

Two things live here: a backend you can run, and rows a client actually produced.

## `backend-node/` — a Pheebs backend in one file

Implements all four required routes from [`../openapi.yaml`](../openapi.yaml) with no
dependencies, so you can point a real client at it and watch events land. The optional
`GET /insights` reports every section as `enabled: false` with a reason, which is what a backend
that computes none of them should say:

```bash
node examples/backend-node/server.js       # listens on :8787, writes pheebs-events.jsonl
pheebs config set base-url http://localhost:8787
pheebs config set token pheebs_local
```

Then use your agent normally. Events appear in the server's stdout and in `pheebs-events.jsonl`.

Two tokens are wired in, and the difference between them is the point:

| Token | `prompt_collection` | `/classify-prompt` behavior |
|---|---|---|
| `pheebs_local` | `false` | Refuses with `allowed: false`; the client records `unclassified` |
| `pheebs_local_consented` | `true` | Classifies and returns a label |

Switch between them to watch the consent gate work end to end.

**It is a teaching implementation.** Tokens are a hardcoded map, storage is a file, and there is
no authentication worth the name. Do not deploy it. What it does demonstrate correctly is the
handful of behaviors that are easy to get backwards — identity stamped from the token rather than
trusted from the client, an unknown token answered as a verdict rather than a 5xx, and consent
enforced server-side rather than assumed. [`../docs/backend-contract.md`](../docs/backend-contract.md)
explains why each of those matters.

Point the client back at nothing when you are done:

```bash
pheebs config unset base-url
```

## `events/` — the shape of a session

[`events/claude-code-session.jsonl`](./events/claude-code-session.jsonl) is 11 rows produced by
running the real client over a scripted session: session start, a repo scan, a prompt, a slash
command, a passing test run, a commit, a failed edit, a spawned reviewer sub-agent, a compaction,
and the turn and session ending.

The rows are genuine client output, not hand-written JSON — but the identifying fields were
replaced with synthetic values (`developer`, `codebase`, `session_id`, `agent_id`) and the
timestamps were rewritten to a fixed instant with spacing consistent with the durations the rows
report. Everything else is exactly as [`src/logger.ts`](../src/logger.ts) wrote it.

It is worth reading against what produced it. Two of those rows came from these commands:

```
npm test
git add -A && git commit -m secret message
```

and what they recorded was `tool_intent: "test_run"`, and `tool_intent: "vcs"` with
`vcs_action: "commit"`. Neither command string appears anywhere in the file. The prompt was
`add retry logic to the client`, and the row carries `prompt_length` plus
`prompt_intent: "unclassified"` — the degraded sentinel, because this session ran without
`prompt_collection` consent, not an example of a real label.

Use these rows as fixtures when building a backend: they are the real field shape, including
`permission_mode` and `effort`, which ride on every Claude Code hook event. (The `artifact_found`
row has neither — it comes from the repo scanner, not from a hook payload.)
