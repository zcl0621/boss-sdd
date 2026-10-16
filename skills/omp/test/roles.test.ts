import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const OMP = join(import.meta.dir, "..");
const AGENTS = join(OMP, "agents");

// The ten roles. Nine keep the name used in skills/claude-code/agents/; the
// reviewer role is `plan-reviewer` because omp bundles an agent named `reviewer`.
const ROLES = [
  "adversary",
  "branch-reviewer",
  "implementer",
  "plan-reviewer",
  "qa",
  "recon-code",
  "recon-product",
  "recon-rules",
  "spec-auditor",
  "ui-designer",
];
const READ_ONLY = [
  "recon-rules",
  "recon-code",
  "recon-product",
  "plan-reviewer",
  "spec-auditor",
  "branch-reviewer",
  "adversary",
];

// Copied from omp 18.11.1 packages/coding-agent/src/task/agents.ts:44-73
// (EMBEDDED_AGENT_DEFS: scout.md, reviewer.md, security-reviewer.md at :45-47,
// the inline frontmatter name "task" at :51 and "sonic" at :63-72).
const OMP_BUNDLED = ["scout", "reviewer", "security-reviewer", "task", "sonic"];
// Reserved names: docs/task-agent-discovery.md:37.
const OMP_RESERVED = ["main", "sub"];

// Copied from omp 18.11.1 packages/coding-agent/src/tools/builtin-names.ts:1-32
// (BUILTIN_TOOL_NAMES). omp lowercases tool names before use
// (normalizeToolName, tools/builtin-names.ts:47-49, applied at
// discovery/helpers.ts:343), so every comparison here is case-insensitive.
const BUILTIN_TOOL_NAMES = [
  "read", "bash", "edit", "ast_grep", "ast_edit", "ask", "debug", "ida", "eval",
  "github", "glob", "grep", "find", "lsp", "checkpoint", "rewind", "context_notes",
  "new_context", "security_scan", "task", "wait", "todo", "web_search", "write",
  "memory_edit", "retain", "recall", "reflect", "learn", "manage_skill",
];
// Write-capable built-ins: edit/write plus ast_edit and memory_edit, and lsp,
// whose rename/code_actions apply workspace edits (omp lsp/tool.ts:1352-1402).
const WRITE_TOOLS = ["edit", "write", "ast_edit", "memory_edit", "lsp"];

// The matching Claude Code template for a role (skills/claude-code/agents/).
const TEMPLATE_OF = (role: string) => (role === "plan-reviewer" ? "reviewer" : role);
const CC_AGENTS = join(OMP, "..", "claude-code", "agents");

function readAgent(role: string): { fm: Record<string, any>; body: string } {
  const text = readFileSync(join(AGENTS, `${role}.md`), "utf8");
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error(`${role}.md has no frontmatter`);
  return { fm: Bun.YAML.parse(m[1]) as Record<string, any>, body: m[2] };
}

function toolList(fm: Record<string, any>): string[] {
  const t = fm.tools;
  if (Array.isArray(t)) return t.map(s => String(s).trim().toLowerCase());
  if (typeof t === "string") return t.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  return [];
}

function configAliases(): string[] {
  const cfg = Bun.YAML.parse(readFileSync(join(OMP, "config.example.yml"), "utf8")) as any;
  return Object.keys(cfg?.modelRoles ?? {});
}

function tableAliases(): string[] {
  const md = readFileSync(join(OMP, "roles.md"), "utf8");
  const section = md.split(/^## Model bindings\s*$/m)[1];
  if (!section) throw new Error("roles.md has no 'Model bindings' section");
  const table = section.split(/^## /m)[0];
  const rows = table.split("\n").filter(l => /^\|/.test(l)).slice(2);
  return rows.map(r => {
    const cells = r.split("|").map(c => c.trim());
    const model = cells[cells.length - 2];
    const m = model.match(/^`@([A-Za-z0-9_-]+)`$/);
    if (!m) throw new Error(`binding row has no single \`@alias\` in the Model column: ${r}`);
    return m[1];
  });
}

describe("skills/omp agents", () => {
  test("exactly the ten role files", () => {
    expect(existsSync(AGENTS)).toBe(true);
    const files = readdirSync(AGENTS).filter(f => !f.startsWith(".")).sort();
    expect(files).toEqual(ROLES.map(r => `${r}.md`).sort());
  });

  test.each(ROLES)("%s: frontmatter name/description/tools/model", role => {
    const { fm, body } = readAgent(role);
    expect(fm.name).toBe(role);
    expect(typeof fm.description).toBe("string");
    expect(toolList(fm).length).toBeGreaterThan(0);
    expect(fm.model).toMatch(/^@[A-Za-z0-9_-]+$/);
    expect(body.trim().length).toBeGreaterThan(0);
  });

  test.each(ROLES)("%s: every tool is a real omp built-in tool name", role => {
    for (const t of toolList(readAgent(role).fm)) expect(BUILTIN_TOOL_NAMES).toContain(t);
  });

  test.each(ROLES)("%s: carries every ## heading of the claude-code template", role => {
    const tpl = readFileSync(join(CC_AGENTS, `${TEMPLATE_OF(role)}.md`), "utf8");
    const headings = tpl.split("\n").filter(l => /^## /.test(l)).map(l => l.trim());
    expect(headings.length).toBeGreaterThan(0);
    const ownLines = new Set(readAgent(role).body.split("\n").map(l => l.trim()));
    for (const h of headings) expect(ownLines.has(h)).toBe(true);
  });

  test.each(READ_ONLY)("%s: read-only by allowlist, keeps bash", role => {
    const tools = toolList(readAgent(role).fm);
    expect(tools).toContain("bash");
    for (const w of WRITE_TOOLS) expect(tools).not.toContain(w);
    expect(tools.filter(t => WRITE_TOOLS.includes(t))).toEqual([]);
  });

  test("implementer and ui-designer can write", () => {
    for (const role of ["implementer", "ui-designer"]) {
      const tools = toolList(readAgent(role).fm);
      expect(tools).toContain("edit");
      expect(tools).toContain("write");
    }
  });

  test("no agent name collides with an omp bundled or reserved agent", () => {
    for (const role of ROLES) {
      const name = readAgent(role).fm.name;
      expect(OMP_BUNDLED).not.toContain(name);
      expect(OMP_RESERVED).not.toContain(name);
    }
  });
});

describe("roles.md and config.example.yml", () => {
  test("every alias used by an agent file is defined under modelRoles", () => {
    const defined = configAliases();
    expect(defined.length).toBeGreaterThan(0);
    for (const role of ROLES) {
      const alias = String(readAgent(role).fm.model).replace(/^@/, "");
      expect(defined).toContain(alias);
    }
  });

  test("every alias in the Model bindings table is defined under modelRoles", () => {
    const defined = configAliases();
    const aliases = tableAliases();
    expect(aliases.length).toBeGreaterThanOrEqual(10);
    for (const a of aliases) expect(defined).toContain(a);
  });

  test("roles.md explains modelRoles resolution, the rename and the bundled list", () => {
    const md = readFileSync(join(OMP, "roles.md"), "utf8");
    expect(md).toContain("modelRoles");
    expect(md).toContain("~/.omp/agent/config.yml");
    expect(md).toContain(".omp/config.yml");
    expect(md).toContain("plan-reviewer");
    expect(md).toContain("task/agents.ts");
  });

  test("example model ids include a gpt-6.1-sol and an opus-5.5 id", () => {
    const cfg = Bun.YAML.parse(readFileSync(join(OMP, "config.example.yml"), "utf8")) as any;
    const ids = Object.values(cfg?.modelRoles ?? {}).map(String);
    expect(ids.some(i => /gpt-6\.1-sol/.test(i))).toBe(true);
    expect(ids.some(i => /opus-5\.5/.test(i))).toBe(true);
  });

  test("config.example.yml sets experimentalContextManagement: true", () => {
    const raw = readFileSync(join(OMP, "config.example.yml"), "utf8");
    const cfg = Bun.YAML.parse(raw) as any;
    const parsed = cfg?.compaction?.experimentalContextManagement === true;
    const shown = /^\s*#?\s*experimentalContextManagement:\s*true\b/m.test(raw);
    expect(parsed || shown).toBe(true);
  });

  test("config.example.yml documents the 500k cap via modelThresholds or thresholdTokens", () => {
    const raw = readFileSync(join(OMP, "config.example.yml"), "utf8");
    expect(raw).toMatch(/500k|500000|500_000/);
    expect(raw).toMatch(/modelThresholds|thresholdTokens/);
  });
});
