# Goal mode

On when the user asks to run without waiting on them: `--goal`, "run it to the
end", "I'm going away". It removes the waiting. It does not license guessing.

## Arming it

Phase P runs first and waits for the user, even when they asked for goal mode
in their first message. Once the outcome is confirmed:

1. Write `goal mode armed` in the plan's header.
2. OpenCode has no built-in goal feature. The `goal` tool comes from the goal
   plugin. If it is in your toolset, call it once:
   `goal({ action: "set", objective: "<the requirement, plus a plan-sdd
   close-out with the delivery report written>" })`.

With the tool, the plugin keeps the objective across compactions and nudges an
idle session to carry on while the goal is active. Without it nothing resumes
an idle session, so ending a turn ends the run.

## While it runs

- Park what you cannot answer under "Waiting on you" and block the tasks
  behind it. Record reversible, low-risk choices under "Decided for you".
- Keep executing everything that is not blocked. Do not end a turn while ready
  work remains, and do not shrink the scope to what has already landed.
- Do nothing outside the plan because you happened to notice it. Park it.
- Do not skip a review because nobody is watching. With the user away, the
  reviews are the only outside check left.

## What still stops it

Say exactly what is needed, record it in the plan, call
`goal({ action: "wait", reason: "<what is needed>" })` when you have the tool,
and end the turn:

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
finish. Call `goal({ action: "complete", evidence: "<where it is>" })` only on a
clean finish or when the user explicitly stops the run; a partial close-out is
`wait`, not `complete`.
