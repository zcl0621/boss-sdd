// omp-context: restores the working set after a compaction or rollover, feeds summary
// requirements to omp's summarizer, and nudges near the budget in legacy compaction mode.
//
// omp API used (omp 18.11.1), all documented extension surface:
//   input, message_end, tool_result, turn_end     extensions/types.ts (InputEvent, MessageEndEvent, ToolResultEvent)
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
// Placement: if messages[0] is a compactionSummary, at index 1; otherwise IMMEDIATELY AFTER THE FIRST NON-SYNTHETIC USER
//   MESSAGE; when neither applies, nothing is inserted. Never at the tail, never at index 0.
//   - omp builds the summarizer request from convert(history) and convert(history + retained) and cuts the second at
//     len(convert(history)) (session/agent-session.ts:2380-2403). A tail block shifts that cut by its own size, can split
//     a tool_use/tool_result pair and pulls retained messages into the summarized range. With this rule both
//     conversions start with the same summary, so a summary-led request has the block at index 1 in both; without a
//     summary, a user message in history sits at the same index in both, and one only in retained lies after the cut.
//     Either way the prefix is exactly convert(history). (Falling back to "after the summary" only when there is no user
//     message would misalign: history alone puts the block at 1, history+retained anchors on a user message in retained.)
//   - a block at index 0 would become the date/cwd reminder's root (firstUser, session/date-cwd-reminder.ts:66); with a
//     summary first, the converted summary is the first user message, so that anchor is unchanged.
//   Known cost: after an Anthropic NATIVE compaction summary the block sits between the summary and the first retained
//   turn, which stops the converter merging the summary into a following assistant turn (ai/src/providers/anthropic.ts:
//   6190-6208). Role alternation stays valid.
// Timestamp: the constant 0. A real timestamp makes anthropic.ts:5869 flushCompactionFiles(msg.timestamp) replay the
//   summary's file metadata in front of the retained tail (ai/src/types.ts:1108-1130).
// Cache: the block's bytes are constant between compactions (nudge numbers are frozen when it latches, the timestamp is
//   0), so the cached prefix shifts once per compaction or nudge latch and is stable otherwise. Cost: the block's tokens
//   on each request until the next compaction.
// Filtering: `input` fires before slash parsing (modes/controllers/input-controller.ts:1011-1021), so text starting
//   with "/" or "!" is not recorded; agent-attributed user messages (session/agent-session.ts:7545, :11448) are skipped.
// Read selectors stripped from read paths: docs/tools/read.md:33-49.
// session_before_compact is deliberately NOT registered: it would disable async speculative compaction.
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

interface Word {
  text: string;
  viaInput: boolean;
  matched: boolean;
}
interface State {
  words: Word[];
  /** Restore block built at the last compaction; included in every context request until the next one. */
  pendingRestore?: string;
  /** Nudge text once triggered, numbers frozen at that moment; included until the next compaction. */
  nudgeText?: string;
  /** After a compaction, usage may still be stale; do not evaluate the nudge until the next turn_end. */
  nudgeHold: boolean;
  plan?: { path: string; status?: string };
  skills: Set<string>;
  announced: Set<string>;
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

function statusOf(text: string): string | undefined {
  const m = /\bStatus:[^\n]*/.exec(text);
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

async function gitLines(pi: any, ctx: any): Promise<{ branch?: string; worktrees: string[] }> {
  const run = async (args: string[]): Promise<string | undefined> => {
    try {
      const r = await pi.exec("git", args, { timeout: GIT_TIMEOUT_MS, cwd: ctx?.cwd });
      if (!r || r.code !== 0) return undefined;
      const out = String(r.stdout ?? "").trim();
      return out || undefined;
    } catch {
      return undefined;
    }
  };
  const branch = await run(["rev-parse", "--abbrev-ref", "HEAD"]);
  const wt = await run(["worktree", "list"]);
  return { branch, worktrees: wt ? wt.split("\n").map(l => l.trim()).filter(Boolean) : [] };
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
    else s = { words: [], nudgeHold: false, skills: new Set(), announced: new Set() };
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

  const addWord = (s: State, raw: string, viaInput: boolean) => {
    const full = raw.trim();
    if (!full) return;
    if (viaInput && (full.startsWith("/") || full.startsWith("!"))) return; // slash commands, shell escapes
    const text = full.slice(0, MAX_WORD_CHARS);
    if (!viaInput) {
      // The message typed earlier (possibly while streaming) arrives here; pair it whatever the turn.
      const twin = s.words.find(w => w.viaInput && !w.matched && w.text === text);
      if (twin) {
        twin.matched = true;
        return;
      }
    }
    s.words.push({ text, viaInput, matched: false });
    if (s.words.length > MAX_WORDS) s.words.splice(0, s.words.length - MAX_WORDS);
  };

  const trackPlan = (s: State, path: string, status: string | undefined) => {
    s.plan = { path, status };
  };

  pi.on("input", safe((e: any, ctx: any) => {
    if (typeof e?.text === "string") addWord(stateFor(ctx), e.text, true);
  }));

  pi.on("message_end", safe((e: any, ctx: any) => {
    const m = e?.message;
    const s = stateFor(ctx);
    if (m?.role === "user") {
      if (m.attribution !== "agent") addWord(s, textOf(m.content), false);
    }
    else if (m?.role === "custom" && m.customType === "skill-prompt" && typeof m.details?.name === "string")
      s.skills.add(m.details.name);
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

  pi.on("session_compact", safe(async (e: any, ctx: any) => {
    const s = stateFor(ctx);
    const entry = e?.compactionEntry;
    const id = typeof entry?.id === "string" ? entry.id : undefined;
    if (id) {
      if (s.announced.has(id)) return;
      s.announced.add(id);
    }
    s.nudgeText = undefined; // a new window starts
    s.nudgeHold = true;
    const rollover = entry?.details?.kind === ROLLOVER_KIND;
    const lines: string[] = [
      rollover
        ? "Working set restored after a context rollover:"
        : "Working set restored after compaction (the summary may have lost detail):",
    ];
    if (s.words.length) {
      lines.push("", "Recent user words (verbatim):");
      for (const w of s.words) lines.push(`- ${w.text.replace(/\n/g, "\n  ")}`);
    }
    if (s.plan) {
      lines.push("", `Active plan: ${s.plan.path}`);
      if (s.plan.status) lines.push(s.plan.status);
    }
    const git = await gitLines(pi, ctx);
    if (git.branch) lines.push("", `Git branch: ${git.branch}`);
    if (git.worktrees.length) lines.push(...(git.branch ? [] : [""]), "Worktrees:", ...git.worktrees.map(w => `- ${w}`));
    if (!rollover && s.skills.size) lines.push("", `Loaded skills: ${[...s.skills].join(", ")}`);
    s.pendingRestore = lines.join("\n"); // replaces the previous block; the context handler inserts it
  }));

  pi.on("turn_end", safe((_e: any, ctx: any) => {
    stateFor(ctx).nudgeHold = false; // usage reflects the post-compaction window from here on
  }));

  const nudgeFor = async (s: State, ctx: any): Promise<string | undefined> => {
    if (s.nudgeText) return s.nudgeText;
    if (s.nudgeHold) return undefined;
    try {
      const settings = await readSettings(ctx);
      const threshold = settings?.thresholdTokens;
      if (!settings || settings.experimentalContextManagement || typeof threshold !== "number" || threshold <= 0) return undefined;
      const tokens = ctx?.getContextUsage?.()?.tokens;
      if (typeof tokens !== "number" || tokens < fraction * threshold) return undefined;
      s.nudgeText =
        `Context is near the compaction threshold (${tokens} of ${threshold} tokens). ` +
        "Compaction will summarize soon: state the user's key words, the plan status and any open decisions in your next reply so they survive.";
      return s.nudgeText;
    } catch {
      return undefined;
    }
  };

  pi.on("context", safe(async (e: any, ctx: any) => {
    const messages = e?.messages;
    if (!Array.isArray(messages)) return undefined;
    // Leading compactionSummary: index 1. Otherwise right after the first non-synthetic user message. Otherwise nothing.
    const at = messages[0]?.role === "compactionSummary" ? 0 : messages.findIndex((m: any) => m?.role === "user" && !m.synthetic);
    if (at < 0) return undefined; // no anchor in this request: insert nothing
    const s = stateFor(ctx);
    const parts: string[] = [];
    if (s.pendingRestore) parts.push(s.pendingRestore);
    const nudge = await nudgeFor(s, ctx);
    if (nudge) parts.push(nudge);
    if (!parts.length) return undefined;
    const block = { role: "user", content: [{ type: "text", text: parts.join("\n\n") }], synthetic: true, timestamp: 0 };
    return { messages: [...messages.slice(0, at + 1), block, ...messages.slice(at + 1)] };
  }));
}
