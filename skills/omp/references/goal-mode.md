# Goal mode

On when the user asks to run without waiting on them: `--goal`, "run it to the
end", "I'm going away". It removes the waiting. It does not license guessing.

## Arming it

Phase P runs first and waits for the user, even when they asked for goal mode
in their first message. Once the outcome is confirmed:

1. Write `goal mode armed` in the plan's header.
2. omp's goal mode is started by the user, with `/goal <objective>` or
   `omp --goal "<objective>"` at launch; you cannot start it. If you cannot see
   that it is on, offer them one line to type, once, and carry on without
   waiting for it. Phrase the objective so it can be judged from the
   transcript alone: the run's delivery report has been written, or the run has
   stopped for something only the user can give and says what.

With goal mode on, omp continues the session after each turn until the
objective is complete, and gives you a `goal` tool to mark it so; do not mark
it before the close-out conditions hold. Without it nothing resumes an idle
session, so ending a turn ends the run. A `-p` print run never resumes.

## While it runs

- Park what you cannot answer under "Waiting on you" and block the tasks
  behind it. Record reversible, low-risk choices under "Decided for you".
- Keep executing everything that is not blocked. Do not end a turn while ready
  work remains, and do not shrink the scope to what has already landed.
- Do nothing outside the plan because you happened to notice it. Park it.
- Do not skip a review because nobody is watching. With the user away, the
  reviews are the only outside check left.

## What still stops it

Say exactly what is needed, record it in the plan, and end the turn:

- new credentials, authorization or approval;
- an outward or irreversible action: push, PR, merge to a shared branch,
  deploy, a message, production data;
- something the user forbade turning out to be necessary;
- a dirty main working tree before the first worktree is cut;
- recon returning no product boundary at all, since every task's scope descends
  from it;
- every remaining path blocked.

A single stuck node is not on this list. It is `blocked`, with its downstream,
and the run continues.

## Ending it

The delivery report is written first, with the evidence in it, whether the
close-out is clean or partial. A partial close-out is never reported as a
finish, and a report is never written to make the `/goal` condition read as
met.
