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

const mdIn = (dir: string) => readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
const CC_REFERENCES = mdIn(join(CC, "references"));
// References with nothing platform-specific in them: byte-identical on both.
const SHARED = ["board.md", "plan.md", "worktrees.md"];

describe("the two skills carry the same reference set", () => {
  test("six references, same names", () => {
    expect(CC_REFERENCES).toEqual(["board.md", "dispatch.md", "goal-mode.md", "plan.md", "review.md", "worktrees.md"]);
    expect(mdIn(join(OMP, "references"))).toEqual(CC_REFERENCES);
  });
  test("no retired file is left behind", () => {
    for (const f of ["roles.md", "references/memory.md", "references/worktree-mode.md", "references/dag-contract.md"]) {
      expect(existsSync(join(OMP, f))).toBe(false);
    }
  });
  for (const f of SHARED) {
    test(`references/${f} is identical to the claude-code copy`, () => {
      expect(read(join(OMP, "references", f))).toBe(read(join(CC, "references", f)));
    });
  }
});

describe("SKILL.md frontmatter", () => {
  test("name is plan-sdd, description non-empty", () => {
    const m = read(join(OMP, "SKILL.md")).match(/^---\n([\s\S]*?)\n---\n/);
    expect(m).not.toBeNull();
    const fm = m![1];
    expect(fm).toMatch(/^name:\s*plan-sdd\s*$/m);
    const d = fm.match(/^description:[ \t]*(.*)$/m);
    expect(d).not.toBeNull();
    const rest = fm.slice(fm.indexOf(d![0]) + d![0].length);
    const cont = rest.split("\n").filter((l) => /^\s+\S/.test(l)).join(" ");
    expect((d![1].replace(/^[>|][+-]?$/, "") + " " + cont).trim().length).toBeGreaterThan(0);
  });
  test("same description as the claude-code skill", () => {
    const desc = (p: string) => read(p).match(/^description:[\s\S]*?(?=^[a-z-]+:|^---$)/m)![0];
    expect(desc(join(OMP, "SKILL.md"))).toBe(desc(join(CC, "SKILL.md")));
  });
});

describe("same `##` structure as skills/claude-code", () => {
  for (const f of ["PLAYBOOK.md", ...CC_REFERENCES.map((r) => `references/${r}`)]) {
    test(f, () => expect(h2(read(join(OMP, f)))).toEqual(h2(read(join(CC, f)))));
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
      read(file).split("\n").forEach((line, i) => {
        if (/`reviewer`/.test(line) && !/role|bundled|plan-reviewer/i.test(line)) bad.push(`${rel(file)}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(bad).toEqual([]);
  });
  test("the playbook and review.md dispatch plan-reviewer", () => {
    expect(read(join(OMP, "PLAYBOOK.md"))).toContain("`plan-reviewer`");
    expect(read(join(OMP, "references/review.md"))).toContain("`plan-reviewer`");
  });
});

describe("omp-specific content", () => {
  const has = (f: string, needles: string[]) => {
    const t = read(join(OMP, f));
    for (const n of needles) expect(t).toContain(n);
    return t;
  };
  test("SKILL.md: read-only by instruction, allowlist only a partial guard", () => {
    has("SKILL.md", ["read-only by instruction", "partial guard"]);
  });
  test("SKILL.md and review.md agree: /review is typed by the user", () => {
    has("SKILL.md", ["`/review`", "typed by the user"]);
    has("references/review.md", ["`/review`", "typed by the user"]);
  });
  test("no unsupported claim that the native reviewer is better", () => {
    for (const f of walkMd(OMP)) expect(read(f)).not.toMatch(/better at (this|that|the)\b[^.]*\bjob/i);
  });
  test("skills are read with skill://, and the playbook path is spelled out", () => {
    has("SKILL.md", ["read skill://plan-sdd/PLAYBOOK.md", "read skill://show-me"]);
  });
  test("SKILL.md resume row: a failed resume falls back to a fresh dispatch", () => {
    const t = has("SKILL.md", ["agent://<id>", "Peer messaging is unavailable", "is not running", "fresh"]);
    expect(t).toMatch(/revive/i);
  });
  // docs/e2e/2026-10-16-omp-e2e-recheck2.md finding 4: after a rollover Kimi read the system prompt's device docs as
  // "the top-level function list shows them" and called `ask` five times instead of `write xd://…`.
  test("SKILL.md board: device docs are not the function list; call form kept in context_notes", () => {
    const t = has("SKILL.md", ["`# xd:// Tool Devices`", "not your function list", "write xd://mcp__plan_sdd_<tool>"]);
    const board = t.slice(t.indexOf("## The board on omp"), t.indexOf("## Tools you need"));
    expect(board).toContain("context_notes");
    expect(board).toContain("`read xd://`");
    expect(board).toMatch(/never use `ask`/i);
  });
  test("goal-mode.md: user-started, the goal tool, and print runs", () => {
    has("references/goal-mode.md", ["/goal <objective>", "omp --goal", "`goal` tool", "`-p`"]);
  });
  test("the skill no longer uses project memory, and INSTALL.md says so", () => {
    has("references/board.md", ["plan_memory_", "does not use"]);
    has("INSTALL.md", ["extensions/omp-plan-memory", "remove that directory"]);
    expect(existsSync(join(REPO, "plugins/omp-plan-memory"))).toBe(false);
  });
});

describe("INSTALL.md", () => {
  const p = join(OMP, "INSTALL.md");
  test("names the omp install targets", () => {
    const t = read(p);
    for (const needle of [
      "~/.omp/agent/skills/plan-sdd/",
      "~/.omp/agent/agents/",
      "~/.omp/agent/mcp.json",
      "modelRoles",
      "config.example.yml",
    ]) expect(t).toContain(needle);
  });
  test("mkdir before mcp.json, cp -n exit, flow-style and config.yaml, profile, Claude Code skill", () => {
    const t = read(p);
    for (const n of ["|| true", "cp -n", "config.yaml", "flow-style", "experimentalContextManagement", "--profile", "~/.omp/profiles/", ".claude/skills/plan-sdd", "plugins/omp-context"]) {
      expect(t).toContain(n);
    }
    expect(t).toMatch(/mkdir -p ~\/\.omp\/agent\n/);
  });
  test("lists the five agent files and the retired ones to remove", () => {
    const t = read(p);
    for (const n of ["`recon`", "`implementer`", "`plan-reviewer`", "`qa`", "`adversary`", "spec-auditor.md", "recon-rules.md"]) {
      expect(t).toContain(n);
    }
  });
  test("every repo-relative path it names exists (backticks, links, fenced blocks)", () => {
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
    expect([...found].filter((c) => !existsSync(join(REPO, c)))).toEqual([]);
  });
});

// Left-column phrases of the bindings table in a SKILL.md.
function leftPhrases(text: string): string[] {
  const out: string[] = [];
  let inTable = false;
  for (const line of text.split("\n")) {
    if (/^## Bindings/.test(line)) { inTable = true; continue; }
    if (inTable && /^## /.test(line)) break;
    if (!inTable || !line.startsWith("|") || /^\|\s*-/.test(line)) continue;
    const cell = line.split("|")[1].trim();
    if (/^The playbook says/i.test(cell)) continue;
    out.push(cell);
  }
  return out;
}
// Phrases that name a Claude Code mechanism are mapped to their omp wording.
const PHRASE_MAP: Record<string, string> = {
  "Claude Code's own reviewer": "omp's own reviewer",
};

describe("SKILL.md bindings", () => {
  const skill = () => read(join(OMP, "SKILL.md"));
  const phrases = leftPhrases(read(join(CC, "SKILL.md")));
  test("claude-code bindings table was parsed", () => expect(phrases.length).toBeGreaterThanOrEqual(9));
  test("omp binds exactly the mechanisms claude-code binds", () => {
    expect(leftPhrases(skill())).toEqual(phrases.map((p) => PHRASE_MAP[p] ?? p));
  });
  for (const needle of ["`wait`", "`tasks`", "`context`", "~/.omp/agent/mcp.json", "/goal", "--goal", "`-p`", "isolated", "`solutionSpace`"]) {
    test(`mentions ${needle}`, () => expect(skill()).toContain(needle));
  }
});
