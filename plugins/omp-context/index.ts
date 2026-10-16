// omp-context: restores the working set after a compaction or rollover, feeds summary
// requirements to omp's summarizer, and nudges near the budget in legacy compaction mode.
//
// omp API used (omp 18.11.1), all documented extension surface:
//   session_start, message_end, tool_result,      extensions/types.ts (MessageEndEvent, ToolResultEvent)
//   turn_end
//   session.compacting -> { context?: string[] }  extensibility/shared-events.ts:90, :482
//   session_compact {compactionEntry}             shared-events.ts:97; fired for legacy compaction and rollover
//                                                 (session/session-maintenance.ts:2486); rollover entries carry
//                                                 details.kind === "experimental-context-rollover" (:1664, :1824)
//   context -> { messages }                       docs/extensions.md:485 ("`context` - receives conversation messages and
//                                                 may return `{ messages }`"); extensions/types.ts:1480-1482
//                                                 (ContextEventResult); runner.ts:2009 emitContext;
//                                                 called for EVERY provider request from sdk.ts:4253-4256
//                                                 (transformContext -> extensionRunner.emitContext), including mid-run
//                                                 steps. Print mode runs the same AgentSession (modes/print-mode.ts:112),
//                                                 so the event fires there too.
//   pi.exec, ctx.getContextUsage
// Delivery: pi.sendMessage is NOT used. Even "nextTurn" waits for the next user prompt (session/agent-session.ts:8897-8899,
//   drained :8018-8022), and "aside" at a post-turn compaction (isIdle() false inside agent_end) can wake an unrequested
//   model turn just to deliver a hidden message (#resumeStrandedIrcAsides, agent-session.ts:1202-1317). Instead the
//   restore block and the nudge are added, as ONE synthetic user message, to every `context` request (the way
//   plugins/omp-plan-memory does). Nothing is persisted and no turn is triggered.
// Placement (anchorIndex): right after a compactionSummary found among the LEADING custom (and synthetic user) messages;
//   otherwise right after the EARLIEST USER TURN: the first non-synthetic user message or user-attributed `skill-prompt`
//   custom message, whichever comes first; otherwise nothing. Never at the tail, never at index 0.
//   - After a rollover omp's buildSessionContext (session/session-context.ts) pushes the summary first (:540-545),
//     re-appends the latest user request, which for a /skill-started task is the skill-prompt custom message
//     (:547-569, isRolloverRequestEntry :40-48), then kept and later messages, and finally splices the context-notes
//     custom message in at index 0 (:646-670). T9 saw [custom notes, compactionSummary, custom skill-prompt, custom
//     todo reminder, assistant, toolResult, ...] with no user role at all. That head stays put until the next
//     compaction: session-maintenance.ts:2466-2468 swaps it in once and later turns only append.
//   - omp builds the summarizer request from convert(history) and convert(history + retained) and cuts the second at
//     len(convert(history)) (session/agent-session.ts:2380-2403). A tail block shifts that cut by its own size, can split
//     a tool_use/tool_result pair and pulls retained messages into the summarized range. History there is the rebuilt
//     summary plus entries after the previous compaction (agent/src/compaction/compaction.ts:2051-2070), so a leading
//     summary is in both conversions, and the earliest user turn in history is also the earliest in history+retained;
//     one only in retained lies after the cut. Either way the prefix is exactly convert(history). (A "user message
//     first, skill-prompt second" order would misalign: a skill-prompt in history, a user message only in retained.)
//   - a block at index 0 would become the date/cwd reminder's root (firstUser, session/date-cwd-reminder.ts:66); with a
//     summary first, the converted summary is the first user message, so that anchor is unchanged.
//   - A NATIVE Anthropic summary (providerPayload.type "anthropicCompaction") must open the request and is folded into
//     a directly following assistant turn whose signed thinking is bound to that prefix. The anchor then moves past
//     that assistant turn, its toolResults and the notes message, exactly where omp puts the notes
//     (session/session-context.ts:651-662). The native cut never separates a tool call from its results and cuts only
//     at an assistant/non-assistant boundary (agent/src/compaction/anthropic.ts:137-171), so the same anchor is found
//     in history and history+retained.
// Timestamp: the constant 0. A real timestamp makes anthropic.ts:5869 flushCompactionFiles(msg.timestamp) replay the
//   summary's file metadata in front of the retained tail (ai/src/types.ts:1108-1130).
// Cache: `context` is synchronous over stored state, so two requests with no event between them carry the same bytes.
//   The block changes at a compaction, at most once more when that compaction's git refresh fills in, and when the
//   nudge latches at a turn_end (numbers frozen, timestamp 0). omp marks each inserted message per-call
//   (extensions/runner.ts:2069); on Anthropic that stops the every-15-turns cache checkpoints below the block
//   (ai/src/providers/anthropic.ts:4514-4518). Cost: the block's tokens on each request until the next compaction.
// User words: from message_end with role "user" (the message as it entered the session), and the task text of a
//   user-invoked /skill:<name> <args>: omp stores it as a custom message, customType "skill-prompt", attribution
//   "user", whose content is the skill body and whose details.args is the user's own text, trimmed
//   (modes/skill-command.ts:63-87, extensibility/skills.ts:671-718); details.args is recorded, never the body or
//   details.prompt. Not from `input`:
//   input handlers chain (runner.ts:1982-2005), so a later extension may rewrite or swallow the text, and the continue
//   shortcut becomes a synthetic developer message (input-controller.ts:985-998). Agent-attributed or synthetic user
//   messages (session/agent-session.ts:7545, :11448) are skipped.
// Read selectors stripped from read paths: docs/tools/read.md:33-49.
// session_before_compact is deliberately NOT registered: it would disable async speculative compaction.
// Nudge: decided at turn_end (settings and usage read there) and stored; a compaction clears it and drops any decision
//   still in flight, so nothing re-arms it before the next turn_end.
// Mode and threshold come from omp itself through string-literal dynamic imports behind try/catch; on any
// failure the nudge stays quiet:
//   lookup("compaction.experimentalContextManagement").get(pi.pi.settings)   docs/extensions.md:287-296
//   describeModelCompactionPoint(settings, model).tokens                      session/model-compaction-threshold.ts:37
// Nudge fraction: factory option > env OMP_CONTEXT_NUDGE_FRACTION (0 < f < 1) > 0.85.
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_WORDS = 8;
const MAX_WORD_CHARS = 1000;
const GIT_TIMEOUT_MS = 3000;
const MAX_SESSIONS = 32;
const NUDGE_ENV = "OMP_CONTEXT_NUDGE_FRACTION";
const DEFAULT_NUDGE_FRACTION = 0.85;
const ROLLOVER_KIND = "experimental-context-rollover";
const SKILL_PROMPT = "skill-prompt";

/** A user-invoked /skill:<name> message (omp's isUserInvokedSkillPrompt, tui/src/chat/messages.ts:273-275). */
const isUserSkillPrompt = (m: any): boolean => m?.role === "custom" && m.customType === SKILL_PROMPT && m.attribution === "user";

// Same body as anchorIndex in plugins/omp-plan-memory/index.ts; keep the two identical.
/** Index of the message the block goes right after, or -1 for none (see Placement in the header). */
function anchorIndex(messages: any[]): number {
  const isSyntheticUser = (m: any): boolean => m?.role === "user" && m.synthetic === true;
  const isUserTurn = (m: any): boolean =>
    (m?.role === "user" && m.synthetic !== true) ||
    (m?.role === "custom" && m.customType === "skill-prompt" && m.attribution === "user");
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m?.role !== "compactionSummary") {
      if (m?.role === "custom" || isSyntheticUser(m)) continue;
      break;
    }
    // A native Anthropic summary is folded into a directly following assistant turn (signed thinking bound to that
    // prefix): never split it. Mirror omp's notes placement (session/session-context.ts:651-662): past one assistant
    // message, then its toolResults, then past the notes message omp put there.
    let at = i;
    if (m.providerPayload?.type === "anthropicCompaction") {
      if (messages[at + 1]?.role === "assistant") at++;
      while (messages[at + 1]?.role === "toolResult") at++;
      const next = messages[at + 1];
      if (next?.role === "custom" && next.customType === "experimental_context_notes") at++;
    }
    return at;
  }
  return messages.findIndex(isUserTurn);
}

export const DEFAULT_GUIDANCE = [
  "When summarizing, keep the following so work can resume:",
  "- Keep the user's own words verbatim (quote their requests, constraints and corrections; do not paraphrase them).",
  "- Plan status: the active plan document path and its Status line.",
  "- Open nodes: tasks started but not finished, and what each is waiting for.",
  "- Worktrees and branches in use, with the path of each worktree.",
  "- Pending decisions: questions asked of the user that are still unanswered, and decisions made with their reasons.",
].join("\n");

export interface SettingsSnapshot {
  experimentalContextManagement: boolean;
  /** Effective compaction trigger in tokens for the active model, when omp can tell. */
  thresholdTokens?: number;
}
export type ReadSettings = (ctx: any) => Promise<SettingsSnapshot | undefined>;
export interface ModuleLoaders {
  registry: () => Promise<any>;
  threshold: () => Promise<any>;
}
export interface OmpContextOptions {
  readSettings?: ReadSettings;
  guidancePath?: string;
  nudgeFraction?: number;
  loadModules?: ModuleLoaders;
}

export function defaultGuidancePath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "guidance.md");
}

// String-literal specifiers: a variable specifier fails in the release binary.
const defaultLoaders: ModuleLoaders = {
  registry: () => import("@oh-my-pi/pi-coding-agent/config/registry"),
  threshold: () => import("@oh-my-pi/pi-coding-agent/session/model-compaction-threshold"),
};

export function createSettingsReader(pi: any, loaders: ModuleLoaders = defaultLoaders): ReadSettings {
  return async (ctx: any) => {
    const scope = pi?.pi?.settings;
    let experimental: boolean;
    try {
      const reg = await loaders.registry();
      const setting = reg?.lookup?.("compaction.experimentalContextManagement");
      const value = setting?.get?.(scope);
      if (typeof value !== "boolean") return undefined;
      experimental = value;
    } catch {
      return undefined;
    }
    let thresholdTokens: number | undefined;
    try {
      if (ctx?.model) {
        const mod = await loaders.threshold();
        const tokens = mod?.describeModelCompactionPoint?.(scope, ctx.model)?.tokens;
        if (typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0) thresholdTokens = tokens;
      }
    } catch {
      thresholdTokens = undefined;
    }
    return { experimentalContextManagement: experimental, thresholdTokens };
  };
}

interface GitInfo {
  branch?: string;
  worktrees: string[];
}
interface State {
  words: string[];
  /** Restore block built at the last compaction; included in every context request until the next one. */
  pendingRestore?: string;
  /** Nudge text once triggered at a turn_end, numbers frozen at that moment; included until the next compaction. */
  nudgeText?: string;
  /** Bumped by every compaction: git fills and nudge decisions started before it are dropped. */
  generation: number;
  /** Last known git branch and worktrees (refreshed at session_start, turn_end and after a compaction). */
  git?: GitInfo;
  /** Sequence number of the latest git refresh started, and of the one whose result `git` holds. */
  gitStarted: number;
  gitApplied: number;
  plan?: { path: string; status?: string };
  skills: Set<string>;
  /** Id of the latest compaction announced: omp may emit session_compact twice for one entry. */
  announced?: string;
}

const PLAN_RE = /(^|[\\/])docs[\\/]plans[\\/][^\\/]+\.md$/;
const isPlanPath = (p: unknown): p is string => typeof p === "string" && PLAN_RE.test(p);

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((b: any) => (b && b.type === "text" && typeof b.text === "string" ? b.text : ""))
      .filter(Boolean)
      .join("\n");
  return "";
}

// The plan-level Status starts its line (plan-spec.md: the header block); a task's `- Status:` line does not count.
function statusOf(text: string): string | undefined {
  const m = /^Status:[^\n]*/m.exec(text);
  return m ? m[0].trim() : undefined;
}

// omp read selectors: :raw, :-N, :N, :A-B, :A+C, :5-10,20-30, :range:raw, :raw:range (docs/tools/read.md:33-49).
const SELECTOR_RE = /(?::(?:raw|-?\d+(?:[-+]\d+)?(?:,\d+(?:[-+]\d+)?)*))+$/;

function splitSelector(p: string): { path: string; ranged: boolean } {
  const m = SELECTOR_RE.exec(p);
  if (!m) return { path: p, ranged: false };
  return { path: p.slice(0, m.index), ranged: /\d/.test(m[0]) };
}

export function resolveNudgeFraction(option: number | undefined, env: Record<string, string | undefined> = process.env): number {
  if (typeof option === "number") return option;
  const raw = env[NUDGE_ENV];
  if (typeof raw === "string" && raw.trim() !== "") {
    const f = Number(raw);
    if (Number.isFinite(f) && f > 0 && f < 1) return f;
  }
  return DEFAULT_NUDGE_FRACTION;
}

function skillFromPath(p: string): string | undefined {
  const uri = /^skill:\/\/([^/\s]+)/.exec(p);
  if (uri) return uri[1];
  const file = /[\\/]skills[\\/]([^\\/]+)[\\/]SKILL\.md$/.exec(p);
  return file ? file[1] : undefined;
}

function readStatusFromDisk(path: string, cwd: unknown): string | undefined {
  try {
    const abs = isAbsolute(path) ? path : resolve(typeof cwd === "string" ? cwd : process.cwd(), path);
    return statusOf(readFileSync(abs, "utf8"));
  } catch {
    return undefined;
  }
}

function readGuidance(path: string): string {
  try {
    const t = readFileSync(path, "utf8").trim();
    if (t) return t;
  } catch {
    // fall through to the default
  }
  return DEFAULT_GUIDANCE;
}

/** One git answer: its output, a definite "not a git repository", or failed (timeout, spawn failure, other error). */
type GitAnswer = { out: string } | { notRepo: true } | undefined;
const NOT_REPO_RE = /not a git repository/i;

/** Each field is set only when its own call succeeded; `notRepo` when git definitely said so. */
interface GitRefresh {
  branch?: string;
  worktrees?: string[];
  notRepo: boolean;
}

async function gitLines(pi: any, ctx: any): Promise<GitRefresh> {
  const run = async (args: string[]): Promise<GitAnswer> => {
    try {
      const r = await pi.exec("git", args, { timeout: GIT_TIMEOUT_MS, cwd: ctx?.cwd });
      if (!r || r.killed) return undefined; // timeout or signal (omp exec/exec.ts:49-55)
      if (r.code === 0) return { out: String(r.stdout ?? "").trim() };
      return NOT_REPO_RE.test(String(r.stderr ?? "")) ? { notRepo: true } : undefined;
    } catch {
      return undefined;
    }
  };
  const b = await run(["rev-parse", "--abbrev-ref", "HEAD"]);
  const w = await run(["worktree", "list"]);
  const out: GitRefresh = { notRepo: (!!b && "notRepo" in b) || (!!w && "notRepo" in w) };
  if (b && "out" in b) out.branch = b.out || undefined;
  if (w && "out" in w) out.worktrees = w.out.split("\n").map(l => l.trim()).filter(Boolean);
  return out;
}

/** Git info after a refresh: cleared outside a repository, else each field replaced only when its call succeeded. */
function mergeGit(old: GitInfo | undefined, r: GitRefresh): GitInfo | undefined {
  if (r.notRepo) return undefined;
  const branch = "branch" in r ? r.branch : old?.branch;
  const worktrees = r.worktrees ?? old?.worktrees ?? [];
  return branch || worktrees.length ? { branch, worktrees } : undefined;
}

export default function ompContext(pi: any, options: OmpContextOptions = {}): void {
  const guidancePath = options.guidancePath ?? defaultGuidancePath();
  const fraction = resolveNudgeFraction(options.nudgeFraction);
  const readSettings: ReadSettings = options.readSettings ?? createSettingsReader(pi, options.loadModules);
  const states = new Map<string, State>();

  const stateFor = (ctx: any): State => {
    let id = "default";
    try {
      id = String(ctx?.sessionManager?.getSessionId?.() ?? "default");
    } catch {
      // keep default
    }
    let s = states.get(id);
    if (s) states.delete(id); // re-insert below: Map order is least recently used first
    else s = { words: [], generation: 0, gitStarted: 0, gitApplied: 0, skills: new Set() };
    states.set(id, s);
    while (states.size > MAX_SESSIONS) states.delete(states.keys().next().value as string);
    return s;
  };

  const safe = <E, C>(fn: (e: E, c: C) => any) => async (e: E, c: C) => {
    try {
      return await fn(e, c);
    } catch {
      return undefined;
    }
  };

  // Only the user message as it entered the session (message_end). Raw `input` text is not used: another extension
  // may rewrite or swallow it later in the chain (runner.ts:1982-2005), and the continue shortcut never reaches it.
  const addWord = (s: State, raw: string) => {
    const full = raw.trim();
    if (!full) return;
    s.words.push(full.slice(0, MAX_WORD_CHARS));
    if (s.words.length > MAX_WORDS) s.words.splice(0, s.words.length - MAX_WORDS);
  };

  const trackPlan = (s: State, path: string, status: string | undefined) => {
    s.plan = { path, status };
  };

  pi.on("message_end", safe((e: any, ctx: any) => {
    const m = e?.message;
    const s = stateFor(ctx);
    if (m?.role === "user") {
      if (m.attribution !== "agent" && m.synthetic !== true) addWord(s, textOf(m.content));
    }
    else if (m?.role === "custom" && m.customType === SKILL_PROMPT) {
      if (typeof m.details?.name === "string") s.skills.add(m.details.name);
      if (isUserSkillPrompt(m) && typeof m.details?.args === "string") addWord(s, m.details.args);
    }
  }));

  pi.on("tool_result", safe((e: any, ctx: any) => {
    if (e?.isError) return;
    const s = stateFor(ctx);
    const input = e?.input ?? {};
    if (e.toolName === "read" && typeof input.path === "string") {
      const { path: p, ranged } = splitSelector(input.path);
      const skill = skillFromPath(p);
      if (skill) s.skills.add(skill);
      else if (isPlanPath(p)) {
        let status = ranged ? undefined : statusOf(textOf(e.content));
        if (!status) status = readStatusFromDisk(p, ctx?.cwd);
        if (!status && s.plan?.path === p) status = s.plan.status;
        trackPlan(s, p, status);
      }
    } else if (e.toolName === "write" && isPlanPath(input.path)) {
      trackPlan(s, input.path, statusOf(typeof input.content === "string" ? input.content : ""));
    } else if (e.toolName === "edit") {
      const paths: string[] = [];
      const d = e.details;
      if (typeof d?.path === "string") paths.push(d.path);
      if (Array.isArray(d?.perFileResults))
        for (const r of d.perFileResults) if (typeof r?.path === "string") paths.push(r.path);
      if (typeof input.path === "string") paths.push(input.path);
      const plans = paths.filter(isPlanPath);
      const last = plans[plans.length - 1];
      if (last) trackPlan(s, last, readStatusFromDisk(last, ctx?.cwd));
    }
  }));

  pi.on("session.compacting", safe(() => ({ context: [readGuidance(guidancePath)] })));

  const gitPart = (git: GitInfo | undefined): string[] => {
    const out: string[] = [];
    if (git?.branch) out.push("", `Git branch: ${git.branch}`);
    if (git?.worktrees.length) out.push(...(git.branch ? [] : [""]), "Worktrees:", ...git.worktrees.map(w => `- ${w}`));
    return out;
  };

  // Each refresh takes a sequence number when it starts; its result replaces `s.git` only when no later-started
  // refresh has been applied, so a slow old answer never overwrites a newer one. Fields merge one by one (mergeGit):
  // a call that failed or timed out keeps its old field, a definite "not a git repository" clears both.
  const refreshGit = async (s: State, ctx: any): Promise<GitInfo | undefined> => {
    const seq = ++s.gitStarted;
    const git = mergeGit(s.git, await gitLines(pi, ctx));
    if (seq > s.gitApplied) {
      s.git = git;
      s.gitApplied = seq;
    }
    return git;
  };
  // Not awaited: omp awaits session_start at startup and waits for in-flight handlers before going idle.
  const refreshInBackground = (s: State, ctx: any) => void refreshGit(s, ctx).catch(() => undefined);

  pi.on("session_start", safe((_e: any, ctx: any) => {
    refreshInBackground(stateFor(ctx), ctx);
  }));

  // The new block is set synchronously from state already held, before any await: omp may emit session_compact
  // detached (session-maintenance.ts:2490-2496), so the next provider request can come before any git call returns.
  // A git refresh started here fills in the git part once, and is dropped if a newer compaction happened meanwhile.
  pi.on("session_compact", safe(async (e: any, ctx: any) => {
    const s = stateFor(ctx);
    const entry = e?.compactionEntry;
    const id = typeof entry?.id === "string" ? entry.id : undefined;
    if (id) {
      if (s.announced === id) return;
      s.announced = id;
    }
    const generation = ++s.generation;
    s.nudgeText = undefined; // a new window starts
    const rollover = entry?.details?.kind === ROLLOVER_KIND;
    const head: string[] = [
      rollover
        ? "Working set restored after a context rollover:"
        : "Working set restored after compaction (the summary may have lost detail):",
    ];
    if (s.words.length) {
      head.push("", "Recent user words (verbatim):");
      for (const w of s.words) head.push(`- ${w.replace(/\n/g, "\n  ")}`);
    }
    if (s.plan) {
      head.push("", `Active plan: ${s.plan.path}`);
      if (s.plan.status) head.push(s.plan.status);
    }
    const tail: string[] = !rollover && s.skills.size ? ["", `Loaded skills: ${[...s.skills].join(", ")}`] : [];
    const build = (git: GitInfo | undefined) => [...head, ...gitPart(git), ...tail].join("\n");
    s.pendingRestore = build(s.git); // replaces the previous block; the context handler inserts it

    const git = await refreshGit(s, ctx);
    if (s.generation !== generation) return; // a newer compaction owns the block now
    s.pendingRestore = build(git); // the one git fill for this compaction
  }));

  // The nudge is decided here, from settled usage, and stored; `context` only reads it. Usage is read after
  // the settings so it is as fresh as possible; a compaction during the await drops the decision.
  const decideNudge = async (s: State, ctx: any): Promise<void> => {
    if (s.nudgeText) return; // latched: numbers frozen until the next compaction
    const generation = s.generation;
    let settings: SettingsSnapshot | undefined;
    try {
      settings = await readSettings(ctx);
    } catch {
      return;
    }
    if (s.generation !== generation || s.nudgeText) return;
    const threshold = settings?.thresholdTokens;
    if (!settings || settings.experimentalContextManagement || typeof threshold !== "number" || threshold <= 0) return;
    let tokens: unknown;
    try {
      tokens = ctx?.getContextUsage?.()?.tokens;
    } catch {
      return;
    }
    if (typeof tokens !== "number" || tokens < fraction * threshold) return;
    s.nudgeText =
      `Context is near the compaction threshold (${tokens} of ${threshold} tokens). ` +
      "Compaction will summarize soon: state the user's key words, the plan status and any open decisions in your next reply so they survive.";
  };

  // A compaction clears the nudge and nothing re-evaluates it before the next turn_end, so stale usage cannot re-arm it.
  // Only the settings/usage read for the nudge is awaited; the git refresh runs in the background.
  pi.on("turn_end", safe(async (_e: any, ctx: any) => {
    const s = stateFor(ctx);
    refreshInBackground(s, ctx);
    await decideNudge(s, ctx);
  }));

  // A pure function of stored state: no await, so two requests with no event between them carry the same bytes.
  pi.on("context", safe((e: any, ctx: any) => {
    const messages = e?.messages;
    if (!Array.isArray(messages)) return undefined;
    const at = anchorIndex(messages);
    if (at < 0) return undefined; // no anchor in this request: insert nothing
    const s = stateFor(ctx);
    const parts: string[] = [];
    if (s.pendingRestore) parts.push(s.pendingRestore);
    if (s.nudgeText) parts.push(s.nudgeText);
    if (!parts.length) return undefined;
    const block = { role: "user", content: [{ type: "text", text: parts.join("\n\n") }], synthetic: true, timestamp: 0 };
    return { messages: [...messages.slice(0, at + 1), block, ...messages.slice(at + 1)] };
  }));
}
