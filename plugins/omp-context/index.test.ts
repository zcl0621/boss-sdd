// Behaviour tests for the omp-context extension. They drive a fake `pi` / `ctx`
// and never touch ~/.omp: guidance files live in a temp dir.
//
// omp events used (omp 18.11.1, packages/coding-agent/src/extensibility):
//   input / tool_result            extensions/types.ts InputEvent, ToolResultEvent
//   session.compacting             shared-events.ts SessionCompactingEvent/Result ({context?: string[]})
//   session_compact                shared-events.ts SessionCompactEvent {compactionEntry, fromExtension};
//                                  fired for legacy compaction AND rollover (session-maintenance.ts:2486),
//                                  rollover entries carry details.kind === "experimental-context-rollover" (:1664, :1824)
//   turn_end                       near-budget check
//   message_end                    MessageEndEvent {message} (types.ts:1081): user prompts run through the agent
//                                  loop (agent/src/agent-loop.ts:621-642) in every mode, unlike `input`, which is
//                                  interactive-only (types.ts:1221). A `/skill:<name>` invocation is a message with
//                                  role "custom", customType "skill-prompt" (tui/src/chat/messages.ts:21) and
//                                  details.name (SkillPromptDetails, :60; built in modes/skill-command.ts:60-85).
// Threshold: the injected readSettings(ctx) returns the EFFECTIVE compaction trigger in tokens for the active model
//   (omp: describeModelCompactionPoint(settings, model).tokens, session/model-compaction-threshold.ts:37), so
//   compaction.modelThresholds and the reserve-based default are omp's job, not re-derived here.
// Delivery: the `context` event (types.ts:1480-1482, runner.ts emitContext :2009), called for every provider request
//   from sdk.ts:4253-4256 transformContext, in every mode (print mode runs the same AgentSession, print-mode.ts:112).
//   The extension returns {messages: [...event.messages, synthetic user message]}; nothing is persisted, no turn is
//   triggered and pi.sendMessage is never used.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import ompContext, { createSettingsReader, defaultGuidancePath } from "./index";

type Handler = (event: any, ctx: any) => any;

interface Sent {
  message: any;
  options: any;
}

function makeFakePi(opts: { execImpl?: (cmd: string, args: string[], o?: any) => Promise<any> } = {}) {
  const handlers = new Map<string, Handler[]>();
  const sent: Sent[] = []; // restore blocks, as observed through the context handler after each compaction
  const sendCalls: Sent[] = [];
  let lastPushed: string | undefined;
  const execCalls: { cmd: string; args: string[]; opts: any }[] = [];
  const defaultExec = async (_cmd: string, args: string[]) => {
    if (args[0] === "rev-parse") return { stdout: "feature/x\n", stderr: "", code: 0, killed: false };
    if (args[0] === "worktree")
      return {
        stdout: "/repo  abc1234 [main]\n/repo-wt/T5  def5678 [feature/x]\n",
        stderr: "",
        code: 0,
        killed: false,
      };
    return { stdout: "", stderr: "", code: 1, killed: false };
  };
  const pi = {
    on(event: string, h: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), h]);
    },
    sendMessage(message: any, options?: any) {
      sendCalls.push({ message, options });
    },
    async exec(cmd: string, args: string[], o?: any) {
      execCalls.push({ cmd, args, opts: o });
      return (opts.execImpl ?? defaultExec)(cmd, args, o);
    },
  };
  async function emitRaw(event: string, payload: any, ctx: any) {
    let last: any;
    for (const h of handlers.get(event) ?? []) {
      const r = await h({ type: event, ...payload }, ctx);
      if (r !== undefined) last = r;
    }
    return last;
  }
  async function emit(event: string, payload: any, ctx: any) {
    const r = await emitRaw(event, payload, ctx);
    if (event === "session_compact") {
      // Observe what the next provider request would carry; record each new restore text once.
      const probe = baseMessages();
      const c = await emitRaw("context", { messages: probe }, ctx);
      const t = (c?.messages ?? []).filter((m: any) => !probe.includes(m)).map(msgText).find((x: string) => x.startsWith(RESTORE));
      if (t !== undefined && t !== lastPushed) {
        lastPushed = t;
        sent.push({ message: { content: t }, options: {} });
      }
    }
    return r;
  }
  return { pi, handlers, sent, sendCalls, execCalls, emit };
}

function makeCtx(over: Record<string, any> = {}) {
  return {
    cwd: "/repo",
    sessionManager: { getSessionId: () => "s1", getBranch: () => [] },
    getContextUsage: () => ({ tokens: 10, contextWindow: 200000, percent: 0 }),
    ...over,
  };
}

const RESTORE = "Working set restored";
const NUDGE = "near the compaction threshold";
const msgText = (m: any): string =>
  typeof m?.content === "string" ? m.content : (m?.content ?? []).map((b: any) => b?.text ?? "").join("");
const baseMessages = () => [
  { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 },
  { role: "assistant", content: [{ type: "text", text: "yo" }], timestamp: 2 },
];
/** Texts of the messages the extension added to a provider request (empty when it returns nothing). */
async function appendedTexts(emit: any, ctx: any, messages: any[] = baseMessages()): Promise<string[]> {
  const r = await emit("context", { messages }, ctx);
  return r?.messages ? r.messages.filter((m: any) => !messages.includes(m)).map(msgText) : [];
}
const text = (s: string) => [{ type: "text", text: s }];
/** A user message as it entered the session (message_end): the only source of recorded user words. */
const said = (t: string) => ({ message: { role: "user", content: [{ type: "text", text: t }], attribution: "user" } });
const legacyCompaction = (id = "c1") => ({
  compactionEntry: { id, type: "compaction", summary: "s", details: undefined },
  fromExtension: false,
});
const rolloverCompaction = (id = "r1") => ({
  compactionEntry: { id, type: "compaction", summary: "s", details: { kind: "experimental-context-rollover", version: 1 } },
  fromExtension: false,
});
const settings = (over: Record<string, any> = {}) => async (_ctx?: any) => ({
  experimentalContextManagement: false,
  thresholdTokens: 100000,
  ...over,
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omp-context-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function setup(o: { settings?: any; guidancePath?: string | null; execImpl?: any; nudgeFraction?: number } = {}) {
  const fake = makeFakePi({ execImpl: o.execImpl });
  ompContext(fake.pi as any, {
    readSettings: o.settings ?? settings(),
    ...(o.guidancePath === null ? {} : { guidancePath: o.guidancePath ?? join(dir, "guidance.md") }),
    nudgeFraction: o.nudgeFraction,
  });
  return fake;
}

describe("registration", () => {
  test("listens to compaction events but never registers session_before_compact", () => {
    const { handlers } = setup();
    expect(handlers.has("session.compacting")).toBe(true);
    expect(handlers.has("session_compact")).toBe(true);
    expect(handlers.has("session_before_compact")).toBe(false);
  });
});

describe("restore block after legacy compaction", () => {
  test("carries user words, plan path + status, skills, branch and worktrees, once", async () => {
    const { emit, sent } = setup();
    const ctx = makeCtx();
    await emit("message_end", said("please keep the migration reversible"), ctx);
    await emit("message_end", said("and do not touch the main tree"), ctx);
    await emit(
      "tool_result",
      { toolName: "read", input: { path: "docs/plans/2026-10-16-x.md" }, content: text("# Plan\nStatus: In progress (T5)\nbody"), isError: false },
      ctx,
    );
    await emit(
      "tool_result",
      { toolName: "read", input: { path: "skill://plan-sdd" }, content: text("skill body"), isError: false },
      ctx,
    );
    await emit("session_compact", legacyCompaction(), ctx);

    expect(sent).toHaveLength(1);
    const body = typeof sent[0].message.content === "string" ? sent[0].message.content : JSON.stringify(sent[0].message.content);
    expect(body).toContain("please keep the migration reversible");
    expect(body).toContain("and do not touch the main tree");
    expect(body).toContain("docs/plans/2026-10-16-x.md");
    expect(body).toContain("Status: In progress (T5)");
    expect(body).toContain("plan-sdd");
    expect(body).toContain("feature/x");
    expect(body).toContain("/repo-wt/T5");
  });

  test("a plan written through the write tool is tracked from the written content", async () => {
    const { emit, sent } = setup();
    const ctx = makeCtx();
    await emit(
      "tool_result",
      { toolName: "write", input: { path: "docs/plans/new.md", content: "# T\nStatus: Draft\n" }, content: text("ok"), isError: false },
      ctx,
    );
    await emit("session_compact", legacyCompaction(), ctx);
    const body = String(sent[0].message.content);
    expect(body).toContain("docs/plans/new.md");
    expect(body).toContain("Status: Draft");
  });

  test("a read of a non-plan file does not become the active plan", async () => {
    const { emit, sent } = setup();
    const ctx = makeCtx();
    await emit(
      "tool_result",
      { toolName: "read", input: { path: "src/readme.md" }, content: text("Status: nope"), isError: false },
      ctx,
    );
    await emit("session_compact", legacyCompaction(), ctx);
    expect(String(sent[0].message.content)).not.toContain("src/readme.md");
  });

  test("user messages are bounded in count and size, newest kept", async () => {
    const { emit, sent } = setup();
    const ctx = makeCtx();
    for (let i = 0; i < 30; i++) await emit("message_end", said(`msg-${i} ${"z".repeat(5000)}`), ctx);
    await emit("session_compact", legacyCompaction(), ctx);
    const body = String(sent[0].message.content);
    expect(body).toContain("msg-29");
    expect(body).not.toContain("msg-0 ");
    expect(body.length).toBeLessThan(30000);
  });

  test("the same compaction entry is announced once; a new entry after new words gets a new block", async () => {
    const { emit, sent } = setup();
    const ctx = makeCtx();
    await emit("session_compact", legacyCompaction("c1"), ctx);
    await emit("session_compact", legacyCompaction("c1"), ctx);
    expect(sent).toHaveLength(1);
    await emit("message_end", said("something new"), ctx);
    await emit("session_compact", legacyCompaction("c2"), ctx);
    expect(sent).toHaveLength(2);
  });

  test("git is called through pi.exec with a timeout", async () => {
    const { emit, execCalls } = setup();
    await emit("session_compact", legacyCompaction(), makeCtx());
    expect(execCalls.length).toBeGreaterThan(0);
    for (const c of execCalls) {
      expect(c.cmd).toBe("git");
      expect(typeof c.opts?.timeout).toBe("number");
    }
  });
});

describe("restore block after rollover", () => {
  test("is thin: words, plan and git, no skills", async () => {
    const { emit, sent } = setup();
    const ctx = makeCtx();
    await emit("message_end", said("ship it carefully"), ctx);
    await emit(
      "tool_result",
      { toolName: "read", input: { path: "docs/plans/p.md" }, content: text("Status: Approved"), isError: false },
      ctx,
    );
    await emit(
      "tool_result",
      { toolName: "read", input: { path: "skill://plan-sdd" }, content: text("x"), isError: false },
      ctx,
    );
    await emit("session_compact", rolloverCompaction(), ctx);
    expect(sent).toHaveLength(1);
    const body = String(sent[0].message.content);
    expect(body).toContain("ship it carefully");
    expect(body).toContain("Status: Approved");
    expect(body).toContain("feature/x");
    expect(body).not.toContain("plan-sdd");
  });
});

describe("session.compacting", () => {
  test("returns summary requirements from the default text", async () => {
    const { emit } = setup();
    const r = await emit("session.compacting", { sessionId: "s1", messages: [] }, makeCtx());
    expect(Array.isArray(r.context)).toBe(true);
    const all = r.context.join("\n").toLowerCase();
    for (const k of ["verbatim", "status", "open", "worktree", "decision"]) expect(all).toContain(k);
  });

  test("uses guidance.md when present", async () => {
    writeFileSync(join(dir, "guidance.md"), "CUSTOM GUIDANCE LINE");
    const { emit } = setup();
    const r = await emit("session.compacting", { sessionId: "s1", messages: [] }, makeCtx());
    expect(r.context.join("\n")).toContain("CUSTOM GUIDANCE LINE");
  });

  test("an unreadable guidance path falls back to the default instead of throwing", async () => {
    mkdirSync(join(dir, "guidance.md")); // a directory: readFile fails
    const { emit } = setup();
    const r = await emit("session.compacting", { sessionId: "s1", messages: [] }, makeCtx());
    expect(r.context.join("\n").toLowerCase()).toContain("verbatim");
  });
});

describe("near-budget nudge (decided at turn_end, carried by the context event)", () => {
  const usage = (tokens: number) => () => ({ tokens, contextWindow: 200000, percent: tokens / 2000 });
  /** A turn ends with this ctx's usage (the decision point), then the next request is built. */
  const nudges = async (emit: any, ctx: any) => {
    await emit("turn_end", {}, ctx);
    return (await appendedTexts(emit, ctx)).filter(t => t.includes(NUDGE));
  };

  test("appended on every request once usage at a turn_end reaches the fraction of thresholdTokens, until the next compaction", async () => {
    const { emit, sendCalls } = setup({ nudgeFraction: 0.85 });
    const turn = (tokens: number) => emit("turn_end", {}, makeCtx({ getContextUsage: usage(tokens) }));
    const request = async (tokens = 10) => (await appendedTexts(emit, makeCtx({ getContextUsage: usage(tokens) }))).filter(t => t.includes(NUDGE));
    await turn(80000);
    expect(await request()).toHaveLength(0); // below 85% of 100000
    await turn(90000);
    expect(await request()).toHaveLength(1);
    expect(await request()).toHaveLength(1); // later request: still there
    await turn(10);
    expect(await request()).toHaveLength(1); // latched until compaction
    await emit("session_compact", legacyCompaction(), makeCtx());
    expect(await request(90000)).toHaveLength(0); // cleared; high live usage does not re-arm it before the next turn_end
    await turn(10);
    expect(await request()).toHaveLength(0);
    await turn(90000);
    expect(await request()).toHaveLength(1); // new window, armed again
    expect(sendCalls).toHaveLength(0);
  });

  test("compares against the effective threshold the reader reports (e.g. a modelThresholds fixed trigger on a 500k window)", async () => {
    const { emit } = setup({ settings: settings({ thresholdTokens: 90000 }), nudgeFraction: 0.9 });
    const big = (tokens: number) => () => ({ tokens, contextWindow: 500000, percent: tokens / 5000 });
    expect(await nudges(emit, makeCtx({ getContextUsage: big(70000) }))).toHaveLength(0); // 0.9 * 90000 = 81000
    expect(await nudges(emit, makeCtx({ getContextUsage: big(82000) }))).toHaveLength(1);
  });

  test("the reader receives the live ctx so it can resolve the active model", async () => {
    const seen: any[] = [];
    const { emit } = setup({ settings: async (c: any) => { seen.push(c); return { experimentalContextManagement: false, thresholdTokens: 100000 }; } });
    await emit("turn_end", {}, makeCtx({ model: { provider: "p", id: "m", contextWindow: 200000 } }));
    expect(seen[0]?.model?.id).toBe("m");
  });

  test("no effective threshold (compaction disabled / unresolved): stays quiet", async () => {
    const { emit } = setup({ settings: settings({ thresholdTokens: undefined }) });
    expect(await nudges(emit, makeCtx({ getContextUsage: usage(199000) }))).toHaveLength(0);
  });

  test("a throwing settings reader degrades to quiet", async () => {
    const { emit } = setup({ settings: async () => { throw new Error("import failed"); } });
    expect(await nudges(emit, makeCtx({ getContextUsage: usage(199000) }))).toHaveLength(0);
  });

  test("never in rollover (experimentalContextManagement) mode", async () => {
    const { emit } = setup({ settings: settings({ experimentalContextManagement: true }) });
    expect(await nudges(emit, makeCtx({ getContextUsage: usage(199000) }))).toHaveLength(0);
  });

  test("unknown mode (settings unreadable) stays quiet", async () => {
    const { emit } = setup({ settings: async () => undefined });
    expect(await nudges(emit, makeCtx({ getContextUsage: usage(199000) }))).toHaveLength(0);
  });

  test("getContextUsage undefined or throwing does not throw into omp", async () => {
    const { emit } = setup();
    expect(await nudges(emit, makeCtx({ getContextUsage: () => undefined }))).toHaveLength(0);
    expect(await nudges(emit, makeCtx({ getContextUsage: () => { throw new Error("boom"); } }))).toHaveLength(0);
  });
});

describe("restore block through the context event", () => {
  test("nothing is appended before any compaction (handler returns no change)", async () => {
    const { emit } = setup();
    const msgs = baseMessages();
    const r = await emit("context", { messages: msgs }, makeCtx());
    expect(r === undefined || r.messages.length === msgs.length).toBe(true);
  });

  test("present after a compaction, as one synthetic user message right after the first user message, and on later requests", async () => {
    const { emit, sendCalls } = setup();
    const ctx = makeCtx();
    await emit("message_end", said("keep this"), ctx);
    await emit("session_compact", legacyCompaction(), ctx);
    const msgs = baseMessages();
    const r = await emit("context", { messages: msgs }, ctx);
    expect(r.messages).toHaveLength(msgs.length + 1);
    const block = r.messages[1]; // baseMessages(): [user, assistant]; the block follows the user message
    expect(r.messages[0]).toBe(msgs[0]);
    expect(r.messages[2]).toBe(msgs[1]);
    expect(block.role).toBe("user");
    expect(block.synthetic).toBe(true);
    expect("attribution" in block).toBe(false);
    expect(block.timestamp).toBe(0); // a real timestamp makes anthropic.ts:5869 flushCompactionFiles replay the summary files
    expect(block.content[0].type).toBe("text");
    expect(block.content[0].text).toContain(RESTORE);
    expect(block.content[0].text).toContain("keep this");
    for (let i = 0; i < 3; i++) expect((await appendedTexts(emit, ctx)).some(t => t.includes("keep this"))).toBe(true);
    expect(sendCalls).toHaveLength(0); // nothing goes through pi.sendMessage
  });

  test("messages are never mutated in place: the input array and its elements are untouched", async () => {
    const { emit } = setup();
    const ctx = makeCtx();
    await emit("session_compact", legacyCompaction(), ctx);
    const msgs = baseMessages();
    const frozen = msgs.map(m => Object.freeze({ ...m }));
    Object.freeze(frozen);
    const r = await emit("context", { messages: frozen }, ctx);
    expect(r.messages).not.toBe(frozen);
    expect(frozen).toHaveLength(2);
    expect(r.messages[0]).toBe(frozen[0]); // the block sits after the first user message, originals untouched
    expect(r.messages[2]).toBe(frozen[1]);
  });

  test("replaced (not stacked) after the next compaction, rebuilt from current state", async () => {
    const { emit } = setup();
    const ctx = makeCtx();
    await emit("message_end", said("first words"), ctx);
    await emit("session_compact", legacyCompaction("c1"), ctx);
    await emit("message_end", said("second words"), ctx);
    expect((await appendedTexts(emit, ctx)).join("\n")).not.toContain("second words"); // block is the c1 snapshot
    await emit("session_compact", legacyCompaction("c2"), ctx);
    const texts = (await appendedTexts(emit, ctx)).filter(t => t.startsWith(RESTORE));
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain("second words");
  });

  test("an identical rebuild is not skipped: a second compaction with no new words still leaves one block in place", async () => {
    const { emit } = setup();
    const ctx = makeCtx();
    await emit("message_end", said("same state"), ctx);
    await emit("session_compact", legacyCompaction("c1"), ctx);
    await emit("session_compact", legacyCompaction("c2"), ctx); // e.g. dead-end recovery with a new entry id
    const texts = (await appendedTexts(emit, ctx)).filter(t => t.startsWith(RESTORE));
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain("same state");
  });

  test("the same entry id again does not rebuild the block", async () => {
    const { emit } = setup();
    const ctx = makeCtx();
    await emit("session_compact", legacyCompaction("c1"), ctx);
    await emit("message_end", said("after c1"), ctx);
    await emit("session_compact", legacyCompaction("c1"), ctx);
    expect((await appendedTexts(emit, ctx)).join("\n")).not.toContain("after c1");
  });

  test("a rollover block is thin and also persists across requests", async () => {
    const { emit } = setup();
    const ctx = makeCtx();
    await emit("tool_result", { toolName: "read", input: { path: "skill://plan-sdd" }, content: text("x"), isError: false }, ctx);
    await emit("message_end", said("thin please"), ctx);
    await emit("session_compact", rolloverCompaction(), ctx);
    for (let i = 0; i < 2; i++) {
      const t = (await appendedTexts(emit, ctx)).find(x => x.startsWith(RESTORE)) ?? "";
      expect(t).toContain("thin please");
      expect(t).not.toContain("plan-sdd");
    }
  });

  test("restore and nudge share ONE synthetic message when both apply (stable message count)", async () => {
    const { emit } = setup();
    await emit("session_compact", legacyCompaction(), makeCtx());
    const hot = makeCtx({ getContextUsage: () => ({ tokens: 95000, contextWindow: 200000, percent: 47 }) });
    await emit("turn_end", {}, hot);
    const texts = await appendedTexts(emit, hot);
    expect(texts).toHaveLength(1);
    expect(texts[0].startsWith(RESTORE)).toBe(true);
    expect(texts[0]).toContain(NUDGE);
  });

  test("the extra text is identical on every request in a window, whatever the live token count does", async () => {
    const { emit } = setup();
    const at = (tokens: number) => makeCtx({ getContextUsage: () => ({ tokens, contextWindow: 200000, percent: 0 }) });
    await emit("turn_end", {}, at(90000));
    const first = await appendedTexts(emit, at(90000));
    await Bun.sleep(5);
    const second = await appendedTexts(emit, at(97000));
    const third = await appendedTexts(emit, at(91234));
    expect(first).toHaveLength(1);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  const user = (t: string, extra: any = {}) => ({ role: "user", content: [{ type: "text", text: t }], timestamp: 9, ...extra });
  const asst = (t: string) => ({ role: "assistant", content: [{ type: "text", text: t }], timestamp: 9 });
  const summary = () => ({ role: "compactionSummary", summary: "s", timestamp: 5 });
  const toolRes = () => ({ role: "toolResult", toolCallId: "t9", toolName: "read", content: [{ type: "text", text: "r" }], timestamp: 9 });
  const isBlock = (m: any) => m?.synthetic === true && msgText(m).startsWith(RESTORE);

  test("a leading compactionSummary: the block goes at index 1, whatever follows", async () => {
    const { emit } = setup();
    const ctx = makeCtx();
    await emit("session_compact", legacyCompaction(), ctx);
    const custom = { role: "custom", customType: "x", content: "c", timestamp: 1 };
    for (const rest of [[custom, user("u1"), asst("a1")], [user("u1")], [asst("a1"), asst("a2")], [], [toolRes()]]) {
      const msgs = [summary(), ...rest];
      const r = (await emit("context", { messages: msgs }, ctx)).messages;
      expect(r[0]).toBe(msgs[0]);
      expect(r[1]).toSatisfy(isBlock);
      expect(r.slice(2)).toEqual(rest);
    }
  });

  test("no leading summary: immediately after the first non-synthetic user message, not after a custom message", async () => {
    const { emit } = setup();
    const ctx = makeCtx();
    await emit("session_compact", legacyCompaction(), ctx);
    const custom = { role: "custom", customType: "x", content: "c", timestamp: 1 };
    const msgs = [custom, user("u1"), asst("a1"), user("u2")];
    const r = (await emit("context", { messages: msgs }, ctx)).messages;
    expect(r.findIndex(isBlock)).toBe(2);
    expect(r[1]).toBe(msgs[1]);
    expect(r.filter(isBlock)).toHaveLength(1);
  });

  test("a synthetic user message does not count as the first user message", async () => {
    const { emit } = setup();
    const ctx = makeCtx();
    await emit("session_compact", legacyCompaction(), ctx);
    const synth = user("synthetic reminder", { synthetic: true });
    const real = user("real");
    const r = (await emit("context", { messages: [synth, real, asst("a")] }, ctx)).messages;
    expect(r[2]).toSatisfy(isBlock);
    expect(r[1]).toBe(real);
  });

  test("the first non-synthetic user message stays the first user message when there is no leading summary", async () => {
    const { emit } = setup();
    const ctx = makeCtx();
    await emit("session_compact", legacyCompaction(), ctx);
    const u1 = user("u1");
    const r = (await emit("context", { messages: [asst("a0"), u1, asst("a")] }, ctx)).messages;
    expect(r.find((m: any) => m.role === "user")).toBe(u1);
  });

  test("no leading summary and no user message: nothing is inserted", async () => {
    const { emit } = setup();
    const ctx = makeCtx({ getContextUsage: () => ({ tokens: 95000, contextWindow: 200000, percent: 0 }) });
    await emit("session_compact", legacyCompaction(), ctx);
    await emit("turn_end", {}, ctx);
    for (const msgs of [[], [asst("a")], [asst("a"), toolRes()]]) {
      expect(await emit("context", { messages: msgs }, ctx)).toBeUndefined();
    }
  });

  // omp builds the summarizer request from history and history+retained, then cuts the second at
  // len(convert(history)) (session/agent-session.ts:2380-2403). Both conversions start with the same summary, so a
  // summary-led request carries the block at index 1 in both; without a summary a user message in history sits at the
  // same index in both, and one only in retained lies after the cut. Either way the prefix is exactly convert(history).
  describe("summarizer cut alignment", () => {
    const toolCall = () => ({ role: "assistant", content: [{ type: "toolCall", id: "t1", name: "read", arguments: {} }], timestamp: 3 });
    const toolResult = () => ({ role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "text", text: "r" }], timestamp: 4 });
    const cases: [string, () => any[], () => any[]][] = [
      ["history has a user message (tool call at the cut)", () => [summary(), user("u1"), toolCall()], () => [toolResult(), asst("done"), user("u2")]],
      ["summary-led, history without a user message", () => [summary(), toolCall()], () => [toolResult(), asst("done"), user("u2")]],
      ["summary-led, no user message anywhere", () => [summary(), toolCall()], () => [toolResult(), asst("done")]],
      ["summary-led, only assistant/tool turns retained", () => [summary(), user("u1"), toolCall()], () => [toolResult(), asst("done")]],
      ["no summary, user message only in retained", () => [asst("a0"), toolCall()], () => [toolResult(), user("u2"), asst("done")]],
      ["summary-only history, retained assistant turns", () => [summary()], () => [asst("a1"), asst("a2"), user("u2")]],
      ["no summary, no user message anywhere", () => [asst("a0"), toolCall()], () => [toolResult(), asst("done")]],
      ["no leading summary", () => [user("u1"), toolCall()], () => [toolResult(), asst("done")]],
    ];
    for (const withNudge of [false, true]) {
      for (const [name, mkHistory, mkRetained] of cases) {
        test(`prefix of convert(history+retained) equals convert(history): ${name} (nudge=${withNudge})`, async () => {
          const { emit } = setup();
          const ctx = makeCtx(withNudge ? { getContextUsage: () => ({ tokens: 95000, contextWindow: 200000, percent: 0 }) } : {});
          if (withNudge) await emit("turn_end", {}, ctx);
          await emit("input", { text: "words", source: "interactive" }, ctx);
          await emit("session_compact", legacyCompaction(), ctx);
          if (withNudge) await emit("turn_end", {}, ctx);
          const history = mkHistory();
          const retained = mkRetained();
          const run = async (msgs: any[]) => (await emit("context", { messages: msgs }, ctx))?.messages ?? msgs;
          const convertH = await run(history);
          await Bun.sleep(5);
          const convertHR = await run([...history, ...retained]);
          const prefixLength = convertH.length;
          expect(convertHR.slice(0, prefixLength)).toEqual(convertH);
          expect(convertHR[prefixLength]).toBe(retained[0]); // the cut lands on the first retained message
          // the originals keep their relative order
          expect(convertHR.filter((m: any) => !isBlock(m))).toEqual([...history, ...retained]);
        });
      }
    }
  });

  test("a throwing handler path never throws into omp", async () => {
    const { emit } = setup();
    const r = await emit("context", { messages: undefined }, makeCtx());
    expect(r).toBeUndefined();
  });
});

describe("degradation", () => {
  test("git missing: block is still sent, without git lines", async () => {
    const { emit, sent } = setup({ execImpl: async () => { throw new Error("spawn git ENOENT"); } });
    const ctx = makeCtx();
    await emit("message_end", said("remember this"), ctx);
    await emit("session_compact", legacyCompaction(), ctx);
    expect(sent).toHaveLength(1);
    const body = String(sent[0].message.content);
    expect(body).toContain("remember this");
    expect(body).not.toContain("feature/x");
  });

  test("git nonzero exit is treated as no git info", async () => {
    const { emit, sent } = setup({ execImpl: async () => ({ stdout: "", stderr: "fatal", code: 128, killed: false }) });
    await emit("session_compact", legacyCompaction(), makeCtx());
    expect(sent).toHaveLength(1);
  });

});

describe("user words in every mode", () => {
  const userMsg = (t: string) => ({ message: { role: "user", content: [{ type: "text", text: t }], attribution: "user" } });

  test("a user message seen only through message_end (print mode, no input event) is kept", async () => {
    const { emit, sent } = setup();
    const ctx = makeCtx();
    await emit("message_end", userMsg("print mode words"), ctx);
    await emit("session_compact", legacyCompaction(), ctx);
    expect(String(sent[0].message.content)).toContain("print mode words");
  });

  test("string content is accepted and assistant messages are ignored", async () => {
    const { emit, sent } = setup();
    const ctx = makeCtx();
    await emit("message_end", { message: { role: "user", content: "plain string words" } }, ctx);
    await emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "assistant chatter" }] } }, ctx);
    await emit("session_compact", legacyCompaction(), ctx);
    const body = String(sent[0].message.content);
    expect(body).toContain("plain string words");
    expect(body).not.toContain("assistant chatter");
  });

  test("the same words arriving through input and message_end in one turn are listed once", async () => {
    const { emit, sent } = setup();
    const ctx = makeCtx();
    await emit("input", { text: "only once please", source: "interactive" }, ctx);
    await emit("message_end", userMsg("only once please"), ctx);
    await emit("session_compact", legacyCompaction(), ctx);
    const body = String(sent[0].message.content);
    expect(body.split("only once please").length - 1).toBe(1);
  });

  test("the same words sent again in a later turn are kept twice", async () => {
    const { emit, sent } = setup();
    const ctx = makeCtx();
    for (let turn = 0; turn < 2; turn++) {
      await emit("input", { text: "again and again", source: "interactive" }, ctx);
      await emit("message_end", userMsg("again and again"), ctx);
      await emit("turn_end", {}, ctx);
    }
    await emit("session_compact", legacyCompaction(), ctx);
    const body = String(sent[0].message.content);
    expect(body.split("again and again").length - 1).toBe(2);
  });

  test("print mode (message_end only) repeating the same words in later turns keeps both", async () => {
    const { emit, sent } = setup();
    const ctx = makeCtx();
    for (let turn = 0; turn < 2; turn++) {
      await emit("message_end", userMsg("repeat me"), ctx);
      await emit("turn_end", {}, ctx);
    }
    await emit("session_compact", legacyCompaction(), ctx);
    expect(String(sent[0].message.content).split("repeat me").length - 1).toBe(2);
  });
});

describe("skills loaded with /skill:<name>", () => {
  const skillMsg = (name: string) => ({
    message: {
      role: "custom",
      customType: "skill-prompt",
      content: "skill text",
      details: { name, path: `/skills/${name}/SKILL.md`, lineCount: 3 },
      attribution: "user",
    },
  });

  test("a skill-prompt custom message adds the skill name; the skill:// read path still works", async () => {
    const { emit, sent } = setup();
    const ctx = makeCtx();
    await emit("message_end", skillMsg("shuorenhua"), ctx);
    await emit("tool_result", { toolName: "read", input: { path: "skill://plan-sdd" }, content: text("x"), isError: false }, ctx);
    await emit("session_compact", legacyCompaction(), ctx);
    const body = String(sent[0].message.content);
    expect(body).toContain("shuorenhua");
    expect(body).toContain("plan-sdd");
  });

  test("a skill-prompt message does not leak its body into the user words", async () => {
    const { emit, sent } = setup();
    const ctx = makeCtx();
    await emit("message_end", skillMsg("s1x"), ctx);
    await emit("session_compact", legacyCompaction(), ctx);
    expect(String(sent[0].message.content)).not.toContain("skill text");
  });
});

describe("per session", () => {
  const ctxFor = (id: string) => makeCtx({ sessionManager: { getSessionId: () => id, getBranch: () => [] } });

  test("a second session starts empty and the first is unaffected", async () => {
    const { emit, sent } = setup();
    await emit("message_end", said("words of session A"), ctxFor("A"));
    await emit(
      "tool_result",
      { toolName: "read", input: { path: "docs/plans/a.md" }, content: text("Status: A-status"), isError: false },
      ctxFor("A"),
    );
    await emit("session_compact", legacyCompaction("cB"), ctxFor("B"));
    const bodyB = String(sent[0].message.content);
    expect(bodyB).not.toContain("words of session A");
    expect(bodyB).not.toContain("A-status");

    await emit("message_end", said("words of session B"), ctxFor("B"));
    await emit("session_compact", legacyCompaction("cA"), ctxFor("A"));
    const bodyA = String(sent[1].message.content);
    expect(bodyA).toContain("words of session A");
    expect(bodyA).toContain("A-status");
    expect(bodyA).not.toContain("words of session B");
  });

  test("the restore block of one session is not shown to another", async () => {
    const { emit } = setup();
    await emit("message_end", said("only A"), ctxFor("A"));
    await emit("session_compact", legacyCompaction("cA"), ctxFor("A"));
    expect((await appendedTexts(emit, ctxFor("A"))).join("\n")).toContain("only A");
    expect(await appendedTexts(emit, ctxFor("B"))).toHaveLength(0);
  });

  test("a nudge in one session does not affect another", async () => {
    const { emit } = setup();
    const hot = (id: string, tokens: number) =>
      makeCtx({ sessionManager: { getSessionId: () => id, getBranch: () => [] }, getContextUsage: () => ({ tokens, contextWindow: 200000, percent: 0 }) });
    await emit("turn_end", {}, hot("A", 95000));
    await emit("turn_end", {}, hot("B", 10));
    expect((await appendedTexts(emit, hot("A", 95000))).some(t => t.includes(NUDGE))).toBe(true);
    expect((await appendedTexts(emit, hot("B", 10))).some(t => t.includes(NUDGE))).toBe(false);
  });
});

describe("default guidance path", () => {
  test("defaultGuidancePath() is guidance.md next to index.ts (a pure value; nothing is written)", () => {
    expect(defaultGuidancePath()).toBe(join(dirname(fileURLToPath(new URL("./index.ts", import.meta.url))), "guidance.md"));
  });
});

describe("plan file changed through the edit tool", () => {
  // omp's default edit mode is hashline: input is { input: string } with no path. The path is reliably in
  // result details: details.path (absolute; move target on rename) or details.perFileResults[].path
  // (edit/index.ts:243-270 aggregateDetails). `edits[].path` is renderer-only and not used.
  const planDir = () => {
    mkdirSync(join(dir, "docs", "plans"), { recursive: true });
    return join(dir, "docs", "plans");
  };
  const readOld = (path: string) => ({ toolName: "read", input: { path }, content: text("Status: Old"), isError: false });

  test("hashline shape: no input.path, details.path absolute; Status refreshes from disk", async () => {
    const plan = join(planDir(), "e.md");
    writeFileSync(plan, "# P\nStatus: Old\n");
    const { emit, sent } = setup();
    const ctx = makeCtx({ cwd: dir });
    await emit("tool_result", readOld("docs/plans/e.md"), ctx);
    writeFileSync(plan, "# P\nStatus: New\n");
    await emit(
      "tool_result",
      { toolName: "edit", input: { input: "@@ docs/plans/e.md\n- Status: Old\n+ Status: New" }, content: text("Edited"), details: { path: plan, diff: "-Status: Old\n+Status: New" }, isError: false },
      ctx,
    );
    await emit("session_compact", legacyCompaction(), ctx);
    const body = String(sent[0].message.content);
    expect(body).toContain("Status: New");
    expect(body).not.toContain("Status: Old");
  });

  test("a hashline edit of a plan not yet seen makes it the active plan", async () => {
    const plan = join(planDir(), "fresh.md");
    writeFileSync(plan, "# P\nStatus: Fresh\n");
    const { emit, sent } = setup();
    const ctx = makeCtx({ cwd: dir });
    await emit("tool_result", { toolName: "edit", input: { input: "x" }, content: text("ok"), details: { path: plan, diff: "" }, isError: false }, ctx);
    await emit("session_compact", legacyCompaction(), ctx);
    const body = String(sent[0].message.content);
    expect(body).toContain("fresh.md");
    expect(body).toContain("Status: Fresh");
  });

  test("replace mode: relative input.path still works", async () => {
    const plan = join(planDir(), "r.md");
    writeFileSync(plan, "# P\nStatus: Replaced\n");
    const { emit, sent } = setup();
    const ctx = makeCtx({ cwd: dir });
    await emit(
      "tool_result",
      { toolName: "edit", input: { path: "docs/plans/r.md", old_string: "a", new_string: "b" }, content: text("ok"), isError: false },
      ctx,
    );
    await emit("session_compact", legacyCompaction(), ctx);
    const body = String(sent[0].message.content);
    expect(body).toContain("docs/plans/r.md");
    expect(body).toContain("Status: Replaced");
  });

  test("multi-file: perFileResults paths; the plan refreshes and the non-plan file is ignored", async () => {
    const plan = join(planDir(), "m.md");
    writeFileSync(plan, "# P\nStatus: Multi\n");
    const other = join(dir, "src", "code.ts");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(other, "Status: not a plan\n");
    const { emit, sent } = setup();
    const ctx = makeCtx({ cwd: dir });
    await emit(
      "tool_result",
      {
        toolName: "edit",
        input: { input: "multi" },
        content: text("ok"),
        details: { diff: "", perFileResults: [{ path: other, diff: "" }, { path: plan, diff: "" }] },
        isError: false,
      },
      ctx,
    );
    await emit("session_compact", legacyCompaction(), ctx);
    const body = String(sent[0].message.content);
    expect(body).toContain("m.md");
    expect(body).toContain("Status: Multi");
    expect(body).not.toContain("code.ts");
    expect(body).not.toContain("not a plan");
  });

  test("an absolute plan path is recognised as docs/plans/*.md (read and write)", async () => {
    const abs = join(planDir(), "abs.md");
    const { emit, sent } = setup();
    const ctx = makeCtx({ cwd: dir });
    await emit("tool_result", { toolName: "read", input: { path: abs }, content: text("Status: Abs"), isError: false }, ctx);
    await emit("session_compact", legacyCompaction("c1"), ctx);
    expect(String(sent[0].message.content)).toContain("Status: Abs");
    await emit(
      "tool_result",
      { toolName: "write", input: { path: abs, content: "# T\nStatus: AbsWritten\n" }, content: text("ok"), isError: false },
      ctx,
    );
    await emit("session_compact", legacyCompaction("c2"), ctx);
    expect(String(sent[1].message.content)).toContain("Status: AbsWritten");
  });

  test("an unreadable edited plan keeps the path and drops the stale status", async () => {
    const { emit, sent } = setup();
    const ghost = join(dir, "nowhere", "docs", "plans", "gone.md");
    const ctx = makeCtx({ cwd: join(dir, "nowhere") });
    await emit("tool_result", { toolName: "read", input: { path: ghost }, content: text("Status: Old"), isError: false }, ctx);
    await emit("tool_result", { toolName: "edit", input: { input: "x" }, content: text("ok"), details: { path: ghost, diff: "" }, isError: false }, ctx);
    await emit("session_compact", legacyCompaction(), ctx);
    const body = String(sent[0].message.content);
    expect(body).toContain("gone.md");
    expect(body).not.toContain("Status: Old");
  });
});

describe("default settings reader (decision 9 fallback)", () => {
  const scope = { fake: "settings" };
  const piWith = () => ({ pi: { settings: scope } }) as any;
  const registry = (values: Record<string, unknown>) => ({
    lookup: (id: string) => (id in values ? { get: (s: unknown) => (s === scope ? values[id] : "WRONG SCOPE") } : undefined),
  });

  test("with fake omp modules it yields mode + effective threshold tokens for the ctx model", async () => {
    const model = { provider: "p", id: "m", contextWindow: 500000 };
    const seen: any[] = [];
    const read = createSettingsReader(piWith(), {
      registry: async () => registry({ "compaction.experimentalContextManagement": false }),
      threshold: async () => ({
        describeModelCompactionPoint: (s: unknown, m: unknown) => {
          seen.push([s, m]);
          return { tokens: 123456 };
        },
      }),
    });
    expect(await read({ model })).toEqual({ experimentalContextManagement: false, thresholdTokens: 123456 });
    expect(seen[0][0]).toBe(scope);
    expect(seen[0][1]).toBe(model);
  });

  test("mode true is reported as true", async () => {
    const read = createSettingsReader(piWith(), {
      registry: async () => registry({ "compaction.experimentalContextManagement": true }),
      threshold: async () => ({ describeModelCompactionPoint: () => ({ tokens: 1 }) }),
    });
    expect((await read({ model: {} }))?.experimentalContextManagement).toBe(true);
  });

  test("registry module fails to load: undefined, no throw", async () => {
    const read = createSettingsReader(piWith(), {
      registry: async () => { throw new Error("Cannot find package"); },
      threshold: async () => ({ describeModelCompactionPoint: () => ({ tokens: 1 }) }),
    });
    expect(await read({ model: {} })).toBeUndefined();
  });

  test("garbage modules (no lookup, unknown id, non-boolean): undefined, no throw", async () => {
    for (const reg of [{}, registry({}), registry({ "compaction.experimentalContextManagement": "yes" })]) {
      const read = createSettingsReader(piWith(), { registry: async () => reg, threshold: async () => ({}) });
      expect(await read({ model: {} })).toBeUndefined();
    }
  });

  test("threshold module fails or returns garbage: mode kept, thresholdTokens undefined", async () => {
    for (const threshold of [
      async () => { throw new Error("nope"); },
      async () => ({}),
      async () => ({ describeModelCompactionPoint: () => { throw new Error("bad"); } }),
      async () => ({ describeModelCompactionPoint: () => ({ tokens: "lots" }) }),
      async () => ({ describeModelCompactionPoint: () => ({}) }),
    ]) {
      const read = createSettingsReader(piWith(), {
        registry: async () => registry({ "compaction.experimentalContextManagement": false }),
        threshold,
      });
      expect(await read({ model: {} })).toEqual({ experimentalContextManagement: false, thresholdTokens: undefined });
    }
  });

  test("no model on ctx: thresholdTokens undefined", async () => {
    const read = createSettingsReader(piWith(), {
      registry: async () => registry({ "compaction.experimentalContextManagement": false }),
      threshold: async () => ({ describeModelCompactionPoint: () => ({ tokens: 5 }) }),
    });
    expect(await read({})).toEqual({ experimentalContextManagement: false, thresholdTokens: undefined });
  });

  test("the extension with a failing default reader never nudges and never throws", async () => {
    const fake = makeFakePi();
    ompContext(fake.pi as any, { guidancePath: join(dir, "g.md"), loadModules: { registry: async () => { throw new Error("x"); }, threshold: async () => ({}) } });
    const hot = makeCtx({ getContextUsage: () => ({ tokens: 199000, contextWindow: 200000, percent: 99 }) });
    await fake.emit("turn_end", {}, hot);
    const texts = await appendedTexts(fake.emit, hot);
    expect(texts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------
// Rework round: delivery timing, repeat suppression, filtering, selectors, env fraction, bounded state
// ---------------------------------------------------------------------------------------------------

describe("what counts as user words", () => {
  test("input events are ignored: typed text, slash commands and shell escapes are not recorded from input", async () => {
    const { emit, sent } = setup();
    const ctx = makeCtx();
    for (const t of ["typed but swallowed", "/compact now", "/skill:plan-sdd go", "!ls -la", "  /model x"])
      await emit("input", { text: t, source: "interactive" }, ctx);
    await emit("message_end", said("real words"), ctx); // what reached the session as a user message
    await emit("session_compact", legacyCompaction(), ctx);
    const body = String(sent[0].message.content);
    expect(body).toContain("real words");
    for (const t of ["typed but swallowed", "/compact", "/skill:plan-sdd go", "!ls", "/model x"]) expect(body).not.toContain(t);
  });

  test("a prompt template / file-based slash command arrives expanded at message_end and is recorded, cut to 1000 characters", async () => {
    // slash-commands.ts:124-141, agent-session.ts:7380-7397: the expanded text is the user message
    const { emit, sent } = setup();
    const ctx = makeCtx();
    const expanded = `Review the diff for correctness. ${"x".repeat(1200)} END-OF-TEMPLATE`;
    await emit("message_end", said(expanded), ctx);
    await emit("session_compact", legacyCompaction(), ctx);
    const body = String(sent[0].message.content);
    expect(body).toContain(`- ${expanded.slice(0, 1000)}\n`);
    expect(body).not.toContain("END-OF-TEMPLATE");
  });

  test("synthetic user messages are not recorded", async () => {
    const { emit, sent } = setup();
    const ctx = makeCtx();
    await emit("message_end", { message: { role: "user", content: "synthetic words", attribution: "user", synthetic: true } }, ctx);
    await emit("message_end", said("real words"), ctx);
    await emit("session_compact", legacyCompaction(), ctx);
    const body = String(sent[0].message.content);
    expect(body).toContain("real words");
    expect(body).not.toContain("synthetic words");
  });

  test("agent-attributed user messages are not recorded", async () => {
    const { emit, sent } = setup();
    const ctx = makeCtx();
    await emit("message_end", { message: { role: "user", content: "relayed by agent", attribution: "agent" } }, ctx);
    await emit("message_end", { message: { role: "user", content: "typed by human", attribution: "user" } }, ctx);
    await emit("message_end", { message: { role: "user", content: "no attribution field" } }, ctx);
    await emit("session_compact", legacyCompaction(), ctx);
    const body = String(sent[0].message.content);
    expect(body).not.toContain("relayed by agent");
    expect(body).toContain("typed by human");
    expect(body).toContain("no attribution field");
  });
});

describe("input/message_end pairing across turns", () => {
  const userMsg = (t: string) => ({ message: { role: "user", content: [{ type: "text", text: t }], attribution: "user" } });

  test("a message typed while streaming (input at turn N, message_end later) is listed once", async () => {
    const { emit, sent } = setup();
    const ctx = makeCtx();
    await emit("input", { text: "queued while streaming", source: "interactive" }, ctx);
    await emit("turn_end", {}, ctx);
    await emit("turn_end", {}, ctx);
    await emit("message_end", userMsg("queued while streaming"), ctx);
    await emit("session_compact", legacyCompaction(), ctx);
    expect(String(sent[0].message.content).split("queued while streaming").length - 1).toBe(1);
  });

  test("a later real repeat (input plus its own message_end) still gives two entries", async () => {
    const { emit, sent } = setup();
    const ctx = makeCtx();
    for (let i = 0; i < 2; i++) {
      await emit("input", { text: "same words", source: "interactive" }, ctx);
      await emit("message_end", userMsg("same words"), ctx);
      await emit("turn_end", {}, ctx);
    }
    await emit("session_compact", legacyCompaction(), ctx);
    expect(String(sent[0].message.content).split("same words").length - 1).toBe(2);
  });
});

describe("read selectors", () => {
  const selectors = [":raw", ":-5", ":5", ":10-20", ":10+5", ":5-10,20-30", ":10-20:raw", ":raw:10-20"];

  for (const sel of selectors) {
    test(`plan path with selector ${sel} is recorded without the selector`, async () => {
      const { emit, sent } = setup();
      const ctx = makeCtx();
      await emit("tool_result", { toolName: "read", input: { path: `docs/plans/p.md${sel}` }, content: text("Status: Sel"), isError: false }, ctx);
      await emit("session_compact", legacyCompaction(), ctx);
      expect(String(sent[0].message.content)).toMatch(/Active plan: docs\/plans\/p\.md(\n|$)/);
    });

    test(`SKILL.md path with selector ${sel} yields the skill name`, async () => {
      const { emit, sent } = setup();
      const ctx = makeCtx();
      await emit("tool_result", { toolName: "read", input: { path: `/h/skills/foo/SKILL.md${sel}` }, content: text("x"), isError: false }, ctx);
      await emit("session_compact", legacyCompaction(), ctx);
      expect(String(sent[0].message.content)).toContain("Loaded skills: foo");
    });
  }
});

describe("ranged reads keep the Status", () => {
  const planWith = (status: string) => {
    mkdirSync(join(dir, "docs", "plans"), { recursive: true });
    writeFileSync(join(dir, "docs", "plans", "k.md"), `# P\n${status}\n`);
  };
  const read = (path: string, body: string) => ({ toolName: "read", input: { path }, content: text(body), isError: false });

  test("a ranged read without Status re-reads it from disk", async () => {
    planWith("Status: FromDisk");
    const { emit, sent } = setup();
    const ctx = makeCtx({ cwd: dir });
    await emit("tool_result", read("docs/plans/k.md:5-9", "some middle lines"), ctx);
    await emit("session_compact", legacyCompaction(), ctx);
    expect(String(sent[0].message.content)).toContain("Status: FromDisk");
  });

  test("a ranged read that happens to show a stale Status line still prefers disk", async () => {
    planWith("Status: Current");
    const { emit, sent } = setup();
    const ctx = makeCtx({ cwd: dir });
    await emit("tool_result", read("docs/plans/k.md:1-3", "Status: Stale"), ctx);
    await emit("session_compact", legacyCompaction(), ctx);
    const body = String(sent[0].message.content);
    expect(body).toContain("Status: Current");
    expect(body).not.toContain("Status: Stale");
  });

  test("when disk fails too, the previous Status for the same path is kept", async () => {
    const { emit, sent } = setup();
    const ctx = makeCtx({ cwd: join(dir, "nowhere") });
    await emit("tool_result", read("docs/plans/k.md", "Status: Known"), ctx);
    await emit("tool_result", read("docs/plans/k.md:20-30", "no status here"), ctx);
    await emit("session_compact", legacyCompaction(), ctx);
    expect(String(sent[0].message.content)).toContain("Status: Known");
  });

  test("an unranged read with no Status line also falls back to disk, then to the previous Status", async () => {
    const { emit, sent } = setup();
    const ctx = makeCtx({ cwd: join(dir, "nowhere") });
    await emit("tool_result", read("docs/plans/k.md", "Status: Known"), ctx);
    await emit("tool_result", read("docs/plans/k.md", "# no status in this body"), ctx);
    await emit("session_compact", legacyCompaction(), ctx);
    expect(String(sent[0].message.content)).toContain("Status: Known");
  });

  test("the previous Status is not carried over to a different plan path", async () => {
    const { emit, sent } = setup();
    const ctx = makeCtx({ cwd: join(dir, "nowhere") });
    await emit("tool_result", read("docs/plans/one.md", "Status: One"), ctx);
    await emit("tool_result", read("docs/plans/two.md:3-4", "nothing"), ctx);
    await emit("session_compact", legacyCompaction(), ctx);
    const body = String(sent[0].message.content);
    expect(body).toContain("docs/plans/two.md");
    expect(body).not.toContain("Status: One");
  });
});

describe("OMP_CONTEXT_NUDGE_FRACTION", () => {
  const withEnv = async (value: string | undefined, fn: () => Promise<void>) => {
    const saved = process.env.OMP_CONTEXT_NUDGE_FRACTION;
    if (value === undefined) delete process.env.OMP_CONTEXT_NUDGE_FRACTION;
    else process.env.OMP_CONTEXT_NUDGE_FRACTION = value;
    try {
      await fn();
    } finally {
      if (saved === undefined) delete process.env.OMP_CONTEXT_NUDGE_FRACTION;
      else process.env.OMP_CONTEXT_NUDGE_FRACTION = saved;
    }
  };
  const fires = async (tokens: number, o: { nudgeFraction?: number } = {}) => {
    const { emit } = setup(o);
    const ctx = makeCtx({ getContextUsage: () => ({ tokens, contextWindow: 200000, percent: 0 }) });
    await emit("turn_end", {}, ctx);
    const texts = await appendedTexts(emit, ctx);
    return texts.some(t => t.includes(NUDGE));
  };

  test("a valid env value replaces the default (0.85)", async () => {
    await withEnv("0.5", async () => {
      expect(await fires(60000)).toBe(true);
    });
    await withEnv(undefined, async () => {
      expect(await fires(60000)).toBe(false);
      expect(await fires(90000)).toBe(true);
    });
  });

  test("invalid env values (0, 1, 1.5, negative, text, empty) fall back to the default", async () => {
    for (const bad of ["0", "1", "1.5", "-0.2", "abc", "", "NaN"]) {
      await withEnv(bad, async () => {
        expect(await fires(60000)).toBe(false); // below 85%
        expect(await fires(90000)).toBe(true);
      });
    }
  });

  test("the factory option beats the env", async () => {
    await withEnv("0.5", async () => {
      expect(await fires(60000, { nudgeFraction: 0.95 })).toBe(false);
      expect(await fires(96000, { nudgeFraction: 0.95 })).toBe(true);
    });
  });
});

describe("bounded session state", () => {
  const ctxFor = (id: string) => makeCtx({ sessionManager: { getSessionId: () => id, getBranch: () => [] } });
  const bodyFor = async (emit: any, sent: any[], id: string, entry: string) => {
    const n = sent.length;
    await emit("session_compact", legacyCompaction(entry), ctxFor(id));
    return sent.length > n ? String(sent[sent.length - 1].message.content) : "";
  };

  test("keeps the 32 most recently used sessions and evicts the least recently used", async () => {
    const { emit, sent } = setup();
    for (let i = 0; i < 32; i++) await emit("message_end", said(`words-of-s${i}`), ctxFor(`s${i}`));
    await emit("message_end", said("words-of-s0-again"), ctxFor("s0")); // s0 is now most recent
    await emit("message_end", said("words-of-s32"), ctxFor("s32")); // evicts s1
    expect(await bodyFor(emit, sent, "s0", "e0")).toContain("words-of-s0");
    expect(await bodyFor(emit, sent, "s32", "e32")).toContain("words-of-s32");
    const s1 = await bodyFor(emit, sent, "s1", "e1");
    expect(s1).not.toContain("words-of-s1");
  });
});

// ---------------------------------------------------------------------------------------------------
// T12: restore block ready before the next request; nudge and words from settled state
// ---------------------------------------------------------------------------------------------------

/**
 * A git stub for a detached session_compact: while slow, every call waits until release(); the branch it
 * reports can be changed to see whether a later git answer leaks into a block that should be settled.
 */
function slowGit() {
  let release!: () => void;
  const gate = new Promise<void>(r => (release = r));
  let slow = false;
  let branch = "feature/x";
  const execImpl = async (_cmd: string, args: string[]) => {
    if (slow) await gate;
    if (args[0] === "rev-parse") return { stdout: `${branch}\n`, stderr: "", code: 0, killed: false };
    if (args[0] === "worktree") return { stdout: "/repo  abc1234 [main]\n", stderr: "", code: 0, killed: false };
    return { stdout: "", stderr: "", code: 1, killed: false };
  };
  return {
    execImpl,
    goSlow: () => (slow = true),
    goFast: () => (slow = false),
    setBranch: (b: string) => (branch = b),
    release: () => release(),
  };
}

/** Fire every handler for an event without awaiting it (omp's `void compactEmit`, session-maintenance.ts:2490-2496). */
const fireDetached = (handlers: Map<string, Handler[]>, event: string, payload: any, ctx: any) => {
  for (const h of handlers.get(event) ?? []) void h({ type: event, ...payload }, ctx);
};
const flush = () => Bun.sleep(0);
const restoreTexts = async (emit: any, ctx: any) => (await appendedTexts(emit, ctx)).filter((t: string) => t.startsWith(RESTORE));

describe("T12 acceptance 1 (C1): restore block in place before the next context call", () => {
  const userMsg = (t: string) => ({ message: { role: "user", content: [{ type: "text", text: t }], attribution: "user" } });

  test("detached session_compact with git slow: the next context call carries the new block (git from turn_end) and not the old one", async () => {
    const git = slowGit();
    const { emit, handlers } = setup({ execImpl: git.execImpl });
    const ctx = makeCtx();
    try {
      await emit("message_end", userMsg("old words"), ctx);
      await emit("session_compact", legacyCompaction("c1"), ctx); // fast git: the old block is in place
      expect((await restoreTexts(emit, ctx)).some(t => t.includes("old words"))).toBe(true);

      await emit("message_end", userMsg("new words"), ctx);
      git.setBranch("turn/branch"); // differs from c1's branch: the instant block must show the turn_end refresh
      await emit("turn_end", {}, ctx); // git still fast here: the refresh point for git/worktree info
      await flush();
      git.goSlow();
      fireDetached(handlers, "session_compact", rolloverCompaction("r2"), ctx);

      const seen: string[] = [];
      const first = await restoreTexts(emit, ctx);
      expect(first).toHaveLength(1);
      expect(first[0]).toContain("new words");
      expect(first[0]).toContain("after a context rollover"); // the r2 block
      expect(first[0]).not.toContain("after compaction"); // the c1 block is gone
      expect(first[0]).toContain("Git branch: turn/branch"); // from the turn_end refresh, no await
      seen.push(first[0]);

      git.release();
      await flush();
      for (let i = 0; i < 2; i++) {
        const r = await restoreTexts(emit, ctx);
        expect(r).toHaveLength(1);
        seen.push(r[0]);
      }
      expect(new Set(seen).size).toBeLessThanOrEqual(2); // bytes change at most once per compaction
      expect(seen[seen.length - 1]).toContain("Git branch:");
    } finally {
      git.release();
    }
  });

  test("first compaction with no git known yet, detached and git slow: block present at once, git filled in later, then settled", async () => {
    const git = slowGit();
    git.goSlow();
    const { emit, handlers } = setup({ execImpl: git.execImpl });
    const ctx = makeCtx();
    try {
      await emit("message_end", userMsg("keep me"), ctx);
      fireDetached(handlers, "session_compact", legacyCompaction("c1"), ctx);
      const now = await restoreTexts(emit, ctx);
      expect(now).toHaveLength(1);
      expect(now[0]).toContain("keep me");

      git.release();
      await flush();
      const filled = await restoreTexts(emit, ctx);
      expect(filled).toHaveLength(1);
      expect(filled[0]).toContain("Git branch: feature/x"); // the later fill
      expect(filled[0]).toContain("keep me");

      git.goFast();
      git.setBranch("other/branch");
      expect(await restoreTexts(emit, ctx)).toEqual(filled);
      await emit("turn_end", {}, ctx); // a new git answer must not rewrite this compaction's block
      await flush();
      expect(await restoreTexts(emit, ctx)).toEqual(filled);
    } finally {
      git.release();
    }
  });

  test("a stale git result from an earlier compaction does not overwrite a later compaction's block", async () => {
    const git = slowGit();
    git.goSlow();
    const { emit, handlers } = setup({ execImpl: git.execImpl });
    const ctx = makeCtx();
    try {
      await emit("message_end", userMsg("c1 words"), ctx);
      fireDetached(handlers, "session_compact", legacyCompaction("c1"), ctx); // its git waits on the gate
      await flush();
      git.goFast();
      await emit("message_end", userMsg("r2 words"), ctx);
      fireDetached(handlers, "session_compact", rolloverCompaction("r2"), ctx); // fast git
      await flush();
      git.release(); // c1's git answers late
      await flush();
      const r = await restoreTexts(emit, ctx);
      expect(r).toHaveLength(1);
      expect(r[0]).toContain("after a context rollover");
      expect(r[0]).not.toContain("after compaction");
      expect(r[0]).toContain("r2 words");
    } finally {
      git.release();
    }
  });
});

describe("T12 acceptance 2 (C3): context is a pure function of stored state", () => {
  test("two context calls with no event between return identical messages even when usage crosses the threshold between them", async () => {
    let tokens = 10;
    const ctx = makeCtx({ getContextUsage: () => ({ tokens, contextWindow: 200000, percent: 0 }) });
    const { emit } = setup({ nudgeFraction: 0.85 });
    await emit("session_compact", legacyCompaction(), ctx);
    await emit("turn_end", {}, ctx); // usage settled at 10: below 85% of 100000
    const msgs = baseMessages();
    const first = (await emit("context", { messages: msgs }, ctx))?.messages ?? msgs;
    tokens = 95000; // live usage crosses the threshold, but no event happened
    const second = (await emit("context", { messages: msgs }, ctx))?.messages ?? msgs;
    expect(second).toEqual(first);
    expect(second.map(msgText).join("\n")).not.toContain(NUDGE);
  });

  test("the nudge decided at turn_end is carried by the next context calls whatever the live usage then says", async () => {
    let tokens = 95000;
    const ctx = makeCtx({ getContextUsage: () => ({ tokens, contextWindow: 200000, percent: 0 }) });
    const { emit } = setup({ nudgeFraction: 0.85 });
    await emit("turn_end", {}, ctx); // decided here from usage 95000
    tokens = 10;
    expect((await appendedTexts(emit, ctx)).some(t => t.includes(NUDGE))).toBe(true);
  });

  test("context does not wait on the settings reader, even while a turn_end is still waiting on it", async () => {
    const never = new Promise<any>(() => {});
    const { emit, handlers } = setup({ settings: () => never });
    const ctx = makeCtx({ getContextUsage: () => ({ tokens: 95000, contextWindow: 200000, percent: 0 }) });
    // no compaction: nothing holds the nudge back, so today's context handler reaches the reader
    fireDetached(handlers, "turn_end", {}, ctx); // its reader call never resolves
    const timedOut = Symbol("timed out");
    const r = await Promise.race([emit("context", { messages: baseMessages() }, ctx), Bun.sleep(200).then(() => timedOut)]);
    expect(r).not.toBe(timedOut);
  });
});

describe("T12 acceptance 3 (C4): recent user words come from the user message as it entered the session", () => {
  const userMsg = (t: string) => ({ message: { role: "user", content: [{ type: "text", text: t }], attribution: "user" } });
  const bodyAfterCompaction = async (emit: any, sent: any[], ctx: any) => {
    await emit("session_compact", legacyCompaction(), ctx);
    return String(sent[sent.length - 1]?.message.content ?? "");
  };

  test("rewrite: another input handler rewrote the text; only the rewritten text (the session's user message) is recorded", async () => {
    const { emit, sent } = setup();
    const ctx = makeCtx();
    // runner.ts:1982-2005 chains input handlers; a later one rewrites what this extension saw
    await emit("input", { text: "raw typed text", source: "interactive" }, ctx);
    await emit("message_end", userMsg("rewritten by another extension"), ctx);
    const body = await bodyAfterCompaction(emit, sent, ctx);
    expect(body).toContain("rewritten by another extension");
    expect(body).not.toContain("raw typed text");
  });

  test("regression guard (passes today): the continue directive, a synthetic developer message, is not recorded", async () => {
    const { emit, sent } = setup();
    const ctx = makeCtx();
    await emit("message_end", userMsg("a real message"), ctx);
    // input-controller.ts:985-998: "." / "c" never reach `input`; omp prompts manualContinuePrompt as a synthetic,
    // agent-attributed developer message (agent-session.ts:7536-7545)
    const directive = {
      message: {
        role: "developer",
        content: [{ type: "text", text: "<system-notice>\nContinue.\n</system-notice>" }],
        attribution: "agent",
        synthetic: true,
        userInitiated: true,
      },
    };
    await emit("message_end", directive, ctx);
    const body = await bodyAfterCompaction(emit, sent, ctx);
    expect(body).toContain("a real message");
    expect(body).not.toContain("Continue.");
  });

  test("regression guard: a real user message 'c' (guided-goal answer / RPC) is recorded", async () => {
    const { emit, sent } = setup();
    const ctx = makeCtx();
    await emit("message_end", { message: { role: "user", content: "c", attribution: "user" } }, ctx);
    const body = await bodyAfterCompaction(emit, sent, ctx);
    expect(body).toMatch(/^- c$/m);
  });

  test("regression guard: a user message starting with '/' that reached the session is recorded (no input prefix filter on message_end)", async () => {
    const { emit, sent } = setup();
    const ctx = makeCtx();
    await emit("message_end", userMsg("/Users/zhang/x please"), ctx);
    const body = await bodyAfterCompaction(emit, sent, ctx);
    expect(body).toContain("- /Users/zhang/x please");
  });
});

// ---------------------------------------------------------------------------------------------------
// T12 rework: git refreshes never block a handler, never overwrite newer git state; coverage of drops
// ---------------------------------------------------------------------------------------------------

/**
 * A git stub in phases: a `rev-parse` call waits on the phase current when it starts and reports that phase's
 * branch, so refreshes started at different moments can be answered in any order.
 */
function phasedGit() {
  type Phase = { gate: Promise<void>; open: () => void; branch: string };
  const phases = new Map<string, Phase>();
  const make = (branch: string, open: boolean): Phase => {
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    if (open) release();
    return { gate, open: release, branch };
  };
  let current = make("feature/x", true);
  const execImpl = async (_cmd: string, args: string[]) => {
    const p = current;
    await p.gate;
    if (args[0] === "rev-parse") return { stdout: `${p.branch}\n`, stderr: "", code: 0, killed: false };
    if (args[0] === "worktree") return { stdout: "/repo  abc1234 [main]\n", stderr: "", code: 0, killed: false };
    return { stdout: "", stderr: "", code: 1, killed: false };
  };
  return {
    execImpl,
    phase: (name: string, branch: string, open = false) => {
      current = make(branch, open);
      phases.set(name, current);
    },
    release: (name: string) => phases.get(name)?.open(),
    releaseAll: () => {
      for (const p of phases.values()) p.open();
    },
  };
}

const settled = <T>(p: Promise<T>, ms = 200) => {
  const timedOut = Symbol("timed out");
  return Promise.race([p.then(() => "settled" as const), Bun.sleep(ms).then(() => timedOut)]);
};

describe("T12 rework item 1: git refreshes do not hold up turn_end or session_start", () => {
  test("turn_end resolves promptly while git is gated slow", async () => {
    const git = phasedGit();
    const { emit } = setup({ execImpl: git.execImpl });
    try {
      git.phase("slow", "slow/branch");
      expect(await settled(emit("turn_end", {}, makeCtx()))).toBe("settled");
    } finally {
      git.releaseAll();
    }
  });

  test("session_start resolves promptly while git is gated slow", async () => {
    const git = phasedGit();
    const { emit } = setup({ execImpl: git.execImpl });
    try {
      git.phase("slow", "slow/branch");
      expect(await settled(emit("session_start", {}, makeCtx()))).toBe("settled");
    } finally {
      git.releaseAll();
    }
  });
});

describe("T12 rework item 2: an older git refresh never overwrites newer git state", () => {
  test("a turn_end refresh started before a compaction and finishing after its fill does not overwrite the git state", async () => {
    const git = phasedGit();
    const { emit, handlers } = setup({ execImpl: git.execImpl });
    const ctx = makeCtx();
    try {
      git.phase("old", "old/branch"); // the turn_end refresh waits here
      fireDetached(handlers, "turn_end", {}, ctx);
      await flush();
      git.phase("fill", "new/branch", true); // the compaction's fill answers at once
      await emit("session_compact", legacyCompaction("c1"), ctx);
      await flush();
      git.release("old"); // the older refresh answers last
      await flush();
      git.phase("never", "never/branch"); // c2's own fill never answers: its instant block shows s.git
      fireDetached(handlers, "session_compact", legacyCompaction("c2"), ctx);
      const r = await restoreTexts(emit, ctx);
      expect(r).toHaveLength(1);
      expect(r[0]).toContain("Git branch: new/branch");
      expect(r[0]).not.toContain("old/branch");
    } finally {
      git.releaseAll();
    }
  });
});

describe("T12 rework item 3: coverage", () => {
  test("a nudge decision is dropped when a compaction happens during the settings read", async () => {
    let answer!: (v: any) => void;
    const pending = new Promise<any>(r => (answer = r));
    const { emit, handlers } = setup({ settings: () => pending });
    const hot = makeCtx({ getContextUsage: () => ({ tokens: 95000, contextWindow: 200000, percent: 0 }) });
    fireDetached(handlers, "turn_end", {}, hot); // waits on the settings read
    await flush();
    await emit("session_compact", legacyCompaction(), hot);
    answer({ experimentalContextManagement: false, thresholdTokens: 100000 });
    await flush();
    expect((await appendedTexts(emit, hot)).some(t => t.includes(NUDGE))).toBe(false);
  });

  test("the session_start refresh feeds the first compaction's instant block", async () => {
    const git = phasedGit();
    const { emit, handlers } = setup({ execImpl: git.execImpl });
    const ctx = makeCtx();
    try {
      git.phase("start", "start/branch", true);
      await emit("session_start", {}, ctx);
      await flush();
      git.phase("never", "never/branch"); // the compaction's own fill never answers
      fireDetached(handlers, "session_compact", legacyCompaction("c1"), ctx);
      const r = await restoreTexts(emit, ctx);
      expect(r).toHaveLength(1);
      expect(r[0]).toContain("Git branch: start/branch");
    } finally {
      git.releaseAll();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// T15 (fix: T9 F1, F3). Request shape after a rollover, from omp's own assembly (omp 18.11.1):
//   buildSessionContext (session/session-context.ts) pushes the compactionSummary first (:540-545), then on a rollover
//   (details.kind "experimental-context-rollover") re-appends the latest user request from before the compaction
//   (:547-569; isRolloverRequestEntry :40-48 -> isUserRequestEntry, tui/src/chat/transcript-entry.ts:59-70, which
//   counts a user-attributed skill-prompt custom message), then the kept and later messages; last it splices the
//   context-notes custom message (customType "experimental_context_notes", "<experimental-context-notes>") in at index
//   0 (:646-670). session-maintenance.ts:2466-2468 swaps that in with agent.replaceMessages after appendCompaction,
//   and later turns only append, so the leading messages stay put until the next compaction.
//   The T9 capture (docs/e2e/2026-10-16-omp-e2e.md item 3a): [0] custom notes, [1] compactionSummary,
//   [2] custom skill-prompt, [3] custom todo reminder, then assistant/toolResult, no `user` role at all.
// /skill:<name> <args>: modes/skill-command.ts:63-87 builds { customType "skill-prompt", content <skill body>,
//   details, attribution "user" }; details come from extensibility/skills.ts:671-718: { name, path, args (trimmed
//   user text, undefined when empty), prompt (the whole draft), lineCount }. It reaches extensions as message_end
//   (agent/src/agent-loop.ts:1121-1125 emitInputMessages).
// ---------------------------------------------------------------------------------------------------------------
const t9Notes = () => ({
  role: "custom",
  customType: "experimental_context_notes",
  content: "<experimental-context-notes>\nPIN-1\n</experimental-context-notes>",
  display: false,
  timestamp: 1,
});
const t9Summary = () => ({ role: "compactionSummary", summary: "rolled over", tokensBefore: 69719, timestamp: 2 });
const SKILL_BODY = '[IMPORTANT: User invoked the "plan-sdd" skill; follow its instructions. Full skill below.]\n\nSKILL BODY TEXT';
const T9_ARGS = "Goal mode: run it to the end. Change: add farewell(name) to src/greet.js returning \"bye \" + name.";
const t9Skill = (attribution: string = "user", args: string | undefined = T9_ARGS) => ({
  role: "custom",
  customType: "skill-prompt",
  content: SKILL_BODY,
  display: true,
  details: { name: "plan-sdd", path: "/skills/plan-sdd/SKILL.md", args, prompt: `/skill:plan-sdd ${args ?? ""}`.trim(), lineCount: 120 },
  attribution,
  timestamp: 3,
});
const t9Todo = () => ({
  role: "custom",
  customType: "mid-run-todo-nudge",
  content: "<system-reminder> 4 todo items still open </system-reminder>",
  display: false,
  attribution: "agent",
  timestamp: 4,
});
const t9Call = (id = "tc1") => ({ role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: {} }], timestamp: 5 });
const t9Result = (id = "tc1") => ({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: "r" }], timestamp: 6 });
const t9User = (t: string) => ({ role: "user", content: [{ type: "text", text: t }], attribution: "user", timestamp: 7 });
const t9Asst = (t: string) => ({ role: "assistant", content: [{ type: "text", text: t }], timestamp: 8 });
/** The first request after the T9 second rollover, role for role. */
const t9Request = () => [t9Notes(), t9Summary(), t9Skill(), t9Todo(), t9Call(), t9Result(), t9Asst("next")];
const isRestoreBlock = (m: any) => m?.synthetic === true && msgText(m).startsWith(RESTORE);

describe("T15 acceptance 1 (F1): the anchor in the request shape omp builds after a rollover", () => {
  test("T9 shape [custom notes, compactionSummary, custom skill-prompt, custom todo, assistant, toolResult]: block right after the summary", async () => {
    const { emit } = setup();
    const ctx = makeCtx();
    await emit("message_end", said("keep me"), ctx);
    await emit("session_compact", rolloverCompaction("r2"), ctx);
    const msgs = t9Request();
    expect(msgs.map((m: any) => m.role)).toEqual(["custom", "compactionSummary", "custom", "custom", "assistant", "toolResult", "assistant"]);
    const r = await emit("context", { messages: msgs }, ctx);
    expect(r?.messages).toBeDefined();
    const out = r.messages;
    expect(out).toHaveLength(msgs.length + 1);
    expect(out[0]).toBe(msgs[0]);
    expect(out[1]).toBe(msgs[1]);
    expect(out[2]).toSatisfy(isRestoreBlock);
    expect(out.slice(3)).toEqual(msgs.slice(2));
  });

  test("the summary after leading custom messages wins over a later user message (T9 3c shape: custom, summary, assistant, user)", async () => {
    const { emit } = setup();
    const ctx = makeCtx();
    await emit("session_compact", rolloverCompaction("r3"), ctx);
    for (const lead of [[t9Notes()], [t9Notes(), t9Todo()], []]) {
      const msgs = [...lead, t9Summary(), t9Asst("a"), t9User("u"), t9Asst("b")];
      const out = (await emit("context", { messages: msgs }, ctx))?.messages ?? msgs;
      expect(out.findIndex(isRestoreBlock)).toBe(lead.length + 1);
      expect(out.filter(isRestoreBlock)).toHaveLength(1);
    }
  });

  test("no summary, no user message: right after the user-invoked skill-prompt message", async () => {
    const { emit } = setup();
    const ctx = makeCtx();
    await emit("session_compact", legacyCompaction("c1"), ctx);
    const msgs = [t9Notes(), t9Skill(), t9Todo(), t9Call(), t9Result()];
    const out = (await emit("context", { messages: msgs }, ctx))?.messages ?? msgs;
    expect(out.findIndex(isRestoreBlock)).toBe(2);
    expect(out[1]).toBe(msgs[1]);
    expect(out.filter(isRestoreBlock)).toHaveLength(1);
  });

  test("no summary: the skill-prompt anchors when it comes before the first user message (same anchor in history and history+retained)", async () => {
    const { emit } = setup();
    const ctx = makeCtx();
    await emit("session_compact", legacyCompaction("c1"), ctx);
    const msgs = [t9Skill(), t9Asst("a"), t9User("later"), t9Asst("b")];
    const out = (await emit("context", { messages: msgs }, ctx))?.messages ?? msgs;
    expect(out.findIndex(isRestoreBlock)).toBe(1);
  });

  test("regression guard: no summary, a user message before any skill-prompt still anchors on the user message", async () => {
    const { emit } = setup();
    const ctx = makeCtx();
    await emit("session_compact", legacyCompaction("c1"), ctx);
    const msgs = [t9User("first"), t9Skill(), t9Asst("a")];
    const out = (await emit("context", { messages: msgs }, ctx))?.messages ?? msgs;
    expect(out.findIndex(isRestoreBlock)).toBe(1);
  });

  test("regression guard: a skill-prompt not attributed to the user is no anchor; with no other anchor nothing is inserted", async () => {
    const { emit } = setup();
    const ctx = makeCtx();
    await emit("session_compact", legacyCompaction("c1"), ctx);
    for (const attribution of ["agent", undefined]) {
      const skill: any = t9Skill("x");
      if (attribution === undefined) delete skill.attribution;
      else skill.attribution = attribution;
      expect(await emit("context", { messages: [t9Notes(), skill, t9Call(), t9Result()] }, ctx)).toBeUndefined();
    }
  });

  // The async-compaction cut (session/agent-session.ts:2376-2403) converts history and history+retained and keeps the
  // first len(convert(history)) messages. history there comes from session entries after the previous compaction
  // plus the rebuilt summary (agent/src/compaction/compaction.ts:2051-2070, :1440-1473), so the notes message is not
  // in it, but a skill-prompt or other custom entries can be. The T9 live shape is included as well.
  describe("summarizer cut alignment for the new shapes", () => {
    // [name, history, retained, history alone holds an anchor (so the block must already be in convert(history))]
    const cases: [string, () => any[], () => any[], boolean][] = [
      ["T9 live shape, cut inside the tool turn", () => [t9Notes(), t9Summary(), t9Skill(), t9Todo(), t9Call()], () => [t9Result(), t9Asst("done"), t9User("u2")], true],
      ["summary, skill-prompt, todo; no user anywhere", () => [t9Summary(), t9Skill(), t9Todo(), t9Call()], () => [t9Result(), t9Asst("done")], true],
      ["no summary, skill-prompt in history, user only in retained", () => [t9Skill(), t9Call()], () => [t9Result(), t9User("u2"), t9Asst("done")], true],
      ["no summary, agent custom in history, skill-prompt only in retained", () => [t9Todo(), t9Call()], () => [t9Result(), t9Skill(), t9Asst("done")], false],
      ["no summary, notes then skill-prompt", () => [t9Notes(), t9Skill(), t9Call()], () => [t9Result(), t9Asst("done")], true],
      // What buildLiveProviderContext actually sees after the T9 rollover: summary plus entries after the compaction (the
      // notes message and the re-appended request are added only by buildSessionContext). The notes-at-0 rows above are
      // stricter than anything the cut sees.
      ["cut's own view after the T9 rollover: summary, todo, tool call", () => [t9Summary(), t9Todo(), t9Call()], () => [t9Result(), t9Asst("done")], true],
    ];
    for (const withNudge of [false, true]) {
      for (const [name, mkHistory, mkRetained, historyAnchored] of cases) {
        test(`prefix of convert(history+retained) equals convert(history), block present: ${name} (nudge=${withNudge})`, async () => {
          const { emit } = setup();
          const ctx = makeCtx(withNudge ? { getContextUsage: () => ({ tokens: 95000, contextWindow: 200000, percent: 0 }) } : {});
          await emit("message_end", said("words"), ctx);
          await emit("session_compact", rolloverCompaction(), ctx);
          if (withNudge) await emit("turn_end", {}, ctx);
          const history = mkHistory();
          const retained = mkRetained();
          const run = async (msgs: any[]) => (await emit("context", { messages: msgs }, ctx))?.messages ?? msgs;
          const convertH = await run(history);
          const convertHR = await run([...history, ...retained]);
          expect(convertHR.slice(0, convertH.length)).toEqual(convertH);
          expect(convertHR[convertH.length]).toBe(retained[0]);
          expect(convertHR.filter((m: any) => !isRestoreBlock(m))).toEqual([...history, ...retained]);
          expect(convertHR.filter(isRestoreBlock)).toHaveLength(1); // every one of these shapes has an anchor
          expect(convertH.filter(isRestoreBlock)).toHaveLength(historyAnchored ? 1 : 0);
        });
      }
    }
  });
});

// omp's other user-attributed custom turn (isUserTurnInitiator, tui/src/chat/messages.ts:282-287): customType
// "collab-prompt" (wire/src/index.ts:170). Only the skill-prompt is part of T15.
const collabPrompt = () => ({
  role: "custom",
  customType: "collab-prompt",
  content: "peer prompt body",
  display: true,
  details: { args: "collab peer args" },
  attribution: "user",
  timestamp: 3,
});

describe("T15 audit tightening: a user-attributed custom of another type is neither an anchor nor recorded", () => {
  test("collab-prompt carrying details.args: not recorded, no anchor", async () => {
    const { emit } = setup();
    const ctx = makeCtx();
    await emit("message_end", { message: collabPrompt() }, ctx);
    await emit("session_compact", legacyCompaction(), ctx);
    expect(await emit("context", { messages: [t9Notes(), collabPrompt(), t9Call(), t9Result()] }, ctx)).toBeUndefined();
    const r = (await restoreTexts(emit, ctx))[0];
    expect(r).not.toContain("collab peer args");
    expect(r).not.toContain("Recent user words");
  });
});

describe("T15 acceptance 2 (F3): the task text of /skill:<name> <args> counts as user words", () => {
  const skillEnd = (attribution = "user", args: string | undefined = T9_ARGS) => ({ message: t9Skill(attribution, args) });

  test("the args of a user-invoked skill-prompt are recorded verbatim, the skill body is not", async () => {
    const { emit } = setup();
    const ctx = makeCtx();
    await emit("message_end", skillEnd(), ctx);
    await emit("session_compact", legacyCompaction(), ctx);
    const r = await restoreTexts(emit, ctx);
    expect(r).toHaveLength(1);
    expect(r[0]).toContain("Recent user words (verbatim):");
    expect(r[0]).toContain(T9_ARGS);
    expect(r[0]).not.toContain("SKILL BODY TEXT");
    expect(r[0]).not.toContain("IMPORTANT: User invoked");
    expect(r[0]).not.toContain("/skill:plan-sdd"); // details.args, not details.prompt (the whole draft)
  });

  test("the skill task and later typed words are both kept, in order", async () => {
    const { emit } = setup();
    const ctx = makeCtx();
    await emit("message_end", skillEnd(), ctx);
    await emit("message_end", said("and keep the greet check"), ctx);
    await emit("session_compact", legacyCompaction(), ctx);
    const r = (await restoreTexts(emit, ctx))[0] ?? "";
    const a = r.indexOf(T9_ARGS);
    const b = r.indexOf("and keep the greet check");
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
  });

  test("T9 end to end: /skill:plan-sdd task, rollover, T9 request shape: the block sits after the summary and carries the task", async () => {
    const { emit } = setup();
    const ctx = makeCtx();
    await emit("message_end", skillEnd(), ctx);
    await emit("session_compact", rolloverCompaction("r1"), ctx);
    const out = (await emit("context", { messages: t9Request() }, ctx))?.messages ?? [];
    expect(out[2]).toSatisfy(isRestoreBlock);
    expect(msgText(out[2])).toContain(T9_ARGS);
  });

  test("regression guard: a skill invoked without args records nothing as user words", async () => {
    const { emit } = setup();
    const ctx = makeCtx();
    const noArgs = t9Skill("user");
    delete (noArgs.details as any).args; // omp sets args to undefined when nothing follows /skill:<name> (skills.ts:713)
    noArgs.details.prompt = "/skill:plan-sdd";
    await emit("message_end", { message: noArgs }, ctx);
    await emit("session_compact", legacyCompaction(), ctx);
    expect((await restoreTexts(emit, ctx))[0]).not.toContain("Recent user words");
  });

  test("regression guard: a skill-prompt not attributed to the user is not recorded; other slash commands typed as input are not recorded", async () => {
    const { emit } = setup();
    const ctx = makeCtx();
    await emit("message_end", skillEnd("agent", "agent-chosen args"), ctx);
    await emit("input", { text: "/model kimi", source: "interactive" }, ctx);
    await emit("input", { text: "/compact keep it", source: "interactive" }, ctx);
    await emit("session_compact", legacyCompaction(), ctx);
    const r = (await restoreTexts(emit, ctx))[0];
    expect(r).not.toContain("agent-chosen args");
    expect(r).not.toContain("/model");
    expect(r).not.toContain("Recent user words");
  });
});

describe("T15 fold-in of T12 nits", () => {
  const usage = (tokens: number) => () => ({ tokens, contextWindow: 200000, percent: tokens / 2000 });
  const nudgeText = async (emit: any, ctx: any) => (await appendedTexts(emit, ctx)).find(t => t.includes(NUDGE));

  test("once latched, the nudge numbers stay frozen across later turn_ends until the next compaction", async () => {
    const { emit } = setup({ nudgeFraction: 0.85 });
    await emit("turn_end", {}, makeCtx({ getContextUsage: usage(90000) }));
    const first = await nudgeText(emit, makeCtx());
    expect(first).toContain("90000 of 100000");
    await emit("turn_end", {}, makeCtx({ getContextUsage: usage(99000) }));
    const later = await nudgeText(emit, makeCtx());
    expect(later).toBe(first);
    expect(later).not.toContain("99000");
  });

  test("once latched, later turn_ends do not consult the settings reader again until the next compaction", async () => {
    let reads = 0;
    const reader = async () => {
      reads++;
      return { experimentalContextManagement: false, thresholdTokens: 100000 };
    };
    const { emit } = setup({ settings: reader, nudgeFraction: 0.85 });
    await emit("turn_end", {}, makeCtx({ getContextUsage: usage(90000) }));
    expect(reads).toBe(1);
    await emit("turn_end", {}, makeCtx({ getContextUsage: usage(99000) }));
    await emit("turn_end", {}, makeCtx({ getContextUsage: usage(99500) }));
    expect(reads).toBe(1);
    await emit("session_compact", legacyCompaction(), makeCtx());
    await emit("turn_end", {}, makeCtx({ getContextUsage: usage(10) }));
    expect(reads).toBe(2);
  });

  test("a failed git refresh ({branch: undefined, worktrees: []}) does not overwrite earlier good git info", async () => {
    let gitWorks = true;
    const execImpl = async (_cmd: string, args: string[]) => {
      if (!gitWorks) return { stdout: "", stderr: "", code: -1, killed: true }; // timeout (omp exec/exec.ts:49-55)
      if (args[0] === "rev-parse") return { stdout: "feature/x\n", stderr: "", code: 0, killed: false };
      if (args[0] === "worktree") return { stdout: "/repo  abc1234 [main]\n", stderr: "", code: 0, killed: false };
      return { stdout: "", stderr: "", code: 1, killed: false };
    };
    const { emit } = setup({ execImpl });
    const ctx = makeCtx();
    await emit("session_start", {}, ctx);
    await flush();
    gitWorks = false;
    await emit("turn_end", {}, ctx); // its background refresh fails
    await flush();
    await emit("session_compact", legacyCompaction("c1"), ctx); // its own fill fails too
    await flush();
    const r = await restoreTexts(emit, ctx);
    expect(r).toHaveLength(1);
    expect(r[0]).toContain("Git branch: feature/x");
    expect(r[0]).toContain("/repo  abc1234 [main]");
  });
});

// T15 rework: git fields are refreshed one by one. omp's pi.exec (exec/exec.ts:49-55) reports a timeout as
// {code: -1, killed: true}; git itself answers outside a repository with a non-zero exit and "not a git repository".
describe("T15 rework: partial git failure and not-a-repo", () => {
  const OK = (stdout: string) => ({ stdout, stderr: "", code: 0, killed: false });
  const TIMEOUT = { stdout: "", stderr: "", code: -1, killed: true };
  const NOT_REPO = { stdout: "", stderr: "fatal: not a git repository (or any of the parent directories): .git\n", code: 128, killed: false };
  /** Each git call answers from the current `mode`. */
  const scripted = () => {
    let mode: { revParse: any; worktree: any } = {
      revParse: OK("old/branch\n"),
      worktree: OK("/repo  abc1234 [old/branch]\n/repo-wt  def5678 [side]\n"),
    };
    const execImpl = async (_cmd: string, args: string[]) => (args[0] === "rev-parse" ? mode.revParse : mode.worktree);
    return { execImpl, set: (m: { revParse: any; worktree: any }) => (mode = m) };
  };
  const blockAfterRefresh = async (git: ReturnType<typeof scripted>, next: { revParse: any; worktree: any }) => {
    const { emit } = setup({ execImpl: git.execImpl });
    const ctx = makeCtx();
    await emit("session_start", {}, ctx);
    await flush();
    git.set(next);
    await emit("turn_end", {}, ctx);
    await flush();
    await emit("session_compact", legacyCompaction("c1"), ctx); // its own fill gets the same answers
    await flush();
    const r = await restoreTexts(emit, ctx);
    expect(r).toHaveLength(1);
    return r[0];
  };

  test("rev-parse ok, worktree list times out: the new branch is taken, the old worktrees are kept", async () => {
    const git = scripted();
    const b = await blockAfterRefresh(git, { revParse: OK("new/branch\n"), worktree: TIMEOUT });
    expect(b).toContain("Git branch: new/branch");
    expect(b).not.toContain("old/branch\n");
    expect(b).toContain("- /repo  abc1234 [old/branch]");
    expect(b).toContain("- /repo-wt  def5678 [side]");
  });

  test("worktree list ok, rev-parse times out: the new worktrees are taken, the old branch is kept", async () => {
    const git = scripted();
    const b = await blockAfterRefresh(git, { revParse: TIMEOUT, worktree: OK("/repo  9999999 [new/branch]\n") });
    expect(b).toContain("Git branch: old/branch");
    expect(b).toContain("- /repo  9999999 [new/branch]");
    expect(b).not.toContain("/repo-wt  def5678 [side]");
  });

  test("a definite 'not a git repository' answer clears git info instead of keeping stale data", async () => {
    const git = scripted();
    const b = await blockAfterRefresh(git, { revParse: NOT_REPO, worktree: NOT_REPO });
    expect(b).not.toContain("Git branch:");
    expect(b).not.toContain("Worktrees:");
    expect(b).not.toContain("old/branch");
  });
});

// T15 acceptance 5: a native Anthropic compaction summary (providerPayload.type "anthropicCompaction") must open the
// request and is folded into a directly following retained assistant turn whose signed thinking is bound to that
// prefix; omp itself puts the notes after the summary, that assistant turn and its tool results
// (session/session-context.ts:651-662). The native cut (agent/src/compaction/anthropic.ts:137-171) only cuts at an
// assistant/non-assistant boundary and never between a tool call and its results, so in the cut's history the retained
// assistant turn and its results are on the same side.
describe("T15 acceptance 5: the native Anthropic summary fold is never split", () => {
  const native = () => ({ ...t9Summary(), providerPayload: { type: "anthropicCompaction", provider: "anthropic", content: "c" } });
  const call2 = () => ({
    role: "assistant",
    content: [{ type: "toolCall", id: "a", name: "read", arguments: {} }, { type: "toolCall", id: "b", name: "read", arguments: {} }],
    timestamp: 5,
  });
  const res = (id: string) => ({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: "r" }], timestamp: 6 });

  test("[native summary, assistant, toolResult, toolResult, notes custom, ...]: block after the tool results and the notes", async () => {
    const { emit } = setup();
    const ctx = makeCtx();
    await emit("session_compact", rolloverCompaction("r1"), ctx);
    const msgs = [native(), call2(), res("a"), res("b"), t9Notes(), t9Skill(), t9Asst("next")];
    const out = (await emit("context", { messages: msgs }, ctx))?.messages ?? msgs;
    expect(out.findIndex(isRestoreBlock)).toBe(5);
    expect(out.slice(0, 5)).toEqual(msgs.slice(0, 5));
    expect(out.filter(isRestoreBlock)).toHaveLength(1);
  });

  test("native summary followed by a plain assistant turn, then a user message: block right after that assistant turn", async () => {
    const { emit } = setup();
    const ctx = makeCtx();
    await emit("session_compact", legacyCompaction("c1"), ctx);
    const msgs = [native(), t9Asst("kept"), t9User("u"), t9Asst("b")];
    const out = (await emit("context", { messages: msgs }, ctx))?.messages ?? msgs;
    expect(out.findIndex(isRestoreBlock)).toBe(2);
  });

  test("native summary followed directly by a user message: block at index 1", async () => {
    const { emit } = setup();
    const ctx = makeCtx();
    await emit("session_compact", legacyCompaction("c1"), ctx);
    const msgs = [native(), t9User("u"), t9Asst("b")];
    const out = (await emit("context", { messages: msgs }, ctx))?.messages ?? msgs;
    expect(out.findIndex(isRestoreBlock)).toBe(1);
  });

  test("regression guard: a non-native summary keeps the block right after it", async () => {
    const { emit } = setup();
    const ctx = makeCtx();
    await emit("session_compact", legacyCompaction("c1"), ctx);
    const msgs = [t9Summary(), call2(), res("a"), res("b"), t9Notes(), t9Asst("next")];
    const out = (await emit("context", { messages: msgs }, ctx))?.messages ?? msgs;
    expect(out.findIndex(isRestoreBlock)).toBe(1);
  });

  describe("cut alignment for the native shape", () => {
    // [name, history, retained]; history is the rebuilt native summary plus entries (compaction.ts:2026-2070).
    const cases: [string, () => any[], () => any[]][] = [
      ["retained assistant turn with its tool results in history, cut at the next assistant", () => [native(), call2(), res("a"), res("b")], () => [t9Asst("next"), t9User("u2")]],
      ["retained plain assistant turn in history, cut at a user message", () => [native(), t9Asst("kept")], () => [t9User("u2"), t9Asst("done")]],
      ["retained assistant turn and results, then more turns in history", () => [native(), call2(), res("a"), res("b"), t9Asst("x"), t9User("u1")], () => [t9Asst("y")]],
      ["native summary then a user message in history", () => [native(), t9User("u1"), t9Asst("a1")], () => [t9User("u2"), t9Asst("a2")]],
    ];
    for (const [name, mkHistory, mkRetained] of cases) {
      test(`prefix of convert(history+retained) equals convert(history), block in history: ${name}`, async () => {
        const { emit } = setup();
        const ctx = makeCtx();
        await emit("session_compact", legacyCompaction("c1"), ctx);
        const history = mkHistory();
        const retained = mkRetained();
        const run = async (msgs: any[]) => (await emit("context", { messages: msgs }, ctx))?.messages ?? msgs;
        const convertH = await run(history);
        const convertHR = await run([...history, ...retained]);
        expect(convertHR.slice(0, convertH.length)).toEqual(convertH);
        expect(convertHR[convertH.length]).toBe(retained[0]);
        expect(convertH.filter(isRestoreBlock)).toHaveLength(1);
        // the fold is intact: the assistant turn right after the summary is never separated from it
        if (history[1]?.role === "assistant") expect(convertH[1]).toBe(history[1]);
      });
    }
  });
});

describe("review fixes (2026-10-16)", () => {
  test("the plan status is the header's Status line, not a task's `- Status:` line", async () => {
    const { emit, sent } = setup();
    const ctx = makeCtx();
    const doc = "# Plan\n\n## Tasks\n\n### T1 first\n- Status: done (merged)\n\n### T2 second\n- Status: pending\n";
    await emit("tool_result", { toolName: "read", input: { path: "docs/plans/no-header.md" }, content: text(doc), isError: false }, ctx);
    await emit("session_compact", legacyCompaction(), ctx);
    const body = String(sent[0].message.content);
    expect(body).toContain("Active plan: docs/plans/no-header.md");
    expect(body).not.toContain("Status: done");
    expect(body).not.toContain("Status: pending");
  });

  test("a header Status inside the plan-spec text block is found ahead of task lines", async () => {
    const { emit, sent } = setup();
    const ctx = makeCtx();
    const doc = "# Plan\n\n```text\nStatus: running\nRun id: x\n```\n\n### T1\n- Status: done\n";
    await emit("tool_result", { toolName: "read", input: { path: "docs/plans/h.md" }, content: text(doc), isError: false }, ctx);
    await emit("session_compact", legacyCompaction(), ctx);
    const body = String(sent[0].message.content);
    expect(body).toContain("Status: running");
    expect(body).not.toContain("Status: done");
  });

  test("a Markdown-bold header Status is the plan status, shown without the markup", async () => {
    for (const header of ["**Status:** running", "**Status**: running", "__Status:__ running"]) {
      const { emit, sent } = setup();
      const ctx = makeCtx();
      const doc = `# Plan\n\n${header}\n\n### T1\n- Status: done\n`;
      await emit("tool_result", { toolName: "read", input: { path: "docs/plans/bold.md" }, content: text(doc), isError: false }, ctx);
      await emit("session_compact", legacyCompaction(), ctx);
      const body = String(sent[0].message.content);
      expect(body).toContain("\nStatus: running");
      expect(body).not.toContain("Status: done");
    }
  });

  test("bold markup around the Status value is dropped too", async () => {
    const { emit, sent } = setup();
    const ctx = makeCtx();
    await emit("tool_result", { toolName: "read", input: { path: "docs/plans/v.md" }, content: text("# P\nStatus: **in progress**\n"), isError: false }, ctx);
    await emit("session_compact", legacyCompaction(), ctx);
    const body = String(sent[0].message.content);
    expect(body).toContain("\nStatus: in progress");
    expect(body).not.toContain("**");
  });

  test("a Status value with several bold spans keeps its spans intact", async () => {
    const { emit, sent } = setup();
    const ctx = makeCtx();
    await emit("tool_result", { toolName: "read", input: { path: "docs/plans/w.md" }, content: text("# P\nStatus: **blocked** on **T7**\n"), isError: false }, ctx);
    await emit("session_compact", legacyCompaction(), ctx);
    expect(String(sent[0].message.content)).toContain("\nStatus: **blocked** on **T7**");
  });

  test("only a repeat of the latest compaction entry is dropped; nothing older is remembered", async () => {
    const { emit, sent } = setup();
    const ctx = makeCtx();
    await emit("session_compact", legacyCompaction("c1"), ctx);
    await emit("message_end", said("two"), ctx);
    await emit("session_compact", legacyCompaction("c2"), ctx);
    await emit("session_compact", legacyCompaction("c2"), ctx);
    await emit("message_end", said("three"), ctx);
    await emit("session_compact", legacyCompaction("c1"), ctx);
    expect(sent).toHaveLength(3);
  });

  test("anchorIndex is the same source in omp-context and omp-plan-memory", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const body = (file: string) => {
      const src = require("node:fs").readFileSync(file, "utf8") as string;
      const start = src.indexOf("function anchorIndex(");
      expect(start).toBeGreaterThanOrEqual(0);
      const end = src.indexOf("\n}\n", start);
      // The two files differ only in semicolon style; compare the logic.
      return src.slice(start, end).replace(/;$/gm, "").replace(/\s+/g, " ").trim();
    };
    expect(body(join(here, "../omp-plan-memory/index.ts"))).toBe(body(join(here, "index.ts")));
  });
});
