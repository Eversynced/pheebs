export const CODEBOOK_VERSION = "cb3";

// Pinned rather than the `haiku` alias, which a Claude Code update can move to another model
// without the classifier version saying so. A change here ships as a client release.
export const MODEL = "claude-haiku-5-5";

export const CODEBOOK = `You classify a single developer prompt to an AI coding agent into exactly one intent.

Assign exactly one label from this closed set:
- task: asks for new work (implement, build, fix, add, write).
- context: supplies information or constraints without asking for a change (facts about the codebase, requirements, preferences).
- direction: steers the approach or how to do the work (use pattern X, do it this way, prefer Y).
- pushback: challenges the output, asks for rationale, or points out an error the agent made.
- repair: reports that something is broken (a failure, a bug, wrong behavior).
- approval: accepts and moves on (lgtm, looks good, ship it, yes go).
- unclassified: out of set — greetings; bare thanks/acknowledgements that decide nothing; pasted content (logs, command output, stack traces) with no request or judgment attached; or anything that fits no class. Prefer unclassified over forcing a fit.

Tie-break for multi-intent prompts: pick the single dominant intent. Precedence when genuinely tied: repair > pushback > approval > direction > task > context.

Boundaries: a bare "thanks"/"ok"/"got it" is unclassified, not approval — approval accepts the agent's work ("lgtm", "ship it", "merge it"). Pasted logs or a stack trace with nothing asked or claimed around them are unclassified, not context or repair; they become context or repair only when the developer adds a statement or request around them.

Separately, set requests_verification true when the prompt asks for work to be checked against a reference — tests, build, lint, types, or requirements/PRD/spec/acceptance criteria. It is orthogonal to the label: assign the label as if the flag did not exist. Set it false otherwise.

Separately again, set task_scope to the size of the work the prompt asks for. It describes the work, never a model or a tier, and it is orthogonal to the label: assign the label as if this field did not exist.
- mechanical: a single-file change with an unambiguous spec. Nothing to decide.
- bounded: a fix or feature inside known code, with a clear way to tell it worked.
- cross_cutting: a multi-file change, a design decision, or debugging whose root cause is not yet known.
- open_ended: no clear finish line, or a wrong answer is expensive to discover.
- n/a: the prompt is not task or repair. Only these two intents name a size; every other label takes n/a.
When a prompt is too thin to place between two scopes, take the higher one.

Respond only via the structured output schema.`;

export const LABELS: readonly string[] = [
  "task",
  "context",
  "direction",
  "pushback",
  "repair",
  "approval",
  "unclassified",
];

export const TASK_SCOPES: readonly string[] = [
  "mechanical",
  "bounded",
  "cross_cutting",
  "open_ended",
  "n/a",
];

export const INTENT_SCHEMA = {
  type: "object",
  properties: {
    label: { type: "string", enum: LABELS },
    requests_verification: { type: "boolean" },
    task_scope: { type: "string", enum: TASK_SCOPES },
  },
  required: ["label", "requests_verification", "task_scope"],
  additionalProperties: false,
};

// A second, client-owned codebook for the prompt a model writes when it spawns a subagent. The
// developer-prompt codebook above cannot tell a review from a build, because both are `task`, so
// this one answers a different question: what kind of work was the subagent asked to do.
export const SUBAGENT_CODEBOOK_VERSION = "sb1";

export const SUBAGENT_CODEBOOK = `You classify a single prompt that one AI coding agent wrote to hand work to a sub-agent into exactly one kind of work.

Assign exactly one label from this closed set:
- review: asks the sub-agent to judge existing work (code, a diff, a design, a plan, tests, a migration) for correctness, security, risk or quality, and to report findings. Nothing is to be changed.
- build: asks the sub-agent to change something (implement, add, fix, refactor, write or update tests, migrate, rename, generate).
- research: asks the sub-agent to find or explain something (locate code, list callers, summarize how a thing works, look up a fact) without judging its quality and without changing anything.
- other: fits none of these, or the prompt is too thin to tell.

A prompt that asks for a review and also for the problems to be fixed is build. A prompt that mentions reviewing only as background to a change is build. Prefer other over forcing a fit; never choose review unless judging existing work is the whole request.

Respond only via the structured output schema.`;

export const SUBAGENT_LABELS: readonly string[] = ["review", "build", "research", "other"];

export const SUBAGENT_SCHEMA = {
  type: "object",
  properties: { label: { type: "string", enum: SUBAGENT_LABELS } },
  required: ["label"],
  additionalProperties: false,
};
