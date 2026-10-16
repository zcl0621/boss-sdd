#!/usr/bin/env bun
// Evolution harness for omp-context's summary guidance (the `guidance.md` next to index.ts).
//
// Replays real compactions offline: for each compaction in omp session journals that ran omp's summarizer with
// the session.compacting context, rebuild the input omp's summarizer saw, send it with a candidate guidance and
// count how many recall facts the new summary keeps. A candidate is installed only when it keeps more facts on
// the train conversations (by at least `margin`) and no fewer on the holdout ones.
//
//   bun plugins/omp-context/evolve/evolve.ts --sessions <dir> --bank <questions.json> --model <id>
//       [--target <dir>] [--rounds N] [--samples N] [--margin N] [--baseline-file f] [--dry-run]
//
// Scoring method ported from plugins/context-keeper/evolve/ (evolve.mjs, loop.mjs): verbatim answers, a
// train/holdout split, margin >= 1, rejection of candidates that contain a bank answer.
import { type ChildProcess, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { DEFAULT_GUIDANCE } from "../index";
import { SUMMARIZATION_PROMPT, SUMMARIZATION_SYSTEM_PROMPT, UPDATE_SUMMARIZATION_PROMPT } from "./omp-prompts";

export { SUMMARIZATION_PROMPT, SUMMARIZATION_SYSTEM_PROMPT, UPDATE_SUMMARIZATION_PROMPT };

// ---------- types ----------
export interface Question {
  id: string;
  kind: string;
  facts: string[][];
}
export interface Bank {
  /** A session is holdout when one of these is a substring of its title (title slot / header) or file name. */
  holdout?: string[];
  questions: Question[];
}
export interface Session {
  name: string;
  title: string;
  source: string;
  path: string;
  entries: any[];
}
export interface Case {
  id: string;
  session: string;
  split: "train" | "holdout";
  update: boolean;
  lead: string;
  transcript: string;
  questions: { id: string; kind: string; facts: string[] }[];
}
export type Purpose = "proposal" | "summary";
export type Generate = (prompt: string, opts: { purpose: Purpose }) => Promise<string>;
export type Exec = (
  cmd: string,
  args: string[],
  opts: { stdin: "ignore"; timeoutMs?: number; cwd?: string },
) => Promise<{ code: number; stdout: string; stderr: string }>;

export class QuotaError extends Error {}
const QUOTA = /usage limit|quota will reset|insufficient balance|rate limit/i;

// ---------- live temp resources ----------
// Everything evolve makes in the temp dir, and every omp child it starts, is registered here so a signal handler
// (see main) can remove and kill it all before exiting.
const liveDirs = new Set<string>();
const liveChildren = new Set<ChildProcess>();
const liveFiles = new Set<string>();
/** Register a temp file for cleanupLive; the returned function unregisters it. */
export const trackTempFile = (path: string): (() => void) => {
  liveFiles.add(path);
  return () => void liveFiles.delete(path);
};
const makeTemp = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  liveDirs.add(d);
  return d;
};
const removeTemp = (d: string) => {
  rmSync(d, { recursive: true, force: true });
  liveDirs.delete(d);
};
export const liveTempDirs = (): string[] => [...liveDirs];
/** Kill running omp children and remove every registered temp dir. Safe to call at any time, more than once. */
export function cleanupLive(): void {
  for (const c of liveChildren) c.kill("SIGKILL");
  liveChildren.clear();
  for (const f of liveFiles) rmSync(f, { force: true });
  liveFiles.clear();
  for (const d of [...liveDirs]) removeTemp(d);
}

// ---------- locations ----------
/**
 * The installed extension dir, inside omp's agent directory as omp resolves it (utils/src/dirs.ts): a named profile
 * (`OMP_PROFILE`, else `PI_PROFILE`; empty or "default" means none) uses `<root>/profiles/<name>/agent` and ignores
 * `PI_CODING_AGENT_DIR`; otherwise `PI_CODING_AGENT_DIR`, else `<root>/agent`, with root `<HOME>/<PI_CONFIG_DIR or
 * .omp>`, HOME falling back to os.homedir(). Only ever computed here.
 */
export function defaultTargetDir(env: Record<string, string | undefined> = process.env): string {
  const root = join(env.HOME || homedir(), env.PI_CONFIG_DIR || ".omp");
  const raw = (env.OMP_PROFILE !== undefined ? env.OMP_PROFILE : env.PI_PROFILE)?.trim();
  const profile = raw && raw !== "default" ? raw : undefined;
  const agent = profile ? join(root, "profiles", profile, "agent") : env.PI_CODING_AGENT_DIR || join(root, "agent");
  return join(agent, "extensions", "omp-context");
}

// ---------- journals ----------
const walk = (dir: string): string[] => {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
};

/** Each journal is copied under `tempRoot` first and the copy is what gets parsed; the source is only read. */
export function loadJournals(dir: string, opts: { tempRoot: string }): Session[] {
  // No default: a copy dir nobody owns would leak. The caller makes it and removes it.
  const tempRoot = opts?.tempRoot;
  if (!tempRoot) throw new Error("loadJournals: tempRoot is required (the caller owns, and removes, the copy dir)");
  return walk(dir).map((source, i) => {
    const path = join(tempRoot, String(i), relative(dir, source));
    mkdirSync(dirname(path), { recursive: true });
    copyFileSync(source, path);
    const entries: any[] = [];
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (e && typeof e === "object") entries.push(e);
      } catch {}
    }
    const slot = entries.find((e) => e.type === "title" && typeof e.title === "string");
    const header = entries.find((e) => e.type === "session" && typeof e.title === "string");
    return { name: basename(source, ".jsonl"), title: slot?.title ?? header?.title ?? "", source, path, entries };
  });
}

// ---------- replay cases ----------
const ROLLOVER_KIND = "experimental-context-rollover";
const TOOL_RESULT_MAX_CHARS = 2000; // omp compaction/utils.ts:209-218

const isRollover = (c: any) => c?.details?.kind === ROLLOVER_KIND;
// Only compactions whose summarizer got the session.compacting context: no method (a legacy or plain entry; a
// manual /compact stores the method it selected), "soft" and "remote". handoff (auto handoff skips the context), snapcompact, shake, rollover (no summarizer) and
// extension-supplied compactions (fromExtension, which omp stores without a method) are skipped and counted.
const skipKey = (c: any): string | undefined => {
  if (isRollover(c)) return "rollover";
  if (c.fromExtension === true) return "extension";
  if (c.method !== undefined && c.method !== "soft" && c.method !== "remote") return String(c.method);
  return undefined;
};

export type Dialect = "anthropic" | "generic";
// omp's boundedMatch (catalog/src/compat/taxonomy.ts:56): the token starts the value and is followed by the end or
// one of - _ . : or a digit.
const boundedMatch = (value: string, token: string): boolean =>
  value === token || (value.startsWith(token) && /[-_.:0-9]/.test(value[token.length]));

/**
 * The anthropic dialect drops thinking from the summarizer input; everything else keeps it. Mirrors omp's
 * classifyModel decision for the anthropic class (compat/taxonomy.ts:56-77, rules.json): a bounded match of
 * `anthropic` or `claude` at the start of the bare id (the part after the last "/"), or `anthropic` as a bounded
 * namespace part of the id (split on / . :). Not mirrored: omp's per-provider identity overrides and its
 * tie-breaking between classes.
 */
export const dialectFor = (model: string | undefined): Dialect => {
  const lower = (model ?? "").trim().toLowerCase();
  const bare = lower.slice(lower.lastIndexOf("/") + 1);
  const anthropic =
    boundedMatch(bare, "anthropic") ||
    boundedMatch(bare, "claude") ||
    lower.split(/[/.:]/).some((part) => part && boundedMatch(part, "anthropic"));
  return anthropic ? "anthropic" : "generic";
};

/** Skipped compactions in the journals, counted by method ("rollover" for rollovers). */
export function countSkipped(sessions: Session[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of sessions)
    for (const e of s.entries)
      if (e.type === "compaction") {
        const k = skipKey(e);
        if (k) out[k] = (out[k] ?? 0) + 1;
      }
  return out;
}

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.filter((p: any) => p?.type === "text").map((p: any) => p.text).join("")
      : "";

// <file> too: omp inlines our prompt file inside <file name="...">...</file> (cli/file-processor.ts), and a literal
// </file> in a transcript would close that wrapper early.
const escapeBoundaryTags = (text: string) => text.replace(/<\s*\/?\s*(?:conversation|previous-summary|file)\s*>/gi, (t) => `&lt;${t.slice(1)}`);

const cut = (text: string) =>
  text.length <= TOOL_RESULT_MAX_CHARS
    ? text
    : `${text.slice(0, TOOL_RESULT_MAX_CHARS)}\n\n[... ${text.length - TOOL_RESULT_MAX_CHARS} more characters truncated]`;

const callArgs = (a: unknown) =>
  Object.entries((a ?? {}) as Record<string, unknown>)
    .map(([k, v]) => `${k}=${JSON.stringify(v) ?? "null"}`)
    .join(", ");

/** What an entry contributes to the summarizer input (omp getMessageFromEntry), as text blocks. */
function render(entry: any, dropThinking: boolean): string[] {
  if (entry.type === "custom_message") {
    const t = textOf(entry.content);
    return t ? [`[Developer]: ${t}`] : [];
  }
  if (entry.type === "branch_summary") return entry.summary ? [`[User]: ${entry.summary}`] : [];
  if (entry.type !== "message" || !entry.message) return [];
  const m = entry.message;
  if (m.role === "user" || m.role === "developer") {
    const t = textOf(m.content);
    return t ? [`[${m.role === "user" ? "User" : "Developer"}]: ${t}`] : [];
  }
  if (m.role === "toolResult") {
    const t = textOf(m.content);
    return t ? [`[Tool Result]: ${cut(t)}`] : [];
  }
  if (m.role !== "assistant" || !Array.isArray(m.content)) return [];
  const out: string[] = [];
  const think = m.content.filter((b: any) => b.type === "thinking").map((b: any) => b.thinking);
  const text = m.content.filter((b: any) => b.type === "text").map((b: any) => b.text);
  const calls = m.content.filter((b: any) => b.type === "toolCall");
  if (think.length && !dropThinking) out.push(`[Thinking]: ${think.join("\n")}`);
  if (text.length) out.push(`[Assistant]: ${text.join("\n")}`);
  if (calls.length) out.push(`[Tool Call]: ${calls.map((c: any) => `${c.name}(${callArgs(c.arguments)})`).join("; ")}`);
  return out;
}

/** Of the spellings present in the history, the one that appears last (the value that changed last). */
export function expected(history: string, spellings: string[]): string | undefined {
  const low = history.toLowerCase();
  let best: string | undefined;
  let at = -1;
  for (const s of spellings) {
    const i = low.lastIndexOf(s.toLowerCase());
    if (i > at) {
      at = i;
      best = s;
    }
  }
  return best;
}

const isHoldout = (bank: Bank, s: Session) => (bank.holdout ?? []).some((p) => p && (s.title.includes(p) || s.name.includes(p)));

/**
 * One case per summarizer compaction. The transcript is what omp summarized (compaction.ts:1419-1473): from the
 * previous compaction's firstKeptEntryId (else the start) up to, excluding, this compaction's firstKeptEntryId.
 * The lead is the previous compaction's summary whatever its method (compaction.ts:1387-1402, 997-998).
 */
export function buildCases(sessions: Session[], bank: Bank, opts: { dialect?: string } = {}): Case[] {
  const cases: Case[] = [];
  for (const s of sessions) {
    const byId = new Map<string, any>();
    for (const e of s.entries) if (typeof e.id === "string") byId.set(e.id, e);
    let n = 0;
    for (const comp of s.entries) {
      if (comp.type !== "compaction") continue;
      n++;
      if (skipKey(comp)) continue;
      // root -> this compaction's parent, following parentId
      const path: any[] = [];
      for (let id = comp.parentId, guard = 0; id && byId.has(id) && guard < 100000; guard++) {
        const e = byId.get(id);
        path.unshift(e);
        id = e.parentId;
      }
      let reset = -1;
      path.forEach((e, i) => {
        if (e.type === "reset_boundary") reset = i;
      });
      let prevIdx = -1;
      path.forEach((e, i) => {
        if (e.type === "compaction" && i > reset) prevIdx = i;
      });
      let start = reset + 1;
      if (prevIdx >= 0) {
        start = prevIdx + 1;
        for (let i = reset + 1; i < prevIdx; i++)
          if (path[i].id === path[prevIdx].firstKeptEntryId) {
            start = i;
            break;
          }
      }
      let end = path.findIndex((e, i) => i >= start && e.id === comp.firstKeptEntryId);
      if (end < 0) end = path.length;
      const blocks = path.slice(start, end).flatMap((e) => render(e, opts.dialect === "anthropic"));
      const transcript = escapeBoundaryTags(blocks.join("\n\n"));
      const lead = prevIdx >= 0 && typeof path[prevIdx].summary === "string" ? path[prevIdx].summary : "";
      const history = `${lead}\n${transcript}`;
      const questions: Case["questions"] = [];
      for (const q of bank.questions) {
        const facts = q.facts.map((sp) => expected(history, sp));
        if (facts.every((f): f is string => !!f)) questions.push({ id: q.id, kind: q.kind, facts: facts as string[] });
      }
      if (!questions.length) continue;
      cases.push({
        id: `${s.name}#${n}`,
        session: s.name,
        split: isHoldout(bank, s) ? "holdout" : "train",
        update: !!lead,
        lead,
        transcript,
        questions,
      });
    }
  }
  return cases;
}

// ---------- scoring ----------
export function score(item: Pick<Case, "questions">, summary: string | undefined) {
  const low = (summary ?? "").toLowerCase();
  const lost: { question: string; kind: string }[] = [];
  let kept = 0;
  let total = 0;
  for (const q of item.questions)
    for (const f of q.facts) {
      total++;
      if (low.includes(f.toLowerCase())) kept++;
      else lost.push({ question: q.id, kind: q.kind });
    }
  return { kept, total, lost };
}

/** The request omp's summarizer makes (compaction.ts:987-1001); the guidance lands in <additional-context>. */
export function summaryPrompt(item: Pick<Case, "update" | "lead" | "transcript">, guidance: string): string {
  let p = `<conversation>\n${item.transcript}\n</conversation>\n\n`;
  if (item.update) p += `<previous-summary>\n${escapeBoundaryTags(item.lead)}\n</previous-summary>\n\n`;
  if (guidance) p += `<additional-context>\n- ${guidance}\n</additional-context>\n\n`;
  return p + (item.update ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT);
}

/** Bank answers contained in `text` (lowercased). A candidate containing one would be teaching to the test. */
export function leaks(text: string, bank: Bank): string[] {
  const low = text.toLowerCase();
  const answers = [...new Set(bank.questions.flatMap((q) => q.facts.flat()).map((s) => s.toLowerCase()))];
  return answers.filter((a) => low.includes(a));
}

// ---------- the default generator: omp -p ----------
// The prompt travels as an `@<file>` argument, which omp's CLI inlines into the first message (omp
// cli/args.ts:386-393 collects `@` arguments, cli/file-processor.ts wraps a text file as <file name="...">), so
// it is not bound by the command-line length limit. omp skips file contents over 5 MiB (file-processor.ts:24),
// so stay well under that.
export const MAX_PROMPT_BYTES = 4_000_000;
const TASK_MESSAGE = "The attached file is the complete request. Do what it asks, using only its content. Do not call any tools. Reply with the requested text only.";

/** Runs a process with its stdin closed, collecting output; kills it after `timeoutMs`. */
export const runCommand: Exec = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: [opts.stdin, "pipe", "pipe"], cwd: opts.cwd });
    liveChildren.add(child);
    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      liveChildren.delete(child);
      if (timer) clearTimeout(timer);
      fn();
    };
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGKILL");
          done(() => reject(new Error(`${cmd} timed out after ${opts.timeoutMs} ms and was killed`)));
        }, opts.timeoutMs)
      : undefined;
    child.stdout!.on("data", (d) => (stdout += d));
    child.stderr!.on("data", (d) => (stderr += d));
    child.on("error", (e) => done(() => reject(new Error(`could not run ${cmd}: ${e.message}`))));
    child.on("close", (code) => done(() => resolve({ code: code ?? 1, stdout, stderr })));
  });

/**
 * `omp -p --no-tools --no-extensions --no-skills --no-rules --no-title --no-lsp --thinking high
 *  --system-prompt <file: omp's summarization system prompt> --model <id> --session-dir <temp> @<prompt file> "<task>"`,
 * stdin closed, cwd a fresh empty temp dir. Everything it creates is removed afterwards.
 * - The flags exist in omp (cli/args.ts, cli/flag-tables.ts); --thinking accepts off, minimal, low, medium, high,
 *   xhigh, max, auto (tui/src/thinking.ts:9, catalog/src/effort.ts); omp compacts at high by default
 *   (compaction.ts:651-655).
 * - --system-prompt takes text or, for a value with no newline, a file path (coding-agent system-prompt.ts:285-300),
 *   so the prompt file path is passed.
 * - omp still appends a <project-context> block (workstation lines, context files, workspace tree) to a custom
 *   system prompt (system-prompt.ts:1028-1036); an empty cwd keeps it minimal.
 */
export function createOmpGenerator(opts: { model: string; exec?: Exec; timeoutMs?: number }): Generate {
  const exec = opts.exec ?? runCommand;
  return async (prompt) => {
    const bytes = Buffer.byteLength(prompt);
    if (bytes > MAX_PROMPT_BYTES) throw new Error(`prompt is too large: ${bytes} bytes, over the ${MAX_PROMPT_BYTES}-byte limit for an omp @file`);
    const root = makeTemp("omp-evolve-run-");
    try {
      const sessionDir = join(root, "session");
      const cwd = join(root, "cwd");
      const file = join(root, "prompt.md");
      const systemFile = join(root, "system.md");
      mkdirSync(sessionDir);
      mkdirSync(cwd);
      writeFileSync(file, prompt);
      writeFileSync(systemFile, SUMMARIZATION_SYSTEM_PROMPT);
      const r = await exec(
        "omp",
        [
          "-p",
          "--no-tools",
          "--no-extensions",
          "--no-skills",
          "--no-rules",
          "--no-title",
          "--no-lsp",
          "--thinking",
          "high",
          "--system-prompt",
          systemFile,
          "--model",
          opts.model,
          "--session-dir",
          sessionDir,
          `@${file}`,
          TASK_MESSAGE,
        ],
        { stdin: "ignore", cwd, timeoutMs: opts.timeoutMs ?? 15 * 60 * 1000 },
      );
      if (r.code !== 0) {
        const out = `${r.stderr}\n${r.stdout}`.trim();
        if (QUOTA.test(out)) throw new QuotaError(out.slice(-300));
        throw new Error(`omp exited with code ${r.code}: ${out.slice(-300)}`);
      }
      return r.stdout.trim();
    } finally {
      removeTemp(root);
    }
  };
}

// ---------- the loop ----------
export const GUIDANCE_LIMIT = 2000;

interface Hist {
  round: number;
  candidate?: string;
  outcome: string;
}

const proposerPrompt = (o: { current: string; lost: { kind: string }[]; kept: number; total: number; history: Hist[] }) => {
  const byKind: Record<string, number> = {};
  for (const l of o.lost) byKind[l.kind] = (byKind[l.kind] ?? 0) + 1;
  const lost = Object.entries(byKind)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `- ${n}x ${k}`)
    .join("\n");
  const tried = o.history
    .slice(-4)
    .map((h) => `- (${h.outcome}) ${h.candidate ?? "[text withheld]"}`)
    .join("\n");
  return `You improve one part of the instructions a coding agent's conversation is summarized with when its context is compacted. After compaction the agent continues the work from the summary alone, so facts it needs and cannot easily look up again must survive.

The summarizer is given the conversation, then your text as additional context, then this fixed prompt (you cannot change it):
<fixed>
${SUMMARIZATION_PROMPT}
</fixed>

Current text${o.current ? "" : " (empty)"}:
<current>
${o.current}
</current>

On the training conversations the summaries kept ${o.kept} of ${o.total} facts the agent needed later. Facts lost, by kind:
${lost || "- (none)"}
${tried ? `\nEarlier candidates and what happened to them:\n${tried}\n` : ""}
Write a replacement for the current text. Rules:
- At most ${GUIDANCE_LIMIT} characters. Shorter is better; every sentence must earn its place.
- General guidance that would help on any project. Do not name hosts, IPs, ports, ticket ids, branch names, file paths, markers or other concrete values; a candidate containing a concrete value from the test conversations is discarded.
- Do not restate what the fixed prompt already says; add what it is missing or sharpen it where summaries still fail.
- No "<" or ">" characters.
Reply with the new text only, no quotes, no commentary.`;
};

export interface EvolveOptions {
  sessionsDir: string;
  bank: Bank;
  generate?: Generate;
  model?: string;
  exec?: Exec;
  dialect?: Dialect;
  targetDir?: string;
  /** Where journal copies go. When omitted, evolve makes one and removes it on every path. */
  tempRoot?: string;
  env?: Record<string, string | undefined>;
  baseline?: string;
  rounds?: number;
  samples?: number;
  margin?: number;
  maxPromptBytes?: number;
  dryRun?: boolean;
  say?: (line: string) => void;
}

export interface Tally {
  kept: number;
  total: number;
}
export interface EvolveResult {
  installed: boolean;
  dryRun?: boolean;
  reason: string;
  target: string;
  guidance: string;
  train: { before: Tally; after: Tally };
  holdout: { before: Tally; after: Tally };
  history: Hist[];
  skipped: Record<string, number>;
  /** Cases left out at baseline (oversize prompt or a failed generator call), with why. */
  dropped: { id: string; reason: string }[];
  cases: { train: number; holdout: number };
}

type CaseResult = { kept: number; total: number; lost: { question: string; kind: string }[]; failed?: string };

/**
 * Install `guidance.md` into the target dir only when a candidate keeps at least `margin` more facts on train and
 * no fewer on holdout. Otherwise nothing is written there and `reason` says why.
 *  - A case whose prompt is oversize or whose generator call fails at baseline is dropped and reported; if that
 *    empties a split the run stops. A candidate failing on a case that passed baseline scores 0 on that case.
 *  - A quota error, or a failing proposal request, stops the run with nothing installed.
 */
export async function evolve(o: EvolveOptions): Promise<EvolveResult> {
  // Everything that can be checked without work is checked first: no temp dir, no generator call.
  for (const [name, dflt] of [["rounds", 3], ["samples", 1], ["margin", 1]] as const) {
    const v = (o as any)[name] ?? dflt;
    if (!Number.isInteger(v) || v < 1) throw new Error(`${name} must be an integer >= 1, got ${v}`);
  }
  if (o.maxPromptBytes !== undefined && (!Number.isInteger(o.maxPromptBytes) || o.maxPromptBytes < 1))
    throw new Error(`maxPromptBytes must be an integer >= 1, got ${o.maxPromptBytes}`);
  if (o.targetDir !== undefined && !o.targetDir) throw new Error("targetDir must not be empty");
  validateBank(o.bank);
  const ownTemp = o.tempRoot === undefined;
  const tempRoot = o.tempRoot ?? makeTemp("omp-evolve-journals-");
  try {
    return await evolveIn(o, tempRoot);
  } finally {
    if (ownTemp) removeTemp(tempRoot);
  }
}

/** Throws a clear error for a bank that cannot be used: it would score nothing or match everything. */
export function validateBank(bank: unknown): asserts bank is Bank {
  const b = bank as any;
  if (!b || typeof b !== "object") throw new Error("bank must be an object with a questions array");
  if (b.holdout !== undefined && !(Array.isArray(b.holdout) && b.holdout.every((h: unknown) => typeof h === "string" && h)))
    throw new Error("bank.holdout must be an array of non-empty strings");
  if (!Array.isArray(b.questions) || !b.questions.length) throw new Error("bank.questions must be a non-empty array");
  b.questions.forEach((q: any, i: number) => {
    const at = `bank.questions[${i}]`;
    if (!q || typeof q.id !== "string" || !q.id) throw new Error(`${at} needs a string id`);
    if (!Array.isArray(q.facts) || !q.facts.length) throw new Error(`${at} (${q.id}) needs a non-empty facts array`);
    q.facts.forEach((f: any, j: number) => {
      if (!Array.isArray(f) || !f.length) throw new Error(`${at}.facts[${j}] (${q.id}) needs at least one spelling`);
      if (!f.every((sp: unknown) => typeof sp === "string" && sp.length > 0)) throw new Error(`${at}.facts[${j}] (${q.id}) has an empty or non-string spelling`);
    });
  });
}

async function evolveIn(o: EvolveOptions, tempRoot: string): Promise<EvolveResult> {
  const env = o.env ?? process.env;
  const target = o.targetDir ?? defaultTargetDir(env);
  const say = o.say ?? (() => {});
  const rounds = o.rounds ?? 3;
  const samples = Math.max(1, o.samples ?? 1);
  const margin = o.margin ?? 1;
  const maxPrompt = o.maxPromptBytes ?? MAX_PROMPT_BYTES;
  const empty: Tally = { kept: 0, total: 0 };
  const result: EvolveResult = {
    installed: false,
    reason: "",
    target,
    guidance: "",
    train: { before: empty, after: empty },
    holdout: { before: empty, after: empty },
    history: [],
    skipped: {},
    dropped: [],
    cases: { train: 0, holdout: 0 },
  };

  const sessions = loadJournals(o.sessionsDir, { tempRoot });
  const cases = buildCases(sessions, o.bank, { dialect: o.dialect ?? dialectFor(o.model) });
  result.skipped = countSkipped(sessions);
  let train = cases.filter((c) => c.split === "train");
  let holdout = cases.filter((c) => c.split === "holdout");
  result.cases = { train: train.length, holdout: holdout.length };
  // An empty split would make the "holdout does not drop" guard pass vacuously (and an empty train cannot improve).
  for (const [name, set] of [["train", train], ["holdout", holdout]] as const)
    if (!set.length) {
      result.reason = `no cases in the ${name} split (train ${train.length}, holdout ${holdout.length}; skipped compactions ${JSON.stringify(result.skipped)}); nothing evaluated, nothing written`;
      return result;
    }

  const generate = o.generate ?? (o.model ? createOmpGenerator({ model: o.model, exec: o.exec }) : undefined);
  if (!generate) {
    result.reason = "no generator: pass a generate function or a model";
    return result;
  }

  let baseline = o.baseline;
  if (baseline === undefined) {
    const file = join(target, "guidance.md");
    try {
      baseline = existsSync(file) ? readFileSync(file, "utf8") : "";
    } catch {
      baseline = "";
    }
    if (!baseline.trim()) baseline = DEFAULT_GUIDANCE;
  }

  const scoreCase = async (c: Case, guidance: string): Promise<CaseResult> => {
    const full = score(c, "");
    const prompt = summaryPrompt(c, guidance);
    const bytes = Buffer.byteLength(prompt);
    if (bytes > maxPrompt) return { kept: 0, total: full.total, lost: full.lost, failed: `prompt too large (${bytes} bytes, limit ${maxPrompt})` };
    let kept = 0;
    let last = full;
    for (let i = 0; i < samples; i++) {
      try {
        last = score(c, await generate(prompt, { purpose: "summary" }));
      } catch (e: any) {
        if (e instanceof QuotaError) throw e;
        return { kept: 0, total: full.total, lost: full.lost, failed: `generator failed: ${e?.message ?? e}` };
      }
      kept += last.kept;
    }
    return { kept: kept / samples, total: full.total, lost: last.lost };
  };
  const tally = (rs: CaseResult[]): Tally & { lost: CaseResult["lost"] } => ({
    kept: rs.reduce((a, r) => a + r.kept, 0),
    total: rs.reduce((a, r) => a + r.total, 0),
    lost: rs.flatMap((r) => r.lost),
  });
  // A candidate's failure on a case that passed baseline counts as 0 for that case.
  const evaluate = async (set: Case[], guidance: string) => {
    const rs: CaseResult[] = [];
    for (const c of set) rs.push(await scoreCase(c, guidance)); // one omp run at a time
    return tally(rs);
  };

  let cur = baseline;
  try {
    // Baseline: failures drop the case (loop.mjs semantics); the rest keep their baseline score.
    const base = new Map<string, CaseResult>();
    for (const c of [...train, ...holdout]) {
      const r = await scoreCase(c, cur);
      if (r.failed) result.dropped.push({ id: c.id, reason: r.failed });
      else base.set(c.id, r);
    }
    if (result.dropped.length) say(`left out at baseline: ${result.dropped.map((d) => `${d.id} (${d.reason})`).join("; ")}`);
    train = train.filter((c) => base.has(c.id));
    holdout = holdout.filter((c) => base.has(c.id));
    for (const [name, set] of [["train", train], ["holdout", holdout]] as const)
      if (!set.length) {
        result.reason = `no cases left in the ${name} split after dropping ${result.dropped.length} (${result.dropped.map((d) => `${d.id}: ${d.reason}`).join("; ")}); nothing installed`;
        return result;
      }
    let curTrain = tally(train.map((c) => base.get(c.id)!));
    let curHold = tally(holdout.map((c) => base.get(c.id)!));
    result.train = { before: { kept: curTrain.kept, total: curTrain.total }, after: { kept: curTrain.kept, total: curTrain.total } };
    result.holdout = { before: { kept: curHold.kept, total: curHold.total }, after: { kept: curHold.kept, total: curHold.total } };
    say(`baseline: train ${curTrain.kept}/${curTrain.total}, holdout ${curHold.kept}/${curHold.total}`);

    // What the proposer sees of earlier rounds. A leaking candidate is never repeated back, nor what it leaked.
    const shown: Hist[] = [];
    let accepted = false;
    for (let r = 1; r <= rounds; r++) {
      const raw = (await generate(proposerPrompt({ current: cur, lost: curTrain.lost, kept: curTrain.kept, total: curTrain.total, history: shown }), { purpose: "proposal" })).trim();
      const leaked = leaks(raw, o.bank);
      const bad = raw.length > GUIDANCE_LIMIT || /[<>]/.test(raw);
      if (!raw || leaked.length || bad) {
        const why = !raw ? "empty" : leaked.length ? `value leak: contains test values: ${leaked.join(", ")}` : `failed the check (${raw.length} chars, limit ${GUIDANCE_LIMIT}, or contains "<" or ">")`;
        result.history.push({ round: r, candidate: raw.slice(0, 300), outcome: `discarded: ${why}` });
        shown.push(leaked.length ? { round: r, outcome: "discarded: it leaked values from the test conversations" } : { round: r, candidate: raw.slice(0, 300), outcome: `discarded: ${why}` });
        say(`round ${r}: discarded, ${leaked.length ? "value leak" : why}`);
        continue;
      }
      const t = await evaluate(train, raw);
      if (t.kept < curTrain.kept + margin) {
        const out = `rejected: train ${t.kept}/${t.total} vs ${curTrain.kept}/${curTrain.total}, gain below margin ${margin}`;
        result.history.push({ round: r, candidate: raw, outcome: out });
        shown.push({ round: r, candidate: raw, outcome: out });
        say(`round ${r}: rejected, train ${t.kept}/${t.total}`);
        continue;
      }
      const h = await evaluate(holdout, raw);
      if (h.kept < curHold.kept) {
        const out = `rejected: better on train (${t.kept}/${t.total}) but holdout dropped ${h.kept}/${h.total} vs ${curHold.kept}/${curHold.total}`;
        result.history.push({ round: r, candidate: raw, outcome: out });
        shown.push({ round: r, candidate: raw, outcome: out });
        say(`round ${r}: rejected on holdout`);
        continue;
      }
      cur = raw;
      curTrain = t;
      curHold = h;
      accepted = true;
      const out = `accepted: train ${t.kept}/${t.total}, holdout ${h.kept}/${h.total}`;
      result.history.push({ round: r, candidate: raw, outcome: out });
      shown.push({ round: r, candidate: raw, outcome: out });
      result.train.after = { kept: t.kept, total: t.total };
      result.holdout.after = { kept: h.kept, total: h.total };
      say(`round ${r}: accepted`);
    }
    if (!accepted) {
      result.reason = `nothing installed: ${result.history.map((x) => `round ${x.round} ${x.outcome}`).join("; ") || "no rounds ran"}`;
      return result;
    }
  } catch (e: any) {
    result.reason = e instanceof QuotaError ? `stopped on quota: ${e.message}` : `generator failed: ${e?.message ?? e}`;
    return result;
  }

  result.guidance = cur;
  if (o.dryRun) {
    result.dryRun = true;
    result.reason = "dry run: the last accepted candidate would be installed; nothing written";
    return result;
  }
  // Write beside the target and rename, so a reader never sees a half-written guidance.md.
  const tmpFile = join(target, `.guidance.md.${process.pid}.${Date.now()}.tmp`);
  const untrack = trackTempFile(tmpFile);
  try {
    mkdirSync(target, { recursive: true });
    writeFileSync(tmpFile, cur);
    renameSync(tmpFile, join(target, "guidance.md"));
    untrack();
  } catch (e: any) {
    untrack();
    rmSync(tmpFile, { force: true });
    result.reason = `could not write ${join(target, "guidance.md")}: ${e?.message ?? e}`;
    return result;
  }
  result.installed = true;
  result.reason = `installed ${join(target, "guidance.md")}: train ${result.train.before.kept}->${result.train.after.kept}/${result.train.after.total}, holdout ${result.holdout.before.kept}->${result.holdout.after.kept}/${result.holdout.after.total}`;
  return result;
}

// ---------- CLI ----------
const USAGE =
  "usage: bun evolve.ts --sessions <dir> --bank <questions.json> --model <id> [--target <dir>] [--rounds N] [--samples N] [--margin N] [--dialect anthropic|generic] [--baseline-file <file>] [--dry-run]";

export interface CliOptions {
  sessions: string;
  bank: string;
  model: string;
  target?: string;
  /** omp profile whose agent dir to install into (as `omp --profile`); exclusive with target. */
  profile?: string;
  baselineFile?: string;
  dialect?: Dialect;
  rounds: number;
  samples: number;
  margin: number;
  dryRun: boolean;
}

const VALUE_FLAGS = ["sessions", "bank", "model", "target", "profile", "baseline-file", "dialect", "rounds", "samples", "margin"];

export function parseArgs(argv: string[]): { ok: true; value: CliOptions } | { ok: false; error: string } {
  const raw: Record<string, string> = {};
  const seen = new Set<string>();
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) return { ok: false, error: `unexpected argument "${a}"` };
    const eq = a.indexOf("=");
    const name = a.slice(2, eq < 0 ? undefined : eq);
    const inline = eq < 0 ? undefined : a.slice(eq + 1);
    if (name === "dry-run") {
      if (inline !== undefined) return { ok: false, error: "--dry-run takes no value" };
      if (seen.has(name)) return { ok: false, error: "--dry-run given more than once" };
      seen.add(name);
      dryRun = true;
      continue;
    }
    if (!VALUE_FLAGS.includes(name)) return { ok: false, error: `unknown flag --${name}` };
    if (seen.has(name)) return { ok: false, error: `--${name} given more than once` };
    seen.add(name);
    const value = inline ?? argv[++i];
    if (value === undefined || value === "") return { ok: false, error: `--${name} needs a non-empty value` };
    if (value.startsWith("-")) return { ok: false, error: `--${name} value "${value}" must not start with "-"` };
    raw[name] = value;
  }
  for (const k of ["sessions", "bank", "model"]) if (!raw[k]) return { ok: false, error: `missing --${k}` };
  const int = (k: string, dflt: number): number | string => {
    if (raw[k] === undefined) return dflt;
    return /^[0-9]+$/.test(raw[k]) && Number(raw[k]) >= 1 ? Number(raw[k]) : `--${k} must be an integer >= 1, got "${raw[k]}"`;
  };
  const rounds = int("rounds", 3);
  const samples = int("samples", 1);
  const margin = int("margin", 1);
  for (const v of [rounds, samples, margin]) if (typeof v === "string") return { ok: false, error: v };
  if (raw.profile !== undefined && raw.target !== undefined) return { ok: false, error: "--profile and --target cannot be combined" };
  if (raw.dialect !== undefined && raw.dialect !== "anthropic" && raw.dialect !== "generic") return { ok: false, error: `--dialect must be anthropic or generic, got "${raw.dialect}"` };
  return {
    ok: true,
    value: {
      sessions: raw.sessions,
      bank: raw.bank,
      model: raw.model,
      target: raw.target,
      profile: raw.profile,
      baselineFile: raw["baseline-file"],
      dialect: raw.dialect as Dialect | undefined,
      rounds: rounds as number,
      samples: samples as number,
      margin: margin as number,
      dryRun,
    },
  };
}

export interface MainDeps {
  evolve?: typeof evolve;
  log?: (line: string) => void;
  error?: (line: string) => void;
  /** Registers a signal handler and returns a function that removes it. Default: process.on / process.off. */
  onSignal?: (signal: "SIGINT" | "SIGTERM" | "SIGHUP", handler: () => void) => () => void;
  exit?: (code: number) => void;
  cleanup?: () => void;
}

/** Returns the process exit code: 0 when the run completed (installed or not), 2 for bad arguments, 1 on failure. */
export async function main(argv: string[], deps: MainDeps = {}): Promise<number> {
  const log = deps.log ?? ((l) => console.log(l));
  const error = deps.error ?? ((l) => console.error(l));
  const run = deps.evolve ?? evolve;
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    error(`${parsed.error}\n${USAGE}`);
    return 2;
  }
  const a = parsed.value;
  let bank: Bank;
  let baseline: string | undefined;
  try {
    bank = JSON.parse(readFileSync(a.bank, "utf8")) as Bank;
    baseline = a.baselineFile ? readFileSync(a.baselineFile, "utf8") : undefined;
    validateBank(bank);
  } catch (e: any) {
    error(`${e?.message ?? e}`);
    return 2;
  }
  // On SIGINT/SIGTERM: kill the omp child, remove the journal copies and run dirs, then exit 130 / 143.
  const onSignal =
    deps.onSignal ??
    ((sig, h) => {
      process.on(sig, h);
      return () => void process.off(sig, h);
    });
  const exit = deps.exit ?? ((c: number) => process.exit(c));
  const cleanup = deps.cleanup ?? cleanupLive;
  const codes = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 } as const;
  const disposers = (Object.keys(codes) as (keyof typeof codes)[]).map((sig) =>
    onSignal(sig, () => {
      cleanup();
      error(`${sig}: interrupted, cleaned up`);
      exit(codes[sig]);
    }),
  );
  try {
    const result = await run({
      sessionsDir: a.sessions,
      bank,
      model: a.model,
      dialect: a.dialect,
      targetDir: a.target ?? (a.profile !== undefined ? defaultTargetDir({ ...process.env, OMP_PROFILE: a.profile }) : undefined),
      baseline,
      rounds: a.rounds,
      samples: a.samples,
      margin: a.margin,
      dryRun: a.dryRun,
      say: log,
    });
    log(`cases: train ${result.cases.train}, holdout ${result.cases.holdout}; skipped compactions by method: ${JSON.stringify(result.skipped)}`);
    if (result.dropped?.length) log(`left out at baseline: ${result.dropped.map((d) => `${d.id} (${d.reason})`).join("; ")}`);
    log(result.reason);
    return 0;
  } catch (e: any) {
    error(`evolve failed: ${e?.message ?? e}`);
    return 1;
  } finally {
    for (const d of disposers) d();
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
