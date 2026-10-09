# Building a Complex Prompt From Scratch

This is the element list and worked examples for **Job 2** in SKILL.md — writing a new prompt for a task rather than reviewing an existing one. It's a menu, not a mold: **not every element belongs in every prompt.** The right way to use this file is to get a prompt working first with whichever elements seem plausibly relevant, then look at it fresh and cut whatever isn't earning its place.

## The element list

In roughly this order (a few elements' order genuinely matters; most are flexible — noted below):

1. **`user` turn** — every prompt to Claude starts as a user-role message; this is a formatting fact, not a content decision.
2. **Task context** — who Claude is in this interaction and what the overarching goal is. *Ordering matters*: put this early, since it frames how everything after it should be read.
3. **Tone context** — what tone or register to hold, if the interaction is at all customer-facing or stylistically sensitive. Omit for tasks with no stylistic dimension.
4. **Detailed task description and rules** — the specific behaviors and constraints, spelled out in enough detail that an ambiguous case has a clear answer. This is where you give Claude its "out" for cases it can't or shouldn't handle (see `reasoning-and-grounding.md` § Hallucinations for the exact phrasing pattern). Worth reading this section aloud to a colleague before finalizing — if a rule is ambiguous to them, it's ambiguous to Claude.
5. **Examples** — at least one worked example of an ideal response, each wrapped in its own `<example>` tags, labeled with what it's an example of if there's more than one kind. Cover edge cases, not just the median case. Omit for tasks with no particular format/style to imitate.
6. **Input data to process** — the actual document, conversation history, or content Claude needs to work with, each distinct piece in its own tags. *Ordering is flexible* relative to task description/examples — see the two worked examples below, which place it differently.
7. **Immediate task / the actual request** — restated explicitly, close to the end of the prompt. Repeating the ask here, even if it was implied by the task context, measurably helps — put the literal question or instruction close to where Claude starts generating, not buried at the top of a long prompt.
8. **Precognition (thinking step by step)** — for genuinely multi-step tasks, an instruction to reason before answering, placed right after the immediate task. *Ordering matters here*: this goes near the end, right before the output-formatting instruction, not at the top.
9. **Output formatting** — the exact shape of the final answer. *Ordering matters*: near the end is more reliable than stating it up front and hoping it's still in effect several paragraphs later.
10. **Prefill** — only relevant when you have direct control over the message array (a raw API call or a scripted pipeline), not inside an interactive agent-harness system prompt. Seeds the start of the `assistant` turn to force past a preamble or lock in a format (e.g. prefilling `{` for JSON, or `<response>` to skip straight to content).

**The meta-rule stated at the top of the tutorial this is drawn from, worth repeating**: get a prompt working with more elements first, then refine and slim it down — don't try to guess the minimal set upfront. It's easier to see what to cut once you have a working draft than to reason abstractly about what will be needed.

## Worked example 1 — a conversational persona bot

Task: an AI career-coach chatbot named "Joe," replying inside an ongoing conversation.

Element choices and content:

- **Task context**: `You will be acting as an AI career coach named Joe created by the company AdAstra Careers. Your goal is to give career advice to users. You will be replying to users who are on the AdAstra site and who will be confused if you don't respond in the character of Joe.`
- **Tone context**: `You should maintain a friendly customer service tone.`
- **Task description & rules**: stay in character as Joe; if unsure how to respond, say so and ask for rephrasing; if asked something irrelevant, redirect to career topics.
- **Examples**: one `<example>` showing a standard back-and-forth in Joe's voice.
- **Input data**: the conversation `<history>` so far, and the user's `<question>`.
- **Immediate task**: `How do you respond to the user's question?`
- **Precognition**: `Think about your answer first before you respond.`
- **Output formatting**: `Put your response in <response></response> tags.`
- **Prefill**: `[Joe] <response>` — locks the reply into character and skips straight past any meta-commentary.

Note the order used here: task context → tone → rules → examples → input data → immediate task → precognition → output formatting. Examples come *before* the input data in this one, because the examples are teaching a general conversational style that applies regardless of the specific question, so they read naturally as scene-setting before the actual data.

## Worked example 2 — a document-grounded Q&A assistant

Task: a legal-research assistant, answering a question strictly from a supplied set of search results, with citations.

Element choices and content:

- **Task context**: `You are an expert lawyer.`
- **Tone context**: omitted — no particular register needed beyond professional, which "expert lawyer" already implies.
- **Input data**: the `<legal_research>` block of search results, presented *before* the task description in this example.
- **Examples**: how to format citations — bracketed search-result IDs at the end of the citing sentence, shown with two short example sentences.
- **Task description & rules**: write a concise answer to the `<question>` (restated inline here rather than in a separate "immediate task" section), capped at a couple of paragraphs, with the explicit permission to say `"Sorry, I do not have sufficient information at hand to answer this question."` if the research doesn't support an answer.
- **Immediate task**: omitted as a separate section — folded into the task description above, since the question was already given a natural home there.
- **Precognition**: `Before you answer, pull out the most relevant quotes from the research in <relevant_quotes> tags.` — this is the evidence-gathering-before-answering technique from `reasoning-and-grounding.md`, doing double duty as both the reasoning step and the hallucination guard.
- **Output formatting**: `Put your two-paragraph response in <answer> tags.`
- **Prefill**: `<relevant_quotes>` — forces the quote-extraction step to actually happen before Claude can move on to the answer.

This example deliberately reorders things relative to example 1 (input data comes right after task context, before examples; there's no separate immediate-task section) — this is the "ordering is flexible for most elements" point made concrete. What's consistent across both: task context is first, and output formatting plus precognition sit near the end, right before the response starts.

## How to use these two examples when drafting

Don't copy either structure wholesale. Instead:

1. Decide, task by task, whether each element in the numbered list is pulling weight for *this* prompt.
2. Look at whether your task resembles example 1 (persona, ongoing interaction, style matters more than grounding) or example 2 (single-shot, grounded in supplied data, correctness/citation matters more than voice) — or neither — and let that guide which elements you lean on harder.
3. Keep task context first and output formatting/precognition near the end; be more flexible about everything in between.
4. Build the first draft generously, then cut. A prompt that works but has one unnecessary section is a much easier fix than a prompt that's missing the one section it actually needed.
