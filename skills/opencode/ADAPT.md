# OpenCode adaptation (plan-sdd)

Checked against OpenCode 2.0.23.

- Orchestrator: the `plan-sdd` primary agent ([agents/plan-sdd.md](agents/plan-sdd.md)); it loads this skill first with `skill({ id: "plan-sdd" })`.
- Role agents: `recon`, `implementer`, `qa`, `reviewer`, `spec-auditor`, all `mode: subagent` with `permission: { subagent: deny }`; the three read-only roles also carry `edit: deny`. Frontmatter `readonly:` is not an OpenCode field and does nothing.
- Models: every fresh role dispatch resolves through `~/.config/opencode/model-policy.json` ([references/model-policy.md](references/model-policy.md)), read and validated once per run. Role frontmatter deliberately has no competing `model:` default.
- Board/memory MCP server id: `plan-sdd` — `plan_board_status`, `plan_*_run`, `plan_*_task(s)`, `plan_graph`, `plan_memory_*`.
- Unattended: [references/unattended-mode.md](references/unattended-mode.md). The `goal` tool comes from the goal plugin (`plugins/goal.js`), not from OpenCode. `todowrite`/`todoread` come from the todo plugin; see SKILL.md "Todo list". `pin_context` comes from the pin plugin (`plugins/pin.js`).
- Phase P (mandatory discussion): [references/greenfield-prelude.md](references/greenfield-prelude.md) before Phase 0 on every run; user-facing wording checked with the `shuorenhua` skill ([references/greenfield-discussion.md](references/greenfield-discussion.md)).
- Context: the context-keeper plugin rebuilds the working set after each compaction (plan document status, loaded skills, subagent ledger, recent files) and clears old re-obtainable tool output in batches. The plan document is the scoreboard; keep it current, and pin its path. Pins, the goal, and the todo list are not part of that rebuild; the pin, goal, and todo plugins each append their current state to every request, so compaction does not drop them.

## Model policy

`~/.config/opencode/model-policy.json` is the sole model mapping. It binds each
dispatch purpose to a stable profile and exactly one concrete model. `L1` and
other levels are descriptive metadata, never a fallback pool. Read it once per
run, resolve the bindings the run will use, verify each resulting ID once with
the OpenCode `models` tool, and record `Model policy: v<N>, validated <date>`
in the plan's Status header. An invalid policy, an unavailable model, or an
invalid variant is `BLOCK`. A missing file is not: record
`Model policy: absent` and dispatch without `model`.

Validate: call `tools.opencode.models({ provider, query, all: true, limit })`
inside `execute`. Match the registry `model` base id and `#variant` against
what it returns. `models` missing from the direct tool list is expected, not
grounds to skip validation; only a failed call or a non-matching id/variant is
`BLOCK`.

Changing a model means editing only the registry: increment `policy_version`,
validate the candidate, and record role-appropriate evaluation evidence. There
is no automatic substitution: a quota error pauses the run for the user.

## Dispatch

| Habit from other hosts | OpenCode |
| --- | --- |
| `Task` | `subagent` |
| `run_in_background: true` | `background: true` (parallel batches, and steering a running child) |
| Task agent ID | `sessionID` (`^ses…`) |
| Always background, then end the turn | Foreground if one child and you need the result now |
| Poll / "silence is not done" | Do not poll; host notifies background children |
| Send a message to a running agent | `subagent` with its `sessionID` and `background: true`; it lands as a `steer` message after the child's current tool call |
| Is the agent alive? | `opencode api get /api/session/active`, only on suspicion |
| Stop an agent | `opencode api post /api/session/<id>/interrupt` |

Full protocol: [references/subagent-lifecycle.md](references/subagent-lifecycle.md).

Every fresh plan-sdd dispatch passes the resolved `model` explicitly (none when
the policy file is absent). Form A resumes omit `model` and pass only the
usable session ID.
