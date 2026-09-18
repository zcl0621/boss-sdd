# Code Review Rules for AGENTS.md

Codex reads project instructions from `AGENTS.md`, and it takes its code review
rules from the same files: it searches the repository for `AGENTS.md` and
follows the applicable Code Review rules. That is the one lever a project has
over a reviewer this skill does not control: `/review` in the CLI, and
`@codex review` on a pull request.

**The scope rule is additive, not nearest-wins.** Repository-wide rules go in
the root `AGENTS.md`; rules that only make sense for one subtree go in a nested
file there, such as `services/experiment_reporting/AGENTS.md`. Codex applies the
root guidance *and* the more specific guidance covering each changed file, so a
nested file adds to the root rather than replacing it. Do not restate the root
rules in a nested file expecting to override them; write only what is new, and
where a nested rule has to contradict a root one, say so in words rather than
relying on position. The section heading is spelled `## Code Review Rules`; put
it in the `AGENTS.md` closest to the code the rules govern.

Both facts come from the verified platform table in
`docs/plans/2026-09-18-boss-sdd-hardening.md`, which is the only source this
directory cites for Codex.

This file is a snippet, not something the skill installs. Paste the block below
into your project's `AGENTS.md`, edit it to match what the project actually
believes, and delete anything that does not apply. It is optional, and the skill
runs identically whether or not you use it.

---

## Code Review Rules

**Report evidence, not verdicts.** Every finding names the file and the line,
and says what breaks and under what input. A finding that cannot say what breaks
is an opinion about style, and it belongs in a separate note rather than in the
findings list.

**Say when you could not tell.** "I could not determine whether this path is
reachable" is a useful review result. Silence on the same question is not, and
it reads identically to having checked.

**Check for what is absent.** Missing error handling, a missing authorization
check, a behaviour change with no test covering it, a new failure mode with no
path that reports it. The diff shows what was added; it does not show what
should have been there and is not.

**A test that asserts the implementation rather than the behaviour is a
finding.** So is a test that was weakened or deleted to make a suite green.

**Do not flag pre-existing code as a new problem.** If a line predates this
change, say so and move on, or say you could not establish which.

**Do not propose a refactor of code the change did not touch.** Scope creep
found in review costs the same as scope creep found anywhere else.

**Generated files, historical migrations, and vendored directories are out of
scope.** Say a change to one exists, and stop there.
