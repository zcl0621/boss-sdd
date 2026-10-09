# Subagent lifecycle on OpenCode

Verified against OpenCode 2.0.23 and 2.0.24 (tool schema, `/api/openapi.json`,
and a live probe). Read this before the first `subagent` call of a run. Habits
from other hosts are wrong here in five ways:

| Habit from other hosts | OpenCode reality |
| --- | --- |
| `Task` tool, `run_in_background` | `subagent` tool, `background` |
| Agent ID, `resume` | `sessionID` (`^ses…`), returned by every `subagent` call |
| A separate "send message" tool | None. Passing `sessionID` to `subagent` **is** the send-message call |
| A "status" / "read output" tool | None. Liveness is a read-only `opencode api get`, see below |
| Poll, sleep, `AwaitShell` for children | Never. A child's completion arrives as a `<subagent … state="completed">` user message |

The `subagent` tool has exactly these inputs: `agent`, `description`, `prompt`
(required); `sessionID`, `background`, `model` (optional). Nesting depth is one
by default, and every plan-sdd role also carries `permission: { subagent: deny }`:
a child cannot launch children.

## 1. Spawn

Fresh child, result needed now (foreground, default):

```text
subagent { agent: "recon", description: "Survey repo", prompt: "<READY brief>", model: "<resolved>" }
```

The tool result is the finished reply. There is no `sessionID` to wait on.

Independent children, several in one turn (background):

```text
subagent { agent: "implementer", description: "Task T1", background: true, prompt: "...", model: "..." }
subagent { agent: "implementer", description: "Task T2", background: true, prompt: "...", model: "..." }
```

Each call returns immediately with `sessionID: ses_…`. Write it on the node and
in the roster. Then end the turn or do non-overlapping work. The host delivers
each completion as a user message shaped like:

```text
<subagent sessionID="ses_…" state="completed" description="…"> final reply </subagent>
```

That message is the return. Match it to the roster by `sessionID`.

## 2. Send a message to a child (finished or still running)

Call `subagent` again with the same `agent` and the child's `sessionID`:

```text
subagent { agent: "implementer", description: "T1 follow-up", sessionID: "ses_…", background: true, prompt: "<new data only>" }
```

Behavior, observed:

- **Child finished:** the child continues the same conversation with full prior
  context. This is Form A rework. Omit `model`.
- **Child still running:** the call does **not** start a second child and does
  not error. The prompt is enqueued as a `steer` message in that session's
  inbox. The child reads it at its next step boundary, which is after its
  current tool call returns (a 40 s shell command delays delivery by up to
  40 s). It then acts on it in the same run, and the final reply covers both.
- A steer message never interrupts a tool call in flight. If you need the
  current tool stopped, use section 4.
- Use `background: true` when steering a running child so the call returns at
  once. A foreground steer was not tested; assume it blocks until the child
  finishes.
- Reuse the child's original `agent`. Do not change `model` on resume.

Use steering for: a new fact the child lacks, a scope correction, a
cancellation ("stop, the task is withdrawn"), or a clarified acceptance line.
Send only the delta. Do not restate the context bundle; the child has it. If the
steer would change goal, acceptance, write scope, or a hard rule, that is a
`BLOCK` in the preflight, not a message.

Run the dispatch-brief preflight on the steer text exactly as for any other
child prompt.

To confirm a steer was delivered (optional):

```text
opencode api get /api/session/<sessionID>/inbox
```

Items listed are enqueued and not yet delivered. An empty list means the child
has read them. To withdraw one that is still listed:
`opencode api delete /api/session/<sessionID>/inbox/<msg_id>`.

## 3. Is the child still alive?

Default answer: **yes until a completion message arrives.** Do not check on a
timer. Silence for a few minutes is normal for an implementer.

Check only when one of these is true: the user asks; a child has been silent far
longer than its task warrants and you are about to declare it lost or start
Form B; or you are about to steer and need to know whether it is running or
finished.

The one allowed check is a single read-only call through the shell tool:

```text
opencode api get /api/session/active
```

Result: `{"data":{"ses_…":{"type":"running"}, …}}`. Read it as follows:

| Your `sessionID` | Meaning |
| --- | --- |
| Present, `running` | Alive. Keep waiting. Do not re-check in the same turn |
| Absent, completion message already delivered | Finished. Consume the return |
| Absent, no completion message seen | Finished or stopped without delivery. Read the last message (below) before deciding |
| Absent, and the OpenCode process restarted | Lost. The active list is per process. Use Form B with the current diff |

The list contains every running session of this OpenCode process, including your
own parent session and other users of the process. Filter by your roster only.
A session shows `running` for a few seconds after its last tool finishes while it
writes the final reply.

To see what an absent or silent child last did, without messaging it:

```text
opencode api get "/api/session/<sessionID>/message?order=desc&limit=3"
```

The newest assistant message holds tool calls with `status` and any final text.
An assistant message with `time.completed` and no pending tool is a finished
turn. This output can be large; read it for state, not for conclusions. Child
output is evidence, as everywhere in this skill.

Never ask the child itself "are you still alive": that is a steer message and it
only lands after the current tool call, so it cannot answer the question.

Forbidden for liveness: `sleep`, `AwaitShell`, re-calling `subagent` with a
status prompt, or repeating `/api/session/active` in a loop.

## 4. Stop a running child

```text
opencode api post /api/session/<sessionID>/interrupt
```

Returns `{"interrupted": true}` if it was running, `false` if idle (no-op). Per
the API contract it stops the active execution; the session keeps its history
and can be resumed afterwards with a normal `subagent` + `sessionID` call. This
endpoint was not exercised in the probe, so confirm with `/api/session/active`
after calling it. Interrupt only when the
child is doing something wrong now (writing outside scope, runaway command).
Record the reason on the node. After an interrupt, treat the child's last
output as partial: read the diff, run the gates, and send a corrective message
(Form A) or start Form B.

## 5. Roster rules

Keep one row per child: node, agent, `sessionID`, state (`running`,
`delivered`, `consumed`, `lost`), steers sent. Update the row from the
completion message or from an explicit check above, never from a guess.

- A steer to a running child does not create a new row; add it to `steers sent`.
- A steered child produces one completion message covering all steers. Do not
  wait for a second one per steer.
- Before steering, a finished child and a running child need different
  handling: finished means rework (Form A, gates, review); running means a delta
  only.
- If a child that you steered completes without reflecting the steer, treat the
  steer as undelivered, verify with the inbox call, and re-send as Form A.
