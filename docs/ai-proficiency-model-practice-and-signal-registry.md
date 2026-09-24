# AI Proficiency Model Practice and Signal Registry

**Last updated:** Sep 24, 2026

The source of truth for how well each practice and signal of the AI Proficiency Model is measured in the *current* version of Pheebs: the detector, per-harness availability, detector confidence, and implementation status. This is a living document: update it on **every release**.

- **Version measured:** `1.0.0` (released 2026-09-23; clients pick it up on their next auto-update check, so the scan types below fire per engineer from the moment their client upgrades)
- **Last reviewed:** 2026-09-23
- **Rubric being measured:** [AI Proficiency Model](ai-proficiency-model.md)

## Scope

Pheebs implements Layer 1 capture: hooks in Claude Code, Cursor, and Codex that emit generic
events, plus a repo scan for AI-config artifacts. Every practice in this registry marked Live has
a detector that ships in the client.

The Layer 2 signals are not implemented here. They are computed by a consumer from the same event
stream, and the fields they need are defined in the backend contract rather than produced by this
repo. A row's status describes the capture side only: it says the facts are emitted, not that
anything downstream reads them.

Re-verifying this registry against the released version is a pre-release step. It runs as part of
the final audit before a release ships, not after.

IDs are stable keys for dashboards, queries, and tickets. Prose and the model document use the names. Anchors come first in each table.

Every practice ships with:

- **Detector:** the exact event, scan field, or OTel expression that fires on it.
- **Harness availability:** whether the feature exists on Claude Code, Cursor, Codex. n/a cells leave the engineer's coverage denominator.
- **Detector confidence per harness:** 🟢 is deterministic. 🟡 has known false negatives.
- **Role:** one of `Anchor` (drives the competency's state), `Stat` (adds detail and counts toward coverage only), `Pattern` (a stat whose detector is an event sequence), or `Team stat` (aggregated org-wide, outside the coverage index) — as defined in the [model](ai-proficiency-model.md). A cell may add a short qualifier (e.g. `Anchor where applicable`, `Stat, feeds TS3`).
- **Status:** live (the detector fires today) or scanner (a new scan type is needed).

## Layer 1 practices

### Models (MD)

| ID | Practice | Detector | CC | Cursor | Codex | Role | Status |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| MD1 | Multi-model use, 2+ distinct models in window | `model_switched.from_model`/`to_model`, counting only `switch_source` in `command`/`picker`/`sdk` so a fallback or a resume restore is not read as a choice (CC) — only `command` has been observed emitted, the rest of that domain is vendor-documented but unobserved, so the filter is a precaution against behaviour we have not driven; `session_started.model` + OTel tokens-by-model (CC, Codex); per-event `model` field (Cursor, Codex) — see the [ledger](./spike-findings-ledger.md) | 🟢 | 🟢 selection-level | 🟢 | Anchor | Live |
| MD2 | Multi-harness use, 2+ `ai_tool` values | Every event carries `ai_tool` | 🟢 | 🟢 | 🟢 | Stat | Live |
| MD3 | Effort variation, 2+ distinct `effort` values | Per-event `effort` (CC); **preferred** on Cursor: `model_params` entries (`{id, value}`, ids `effort` and the undocumented `fast`) on `session_started` / `prompt_submitted` / `turn_ended`, **not** the tool events the vendor doc names; fallback where `model_params` is absent: the effort-suffixed slug on `session_started.model` | 🟢 | 🟢 via `model_params` on the **GUI**; **CLI emits none of it**, so the slug-suffix fallback is what a CLI session gives | n/a | Stat | Live |
| MD4 | Plan-mode use | `permission_mode = plan` segments | 🟢 | n/a to hooks today | n/a, `permission_mode` never reports `plan` | Stat | Live (CC only) |
| MD5 | Autonomy variation, 2+ distinct `permission_mode` values | Per-event `permission_mode` | 🟢 | n/a | n/a, value is constant per harness | Stat | Live (CC only) |
| MD6 | Split-phase delivery: plan-mode segment on one model or effort, then an execution segment on another, same session | `permission_mode` transitions joined with per-event `model` and OTel tokens-by-model | 🟢 | n/a | n/a, no `permission_mode` transitions occur | Pattern | Live, backend join (CC only) |

MD6 is the classic Opus-to-plan, Sonnet-to-execute pattern, expressed as a detector.

### Corrections from the 2026-09-09 Cursor/Codex payload capture

Six cells were changed because a real payload contradicted them — four in the Models table directly above, and CX1/CX2 in the Context management table further down. Each correction is
stated here rather than only edited into the table; the evidence is in
[`spike-findings-ledger.md`](./spike-findings-ledger.md) (entries dated 2026-09-09).

- **MD3 (Cursor)** was `🟢 once live`, on the vendor doc's claim that `preToolUse`/`postToolUse`
  carry `model_params`. **It is 🟢 and satisfied, and as of the 2026-09-11 GUI session the
  preferred detector is `model_params` after all, on events the doc does not name.** The sequence
  is worth keeping, because this cell was regraded four times in one day and each step was
  reasonable on its evidence. A Free-plan CLI capture found `model_params` absent and the cell went
  to `n/a`. A Pro CLI capture found it **still** absent at an explicit `xhigh` effort tier, which
  refuted the vendor doc on that surface and resolved the plan-tier caveat rather than sharpening
  it: **the plan tier was never the blocker**. The same capture found the effort tier arriving as a
  suffix on `session_started.model`, so the cell went to 🟢 on the slug. **The GUI session then
  found `model_params` itself**, with exactly the shape the doc gave (`{id, value}` entries) plus an
  undocumented `fast` id, carried on `sessionStart` / `beforeSubmitPrompt` / `stop` and **not** on
  the tool events the doc points at. `model_id`, the stripped slug, rides alongside `model` on the
  same payloads.
  **So the detector column now prefers `model_params` and keeps the slug suffix as a documented
  fallback.** `model_params` is the vendor's own structured field, and reading it beats parsing an
  unversioned slug format whose shape can drift (`-fast` variants exist alongside the tier
  suffixes). A consumer should read `model_params` where it is present and fall back to the suffix
  only where it is not.
  **The surface split is the caveat that must not be dropped: `model_params` is GUI-only on the
  evidence we have.** It is absent from CLI payloads even on Pro at an explicit effort tier, so a
  consumer must **not** assume it is present on every Cursor session; a headless fleet will have the
  slug and nothing else. That is also why the slug fallback stays documented rather than deleted.
  Pheebs still emits the **raw** slug and raw `model_params` and does not parse either into an
  effort tag, because the consumer decides what `-xhigh` or `{id: "fast"}` means.

- **MD4, MD5 and MD6 (Codex)** were each `🟢 once live`, on the assumption `permission_mode`
  varies with the session's mode. It does not. It is **constant per harness** — `bypassPermissions`
  under `codex exec`, `default` throughout an interactive TUI session, unchanged even after
  switching that session into Plan mode. So a Codex plan-mode segment cannot be detected (MD4),
  a distinct-value count counts harnesses rather than developer behaviour (MD5), and there are no
  transitions to join (MD6). All three are now `n/a` for Codex. Note the field **is** extracted on
  Codex from the release that follows this correction, on all five events that carry it — that is
  deliberate, and it is not a claim these three rows work. It is a raw fact captured at no cost, so
  that a future Codex build which makes the value vary is already being recorded rather than needing
  a client change first. Until such a build exists, these cells stay `n/a`. Caveat recorded in the
  ledger, and it is load-bearing here: the two halves of that evidence came from **different builds**.
  The `codex exec` half ran on the pinned codex-cli `0.136.0` and establishes only that the value is
  constant under that harness; the Plan-mode observation — the one that actually refutes the premise —
  came from a TUI reporting **v0.154.0**. Re-check the Plan-mode half against a pinned build before
  treating these three `n/a` cells as permanent.
- **CX1 (Codex)** was `🟢 unverified`. `PreCompact` and `PostCompact` were driven and both fire
  carrying `trigger`, so the hook half is settled; only `auto` was ever observed, so the cell is
  `🟡` rather than green until a manual compaction is captured.
- **CX2 (Codex)** was `🟢` for both `resume` and `clear`. `resume` is confirmed (and `compact`
  turned out to be a third value the doc lists but we did not expect to see). `clear` was driven
  in the TUI and fired **no** `SessionStart` at all, so that half of the cell is not met.

AR1's Cursor cell keeps its 🟢 presence-only grade, but its attachment detector has moved and the
wording is corrected rather than left standing. The earlier note here said `beforeSubmitPrompt`
never fired; **that was true of headless `cursor-agent -p` only.** The 2026-09-11 GUI session
showed it fires and carries `attachments`, one entry, keys `{file_path, type}`, `type: "rule"`,
from an `alwaysApply` rule in the fixture. What that single observation does **not** support is
counting: it was a **len-1 list with a rule alone in scope**, so a **mixed file-and-rule list is
untested** and the detector cannot yet claim attachment counts or tell the two types apart in the
wild. The cell therefore reads *not yet countable, observed once, GUI only* instead of *pending*,
and must not be read as a live attachment detector.

One caveat: Cursor reads model *selection*. Auto mode counts as one value, and the models auto routes to stay invisible there since Cursor has no OTel. CC and Codex catch actual usage through tokens-by-model.

### Artifacts (AR)

| ID | Practice | Detector | CC | Cursor | Codex | Role | Status |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| AR2 | Artifact invocation | `command_expanded` (CC); leading-slash `command_name` parsed from prompt text (Cursor); **not obtainable on Codex**, see below | 🟢 | 🟡 GUI only, no auto-invoke path | n/a, not observable | Anchor | Live |
| AR1 | Context file in repo (CLAUDE.md, AGENTS.md, rules) | Scan type `context_file` presence (`CLAUDE.md`, `AGENTS.md`, `.cursorrules`, `.cursor/rules/`, `.github/copilot-instructions.md`); CC `InstructionsLoaded` hook (`load_reason`, `memory_type`) fires on actual load; Cursor `rule`-type attachment counts not yet countable, see note | 🟢 present + loaded | 🟢 presence only | 🟢 presence only | Stat | Live (scan + CC hook); Cursor attachment detector observed once, GUI only |
| AR3 | Artifact breadth, distinct skills and commands invoked | Distinct `command_name` values | 🟢 | 🟡 inherits AR2 | n/a, inherits AR2 | Stat | Live |

AR3 is shown as a distribution. Arbitrary count cutoffs rarely survive calibration, so cohort data picks them later.

**AR2 and AR3 are 🟡 on Cursor and Codex because three different detectors share one field name,
`command_name`.** Claude Code fills it from structured vendor fields: `command_expanded` carries its own
`command_name` alongside `expansion_type` and `command_source` and fires only on a real expansion, and the
`Skill`-tool path reads `tool_input.skill` into the same field specifically to catch model-driven
auto-invoke. Cursor and Codex expose no such field, so the name is parsed out of the leading `/token` of
raw prompt text on `prompt_submitted`, with no allowlist, no validation, and no signal that an expansion
occurred. **Claude Code answers "was a command expanded, and which one". Cursor and Codex answer "did the
prompt text begin with a slash", and only the first is what AR2 claims to measure.** The **practice** is
not in doubt on either tool: `.cursor/commands/` and Codex's `.agents/skills` exist, and pheebs's own
scanner already detects them as `cursor_commands` and `codex_skills`. What differs is whether the detector
can **see** it, and on 2026-09-11 two probes settled that question and split the two tools apart.

**Cursor keeps 🟡, for two defects that survive the probes.** It is **structurally blind to non-GUI
sessions**: `beforeSubmitPrompt`, the only event that can carry the field, fired zero times across four
headless CLI runs that were each producing six to nine other event types, against three times in the GUI
run, so background and CLI Cursor sessions contribute no prompt event at all rather than merely no command.
And it has **no auto-invoke path**: anything invoked other than by a typed slash is invisible, which is
precisely the gap Claude Code's `Skill` capture exists to close. **Over-counting is possible in principle
on Cursor but has not been demonstrated there,** and must not be cited as though it had:
`readSlashCommandName` applies no allowlist, so any leading `/token` would parse, but no Cursor phantom has
actually been observed. An earlier version of this passage offered a typed `/compact` as that
demonstration. **That was wrong and is withdrawn:** `/compact` is a real Cursor command, it executed, and
it drove the manual compaction that settled CX1. The only live over-counting evidence we hold is the
Codex-under-`exec` case below.

**Production data cannot confirm or refute any of this, and should not be used to try.** Cursor holds 14
`prompt_submitted` events all-time and Codex 13, against Claude Code's 850 at roughly a 0.9% command rate.
Even a perfect detector would be expected to yield about 0.1 occurrences at those volumes, so the zero on
both tools is what an unexercised detector and a broken one look like alike. It distinguishes nothing.

**The open question that could have made these cells worse than 🟡 is now closed, and it split the two
tools.** It asked whether a *real* command reaches the hook as its literal name or already expanded into a
body whose first token is ordinary prose; the second would mean real commands yield nothing while phantoms
still register, so the detector would capture **only** false positives.

**Cursor answered it the good way: the hook fires before expansion.** A real user-defined command at
`.cursor/commands/pheebsprobe.md`, invoked as `/pheebsprobe` in the GUI, arrived in
`beforeSubmitPrompt.prompt` as the literal token, 12 characters, not the body. Both controls fired in the
same turn, so this is controlled rather than inferred: the model's reply carried the command-body marker,
proving the command really executed and its body reached the model, and it carried the `alwaysApply` rule
marker too. **Cursor expands the body for the model while the hook still sees the name**, which is the
ideal shape for AR2. Real Cursor commands are visible to the detector, and the worst case is refuted there.

**Codex answered it the other way, which is why its cells are `n/a, not observable` rather than 🟡.** On
the **TUI** an unrecognized `/token` is rejected client-side by the composer and never submitted, so the
hook does not fire at all and the `codex exec` phantom passthrough does **not** reproduce there. And a
**real skill is not slash-invoked on this build**: skills are catalogued to the model and `/` covers
built-ins only, so a genuine skill run arrives with a prose first token and yields no `command_name`. The
marker control fired, so "the prompt looked like prose" is not confounded with "the skill never ran". **Net:
a real Codex skill invocation can never produce `command_name` on either surface** — the TUI gives no
signal at all (real invisible, phantom blocked), and `codex exec` gives false positives only (real
invisible, phantom registers). AR3 and TS1 inherit it. Two honest limits on that result: only **skills**
were driven, so if 0.154.0 has a user-definable slash-invoked mechanism we did not find, it is untested;
and that hook payload carries **no version field**, so the build pin rests on `--version` agreeing with the
TUI banner rather than on the payload, which is the weaker of the two kinds of pin this file uses given
`--version` drifted twice on 2026-09-11.

**Why Codex is `n/a` and not simply a worse amber, stated in this file's own terms.** 🟡 means *known false
negatives*, which invites a consumer to count what does arrive and treat it as a partial signal. On Codex
that is affirmatively wrong: a real invocation produces nothing, and what `codex exec` does emit is only
phantoms, so counting the cell would count noise and report it as practice. There is no shade below 🟡 in
the legend and this is not the place to mint one, so the cell leaves the coverage denominator instead,
which is precisely what stops the noise being scored. **Be precise about what this `n/a` means, because it
is not the usual one.** The legend defines availability as whether the feature *exists* on the harness, and
this file has elsewhere argued that `n/a` claims the harness **cannot do** the thing. Codex can: the skills
are real and our own scanner detects them. What cannot happen is **observation**. That is a third state the
legend has no symbol for, and it is now sharing `n/a` with the other two, so the cells carry the words
`not observable` to keep a reader from reading it as "Codex has no skills". The legend gap is real and is
flagged here rather than forced.

**One consequence of that `n/a` belongs here rather than being discovered later: AR2 is the only Anchor in
Artifacts, so a Codex-only engineer now has no judgeable Artifacts anchor.** The competency reads
*Insufficient data* for them rather than Unobserved, which is the same handling Context management already
receives on a harness that cannot produce its anchors, and for the same reason: a cold Artifacts column
would invite a structural-gap reading of behaviour we are simply unable to see. AR1 and AR3 still count
toward coverage there, but neither drives the competency's state. If a later Codex build exposes a
slash-invoked command mechanism, or any hook that names an invoked skill, this becomes an extractor
question again rather than a permanent exclusion.

**No extractor change is available, and the tempting fix is forbidden.** The structured field does not
exist to read, so this is not a capture bug waiting on an extractor. In particular, **do not** build an
allowlist from the `cursor_commands` / `codex_skills` scan results: that would couple the event layer to a
scan result and bake our own interpretation into emission, which the schema rule forbids. Filtering to
commands that exist is a **consumer's** join, not ours.

A caveat on **AR1**'s discriminating power, to be checked against cohort data rather than assumed: a repo that has hosted any Claude Code session tends to acquire a `CLAUDE.md`, and all three repos measured during implementation carried one. With authorship deliberately dropped from the model, AR1 may settle near universal adoption and separate nobody. If the first full window confirms that, the practice is a floor check rather than a signal, and the interesting question moves to whether the context file is *loaded* — which is the pending CC `InstructionsLoaded` half of the detector.

Spawn events never feed Artifacts. A custom sub-agent definition is an artifact file, it shows in the scan and in the types-present stat, and its use is a spawn that counts in Orchestration. One event feeds one area.

### MCP (MC)

| ID | Practice | Detector | CC | Cursor | Codex | Role | Status |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| MC1 | MCP tool use | `mcp__` prefixed tool events, MCP exec hooks on Cursor | 🟢 | 🟢 | 🟢 | Anchor | Live |
| MC2 | Server breadth, 2+ distinct `mcp_server_name` | Normalized `mcp_server_name` | 🟢 | 🟢 | 🟢 | Stat | Live |

### Evals (EV)

| ID | Practice | Detector | CC | Cursor | Codex | Role | Status |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| EV1 | In-loop verification | `tool_intent` in {test_run, build, typecheck, lint} with pass/fail outcome | 🟡 keyword table | 🟡 | 🟡 | Anchor | Live |
| EV2 | Review pass | `role = review` sub-agent spawns | 🟡 table-only | 🟡 | 🟡 | Stat | Live |
| EV3 | Eval harness present | Scan `eval_harness` | 🟢 presence | 🟢 | 🟢 | Stat, feeds TS3 | Live |
| EV4 | Fix loop: failing `test_run`, then edit, then passing `test_run`, one session | Event sequence over `test_run` outcomes | 🟡 | 🟡 | 🟡 | Pattern | Live |
| EV5 | Test-gated ship: `test_run` shortly before `vcs_action` in {commit, push, pr_create}, same session | Event sequence over `test_run` + `vcs_action` | 🟡 | 🟡 | 🟡 | Pattern | Live |

EV1 stays 🟡 by nature: shell commands are an open world, so the keyword table undercounts newer and bespoke runners. It undercounts, it never fabricates, and Layer 2's verification coverage runs on the same intent table. The boundary in one sentence: **Layer 1 counts whether a practice occurs, Layer 2 rates the judgement behind what ships, on both the output and the input side.** Same events, different math.

### Context management (CX)

| ID | Practice | Detector | CC | Cursor | Codex | Role | Status |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| CX1 | Manual compaction | `context_compacted`, `trigger_type = manual` | 🟢 | 🟢 confirmed on the **GUI**, `trigger` carries `manual`; the CLI cannot drive a compaction at all | 🟡 hook fires and carries `trigger`, only `auto` observed | Anchor | Live |
| CX2 | Resume and clear lifecycle | `start_source` in {resume, clear} | 🟢 | n/a, no granularity | 🟡 `resume` confirmed, `clear` fires no event | Anchor where applicable | Live |
| CX4 | Auto vs manual compaction split | `trigger_type` ratio | 🟢 | 🟢 | 🟢 | Team stat | Live |

Sub-agent events feed Orchestration, not Context management. One event feeds one area. CX1 and CX2 were corrected on 2026-09-09; the correction is stated with the Models corrections near the top of this file.

**CX1 on Cursor is settled 🟢 as of 2026-09-11, and the question is closed.** A hand-driven compaction in the Cursor **GUI** fired `preCompact` carrying `trigger: "manual"`, so the payload does carry the value and the detector does work on that harness. This cell had a long argument attached to it, and the resolution is worth stating plainly so nobody re-opens it: every Cursor `context_compacted` event we held carried `trigger_type = auto`, 168 across 4 developers, and that was read as a contradiction needing an explanation. **It was a sampling artifact, not a contradiction.** Those 168 are production CLI and background traffic, where compaction genuinely is automatic, so they never had anything to say about the manual path; and headless `cursor-agent -p` exposes no way to drive a compaction, which is why only a GUI session could settle it. For comparison the same field on Claude Code gives 34 manual across 9 developers against 116 auto. No extractor change was needed: `extractCursorExtra` already maps `payload.trigger` onto `trigger_type` with no value allowlist.

**The earlier grading argument is retained because its reasoning was right even though its conclusion is now obsolete.** CX1 used to render as *Insufficient data* on Cursor rather than n/a, on the grounds that n/a claims the harness cannot do a thing while we had only 168 observations with no manual among them, and that only *we have not measured this yet* was true. That was the correct call on the evidence then, and the GUI run has now converted it into a plain 🟢 rather than proving it wrong. CX2 remains a genuine n/a on Cursor, since the harness reports no session origin at all, so the two Context anchors still carry deliberately different labels.

**A Cursor-only engineer now does have a judgeable Context management anchor**, which reverses the consequence this passage used to record. While CX1 was unverified the competency read *Insufficient data* for such an engineer rather than Unobserved, deliberately, so that a cold Context column could not invite a structural-gap reading of behaviour we simply could not see. That was the right handling of an open question and it is what kept the gap visible rather than freezing it into a permanent exclusion. The question is now answered on the GUI, so the anchor is live there. One scope limit travels with it: the manual trigger has been observed on the **GUI only**, because the CLI cannot produce a manual compaction, so a fleet of headless Cursor sessions will still show `auto` throughout and that is a true reading of those sessions rather than a gap.

One knock-on, and it is bigger than a footnote: **CX4, the team-wide compaction split, pools Cursor's auto-only feed into one ratio.** Cursor is currently the majority of those rows, so the split reads far more auto-heavy than Claude Code behaviour alone — close to even once Cursor is excluded. CX4 is a team stat outside the coverage index, but the ratio *is* its entire content, so a caveat under a wrong headline is not the same as a correct one. Slice it by harness or exclude Cursor before anyone argues from it.

**And a cell in the other direction — corrected 2026-09-09, after the verification this paragraph asked for.** This passage used to say CX1 and CX2 were both 🟢 on Codex with neither ever observed, that Codex had produced no `context_compacted` event at all and no `start_source` other than `startup`, and that both cells were deliberately left 🟢 pending a real payload. **All of that is now out of date, and the cells above are the current truth.** A live capture drove both: `PreCompact` and `PostCompact` fire on Codex and carry `trigger`, observed as `auto`; `start_source` carries `resume` and an undocumented `compact` as well as `startup`, while `clear` fires no `SessionStart` at all. So CX1 and CX2 are now 🟡 rather than 🟢, each with the half that is settled and the half that is not named inline. What the old paragraph got right is the mechanism: Codex takes the same payload-dependent path Cursor does (`definitions.codex.ts` registers `PreCompact` once and `handler.ts` reads `payload.trigger`) rather than Claude Code's twice-registered `matcher: auto` / `matcher: manual` with a pheebs-stamped `--trigger-type` — which is why `manual` remains the unproven half on Codex, exactly as it is on Cursor. Evidence: the 2026-09-09 Codex entry in [`spike-findings-ledger.md`](./spike-findings-ledger.md).

### Orchestration (OR)

| ID | Practice | Detector | CC | Cursor | Codex | Role | Status |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| OR1 | Sub-agent use | `subagent_spawned` | 🟢 | 🟢 | 🟢 | Anchor | Live |
| OR2 | Parallel execution | `tool_input.run_in_background` per tool call + `task_created` + `background_task_count` (CC), `is_parallel_worker` on `subagent_spawned` (Cursor) | 🟢 forward-only | 🟢 | n/a | Stat | Live |
| OR3 | Agent breadth, 2+ distinct non-built-in `agent_type` | `agent_type` ex known built-ins | 🟢 | 🟢 | 🟢 | Stat | Live |
| OR6 | Hooks configured beyond the Pheebs defaults | Scan type `hook_config`: project `.claude/settings.json`, `.claude/settings.local.json`, `.cursor/hooks.json` and `.codex/config.toml`, each counted only when it carries an entry naming a command that `isPheebsEntry` does not claim | 🟢 project-scoped | 🟢 project-scoped | 🟢 project-scoped, trust-gated | Stat | Live |
| OR7 | Plugin enabled | Scan type `plugin_enabled`: a project `.claude/settings.json` / `settings.local.json` `enabledPlugins` entry set to `true` | 🟡 project-scoped | n/a | n/a | Stat | Live |

Notes on OR6 and OR7. Pheebs only observes its own hook executions, never anyone else's, so *configured* rather than *fired* is the honest claim for OR6 — and it is the only claim the detector can make, since a filesystem scan sees a file, not an execution. Note the gap that phrasing used to paper over: **a configured hook is not necessarily a running one.** All three harnesses load the project file this detector reads, so a scan hit is real configuration on each. What the scan still cannot see is whether the hook **runs**: on Codex a project's hooks load only once the project is trusted, and every handler additionally needs a matching `trusted_hash`, so a file this detector counts may be configured and inert. That is the gap stated plainly rather than papered over, and it is why OR6 claims *configured* and stops there. Plugins bundle commands, agents, hooks, and MCP servers, and their contents already count where they're used (a plugin command invoked lands in AR2), so OR7 claims enablement only. One event feeds one area.

Both are **project-scoped**, and that is the honest limit on the claim rather than a footnote. The scanner never reads user-level config, so hooks in `~/.claude/settings.json`, `~/.cursor/hooks.json` or `~/.codex/config.toml`, and plugins enabled in `~/.claude/settings.json`, are invisible to it. A developer who only ever configures globally reads as having none.

That bites **OR7**, which is why it is 🟡 rather than 🟢: `enabledPlugins` in practice usually sits in the user-level file, so a developer with plugins enabled can still read Unobserved. **OR6 does not have OR7's problem, and a 2026-09-09 capture that appeared to show otherwise has since been refuted on both of its halves.** That capture reported that neither Codex nor Cursor reads a project-level hooks file, which would have meant working hook config could *only* sit at user level where the scanner never looks, and both cells were graded 🟡 on 2026-09-09 for that reason. Both halves fell: a three-run A/B showed Cursor does read `.cursor/hooks.json` and merges it with the user-level file, and Codex's own source showed a project layer that is read and hooks that are discovered from it. Both cells are 🟢 again as of 2026-09-11. The residual limit that remains is the ordinary project-scoped one, shared with Claude Code and already accepted under its 🟢: a developer who only ever configures hooks globally is invisible to the scan. Grading any of the three differently on that basis would be inconsistent rather than cautious.

A second, narrower gap in the same family: `pheebs init --project` writes to `<cwd>/.claude`, `<cwd>/.cursor` or `<cwd>/.codex`, while the scanner reads relative to the **git root**. Run the init from a subdirectory and the config it writes is real but invisible to the detector. Pre-existing for Claude and Cursor and now inherited by Codex, so it is a known blind spot rather than a regression.

For the record, an earlier draft of this row marked OR6 **n/a on Codex** on the grounds that Codex configures hooks only at user level, and a later correction overturned that by pointing at `codexPath(project=true)` resolving to `<cwd>/.codex/config.toml` and `removeToolHooks` uninstalling from it. **Corrected again 2026-09-09, and the second correction was reasoning from the wrong thing.** It argued from *our own path-resolution code* to a claim about *the vendor's behaviour* — the exact failure the findings ledger exists to prevent. **Corrected a third time on 2026-09-11, and this time by reading the vendor's source rather than inferring from behaviour.** Both halves of that capture are refuted: Codex does read `<cwd>/.codex/config.toml` and does discover hooks from it once the project is trusted, and Cursor does read `<cwd>/.cursor/hooks.json`. So the original note's conclusion, that project-level hook config is supported and detectable, was right after all, while the reasoning it was overturned with and the capture that overturned it were both wrong. Worth keeping visible: the second correction reached the right *shape* of objection, that our path-resolution code cannot testify about a vendor's behaviour, and then substituted a capture that could not testify either, because it could not distinguish an unsupported mechanism from a silently gated one. See the 2026-09-09 project-local entry, and its two correction bullets, in [`spike-findings-ledger.md`](./spike-findings-ledger.md).

**OR6's Codex cell is 🟢 project-scoped, trust-gated, as of 2026-09-11.** 🟢 means deterministic and 🟡 means known false negatives, and the question is whether the scan misses developers who are doing the practice. It does not: Codex reads a project `.codex/config.toml`, hook discovery pulls handlers from that layer, and the scanner reads the same file, so a developer configuring hooks at project scope is seen. The trust gate does not change that. It sits on a different axis, between *configured* and *running*, and OR6 already claims only the former: a developer who hand-writes hooks into a project `.codex/config.toml` is doing the practice whether or not they later trusted the directory. The cell carries `trust-gated` in its text so the limit travels with the grade, because on Codex there are now two ways a counted hook may never fire, an untrusted project and a handler without a matching `trusted_hash`. One inference a reader would otherwise draw is still false and worth naming: that **pheebs's own** `init --project --codex` produces a *running* install. It writes a file Codex reads, but pheebs does not write trust entries and should not.

**`hook_config` and `context_file` are revived names, not new ones, and history is not continuous.** A retired scanner generation already emitted `hook_config` (21 events, 2 developers, 2026-06-12 to 06-15, pheebs `0.5.0`-`0.6.0`) and `claude_md` (16 events, 1 developer, same window and versions) — `claude_md` being the narrower predecessor of `context_file`. Both stopped in June and the detectors were removed.

Two consequences. First, an all-time query on `artifact_type` returns a June cluster produced by a different implementation with different semantics — in particular the old `hook_config` predates the pheebs-entry exclusion, so those rows may be counting our own installed hooks and are **not comparable** to the new ones. Any historical read of OR6 must start from the current generation, not from first-ever. Second, anything deriving a detector's live date from the data needs a generation floor, or the June rows make the practice look mature immediately; the `pheebs-proficiency` panels implement exactly that floor.

`plugin_enabled` has no such history and starts clean.

## Team stats (TS)

| ID | Stat | Built from | Status |
| :-- | :-- | :-- | :-- |
| TS1 | Skill reuse breadth | AR2 events, backend group-by on `command_name` per distinct engineer | Backend group-by |
| TS6 | Sub-agent reuse breadth | `subagent_spawned` events, backend group-by on `agent_type` per distinct engineer | Backend group-by |
| TS4 | Connectors in use | MC1 events, canonical `mcp_server_name`, tool verb split into reads and writes | Live |
| TS5 | Artifact types present | Repo scan artifact types across observed repos | Live |
| TS2 | MCP-enabled repos in use | `mcp_config` scan + MC1 events | Live |
| TS3 | Eval harness in active use | EV3 + `eval_target` tag on `test_run` | Local tag needed |

Repo denominator: every event carries a codebase identifier, the scan runs on each engineer's clone and merges per codebase, and a repo enters the window's denominator when it has session activity. Pheebs never inventories the GitHub org, so a repo nobody works in doesn't exist to it.

## Layer 2 signals

Layer 2 is contract-only. This repo captures the facts; a backend computes the signals.

The contract carries the fields the five judgement signals need: `prompt_intent`,
`classifier_version` and `requests_verification` on a classified prompt, `task_scope` on the
classifier response, and the `judgement_signals` section of `/insights`. Their shapes are in
[`openapi.yaml`](../openapi.yaml), with the failure semantics in
[`backend-contract.md`](./backend-contract.md). Implementing them is the backend's job.

| Signal | Needs | Status |
| :-- | :-- | :-- |
| Verification coverage | `tool_intent` in {test_run, build, typecheck, lint} after an edit (the EV1 intent table), or `requests_verification` on a classified prompt | Contract-only. This repo captures the facts; a backend computes the rate. |
| Pushback rate | `prompt_intent` on classified prompts | Contract-only. This repo captures the facts; a backend computes the rate. |
| Refinement-to-repair ratio | `prompt_intent` on classified follow-up prompts | Contract-only. This repo captures the facts; a backend computes the ratio. |
| Wholesale-accept rate | `tool_intent = edit` events, `prompt_intent` and `requests_verification` on the session's prompts, and `lines_changed` on each edit as the weight | Contract-only for the rate. A backend computes detection and the lines-weighted metric, gated behind the classifier gate. Claude Code only. |
| Model-fit rate | `task_scope` on classified task and repair prompts (contract-specified beside `prompt_intent`); a scope-to-class map maintained by the backend; complete sessions only | Contract-only. This repo captures the facts; a backend computes the verdicts. |

Model-fit is judged only over **complete** sessions, where every task, repair, and unclassified
prompt carries a known scope, so an incomplete session leaves the denominator rather than
lowering the recommendation. The scope-to-class map is a backend judgement and never ships in
the client. The team-level cost rendering of the fit gap, priced from the `cost` section of
`/insights`, is a rendering of this signal, not a signal of its own; prices never enter the
model. The full definition is under [How model fit is judged](#how-model-fit-is-judged)
below.

The one capture-side piece is prompt classification: the client sends the prompt to the backend
`/classify-prompt` proxy when the tenant has consented, and stores the returned label. The prompt
text is never persisted by the client.

### How prompt intent is judged

**One label per prompt.** A prompt classifier labels each submitted prompt with exactly one
`prompt_intent` from a set of six.

| Intent | What the prompt does |
| :-- | :-- |
| `task` | Asks for new work. |
| `context` | Supplies information or constraints. |
| `direction` | Steers the approach. |
| `pushback` | Challenges output, asks for rationale, points out an error. |
| `repair` | Reports that something is broken. |
| `approval` | Accepts and moves on. |

A prompt that carries more than one move takes its dominant intent. A greeting, a pasted log,
a slash-command invocation already identified, or a bare question that fits no class is
`unclassified`.

The classifier also emits an orthogonal boolean, `requests_verification`, true when the prompt
asks for work to be checked against a reference. The reference is deliberately broad: tests,
build, lint, types, but also requirements, a PRD, a spec, acceptance criteria. Reviewing a
document against its initial requirements is the same habit applied to a non-executable artifact.
It is a flag because verification requests co-occur with the six moves rather than compete with them. "No, that's
wrong, run the tests again" is `repair` with the flag true; "looks good, run CI before we merge"
is `approval` with the flag true.

**The four output signals, composed from the labels.**

- *Verification coverage* needs no label. Its verification family is four tool intents, all
  detected from what actually ran: `test_run`, `build`, `typecheck`, and `lint`, rolled up at
  the metric layer and kept separate. The core read is edit-then-verify: of sessions containing
  AI edits, the share where an edit is followed by a verification action before the session ends.
  It counts whether the agent ran the check or the engineer asked for it.
- *Pushback rate* is the share of sessions with at least one `pushback` prompt, with the
  pushback share of all prompts as a secondary. It is reported at the session grain rather than
  as a percentage target because the healthy rate depends on the work, and engineers should
  never be performing skepticism to move a number.
- *Refinement-to-repair ratio* splits iteration in two. Refinement is `direction` and
  `pushback` prompts after a working state. Repair is `repair` prompts fixing a failure. A
  working state is a passing verification event, and pass or fail is the event type, not a
  judgement. Refinement depth is fluency. Repair depth is friction, and usually points at weak
  upfront context.
- *Wholesale-accept rate* is the joint absence of everything above: sessions where the AI
  produced edits and the session shows zero `pushback`, zero `repair`, zero verification, and
  ends in `approval` or silence. Every AI-edited session enters the denominator, and the
  headline is the share of AI-edited lines that landed in flagged sessions, weighted by
  `lines_changed`, with the plain session share as a secondary.

When prompt classification is disabled prompt intents are set as `unclassified`.

The classifier is revised: its prompt, its model, its execution backend, the class set, or the
flag definition. So `classifier_version` goes along with every label.

No signal derived from the labels surfaces before the classifier clears a validation gate.
The bar is macro F1 of at least 0.802 over the six classes. The flag is scored separately,
at 0.80 precision and recall, and a flag failure holds only the flag's consumers while the
six labels ship. A version bump re-runs the gate.

Nothing about the classifier changes what the engineer's agent does. The label is read after
the fact, off the same prompt event, and the prompt goes through whether or not the
classifier answered.

### How model fit is judged

**A scope label per prompt.** The same classifier that labels prompt intent also sizes task and
repair prompts with a `task_scope`. Scopes describe the work, never a model or a tier:

| Scope | What it describes |
| :-- | :-- |
| `mechanical` | A single-file change with an unambiguous spec. |
| `bounded` | A fix or feature inside known code, with a clear verification path. |
| `cross_cutting` | A multi-file change, a design decision, or unknown-root-cause debugging. |
| `open_ended` | No clear finish line, or an expensive wrong answer. |

Prompts of other intents carry `n/a`. A prompt too thin to place gets the higher plausible
scope.

**A decision per session.** The recommended class is the maximum scope over the session's task
and repair prompts — the session must handle its hardest prompt. A session gets a decision only
when it is **complete**: every task, repair, and unclassified prompt carries a known scope.
Incomplete sessions leave the denominator, the same way *Insufficient data* leaves the Layer 1
coverage denominator: a measurement gap is never reported as a behaviour.

**A class map.** Scope maps to model class through a table the backend maintains — a
published, versioned judgement, kept out of the client. One example map:

| Scope | Class | Model |
| :-- | :-- | :-- |
| `mechanical` | small | Haiku 4.5 |
| `bounded` | medium | Sonnet 5 |
| `cross_cutting` | large | Opus 5 |
| `open_ended` | frontier | Fable 5.1 |

**The decision, both ways.** A complete session is then one of three things: **fit** (the class
it ran matched the recommendation), **over-provisioned** (it ran above), or **under-powered**
(it ran below). Model-fit rate is the **fit** share.

**An audit, not a router.** Nothing about this signal changes which model runs. Pheebs does
not intercept prompts, does not route them, and does not switch models on anyone's behalf.
