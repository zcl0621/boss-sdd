// Evolve for omp-context: replays compactions found in omp session journals offline, scores how many recall
// facts a candidate summary guidance keeps, and installs the guidance only when it earns it. Everything here
// runs on fixture journals, fake generators/exec and temp dirs: no omp process is spawned, and nothing is
// written under the real ~/.omp (every evolve call below carries an env whose HOME is a temp dir).
//
// What a replay case must mirror (omp source, packages/agent/src/compaction/):
//  - cut:    compaction.ts:1419-1473. omp summarizes only the messages from the previous boundary (the previous
//            compaction's firstKeptEntryId, else the start) up to but excluding this compaction's
//            firstKeptEntryId; the retained tail is not part of the summary input.
//  - format: the summarizer renders with the dialect picked for the summarizer model (xml fallback, anthropic,
//            harmony, kimi, ...), so labels are NOT pinned here. Tests assert which texts are included (user,
//            assistant, tool call, tool result, custom/nudge text) or excluded (thinking for the anthropic dialect,
//            an abandoned branch, non-message entries), the 2000-char tool-result cut (utils.ts:209-218) and the
//            boundary-tag escaping (utils.ts:220-225).
//  - prompt: compaction.ts:987-1001: <conversation>, <previous-summary> (update only), <additional-context>
//            (where session.compacting `context` strings land), then the (update) summarization prompt.
//  - only compactions that ran the summarizer WITH the session.compacting context make cases: no `method`,
//    `method: "soft"` or `method: "remote"`. handoff (auto handoff skips that context), snapcompact, shake,
//    rollover (details.kind "experimental-context-rollover", no summarizer) and extension-supplied compactions
//    (`fromExtension`) are skipped and counted by method.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname as dirnameOf, join } from "node:path";
import {
  QuotaError,
  SUMMARIZATION_PROMPT,
  UPDATE_SUMMARIZATION_PROMPT,
  buildCases,
  countSkipped,
  MAX_PROMPT_BYTES,
  SUMMARIZATION_SYSTEM_PROMPT,
  cleanupLive,
  trackTempFile,
  liveTempDirs,
  validateBank,
  createOmpGenerator,
  dialectFor,
  runCommand,
  defaultTargetDir,
  evolve,
  expected,
  leaks,
  loadJournals,
  score,
  summaryPrompt,
} from "./evolve";
import { DEFAULT_GUIDANCE } from "../index";

const FIXTURES = join(import.meta.dir, "fixtures");
const SESSIONS = join(FIXTURES, "sessions"); // journals that make cases
const SKIPPED = join(FIXTURES, "skipped"); // journals whose compactions are all skipped or mixed by method

const made: string[] = [];
const tmp = (name: string) => {
  const d = mkdtempSync(join(tmpdir(), `omp-evolve-${name}-`));
  made.push(d);
  return d;
};
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

// Questions are asked only when every fact appears in the summarized range (plus the lead); a fact lists its
// spellings and the one seen last is the expected answer. A session is holdout when one of `holdout` is a
// substring of its title (title slot or session header) OR of its file name (without .jsonl).
const BANK = {
  holdout: ["holdout-"],
  questions: [
    { id: "jump", kind: "connection steps read from a doc", facts: [["jump.lab.internal"], ["-p 2222", "-p 2200"], ["10.9.8.7"]] },
    { id: "marker", kind: "tracker id", facts: [["HERON-12"]] },
    { id: "kube", kind: "cluster context", facts: [["stg-east"], ["ns-payments"]] },
    { id: "never", kind: "absent", facts: [["not-in-any-history"]] },
    { id: "tail", kind: "rollback id", facts: [["ZZ-TAIL-9"]] },
    { id: "roll", kind: "rollover-range fact", facts: [["RB-ROLL-77"]] },
  ],
};

describe("journal parsing", () => {
  test("copies each journal to the temp root first and parses the copy, found recursively", () => {
    const src = tmp("src");
    mkdirSync(join(src, "nested", "deeper"), { recursive: true });
    cpSync(join(SESSIONS, "train-legacy.jsonl"), join(src, "train-legacy.jsonl"));
    cpSync(join(SESSIONS, "kube-session.jsonl"), join(src, "nested", "deeper", "kube-session.jsonl"));
    writeFileSync(join(src, "notes.txt"), "not a journal");
    const snap = () => new Map(readdirSync(src, { recursive: true }).map((f) => [String(f), statSync(join(src, String(f))).mtimeMs]));
    const before = snap();
    const tempRoot = tmp("copies");

    const sessions = loadJournals(src, { tempRoot });

    expect(sessions.map((s) => s.name).sort()).toEqual(["kube-session", "train-legacy"]);
    for (const s of sessions) {
      expect(s.path.startsWith(tempRoot)).toBe(true);
      expect(s.source.startsWith(src)).toBe(true);
      expect(readFileSync(s.path, "utf8")).toBe(readFileSync(s.source, "utf8"));
      expect(s.entries.length).toBeGreaterThan(5);
    }
    expect(snap()).toEqual(before); // the source tree is left exactly as it was
  });

  test("skips lines that are not JSON instead of failing", () => {
    const legacy = loadJournals(SESSIONS, { tempRoot: tmp("copies") }).find((s) => s.name === "train-legacy")!;
    expect(legacy.entries.filter((e: any) => e.type === "compaction")).toHaveLength(2);
  });

  test("tempRoot is required, so no caller can leak an unowned copy dir", () => {
    expect(() => (loadJournals as any)(SESSIONS, {})).toThrow(/tempRoot/);
    expect(() => (loadJournals as any)(SESSIONS)).toThrow(/tempRoot/);
  });

  test("reads the session title from the title slot", () => {
    const sessions = loadJournals(SESSIONS, { tempRoot: tmp("copies") });
    expect(sessions.find((s) => s.name === "kube-session")!.title).toBe("holdout-kube-check");
    expect(sessions.find((s) => s.name === "train-legacy")!.title).toBe("");
  });
});

describe("replay cases from compaction entries", () => {
  const sessions = () => loadJournals(SESSIONS, { tempRoot: tmp("copies") });
  const caseOf = (id: string, bank = BANK) => buildCases(sessions(), bank).find((c) => c.id === id)!;

  test("one case per summarizer compaction, numbered by position among the session's compactions", () => {
    const cases = buildCases(sessions(), BANK);
    // kube-session: compaction #1 summarizes (no method), #2 is a rollover and makes no case
    expect(cases.map((c) => c.id).sort()).toEqual(["kube-session#1", "train-legacy#1", "train-legacy#2"]);
  });

  test("a rollover compaction makes no case even when an answerable fact sits in its summarized range", () => {
    // RB-ROLL-77 lives in the range the rollover (#2) covers (e005..e007) and nowhere else, so the only thing
    // that can keep it out of the cases is the experimental-context-rollover filter.
    const all = buildCases(sessions(), BANK);
    expect(all.some((c) => c.id === "kube-session#2")).toBe(false);
    expect(all.some((c) => c.questions.some((q: any) => q.id === "roll"))).toBe(false);
  });

  test("a journal with only a rollover compaction, its range holding an answerable fact, yields no cases", () => {
    const src = tmp("rollover-only");
    const lines = readFileSync(join(SESSIONS, "kube-session.jsonl"), "utf8").split("\n");
    writeFileSync(join(src, "only-rollover.jsonl"), lines.filter((l) => !l.includes('"KUBE SUMMARY')).join("\n"));
    const sessions = loadJournals(src, { tempRoot: tmp("copies") });
    expect(sessions[0].entries.some((e: any) => JSON.stringify(e).includes("RB-ROLL-77"))).toBe(true);
    expect(buildCases(sessions, BANK)).toEqual([]);
  });

  test("the transcript is what omp summarizes: start up to, excluding, firstKeptEntryId", () => {
    const c1 = caseOf("train-legacy#1");
    expect(c1.update).toBe(false);
    expect(c1.lead).toBe("");
    expect(c1.transcript).toContain("Deploy the staging service. Read docs/ops.md first.");
    expect(c1.transcript).toContain("The port changed, use -p 2200 from now on.");
    expect(c1.transcript).toContain("Understood, I will use port 2200.");
    expect(c1.transcript).toMatch(/read[\s\S]*docs\/ops\.md/); // the tool call: name and argument
    expect(c1.transcript).toContain("Jump host: jump.lab.internal"); // the tool result
    // custom_message entries reach the summarizer too (getMessageFromEntry)
    expect(c1.transcript).toContain("NUDGE-TEXT near threshold");
    // not part of the input: non-message entries (credential_pin), the retained tail (e010 onward), an abandoned sibling branch, the future
    expect(c1.transcript).not.toContain("credential");
    expect(c1.transcript).not.toContain("RETAINED-TAIL-ONE");
    expect(c1.transcript).not.toContain("ZZ-TAIL-9");
    expect(c1.transcript).not.toContain("DEADEND-TEXT");
    expect(c1.transcript).not.toContain("HERON-12");
    expect(c1.transcript).not.toContain("MESSAGE-AFTER-LAST-COMPACTION");
  });

  test("the next compaction restarts at the previous firstKeptEntryId, so the old tail is now summarized", () => {
    const c2 = caseOf("train-legacy#2");
    expect(c2.update).toBe(true);
    expect(c2.lead).toBe("OLD SUMMARY ONE: goal is the staging deploy.");
    expect(c2.transcript).toContain("RETAINED-TAIL-ONE keep going with the deploy.");
    expect(c2.transcript).toContain("Working on it. Code ZZ-TAIL-9 is the rollback id.");
    expect(c2.transcript).toContain("Tracker marker for this work is HERON-12.");
    // already summarized before, or still retained, or later
    expect(c2.transcript).not.toContain("Jump host");
    expect(c2.transcript).not.toContain("NUDGE-TEXT");
    expect(c2.transcript).not.toContain("RETAINED-TAIL-TWO");
    expect(c2.transcript).not.toContain("MESSAGE-AFTER-LAST-COMPACTION");
  });

  test("questions are answerable from the summarized range plus the lead, the last spelling being expected", () => {
    expect(caseOf("train-legacy#1").questions).toEqual([
      { id: "jump", kind: "connection steps read from a doc", facts: ["jump.lab.internal", "-p 2200", "10.9.8.7"] },
    ]);
    // ZZ-TAIL-9 sits in the tail retained at #1, so it is asked at #2 only; the jump facts left with #1's cut
    expect(caseOf("train-legacy#2").questions.map((q: any) => q.id)).toEqual(["marker", "tail"]);
    expect(caseOf("kube-session#1").questions.map((q: any) => q.id)).toEqual(["kube"]);
  });

  test("a fact that survives only in the lead summary still makes its question answerable", () => {
    const bank = { holdout: [], questions: [{ id: "lead", kind: "k", facts: [["OLD SUMMARY ONE"], ["HERON-12"]] }] };
    const c = buildCases(sessions(), bank);
    expect(c.map((x) => x.id)).toEqual(["train-legacy#2"]);
  });

  test("a compaction with no answerable question yields no case", () => {
    expect(buildCases(sessions(), { holdout: [], questions: [BANK.questions[3]] })).toEqual([]);
  });

  test("expected(): the spelling that appears last wins, undefined when none appears", () => {
    expect(expected("ssh -p 2222 ... later ... ssh -p 2200", ["-p 2222", "-p 2200"])).toBe("-p 2200");
    expect(expected("only -p 2222 here", ["-p 2222", "-p 2200"])).toBe("-p 2222");
    expect(expected("nothing", ["-p 2222"])).toBeUndefined();
  });

  describe("split: holdout patterns match the session title OR the file name", () => {
    test("by title (kube-session.jsonl carries the title holdout-kube-check)", () => {
      expect(caseOf("kube-session#1").split).toBe("holdout");
      expect(caseOf("train-legacy#1").split).toBe("train");
    });
    test("by file name", () => {
      const src = tmp("byname");
      cpSync(join(SESSIONS, "train-legacy.jsonl"), join(src, "holdout-copy.jsonl"));
      const cases = buildCases(loadJournals(src, { tempRoot: tmp("copies") }), BANK);
      expect(cases.map((c) => [c.id, c.split])).toEqual([
        ["holdout-copy#1", "holdout"],
        ["holdout-copy#2", "holdout"],
      ]);
    });
  });

  describe("serialization (omp serializeConversation)", () => {
    const entry = (id: string, parentId: string | null, message: any) => ({ type: "message", id, parentId, message });
    const session = (messages: any[], keptIndex: number) => {
      const entries: any[] = [];
      let parent: string | null = null;
      messages.forEach((m, i) => {
        entries.push(entry(`m${i}`, parent, m));
        parent = `m${i}`;
      });
      entries.push({ type: "compaction", id: "c1", parentId: parent, summary: "S", firstKeptEntryId: `m${keptIndex}`, tokensBefore: 1 });
      return [{ name: "mem", title: "", source: "mem", path: "mem", entries }];
    };
    const one = { holdout: [], questions: [{ id: "q", kind: "k", facts: [["needle"]] }] };
    const text = (c: string) => [{ type: "text", text: c }];

    test("user, assistant text, tool call (name and arguments) and tool result texts are all included", () => {
      const msgs = [
        { role: "user", content: text("needle go") },
        { role: "assistant", content: [{ type: "text", text: "on it" }, { type: "toolCall", id: "t1", name: "grep", arguments: { pattern: "a b", n: 3 } }] },
        { role: "toolResult", toolCallId: "t1", content: text("RESULT-BODY") },
        { role: "user", content: text("tail") },
      ];
      const [c] = buildCases(session(msgs, 3) as any, one);
      for (const t of ["needle go", "on it", "grep", "a b", "RESULT-BODY"]) expect(c.transcript).toContain(t);
      expect(c.transcript).not.toContain("tail");
    });

    test("thinking is rendered, except for the anthropic dialect which drops it", () => {
      const msgs = [
        { role: "user", content: text("needle go") },
        { role: "assistant", content: [{ type: "thinking", thinking: "plan-it-quietly" }, { type: "text", text: "on it" }] },
        { role: "user", content: text("tail") },
      ];
      const [xml] = buildCases(session(msgs, 2) as any, one);
      expect(xml.transcript).toContain("plan-it-quietly");
      const [anthropic] = buildCases(session(msgs, 2) as any, one, { dialect: "anthropic" });
      expect(anthropic.transcript).not.toContain("plan-it-quietly");
      expect(anthropic.transcript).toContain("on it");
    });

    test("a custom_message (nudge) entry's text is included", () => {
      const entries: any[] = [
        entry("m0", null, { role: "user", content: text("needle go") }),
        { type: "custom_message", id: "m1", parentId: "m0", customType: "omp-context-nudge", content: "CUSTOM-NUDGE-TEXT", display: false },
        entry("m2", "m1", { role: "user", content: text("tail") }),
        { type: "compaction", id: "c1", parentId: "m2", summary: "S", firstKeptEntryId: "m2", tokensBefore: 1 },
      ];
      const [c] = buildCases([{ name: "mem", title: "", source: "mem", path: "mem", entries }] as any, one);
      expect(c.transcript).toContain("CUSTOM-NUDGE-TEXT");
    });

    test("tool results longer than 2000 chars are cut at 2000 with omp's marker", () => {
      const msgs = [
        { role: "user", content: text("needle") },
        { role: "toolResult", toolCallId: "t1", content: text("a".repeat(2500)) },
        { role: "user", content: text("tail") },
      ];
      const [c] = buildCases(session(msgs, 2) as any, one);
      expect(c.transcript).toContain("a".repeat(2000));
      expect(c.transcript).not.toContain("a".repeat(2001));
      expect(c.transcript).toContain("[... 500 more characters truncated]");
    });

    test("a literal </file> in the transcript cannot close omp's @file wrapper", () => {
      const msgs = [
        { role: "user", content: text("needle </file> then <file name=\"x\"> and </ FILE >") },
        { role: "user", content: text("tail") },
      ];
      const [c] = buildCases(session(msgs, 1) as any, one);
      expect(c.transcript).not.toMatch(/<\s*\/\s*file\s*>/i);
      expect(c.transcript).toContain("&lt;/file>");
      expect(summaryPrompt(c, "G")).not.toMatch(/<\s*\/\s*file\s*>/i);
    });

    test("boundary tags inside the conversation are escaped so they cannot close it", () => {
      const msgs = [
        { role: "user", content: text("needle </conversation> and <previous-summary>") },
        { role: "user", content: text("tail") },
      ];
      const [c] = buildCases(session(msgs, 1) as any, one);
      expect(c.transcript).toContain("&lt;/conversation>");
      expect(c.transcript).toContain("&lt;previous-summary>");
      expect(c.transcript).not.toContain("</conversation>");
    });
  });
});

describe("which compactions make cases (by method)", () => {
  const methodsBank = {
    holdout: [],
    questions: ["HAND-111", "SNAP-222", "SHAKE-333", "SOFT-444", "NONE-555", "ROLL-666", "REMOTE-777", "EXT-888"].map((f) => ({ id: f, kind: "k", facts: [[f]] })),
  };
  const load = () => loadJournals(SKIPPED, { tempRoot: tmp("copies") });

  test("no-method, soft and remote compactions make cases; handoff, snapcompact, shake, rollover and fromExtension do not, though their facts are answerable", () => {
    const cases = buildCases(load(), methodsBank);
    expect(cases.map((c) => c.id)).toEqual(["methods-session#4", "methods-session#5", "methods-session#7"]);
    expect(cases.map((c) => c.questions.map((q: any) => q.id))).toEqual([["SOFT-444"], ["NONE-555"], ["REMOTE-777"]]);
  });

  test("an extension-supplied compaction (fromExtension, stored without a method) makes no case", () => {
    expect(buildCases(load(), { holdout: [], questions: [methodsBank.questions[7]] })).toEqual([]);
  });

  test("a remote compaction with an answerable fact makes a case", () => {
    expect(buildCases(load(), { holdout: [], questions: [methodsBank.questions[6]] }).map((c) => c.id)).toEqual(["methods-session#7"]);
  });

  test("a handoff compaction with an answerable fact makes no case", () => {
    const cases = buildCases(load(), { holdout: [], questions: [methodsBank.questions[0]] });
    expect(cases).toEqual([]);
  });

  test("the report counts skipped compactions by method", () => {
    expect(countSkipped(load())).toEqual({ handoff: 1, snapcompact: 1, shake: 1, rollover: 1, extension: 1 });
    expect(countSkipped(loadJournals(SESSIONS, { tempRoot: tmp("copies") }))).toEqual({ rollover: 1 });
  });

  test("evolve reports the skipped counts in its result", async () => {
    const src = tmp("mixed");
    cpSync(SESSIONS, src, { recursive: true });
    cpSync(join(SKIPPED, "methods-session.jsonl"), join(src, "methods-session.jsonl"));
    const result: any = await evolve({
      sessionsDir: src,
      bank: { ...BANK, questions: [...BANK.questions, ...methodsBank.questions] },
      generate: async (_p: string, o: { purpose: string }) => (o.purpose === "proposal" ? "no gain" : "vague"),
      targetDir: tmp("target"),
      tempRoot: tmp("copies"),
      env: { HOME: tmp("home") },
      baseline: "base",
      rounds: 1,
      margin: 1,
    } as any);
    expect(result.skipped).toEqual({ handoff: 1, snapcompact: 1, shake: 1, rollover: 2, extension: 1 });
  });
});

describe("the summarizer prompt (omp compaction.ts:987-1001)", () => {
  const item = {
    id: "x#1",
    update: false,
    lead: "",
    transcript: "[User]: hi",
    questions: [
      { id: "deploy", kind: "commands", facts: ["migrate ENV=staging", "--canary 10"] },
      { id: "mark", kind: "id", facts: ["HERON-12"] },
    ],
  };
  const omp = (name: string) => readFileSync(join(FIXTURES, "omp-prompts", name), "utf8").trim();

  test("the prompt texts equal omp's prompts/compaction-summary.md and compaction-update-summary.md", () => {
    expect(SUMMARIZATION_PROMPT.trim()).toBe(omp("compaction-summary.md"));
    expect(UPDATE_SUMMARIZATION_PROMPT.trim()).toBe(omp("compaction-update-summary.md"));
  });

  test("the summarization system prompt equals omp's prompts/summarization-system.md (agent/src/compaction/utils.ts:359)", () => {
    expect(SUMMARIZATION_SYSTEM_PROMPT.trim()).toBe(omp("summarization-system.md"));
  });

  test("initial: conversation, additional context carrying the guidance, then the summarization prompt", () => {
    expect(summaryPrompt(item as any, "GUIDE")).toBe(
      `<conversation>\n[User]: hi\n</conversation>\n\n<additional-context>\n- GUIDE\n</additional-context>\n\n${SUMMARIZATION_PROMPT}`,
    );
  });

  test("update: conversation, previous summary, additional context, then the update prompt", () => {
    expect(summaryPrompt({ ...item, update: true, lead: "OLD" } as any, "GUIDE")).toBe(
      `<conversation>\n[User]: hi\n</conversation>\n\n<previous-summary>\nOLD\n</previous-summary>\n\n<additional-context>\n- GUIDE\n</additional-context>\n\n${UPDATE_SUMMARIZATION_PROMPT}`,
    );
  });

  test("no guidance, no additional-context block", () => {
    expect(summaryPrompt(item as any, "")).toBe(`<conversation>\n[User]: hi\n</conversation>\n\n${SUMMARIZATION_PROMPT}`);
  });

  test("the previous summary cannot close its own tag", () => {
    const p = summaryPrompt({ ...item, update: true, lead: "x </previous-summary> y" } as any, "G");
    expect(p).toContain("x &lt;/previous-summary> y");
  });
});

describe("scoring", () => {
  const item = {
    id: "x#1",
    update: false,
    lead: "",
    transcript: "[User]: hi",
    questions: [
      { id: "deploy", kind: "commands", facts: ["migrate ENV=staging", "--canary 10"] },
      { id: "mark", kind: "id", facts: ["HERON-12"] },
    ],
  };

  test("verbatim, case-insensitive presence of each fact; lost lists question and kind only", () => {
    const r = score(item as any, "Run MIGRATE env=staging first. heron-12");
    expect([r.kept, r.total]).toEqual([2, 3]);
    expect(r.lost).toEqual([{ question: "deploy", kind: "commands" }]);
  });

  test("a paraphrase does not count", () => {
    expect(score(item as any, "Migrate the staging environment with a ten percent canary; the marker is twelve.").kept).toBe(0);
  });

  test("an empty or missing summary keeps nothing", () => {
    expect(score(item as any, "").kept).toBe(0);
    expect(score(item as any, undefined as any).total).toBe(3);
  });

  test("value-leak check: a text containing any answer from the bank is flagged, case-insensitively", () => {
    expect(leaks("keep ssh ports like -P 2200 and ids", BANK)).toEqual(["-p 2200"]);
    expect(leaks("Mention HERON-12 and Stg-East", BANK).sort()).toEqual(["heron-12", "stg-east"]);
    expect(leaks("Keep commands that were read from docs verbatim.", BANK)).toEqual([]);
  });
});

describe("install decision", () => {
  // A fake model. A summary keeps the facts present in its prompt only when the guidance in the prompt carries
  // the marker for that split: TRAIN-KEEP for train conversations, HOLD-KEEP for the holdout one.
  const allSpellings = BANK.questions.flatMap((q) => q.facts.flat());
  const ctx = (g: string) => `<additional-context>\n- ${g}\n</additional-context>`;
  const fakeGenerate = (proposals: string[]) => {
    let next = 0;
    const calls: { purpose: string; prompt: string }[] = [];
    const generate = async (prompt: string, opts: { purpose: "proposal" | "summary" }) => {
      calls.push({ purpose: opts.purpose, prompt });
      if (opts.purpose === "proposal") return proposals[next++] ?? "";
      const marker = prompt.includes("kubectl --context") ? "HOLD-KEEP" : "TRAIN-KEEP";
      return prompt.includes(marker) ? allSpellings.filter((s) => prompt.includes(s)).join("; ") : "A vague summary.";
    };
    return { generate, calls };
  };
  // Every call gets an env whose HOME is a temp dir, so even an implementation that ignored `targetDir` could
  // not touch the real home.
  const run = (target: string, proposals: string[], extra: Record<string, unknown> = {}) => {
    const { generate, calls } = fakeGenerate(proposals);
    return evolve({
      sessionsDir: SESSIONS,
      bank: BANK,
      generate,
      targetDir: target,
      tempRoot: tmp("copies"),
      env: { HOME: tmp("home") },
      baseline: "HOLD-KEEP",
      rounds: proposals.length,
      margin: 1,
      ...extra,
    } as any).then((result: any) => ({ result, calls }));
  };

  test("installs guidance.md when train improves by the margin and holdout does not drop", async () => {
    const target = tmp("target");
    const { result } = await run(target, ["HOLD-KEEP TRAIN-KEEP: keep concrete values verbatim."]);
    expect(result.installed).toBe(true);
    expect(readFileSync(join(target, "guidance.md"), "utf8")).toBe("HOLD-KEEP TRAIN-KEEP: keep concrete values verbatim.");
    expect(result.train.after.kept - result.train.before.kept).toBeGreaterThanOrEqual(1);
    expect(result.holdout.after.kept).toBeGreaterThanOrEqual(result.holdout.before.kept);
    expect(readdirSync(target)).toEqual(["guidance.md"]);
  });

  test("candidate summaries are requested with the candidate guidance in omp's layout, one request per case", async () => {
    const { calls } = await run(tmp("target"), ["HOLD-KEEP TRAIN-KEEP"]);
    const summaries = calls.filter((c) => c.purpose === "summary");
    expect(summaries.filter((c) => c.prompt.includes(ctx("HOLD-KEEP TRAIN-KEEP")))).toHaveLength(3);
    expect(summaries.filter((c) => c.prompt.includes(ctx("HOLD-KEEP")))).toHaveLength(3); // the baseline's own pass
    expect(summaries.every((c) => c.prompt.startsWith("<conversation>\n"))).toBe(true);
  });

  test("no install, nothing written, reason reported, when train does not improve", async () => {
    const target = tmp("target");
    const { result } = await run(target, ["HOLD-KEEP only: no gain on train."]);
    expect(result.installed).toBe(false);
    expect(result.reason).toMatch(/train/i);
    expect(readdirSync(target)).toEqual([]);
  });

  test("no install when the gain is below the margin", async () => {
    const target = tmp("target");
    const { result } = await run(target, ["HOLD-KEEP TRAIN-KEEP"], { margin: 99 });
    expect(result.installed).toBe(false);
    expect(result.reason).toMatch(/margin/i);
    expect(readdirSync(target)).toEqual([]);
  });

  test("no install when holdout drops, even though train improves", async () => {
    const target = tmp("target");
    const { result } = await run(target, ["TRAIN-KEEP: helps train, loses the holdout."]);
    expect(result.installed).toBe(false);
    expect(result.reason).toMatch(/holdout/i);
    expect(readdirSync(target)).toEqual([]);
  });

  test("a rejected run leaves an existing guidance.md untouched", async () => {
    const target = tmp("target");
    writeFileSync(join(target, "guidance.md"), "PREVIOUS GUIDANCE");
    const { result } = await run(target, ["TRAIN-KEEP: loses the holdout."]);
    expect(result.installed).toBe(false);
    expect(readFileSync(join(target, "guidance.md"), "utf8")).toBe("PREVIOUS GUIDANCE");
  });

  test("a candidate that contains a bank answer is discarded unscored, and the next round can still win", async () => {
    const target = tmp("target");
    const { result, calls } = await run(target, ["HOLD-KEEP TRAIN-KEEP and remember HERON-12", "HOLD-KEEP TRAIN-KEEP clean"]);
    expect(result.installed).toBe(true);
    expect(readFileSync(join(target, "guidance.md"), "utf8")).toBe("HOLD-KEEP TRAIN-KEEP clean");
    expect(result.history[0].outcome).toMatch(/leak/i);
    expect(result.history[0].outcome).toMatch(/heron-12/);
    expect(calls.some((c) => c.purpose === "summary" && c.prompt.includes("remember HERON-12"))).toBe(false);
  });

  test("with no baseline option, the baseline is the guidance already in the target dir, else the built-in default", async () => {
    const target = tmp("target");
    writeFileSync(join(target, "guidance.md"), "ALREADY HOLD-KEEP");
    const first = await run(target, ["x"], { baseline: undefined });
    expect(first.calls.some((c) => c.purpose === "summary" && c.prompt.includes(ctx("ALREADY HOLD-KEEP")))).toBe(true);

    const second = await run(tmp("target"), ["x"], { baseline: undefined });
    expect(second.calls.some((c) => c.purpose === "summary" && c.prompt.includes(`<additional-context>\n- ${DEFAULT_GUIDANCE}`))).toBe(true);
  });

  describe("an empty split refuses to run", () => {
    test("no holdout sessions: reported, no model call, nothing written", async () => {
      const target = tmp("target");
      const { result, calls } = await run(target, ["HOLD-KEEP TRAIN-KEEP"], { bank: { ...BANK, holdout: ["matches-nothing"] } });
      expect(result.installed).toBe(false);
      expect(result.reason).toMatch(/holdout/i);
      expect(result.reason).toMatch(/no cases|empty|no /i);
      expect(calls).toEqual([]);
      expect(readdirSync(target)).toEqual([]);
    });

    test("no train sessions: reported, no model call, nothing written", async () => {
      const target = tmp("target");
      const { result, calls } = await run(target, ["HOLD-KEEP TRAIN-KEEP"], { bank: { ...BANK, holdout: ["train-", "kube-"] } });
      expect(result.installed).toBe(false);
      expect(result.reason).toMatch(/train/i);
      expect(calls).toEqual([]);
      expect(readdirSync(target)).toEqual([]);
    });
  });

  describe("generator failure never installs", () => {
    const failing = (error: Error, when: "summary" | "proposal") => async (_p: string, opts: { purpose: string }) => {
      if (opts.purpose === when) throw error;
      return opts.purpose === "proposal" ? "HOLD-KEEP TRAIN-KEEP" : "A vague summary.";
    };

    test("a generator that throws: installed false, target dir unchanged, reason names the failure", async () => {
      const target = tmp("target");
      writeFileSync(join(target, "guidance.md"), "PREVIOUS GUIDANCE");
      const { result } = await run(target, ["x"], { generate: failing(new Error("generator exploded: boom"), "summary") });
      expect(result.installed).toBe(false);
      // the drop path: every case failed at baseline and was dropped with the failure as its reason
      expect(result.dropped.map((d: any) => d.id).sort()).toEqual(["kube-session#1", "train-legacy#1", "train-legacy#2"]);
      expect(result.dropped.every((d: any) => /boom/.test(d.reason))).toBe(true);
      expect(result.reason).toMatch(/no cases left/);
      expect(result.reason).toMatch(/boom/);
      expect(readdirSync(target)).toEqual(["guidance.md"]);
      expect(readFileSync(join(target, "guidance.md"), "utf8")).toBe("PREVIOUS GUIDANCE");
    });

    test("a failing proposal request is handled the same way", async () => {
      const target = tmp("target");
      const { result } = await run(target, ["x"], { generate: failing(new Error("proposer down: nope"), "proposal") });
      expect(result.installed).toBe(false);
      expect(result.reason).toMatch(/nope/);
      expect(readdirSync(target)).toEqual([]);
    });

    test("a quota error stops the run and the reason says quota", async () => {
      const target = tmp("target");
      const { result } = await run(target, ["x"], { generate: failing(new QuotaError("usage limit reached"), "summary") });
      expect(result.installed).toBe(false);
      expect(result.reason).toMatch(/quota/i);
      expect(result.reason).toMatch(/usage limit reached/);
      expect(readdirSync(target)).toEqual([]);
    });
  });

  describe("the default generator (omp -p, injectable exec)", () => {
    const fakeExec = (reply: { code: number; stdout?: string; stderr?: string }) => {
      const calls: { cmd: string; args: string[]; opts: any }[] = [];
      const exec = async (cmd: string, args: string[], opts: any) => {
        calls.push({ cmd, args, opts });
        return { code: reply.code, stdout: reply.stdout ?? "", stderr: reply.stderr ?? "" };
      };
      return { exec, calls };
    };

    test("argv carries -p, isolation flags, --model <id>, --session-dir <temp dir>, @<prompt file>; stdin closed, cwd an empty temp dir", async () => {
      const seen: { file: string; body: string; cwd: string; sessionDir: string; cwdEntries: string[] }[] = [];
      const calls: { cmd: string; args: string[]; opts: any }[] = [];
      const exec = async (cmd: string, args: string[], opts: any) => {
        calls.push({ cmd, args, opts });
        const file = args.find((a) => a.startsWith("@"))!.slice(1);
        const sessionDir = args[args.indexOf("--session-dir") + 1];
        const sp = args[args.indexOf("--system-prompt") + 1];
        seen.push({ file, body: readFileSync(file, "utf8"), cwd: opts.cwd, sessionDir, cwdEntries: readdirSync(opts.cwd), systemPrompt: sp, systemBody: readFileSync(sp, "utf8") } as any);
        return { code: 0, stdout: "  the reply\n", stderr: "" };
      };
      const prompt = "THE PROMPT with <tags> and \"quotes\"\n" + "x".repeat(200_000); // far beyond any argv limit
      expect(await createOmpGenerator({ model: "prov/model-x", exec })(prompt, { purpose: "summary" })).toBe("the reply");
      expect(calls).toHaveLength(1);
      const { cmd, args, opts } = calls[0];
      expect(cmd).toBe("omp");
      for (const f of ["-p", "--no-tools", "--no-extensions", "--no-skills", "--no-rules", "--no-title", "--no-lsp"]) expect(args).toContain(f);
      expect(args[args.indexOf("--thinking") + 1]).toBe("high"); // omp's compaction default effort (compaction.ts:651-655)
      // omp's summarization system prompt, passed as a file path (omp reads a single-line value as a path:
      // system-prompt.ts:285-300), so it is not bound by argv limits
      const sp = (seen[0] as any).systemPrompt as string;
      expect(sp.includes("\n")).toBe(false);
      expect((seen[0] as any).systemBody).toBe(SUMMARIZATION_SYSTEM_PROMPT);
      expect(existsSync(sp)).toBe(false); // removed afterwards
      expect(args[args.indexOf("--model") + 1]).toBe("prov/model-x");
      expect(seen[0].sessionDir.startsWith(tmpdir())).toBe(true);
      expect(args.some((a) => a === prompt)).toBe(false); // the prompt is not on the command line
      expect(seen[0].body).toBe(prompt); // it is in the @file, byte for byte
      expect(opts.stdin).toBe("ignore");
      expect(seen[0].cwd).not.toBe(process.cwd());
      expect(seen[0].cwd.startsWith(tmpdir())).toBe(true);
      expect(seen[0].cwdEntries).toEqual([]); // fresh and empty
      // everything it made is removed afterwards
      expect(existsSync(seen[0].file)).toBe(false);
      expect(existsSync(seen[0].cwd)).toBe(false);
      expect(existsSync(seen[0].sessionDir)).toBe(false);
    });

    test("the temp files are removed when omp fails too", async () => {
      let file = "";
      const exec = async (_c: string, args: string[]) => {
        file = args.find((a) => a.startsWith("@"))!.slice(1);
        return { code: 1, stdout: "", stderr: "bad" };
      };
      await createOmpGenerator({ model: "p/m", exec })("P", { purpose: "summary" }).catch(() => {});
      expect(file).not.toBe("");
      expect(existsSync(file)).toBe(false);
    });

    test("a prompt over MAX_PROMPT_BYTES is refused with a clear error, before anything runs", async () => {
      let ran = false;
      const exec = async () => ((ran = true), { code: 0, stdout: "", stderr: "" });
      expect(MAX_PROMPT_BYTES).toBeLessThan(5 * 1024 * 1024); // omp skips @file contents over 5 MB (cli/file-processor.ts:24)
      expect(MAX_PROMPT_BYTES).toBeGreaterThan(1_000_000);
      const err = await createOmpGenerator({ model: "p/m", exec })("x".repeat(MAX_PROMPT_BYTES + 1), { purpose: "summary" }).catch((e: Error) => e);
      expect(String(err.message)).toMatch(/too large|over|exceed/i);
      expect(ran).toBe(false);
    });

    test("a non-zero exit becomes an error carrying the code and stderr", async () => {
      const { exec } = fakeExec({ code: 3, stderr: "model not found" });
      const gen = createOmpGenerator({ model: "p/m", exec });
      const err = await gen("P", { purpose: "summary" }).catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect(String(err.message)).toMatch(/3/);
      expect(String(err.message)).toMatch(/model not found/);
    });

    test("a quota message on a failed run becomes a QuotaError", async () => {
      const { exec } = fakeExec({ code: 1, stderr: "Usage limit reached, quota will reset at 5pm" });
      const err = await createOmpGenerator({ model: "p/m", exec })("P", { purpose: "summary" }).catch((e: Error) => e);
      expect(err).toBeInstanceOf(QuotaError);
    });

    test("through evolve: a failing omp run means installed false, nothing written, reason names the exit", async () => {
      const { exec, calls } = fakeExec({ code: 2, stderr: "spawn failure xyz" });
      const target = tmp("target");
      const { result } = await run(target, ["x"], { generate: undefined, model: "p/m", exec });
      expect(calls.length).toBeGreaterThan(0);
      expect(result.installed).toBe(false);
      expect(result.reason).toMatch(/spawn failure xyz|exit/i);
      expect(readdirSync(target)).toEqual([]);
    });
  });

  // A fake model plus failure injection: `when(prompt, purpose)` returns an Error to throw for that request.
  const runWith = (target: string, proposals: string[], when: (prompt: string, purpose: string) => Error | undefined, extra: Record<string, unknown> = {}) => {
    const fake = fakeGenerate(proposals);
    const generate = async (prompt: string, opts: { purpose: "proposal" | "summary" }) => {
      const e = when(prompt, opts.purpose);
      if (e) throw e;
      return fake.generate(prompt, opts);
    };
    return run(target, proposals, { generate, ...extra }).then(({ result }) => ({ result, calls: fake.calls }));
  };
  const T2 = "RETAINED-TAIL-ONE keep going"; // appears only in train-legacy#2's transcript
  const KUBE = "kubectl --context"; // appears only in the holdout case

  describe("per-case failures", () => {
    test("a case whose generator call fails at baseline is dropped and counted; the run continues", async () => {
      const target = tmp("target");
      const { result } = await runWith(target, ["HOLD-KEEP TRAIN-KEEP"], (p, purpose) => (purpose === "summary" && p.includes(T2) ? new Error("flaky model") : undefined));
      expect(result.dropped).toEqual([{ id: "train-legacy#2", reason: expect.stringMatching(/flaky model/) }]);
      expect(result.installed).toBe(true);
      expect(result.train.before.total).toBe(3); // only train-legacy#1's three jump facts are still scored
    });

    test("an oversize prompt is dropped and counted without being sent; the run continues", async () => {
      const cases = buildCases(loadJournals(SESSIONS, { tempRoot: tmp("copies") }), BANK);
      const size = (c: any) => Buffer.byteLength(summaryPrompt(c, "HOLD-KEEP"));
      const train = cases.filter((c) => c.split === "train").sort((a, b) => size(b) - size(a));
      const limit = Math.floor((size(train[0]) + size(train[1])) / 2);
      expect(size(train[1]) + 50).toBeLessThan(limit);
      const target = tmp("target");
      const sent: string[] = [];
      const { result } = await runWith(target, ["HOLD-KEEP TRAIN-KEEP"], (p, purpose) => (purpose === "summary" ? (sent.push(p), undefined) : undefined), { maxPromptBytes: limit });
      expect(result.dropped.map((d: any) => d.id)).toEqual([train[0].id]);
      expect(result.dropped[0].reason).toMatch(/too large|over|exceed/i);
      expect(sent.every((p) => Buffer.byteLength(p) <= limit)).toBe(true);
      expect(result.installed).toBe(true);
    });

    test("a quota error while scoring a candidate stops the run before any install", async () => {
      const target = tmp("target");
      const { result } = await runWith(target, ["HOLD-KEEP TRAIN-KEEP CAND-QUOTA"], (p, purpose) =>
        purpose === "summary" && p.includes("CAND-QUOTA") ? new QuotaError("usage limit reached") : undefined,
      );
      expect(result.installed).toBe(false);
      expect(result.reason).toMatch(/quota/i);
      expect(readdirSync(target)).toEqual([]);
    });

    test("a candidate's failure on a case that passed baseline scores 0 for that case instead of aborting", async () => {
      const target = tmp("target");
      const { result } = await runWith(target, ["HOLD-KEEP TRAIN-KEEP CAND-FAIL"], (p, purpose) =>
        purpose === "summary" && p.includes("CAND-FAIL") && p.includes(T2) ? new Error("flaky") : undefined,
      );
      expect(result.installed).toBe(true);
      expect(result.train.after).toEqual({ kept: 3, total: 5 }); // #1 keeps its 3 facts, #2 counts as 0 of 2
      expect(result.dropped).toEqual([]);
    });

    test("when drops leave a split empty, it stops without installing and without asking for proposals", async () => {
      const target = tmp("target");
      const { result, calls } = await runWith(target, ["HOLD-KEEP TRAIN-KEEP"], (p, purpose) => (purpose === "summary" && p.includes(KUBE) ? new Error("holdout model down") : undefined));
      expect(result.installed).toBe(false);
      expect(result.reason).toMatch(/holdout/i);
      expect(result.reason).toMatch(/holdout model down/);
      expect(calls.filter((c) => c.purpose === "proposal")).toEqual([]);
      expect(readdirSync(target)).toEqual([]);
    });
  });

  describe("dialect", () => {
    const summaries = (calls: { purpose: string; prompt: string }[]) => calls.filter((c) => c.purpose === "summary").map((c) => c.prompt);
    test("dialectFor mirrors omp's anthropic decision (catalog/src/compat/taxonomy.ts boundedMatch, rules.json)", () => {
      // the token must start the bare id (the part after the last "/"), followed by end, - _ . : or a digit;
      // `anthropic` also counts as a namespace part of the id
      for (const id of ["anthropic/claude-sonnet-4", "claude-opus-5-5", "claude-opus-4", "anthropic/whatever", "claude4", "claude3-opus", "x/claude4.5", "anthropic2-x", "Claude-Opus-4", "claude"])
        expect([id, dialectFor(id)]).toEqual([id, "anthropic"]);
      for (const id of ["my-claude-x", "gpt-claude", "gemma-claude-x", "Qwen3.5-27B-Claude-4.6-Opus-Reasoning", "foo.claude-3", "opus-5.5", "sonnet-4", "haiku", "fable", "qwen/qwen3.8-27b-fable", "gemma-4-26b-a4b-it-opusdistill", "kimi-code/kimi-for-coding", "gpt-6.1-sol", "openai/gpt-5", "claudette-x"])
        expect([id, dialectFor(id)]).toEqual([id, "generic"]);
      expect(dialectFor(undefined)).toBe("generic");
    });
    test("anthropic drops thinking from the replayed conversation; generic keeps it", async () => {
      const a = await run(tmp("target"), ["HOLD-KEEP TRAIN-KEEP"], { dialect: "anthropic" });
      expect(summaries(a.calls).some((p) => p.includes("THINK-ONE"))).toBe(false);
      const g = await run(tmp("target"), ["HOLD-KEEP TRAIN-KEEP"], { dialect: "generic" });
      expect(summaries(g.calls).some((p) => p.includes("THINK-ONE"))).toBe(true);
    });
    test("with no dialect option it is derived from the model id", async () => {
      const a = await run(tmp("target"), ["HOLD-KEEP TRAIN-KEEP"], { model: "anthropic/claude-sonnet-4" });
      expect(summaries(a.calls).some((p) => p.includes("THINK-ONE"))).toBe(false);
      const g = await run(tmp("target"), ["HOLD-KEEP TRAIN-KEEP"], { model: "openai/gpt-5" });
      expect(summaries(g.calls).some((p) => p.includes("THINK-ONE"))).toBe(true);
    });
  });

  describe("temp cleanup", () => {
    const copies = () => new Set(readdirSync(tmpdir()).filter((n) => n.startsWith("omp-evolve-journals-")));
    const leftovers = async (extra: Record<string, unknown>, proposals = ["HOLD-KEEP TRAIN-KEEP"]) => {
      const before = copies();
      await run(tmp("target"), proposals, { tempRoot: undefined, ...extra });
      return [...copies()].filter((n) => !before.has(n));
    };
    test("the journal copies are removed after an install", async () => expect(await leftovers({})).toEqual([]));
    test("... after a dry run", async () => expect(await leftovers({ dryRun: true })).toEqual([]));
    test("... after a refusal on an empty split", async () => expect(await leftovers({ bank: { ...BANK, holdout: ["matches-nothing"] } })).toEqual([]));
    test("... after a generator failure", async () => {
      const boom = async () => {
        throw new Error("boom");
      };
      expect(await leftovers({ generate: boom })).toEqual([]);
    });
    test("... after an exception that escapes evolve (a missing sessions dir)", async () => {
      const before = copies();
      await expect(run(tmp("target"), ["x"], { tempRoot: undefined, sessionsDir: join(tmp("nowhere"), "absent") })).rejects.toThrow();
      expect([...copies()].filter((n) => !before.has(n))).toEqual([]);
    });
    test("... after a non-quota proposal failure that follows a completed baseline (generator calls had started)", async () => {
      const before = copies();
      let summaries = 0;
      const generate = async (_p: string, o: { purpose: string }) => {
        if (o.purpose === "proposal") throw new Error("proposer fell over");
        summaries++;
        return "vague";
      };
      const target = tmp("target");
      const { result } = await run(target, ["x"], { tempRoot: undefined, generate });
      expect(summaries).toBeGreaterThan(0); // the baseline ran before the throw
      expect(result.installed).toBe(false);
      expect(result.reason).toMatch(/proposer fell over/);
      expect(readdirSync(target)).toEqual([]);
      expect([...copies()].filter((n) => !before.has(n))).toEqual([]);
    });
    test("no omp-evolve-run-* dir remains after an evolve run with the default generator (fake exec)", async () => {
      const runs = () => new Set(readdirSync(tmpdir()).filter((n) => n.startsWith("omp-evolve-run-")));
      const before = runs();
      const exec = async () => ({ code: 0, stdout: "vague", stderr: "" });
      await run(tmp("target"), ["HOLD-KEEP TRAIN-KEEP"], { generate: undefined, model: "p/m", exec });
      expect([...runs()].filter((n) => !before.has(n))).toEqual([]);
    });
    test("a dry run reports the outcome and writes nothing", async () => {
      const target = tmp("target");
      const { result } = await run(target, ["HOLD-KEEP TRAIN-KEEP"], { dryRun: true });
      expect(result.installed).toBe(false);
      expect(result.dryRun).toBe(true);
      expect(result.guidance).toBe("HOLD-KEEP TRAIN-KEEP");
      expect(readdirSync(target)).toEqual([]);
    });
  });

  describe("install writes", () => {
    test("an existing guidance.md is replaced whole and nothing else is left in the target dir", async () => {
      const target = tmp("target");
      writeFileSync(join(target, "guidance.md"), "OLD GUIDANCE ".repeat(500));
      const { result } = await run(target, ["HOLD-KEEP TRAIN-KEEP short"]);
      expect(result.installed).toBe(true);
      expect(readFileSync(join(target, "guidance.md"), "utf8")).toBe("HOLD-KEEP TRAIN-KEEP short");
      expect(readdirSync(target)).toEqual(["guidance.md"]);
    });

    test("a write failure leaves the previous guidance.md intact and reports it", async () => {
      if (process.getuid?.() === 0) return; // root ignores directory permissions
      const target = tmp("target");
      writeFileSync(join(target, "guidance.md"), "PREVIOUS");
      chmodSync(target, 0o555);
      try {
        const { result } = await run(target, ["HOLD-KEEP TRAIN-KEEP short"], { baseline: undefined });
        expect(result.installed).toBe(false);
        expect(result.reason).toMatch(/could not write|write/i);
        expect(readFileSync(join(target, "guidance.md"), "utf8")).toBe("PREVIOUS");
      } finally {
        chmodSync(target, 0o755);
      }
    });
  });

  describe("proposer hygiene", () => {
    test("a candidate discarded for leaking is not shown to the next proposal, nor are the values it leaked", async () => {
      const { calls } = await run(tmp("target"), ["LEAKYTEXT-ZED HOLD-KEEP and remember HERON-12", "HOLD-KEEP TRAIN-KEEP clean"]);
      const proposals = calls.filter((c) => c.purpose === "proposal");
      expect(proposals).toHaveLength(2);
      expect(proposals[1].prompt).not.toContain("LEAKYTEXT-ZED");
      expect(proposals[1].prompt).not.toMatch(/heron-12/i);
      expect(proposals[1].prompt).toMatch(/leak/i); // it only learns that a candidate was discarded for leaking
    });
  });

  describe("candidate checks", () => {
    test("a candidate over 2000 characters is discarded unscored", async () => {
      const { result, calls } = await run(tmp("target"), ["HOLD-KEEP TRAIN-KEEP " + "a".repeat(2000)]);
      expect(result.installed).toBe(false);
      expect(result.history[0].outcome).toMatch(/discarded.*check/i);
      expect(calls.filter((c) => c.purpose === "summary" && c.prompt.includes("a".repeat(2000)))).toEqual([]);
    });
    test("a candidate containing < or > is discarded unscored", async () => {
      for (const bad of ["HOLD-KEEP TRAIN-KEEP <b>", "HOLD-KEEP TRAIN-KEEP a > b"]) {
        const { result, calls } = await run(tmp("target"), [bad]);
        expect(result.installed).toBe(false);
        expect(result.history[0].outcome).toMatch(/discarded.*check/i);
        expect(calls.filter((c) => c.purpose === "summary" && c.prompt.includes(bad))).toEqual([]);
      }
    });
  });

  describe("option validation inside evolve()", () => {
    test.each([["samples", Number.NaN], ["samples", 0], ["samples", -5], ["samples", 1.5], ["margin", 0], ["margin", Number.NaN], ["rounds", 0], ["rounds", -1], ["rounds", Number.POSITIVE_INFINITY]])(
      "%s=%p throws before any work",
      async (name, value) => {
        const before = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith("omp-evolve-journals-")));
        let called = 0;
        const generate = async () => (called++, "x");
        await expect(
          evolve({ sessionsDir: join(tmp("never-read"), "absent"), bank: BANK, generate, targetDir: tmp("target"), env: { HOME: tmp("home") }, [name]: value } as any),
        ).rejects.toThrow(new RegExp(name));
        expect(called).toBe(0);
        expect([...readdirSync(tmpdir())].filter((n) => n.startsWith("omp-evolve-journals-") && !before.has(n))).toEqual([]);
      },
    );
  });

  describe("more option validation", () => {
    test.each([0, -1, Number.NaN, 1.5, Number.POSITIVE_INFINITY])("maxPromptBytes=%p throws before any work", async (v) => {
      let called = 0;
      await expect(
        evolve({ sessionsDir: join(tmp("n"), "absent"), bank: BANK, generate: async () => (called++, "x"), targetDir: tmp("target"), env: { HOME: tmp("home") }, maxPromptBytes: v } as any),
      ).rejects.toThrow(/maxPromptBytes/);
      expect(called).toBe(0);
    });
    test("an empty targetDir is rejected (it would mean the current directory)", async () => {
      await expect(evolve({ sessionsDir: SESSIONS, bank: BANK, generate: async () => "x", targetDir: "", env: { HOME: tmp("home") } } as any)).rejects.toThrow(/targetDir/);
    });
  });

  describe("bank validation", () => {
    const bad: [string, any][] = [
      ["a missing questions array", {}],
      ["questions that is not an array", { questions: "x" }],
      ["an empty questions array", { questions: [] }],
      ["a question without id", { questions: [{ kind: "k", facts: [["a"]] }] }],
      ["a question without facts", { questions: [{ id: "q", kind: "k" }] }],
      ["empty facts", { questions: [{ id: "q", kind: "k", facts: [] }] }],
      ["a fact with no spellings", { questions: [{ id: "q", kind: "k", facts: [[]] }] }],
      ["an empty spelling", { questions: [{ id: "q", kind: "k", facts: [[""]] }] }],
      ["a non-string spelling", { questions: [{ id: "q", kind: "k", facts: [[3]] }] }],
      ["holdout that is not a string array", { holdout: "x", questions: [{ id: "q", kind: "k", facts: [["a"]] }] }],
    ];
    test.each(bad)("%s is rejected with a clear error", (_name, bank) => {
      expect(() => validateBank(bank)).toThrow(/bank/i);
    });
    test("a good bank passes", () => expect(() => validateBank(BANK)).not.toThrow());
    test("evolve() rejects a bad bank before any work", async () => {
      const before = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith("omp-evolve-journals-")));
      let called = 0;
      await expect(
        evolve({ sessionsDir: SESSIONS, bank: { questions: [{ id: "q", kind: "k", facts: [[""]] }] } as any, generate: async () => (called++, "x"), targetDir: tmp("target"), env: { HOME: tmp("home") } }),
      ).rejects.toThrow(/bank/i);
      expect(called).toBe(0);
      expect([...readdirSync(tmpdir())].filter((n) => n.startsWith("omp-evolve-journals-") && !before.has(n))).toEqual([]);
    });
  });

  describe("live temp resources (signal cleanup)", () => {
    test("a tracked temp file (the install's) is removed by cleanupLive, and untracking keeps it", () => {
      const dir = tmp("track");
      const a = join(dir, "a.tmp");
      const b = join(dir, "b.tmp");
      writeFileSync(a, "x");
      writeFileSync(b, "x");
      trackTempFile(a);
      const untrack = trackTempFile(b);
      untrack();
      cleanupLive();
      expect(existsSync(a)).toBe(false);
      expect(existsSync(b)).toBe(true);
    });

    test("cleanupLive removes the journal copy dir and the run dir of an in-flight generator call", async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let runDir = "";
      const exec = async (_c: string, args: string[]) => {
        runDir = dirnameOf(args[args.indexOf("--session-dir") + 1]);
        await gate;
        return { code: 0, stdout: "x", stderr: "" };
      };
      const p = run(tmp("target"), ["x"], { generate: undefined, model: "p/m", exec, tempRoot: undefined, rounds: 1 });
      for (let i = 0; i < 200 && !runDir; i++) await new Promise((r) => setTimeout(r, 10));
      expect(runDir).not.toBe("");
      const live = liveTempDirs();
      expect(live.some((d) => d.startsWith(join(tmpdir(), "omp-evolve-journals-")))).toBe(true);
      expect(live).toContain(runDir);
      cleanupLive();
      expect(existsSync(runDir)).toBe(false);
      expect(liveTempDirs().filter((d) => d.includes("omp-evolve-"))).toEqual([]);
      release();
      await p.catch(() => {});
    });
  });

  describe("the installed location", () => {
    test("defaultTargetDir derives from HOME, falling back to os.homedir()", () => {
      const home = tmp("home");
      expect(defaultTargetDir({ HOME: home })).toBe(join(home, ".omp", "agent", "extensions", "omp-context"));
      expect(defaultTargetDir({})).toBe(join(homedir(), ".omp", "agent", "extensions", "omp-context"));
    });

    test("a named profile (OMP_PROFILE, else PI_PROFILE) wins over PI_CODING_AGENT_DIR, as in omp's dirs.ts", () => {
      const home = tmp("home");
      const profiled = join(home, ".omp", "profiles", "work", "agent", "extensions", "omp-context");
      expect(defaultTargetDir({ HOME: home, OMP_PROFILE: "work", PI_CODING_AGENT_DIR: "/x" })).toBe(profiled);
      expect(defaultTargetDir({ HOME: home, PI_PROFILE: "work" })).toBe(profiled);
      expect(defaultTargetDir({ HOME: home, OMP_PROFILE: " work " })).toBe(profiled);
      // An explicitly empty OMP_PROFILE, or "default", selects the default profile and does not inherit PI_PROFILE.
      expect(defaultTargetDir({ HOME: home, OMP_PROFILE: "", PI_PROFILE: "work" })).toBe(join(home, ".omp", "agent", "extensions", "omp-context"));
      expect(defaultTargetDir({ HOME: home, OMP_PROFILE: "default", PI_CODING_AGENT_DIR: "/x" })).toBe(join("/x", "extensions", "omp-context"));
    });

    test("defaultTargetDir follows omp's agent directory: PI_CODING_AGENT_DIR, then HOME/PI_CONFIG_DIR/agent", () => {
      const home = tmp("home");
      expect(defaultTargetDir({ HOME: home, PI_CODING_AGENT_DIR: "/work/omp-agent" })).toBe(
        join("/work/omp-agent", "extensions", "omp-context"),
      );
      expect(defaultTargetDir({ HOME: home, PI_CONFIG_DIR: ".omp-work" })).toBe(
        join(home, ".omp-work", "agent", "extensions", "omp-context"),
      );
    });

    test("with no targetDir, evolve installs under HOME from the given env, never the real home", async () => {
      const home = tmp("home");
      const real = join(homedir(), ".omp", "agent", "extensions", "omp-context", "guidance.md");
      const before = existsSync(real) ? statSync(real).mtimeMs : null;
      const { generate } = fakeGenerate(["HOLD-KEEP TRAIN-KEEP: installed under the fake home."]);
      const result = await evolve({
        sessionsDir: SESSIONS,
        bank: BANK,
        generate,
        tempRoot: tmp("copies"),
        env: { HOME: home },
        baseline: "HOLD-KEEP",
        rounds: 1,
        margin: 1,
      } as any);
      expect(result.installed).toBe(true);
      expect(readFileSync(join(home, ".omp", "agent", "extensions", "omp-context", "guidance.md"), "utf8")).toBe(
        "HOLD-KEEP TRAIN-KEEP: installed under the fake home.",
      );
      expect(existsSync(real) ? statSync(real).mtimeMs : null).toBe(before);
    });
  });
});
