import { execFileSync } from "node:child_process";
import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { detectCodebaseId, type PheebsConfig, resolveLogPath } from "./config.js";
import { getDeveloperHandle } from "./developer-id.js";
import { type AiTool, EVENTS, isPheebsEntry } from "./hooks/definitions.js";
import { appendLogEntry } from "./logger.js";
import { PHEEBS_VERSION } from "./version.js";

// Directories never worth walking when looking for nested artifacts. The
// tool dirs (.claude/.cursor/.codex/.agents) are excluded here because their
// artifacts are detected by the fixed-location checks below.
const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".claude",
  ".cursor",
  ".codex",
  ".agents",
  "dist",
  "build",
  ".next",
  "out",
  "coverage",
  "vendor",
  "target",
  ".venv",
  "venv",
  "__pycache__",
]);

const MAX_WALK_DEPTH = 5;

export type ArtifactType =
  | "claude_agents"
  | "claude_skills"
  | "codex_skills"
  | "cursor_commands"
  | "mcp_config"
  | "eval_harness"
  | "context_file"
  | "hook_config"
  | "plugin_enabled";

const SCAN_SESSION_ID = "scan";

function tryGit(...args: string[]): string | null {
  try {
    const out = execFileSync("git", args, { stdio: ["pipe", "pipe", "ignore"] })
      .toString()
      .trim();
    return out || null;
  } catch {
    return null;
  }
}

// `root` is null when not inside a git work tree. Codebase id resolution is
// shared with the hook path via detectCodebaseId, so artifact_found events carry
// the same codebase label as the rest of a session.
function resolveRepo(): { root: string | null; codebaseId: string } {
  const root = tryGit("rev-parse", "--show-toplevel");
  return { root, codebaseId: detectCodebaseId() };
}

export function bucketFor(mtimeMs: number, nowMs: number): string {
  const days = (nowMs - mtimeMs) / 86_400_000;
  if (days < 1) return "today";
  if (days < 7) return "this_week";
  if (days < 30) return "this_month";
  if (days < 90) return "this_quarter";
  return "older";
}

function fileMtime(p: string): number | null {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

function boundedWalk(root: string, onFile: (name: string, fullPath: string) => void): void {
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (stack.length) {
    const next = stack.pop();
    if (!next) break;
    const { dir, depth } = next;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (depth + 1 >= MAX_WALK_DEPTH || IGNORED_DIRS.has(entry.name)) continue;
        stack.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
      } else if (entry.isFile()) {
        onFile(entry.name, path.join(dir, entry.name));
      }
    }
  }
}

function childDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

function maxOf(values: number[]): number {
  return values.reduce((a, b) => (b > a ? b : a));
}

// --- Eval harness detection -------------------------------------------------
// Detected by name / path / presence only — the scanner never opens a file's
// contents. Every pattern lives in the single EVAL_RULES config below, so new
// eval conventions are easy to add without touching the traversal logic. Of the
// defaults, only promptfoo's config file and Claude's .claude/skills/ layout are
// external standards; the evals/ + rubric.md + cases/ layout is our own
// convention — so treat these as a seeded, extensible rule set, not fixed truth.

interface EvalRules {
  // A directory with one of these names is an eval set when every hallmark
  // child is present (checked by name/presence, never by reading contents).
  setDirNames: string[];
  setHallmarks: string[];
  filePatterns: RegExp[];
  // A skill/command dir whose name matches is eval-oriented. Token-bounded, so
  // `my-eval-runner` matches but `retrieval` does not — a generic pattern, never
  // a literal product name.
  namePattern: RegExp;
  // Tool-dir locations (relative to the repo root) to check for eval-named
  // artifacts and co-located eval sets; the repo-wide walk ignores these dirs.
  skillContainers: string[];
  commandContainers: string[];
}

const EVAL_RULES: EvalRules = {
  setDirNames: ["evals", "eval"],
  setHallmarks: ["rubric.md", "cases"],
  filePatterns: [
    // promptfoo auto-loads promptfooconfig.* (no leading dot; a dotted variant
    // is also seen), so match both.
    /^\.?promptfooconfig\.(ya?ml|json|jsonc|[cm]?js|ts)$/,
    // *.eval.{ts,js,py} — a loose, test-file-style naming convention.
    /\.eval\.(ts|js|py)$/,
  ],
  namePattern: /(^|[-_])evals?([-_]|$)/i,
  skillContainers: [".claude/skills", ".agents/skills"],
  commandContainers: [".cursor/commands"],
};

const EVAL_DIR_NAME_SET = new Set(EVAL_RULES.setDirNames);

function looksLikeEvalSet(dir: string): boolean {
  return EVAL_RULES.setHallmarks.every((child) => existsSync(path.join(dir, child)));
}

function matchesEvalFile(name: string): boolean {
  return EVAL_RULES.filePatterns.some((re) => re.test(name));
}

function childEntries(dir: string): Array<{ name: string; full: string }> {
  try {
    return readdirSync(dir, { withFileTypes: true }).map((entry) => ({
      name: entry.name,
      full: path.join(dir, entry.name),
    }));
  } catch {
    return [];
  }
}

// Repo-wide bounded walk collecting eval-set directories and eval config / test
// files. Respects IGNORED_DIRS, so it never descends into the tool dirs
// (.claude/.agents/…) — eval sets co-located inside skills there are found by
// collectEvalPathsFixed instead.
function collectEvalPathsByWalk(root: string): string[] {
  const found: string[] = [];
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (stack.length) {
    const next = stack.pop();
    if (!next) break;
    const { dir, depth } = next;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (EVAL_DIR_NAME_SET.has(entry.name) && looksLikeEvalSet(full)) {
          found.push(full);
          continue; // a recognized eval set is a leaf signal; don't descend
        }
        if (depth + 1 >= MAX_WALK_DEPTH || IGNORED_DIRS.has(entry.name)) continue;
        stack.push({ dir: full, depth: depth + 1 });
      } else if (entry.isFile() && matchesEvalFile(entry.name)) {
        found.push(full);
      }
    }
  }
  return found;
}

// Eval signals inside the ignored tool dirs, reached by fixed-location checks:
// an eval-oriented skill/command by name, and an eval set co-located inside a
// skill (e.g. .claude/skills/<skill>/evals/).
function collectEvalPathsFixed(root: string): string[] {
  const found: string[] = [];
  for (const container of EVAL_RULES.skillContainers) {
    for (const skillDir of childDirs(path.join(root, container))) {
      if (EVAL_RULES.namePattern.test(path.basename(skillDir))) found.push(skillDir);
      for (const name of EVAL_RULES.setDirNames) {
        const evalDir = path.join(skillDir, name);
        if (looksLikeEvalSet(evalDir)) found.push(evalDir);
      }
    }
  }
  for (const container of EVAL_RULES.commandContainers) {
    for (const cmd of childEntries(path.join(root, container))) {
      if (EVAL_RULES.namePattern.test(cmd.name)) found.push(cmd.full);
    }
  }
  return found;
}

function collectEvalHarnessPaths(root: string): string[] {
  return [...new Set([...collectEvalPathsByWalk(root), ...collectEvalPathsFixed(root)])];
}

// Context files live at fixed, well-known names. Nested per-package files are not
// collected: the practice is whether the repo carries written context at all, and
// walking the whole tree for one filename would cost far more than that claim is worth.
const CONTEXT_FILE_PATHS = [
  "CLAUDE.md",
  "AGENTS.md",
  ".cursorrules",
  path.join(".github", "copilot-instructions.md"),
];

// Plugins are a Claude Code feature, so only its settings files can carry them.
const CLAUDE_SETTINGS_PATHS = [
  path.join(".claude", "settings.json"),
  path.join(".claude", "settings.local.json"),
];

// Project-scoped only, for every harness — the scanner never reads user-level config,
// so hooks configured in ~/.claude, ~/.cursor or ~/.codex are invisible here by design.
// That is a real limit on the claim: a developer who only ever configures hooks globally
// reads as having none.
const HOOK_CONFIG_PATHS = [
  ...CLAUDE_SETTINGS_PATHS,
  path.join(".cursor", "hooks.json"),
  path.join(".codex", "config.toml"),
];

// Contents are parsed in-process to answer one boolean and are never persisted, the
// same bargain intent classification makes with raw shell commands.
function readConfigObject(p: string): Record<string, unknown> | null {
  try {
    const raw = readFileSync(p, "utf-8");
    const parsed: unknown = p.endsWith(".toml") ? parseToml(raw) : JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

// An entry that names no command configures nothing: a matcher block whose command was
// deleted, or an empty stub left by a settings editor, must not count as a configured
// hook. Both harness shapes carry the command in a different place.
function namesACommand(entry: Record<string, unknown>): boolean {
  if (typeof entry.command === "string" && entry.command.trim() !== "") return true;
  if (!Array.isArray(entry.hooks)) return false;
  return entry.hooks.some((inner) => {
    if (typeof inner !== "object" || inner === null) return false;
    const command = (inner as Record<string, unknown>).command;
    return typeof command === "string" && command.trim() !== "";
  });
}

// Presence of a config file proves nothing: `pheebs init` writes hooks into it, so a
// file carrying only our own entries would make every instrumented repo report the
// practice. Only a real hook that pheebs did not install counts.
function hasHumanHooks(config: Record<string, unknown> | null): boolean {
  const hooks = config?.hooks;
  if (typeof hooks !== "object" || hooks === null) return false;
  return Object.values(hooks as Record<string, unknown>).some(
    (entries) =>
      Array.isArray(entries) &&
      entries.some(
        (entry) =>
          typeof entry === "object" &&
          entry !== null &&
          !Array.isArray(entry) &&
          !isPheebsEntry(entry) &&
          namesACommand(entry as Record<string, unknown>),
      ),
  );
}

// A plugin listed but switched off is not the practice, so the value has to be exactly
// true — a truthy string or object is a shape we do not understand, not an enablement.
function hasEnabledPlugin(config: Record<string, unknown> | null): boolean {
  const enabled = config?.enabledPlugins;
  if (typeof enabled !== "object" || enabled === null) return false;
  return Object.values(enabled as Record<string, unknown>).some((value) => value === true);
}

// Candidate paths are resolved to mtimes here and then dropped: one mtime per existing
// file is all the scan needs, and file paths must not leave the machine.
interface ScannedArtifact {
  artifact_type: ArtifactType;
  mtimes: number[];
}

export function collectArtifacts(root: string): ScannedArtifact[] {
  const out: ScannedArtifact[] = [];
  const add = (artifact_type: ArtifactType, candidatePaths: string[]): void => {
    const mtimes: number[] = [];
    for (const p of candidatePaths) {
      const mtime = fileMtime(p);
      if (mtime !== null) mtimes.push(mtime);
    }
    if (mtimes.length) out.push({ artifact_type, mtimes });
  };

  const agentDefPaths: string[] = [];
  boundedWalk(path.join(root, ".claude", "agents"), (_name, full) => agentDefPaths.push(full));
  add("claude_agents", agentDefPaths);

  add("claude_skills", childDirs(path.join(root, ".claude", "skills")));
  add("codex_skills", childDirs(path.join(root, ".agents", "skills")));

  const cursorCmdPaths: string[] = [];
  boundedWalk(path.join(root, ".cursor", "commands"), (_name, full) => cursorCmdPaths.push(full));
  add("cursor_commands", cursorCmdPaths);

  add("mcp_config", [
    path.join(root, ".mcp.json"),
    path.join(root, ".cursor", "mcp.json"),
    path.join(root, ".vscode", "mcp.json"),
  ]);

  add("eval_harness", collectEvalHarnessPaths(root));

  const contextFilePaths = CONTEXT_FILE_PATHS.map((rel) => path.join(root, rel));
  boundedWalk(path.join(root, ".cursor", "rules"), (_name, full) => contextFilePaths.push(full));
  add("context_file", contextFilePaths);

  // The two Claude settings files answer both questions below, so parse each file once.
  const parsed = new Map<string, Record<string, unknown> | null>();
  const configAt = (rel: string): Record<string, unknown> | null => {
    const full = path.join(root, rel);
    if (!parsed.has(full)) parsed.set(full, readConfigObject(full));
    return parsed.get(full) ?? null;
  };

  add(
    "hook_config",
    HOOK_CONFIG_PATHS.filter((rel) => hasHumanHooks(configAt(rel))).map((rel) =>
      path.join(root, rel),
    ),
  );

  add(
    "plugin_enabled",
    CLAUDE_SETTINGS_PATHS.filter((rel) => hasEnabledPlugin(configAt(rel))).map((rel) =>
      path.join(root, rel),
    ),
  );

  return out;
}

const ARTIFACT_LABELS: Record<ArtifactType, string> = {
  claude_agents: "Claude agents",
  claude_skills: "Claude skills",
  codex_skills: "Codex skills",
  cursor_commands: "Cursor commands",
  mcp_config: "MCP configs",
  eval_harness: "Eval harnesses",
  context_file: "Context files",
  hook_config: "Hook configs",
  plugin_enabled: "Enabled plugins",
};

interface EmittedArtifact {
  artifact: ScannedArtifact;
  bucket: string;
}

function scanAndEmit(
  tool: AiTool,
  sessionId: string,
): { codebaseId: string; emitted: EmittedArtifact[] } | null {
  const { root, codebaseId } = resolveRepo();
  if (root === null) return null;

  const scanned = collectArtifacts(root);
  if (!scanned.length) return { codebaseId, emitted: [] };

  const nowMs = Date.now();
  const timestamp = new Date(nowMs).toISOString();
  const config: PheebsConfig = { codebaseId, logPath: resolveLogPath() };
  const developer = getDeveloperHandle();
  const emitted: EmittedArtifact[] = [];

  for (const artifact of scanned) {
    const bucket = bucketFor(maxOf(artifact.mtimes), nowMs);
    appendLogEntry(
      {
        source: "hook",
        event: EVENTS.ArtifactFound,
        developer,
        codebase: config.codebaseId,
        ai_tool: tool,
        session_id: sessionId,
        timestamp,
        version: PHEEBS_VERSION,
        artifact_type: artifact.artifact_type,
        count: artifact.mtimes.length,
        last_modified_bucket: bucket,
      },
      config,
    );
    emitted.push({ artifact, bucket });
  }

  return { codebaseId, emitted };
}

/**
 * Scan the instrumented repo and emit one `artifact_found` event per detected
 * artifact type, recording presence and shape only. Never throws — scan failures
 * must not block the agent. Skips silently when not inside a git work tree.
 */
export function runArtifactScan(tool: AiTool, sessionId?: string): void {
  try {
    scanAndEmit(tool, sessionId ?? SCAN_SESSION_ID);
  } catch (err) {
    process.stderr.write(`pheebs: artifact scan failed: ${err}\n`);
  }
}

export async function runScanInteractive(tool: AiTool): Promise<void> {
  const { intro, outro, log } = await import("@clack/prompts");

  intro("pheebs scan");

  let result: ReturnType<typeof scanAndEmit>;
  try {
    result = scanAndEmit(tool, SCAN_SESSION_ID);
  } catch (err) {
    log.error(`Scan failed: ${err}`);
    outro("✗ error");
    return;
  }

  if (result === null) {
    log.warn("Not inside a git repository — nothing to scan.");
    outro("✗ skipped");
    return;
  }

  if (!result.emitted.length) {
    log.info("No AI-config artifacts found.");
    outro("✓ clean");
    return;
  }

  for (const { artifact, bucket } of result.emitted) {
    const label = ARTIFACT_LABELS[artifact.artifact_type] ?? artifact.artifact_type;
    log.success(`${label}: ${artifact.mtimes.length} file(s), modified ${bucket}`);
  }

  outro(`✓ ${result.emitted.length} artifact type(s) logged for ${result.codebaseId}`);
}
