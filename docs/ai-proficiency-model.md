# AI Proficiency Model

**Last updated:** Sep 20, 2026

> **Scope.** This repository is the capture client. It implements Layer 1: hooks that emit generic
> events from Claude Code, Cursor, and Codex, and a repo scan for AI-config artifacts. Layer 2 is
> not implemented here. Its signals are computed by a backend from the captured events, using
> fields defined in [`openapi.yaml`](../openapi.yaml) and
> [`backend-contract.md`](./backend-contract.md). Read the model below as what the facts are read
> as, not as a description of what this repo computes.

This document is the canonical source of truth for how Pheebs defines and measures AI proficiency. Proficiency has two dimensions:

- **Layer 1: AI harness repertoire.** Which harness capabilities are in play.
- **Layer 2: AI quality signals.** How well AI output gets verified, challenged, and refined before it ships.

Proficiency = repertoire + quality.

Both dimensions are measured by Pheebs from telemetry. How Pheebs detects proficiency under the hood (detectors), per-harness availability, and implementation status for everything below live in the [practice registry](ai-proficiency-model-practice-and-signal-registry.md).

---

# Layer 1: AI harness repertoire

Computed over a trailing 4-week window, using a shared event vocabulary across Claude Code, Cursor, and Codex, a repo artifact scan, and native OpenTelemetry.

## The unit: a practice

A practice is named and binary-detectable: its detector fired in the window or it didn't. Its role is *anchor* or *stat*. Each competency has just one anchor practice, and its state is funneled up as the competency's state. Stats add detail to a competency and count towards the coverage index. Unlike anchor practices, stat practices don't move the competency's state. A *pattern* is a stat whose detector is an event sequence.

## States

Each practice, per engineer, sits in exactly one state over the trailing window:

| State | Definition |
| :-- | :-- |
| **Unobserved** | Detector never fired in the window. |
| **Adopted** | Detector fired at least once in the window. |
| **Recurring** | Detector fired in at least 3 of the last 4 active weeks. |

The three states above are claims about the **engineer**. Two further readings are claims about our **measurement**, and they are not states an engineer can be placed in:

| Reading | Meaning |
| :-- | :-- |
| **n/a** | The harness cannot do the thing, or cannot report it. We will not measure this here. The practice leaves the engineer's coverage denominator. |
| **Insufficient data** | We cannot yet judge the practice for this engineer. It leaves the coverage denominator until we can. |

The two differ in what they claim about the future, and the difference is worth keeping. *n/a* is settled: no amount of waiting changes it. *Insufficient data* is open, and names something we could go and fix. So a practice we have simply never established on a harness reads Insufficient data, not n/a — **unverified is not the same as unsupported**, and choosing n/a on absent evidence quietly writes the practice off for every engineer on that harness.

Never report a measurement gap as Unobserved. Unobserved says the engineer did not do the thing; if the detector could not have seen it, that sentence is false, and the model exists to make behaviour legible rather than to manufacture a verdict. The conditions that produce *Insufficient data* are listed under [Windows and placement](#windows-and-placement).

A competency inherits the state of its anchor practice. Anchors are the core practices of a competency; most are available and detectable on all three harnesses, and the ones that are not are marked *anchor where applicable*. Harness-specific practices feed the coverage index only. A competency with **no judgeable anchor on the engineer's harness mix** reads Insufficient data: the harness gives us nothing to judge it by, which is a statement about our reach and not about the engineer. An anchor sets the competency's state only while it is both applicable and judgeable.

## Scope

A practice states an AI harness capability was invoked, is configured, or recurs.

## Competencies and their practices

Twenty-four practices across the six competencies. Anchors come first in each competency table. Across all practices:
- Twenty-three are per-engineer practices.
- One is a team stat: the session context compaction split.
- Three of the twenty-three per-engineer practices are patterns (composite event sequences): split-phase delivery, fix loop, test-gated ship.

### Models

Which AI models are run for a task: the models, effort settings, and autonomy modes (plan mode, permission settings) in play.

| Practice | What it states |
| :-- | :-- |
| Multi-model use (anchor) | 2+ distinct models in the window |
| Multi-harness use | 2+ AI harnesses in the window |
| Effort variation | 2+ distinct effort settings in the window |
| Plan-mode use | Plan-mode segments in sessions |
| Autonomy variation | 2+ distinct permission modes in the window |
| Split-phase delivery (pattern) | A plan segment on one model or effort, then an execution segment on another, same session |

### Artifacts

The reusable AI-config files that shape how the agent works: skills (`SKILL.md`), sub-agent definitions, slash commands, `CLAUDE.md`/`AGENTS.md`, rules files, saved prompt templates.

| Practice | What it states |
| :-- | :-- |
| Artifact invocation (anchor) | A skill or slash command was invoked |
| Context file in repo | A CLAUDE.md, AGENTS.md, or rules file exists in the repo and gets loaded |
| Artifact breadth | Distinct skills and commands invoked |

### MCP

[Model Context Protocol](https://modelcontextprotocol.io) servers that give the agent live access to external systems (tickets, databases, browsers, designs, documentation).

| Practice | What it states |
| :-- | :-- |
| MCP tool use (anchor) | Tool calls to an MCP server |
| Server breadth | 2+ distinct MCP servers in use |

### Evals

The verification machinery wired into the agent loop: test runs, typecheck, lint, build, second-pass review agents, eval harnesses.

| Practice | What it states |
| :-- | :-- |
| In-loop verification (anchor) | The agent loop runs tests, typecheck, lint, or build, with pass and fail outcomes |
| Review pass | A review sub-agent runs over the work |
| Eval harness present | An eval harness exists in the repo |
| Fix loop (pattern) | A failing test run, an edit, then a passing test run in one session |
| Test-gated ship (pattern) | A test run shortly before a commit, push, or PR in the same session |

### Context management

The context-window features in use: compaction, and the save, resume, and clear lifecycle.

| Practice | What it states |
| :-- | :-- |
| Manual compaction (anchor where applicable) | The engineer compacts the context window by hand |
| Resume and clear lifecycle (anchor where applicable) | Sessions started via resume or clear |
| Compaction split (team stat) | The auto vs manual compaction ratio |

Both anchors here are harness-limited, so on a harness that reports neither manual compaction nor session origin the competency reads Insufficient data. Context management is no longer the only competency that can lose its anchor this way: Artifacts rests on a single anchor, and as of 2026-09-11 that anchor is unobservable on Codex. The registry records which harness each gap applies to, and which gaps are settled rather than merely unverified.

### Orchestration

Coordinating more than one agent or session: sub-agents for parallel or isolated work, git worktrees, multi-stage pipelines, hooks and plugins that extend the loop.

| Practice | What it states |
| :-- | :-- |
| Sub-agent use (anchor) | A sub-agent was spawned |
| Parallel execution | Background tasks or parallel workers in use |
| Agent breadth | 2+ distinct custom agent types in use |
| Hooks configured | Lifecycle hooks configured beyond the Pheebs defaults |
| Plugin enabled | A plugin is enabled |

## Windows and placement

- **Window:** trailing 4 weeks.
- **Active week:** at least one session in any instrumented harness.
- **Placement requires at least 2 active weeks in the window.** Below that the engineer shows as *Insufficient data*, a distinct state from Unobserved.
- **A practice is only judged once its detector has been observable for a full window.** Until then it reads *Insufficient data* and leaves the coverage-index denominator.
  - *Observable* is defined **per engineer, by the client version they run** — not by when the detector shipped. An engineer running a client that predates the detector cannot emit it, so judging them on it would be a claim about their behaviour drawn from a limitation of ours. An engineer who upgraded last week has been observable for one week, whatever the release date says.
  - The window is the same trailing 4 weeks used everywhere else, counted in calendar weeks since the engineer's first event on a qualifying version. That is deliberately not the *active*-week count behind the 3-of-4 Recurring rule: one measures how long we have been able to look, the other how often the engineer showed up.
  - Consequence, and the reason the rule exists: the coverage index never moves because our measurement changed. A new detector cannot reach Recurring for its first three weeks by construction, so without this rule shipping one would lower every engineer's index on release day with nothing behavioural behind it — the trend line falling precisely when Pheebs improves.
- **A state is held, not awarded.** Placement moves in both directions as the window trails.
- **Weeks with no sessions don't count.** Recurring is judged over active weeks only.

*Insufficient data* is therefore produced by four conditions, all of them statements about the measurement:

1. fewer than 2 active weeks in the window;
2. a detector not yet observable to the engineer for a full window;
3. a practice whose support on the engineer's harness has not been established — the detector exists there but has never produced the value the practice needs;
4. a competency with no judgeable anchor on the engineer's harness mix, whether its anchors are n/a or unverified.

## Engineer view

### The coverage index

Per engineer: the share of applicable practices at Recurring. *Applicable* means the feature exists on the engineer's harness mix. Team stats (the compaction split) sit outside the index.

An engineer on more than one harness still gets one index. States pool practices across the harnesses so a practice recurring in the harness mix is counted as met.

Example:

```
Pam works in Claude Code only, with 4 active weeks in the window:

Competency           State       % recurring
---------------------------------------------
Models               Recurring     33%
Artifacts            Recurring     33%
MCP                  Recurring     100%
Evals                Recurring     60%
Context management   Recurring     50%
Orchestration        Adopted       0%


Coverage index: 9 / 23 = 39%
█████████░░░░░░░░░░░░░░
```

The competency states are the profile, the index is the trend line.

## Team view

The team reads three ways.

### Practice adoption funnel

**Goal:** show how deep adoption runs, past just a usage count. Which competencies stuck and which got sampled once? Where the team stalls between adopting and recurring? What to push next?

One stacked bar per practice: Unobserved, Adopted, Recurring, sorted by recurring share. The right edge is the read: how many of the team a practice actually recurs for.

Example:

```
Team Dunder Mifflin

Models                ░░▒▒█████    56% recurring
Artifacts             ░░▒▒▒▒███    33% recurring
MCP                   ░░░▒▒▒▒██    22% recurring
Context management    ░░░░▒▒▒██    22% recurring
Orchestration         ░░░▒▒▒▒██    22% recurring
Evals                 ░░░░░▒▒▒█    11% recurring

░ unobserved · ▒ adopted · █ recurring
```

### Practice heatmap

**Goal:** locate gaps and be intentional about how to fix them. Is a gap shared or individual? Does the fix ship as structural/scaffolding or as coaching/pairing? Who is already strong and can demo to the rest?

One heatmap per team: engineers as rows, competencies as columns, cells colored by state. Column and row patterns carry the diagnosis. A cold column means the environment lacks scaffolding and the fix is structural. A cold row means a coaching conversation. Scattered gaps mean pairing and internal demos.

Example:

```
Team Dunder Mifflin
 
         Models  Artifacts  MCP  Evals  Context  Orchestration
Michael     █        █       █     ▒       █       █
Dwight      █        ▒       ▒     ░       ░       ░
Jim         █        █       █     ▒       ▒       ▒
Pam         ░        ▒       ▒     ░       ░       ▒
Angela      █        ░       ░     ░       ░       ░
Andy        ░        ▒       ▒     ▒       ▒       ▒
Kevin       ▒        ░       ░     ░       ░       ░
Stanley     █        █       ▒     █       █       █
Phyllis     ▒        ▒       ░     ░       ▒       ▒

Cold column (Evals): the fix is structural. Ship the eval harness and a test-gate rule in CLAUDE.md.

Cold row (Kevin): a coaching conversation. The environment is there, so pairing closes the gap.
```

### Team stats

**Goal:** verify tooling investment spread. Which artifacts earned voluntary reuse. Which repos have active scaffolding. These are the receipts for enablement work: ship a skill, watch reuse breadth move next window.

Six team stats aggregate practice detectors org-wide. They involve no per-engineer attribution. Artifacts, connectors, and repos are the rows:

| Stat | Definition |
| :-- | :-- |
| Skill reuse breadth | Share of engineers invoking each skill or slash command per window |
| Sub-agent reuse breadth | Share of engineers spawning each sub-agent per window |
| Connectors in use | Connectors used in the window, share of engineers on each, reads and writes split |
| Artifact types present | Share of repos containing each AI-config artifact type |
| MCP-enabled repos in use | Repos with MCP configured and traffic from 2+ engineers |
| Eval harness in active use | Repos with an eval harness present and exercised in the window |

Example:

```
Team Dunder Mifflin

Skill reuse breadth, share of engineers invoking each
 
/review           ████████  78%
/release-notes    ██████    56%
pr-describe       ████      44%
db-migrate        ██        22%
 
Sub-agent reuse breadth, share of engineers spawning each
 
code-reviewer     ██████    56%
db-migrator       ███       33%
docs-writer       ██        22%
 
Connectors in use, share of engineers using each
 
Linear (r/w)      ███████   67%
GitHub (r/w)      ██████    56%
Postgres (r)      ███       33%
Sentry (r)        ██        22%
 
Artifact types present, share of repos containing each type
 
Skills            █████████ 86%
Slash commands    ███████   71%
MCP config        ███████   71%
Context files     ██████    57%
Eval harness      ████      43%
Sub-agents        ███       29%
 
MCP-enabled repos in use      ████░░░  57%
Eval harness in active use    ██░░░░░  29%
```

---

# Layer 2: AI quality signals

Layer 2 measures what happens to AI output before it ships: whether it gets verified, challenged, and refined. The signals are continuous rates and ratios computed from session telemetry by Pheebs' Layer 2 pipeline. Signals are computed from the event stream and a prompt classifier. Prompt text is never stored. Signals move in both directions, and there are no levels or rankings.

## The signals

| Signal | What it measures |
| :-- | :-- |
| **Verification coverage** | The share of AI edits followed by a verification action: a test run, typecheck, lint, or build, or a verification-intent prompt that checks work against a reference (tests, but also a PRD, a spec, acceptance criteria). |
| **Pushback rate** | How often the engineer challenges or questions AI output rather than accepting it. Questioning collapses precisely when output looks polished, so low pushback on large changes is a risk signal. |
| **Refinement-to-repair ratio** | Whether follow-up prompts refine intent (healthy iteration) or repair breakage (rework). |
| **Wholesale-accept rate** | Large changes accepted with no verification and no pushback, weighted by change size. The composite red flag: the polished-output, no-questions-asked pattern. |

## Engineer view

One panel: current rates, the trend per signal, and a large-change lens.

**Rates.** The four signals over the trailing window, next to the team median.

**Trend.** Weekly values per signal. Trends plot whatever history exists, so a 4-week deployment shows a 4-week trend.

**Large changes.** The size-sensitive signals recomputed over large changes only, where verification and pushback collapse the most. The flagged list lives here: the engineer's own large changes that cleared with no verification and no pushback, with repo, files, and size.

Example:

```
Pam, trailing 4 weeks

Signal                       Pam       Team median
---------------------------------------------------
Verification coverage        62%       48%
Pushback rate                 9%       14%
Refinement-to-repair ratio   2.1 : 1   1.4 : 1
Wholesale-accept rate         6%        4%

Trend, weekly

Verification coverage        44%  ▁▂▂▃▄▅▆▇  62%
Pushback rate                 7%  ▃▂▃▄▃▃▄▄   9%
Refinement-to-repair ratio   1.6  ▄▅▄▅▆▆▇▇  2.1
Wholesale-accept rate         9%  ▇▆▆▅▄▄▃▃   6%

Large changes only

Verification coverage        41%   (62% overall)
Pushback rate                 4%   ( 9% overall)
Wholesale-accept rate        11%   ( 6% overall)

Flagged, this window

api-core    3 files   +388 -12    Tue 14:02
api-core    2 files   +251 -0     Thu 10:17


Pam verifies more than the team and her iteration skews
healthily to refinement, with both trends improving. The gap is
concentrated in large changes, where her verification drops and her
wholesale accepts double.
```

## Team view

The team reads three ways.

### Signals by engineer
 
**Goal:** identify weak signals, same read as the Layer 1 Practice heatmap. Engineers as rows, signals as columns, team median as the last row. A weak signal for one engineer is a coaching conversation. A weak signal across the team is structural, and the fix ships in Layer 1 terms. The strongest cell in a column is who demos.
 
Example:
 
```
Team Dunder Mifflin, trailing 4 weeks
 
           Verification  Pushback  Refine:repair  Wholesale
Michael        71%         22%       2.4 : 1         2%
Dwight         31%          6%       0.8 : 1        11%
Jim            55%         17%       1.6 : 1         3%
Pam            62%          9%       2.1 : 1         6%
Angela         48%         14%       1.4 : 1         4%
Andy           42%         12%       1.2 : 1         5%
Kevin          26%          4%       0.7 : 1        14%
Stanley        74%         19%       2.6 : 1         1%
Phyllis        39%         15%       1.3 : 1         4%
-----------------------------------------------------------
Team median    48%         14%       1.4 : 1         4%
 
Kevin trails the median on all four: a coaching conversation.
Stanley leads on all four: he demos.

Weak column (Pushback): even the top of the column questions
one output in five. Structural. Wire questioning into the loop: a review
sub-agent and a critique command.
```
 
### Median movement
 
**Goal:** the engineer trend, computed on the team median. Structural fixes ship in Layer 1 terms and the median says whether they had a positive impact.

Example:

```
Team Dunder Mifflin, median, weekly

Verification coverage    41%  ▂▃▃▄▅▅▆▆  48%   eval harness shipped w3
Pushback rate            14%  ▄▄▄▄▄▄▄▄  14%
Refinement-to-repair     1.2  ▃▄▄▄▅▅▅▅  1.4
Wholesale-accept          7%  ▅▅▅▄▄▄▃▃   4%
```

### Wholesale watch

**Goal:** track wholesale-accept at the team grain: the count, the trend, and the repos it concentrates in. The item list is personal. Each engineer sees their own flagged changes in their panel, and a lead reaches an instance through the engineer, same as any code review.

Example:

```
Team Dunder Mifflin

Large changes with no verification and no pushback

This window    ███░░░░░░░   7 of 52  (13%)
Last window    █████░░░░░  11 of 49  (22%)

By repo, this window

api-core    ████   4
billing     ██     2
web-app     █      1
```
