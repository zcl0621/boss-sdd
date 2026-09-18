# Review rules

Rules for Cursor's native reviewer. Cursor always loads the copy at the
repository root and then any others found walking up from the changed files.

These rules are the review standard the `plan-sdd` skill runs its own reviewers
under, written for Bugbot. Keep them in step with that skill's review protocol;
they are a restatement of it, not a second policy.

## How to report

- Report actionable problems, ordered by impact, each with the evidence for it:
  the file, the line, and what makes it wrong. A finding with no location cannot
  be triaged and cannot be fixed.
- "Looks fine" is not a review result. Say what was checked and what was found.
- Where you cannot tell, say so instead of choosing. An uncertain finding that is
  labelled uncertain gets one judgment call; a confident wrong dismissal deletes
  a real problem.
- Do not restate the diff back as a summary. The reader has the diff.

## What to check

- Whether the change actually does what the plan document said it would. When a
  plan document is present in the repository, it is the statement of intent.
- The happy path, the error paths, the boundary conditions, and backward
  compatibility.
- Data consistency, permissions, security, concurrency, resource release, and
  observability.
- Whether the tests cover the behaviour that changed, or only the implementation
  details of how it changed.
- Unnecessary complexity, duplicated logic, and hand-edited generated files.
- Whether anything was changed that the change did not need to touch, including
  edits to a file that no task in the plan claimed.

## What not to flag

- Formatting and style the project's own formatter and linter already decide.
  Those run as gates; a review finding about them is noise.
- Pre-existing problems in code this branch did not touch. If a problem predates
  the branch, say that it predates the branch and leave it out of the fix queue.
- Preferences that no rule in this repository supports. A defect is a violation
  of the acceptance criteria, of a documented rule, or of correctness. Anything
  else is a suggestion and should be labelled as one.
