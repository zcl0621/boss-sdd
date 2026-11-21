import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const OMP = join(import.meta.dir, "..");
const AGENTS = join(OMP, "agents");

// The five roles. Four keep the name used in skills/claude-code/agents/; the
// reviewer role is `plan-reviewer` because omp bundles an agent named `reviewer`.
const ROLES = ["adversary", "implementer", "plan-reviewer", "qa", "recon"];
const READ_ONLY = ["recon", "plan-reviewer", "adversary"];

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

// The matching Claude Code file for a role (skills/claude-code/agents/).
const TEMPLATE_OF = (role: string) => (role === "plan-reviewer" ? "reviewer" : role);
const CC_AGENTS = join(OMP, "..", "claude-code", "agents");

function split(text: string, what: string): { fm: Record<string, any>; body: string } {
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error(`${what} has no frontmatter`);
  return { fm: Bun.YAML.parse(m[1]) as Record<string, any>, body: m[2] };
}
const readAgent = (role: string) => split(readFileSync(join(AGENTS, `${role}.md`), "utf8"), `${role}.md`);

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

// Rows of the "Roles and models" table in SKILL.md: [agent name, alias].
function tableRows(): [string, string][] {
  const md = readFileSync(join(OMP, "SKILL.md"), "utf8");
  const section = md.split(/^## Roles and models\s*$/m)[1];
  if (!section) throw new Error("SKILL.md has no 'Roles and models' section");
  const rows = section.split(/^## /m)[0].split("\n").filter(l => /^\|/.test(l)).slice(2);
  return rows.map(r => {
    const cells = r.split("|").map(c => c.trim());
    const agent = cells[2].match(/^`([a-z-]+)`$/);
    const alias = cells[cells.length - 2].match(/^`@([A-Za-z0-9_-]+)`$/);
    if (!agent || !alias) throw new Error(`role row needs a backticked agent name and \`@alias\`: ${r}`);
    return [agent[1], alias[1]];
  });
}

describe("skills/omp agents", () => {
  test("exactly the five role files", () => {
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

  // The standing rules are the same on both platforms; only the frontmatter differs.
  test.each(ROLES)("%s: same rules and description as the claude-code role file", role => {
    const cc = split(readFileSync(join(CC_AGENTS, `${TEMPLATE_OF(role)}.md`), "utf8"), "template");
    const mine = readAgent(role);
    expect(mine.body).toBe(cc.body);
    expect(mine.fm.description).toBe(cc.fm.description);
  });

  test.each(READ_ONLY)("%s: read-only by allowlist, keeps bash", role => {
    const tools = toolList(readAgent(role).fm);
    expect(tools).toContain("bash");
    expect(tools.filter(t => WRITE_TOOLS.includes(t))).toEqual([]);
  });

  test("implementer can write", () => {
    const tools = toolList(readAgent("implementer").fm);
    expect(tools).toContain("edit");
    expect(tools).toContain("write");
  });

  test("no agent name collides with an omp bundled or reserved agent", () => {
    for (const role of ROLES) {
      const name = readAgent(role).fm.name;
      expect(OMP_BUNDLED).not.toContain(name);
      expect(OMP_RESERVED).not.toContain(name);
    }
  });
});

describe("SKILL.md role table and config.example.yml", () => {
  test("the table lists exactly the five agents, each with the alias its file carries", () => {
    const rows = tableRows();
    expect(rows.map(r => r[0]).sort()).toEqual([...ROLES].sort());
    for (const [agent, alias] of rows) expect(readAgent(agent).fm.model).toBe(`@${alias}`);
  });

  test("every alias used by an agent file is defined under modelRoles, and no other", () => {
    const used = ROLES.map(r => String(readAgent(r).fm.model).replace(/^@/, "")).sort();
    expect(configAliases().sort()).toEqual(used);
  });

  test("SKILL.md explains modelRoles resolution, the rename and the bundled list", () => {
    const md = readFileSync(join(OMP, "SKILL.md"), "utf8");
    for (const n of ["modelRoles", "~/.omp/agent/config.yml", ".omp/config.yml", "plan-reviewer", "task/agents.ts", "`security-reviewer`"]) {
      expect(md).toContain(n);
    }
  });

  test("example model ids include a gpt-6.1-sol and an opus-5.5 id", () => {
    const cfg = Bun.YAML.parse(readFileSync(join(OMP, "config.example.yml"), "utf8")) as any;
    const ids = Object.values(cfg?.modelRoles ?? {}).map(String);
    expect(ids.some(i => /gpt-6\.1-sol/.test(i))).toBe(true);
    expect(ids.some(i => /opus-5\.5/.test(i))).toBe(true);
  });

  test("config.example.yml sets experimentalContextManagement: true", () => {
    const cfg = Bun.YAML.parse(readFileSync(join(OMP, "config.example.yml"), "utf8")) as any;
    expect(cfg?.compaction?.experimentalContextManagement).toBe(true);
  });

  test("config.example.yml documents the 500k cap via modelThresholds or thresholdTokens", () => {
    const raw = readFileSync(join(OMP, "config.example.yml"), "utf8");
    expect(raw).toMatch(/500k|500000|500_000/);
    expect(raw).toMatch(/modelThresholds|thresholdTokens/);
  });
});
