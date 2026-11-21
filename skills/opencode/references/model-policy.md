# Model policy

`~/.config/opencode/model-policy.json` maps each dispatch purpose to exactly one
concrete model. An example sits next to this file:
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

## Bindings the skill uses

| Binding | Dispatch |
| --- | --- |
| `recon.default` | the phase 0 survey |
| `implementer.default` | implementation and rework |
| `reviewer.default` | node review and branch review |
| `qa.default` | runtime walkthrough |
| `adversary.default` | the adversarial pass in phase 3 |

A binding the run needs but the file does not define stops that dispatch. It is
not a reason to borrow another binding's model.

## Resolution, once per run

1. Parse the file. A parse error, or a binding that names an unknown profile,
   stops the run before the first dispatch.
2. For each binding, take its profile's `model` and check it once with
   `tools.opencode.models({ provider, query, all: true, limit })` inside
   `execute`: the base id must be listed, and a `#variant` must be one the tool
   reports for it. `models` missing from your direct tool list is expected and
   is not grounds to skip the check.
3. Write `model policy v<policy_version>, validated <date>` into the plan's
   header. Later dispatches use that resolution.
4. Validate again only when the user changes a model, `policy_version` changes,
   or a dispatch fails on its model.

If the file does not exist, write `model policy absent` and dispatch without
`model`; each child then runs on the orchestrator's model.

There is no fallback table. A quota error never switches models: record the
binding, the model and the provider's error text in the plan, and stop for the
user. An ordinary rate limit, timeout or 5xx is not a quota error and is
retried or handled as a failed round.
