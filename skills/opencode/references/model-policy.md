# Model policy

`~/.config/opencode/model-policy.json` maps each dispatch purpose to exactly one
concrete model. SKILL.md says when it is read (once per run) and what blocks.
This file is its schema. An example sits next to it:
[model-policy.example.json](model-policy.example.json).

## Fields

```text
policy_version   integer. Increment on every change.
profiles         object. Profile name -> { purpose, level, model }.
                   purpose  what the profile is for, one sentence.
                   level    cost/capability label (L1, L2, ...). Descriptive only,
                            never a pool to pick from.
                   model    "<provider>/<model>" or "<provider>/<model>#<variant>",
                            exactly as OpenCode's models tool lists it.
bindings         object. Binding name -> profile name.
```

There is no fallback or exception table: a quota error never switches models
(SKILL.md "Quota").

## Bindings the skill uses

| Binding | Dispatch |
| --- | --- |
| `explore.research` | Phase P explorers, explicit research waves |
| `general.architect` | Phase P architects |
| `explore.post_commit_scan` | the project's post-commit scans; memory source checks |
| `recon.default` | Phase 0 recon |
| `implementer.default` | ordinary implementation and rework |
| `implementer.high_complexity` | `[complexity: high]` tasks |
| `implementer.obstacle_escalation` | the one escalated repair of an obstacle episode |
| `qa.default` | runtime walkthrough |
| `reviewer.default` | quality, branch and adversary lanes |
| `spec_auditor.default` | red-test and post-repair spec audits |
| `human.max` | only when the user explicitly names it |

A binding the run needs but the file does not define is `BLOCK` for that
dispatch, not a reason to borrow another binding's model.

## Resolution, once per run

1. Parse the file. A parse error or a binding that names an unknown profile is
   `BLOCK`.
2. For each binding this run will use, take its profile's `model` and check it
   once with `tools.opencode.models` inside `execute`: the base id must be
   listed, and a `#variant` must be one the tool reports for it.
3. Write `Model policy: v<policy_version>, validated <date>` into the plan's
   Status header. Later dispatches use the recorded resolution.
4. Re-validate only when the user changes a model, the file's `policy_version`
   changes, or a dispatch fails on its model.

If the file does not exist, write `Model policy: absent` and dispatch without
`model`; each child then runs on its agent file's model, or the orchestrator's.
