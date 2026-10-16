import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const OMP = join(import.meta.dir, "..");
const REPO = join(OMP, "..", "..");
const CC = join(OMP, "..", "claude-code");

function walkFiles(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "node_modules") continue;
      out.push(...walkFiles(p, exts));
    } else if (exts.some((e) => name.endsWith(e))) out.push(p);
  }
  return out;
}
const walkMd = (d: string) => walkFiles(d, [".md"]);
const rel = (p: string) => relative(OMP, p);
const read = (p: string) => readFileSync(p, "utf8");

// `##` headings outside fenced code blocks.
function h2(text: string): string[] {
  const out: string[] = [];
  let fence = false;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    else if (!fence && /^## /.test(line)) out.push(line.replace(/\s+$/, ""));
  }
  return out;
}

const CC_REFERENCES = readdirSync(join(CC, "references")).filter((f) => f.endsWith(".md")).sort();
const FILES = [
  "SKILL.md",
  "PLAYBOOK.md",
  "INSTALL.md",
  ...CC_REFERENCES.map((f) => `references/${f}`),
];

describe("claude-code reference set is the 16 files the plan names", () => {
  test("16 references to port", () => expect(CC_REFERENCES.length).toBe(16));
});

describe("SKILL.md frontmatter", () => {
  test("name is plan-sdd, description non-empty", () => {
    const p = join(OMP, "SKILL.md");
    expect(existsSync(p)).toBe(true);
    const m = read(p).match(/^---\n([\s\S]*?)\n---\n/);
    expect(m).not.toBeNull();
    const fm = m![1];
    expect(fm).toMatch(/^name:\s*plan-sdd\s*$/m);
    const d = fm.match(/^description:[ \t]*(.*)$/m);
    expect(d).not.toBeNull();
    // inline value, or a block scalar / continuation lines
    const rest = fm.slice(fm.indexOf(d![0]) + d![0].length);
    const cont = rest.split("\n").filter((l) => /^\s+\S/.test(l)).join(" ");
    const value = (d![1].replace(/^[>|][+-]?$/, "") + " " + cont).trim();
    expect(value.length).toBeGreaterThan(0);
  });
});

describe("required files exist", () => {
  for (const f of FILES) {
    test(f, () => expect(existsSync(join(OMP, f))).toBe(true));
  }
});

// Headings that name a Claude Code mechanism may be reworded; every other
// heading must match its claude-code counterpart verbatim. A reworded heading
// must not keep `/code-review` (omp's commands are `/review` and
// `/annotate code-review`, omp docs/slash-command-internals.md:433-449).
const CC_ONLY_HEADING = /\/code-review|SendMessage|subagent_type|\.claude\/agents|`Agent`/;

describe("same `##` structure as skills/claude-code (acceptance 3)", () => {
  for (const f of ["PLAYBOOK.md", ...CC_REFERENCES.map((r) => `references/${r}`)]) {
    test(f, () => {
      const mine = join(OMP, f);
      expect(existsSync(mine)).toBe(true);
      const want = h2(read(join(CC, f)));
      const got = h2(read(mine));
      expect(got.length).toBe(want.length);
      // native-review.md is about Claude Code's reviewer (incl. /code-review
      // --fix/--comment, which omp's /review lacks): every heading may be reworded.
      const freeform = f === "references/native-review.md";
      want.forEach((w, i) => {
        if (freeform) {
          expect(got[i]).not.toMatch(CC_ONLY_HEADING);
          expect(got[i].length).toBeGreaterThan(3);
        } else if (CC_ONLY_HEADING.test(w)) {
          expect(got[i]).not.toMatch(CC_ONLY_HEADING);
          expect(got[i].length).toBeGreaterThan(3);
        } else {
          expect(got[i]).toBe(w);
        }
      });
    });
  }
});

describe("relative Markdown links resolve", () => {
  test("every .md under skills/omp/", () => {
    const bad: string[] = [];
    for (const file of walkMd(OMP)) {
      let fence = false;
      for (const line of read(file).split("\n")) {
        if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
        if (fence) continue;
        for (const m of line.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
          let t = m[1];
          if (/^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith("#")) continue;
          t = decodeURIComponent(t.split("#")[0].split("?")[0]);
          if (!t) continue;
          if (!existsSync(join(dirname(file), t))) bad.push(`${rel(file)}: ${m[1]}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});

describe("no Claude Code mechanism named as the mechanism to use", () => {
  // Per line: a line may name one of these only if that same line says it is a
  // comparison ("Claude Code", or that omp skips/ignores it). A table row is a line.
  const FORBIDDEN = /SendMessage|subagent_type|\.claude\/agents|\/code-review|`Agent`|`Skill`/;
  const COMPARISON = /Claude Code|omp skips|omp ignores|omp does not (load|read|use)/i;
  test("every text file under skills/omp/ except this test", () => {
    const bad: string[] = [];
    for (const file of walkFiles(OMP, [""])) {
      if (file === import.meta.path) continue;
      const buf = readFileSync(file);
      if (buf.includes(0)) continue; // binary
      buf.toString("utf8").split("\n").forEach((line, i) => {
        if (FORBIDDEN.test(line) && !COMPARISON.test(line)) bad.push(`${rel(file)}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(bad).toEqual([]);
  });
});

describe("the reviewer role is dispatched as plan-reviewer", () => {
  // A backticked `reviewer` names omp's bundled agent, the wrong one to dispatch.
  // Allowed only on a line that also says "role", "bundled" or "plan-reviewer".
  test("PLAYBOOK.md and references/", () => {
    const bad: string[] = [];
    for (const file of [join(OMP, "PLAYBOOK.md"), ...walkMd(join(OMP, "references"))]) {
      if (!existsSync(file)) continue;
      read(file).split("\n").forEach((line, i) => {
        if (/`reviewer`/.test(line) && !/role|bundled|plan-reviewer/i.test(line)) bad.push(`${rel(file)}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(bad).toEqual([]);
  });
});

describe("content the review asked for", () => {
  const has = (f: string, needles: string[]) => {
    expect(existsSync(join(OMP, f))).toBe(true);
    const t = read(join(OMP, f));
    for (const n of needles) expect(t).toContain(n);
    return t;
  };
  test("SKILL.md: read-only by instruction, allowlist only a partial guard", () => {
    const t = has("SKILL.md", ["read-only by instruction", "partial guard"]);
    expect(t).not.toMatch(/^#+ .*by tool allowlist/m);
  });
  test("SKILL.md: architects are read-only by instruction; scout has no bash", () => {
    has("SKILL.md", ["architects", "`scout`", "no `bash`"]);
    has("references/greenfield-architect.md", ["read-only by instruction"]);
  });
  test("SKILL.md: todo ops and the auto-promote rule", () => {
    has("SKILL.md", ["`unblock`", "`rm`", "`view`", "`block`", "tools/todo.ts:128-141", "single op per call"]);
  });
  test("SKILL.md: citations for async contract and the warm/cold revive paths", () => {
    has("SKILL.md", ["task-async-contract.md", "createWarmSubagentReviver", "persisted-revive.ts:180-183"]);
    expect(read(join(OMP, "SKILL.md"))).not.toContain("174-177");
    expect(read(join(OMP, "SKILL.md"))).not.toMatch(/[a-z`] The reply is an owner-routed job/);
  });
  test("SKILL.md and native-review.md agree: /review is typed by the user", () => {
    has("SKILL.md", ["`/review`", "typed by the user"]);
    has("references/native-review.md", ["`/review`", "typed by the user"]);
  });
  test("no unsupported claim that the native reviewer is better", () => {
    for (const f of walkMd(OMP)) expect(read(f)).not.toMatch(/better at (this|that|the)\b[^.]*\bjob/i);
  });
  test("skills are loaded with read skill://, not a Skill tool", () => {
    has("references/greenfield-discussion.md", ["skill://"]);
    has("references/greenfield-prelude.md", ["skill://"]);
  });
  test("Form A failure falls back to Form B (SKILL.md resume row, dispatch.md)", () => {
    for (const f of ["SKILL.md", "references/dispatch.md"]) {
      const t = has(f, ["Peer messaging is unavailable", "is not running", "Form B"]);
      expect(t).toMatch(/revive/i);
    }
  });
  test("SKILL.md todo: dispatch order, start-before-done, display artefact", () => {
    has("SKILL.md", ["in the order you will dispatch", "display artefact", "`done`, `block` or `drop`"]);
    has("PLAYBOOK.md", ["in the order you will dispatch", "display artefact"]);
  });
  test("INSTALL.md: mkdir before mcp.json, cp -n exit, flow-style and config.yaml, compaction", () => {
    const t = has("INSTALL.md", ["|| true", "config.yaml", "flow-style", "experimentalContextManagement"]);
    expect(t).toMatch(/mkdir -p ~\/\.omp\/agent\n/);
  });
  // docs/e2e/2026-10-16-omp-e2e-recheck2.md finding 4: after a rollover Kimi read the system prompt's device docs as
  // "the top-level function list shows them" and called `ask` five times instead of `write xd://…`.
  test("SKILL.md board row: device docs are not the function list; no function-call escape hatch", () => {
    const t = has("SKILL.md", ["`# xd:// Tool Devices`", "not your function list"]);
    expect(t).not.toContain("When the top-level function list shows them directly, call them as functions");
  });
  test("SKILL.md board: call form kept in context_notes; a doubt after rollover is a read xd://, never ask", () => {
    const t = has("SKILL.md", ["context_notes", "write xd://mcp__plan_sdd_<tool>"]);
    const board = t.slice(t.indexOf("## The board"), t.indexOf("## Not established"));
    expect(board).toContain("context_notes");
    expect(board).toContain("`read xd://`");
    expect(board).toMatch(/never .*`ask`/i);
  });
  test("INSTALL.md: merge, overwrite, profile and Claude Code skill notes", () => {
    const t = has("INSTALL.md", ["cp -n", "--profile", ".claude/skills/plan-sdd", "plugins/omp-context", "~/.omp/profiles/"]);
    expect(t).not.toContain("landing");
  });
});

describe("INSTALL.md (acceptance 4)", () => {
  const p = join(OMP, "INSTALL.md");
  test("exists and names the omp install targets", () => {
    expect(existsSync(p)).toBe(true);
    const t = read(p);
    for (const needle of [
      "~/.omp/agent/skills/plan-sdd/",
      "~/.omp/agent/agents/",
      "~/.omp/agent/mcp.json",
      "modelRoles",
      "config.example.yml",
    ]) expect(t).toContain(needle);
  });
  test("every repo-relative path it names exists (backticks, links, fenced blocks)", () => {
    expect(existsSync(p)).toBe(true);
    const t = read(p);
    // A real repo path starts skills/, plugins/, docs/, mcp/, Scripts/ or is README.md.
    const ROOTED = /(?<![\w~./-])((?:skills|plugins|docs|mcp|Scripts)\/[\w.\-/]*|README\.md)/g;
    const found = new Set<string>();
    for (const m of t.matchAll(ROOTED)) {
      const after = t[m.index! + m[0].length] ?? "";
      if (/[*<>]/.test(after)) continue; // glob or placeholder
      const path = m[1].replace(/\.+$/, "").replace(/\/$/, "");
      if (path.includes("/") || path === "README.md") found.add(path);
    }
    expect(found.size).toBeGreaterThan(0);
    const bad = [...found].filter((c) => !existsSync(join(REPO, c)));
    expect(bad).toEqual([]);
  });
});

// Left-column phrases of the bindings table in skills/claude-code/SKILL.md.
function leftPhrases(text: string): string[] {
  const out: string[] = [];
  let inTable = false;
  for (const line of text.split("\n")) {
    if (/^## The bindings/.test(line)) { inTable = true; continue; }
    if (inTable && /^## /.test(line)) break;
    if (!inTable || !line.startsWith("|") || /^\|\s*-/.test(line)) continue;
    const cell = line.split("|")[1].trim();
    if (/^Where the playbook says/i.test(cell)) continue;
    const q = cell.match(/^"([^"]+)"/);
    out.push((q ? q[1] : cell.replace(/\s*\(.*$/, "")).replace(/`/g, "").trim());
  }
  return out;
}
// Phrases that name a Claude Code mechanism are mapped to their omp wording.
const PHRASE_MAP: Record<string, string> = {
  "Claude Code's own branch reviewer": "branch reviewer",
};

describe("SKILL.md bindings (acceptance 1-2)", () => {
  const skill = () => read(join(OMP, "SKILL.md"));
  const phrases = leftPhrases(read(join(CC, "SKILL.md")));
  test("claude-code bindings table was parsed", () => expect(phrases.length).toBeGreaterThanOrEqual(14));
  for (const ph of phrases) {
    const want = PHRASE_MAP[ph] ?? ph;
    test(`covers: ${ph}`, () => {
      expect(existsSync(join(OMP, "SKILL.md"))).toBe(true);
      expect(skill().replace(/`/g, "").toLowerCase()).toContain(want.toLowerCase());
    });
  }
  for (const needle of ["`wait`", "`tasks`", "~/.omp/agent/mcp.json", "tools/todo.ts:128", "/goal", "--goal", "`-p`", "isolated"]) {
    test(`mentions ${needle}`, () => {
      expect(existsSync(join(OMP, "SKILL.md"))).toBe(true);
      expect(skill()).toContain(needle);
    });
  }
});
