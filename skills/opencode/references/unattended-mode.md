# Unattended mode (OpenCode)

Triggered by `--goal`, "run it to the end", or "I'm going away". OpenCode has
no built-in goal tool. The `goal` tool comes from the goal plugin
(`~/.config/opencode/plugins/goal.js`); everything else in this file holds
with or without it.

## When on

Only when the user asked to run without waiting on them. Confirm mode does not
use unattended rules.

## Before it starts

Phase P (the discussion in `greenfield-prelude.md`) runs first and waits for the
user, even when the user asked for unattended mode in the first message.
Unattended rules apply only after the user confirmed the Discussion outcome.
Questions that Phase P left open go to the parked list below.

## Arming it

1. Restate the objective: the user requirement plus a plan-sdd clean finish
   (every task `done` with evidence, as SKILL.md defines it).
2. If the `goal` tool is present, call it once:
   `goal({ action: "set", objective: "<the restated objective>" })`.
   Write `Unattended: armed` in the plan's Status header either way.

With the tool, the plugin keeps the objective across compactions and, when the
session goes idle while the goal is active, sends it a short message to carry
on. Without the tool, nothing resumes an idle session: do not end a turn while
ready work remains.

## Orchestrator behavior

1. **Park** unanswered questions; mark dependent DAG tasks `blocked` with the
   question named. Do not guess.
2. Keep executing everything that is not blocked.
3. Ending a turn is not completion. Do not shrink scope to what already landed.
4. Report partial state with explicit blockers instead of pretending finish.
5. When something only the user can give is needed (new credentials or
   approval; push, PR, merge, deploy, production data; something the user
   forbade turning out to be required; every safe path blocked), call
   `goal({ action: "wait", reason: "<what is needed>" })`, report, and end the
   turn. The goal stays active; the plugin does not resume a waiting goal, and
   the user's next message clears the wait.

## Completing

Call `goal({ action: "complete", evidence: "<where the clean-finish evidence is>" })`
only when SKILL.md's **clean finish** is true, or when the user explicitly stops
the run (`evidence: "user stopped: <their words>"`). A partial close-out is
`wait`, not `complete`.

Uncertain evidence is not completion.
