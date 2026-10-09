# Reasoning & Grounding

Covers: getting Claude to reason before answering (precognition / chain-of-thought), teaching desired behavior through examples (few-shot), and keeping Claude from confidently stating things that aren't true (hallucination avoidance). These three all address the same underlying question — does the prompt get Claude to a *correct*, *honest* answer, rather than just a fluent-sounding one?

## Precognition (Thinking Step by Step)

Complex or inferential tasks — weighing multiple factors, catching a subtle logical error, classifying something ambiguous, working through a multi-step calculation — go better when Claude works through the reasoning before committing to a final answer, the same way a person asked a hard question on the spot does better with a moment to think than forced to blurt out an instant response.

The critical constraint: **the thinking has to actually happen in the output, before the answer.** Asking Claude to "think about this" while only allowing it to emit the final answer accomplishes nothing — there's no reasoning to point to, because none happened. If you don't want the reasoning shown to the end user, have Claude produce it in a tagged scratch section (e.g. `<thinking>...</thinking>`) that precedes the final tagged answer, and strip or hide that section downstream rather than suppressing the reasoning step itself.

Two second-order effects worth knowing when debugging a prompt that's giving inconsistent answers:

- **Claude is sensitive to the order of options or evidence presented to it**, and in ambiguous cases has some tendency to favor the later-presented option. If a prompt's answer flips when you reorder two things that shouldn't matter, that's a sign the underlying judgment is genuinely on a knife's edge — worth adding either a scratchpad step or a tie-breaking rule, not just re-ordering and hoping.
- Letting Claude reason explicitly is one of the more reliable single fixes when it's getting a factual or logical question wrong outright — a wrong instant answer often becomes a right one once the same model is told to work through the steps rather than answer cold. If a review target has a bare instruction like "assess whether X is true" with no room to reason, and X is at all inferential, that's the fix to propose.

**When to skip it**: a simple retrieval, a single-fact lookup, a mechanical reformat — none of these have a reasoning chain to expose, and demanding a "let's think step by step" preamble on them just burns tokens and adds latency without changing the (already-easy) answer. Reserve this for tasks with a genuine multi-step or judgment-call structure.

## Few-Shot Examples (Using Examples)

Showing Claude examples of the desired input/output pattern is one of the highest-leverage techniques available, particularly when:

- The target answer needs to be **in a specific format** that's easier to demonstrate than to describe in prose (a citation style, a particular JSON shape, a tone).
- The target answer needs to hit a **tone or style** that's hard to pin down in words (imagine trying to verbally describe "warm and simple, like explaining something to a child" versus just showing three examples of that register).

Practical guidance:

- Wrap each example in its own tags (`<example>...</example>`), and if there's more than one, tell Claude what each is an example *of* before or within the tags, especially if the examples aren't all illustrating the identical thing.
- **Cover edge cases, not just the typical case.** An example set that's all happy-path teaches Claude the happy path and leaves it guessing on everything else — which defeats the purpose of using examples to communicate hard-to-describe behavior in the first place.
- If a prompt's format involves a scratch/reasoning section before the final answer, it's worth showing what that scratch section should look like in the examples too, not just the final output.
- More examples generally help more, up to the point where you're burning context on redundant repetition of the same pattern.

**When to skip it**: a short, low-ambiguity task with an obvious, easily-described output format doesn't need multishot examples — two or three worked examples on a two-line instruction is wasted context, and can even backfire by anchoring the response too tightly to the examples' specific surface details rather than the underlying instruction. If you're reviewing a prompt and the examples present don't seem to be teaching anything the instructions didn't already say plainly, flag them as removable, not as insufficient.

## Avoiding Hallucinations

Claude will sometimes produce a confident, fluent, factually wrong answer, particularly when a question sounds like it should have a knowable answer and no permission to decline has been given. Two techniques reliably cut this down, and they address two different triggers for hallucination:

**1. Give Claude an explicit out.** When a prompt asks a factual question, state directly that it's fine — preferred, even — to say "I don't know" or "there is insufficient information to answer" rather than guess. Without this permission, Claude defaults toward being maximally helpful, which for an unanswerable question means fabricating rather than declining. This is the fix for the "asked something it doesn't actually know" failure mode.

**2. Make Claude gather evidence before answering, especially against long documents.** When the answer needs to be grounded in a supplied document (a long contract, a research corpus, a policy doc), Claude is vulnerable to "distractor" content — text that's topically related but doesn't actually answer the question — and without a grounding step, it will sometimes weave the distractor into a plausible-sounding wrong answer. The fix: instruct Claude to first extract the specific relevant quotes from the source material (in their own tagged section, e.g. `<relevant_quotes>`) *before* composing the answer, and base the final answer only on what was actually extracted. This forces a check-before-you-speak step that a bare "answer the question" instruction skips.

Note that the document/question ordering matters here too: put the question **after** any long supplied document, not before it — asking the question first and then handing over a large block of text to search invites skimming; put the search target last so it's freshest when Claude starts reasoning through the material.

If a hallucination-prone prompt is being run through a direct API call rather than an interactive agent session, lowering `temperature` toward 0 also reduces variance and can reduce hallucination somewhat, though it's a blunter instrument than the two techniques above and doesn't address the root cause (missing grounding or missing permission to decline) — treat it as a supplement, not a substitute.

## A note on self-critique / chaining (light-touch, not the focus of this skill)

Beyond a single well-built prompt, Claude's answers can often be improved by a second pass: feed the first response back and ask Claude to double-check or improve it. This works for catching outright errors (ask it to verify each claim) and for general quality (ask it to revise a first draft). Two caveats worth knowing: asking Claude to "double check" a response that's already correct can occasionally cause it to second-guess a right answer into a wrong one, so pair a revision request with the same "give it an out" principle above (permission to say the original was already fine) rather than demanding a change be found. This is a multi-turn/pipeline technique (prompt chaining), not something you write once into a single system prompt — worth knowing about, but out of scope for reviewing or drafting a single prompt document.
