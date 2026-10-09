---
name: prompt-engineer
description: Review or write prompts, system prompts, agent instructions (CLAUDE.md/AGENTS.md-style files), and tool descriptions, grounded in Anthropic's own prompt-engineering principles (clarity/directness, role prompting, data/instruction separation, output formatting, chain-of-thought, few-shot examples, hallucination avoidance). Use this whenever the user asks to review, critique, improve, tighten, or debug a prompt or agent-guide document, or asks to write a new prompt/system-prompt/instruction-set for a task from scratch — including requests like "why isn't Claude following these instructions," "make this system prompt better," "draft a prompt for X," or "review my CLAUDE.md." Trigger even if the user doesn't say "prompt engineering" explicitly, as long as the artifact under discussion is text meant to instruct an LLM.
---

# Prompt Engineer

Two distinct jobs live under this one skill. Figure out which one you're doing before you start, because the workflow and the checklist differ:

1. **Reviewing an existing prompt** — a system prompt, a CLAUDE.md/AGENTS.md-style agent guide, a tool description, a template that gets filled in and sent to Claude. The output is a set of concrete, line-referenced suggestions, not a rewrite dropped on the user unasked.
2. **Writing a new prompt from scratch** — the user has a task and needs a prompt (or system prompt) built for it. The output is a draft prompt, built up element by element, with a short note on why each included element earns its place.

Both jobs draw on the same underlying principles, but the shape of the work is different: review is diagnostic (find gaps against the checklist below, cite the line), writing is generative (walk the element list in `references/from-scratch-template.md`, keep only what the task needs).

## The one rule that overrides all the others

**Not every technique applies to every prompt.** A two-line instruction doesn't need five XML-tagged sections and three worked examples — that's wasted context and it can actually make the prompt harder to follow than plain prose would have been. A single ambiguous free-form request doesn't need a persona. The skill here is judgment about *which* technique addresses *which* failure mode, not mechanical checklist compliance. When you give feedback or draft a prompt, say why a technique is (or isn't) worth using here, not just that it exists.

The underlying reason these techniques work at all: Claude has no context beyond what's literally in the prompt. It isn't being cagey or lazy when it produces a vague, hedging, or off-target response — it's responding to an underspecified prompt exactly as specified. Every technique below is a way of putting more of the task's real shape into the words Claude actually sees.

## Job 1: Reviewing a prompt or agent-instruction document

Read the target document fully, then work through this checklist. For each item, decide whether it's a real gap for *this* document's actual failure mode — not whether the document could theoretically have more of everything.

| Check | What to look for | If it's failing |
|---|---|---|
| **Clarity & directness** | Read each instruction as if you're a new colleague with zero context, doing exactly what's written, nothing more. Do you land where the author intended? Vague verbs ("handle appropriately," "as needed") are the usual culprit. | See `references/structure-and-clarity.md` § Clarity |
| **Role fit** | Does the document need a persona/role to calibrate tone, domain framing, or the kind of reasoning invoked — or is one present that adds nothing? A role is a tool for shaping *how* Claude approaches the task, not decoration. | `references/structure-and-clarity.md` § Roles |
| **Data/instruction separation** | Wherever the prompt has a template slot, a pasted document, user input, or multiple distinct blocks of text, is it structurally obvious to Claude where instructions end and data begins? Ambiguous boundaries cause Claude to read part of the data as an instruction (or vice versa). | `references/structure-and-clarity.md` § Separation |
| **Output format specification** | If downstream code or a human parses the output, is the exact shape (tags, JSON, a template) spelled out — not just implied by an example? | `references/structure-and-clarity.md` § Output formatting |
| **Reasoning scaffolding** | For tasks with real inferential steps (multi-factor judgment calls, math, "is this satisfied," classification with nuance) — is there anywhere for Claude to reason before committing to an answer? Thinking only helps if it happens *out loud*, before the final answer, not asked-for-and-then-discarded. | `references/reasoning-and-grounding.md` § Precognition |
| **Examples where behavior is hard to specify abstractly** | If the desired output has a particular shape, tone, or edge-case handling that's easier to show than to describe, are there examples? Check that edge cases are represented, not just the happy path. | `references/reasoning-and-grounding.md` § Few-shot |
| **Hallucination risk & escape hatches** | Anywhere Claude is asked for a factual claim it might not actually have grounds for (especially against a long document, or "did X happen / is X true"), is there an explicit permission to say "I don't know" or "insufficient information," and — for document-grounded tasks — a quote-extraction step before the final answer? | `references/reasoning-and-grounding.md` § Hallucination |
| **Ordering** | For long documents (system prompts, agent guides), is the highest-leverage material (role, non-negotiable rules) near the top, and is task-specific/immediate instruction near the bottom, close to where the model starts generating? Ordering matters more for some elements than others — see `references/from-scratch-template.md`. | same reference |

Report findings the same way you would for any review: cite the specific line or section, name the gap, and propose concrete replacement text — don't just name the technique and leave the user to apply it themselves. If a section is already well-targeted for its job, say so; don't manufacture a finding to pad the list.

**A caution specific to CLAUDE.md/AGENTS.md-style files**: these are effectively very-long-lived system prompts, re-read on every session start. A vague instruction here doesn't cost you one bad response, it costs every session until someone notices. It's worth being more exacting here than you would for a one-off prompt — but the same "explain the why, not just MUST" bar from the writing side still applies (see `references/structure-and-clarity.md` § Clarity for the reasoning on why bare imperatives underperform explained ones).

## Job 2: Writing a new prompt from scratch

Don't reach for a rigid template. Instead, walk through the element list below — in roughly this order, since order affects some elements more than others — and for each one, decide: does this task actually need it? Include only what's load-bearing; a prompt built by including everything indiscriminately is a worse prompt than one built by selection.

1. **Task context** — who is Claude in this interaction, what's the overarching goal. Put this early; it primes everything that follows.
2. **Tone context** — only if tone actually matters to the interaction (a customer-facing bot, a specific register). Skip for a one-off internal data-transform task.
3. **Detailed task description and rules** — the specific things Claude must and must not do, including the escape hatch for "I don't know how to handle this." This is the section worth reading aloud to a colleague to catch ambiguity.
4. **Examples** — wrap each in tags, give context for what each is an example *of*, and cover edge cases, not just the typical case. Skip entirely for tasks with no particular format or style to imitate — a couple of worked examples on a two-line task is wasted tokens and can even overfit the response to the examples' specifics.
5. **Input data** — any document, conversation history, or user content Claude needs to process, each piece wrapped in its own tags so it's unambiguous where it starts and ends.
6. **Immediate task / the actual request** — restate, near the end, exactly what Claude should do right now. This is worth repeating even if it was implied earlier — recency matters, and it's the last thing Claude reads before generating.
7. **Precognition (thinking step by step)** — for genuinely multi-step or inferential tasks, tell Claude explicitly to reason before answering, right after the immediate-task instruction. Skip for simple lookups or single-fact asks — forcing a "think step by step" preamble onto a trivial task just adds latency and noise.
8. **Output formatting** — the exact shape of the final answer, near the end of the prompt.
9. **Prefill** (API-level techniques only — not applicable inside a Claude Code / agent-harness system prompt, since you don't control the assistant turn there) — seeding the start of Claude's response to enforce a format or skip a preamble.

Full worked examples (a career-coach chatbot, a legal-research assistant) and the exact combination logic are in `references/from-scratch-template.md` — read it before drafting anything nontrivial, since seeing the element list actually assembled into two differently-ordered real prompts clarifies the "which elements, what order" judgment call much faster than the list alone.

For anything that isn't a multi-element complex prompt — a short, single-purpose instruction — don't force the template. Apply just the relevant pieces of `references/structure-and-clarity.md` (clarity, and separation only if there's a data slot) and stop there.

## Quick reference: which file covers what

- `references/structure-and-clarity.md` — clarity/directness, role prompting, separating instructions from data (XML tags), specifying output format and prefilling. The "does the prompt communicate the shape of the task" cluster.
- `references/reasoning-and-grounding.md` — chain-of-thought/precognition, few-shot examples, avoiding hallucination and giving Claude an escape hatch, plus a short note on self-critique/prompt chaining. The "does the prompt get Claude to the right answer, honestly" cluster.
- `references/from-scratch-template.md` — the full complex-prompt element list with two contrasting worked examples (a conversational persona bot, a document-grounded Q&A assistant) showing the elements assembled in different orders, plus notes on which orderings are load-bearing and which aren't.

Open the relevant reference file rather than trying to hold all of this in the summary above — the checklist table points you at the right one per finding.
