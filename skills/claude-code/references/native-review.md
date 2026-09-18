# Claude Code's native branch reviewer

[The handoff protocol](../shared/references/native-review-handoff.md) says a
wrapper may state which case its platform is in, and that whatever it says is
more current than the shared file. This is that statement for Claude Code, and
nothing else: the procedure for checking, running, handing off and triaging is in
that file and is not repeated here.

Claude Code's native reviewer is `/code-review` on the current branch, and
`/code-review ultra <PR#>` for a cloud multi-agent review of a pull request.
Those two commands are from the verified platform facts. Who may launch them is
what follows.

## `/code-review ultra`: a handoff in this author's environment

The cloud multi-agent review is user-triggered and billed, and an agent must not
attempt to launch it. That is verified for this skill author's own Claude Code
operating environment and is not a claim about every installation. It is why the
ultra path is never an agent action in this packaging: treat it as a handoff
unless your own environment tells you otherwise in as many words.

Never invoke it, never shell out to it, never simulate the keystroke, never ask
another agent to type it. If the branch warrants it, say so in the delivery
report and let the user decide.

## Plain `/code-review`: varies by installation

This one has no single answer, and choosing the convenient one would be a
fabrication either way.

- In one Claude Code session, a subagent reported `code-review` present in its
  own skill roster as agent-invocable, with `--fix` and `--comment` flags.
- In another session on the same machine, that entry was not in the roster and
  the report could not be reproduced.

Both observations are first-hand. Neither generalizes. So run the check in the
handoff protocol at phase 3 and let it decide, rather than assuming either way.
The flags are in the same position: seen once, in one roster, not in the verified
facts. Do not pass a flag you have not seen listed in your own environment.

## Two flags not to reach for, if it turns out to be invocable

- **`--fix`, or anything else that applies the findings for you.** The body's
  first non-negotiable is that you do not write implementation code; a reviewer
  that edits the tree on your behalf breaks that as thoroughly as editing it by
  hand would, and it also writes outside every node's declared write scope while
  other nodes may be mid-write. Take the findings as text and send them back
  through the fix loop.
- **`--comment`, or anything that posts to a pull request.** This one is my own
  conservative extension, not something the body already says: its prohibition
  names "push, open a PR, merge, or deploy", and a PR comment is not literally in
  that list. I am treating it as the same kind of external, user-visible action
  and leaving it to the user's explicit authorization. Judge it yourself if you
  disagree.
