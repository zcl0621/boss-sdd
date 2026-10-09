# Phase P: discussion (mandatory)

Every plan-sdd run starts here. There is no skip. A run does not enter Phase 0
until the user has confirmed the Discussion outcome (see the end of this file).

How to talk to the user in this phase is in
[greenfield-discussion.md](greenfield-discussion.md). Read it first. Every
message the user will read in Phase P is checked with the `shuorenhua` skill
(when installed) before it is sent.

## P0 Pick the depth

Pick one and tell the user in one sentence which one and why.

| Depth | Use when | What runs |
| --- | --- | --- |
| Light | The user already gave a spec or a clear change list: what to change, where, and how to check it. No real choice between designs. | P1 and P5 only. No explore, no architect. |
| Full | The ask is vague, acceptance is missing, or there are two or more real ways to build it. | P1 to P5. |

Doubt between the two: take Full. The user can say "按你说的" to move fast.

Unattended mode does not change this. If the user said `--goal` or "run it to the
end", Phase P still waits for them. Unattended is armed only after the Discussion
outcome is confirmed (see [unattended-mode.md](unattended-mode.md)).

## P1 Say what you understood

Write what you think the user wants, in their words, as a short paragraph. Then
list the assumptions you made to fill gaps, each one a sentence the user can
answer "right" or "wrong" to.

Do not list "unknowns". Fill in what you can infer from the repo, the request,
and project memory. Say it as an assumption.

## P2 Look at the code (Full only)

Launch 2 or 3 `explore` subagents in one turn (binding `explore.research`), each with
[greenfield-explorer.md](greenfield-explorer.md) and a different focus:

- Similar features and how they are called
- How this area is laid out today
- UI, tests, and places where the change would plug in

Each returns 5 to 10 essential files (path and why). Read the handful that
decide the questions you are about to ask, at most about eight across all
explorers; the rest stay as paths in the Discussion outcome for recon. This is read-only; it does not replace Phase 0 recon.

## P3 Ask the questions that change the plan (Full only)

Rules are in [greenfield-discussion.md](greenfield-discussion.md). Short version:

- At most 5 questions per round, at most 2 rounds.
- A question is asked only if a different answer changes what gets built.
- Every question names something the user can see (a file, a screen, a
  command, a behavior) and carries your recommended answer and why.
- Anything you can decide from the code or memory, decide it and put it in the
  assumptions instead.

Wait for the answers. If 2 rounds are not enough, the remaining items go into
"Still open" in the outcome and the tasks that depend on them start `blocked`
in Phase 1 (same rule as parked questions).

## P4 Choose how to build it (Full only)

Only when P2 shows two or more real ways to build it. Launch 2 or 3 `general`
subagents (binding `general.architect`) with [greenfield-architect.md](greenfield-architect.md) and different
focuses (smallest change, cleanest structure, middle path).

Present to the user: each option in plain words, what it costs, and your pick
with the reason. The user picks, or says "按你说的".

If there is only one reasonable way, skip the architects. Say which way and why
in P5.

## P5 Confirm and record

Write the Discussion outcome in the format below and show it to the user. Ask for
one explicit "对 / 确认 / 按这个来". Silence, or a reply that only answers some
questions, is not confirmation.

If the project has no convention for where plan files live, ask for the plan file
location in this same message (one more question, with your suggestion).

```text
Discussion outcome
Depth: light | full
Confirmed by user: <date>, "<their confirming words>"
Goal: <what the user can see once this lands>
Not doing: <what this change leaves alone>
Chosen approach: <the way to build it; the other way considered; why this one>
Assumptions the user accepted: <list>
Defaults taken from "按你说的": <list, or none>
Still open: <questions that stay open, with the tasks that depend on them, or none>
Plan file location: <path>
```

## After Phase P

1. Keep the Discussion outcome. It is copied verbatim into the plan document
   (see [plan-spec.md](plan-spec.md)) in Phase 1.
2. Phase 0 recon gets the user's original requirement in `<requirement>` and the
   Discussion outcome in `<extra_context>`.
3. If the user changes their mind later in the run, update the outcome, say so
   in one sentence, and tell the user which tasks it touches. A change that
   moves the Goal or Not doing lines goes back to the user for confirmation.

Implementation always flows through plan-sdd nodes (implementer, gates,
reviewer), never through a separate feature workflow.
