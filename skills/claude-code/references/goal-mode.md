# Goal mode

Triggered by `--goal`, "run it to the end", or "I'm going away". It removes the
waiting. It does not license guessing.

## When it is on

Only when the user asked to run without waiting on them. Confirm mode does not
use these rules.

## Before it starts

Phase P ([greenfield-prelude.md](greenfield-prelude.md)) runs first and waits for
the user, even when the user asked for goal mode in their first message. Goal
mode applies only after the user confirmed the Discussion outcome. Questions
phase P left open go to the parked list below.

## Arming it

1. Restate the objective: the user's requirement plus a plan-sdd close-out of
   the plan in this run's plan document, clean or partial, with the delivery
   report written.
2. Write `Goal mode: armed` in the plan's Status header.
3. Claude Code's goal feature is typed by the user, not called by you
   ([SKILL.md](../SKILL.md) has the binding). When you cannot see from the
   conversation that one is already set, offer the user the one line to type,
   once, in the same message that confirms goal mode is armed, and carry on
   without waiting for it. Phrase the condition so that it is checkable from
   the transcript alone: the run's delivery report has been written, or the run
   has stopped for something only the user can give and says what.

With the goal feature set, Claude Code checks the condition after each turn and
keeps the session going until it holds. Without it, nothing resumes an idle
session: ending a turn ends the run until the user writes again.

## While it runs

1. **Park** unanswered questions; mark the tasks that depend on them `blocked`
   with the question named. Do not guess.
2. Keep executing everything that is not blocked.
3. Ending a turn is not completion. Do not end a turn while ready work remains,
   and do not shrink the scope to what has already landed.
4. Progress goes into the transcript as one line per finished task (PLAYBOOK,
   "Progress reporting"). Those lines are the checkpoints; writing one is not a
   reason to stop.
5. Report partial state with explicit blockers instead of pretending to finish.
6. When something only the user can give is needed — new credentials or
   approval; a push, PR, merge, deploy, or production data; something the user
   forbade turning out to be required; every safe path blocked — say exactly
   what is needed, record it in the plan, and end the turn there. That is a
   stop, not a finish.

## Ending it

The run is finished only when PLAYBOOK's clean-finish conditions hold, and it
is closed out as partial when nodes are blocked; either way the delivery report
is written first, with the evidence in it. A partial close-out is never
reported as a finish, and uncertain evidence is not completion. Do not write a
delivery report to make the goal condition read as met.
